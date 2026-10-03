import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const base = process.env.PI_WEB_ROLE_TEST_BASE
  ? join(process.env.PI_WEB_ROLE_TEST_BASE, "role-host-integration")
  : join(dirname(fileURLToPath(import.meta.url)), "..", "..", "role-host-integration");
mkdirSync(base, { recursive: true });
const root = mkdtempSync(join(base, "case-"));
const old = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
const cwd = join(root, "project");
mkdirSync(cwd);
execFileSync("git", ["init", "-q", cwd]);
const record = join(cwd, "_交付记录", "start-leaf", "demo");
mkdirSync(record, { recursive: true });
const taskPath = join(record, "任务.json");
const state = { version: 1, mode: "dispatcher-message-work", project_root: cwd, status: "running", dispatcher_session_id: null, mailbox: [] };
writeFileSync(taskPath, JSON.stringify(state));
const jiti = createJiti(import.meta.url, { tsconfigPaths: true, moduleCache: true });
const { POST: newSession } = await jiti.import("../app/api/agent/new/route.ts");
const { POST: rolePost, GET: roleGet } = await jiti.import("../app/api/role-tasks/route.ts");
const { getRpcSession, startRpcSession, setRpcSessionTools } = await jiti.import("./rpc-manager.ts");
const { readDeliveryReceipt, saveDeliveryReceipt } = await jiti.import("./role-tasks.ts");
let wrapper;
after(async () => {
  if (wrapper?.isAlive()) await wrapper.shutdown();
  if (old === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = old;
  rmSync(root, { recursive: true, force: true });
});
test("capability probe has no model or session side effect", async () => {
  const response = await roleGet(new Request("http://localhost/api/role-tasks?capabilities=1"));
  assert.deepEqual(await response.json(), { protocol: "start-leaf-role-messages-v1", nativeTool: "role_task_message", nonBlocking: true, historicalRoleRestore: true, roleModelPreference: true });
});
test("native role tool exact allowlist, bound restore and nonbound exclusion", async () => {
  const response = await newSession(new Request("http://localhost/api/agent/new", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, type: "ensure_session", roleTaskPath: taskPath, toolPolicy: "exact", toolNames: ["role_task_message"] }),
  }));
  const data = await response.json();
  assert.equal(response.status, 200, JSON.stringify(data));
  wrapper = getRpcSession(data.sessionId);
  assert.equal(wrapper.roleTaskPath, taskPath);
  assert.deepEqual((await wrapper.send({ type: "get_tools" })).filter((tool) => tool.active).map((tool) => tool.name), ["role_task_message"]);
  state.dispatcher_session_id = data.sessionId;
  writeFileSync(taskPath, JSON.stringify(state));
  // SDK defers writing new JSONL files until the first assistant message;
  // simulate that lifecycle without making a provider request.
  wrapper.inner.sessionManager.appendMessage({ role: "assistant", content: [{ type: "text", text: "fixture" }], timestamp: Date.now(), api: "fixture", provider: "fixture", model: "fixture", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop" });
  const sessionFile = wrapper.sessionFile;
  await wrapper.shutdown();
  wrapper = (await startRpcSession(data.sessionId, sessionFile, undefined)).session;
  assert.equal(wrapper.roleTaskPath, taskPath);
  assert.deepEqual((await wrapper.send({ type: "get_tools" })).filter((tool) => tool.active).map((tool) => tool.name), ["role_task_message"]);
  await assert.rejects(setRpcSessionTools(data.sessionId, sessionFile, []), /Bound role task tools/);
  const wrongCwd = join(root, "unrelated"); mkdirSync(wrongCwd);
  const rejected = await newSession(new Request("http://localhost/api/agent/new", { method: "POST", body: JSON.stringify({ cwd: wrongCwd, type: "ensure_session", roleTaskPath: taskPath }) }));
  assert.equal(rejected.status, 500);
  const watch = await rolePost(new Request("http://localhost/api/role-tasks", { method: "POST", body: JSON.stringify({ action: "watch", taskPath }) }));
  assert.equal((await watch.json()).status, "watching");
});
test("mailbox validation, busy admission and persistent duplicate receipt (mock SDK admission)", async () => {
  state.work = { id: "work-1", session_id: "worker", status: "running", role: "施工" };
  state.mailbox = [{ id: "event-0001", work_id: "work-1", sender_id: "program", recipient_id: state.dispatcher_session_id, kind: "inspection", text: "report ready", status: "queued" }];
  writeFileSync(taskPath, JSON.stringify(state));
  const send = wrapper.send;
  let calls = 0;
  let busy = true;
  wrapper.send = async (command) => {
    if (command.type !== "role_task_deliver") return send.call(wrapper, command);
    calls++;
    if (busy) return { status: "busy" };
    await command.onAdmitted();
    return null;
  };
  const post = (text) => rolePost(new Request("http://localhost/api/role-tasks", { method: "POST", body: JSON.stringify({ action: "deliver", taskPath, eventId: "event-0001", recipientId: state.dispatcher_session_id, text }) }));
  assert.equal((await (await post("report ready")).json()).status, "busy");
  busy = false;
  assert.equal((await (await post("report ready")).json()).status, "delivered");
  assert.equal((await (await post("report ready")).json()).status, "delivered");
  assert.equal(calls, 2);
  assert.equal((await (await post("different body")).status), 400);
  const receipt = await roleGet(new Request(`http://localhost/api/role-tasks?taskPath=${encodeURIComponent(taskPath)}&eventId=event-0001`));
  assert.equal((await receipt.json()).receipt.status, "delivered");
  state.mailbox.push({ id: "event-error", work_id: "work-1", sender_id: "program", recipient_id: state.dispatcher_session_id, kind: "inspection", text: "error", status: "queued" });
  writeFileSync(taskPath, JSON.stringify(state));
  wrapper.send = async () => ({ error: "synthetic" });
  const bad = await rolePost(new Request("http://localhost/api/role-tasks", { method: "POST", body: JSON.stringify({ action: "deliver", taskPath, eventId: "event-error", recipientId: state.dispatcher_session_id, text: "error" }) }));
  assert.equal(bad.status, 400);
  const noReceipt = await roleGet(new Request(`http://localhost/api/role-tasks?taskPath=${encodeURIComponent(taskPath)}&eventId=event-error`));
  assert.equal((await noReceipt.json()).receipt, null);
  wrapper.send = send;
});
test("real wrapper admission returns busy and rejects failed SDK preflight without model", async () => {
  const originalPrompt = wrapper.inner.prompt;
  const admitted = () => undefined;
  try {
    wrapper.inner.prompt = async () => { throw new Error("synthetic preflight rejection"); };
    await assert.rejects(wrapper.send({ type: "role_task_deliver", message: "fixture", onAdmitted: admitted }), /synthetic preflight rejection/);
    await assert.rejects(wrapper.send({ type: "role_task_deliver", message: "fixture" }), /trusted host admission/);
    let resolveRun;
    wrapper.inner.prompt = (_message, options) => {
      options.preflightResult(true);
      return new Promise((resolve) => { resolveRun = resolve; });
    };
    assert.equal(await wrapper.send({ type: "role_task_deliver", message: "fixture", onAdmitted: admitted }), null);
    assert.deepEqual(await wrapper.send({ type: "role_task_deliver", message: "fixture2", onAdmitted: admitted }), { status: "busy" });
    resolveRun();
    await new Promise((resolve) => setTimeout(resolve, 10));
  } finally { wrapper.inner.prompt = originalPrompt; }
});
test("unknown SDK outcome leaves durable uncertain receipt; late and concurrent retries never resend", async () => {
  const recipientId = state.dispatcher_session_id;
  const eventId = "event-unknown";
  state.mailbox.push({ id: eventId, work_id: state.work.id, sender_id: "program", recipient_id: recipientId, kind: "inspection", text: "uncertain delivery", status: "queued" });
  writeFileSync(taskPath, JSON.stringify(state));
  const originalSend = wrapper.send;
  let calls = 0;
  const request = () => rolePost(new Request("http://localhost/api/role-tasks", { method: "POST", body: JSON.stringify({ action: "deliver", taskPath, eventId, recipientId, text: "uncertain delivery" }) }));
  wrapper.send = async (command) => {
    calls++;
    await command.onAdmitted();
    throw new Error("synthetic lost SDK acknowledgement after admission");
  };
  try {
    const [first, concurrent] = await Promise.all([request(), request()]);
    assert.deepEqual([first, concurrent].map((response) => response.status), [200, 200]);
    assert.equal((await first.json()).status, "uncertain");
    assert.equal((await concurrent.json()).status, "uncertain");
    assert.equal(calls, 1);
    assert.equal(readDeliveryReceipt(taskPath, eventId).status, "uncertain");
    state.mailbox.at(-1).status = "delivering";
    writeFileSync(taskPath, JSON.stringify(state));
    assert.equal((await (await request()).json()).status, "uncertain");
    state.status = "handoff_complete";
    writeFileSync(taskPath, JSON.stringify(state));
    assert.equal((await (await request()).json()).status, "uncertain", "terminal task retains the receipt without redelivery");
    assert.equal(calls, 1);
  } finally {
    wrapper.send = originalSend;
    state.status = "running";
    writeFileSync(taskPath, JSON.stringify(state));
  }
});
test("reported worker cannot be reawakened, including during admission race", async () => {
  const previousWorker = state.work.session_id;
  const previousDispatcher = state.dispatcher_session_id;
  const originalSend = wrapper.send;
  const recipientId = state.dispatcher_session_id;
  // A professional worker is never the dispatcher; use the real fixture session
  // as the bound worker instead of aliasing the two membership roles.
  state.dispatcher_session_id = null;
  state.work.session_id = recipientId;
  state.work.role = "施工";
  state.work.status = "running";
  state.mailbox.push({ id: "event-race", work_id: "work-1", sender_id: "program", recipient_id: recipientId, kind: "reply", text: "old reply", status: "delivering" });
  writeFileSync(taskPath, JSON.stringify(state));
  const post = () => rolePost(new Request("http://localhost/api/role-tasks", { method: "POST", body: JSON.stringify({ action: "deliver", taskPath, eventId: "event-race", recipientId, text: "old reply" }) }));
  let prompted = false;
  wrapper.send = async (command) => {
    state.work.status = "reported";
    state.mailbox.at(-1).status = "superseded";
    writeFileSync(taskPath, JSON.stringify(state));
    await command.onAdmitted();
    prompted = true;
    return null;
  };
  try {
    assert.equal((await post()).status, 400);
    assert.equal(prompted, false);
    assert.equal(readDeliveryReceipt(taskPath, "event-race"), undefined);
    assert.equal((await post()).status, 400); // reported gate before wrapper
    saveDeliveryReceipt({ taskPath, eventId: "event-race", recipientId, text: "old reply", status: "delivered" });
    assert.equal((await (await post()).json()).status, "delivered"); // receipt-only, no prompt
    assert.equal(prompted, false);
  } finally {
    wrapper.send = originalSend;
    state.dispatcher_session_id = previousDispatcher;
    state.work.session_id = previousWorker;
    state.work.status = "running";
    writeFileSync(taskPath, JSON.stringify(state));
  }
});
test("handoff_complete disarms watch, retains read-only receipts, and refuses new delivery", async () => {
  state.status = "handoff_complete";
  writeFileSync(taskPath, JSON.stringify(state));
  const watch = await rolePost(new Request("http://localhost/api/role-tasks", { method: "POST", body: JSON.stringify({ action: "watch", taskPath }) }));
  assert.equal((await watch.json()).status, "finished");
  const receipt = await roleGet(new Request(`http://localhost/api/role-tasks?taskPath=${encodeURIComponent(taskPath)}&eventId=event-0001`));
  assert.equal((await receipt.json()).receipt.status, "delivered");
  state.mailbox.push({ id: "event-0002", work_id: "work-1", sender_id: "program", recipient_id: state.dispatcher_session_id, kind: "inspection", text: "late", status: "queued" });
  writeFileSync(taskPath, JSON.stringify(state));
  const late = await rolePost(new Request("http://localhost/api/role-tasks", { method: "POST", body: JSON.stringify({ action: "deliver", taskPath, eventId: "event-0002", recipientId: state.dispatcher_session_id, text: "late" }) }));
  assert.equal(late.status, 400);
});
