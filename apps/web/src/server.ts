import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSchema } from "../../../packages/core/src/schema.js";
import {
  OnePasswordProvider,
  type Provider,
} from "../../../packages/core/src/provider.js";
import {
  publicResolution,
  readVaults,
  resolveEnvironment,
} from "../../../packages/core/src/resolver.js";
import { applyEdit } from "../../../packages/core/src/edit.js";
import { safeError, VaultError } from "../../../packages/core/src/errors.js";

const equal = (a: string, b: string) => {
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
async function body(request: IncomingMessage): Promise<unknown> {
  const parts: Buffer[] = [];
  let bytes = 0;
  for await (const part of request) {
    bytes += part.length;
    if (bytes > 256_000)
      throw new VaultError("Request is too large.", "request", 413);
    parts.push(part);
  }
  try {
    return JSON.parse(Buffer.concat(parts).toString("utf8"));
  } catch {
    throw new VaultError("Expected a JSON request.");
  }
}
function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(value));
}

export async function startServer(options: {
  schemas: string[];
  port?: number;
  provider?: Provider;
  staticDirectory?: string;
}) {
  if (!options.schemas.length)
    throw new VaultError("Select at least one schema.");
  const schemas = await Promise.all(
    options.schemas.map((path) => loadSchema(path)),
  );
  const projects = schemas.map((schema, index) => ({
    id: String(index),
    path: schema.path,
  }));
  const providers = new Map<
    string,
    { fingerprint: string; pending: Promise<Provider> }
  >();
  const bootstrap = randomBytes(32).toString("hex");
  const credential = randomBytes(32).toString("hex");
  const mutationToken = randomBytes(32).toString("hex");
  const launchTokens = new Map([[bootstrap, Date.now() + 5 * 60_000]]);
  function issueLaunchUrl() {
    for (const [key, expires] of launchTokens)
      if (expires < Date.now()) launchTokens.delete(key);
    const token = randomBytes(32).toString("hex");
    launchTokens.set(token, Date.now() + 5 * 60_000);
    return `${url}/?launch=${randomBytes(8).toString("hex")}#session=${token}`;
  }
  let port = options.port ?? 0;
  const serverDir = dirname(fileURLToPath(import.meta.url));
  const staticDirectory =
    options.staticDirectory ?? resolve(serverDir, "../../../../apps/web/dist");
  // Source mode resolves relative to apps/web/src; compiled mode is nested under dist/apps/web/src.
  const fallbackStaticDirectory = resolve(serverDir, "../dist");
  const server = createServer(async (request, response) => {
    let activeProject: string | undefined;
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    try {
      const host = request.headers.host;
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`)
        throw new VaultError("Unexpected Host header.", "request", 403);
      const origin = request.headers.origin;
      if (
        (origin && origin !== `http://${host}`) ||
        request.headers["sec-fetch-site"] === "cross-site"
      )
        throw new VaultError("Unexpected request origin.", "request", 403);
      const url = new URL(request.url ?? "/", `http://${host}`);
      const cookieName = `bev-session-${port}`;
      const cookie =
        request.headers.cookie
          ?.split(";")
          .map((c) => c.trim())
          .find((c) => c.startsWith(`${cookieName}=`))
          ?.slice(cookieName.length + 1) ?? "";
      const connected = equal(cookie, credential);
      if (url.pathname === "/api/session" && request.method === "POST") {
        if (
          origin !== `http://${host}` ||
          request.headers["content-type"] !== "application/json"
        )
          throw new VaultError(
            "Open the app through its local launch flow.",
            "session",
            403,
          );
        const data = (await body(request)) as { token?: string };
        // A used bookmark must not disconnect a browser that already has a
        // valid session. The same link still cannot authorize another browser.
        if (connected) {
          json(response, 200, { connected: true });
          return;
        }
        const match =
          typeof data?.token === "string"
            ? [...launchTokens].find(
                ([key, expires]) =>
                  expires >= Date.now() && equal(data.token!, key),
              )
            : undefined;
        if (!match)
          throw new VaultError(
            "This browser link expired or was already used. Get a fresh one-time link from the running server.",
            "session",
            401,
          );
        launchTokens.delete(match[0]);
        response.setHeader(
          "Set-Cookie",
          `${cookieName}=${credential}; HttpOnly; SameSite=Strict; Path=/`,
        );
        json(response, 200, { connected: true });
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        if (!connected)
          throw new VaultError(
            "This browser is not connected. Open a fresh one-time browser link from the running server.",
            "session",
            401,
          );
        if (request.method !== "GET") {
          if (
            origin !== `http://${host}` ||
            request.headers["content-type"] !== "application/json" ||
            typeof request.headers["x-bev-mutation"] !== "string" ||
            !equal(request.headers["x-bev-mutation"], mutationToken)
          )
            throw new VaultError(
              "Invalid mutation token or origin.",
              "request",
              403,
            );
        }
        if (url.pathname === "/api/projects" && request.method === "GET") {
          json(response, 200, {
            projects: await Promise.all(
              projects.map(async (project) => {
                const schema = await loadSchema(project.path);
                return {
                  id: project.id,
                  name: schema.config.name ?? "Environment project",
                  schemaPath: project.path,
                };
              }),
            ),
            mutationToken,
          });
          return;
        }
        const project = projects.find(
          (p) => p.id === url.searchParams.get("project"),
        );
        if (!project) throw new VaultError("Select an available project.");
        activeProject = project.id;
        const schema = await loadSchema(project.path);
        let cached = providers.get(project.id);
        // Declarative edits can change scope/auth; never reuse a provider with stale settings.
        const providerFingerprint = JSON.stringify(schema.config);
        if (!cached || cached.fingerprint !== providerFingerprint) {
          cached = {
            fingerprint: providerFingerprint,
            pending: options.provider
              ? Promise.resolve(options.provider)
              : OnePasswordProvider.connect(schema.config),
          };
          providers.set(project.id, cached);
        }
        const provider = await cached.pending;
        const revealAll =
          url.pathname === "/api/reveal-all" && request.method === "POST";
        if (
          revealAll ||
          (url.pathname === "/api/matrix" && request.method === "GET")
        ) {
          if (revealAll) {
            const data = (await body(request)) as { fingerprint?: string };
            if (data?.fingerprint !== schema.fingerprint)
              throw new VaultError(
                "The schema changed. Refresh before revealing values.",
                "conflict",
                409,
              );
          }
          const snapshot = await readVaults(schema, provider);
          const environments = Object.keys(schema.config.environments);
          const resolutions = await Promise.all(
            environments.map((env) =>
              resolveEnvironment(schema, env, snapshot),
            ),
          );
          json(response, 200, {
            fingerprint: schema.fingerprint,
            config: schema.config,
            schemaPath: schema.path,
            environments,
            resolutions: revealAll
              ? resolutions
              : resolutions.map(publicResolution),
            versions: Object.fromEntries(
              [
                ...new Set([
                  ...schema.parsed.configItems.map((item) => item.key),
                  ...Object.values(snapshot).flatMap((items) =>
                    items.map((item) => item.name),
                  ),
                ]),
              ].map((name) => [
                name,
                Object.fromEntries(
                  environments.map((env) => [
                    env,
                    snapshot[env].find((i) => i.name === name)?.version ?? null,
                  ]),
                ),
              ]),
            ),
          });
          return;
        }
        if (url.pathname === "/api/reveal" && request.method === "POST") {
          const data = (await body(request)) as {
            environment?: string;
            name?: string;
            fingerprint?: string;
          };
          if (
            !data.environment ||
            !Object.hasOwn(schema.config.environments, data.environment) ||
            !schema.parsed.configItems.some((i) => i.key === data.name)
          )
            throw new VaultError("Unknown environment or variable.");
          if (data.fingerprint !== schema.fingerprint)
            throw new VaultError(
              "The schema changed. Refresh.",
              "conflict",
              409,
            );
          const snapshot = await readVaults(schema, provider);
          const resolution = await resolveEnvironment(
            schema,
            data.environment,
            snapshot,
          );
          const record = resolution.variables.find(
            (i) => i.name === data.name,
          )!;
          const explicit = snapshot[data.environment].find(
            (i) => i.name === data.name,
          );
          const sourceItem = snapshot[record.source ?? ""]?.find(
            (i) => i.name === data.name,
          );
          json(response, 200, {
            value: record.value,
            explicitValue: explicit?.value,
            editableValue: sourceItem?.value ?? record.value,
            notes: explicit?.notes ?? "",
          });
          return;
        }
        if (url.pathname === "/api/edit" && request.method === "POST") {
          json(
            response,
            200,
            await applyEdit(schema.path, provider, await body(request)),
          );
          return;
        }
        throw new VaultError("Unknown API endpoint.", "request", 404);
      }
      if (request.method !== "GET")
        throw new VaultError("Method not allowed.", "request", 405);
      const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      if (!/^(index\.html|assets\/[a-zA-Z0-9_.-]+)$/.test(file))
        throw new VaultError("Not found.", "request", 404);
      let contents: Buffer;
      try {
        contents = await readFile(resolve(staticDirectory, file));
      } catch {
        try {
          contents = await readFile(resolve(fallbackStaticDirectory, file));
        } catch {
          throw new VaultError(
            "Build the UI first with npm run build.",
            "request",
            404,
          );
        }
      }
      const types: Record<string, string> = {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
      };
      response.writeHead(200, {
        "Content-Type": types[extname(file)] ?? "application/octet-stream",
      });
      response.end(contents);
    } catch (error) {
      // The next explicit request opens a fresh session after expired/failed
      // authorization. Mutations are never automatically retried.
      if (
        activeProject &&
        error instanceof VaultError &&
        ["authentication", "provider", "partial"].includes(error.code)
      )
        providers.delete(activeProject);
      json(response, error instanceof VaultError ? error.status : 500, {
        error: safeError(error),
        code: error instanceof VaultError ? error.code : "internal",
      });
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}`;
  return {
    server,
    url,
    // A non-secret query nonce forces a full navigation when reopening the same
    // port in an existing tab; fragment-only navigation would skip app startup.
    launchUrl: `${url}/?launch=${randomBytes(8).toString("hex")}#session=${bootstrap}`,
    bootstrap,
    issueLaunchUrl,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeIdleConnections();
      }),
  };
}
