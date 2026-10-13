import { expect, it } from "vitest";
import {
  formatJson,
  isJsonContainer,
  jsonTokens,
} from "../apps/web/src/json-value.js";

it("formats nested JSON and compacts it without changing strings, numeric tokens, or duplicate keys", () => {
  const original =
    '{ "id": 900719925474099312345, "ratio": 1e400, "empty": [{}, []], "text": "a  b\\n\\\"c", "id": -0 }';
  const { compact, pretty } = formatJson(original);
  expect(compact).toBe(
    '{"id":900719925474099312345,"ratio":1e400,"empty":[{},[]],"text":"a  b\\n\\\"c","id":-0}',
  );
  expect(pretty).toContain('\n  "id": 900719925474099312345');
  expect(formatJson(pretty).compact).toBe(compact);
  expect(formatJson("null").compact).toBe("null");
});

it("rejects invalid JSON and only auto-detects objects and arrays", () => {
  expect(() => formatJson('{"key":}')).toThrow();
  expect(() => formatJson("[1,]")).toThrow();
  expect(isJsonContainer(' [1, {"ok":true}] ')).toBe(true);
  expect(isJsonContainer("{bad")).toBe(false);
  expect(isJsonContainer("123")).toBe(false);
  expect(isJsonContainer('"a string"')).toBe(false);
});

it("highlights keys, strings, numbers, literals and preserves text as tokens", () => {
  const source = '{"script":"<script>alert(1)</script>","n":-2,"ok":false}';
  const tokens = jsonTokens(source);
  expect(tokens.map((token) => token.text).join("")).toBe(source);
  expect(tokens.find((token) => token.text === '"script"')?.kind).toBe("key");
  expect(tokens.find((token) => token.text.includes("<script>"))?.kind).toBe(
    "string",
  );
  expect(tokens.find((token) => token.text === "-2")?.kind).toBe("number");
  expect(tokens.find((token) => token.text === "false")?.kind).toBe("literal");
});
