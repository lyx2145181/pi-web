import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { createJiti } from "jiti";
import ts from "typescript";

const source = await readFile(new URL("./[id]/export/route.ts", import.meta.url), "utf8");
const parsed = ts.createSourceFile("route.ts", source, ts.ScriptTarget.Latest, true);
const patchDeclaration = parsed.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "patchExportHtml");
assert.ok(patchDeclaration);
const patchExportHtml = runInNewContext(ts.transpileModule(
  patchDeclaration.getText(parsed) + "\npatchExportHtml;",
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText);
const template = await readFile(new URL("../../../node_modules/@earendil-works/pi-coding-agent/dist/core/export-html/template.js", import.meta.url), "utf8");

const legacySort = `        function sortChildren(node) {
          node.children.sort((a, b) =>
            new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime()
          );
          node.children.forEach(sortChildren);
        }`;
const legacyMap = `          function mapNodes(node) {
            treeNodeMap.set(node.entry.id, node);
            node.children.forEach(mapNodes);
          }
          tree.forEach(mapNodes);`;
const legacyMark = `        function markActive(node) {
          let has = activePathIds.has(node.entry.id);
          for (const child of node.children) {
            if (markActive(child)) has = true;
          }
          containsActive.set(node, has);
          return has;
        }`;
const legacy = [legacySort, legacyMap, legacyMark].join("\n");

function deepEntries() {
  const start = Date.parse("2026-01-01T00:00:00Z");
  const entries = Array.from({ length: 25_000 }, (_, i) => ({
    id: `n${i}`, parentId: i ? `n${i - 1}` : null, timestamp: new Date(start + i).toISOString(),
  }));
  // Insert an older sibling last: timestamp sorting, not insertion order, must win.
  entries.push({ id: "older-sibling", parentId: "n100", timestamp: new Date(start).toISOString() });
  return entries;
}

test("the installed SDK's already-iterative template passes through, including CRLF", () => {
  assert.equal(patchExportHtml(template), template);
  assert.equal(patchExportHtml(template.replace(/\n/g, "\r\n")), template);
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

test("legacy helpers remain stack-safe and preserve sibling and active-path semantics", () => {
  const entries = deepEntries();
  const nodes = new Map(entries.map((entry) => [entry.id, { entry, children: [] }]));
  for (const entry of entries) {
    if (entry.parentId) nodes.get(entry.parentId).children.push(nodes.get(entry.id));
  }
  const tree = [nodes.get("n0")];
  const treeNodeMap = new Map();
  const containsActive = new Map();
  runInNewContext(patchExportHtml(legacy) + "\nsortChildren(tree[0]); markActive(tree[0]);", {
    tree, treeNodeMap, containsActive, activePathIds: new Set(["n24999"]),
  }, { timeout: 10_000 });
  assert.equal(treeNodeMap.size, 25_001);
  assert.equal(containsActive.get(nodes.get("n0")), true);
  assert.equal(containsActive.get(nodes.get("n24999")), true);
  assert.equal(containsActive.get(nodes.get("older-sibling")), false);
  assert.deepEqual(nodes.get("n100").children.map((node) => node.entry.id), ["older-sibling", "n101"]);
  assert.equal(patchExportHtml(legacy.replace(/\n/g, "\r\n")), patchExportHtml(legacy));
});

test("unknown, partial and duplicate templates still fail rather than silently skipping repairs", () => {
  assert.throws(() => patchExportHtml("<html>unknown template</html>"), /sortChildren expected 1 match, found 0/);
  assert.throws(() => patchExportHtml(legacySort + legacyMark), /mapNodes expected 1 match, found 0/);
  assert.throws(() => patchExportHtml(legacy + legacySort), /sortChildren expected 1 match, found 2/);
  assert.throws(() => patchExportHtml(template.replace("const pending = [...roots];", "const pending = roots;")), /expected 1 match, found 0/);
  assert.throws(() => patchExportHtml(template + legacySort), /mapNodes expected 1 match, found 0/);
});

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
