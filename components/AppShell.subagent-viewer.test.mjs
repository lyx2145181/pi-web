import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

function viewerMountBlock() {
  const start = source.indexOf("{activeAgentTab && ");
  assert.notEqual(start, -1, "the SubagentViewer mount block was not found");
  const renderStart = source.indexOf("<SubagentViewer", start);
  assert.notEqual(renderStart, -1, "SubagentViewer was not rendered in the mount block");
  const end = source.indexOf("\n          )}", renderStart);
  assert.notEqual(end, -1, "the SubagentViewer mount block end was not found");
  return source.slice(start, end);
}

// Runs the actual inline callback AppShell hands the viewer, so a wrong source
// session or a dropped page cannot pass by matching text.
function runViewerOpenFile(sessionId, filePath, page) {
  const block = viewerMountBlock();
  const propStart = block.indexOf("onOpenFile={");
  assert.notEqual(propStart, -1, "onOpenFile was not bound on SubagentViewer");
  const exprStart = propStart + "onOpenFile={".length;
  const exprEnd = block.indexOf("\n              )}", exprStart);
  assert.notEqual(exprEnd, -1, "the onOpenFile expression end was not found");
  const expression = block.slice(exprStart, exprEnd + "\n              )".length);
  const calls = [];
  const context = vm.createContext({
    activeAgentTab: { sessionId },
    getFileName: (path) => path.slice(path.lastIndexOf("/") + 1),
    handleOpenFile: (...args) => { calls.push(args); },
  });
  const callback = vm.runInContext(stripTypeScriptTypes(expression), context);
  callback(filePath, page);
  assert.equal(calls.length, 1, "handleOpenFile is called exactly once");
  return calls[0];
}

test("the viewer tab is mounted only while the right panel is open", () => {
  assert.match(viewerMountBlock(), /^\{activeAgentTab && rightPanelOpen && \(/);
});

test("a viewer file link opens under the child session, not the selected chat", () => {
  const [, name, options] = runViewerOpenFile("child-session", "/repo/docs/spec.pdf", 7);
  assert.equal(name, "spec.pdf");
  assert.equal(options.sourceSessionId, "child-session");
  assert.equal(options.page, 7, "the PDF page is preserved");
});

test("a viewer file link without a page passes no page", () => {
  const [, name, options] = runViewerOpenFile("child-session", "/repo/src/a.ts", undefined);
  assert.equal(name, "a.ts");
  assert.equal(options.sourceSessionId, "child-session");
  assert.equal(options.page, undefined);
});
