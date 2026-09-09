import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = ts.createSourceFile("ChatWindow.tsx", await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const component = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "NewSessionUpdateLink");
const effect = component.body.statements.find((node) => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && node.expression.expression.getText(source) === "useEffect").expression.arguments[0];
const effectScript = new vm.Script(ts.transpileModule(`(${effect.getText(source)})()`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText);
const update = { updateAvailable: true, latestVersion: "1.0.0", releaseUrl: "https://example.com/release" };
const flush = () => new Promise((resolve) => setImmediate(resolve));

function mount(fetch) {
  const writes = [];
  const cleanup = effectScript.runInNewContext({ AbortController, fetch, setUpdate: (value) => writes.push(value) });
  return { writes, cleanup };
}

test("update check sends one request during Strict Effects replay and still checks on later mounts", async () => {
  let requests = 0;
  const fetch = async () => { requests++; return Response.json(update); };
  const discarded = mount(fetch);
  discarded.cleanup();
  const active = mount(fetch);
  await flush();
  assert.equal(requests, 1);
  assert.deepEqual(discarded.writes, []);
  assert.deepEqual(active.writes, [update]);
  active.cleanup();
  const later = mount(fetch);
  await flush();
  assert.equal(requests, 2);
  assert.deepEqual(later.writes, [update]);
  later.cleanup();
});

test("an unmounted update check ignores late responses even if fetch ignores abort", async () => {
  const pending = Promise.withResolvers();
  const state = mount(() => pending.promise);
  await flush();
  state.cleanup();
  pending.resolve(Response.json(update));
  await flush();
  assert.deepEqual(state.writes, []);
});

test("failed update checks stay best-effort", async () => {
  for (const fetch of [async () => { throw Error("offline"); }, async () => new Response("unavailable", { status: 503 })]) {
    const state = mount(fetch);
    await flush();
    assert.deepEqual(state.writes, []);
    state.cleanup();
  }
});
