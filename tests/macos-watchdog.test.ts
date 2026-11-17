import { expect, it } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { createConnection } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

it("closes the server when its app dies even while the SDK thread is blocked", async () => {
  const module = pathToFileURL(resolve("apps/macos/parent-watchdog.ts")).href;
  const childSource = `import {watchParent} from ${JSON.stringify(module)};
    import {createServer} from 'node:net';
    import {writeSync} from 'node:fs';
    watchParent();
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      writeSync(1, JSON.stringify({pid:process.pid,port:server.address().port}) + "\\n");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
    });`;
  const parent = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import {spawn} from 'node:child_process';
    const child=spawn(process.execPath, ['--disable-warning=DEP0205','--import','tsx','--input-type=module','-e',${JSON.stringify(childSource)}], {stdio:['ignore','pipe','ignore']});
    child.stdout.pipe(process.stdout);
  `,
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  let pid: number | undefined;
  const listening = (port: number) =>
    new Promise<boolean>((done) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        done(true);
      });
      socket.once("error", () => done(false));
      socket.setTimeout(200, () => {
        socket.destroy();
        done(false);
      });
    });
  try {
    const lines = createInterface({ input: parent.stdout! });
    const record = JSON.parse((await once(lines, "line"))[0]);
    pid = record.pid;
    expect(await listening(record.port)).toBe(true);
    parent.kill("SIGKILL");
    const deadline = Date.now() + 5000;
    while (await listening(record.port)) {
      if (Date.now() > deadline)
        throw new Error("Orphaned server survived its app");
      await delay(50);
    }
  } finally {
    parent.kill("SIGKILL");
    if (pid)
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* Already stopped. */
      }
  }
});
