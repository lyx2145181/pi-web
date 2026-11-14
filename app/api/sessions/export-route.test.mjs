import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { createJiti } from "jiti";

const template = await readFile(new URL("../../../node_modules/@earendil-works/pi-coding-agent/dist/core/export-html/template.js", import.meta.url), "utf8");

function deepEntries() {
  const start = Date.parse("2026-01-01T00:00:00Z");
  const entries = Array.from({ length: 25_000 }, (_, i) => ({
    id: `n${i}`, parentId: i ? `n${i - 1}` : null, timestamp: new Date(start + i).toISOString(),
  }));
  // Insert an older sibling last: timestamp sorting, not insertion order, must win.
  entries.push({ id: "older-sibling", parentId: "n100", timestamp: new Date(start).toISOString() });
  return entries;
}

// pi 1.5.0's template walks the tree iteratively, which is why pi-web's string
// patch of the recursive helpers could be removed. If this fails, deep export
// needs a new answer before the patch may stay gone.
test("the installed SDK's export template walks the tree iteratively", () => {
  assert.match(template, /for \(const node of nodeMap\.values\(\)\)/);
  assert.doesNotMatch(template, /\bfunction\s+(?:sortChildren|mapNodes|markActive)\s*\(/);
});

test("installed SDK sorting, newest-leaf lookup and active-path traversal handle 25,000 levels", () => {
  const entries = deepEntries();
  const start = template.indexOf("function buildTree()");
  const end = template.indexOf("function buildTreePrefix(");
  assert.ok(start >= 0 && end > start);
  const result = runInNewContext(template.slice(start, end) + `
    const roots = buildTree();
    const flat = flattenTree(roots, buildActivePathIds('n24999'));
    ({ leaf: findNewestLeaf('n0'), path: getPath('n24999').length,
       count: flat.length, first: flat[0].node.entry.id, last: flat.at(-1).node.entry.id });
  `, { entries, byId: new Map(entries.map((entry) => [entry.id, entry])), labelMap: new Map() }, { timeout: 10_000 });
  assert.equal(result.leaf, "n24999");
  assert.equal(result.path, 25_000);
  assert.equal(result.count, 25_001);
  assert.equal(result.first, "n0");
  assert.equal(result.last, "older-sibling");
});

// The removed patch's own behavior (its replacements, its one-match refusal) has
// no test of its own any more: the route returns the SDK's HTML unchanged, and
// the tests below cover what that still has to do.

const agentDir = await mkdtemp(join(tmpdir(), "pi-web-export-test-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false,
});
const { GET } = await jiti.import("./[id]/export/route.ts");
const { cacheSessionPath, invalidateSessionPathCache } = await jiti.import("../../../lib/session-reader.ts");

test.after(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(agentDir, { recursive: true, force: true });
});

async function fixture(t, deep = false) {
  const id = randomUUID();
  const timestamp = "2026-01-01T00:00:00.000Z";
  const entries = [{ type: "session", version: 3, id, timestamp, cwd: agentDir }];
  let parentId = null;
  if (deep) {
    for (let i = 0; i < 12_000; i++) {
      const entryId = `meta${i}`;
      entries.push({ type: "thinking_level_change", id: entryId, parentId, timestamp, thinkingLevel: "off" });
      parentId = entryId;
    }
  }
  entries.push({ type: "message", id: "user1", parentId, timestamp, message: { role: "user", content: "完整历史测试", timestamp: 1 } });
  entries.push({ type: "message", id: "assistant1", parentId: "user1", timestamp, message: {
    role: "assistant", content: [{ type: "text", text: "Export fixture reply" }],
    api: "openai-responses", provider: "fixture", model: "fixture", stopReason: "stop", timestamp: 2,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  } });
  const path = join(agentDir, `测试-历史-${id}.jsonl`);
  await writeFile(path, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  cacheSessionPath(id, path);
  t.after(() => invalidateSessionPathCache(id));
  return { id, path, before: await readFile(path, "utf8") };
}

for (const inline of [false, true]) {
  test(`real export route returns HTML for ${inline ? "the full-history popup" : "download"} without changing its session`, async (t) => {
    const { id, path, before } = await fixture(t);
    const response = await GET(new Request(`http://localhost/api/sessions/${id}/export${inline ? "?inline=1" : ""}`), {
      params: Promise.resolve({ id }),
    });
    const html = await response.text();
    assert.equal(response.status, 200, html.slice(0, 300));
    assert.match(response.headers.get("Content-Type"), /text\/html/);
    assert.match(response.headers.get("Content-Disposition"), inline ? /^inline;/ : /^attachment;/);
    assert.match(response.headers.get("Content-Disposition"), /filename\*=UTF-8''/);
    assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal(response.headers.get("X-Frame-Options"), "DENY");
    assert.equal(response.headers.get("Content-Security-Policy"), "frame-ancestors 'none'");
    assert.match(html, /<!DOCTYPE html>/i);
    assert.match(html, /for \(const node of nodeMap.values\(\)\)/);
    assert.equal(await readFile(path, "utf8"), before);
  });
}

test("real export route accepts a deep history with the installed SDK", async (t) => {
  const { id, path, before } = await fixture(t, true);
  const response = await GET(new Request(`http://localhost/api/sessions/${id}/export?inline=1`), { params: Promise.resolve({ id }) });
  const html = await response.text();
  assert.equal(response.status, 200, html.slice(0, 300));
  assert.match(html, /<!DOCTYPE html>/i);
  assert.equal(await readFile(path, "utf8"), before);
});

test("missing history remains a 404 JSON refusal", async () => {
  const response = await GET(new Request("http://localhost/api/sessions/missing/export?inline=1"), {
    params: Promise.resolve({ id: "missing" }),
  });
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "Session not found" });
});

// The route writes its export under a private per-request temp directory, so two
// concurrent exports never share (or delete) each other's file.
const routeSource = await readFile(new URL("./[id]/export/route.ts", import.meta.url), "utf8");

test("session export uses a private per-request temp directory", () => {
  assert.match(routeSource, /mkdtempSync\(join\(tmpdir\(\), "pi-web-export-"\)\)/);
  assert.doesNotMatch(routeSource, /join\(tmpdir\(\), "pi-web-export"\)/);
  assert.match(routeSource, /rmSync\(tempDir, \{ recursive: true, force: true \}\)/);
});
