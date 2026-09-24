import assert from "node:assert/strict";
import test from "node:test";

const { safeLoginDestination } = await import("./login-destination.ts");
const origin = "http://127.0.0.1:30141";

test("returns to the same-origin page that sent the browser to login", () => {
  assert.equal(safeLoginDestination("/?session=abc", origin), `${origin}/?session=abc`);
  assert.equal(safeLoginDestination("/?cwd=%2Fhome%2Fpi#top", origin), `${origin}/?cwd=%2Fhome%2Fpi#top`);
});

test("falls back to the app root without a usable destination", () => {
  for (const next of [null, "", "session", "https://evil.example/", "javascript:alert(1)"]) {
    assert.equal(safeLoginDestination(next, origin), "/");
  }
});

test("rejects paths the URL parser resolves to another origin", () => {
  for (const next of [
    "//evil.example",
    "/\\evil.example",
    "/\\/evil.example",
    "/\t/evil.example",
    "/\n/evil.example",
    "/\\\tevil.example",
  ]) {
    assert.equal(safeLoginDestination(next, origin), "/", JSON.stringify(next));
  }
});
