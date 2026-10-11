import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const root = await mkdtemp(join(tmpdir(), "pi-role-model-"));
const previous = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
process.env.HOME = join(root, "home"); process.env.PI_CODING_AGENT_DIR = join(root, "agent");
await mkdir(process.env.HOME); await mkdir(process.env.PI_CODING_AGENT_DIR);
const keepAlive = setInterval(() => {}, 1000);
after(async () => {
  clearInterval(keepAlive);
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
});
const { ModelRuntime, SessionManager, SettingsManager, createAgentSessionServices, createAgentSessionFromServices } = await import("@earendil-works/pi-coding-agent");
const { fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } = await import("@earendil-works/pi-ai");
const jiti = createJiti(import.meta.url);
const { createSubagentController } = await jiti.import("./subagent-runtime.ts");
const { createSubagentExtension } = await jiti.import("./subagent-extension.ts");
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
const { readSubagentSessionResources } = await jiti.import("./subagents.ts");

async function fixture(t, { pinned = "role-a/pin", allow, thinking } = {}) {
  const cwd = await mkdtemp(join(root, "cwd-")), profileDir = join(cwd, ".pi", "agents");
  await mkdir(profileDir, { recursive: true });
  const profilePath = join(profileDir, "model-child.md");
  await writeFile(profilePath, `---\ntools: none\n${pinned ? `model: ${pinned}\n` : ""}${thinking ? `thinking: ${thinking}\n` : ""}${allow === undefined ? "" : `allow_parent_model_override: ${allow}\n`}---\nFixture`);
  const a = fauxProvider({ provider: "role-a", models: [{ id: "pin", reasoning: true }, { id: "next", reasoning: true }, { id: "parent", reasoning: true }, { id: "shared", reasoning: true }, { id: "tuned:high", reasoning: true }] });
  const b = fauxProvider({ provider: "role-b", models: [{ id: "shared", reasoning: true }] });
  const runtime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null, refreshOnCreate: false });
  runtime.registerNativeProvider(a.provider); runtime.registerNativeProvider(b.provider);
  const requests = [];
  const response = (_context, _options, _state, model) => { requests.push(`${model.provider}/${model.id}`); return fauxAssistantMessage([fauxText("Fixture done")]); };
  a.setResponses(Array.from({ length: 10 }, () => response)); b.setResponses(Array.from({ length: 10 }, () => response));
  const manager = SessionManager.inMemory(cwd);
  const parent = { cwd, sessionFile: join(cwd, "parent.jsonl"), isAlive: () => true, isRunning: () => false, waitUntilReady: async () => {},
    inner: { sessionManager: manager, modelRuntime: runtime, model: a.getModel("parent"), agent: { state: {} } } };
  const wrappers = new Map([[manager.getSessionId(), parent]]);
  const controller = createSubagentController({
    getSession: (id) => wrappers.get(id),
    registerSession(inner, options) {
      const wrapper = new AgentSessionWrapper(inner, { ...options, subagentResources: readSubagentSessionResources(inner.sessionManager.getEntries()) });
      wrappers.set(inner.sessionId, wrapper); wrapper.beginExtensionBinding(); return wrapper.waitUntilReady();
    },
    reopenSession: async (id) => wrappers.get(id), resolveSessionPath: async () => null,
    invalidateSessionList: () => {}, isBuiltInSubagentsEnabled: () => true,
  });
  t.after(async () => {
    for (const [id, wrapper] of wrappers) if (id !== manager.getSessionId()) await wrapper.destroy();
    runtime.dispose?.();
  });
  const request = { parentContext: parent.inner, parentToolCallId: "model-fixture", profile: "model-child", description: "Model", task: "Fixture" };
  return { controller, request, requests, wrappers, parent, a, b, profilePath, cwd, runtime };
}

for (const [name, options, requested, expected] of [
  ["missing flag protects the role", {}, undefined, "role-a/pin"],
  ["closed accepts the same bare ID", { allow: false }, "pin", "role-a/pin"],
  ["closed accepts the same qualified ID", {}, "role-a/pin", "role-a/pin"],
  ["blank override retains the pinned model", {}, "  ", "role-a/pin"],
  ["closed ignores a different parent model without retry", {}, "role-a/next", "role-a/pin"],
  ["closed ignores the same ID on another provider", { pinned: "role-a/shared", allow: false }, "role-b/shared", "role-a/shared"],
  ["closed ignores an unknown parent model", {}, "role-a/removed", "role-a/pin"],
  ["closed ignores an ambiguous bare parent ID", {}, "shared", "role-a/pin"],
  ["open permits another provider", { allow: true }, "role-b/shared", "role-b/shared"],
  ["open without an override still uses the role", { allow: true }, undefined, "role-a/pin"],
  ["no specified model accepts parent choice", { pinned: null }, "role-a/next", "role-a/next"],
  ["no specified model inherits the parent", { pinned: null }, undefined, "role-a/parent"],
]) {
  test(name, async (t) => {
    const f = await fixture(t, options);
    const originalProfile = await readFile(f.profilePath, "utf8");
    const execution = await f.controller.extensionRuntime.start({ ...f.request, ...(requested === undefined ? {} : { model: requested }) });
    assert.equal((await execution.completion).status, "completed");
    assert.deepEqual(f.requests, [expected], "exactly one actual request using the selected model, without retry");
    assert.equal(await readFile(f.profilePath, "utf8"), originalProfile, "never rewrite the role's configured model");
  });
}

for (const [name, options, requested, error] of [
  ["missing pinned model is not substituted", { pinned: "role-a/removed" }, "role-a/next", /Subagent model not found/],
  ["open invalid override is not substituted", { allow: true }, "role-a/removed", /Subagent model not found/],
  ["unconfigured role still validates an explicit model", { pinned: null }, "role-a/removed", /Subagent model not found/],
]) {
  test(name, async (t) => {
    const f = await fixture(t, options);
    const before = await readdir(join(process.env.PI_CODING_AGENT_DIR, "sessions")).catch((error) => { if (error.code === "ENOENT") return []; throw error; });
    await assert.rejects(f.controller.extensionRuntime.start({ ...f.request, model: requested }), error);
    assert.equal(f.wrappers.size, 1, "reject before registering a child"); assert.deepEqual(f.requests, []);
    assert.deepEqual(await readdir(join(process.env.PI_CODING_AGENT_DIR, "sessions")).catch((error) => { if (error.code === "ENOENT") return []; throw error; }), before);
  });
}

test("a real Agent resume with an unknown model keeps the manually selected child model", async (t) => {
  const f = await fixture(t);
  const first = await f.controller.extensionRuntime.start(f.request);
  assert.equal((await first.completion).status, "completed");
  await f.wrappers.get(first.run.sessionId).send({ type: "set_model", provider: "role-a", modelId: "next" });
  await writeFile(f.profilePath, "---\ntools: none\nmodel: role-a/shared\nallow_parent_model_override: true\n---\nChanged role");
  const services = await createAgentSessionServices({
    cwd: f.cwd, agentDir: process.env.PI_CODING_AGENT_DIR, modelRuntime: f.runtime,
    settingsManager: SettingsManager.inMemory(),
    resourceLoaderOptions: {
      noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [createSubagentExtension(f.controller.extensionRuntime, () => [])],
    },
  });
  const { session } = await createAgentSessionFromServices({ services, sessionManager: f.parent.inner.sessionManager, model: f.b.getModel("shared") });
  t.after(() => session.dispose());
  f.b.setResponses([
    fauxAssistantMessage([fauxToolCall("Agent", { resume: first.run.sessionId, model: "unknown/ignored", prompt: "Continue", description: "Continue" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("done")]),
  ]);
  await session.prompt("Continue without changing the child's model");
  const results = session.agent.state.messages.filter((message) => message.role === "toolResult" && message.toolName === "Agent");
  assert.equal(results.length, 1, "no retry required");
  assert.equal(results[0].isError, false);
  assert.deepEqual(f.requests, ["role-a/pin", "role-a/next"], "ignore parent parameter and edited role; retain the child's actual model");
});

test("parent and role edits do not change a resumed child's model; a manual child change remains allowed", async (t) => {
  const f = await fixture(t);
  const first = await f.controller.extensionRuntime.start(f.request); assert.equal((await first.completion).status, "completed");
  f.parent.inner.model = f.b.getModel("shared");
  await writeFile(f.profilePath, "---\ntools: none\nmodel: role-a/next\nallow_parent_model_override: true\n---\nChanged role");
  const resumed = await f.controller.extensionRuntime.resume({ ...f.request, sessionId: first.run.sessionId });
  assert.equal((await resumed.completion).status, "completed"); assert.deepEqual(f.requests, ["role-a/pin", "role-a/pin"]);
  await f.wrappers.get(first.run.sessionId).send({ type: "set_model", provider: "role-a", modelId: "next" });
  const manual = await f.controller.extensionRuntime.resume({ ...f.request, sessionId: first.run.sessionId });
  assert.equal((await manual.completion).status, "completed"); assert.deepEqual(f.requests, ["role-a/pin", "role-a/pin", "role-a/next"]);
});

async function runModelThinking(f, requested) {
  f.requests.length = 0;
  const execution = await f.controller.extensionRuntime.start({ ...f.request, ...(requested === undefined ? {} : { model: requested }) });
  assert.equal((await execution.completion).status, "completed");
  const child = f.wrappers.get(execution.run.sessionId).inner;
  return { model: `${child.model.provider}/${child.model.id}`, thinking: child.thinkingLevel };
}

test("D3: explicit call thinking beats profile thinking, which beats the chosen model's :level suffix", async (t) => {
  const profileSuffix = await fixture(t, { pinned: "role-a/pin:high" });
  assert.deepEqual(await runModelThinking(profileSuffix, undefined), { model: "role-a/pin", thinking: "high" });

  const profileThinking = await fixture(t, { pinned: "role-a/pin:high", thinking: "medium" });
  assert.deepEqual(await runModelThinking(profileThinking, undefined), { model: "role-a/pin", thinking: "medium" });

  const callThinking = await fixture(t, { pinned: "role-a/pin:high", thinking: "medium" });
  const execution = await callThinking.controller.extensionRuntime.start({ ...callThinking.request, thinking: "low" });
  assert.equal((await execution.completion).status, "completed");
  assert.equal(callThinking.wrappers.get(execution.run.sessionId).inner.thinkingLevel, "low");

  const callSuffix = await fixture(t, { thinking: "medium" });
  assert.deepEqual(await runModelThinking(callSuffix, "role-a/pin:high"), { model: "role-a/pin", thinking: "medium" });
});

test("D3: a colon id matches whole and an invalid suffix is never stripped", async (t) => {
  const exact = await fixture(t, { pinned: null });
  assert.equal((await runModelThinking(exact, "role-a/tuned:high")).model, "role-a/tuned:high");

  const invalid = await fixture(t, { pinned: null });
  await assert.rejects(
    invalid.controller.extensionRuntime.start({ ...invalid.request, model: "role-a/pin:turbo" }),
    /Subagent model not found: role-a\/pin:turbo/,
  );
});

test("D3: a protected role ignores an attached invalid or suffixed model without rejecting", async (t) => {
  const f = await fixture(t, { pinned: "role-a/pin" });
  for (const requested of ["role-a/removed:turbo", "role-a/removed:high"]) {
    f.requests.length = 0;
    const execution = await f.controller.extensionRuntime.start({ ...f.request, model: requested });
    assert.equal((await execution.completion).status, "completed");
    assert.deepEqual(f.requests, ["role-a/pin"], `ignored ${requested}`);
  }
});

test("D3: a resume with an attached suffixed or invalid model keeps the child's model", async (t) => {
  const f = await fixture(t);
  const first = await f.controller.extensionRuntime.start(f.request);
  assert.equal((await first.completion).status, "completed");
  f.requests.length = 0;
  const resumed = await f.controller.extensionRuntime.resume({ ...f.request, sessionId: first.run.sessionId, model: "role-a/pin:turbo" });
  assert.equal((await resumed.completion).status, "completed");
  assert.deepEqual(f.requests, ["role-a/pin"]);
});
