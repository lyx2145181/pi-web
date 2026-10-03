import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { createJiti } from "jiti";

// Simulated-SDK integration: real SessionManager persistence, no provider/model,
// no network. The role tool is created through the real route but its model calls
// are shadowed on the SDK session object, exactly as a fake provider would be.
const base = process.env.PI_WEB_ROLE_TEST_BASE
  ? join(process.env.PI_WEB_ROLE_TEST_BASE, "role-host-restore")
  : join(dirname(fileURLToPath(import.meta.url)), "..", "..", "role-host-restore");
mkdirSync(base, { recursive: true });
const root = mkdtempSync(join(base, "case-"));
const oldAgent = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
const project = join(root, "project");
mkdirSync(project);
execFileSync("git", ["init", "-q", project]);
const record = join(project, "_交付记录", "start-leaf", "demo");
mkdirSync(record, { recursive: true });
const otherRecord = join(project, "_交付记录", "start-leaf", "review");
mkdirSync(otherRecord, { recursive: true });
const taskPath = join(record, "任务.json");
const otherTaskPath = join(otherRecord, "任务.json");
const taskState = {
  version: 1, mode: "dispatcher-message-work", project_root: project, status: "running",
  dispatcher_session_id: null, work: null, previous_works: [], mailbox: [],
};
const writeTask = (path, value) => writeFileSync(path, JSON.stringify(value));
writeTask(taskPath, taskState);
writeTask(otherTaskPath, { ...taskState });

const jiti = createJiti(import.meta.url, { tsconfigPaths: true, moduleCache: true });
const { POST: newSession } = await jiti.import("../app/api/agent/new/route.ts");
const { POST: rolePost } = await jiti.import("../app/api/role-tasks/route.ts");
const { getRpcSession, startRpcSession } = await jiti.import("./rpc-manager.ts");
const role = await jiti.import("./role-tasks.ts");
let wrapper;
let sessionId;
let sessionFile;

function flush(w) {
  // SDK defers new JSONL writes until the first assistant message.
  w.inner.sessionManager.appendMessage({
    role: "assistant", content: [{ type: "text", text: "fixture" }], timestamp: Date.now(),
    api: "fixture", provider: "fixture", model: "fixture",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
  });
}

after(async () => {
  if (wrapper?.isAlive()) await wrapper.shutdown();
  if (oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = oldAgent;
  rmSync(root, { recursive: true, force: true });
});

test("archived historical session reopens for review but stays outside delivery", async () => {
  const response = await newSession(new Request("http://localhost/api/agent/new", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd: project, type: "ensure_session", roleTaskPath: taskPath, toolPolicy: "exact", toolNames: ["role_task_message"] }),
  }));
  const data = await response.json();
  assert.equal(response.status, 200, JSON.stringify(data));
  sessionId = data.sessionId;
  wrapper = getRpcSession(sessionId);
  flush(wrapper);
  sessionFile = wrapper.sessionFile;
  await wrapper.shutdown();

  // Archive the session, then reopen it with no active dispatcher/worker.
  const archived = {
    ...taskState,
    previous_works: [{ id: "work-0", session_id: sessionId, role: "审查", status: "reported" }],
  };
  writeTask(taskPath, archived);
  const task = role.readRoleTask(taskPath);
  assert.equal(role.restorableSession(task, sessionId), true);
  assert.equal(role.boundSession(task, sessionId), false);
  assert.equal(role.historicalSession(task, sessionId), true);

  wrapper = (await startRpcSession(sessionId, sessionFile, undefined)).session;
  const state = await wrapper.send({ type: "get_state" });
  assert.equal(state.sessionId, sessionId);
  assert.equal(state.roleModelPreference, null);

  // Main security guard: the real registered native tool refuses a historical
  // caller at execute time, before any Python driver call is possible.
  const roleTool = wrapper.inner.getToolDefinition("role_task_message");
  assert.ok(roleTool, "role_task_message is registered on the restored session");
  await assert.rejects(
    roleTool.execute("call-historical", { kind: "progress", text: "review" }, undefined, undefined, {
      sessionManager: { getSessionId: () => sessionId },
    }),
    /Role task binding no longer active/,
  );

  // A review chat must not wake the archived handoff, and a closed task never wakes.
  const runners = globalThis.__piRoleRunners;
  wrapper.requestCurrentRoleTick();
  assert.equal(runners?.has(taskPath) ?? false, false);
  archived.status = "handoff_complete";
  writeTask(taskPath, archived);
  wrapper.requestCurrentRoleTick();
  assert.equal(runners?.has(taskPath) ?? false, false);
  archived.status = "running";
  writeTask(taskPath, archived);

  // A mail event for the archived work is still refused: review cannot deliver.
  archived.mailbox = [{ id: "event-archived", work_id: "work-0", sender_id: "program", recipient_id: sessionId, kind: "reply", text: "old", status: "queued" }];
  archived.work = { id: "work-1", session_id: "next-worker", status: "running" };
  writeTask(taskPath, archived);
  const delivered = await rolePost(new Request("http://localhost/api/role-tasks", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "deliver", taskPath, eventId: "event-archived", recipientId: sessionId, text: "old" }),
  }));
  assert.equal(delivered.status, 400);

  // Persisted binding wins over a different task path: no cross-task reopen.
  await wrapper.shutdown();
  await assert.rejects(
    startRpcSession(sessionId, sessionFile, undefined, { roleTaskPath: otherTaskPath }),
    /Role binding mismatch/,
  );
  wrapper = (await startRpcSession(sessionId, sessionFile, undefined)).session;
});

test("user model preference persists across reopen while defaults cannot impersonate it", async () => {
  // The live session is the restored historical one with a persisted binding.
  const inner = wrapper.inner;
  const originalGetModel = inner.modelRuntime.getModel;
  const originalSetModel = inner.setModel;
  const originalSetThinking = inner.setThinkingLevel;
  inner.modelRuntime.getModel = (provider, modelId) => ({ provider, id: modelId });
  inner.setModel = async (model) => { inner.agent.state.model = model; };
  inner.setThinkingLevel = (level) => { inner.agent.state.thinkingLevel = level === "xhigh" ? "high" : level; };

  try {
    await wrapper.send({ type: "set_model", provider: "fixture", modelId: "fixture-model" });
    await wrapper.send({ type: "set_thinking_level", level: "xhigh" });
    let state = await wrapper.send({ type: "get_state" });
    assert.deepEqual(state.roleModelPreference, {
      version: 1, provider: "fixture", modelId: "fixture-model", thinkingLevel: "high",
    });

    // Defaults may not replace the recorded user choice, but cannot claim identity either.
    await assert.rejects(
      wrapper.send({ type: "set_model", provider: "default-provider", modelId: "default-model", roleModelSource: "defaults" }),
      (error) => error.code === "role_model_preference_locked",
    );
    assert.deepEqual((await wrapper.send({ type: "get_state" })).roleModelPreference, {
      version: 1, provider: "fixture", modelId: "fixture-model", thinkingLevel: "high",
    });

    flush(wrapper);
    await wrapper.shutdown();
    wrapper = (await startRpcSession(sessionId, sessionFile, undefined)).session;
    state = await wrapper.send({ type: "get_state" });
    // Reopened without a provider: the preference still comes from the custom entry.
    assert.deepEqual(state.roleModelPreference, {
      version: 1, provider: "fixture", modelId: "fixture-model", thinkingLevel: "high",
    });
  } finally {
    inner.modelRuntime.getModel = originalGetModel;
    inner.setModel = originalSetModel;
    inner.setThinkingLevel = originalSetThinking;
  }
});

test("an existing role session without a preference accepts default alignment", async () => {
  // Clear preference-bearing history by starting a second task/session with no override.
  writeTask(taskPath, { ...taskState, previous_works: [{ id: "work-0", session_id: "gone", role: "施工", status: "reported" }] });
  const response = await newSession(new Request("http://localhost/api/agent/new", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd: project, type: "ensure_session", roleTaskPath: taskPath, toolPolicy: "exact", toolNames: ["role_task_message"] }),
  }));
  const data = await response.json();
  assert.equal(response.status, 200, JSON.stringify(data));
  const fresh = getRpcSession(data.sessionId);
  fresh.inner.modelRuntime.getModel = (provider, modelId) => ({ provider, id: modelId });
  fresh.inner.setModel = async (model) => { fresh.inner.agent.state.model = model; };
  await fresh.send({ type: "set_model", provider: "role-default", modelId: "role-default", roleModelSource: "defaults" });
  assert.equal((await fresh.send({ type: "get_state" })).roleModelPreference, null);
  assert.equal(role.readRoleModelPreference(fresh.inner.sessionManager.getEntries()), undefined);
  await fresh.shutdown();
});
