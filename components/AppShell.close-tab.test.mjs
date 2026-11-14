import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

// Closing a side chat's tab happens after the DELETE request settles, so it can
// land after the main chat moved to another session (and that session's own side
// tabs were restored). The close must only touch the tabs of the moment: a
// closed-over list would put the other session's tabs back and then save them
// into the sessionStorage entry of the one now shown.
const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const parsed = ts.createSourceFile("AppShell.tsx", source, ts.ScriptTarget.Latest, true);
const declarations = [];
(function visit(node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) declarations.push(node);
  ts.forEachChild(node, visit);
})(parsed);
const declaration = declarations.find((node) => node.name.text === "handleCloseFileTab");
assert.ok(declaration, "AppShell still declares handleCloseFileTab");
const initializer = declaration.initializer;
assert.ok(initializer && ts.isCallExpression(initializer), "it is still a useCallback call");
// The arrow function itself, not the call and its dependency list: the close
// must work whichever dependencies it declares (none, as of the fix).
const closeSource = ts.transpileModule(`(${initializer.arguments[0].getText(parsed)});`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

/** The panel at the moment the delete was clicked, and again after a switch. */
function panel(state) {
  return {
    agentTabs: state.agentTabs,
    fileTabs: state.fileTabs,
    terminalTabs: state.terminalTabs,
    activeFileTabId: state.activeFileTabId,
    rightPanelOpen: state.rightPanelOpen,
  };
}

function setup(clickTime) {
  const state = panel(clickTime);
  const saved = new Map();
  // The render's refs, plus the plain variables an older implementation closed
  // over: both name the tabs seen at click time, so either shape can be run and
  // only a version that reads the refs keeps the shown session intact.
  const context = {
    fileTabs: clickTime.fileTabs,
    terminalTabs: clickTime.terminalTabs,
    agentTabs: clickTime.agentTabs,
    fileTabsRef: { current: clickTime.fileTabs },
    terminalTabsRef: { current: clickTime.terminalTabs },
    agentTabsRef: { current: clickTime.agentTabs },
    lastAgentTabId: (tabs) => (tabs.length ? `agent:${tabs.at(-1).sessionId}` : null),
    useCallback: (fn) => fn,
    setAgentTabs: (value) => { state.agentTabs = typeof value === "function" ? value(state.agentTabs) : value; },
    setFileTabs: (value) => { state.fileTabs = typeof value === "function" ? value(state.fileTabs) : value; },
    setTerminalTabs: (value) => { state.terminalTabs = typeof value === "function" ? value(state.terminalTabs) : value; },
    setActiveFileTabId: (value) => { state.activeFileTabId = typeof value === "function" ? value(state.activeFileTabId) : value; },
    setRightPanelOpen: (value) => { state.rightPanelOpen = value; },
  };
  const close = vm.runInNewContext(closeSource, context);
  // A new render after a session switch: the live state and the refs move on, a
  // closed-over variable would keep click-time values.
  const render = (next) => {
    Object.assign(state, next);
    context.fileTabsRef.current = state.fileTabs;
    context.terminalTabsRef.current = state.terminalTabs;
    context.agentTabsRef.current = state.agentTabs;
  };
  // `rememberSideTabs` as AppShell writes it: this browser tab's record for the
  // main session shown now, from its side tabs only.
  const remember = (rootSessionId) => {
    const tabs = state.agentTabs.filter((tab) => tab.side);
    saved.set(rootSessionId, tabs.map((tab) => tab.sessionId));
  };
  return { close, render, remember, state, saved, source: closeSource };
}

test("a side chat's close that lands after the session switch leaves the shown session intact", () => {
  const env = setup(panel({
    agentTabs: [{ sessionId: "a1", label: "A1", side: true }, { sessionId: "a2", label: "A2", side: true }],
    fileTabs: [], terminalTabs: [], activeFileTabId: "agent:a1", rightPanelOpen: true,
  }));
  env.remember("main-a");
  const clickTimeSaved = [...env.saved.get("main-a")];
  // While the delete was out, the user switched to another session, whose own
  // side tab b1 was restored.
  env.render(panel({
    agentTabs: [{ sessionId: "b1", label: "B1", side: true }],
    fileTabs: [{ id: "file:b", label: "b.ts", filePath: "/b.ts" }],
    terminalTabs: [], activeFileTabId: "agent:b1", rightPanelOpen: true,
  }));
  env.close("agent:a1");
  assert.deepEqual(env.state.agentTabs.map((tab) => tab.sessionId), ["b1"], "the shown session keeps its own tab");
  assert.equal(env.state.activeFileTabId, "agent:b1", "and its active tab stays active");
  assert.equal(env.state.rightPanelOpen, true, "the panel stays open");
  env.remember("main-b");
  assert.deepEqual(env.saved.get("main-b"), ["b1"], "nothing of the other session is saved into this one's record");
  assert.deepEqual(env.saved.get("main-a"), clickTimeSaved, "the other session's record is left as it was");
});

test("a stale close cannot drop the shown session's tabs either", () => {
  // The mirror image: the deleted side chat belongs to the session shown now,
  // and the click-time list is empty, as on a first visit.
  const env = setup(panel({
    agentTabs: [], fileTabs: [], terminalTabs: [], activeFileTabId: null, rightPanelOpen: false,
  }));
  env.render(panel({
    agentTabs: [{ sessionId: "a1", label: "A1", side: true }, { sessionId: "a2", label: "A2", side: true }],
    fileTabs: [], terminalTabs: [], activeFileTabId: "agent:a1", rightPanelOpen: true,
  }));
  env.close("agent:a1");
  assert.deepEqual(env.state.agentTabs.map((tab) => tab.sessionId), ["a2"], "the current list is filtered, not replaced by a stale one");
  assert.equal(env.state.activeFileTabId, "agent:a2", "the next tab takes over");
});

test("closing the last tab of the shown session picks the next tab and closes the panel", () => {
  const env = setup(panel({
    agentTabs: [{ sessionId: "a1", label: "A1", side: true }],
    fileTabs: [], terminalTabs: [], activeFileTabId: "agent:a1", rightPanelOpen: true,
  }));
  env.close("agent:a1");
  assert.deepEqual(env.state.agentTabs, []);
  assert.equal(env.state.activeFileTabId, null);
  assert.equal(env.state.rightPanelOpen, false, "the panel closes with its last tab");
});

test("a late close of a terminal acts on the terminals shown now", () => {
  const env = setup(panel({
    agentTabs: [], fileTabs: [], terminalTabs: [{ id: "terminal:t1", cwd: "/one" }], activeFileTabId: "terminal:t1", rightPanelOpen: true,
  }));
  env.render(panel({
    agentTabs: [], fileTabs: [{ id: "file:b", label: "b.ts", filePath: "/b.ts" }],
    terminalTabs: [{ id: "terminal:t2", cwd: "/two" }], activeFileTabId: "terminal:t2", rightPanelOpen: true,
  }));
  env.close("terminal:t2");
  assert.deepEqual(
    env.state.terminalTabs.map(({ id, cwd, closing }) => ({ id, cwd, closing })),
    [{ id: "terminal:t2", cwd: "/two", closing: "close" }],
    "the shown terminal is the one closed",
  );
  assert.deepEqual(env.state.fileTabs.map((tab) => tab.id), ["file:b"], "the file branch did not run");
  assert.equal(env.state.activeFileTabId, "terminal:t2");
});

test("a late close of a file tab falls back on the tabs shown now", () => {
  const env = setup(panel({
    agentTabs: [], fileTabs: [{ id: "file:a", label: "a.ts", filePath: "/a.ts" }], terminalTabs: [], activeFileTabId: "file:a", rightPanelOpen: true,
  }));
  env.render(panel({
    agentTabs: [{ sessionId: "b1", label: "B1", side: true }],
    fileTabs: [{ id: "file:a", label: "a.ts", filePath: "/a.ts" }, { id: "file:b", label: "b.ts", filePath: "/b.ts" }],
    terminalTabs: [], activeFileTabId: "file:a", rightPanelOpen: true,
  }));
  env.close("file:a");
  assert.deepEqual(env.state.fileTabs.map((tab) => tab.id), ["file:b"], "the current list is filtered, not replaced");
  assert.equal(env.state.activeFileTabId, "file:b");
});
