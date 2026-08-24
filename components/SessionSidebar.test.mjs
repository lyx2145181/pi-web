import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
const sessionItemSource = source.slice(source.indexOf("function SessionItem("));

test("only Shift+click bypasses session deletion confirmation", () => {
  assert.match(
    sessionItemSource,
    /const handleDeleteClick[\s\S]*?if \(e\.shiftKey\) \{\s*void performDelete\(\);\s*\} else \{\s*setConfirmDelete\(true\);/,
  );
});

test("persists recursive session-tree collapse state outside unmounted rows", () => {
  const treeItemSource = source.slice(
    source.indexOf("function SessionTreeItem("),
    source.indexOf("function RunningSessionIndicator"),
  );
  assert.match(source, /setCollapsedSessionIds\(loadCollapsedSessionIds\(\)\)/);
  assert.match(source, /saveCollapsedSessionIds\(next\)/);
  assert.match(treeItemSource, /collapsedSessionIds\.has\(node\.session\.id\)/);
  assert.match(treeItemSource, /onCollapseChange\(node\.session\.id, !collapsed\)/);
  assert.doesNotMatch(treeItemSource, /useState\(false\)/);
});

test("does not register row-level session deletion shortcuts", () => {
  assert.doesNotMatch(sessionItemSource, /const handleKeyDown/);
  assert.doesNotMatch(sessionItemSource, /onKeyDown=\{handleKeyDown\}/);
  assert.doesNotMatch(sessionItemSource, /tabIndex=\{0\}/);
});

test("polls running sessions only while the tab is visible", () => {
  assert.doesNotMatch(source, /new EventSource\("\/api\/agent\/running\/events"\)/);
  assert.match(source, /fetch\("\/api\/agent\/running"/);
  assert.match(source, /document\.visibilityState !== "visible"/);
  assert.match(source, /document\.addEventListener\("visibilitychange", onVisibilityChange\)/);
});

test("exposes the polled running-session set to the shell", () => {
  assert.match(source, /onRunningSessionIdsChange\?: \(ids: Set<string>\) => void/);
  assert.match(source, /onRunningSessionIdsChange\?\.\(runningSessionIds\)/);
});

test("includes project activity counts in accessible labels", () => {
  assert.match(
    source,
    /aria-label=\{`\$\{t\("sidebar\.agentRunning"\)\} \(\$\{activity\.running\}\)`\}/,
  );
  assert.match(
    source,
    /aria-label=\{`\$\{t\("sidebar\.newSessionActivity"\)\} \(\$\{activity\.unread\}\)`\}/,
  );
});

test("summarizes running and completed activity across every project", () => {
  assert.match(source, /const workspaceActivity = useMemo\(\(\) => \{/);
  assert.match(source, /for \(const activity of projectActivity\.values\(\)\)/);
  assert.match(source, /<WorkspaceActivitySummary activity=\{workspaceActivity\} \/>/);
  assert.match(source, /sidebar\.backgroundSessionRunning/);
  assert.match(source, /sidebar\.backgroundSessionComplete/);
});

test("does not persist an unchanged fallback title ending in whitespace", () => {
  assert.match(
    sessionItemSource,
    /const name = renameValue\.trim\(\);[\s\S]*?if \(renameValue === title \|\| name === \(session\.name \?\? ""\)\) return;/,
  );
});

test("offers the downstream context-menu hook only on a normal session row", () => {
  assert.match(sessionItemSource, /const handleContextMenu[\s\S]*?dispatchSessionRowContextMenu\(\{/);
  assert.match(
    sessionItemSource,
    /onContextMenu=\{confirmDelete \|\| renaming \? undefined : handleContextMenu\}/,
  );
});

test("only manual refresh bypasses the server session-list cache", () => {
  assert.match(source, /force \? "\/api\/sessions\?force=1" : "\/api\/sessions"/);
  assert.match(source, /cache: "no-store"/);
  assert.match(source, /void loadSessions\(isFirst, false\)/);
  assert.match(source, /onClick=\{\(\) => loadSessions\(false, true\)\}/);
  assert.match(source, /loadSessions\(false, false\);[\s\S]*?onBackgroundTaskDone/);
});

test("Strict Effects replay does not issue a second session-list request", () => {
  const effectStart = source.indexOf("const sessionRefreshEffectRef = useRef");
  const effectEnd = source.indexOf("// Browser storage is unavailable", effectStart);
  const effect = source.slice(effectStart, effectEnd);
  assert.match(effect, /effect\.initialized && Object\.is\(effect\.refreshKey, refreshKey\)/);
  assert.match(effect, /void loadSessions\(isFirst, false\)/);

  const state = { initialized: false, refreshKey: undefined };
  const calls = [];
  for (const refreshKey of [undefined, undefined]) {
    if (state.initialized && Object.is(state.refreshKey, refreshKey)) continue;
    const isFirst = !state.initialized;
    state.initialized = true;
    state.refreshKey = refreshKey;
    calls.push({ showLoading: isFirst, force: false });
  }
  assert.deepEqual(calls, [{ showLoading: true, force: false }]);
});

test("session-list requests abort predecessors and ignore stale responses", () => {
  assert.match(source, /sessionListControllerRef\.current\?\.abort\(\)/);
  assert.match(source, /signal: controller\.signal/);
  assert.match(source, /if \(requestId !== sessionListRequestRef\.current\) return/);
  assert.match(source, /name !== "AbortError"/);
});

test("a replacement refresh always clears initial loading state", () => {
  const loadBlock = source.slice(
    source.indexOf("const loadSessions = useCallback"),
    source.indexOf("const sessionRefreshEffectRef"),
  );
  assert.match(loadBlock, /if \(requestId === sessionListRequestRef\.current\) \{[\s\S]*setLoading\(false\)/);
  assert.doesNotMatch(loadBlock, /if \(showLoading\) setLoading\(false\)/);
});

test("does not expose disk-backed actions for transient sessions", () => {
  assert.match(sessionItemSource, /if \(session\.transient\) return;/);
  assert.match(sessionItemSource, /\{hovered && !session\.transient && \(/);
});
