import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createJiti } from "jiti";

// Switching the model while a run streams (#1527) reads the live state after
// the switch, because the session file would replace the run's messages under
// the stream. That read is a bounded refresh, and the displayed model/level have
// one ordering rule: a read applies only while it is newer than every read
// already applied and no direct write happened after it was issued. A slow
// reconcile/settle poll that started before the switch must not put the old
// model back over the switch's own read, and a level picked after Stop must win
// over a read that left before it.
const shimPath = fileURLToPath(new URL("./__fixtures__/react-hook-shim.mjs", import.meta.url));
const jiti = createJiti(import.meta.url, { tsconfigPaths: true, alias: { react: shimPath } });
const { renderHook } = await import(pathToFileURL(shimPath).href);
const { useAgentSession } = await jiti.import("./useAgentSession.ts");

globalThis.document ??= Object.assign(new EventTarget(), { visibilityState: "visible" });
globalThis.window ??= new EventTarget();

const source = await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8");
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const settle = async () => { for (let index = 0; index < 12; index++) await new Promise((resolve) => setImmediate(resolve)); };
const deferred = () => Promise.withResolvers();

const model = (provider, id) => ({ provider, id });
const emptyContext = { messages: [], entryIds: [], oldestEntryId: null, hasMore: false };

async function setup({ holdSessionState = false } = {}) {
  const sources = [];
  const commands = [];
  const server = { running: true, model: model("p2", "m2"), thinkingLevel: "medium", switchFailure: null };
  // Live-state reads wait for the test, so a late reply can be made to arrive
  // after what superseded it. `hold` picks which ones wait.
  const held = { status: [], sessionState: [], history: [], tools: [] };
  const hold = { status: false, sessionState: holdSessionState, history: false, tools: false };
  globalThis.EventSource = class {
    readyState = 0;
    onmessage = null;
    onerror = null;
    constructor(url) { this.url = url; sources.push(this); }
    close() { this.readyState = 2; }
    connect() {
      this.readyState = 1;
      this.onmessage?.({ data: JSON.stringify({ type: "connected", sessionId: "A", isStreaming: false }) });
    }
    emit(event) {
      this.readyState = 1;
      this.onmessage?.({ data: JSON.stringify(event) });
    }
  };
  const stateBody = () => ({ running: server.running, state: { isStreaming: server.running, isPromptRunning: true, model: server.model, thinkingLevel: server.thinkingLevel } });
  globalThis.fetch = async (requestUrl, init = {}) => {
    const url = String(requestUrl);
    if (url.startsWith("/api/models")) return json({ models: {}, modelList: [] });
    if (url.startsWith("/api/sessions/A/context?")) return json({ context: emptyContext });
    if (url.startsWith("/api/sessions/A?")) {
      const body = { sessionId: "A", filePath: "/A.jsonl", leafId: null, tree: [], treeFormat: "summary", snapshotRevision: "r:", context: emptyContext };
      if (!hold.history) return json(body);
      const answer = deferred();
      held.history.push({ answer });
      return answer.promise;
    }
    if (url === "/api/sessions/A/state") {
      if (!hold.sessionState) return json(stateBody());
      const answer = deferred();
      held.sessionState.push({ answer, signal: init.signal ?? null });
      return answer.promise;
    }
    if (url.startsWith("/api/agent/A?systemPrompt=0") && !init.body) {
      if (!hold.status) return json(stateBody());
      const answer = deferred();
      held.status.push({ answer, signal: init.signal ?? null });
      return answer.promise;
    }
    if (url === "/api/agent/A" && init.body) {
      const command = JSON.parse(init.body);
      commands.push(command.type);
      if (command.type === "get_state" && hold.tools) {
        const answer = deferred();
        held.tools.push({ answer });
        return answer.promise;
      }
      if (command.type === "set_model") {
        if (server.switchFailure) return json({ error: server.switchFailure }, 500);
        return json({ success: true, data: { provider: command.provider, id: command.modelId } });
      }
      return json({ success: true, data: null });
    }
    if (url === "/api/agent/A") return json(stateBody());
    return json({});
  };
  const hook = renderHook(useAgentSession, {
    session: { id: "A", cwd: "/project", path: "/A.jsonl", name: "A" },
    newSessionCwd: null, newSessionDraftKey: null, t: (key) => key,
  });
  await settle();
  hook.flush();
  for (const stream of sources) if (stream.readyState === 0) stream.connect();
  await settle();
  hook.flush();
  if (holdSessionState) hold.sessionState = false;
  const env = {
    hook, sources, commands, held, hold, server,
    async emit(event) {
      const open = sources.filter((stream) => stream.readyState === 1).at(-1);
      assert.ok(open, "the session's stream is open");
      open.emit(event);
      await settle();
      hook.flush();
    },
    async startRun() {
      await env.emit({ type: "agent_start" });
      assert.equal(hook.result.agentRunning, true, "the run is streaming");
    },
    async finishRun() {
      await hook.result.handleAbort();
      await env.emit({ type: "prompt_done", aborted: true });
      await env.emit({ type: "agent_settled", aborted: true });
      assert.equal(hook.result.agentRunning, false, "the run ended");
    },
    async answer(which, body) {
      const entry = held[which].shift();
      assert.ok(entry, `a ${which} read is waiting`);
      entry.answer.resolve(body === "abort" ? Promise.reject(new DOMException("aborted", "AbortError")) : json(body));
      await settle();
      hook.flush();
    },
    /** Answers the newest held read first (the caller then answers the older one). */
    async answerNewest(which, body) {
      const entry = held[which].pop();
      assert.ok(entry, `a ${which} read is waiting`);
      entry.answer.resolve(json(body));
      await settle();
      hook.flush();
    },
    state: () => json({ running: server.running, state: { isStreaming: server.running, isPromptRunning: true, model: server.model, thinkingLevel: server.thinkingLevel } }),
    close() {
      hook.unmount();
      for (const stream of sources) stream.close();
    },
  };
  return env;
}

test("the live read after a mid-run switch is bounded, so the selector is released", async () => {
  // Source-level, because the deadline is what the read is handed to the browser:
  // a read with no deadline could keep `modelSwitching` true for good.
  const constant = source.match(/const LIVE_STATE_READ_TIMEOUT_MS = ([\d_]+);/);
  assert.ok(constant, "the read has a named deadline");
  const ms = Number(constant[1].replaceAll("_", ""));
  assert.ok(ms > 0 && ms <= 15_000, `the deadline is short (${ms} ms)`);
  assert.match(source, /signal: AbortSignal\.timeout\(LIVE_STATE_READ_TIMEOUT_MS\)/);

  const env = await setup();
  try {
    await env.startRun();
    env.hold.status = true;
    const switching = env.hook.result.handleModelChange("p2", "m2");
    await settle();
    env.hook.flush();
    assert.equal(env.held.status.length, 1, "the switch reads the live state");
    assert.ok(env.held.status[0].signal instanceof AbortSignal, "the read carries a deadline signal");
    assert.equal(env.hook.result.modelSwitching, false, "the selector is usable while the refresh is out");
    assert.equal(env.hook.result.currentModel?.modelId, "m2");
    await env.answer("status", { state: { model: model("p2", "m2"), thinkingLevel: "high" } });
    await switching;
    assert.equal(env.hook.result.thinkingLevel, "high");
  } finally {
    env.close();
  }
});

test("a poll that started before the switch cannot put the old model back over it", async () => {
  // The mount's state read is the same code path as the reconcile poll; holding
  // it models a poll that was already out when the user switched.
  const env = await setup({ holdSessionState: true });
  try {
    assert.equal(env.held.sessionState.length, 1, "a state read was already out");
    await env.startRun();
    env.hold.status = true;
    const switching = env.hook.result.handleModelChange("p2", "m2");
    await settle();
    env.hook.flush();
    assert.equal(env.held.status.length, 1, "the switch's own read is out");
    // The older read answers first with the model it saw before the switch.
    env.server.model = model("m1", "m1");
    await env.answer("sessionState", { running: true, state: { model: model("m1", "m1"), thinkingLevel: "low" } });
    assert.equal(env.hook.result.currentModel?.modelId, "m2", "the older read is dropped");
    await env.answer("status", { state: { model: model("p2", "m2"), thinkingLevel: "high" } });
    await switching;
    assert.equal(env.hook.result.currentModel?.modelId, "m2");
    assert.equal(env.hook.result.thinkingLevel, "high");
  } finally {
    env.close();
  }
});

test("two switch reads that answer out of order leave the newer one applied", async () => {
  const env = await setup();
  try {
    await env.startRun();
    env.hold.status = true;
    const first = env.hook.result.handleModelChange("p2", "m2");
    await settle();
    env.hook.flush();
    const second = env.hook.result.handleModelChange("p3", "m3");
    await settle();
    env.hook.flush();
    assert.equal(env.held.status.length, 2, "both reads are out");
    // The newer read answers first, then the older one arrives late.
    await env.answerNewest("status", { state: { model: model("p3", "m3"), thinkingLevel: "xhigh" } });
    await second;
    assert.equal(env.hook.result.currentModel?.modelId, "m3");
    await env.answer("status", { state: { model: model("p2", "m2"), thinkingLevel: "high" } });
    await first;
    assert.equal(env.hook.result.currentModel?.modelId, "m3", "the late older read does not apply");
    assert.equal(env.hook.result.thinkingLevel, "xhigh");
  } finally {
    env.close();
  }
});

test("a live read that answers after Stop and a new level does not overwrite them", async () => {
  const env = await setup();
  try {
    await env.startRun();
    env.hold.status = true;
    const switching = env.hook.result.handleModelChange("p2", "m2");
    await settle();
    env.hook.flush();
    assert.equal(env.held.status.length, 1);
    // Stop, then pick another level, then start the next run — all after the
    // read left, so the read's reply is older than every one of them.
    env.hold.status = false;
    await env.finishRun();
    await env.hook.result.handleThinkingLevelChange("high");
    await settle();
    env.hook.flush();
    const before = env.commands.filter((type) => type === "prompt").length;
    env.hook.result.handleSend("next task");
    await settle();
    env.hook.flush();
    assert.equal(env.commands.filter((type) => type === "prompt").length, before + 1, "the next run started");
    assert.equal(env.hook.result.thinkingLevel, "high", "the new level shows");
    const oldModel = model("p1", "m1");
    await env.answer("status", { state: { model: oldModel, thinkingLevel: "low" } });
    await switching;
    assert.equal(env.hook.result.thinkingLevel, "high", "the level picked after Stop stays");
    assert.equal(env.hook.result.currentModel?.modelId, "m2", "and the model the switch selected");
  } finally {
    env.close();
  }
});

test("a new run alone (no level change) still lets the switch's read apply", async () => {
  const env = await setup();
  try {
    await env.startRun();
    env.hold.status = true;
    const switching = env.hook.result.handleModelChange("p2", "m2");
    await settle();
    env.hook.flush();
    const firstRead = env.held.status[0];
    assert.ok(firstRead);
    env.hold.status = false;
    await env.finishRun();
    env.hook.result.handleSend("another task");
    await settle();
    env.hook.flush();
    assert.ok(env.commands.includes("prompt"), "a second run started");
    await env.answer("status", { state: { model: model("p2", "m2"), thinkingLevel: "high" } });
    await switching;
    assert.equal(env.hook.result.thinkingLevel, "high", "the read still applies: only the run id moved");
    assert.equal(env.hook.result.currentModel?.modelId, "m2");
  } finally {
    env.close();
  }
});

test("a refused switch reports it, restores the pick and lets the server settle the model", async () => {
  const env = await setup();
  try {
    await env.startRun();
    env.server.switchFailure = "model unavailable";
    env.hold.status = true;
    const switching = env.hook.result.handleModelChange("p2", "m2");
    await settle();
    env.hook.flush();
    assert.equal(env.hook.result.modelSwitching, false, "the selector is released");
    assert.deepEqual(env.hook.result.notices.map(({ type, message }) => [type, message]).filter(([type]) => type === "error"), [["error", "Failed to switch model: model unavailable"]]);
    assert.equal(env.held.status.length, 1, "a failed answer can still follow a server write, so the state is read");
    await env.answer("status", { state: { model: model("p1", "m1"), thinkingLevel: "low" } });
    await switching;
    assert.equal(env.hook.result.currentModel?.modelId, "m1", "the server's state settles it");
    assert.equal(env.hook.result.thinkingLevel, "low");
  } finally {
    env.close();
  }
});

test("an aborted refresh changes nothing and is not an error", async () => {
  const env = await setup();
  try {
    await env.startRun();
    env.hold.status = true;
    const switching = env.hook.result.handleModelChange("p2", "m2");
    await settle();
    env.hook.flush();
    assert.equal(env.held.status.length, 1);
    await env.answer("status", "abort");
    await switching;
    assert.equal(env.hook.result.currentModel?.modelId, "m2", "the switch itself stays");
    assert.equal(env.hook.result.thinkingLevel, "medium", "the old level is left as it was");
    assert.deepEqual(env.hook.result.notices.filter(({ type }) => type === "error"), [], "a dropped refresh is not a failure");
    assert.equal(env.hook.result.modelSwitching, false);
  } finally {
    env.close();
  }
});

test("a history read that started before the level change cannot put the file's older level back", async () => {
  const env = await setup();
  try {
    // A finished run whose next prompt makes the hook read the session file
    // (no live state: that read only carries the file's thinking level).
    await env.startRun();
    await env.finishRun();
    env.hold.history = true;
    env.hook.result.handleSend("first task");
    await settle();
    env.hook.flush();
    await env.startRun();
    await env.emit({ type: "prompt_done", aborted: true });
    await settle();
    env.hook.flush();
    assert.equal(env.held.history.length, 1, "the history read is out");
    await env.hook.result.handleThinkingLevelChange("high");
    await settle();
    env.hook.flush();
    assert.equal(env.hook.result.thinkingLevel, "high");
    await env.answer("history", {
      sessionId: "A", filePath: "/A.jsonl", leafId: null, tree: [], treeFormat: "summary", snapshotRevision: "r2:",
      context: { messages: [], entryIds: [], oldestEntryId: null, hasMore: false, thinkingLevel: "low", model: model("p1", "m1") },
    });
    assert.equal(env.hook.result.thinkingLevel, "high", "the level picked after the read left stays");
  } finally {
    env.close();
  }
});

test("a tools get_state that started before a level change cannot claim to be newer", async () => {
  const env = await setup();
  try {
    env.hold.tools = true;
    const switching = env.hook.result.handleToolPresetChange("read-only");
    await settle();
    env.hook.flush();
    assert.equal(env.held.tools.length, 1, "the get_state read is out");
    await env.hook.result.handleThinkingLevelChange("high");
    await settle();
    env.hook.flush();
    await env.answer("tools", { success: true, data: { systemPrompt: "PROMPT", thinkingLevel: "low", model: model("p1", "m1") } });
    await switching;
    await settle();
    env.hook.flush();
    assert.equal(env.hook.result.thinkingLevel, "high", "the response does not outrank the new level");
    assert.equal(env.hook.result.systemPrompt, "PROMPT", "the rest of the response still applies");
  } finally {
    env.close();
  }
});
