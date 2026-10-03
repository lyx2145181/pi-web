import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

// Mock-SDK unit coverage: no provider, no model credentials and no network.
// The wrapper only reads the session-manager entries and the agent state, so a
// hand-written inner object isolates role model-preference behavior.
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");

const ROLE_TASK_PATH = "/project/_交付记录/start-leaf/leaf/任务.json";

function makeInner() {
  const entries = [];
  const state = { thinkingLevel: "off" };
  const branch = { current: entries };
  const inner = {
    sessionId: "role-session",
    sessionFile: "",
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    autoCompactionEnabled: false,
    autoRetryEnabled: false,
    pendingMessageCount: 0,
    get model() { return state.model; },
    set model(value) { state.model = value; },
    modelRuntime: {
      getModel: (provider, modelId) => ({ provider, id: modelId }),
      refresh: async () => {},
    },
    sessionManager: {
      getEntries: () => entries,
      getBranch: () => branch.current,
      appendCustomEntry: (customType, data) => {
        const id = `entry-${entries.length}`;
        entries.push({ type: "custom", customType, data, id, parentId: null, timestamp: "t" });
        return id;
      },
      getCwd: () => "/project",
      getSessionFile: () => "",
      getSessionId: () => "role-session",
    },
    settingsManager: {},
    agent: { state },
    extensionRunner: { setUIContext: () => {} },
    resourceLoader: {},
    getActiveToolNames: () => [],
    setActiveToolsByName: () => {},
    getSteeringMessages: () => [],
    getFollowUpMessages: () => [],
    getContextUsage: () => undefined,
    prompt: async (_message, options) => { options?.preflightResult?.(true); },
    setModel: async (model) => { inner.model = model; },
    // Simulate the SDK clamp so the recorded preference proves it stores the
    // effective level, not the requested one.
    setThinkingLevel: (level) => { state.thinkingLevel = level === "xhigh" ? "high" : level; },
  };
  return { inner, entries, state, branch };
}

const preferenceEntries = (entries) =>
  entries.filter((entry) => entry.customType === "pi-web:role-model-preference");

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("role session records the user's actual provider/model/clamped thinking preference", async () => {
  const { inner, entries } = makeInner();
  const wrapper = new AgentSessionWrapper(inner, { roleTaskPath: ROLE_TASK_PATH, idleTimeoutMs: 0 });
  await wrapper.send({ type: "set_model", provider: "alpha", modelId: "m1" });
  await wrapper.send({ type: "set_thinking_level", level: "xhigh" });
  const state = await wrapper.send({ type: "get_state" });
  assert.deepEqual(state.roleModelPreference, {
    version: 1, provider: "alpha", modelId: "m1", thinkingLevel: "high",
  });
  assert.equal(preferenceEntries(entries).length, 2);
});

test("defaults apply as intent only and never record or overwrite a user preference", async () => {
  const { inner, entries } = makeInner();
  const wrapper = new AgentSessionWrapper(inner, { roleTaskPath: ROLE_TASK_PATH, idleTimeoutMs: 0 });

  // No preference yet: defaults align the session, without inventing a user choice.
  await wrapper.send({ type: "set_model", provider: "alpha", modelId: "m1", roleModelSource: "defaults" });
  assert.equal((await wrapper.send({ type: "get_state" })).roleModelPreference, null);
  assert.equal(preferenceEntries(entries).length, 0);

  // A normal UI change is the user's override.
  await wrapper.send({ type: "set_model", provider: "beta", modelId: "m2" });
  assert.deepEqual((await wrapper.send({ type: "get_state" })).roleModelPreference, {
    version: 1, provider: "beta", modelId: "m2", thinkingLevel: "off",
  });

  // Same value is an idempotent no-op; a different default is refused.
  await wrapper.send({ type: "set_model", provider: "beta", modelId: "m2", roleModelSource: "defaults" });
  await assert.rejects(
    wrapper.send({ type: "set_model", provider: "alpha", modelId: "m1", roleModelSource: "defaults" }),
    (error) => error.code === "role_model_preference_locked",
  );
  assert.deepEqual((await wrapper.send({ type: "get_state" })).roleModelPreference, {
    version: 1, provider: "beta", modelId: "m2", thinkingLevel: "off",
  });

  await wrapper.send({ type: "set_thinking_level", level: "low" });
  await wrapper.send({ type: "set_thinking_level", level: "low", roleModelSource: "defaults" });
  await assert.rejects(
    wrapper.send({ type: "set_thinking_level", level: "high", roleModelSource: "defaults" }),
    (error) => error.code === "role_model_preference_locked",
  );
  assert.deepEqual((await wrapper.send({ type: "get_state" })).roleModelPreference, {
    version: 1, provider: "beta", modelId: "m2", thinkingLevel: "low",
  });
});

test("non-role sessions keep the previous get_state shape and write no entry", async () => {
  const { inner, entries } = makeInner();
  const wrapper = new AgentSessionWrapper(inner, { idleTimeoutMs: 0 });
  await wrapper.send({ type: "set_model", provider: "alpha", modelId: "m1" });
  const state = await wrapper.send({ type: "get_state" });
  assert.equal("roleModelPreference" in state, false);
  assert.equal("isModelChanging" in state, false);
  assert.equal(entries.length, 0);
});

test("malformed persisted role model preference fails closed", async () => {
  const { inner, entries } = makeInner();
  entries.push({
    type: "custom", customType: "pi-web:role-model-preference",
    data: { version: 2, provider: "alpha" }, id: "bad", parentId: null, timestamp: "t",
  });
  const wrapper = new AgentSessionWrapper(inner, { roleTaskPath: ROLE_TASK_PATH, idleTimeoutMs: 0 });
  await assert.rejects(wrapper.send({ type: "get_state" }), /Invalid persisted role model preference/);
});

test("preference reads only the current tree branch", async () => {
  const { inner, entries, branch } = makeInner();
  const wrapper = new AgentSessionWrapper(inner, { roleTaskPath: ROLE_TASK_PATH, idleTimeoutMs: 0 });
  await wrapper.send({ type: "set_model", provider: "alpha", modelId: "m1" });
  assert.notEqual((await wrapper.send({ type: "get_state" })).roleModelPreference, null);
  // The same file entry on a different branch is not the visible choice.
  branch.current = [];
  assert.equal((await wrapper.send({ type: "get_state" })).roleModelPreference, null);
  assert.equal(entries.length, 1);
});

test("defaults require an idle session while a user change is not gated", async () => {
  const { inner } = makeInner();
  const wrapper = new AgentSessionWrapper(inner, { roleTaskPath: ROLE_TASK_PATH, idleTimeoutMs: 0 });
  for (const busy of ["isBashRunning", "isStreaming"]) {
    inner.isBashRunning = false;
    inner.isStreaming = false;
    inner[busy] = true;
    await assert.rejects(
      wrapper.send({ type: "set_model", provider: "alpha", modelId: "m1", roleModelSource: "defaults" }),
      (error) => error.code === "role_model_defaults_busy",
    );
    await assert.rejects(
      wrapper.send({ type: "set_thinking_level", level: "max", roleModelSource: "defaults" }),
      (error) => error.code === "role_model_defaults_busy",
    );
  }
  inner.isBashRunning = false;
  inner.isStreaming = true;
  // A user change is allowed even while the session is busy, and `max` is a
  // legal ThinkingLevel the SDK accepts.
  await wrapper.send({ type: "set_model", provider: "alpha", modelId: "m1" });
  await wrapper.send({ type: "set_thinking_level", level: "max" });
  assert.deepEqual((await wrapper.send({ type: "get_state" })).roleModelPreference, {
    version: 1, provider: "alpha", modelId: "m1", thinkingLevel: "max",
  });
  inner.isStreaming = false;
});

test("defaults queued before a user change lets the user win", async () => {
  const { inner } = makeInner();
  const wrapper = new AgentSessionWrapper(inner, { roleTaskPath: ROLE_TASK_PATH, idleTimeoutMs: 0 });
  const gate = deferred();
  const order = [];
  inner.setModel = async (model) => {
    order.push(model.id);
    if (model.id === "default-model") await gate.promise;
    inner.agent.state.model = model;
  };
  const defaults = wrapper.send({
    type: "set_model", provider: "default-provider", modelId: "default-model", roleModelSource: "defaults",
  });
  const user = wrapper.send({ type: "set_model", provider: "user-provider", modelId: "user-model" });
  await tick();
  // The user change must wait for the in-flight defaults rather than overwriting.
  assert.deepEqual(order, ["default-model"]);
  gate.resolve();
  await Promise.all([defaults, user]);
  assert.deepEqual(order, ["default-model", "user-model"]);
  assert.equal(inner.model.id, "user-model");
  assert.deepEqual((await wrapper.send({ type: "get_state" })).roleModelPreference, {
    version: 1, provider: "user-provider", modelId: "user-model", thinkingLevel: "off",
  });
});

test("a user change queued first makes a later default reject", async () => {
  const { inner } = makeInner();
  const wrapper = new AgentSessionWrapper(inner, { roleTaskPath: ROLE_TASK_PATH, idleTimeoutMs: 0 });
  const gate = deferred();
  inner.setModel = async (model) => {
    if (model.id === "user-model") await gate.promise;
    inner.agent.state.model = model;
  };
  const user = wrapper.send({ type: "set_model", provider: "user-provider", modelId: "user-model" });
  const defaults = wrapper.send({
    type: "set_model", provider: "default-provider", modelId: "default-model", roleModelSource: "defaults",
  });
  await tick();
  gate.resolve();
  await user;
  await assert.rejects(defaults, (error) => error.code === "role_model_preference_locked");
  assert.equal(inner.model.id, "user-model");
  assert.deepEqual((await wrapper.send({ type: "get_state" })).roleModelPreference, {
    version: 1, provider: "user-provider", modelId: "user-model", thinkingLevel: "off",
  });
});

test("a defaults change waits for prompt admission and then refuses a running role", async () => {
  const { inner } = makeInner();
  const wrapper = new AgentSessionWrapper(inner, { roleTaskPath: ROLE_TASK_PATH, idleTimeoutMs: 0 });
  let acceptPreflight;
  let resolveRun;
  // The prompt holds admission while its preflight is pending, then stays a
  // running role until the run promise settles.
  inner.prompt = (_message, options) => {
    acceptPreflight = () => options?.preflightResult?.(true);
    return new Promise((resolve) => { resolveRun = resolve; });
  };
  const prompt = wrapper.send({ type: "prompt", message: "work" });
  await tick();
  const defaults = wrapper.send({
    type: "set_model", provider: "default-provider", modelId: "default-model", roleModelSource: "defaults",
  });
  await tick();
  // The default cannot acquire admission while the prompt is admitting and
  // must not switch the model once the prompt is a running role.
  acceptPreflight();
  await prompt;
  assert.equal(wrapper.isRunning(), true);
  await assert.rejects(defaults, (error) => error.code === "role_model_defaults_busy");
  assert.equal(inner.model, undefined);
  assert.equal(wrapper.roleModelDefaultsPending, 0);
  resolveRun();
  await tick();
});

test("a failed defaults change still releases the flag and queue", async () => {
  const { inner } = makeInner();
  const wrapper = new AgentSessionWrapper(inner, { roleTaskPath: ROLE_TASK_PATH, idleTimeoutMs: 0 });
  inner.modelRuntime.getModel = () => undefined;
  await assert.rejects(
    wrapper.send({ type: "set_model", provider: "missing", modelId: "missing", roleModelSource: "defaults" }),
    /Model not found/,
  );
  assert.equal(wrapper.roleModelDefaultsPending, 0);
  // Not permanently busy: prompts and later user changes both proceed.
  await wrapper.send({ type: "prompt", message: "work" });
  inner.modelRuntime.getModel = (provider, modelId) => ({ provider, id: modelId });
  await wrapper.send({ type: "set_model", provider: "user-provider", modelId: "user-model" });
  assert.deepEqual((await wrapper.send({ type: "get_state" })).roleModelPreference, {
    version: 1, provider: "user-provider", modelId: "user-model", thinkingLevel: "off",
  });
});

test("a prompt waiting on admission re-checks defaults instead of sneaking through", async () => {
  const { inner } = makeInner();
  const wrapper = new AgentSessionWrapper(inner, { roleTaskPath: ROLE_TASK_PATH, idleTimeoutMs: 0 });
  let prompted = false;
  inner.prompt = async (_message, options) => { prompted = true; options?.preflightResult?.(true); };
  // Hold the shared admission lock so both waiters line up behind it.
  const release = await wrapper.acquirePromptAdmission();
  const prompt = wrapper.send({ type: "prompt", message: "work" });
  await tick();
  const defaults = wrapper.send({
    type: "set_model", provider: "default-provider", modelId: "default-model", roleModelSource: "defaults",
  });
  await tick();
  release();
  // The prompt started waiting before the default, but still sees the new
  // pending marker once it owns admission and must not start a run.
  await assert.rejects(prompt, (error) => error.code === "role_model_defaults_busy");
  assert.equal(prompted, false);
  await defaults;
  assert.equal(inner.model.id, "default-model");
});

test("a deliver cannot pass onAdmitted while defaults is pending", async () => {
  const { inner } = makeInner();
  const wrapper = new AgentSessionWrapper(inner, { roleTaskPath: ROLE_TASK_PATH, idleTimeoutMs: 0 });
  let admitted = false;
  const release = await wrapper.acquirePromptAdmission();
  const deliver = wrapper.send({
    type: "role_task_deliver", message: "work", onAdmitted: async () => { admitted = true; },
  });
  await tick();
  const defaults = wrapper.send({
    type: "set_model", provider: "default-provider", modelId: "default-model", roleModelSource: "defaults",
  });
  await tick();
  release();
  assert.deepEqual(await deliver, { status: "busy" });
  assert.equal(admitted, false);
  await defaults;
  assert.equal(inner.model.id, "default-model");
});


test("isModelChanging reflects an in-flight role setter and clears on success or failure", async () => {
  const { inner } = makeInner();
  const wrapper = new AgentSessionWrapper(inner, { roleTaskPath: ROLE_TASK_PATH, idleTimeoutMs: 0 });
  const gate = deferred();
  inner.setModel = async (model) => { await gate.promise; inner.agent.state.model = model; };
  const pending = wrapper.send({ type: "set_model", provider: "alpha", modelId: "m1" });
  await tick();
  assert.equal((await wrapper.send({ type: "get_state" })).isModelChanging, true);
  gate.resolve();
  await pending;
  assert.equal((await wrapper.send({ type: "get_state" })).isModelChanging, false);
  // A failed setter also clears the flag instead of reporting a stuck change.
  inner.setModel = async () => { throw new Error("synthetic auth failure"); };
  await assert.rejects(wrapper.send({ type: "set_model", provider: "alpha", modelId: "m2" }), /synthetic auth failure/);
  assert.equal((await wrapper.send({ type: "get_state" })).isModelChanging, false);
});

test("a defaults pending makes prompt and deliver immediately busy without running the SDK", async () => {
  const { inner } = makeInner();
  const wrapper = new AgentSessionWrapper(inner, { roleTaskPath: ROLE_TASK_PATH, idleTimeoutMs: 0 });
  const gate = deferred();
  let prompted = false;
  inner.prompt = async (_message, options) => { prompted = true; options?.preflightResult?.(true); };
  inner.setModel = async (model) => { await gate.promise; inner.agent.state.model = model; };
  const defaults = wrapper.send({
    type: "set_model", provider: "default-provider", modelId: "default-model", roleModelSource: "defaults",
  });
  await tick();
  // The gate is still pending: this must reject now, not wait for the switch and
  // then auto-start the run after the caller's timeout.
  await assert.rejects(
    wrapper.send({ type: "prompt", message: "work" }),
    (error) => error.code === "role_model_defaults_busy",
  );
  assert.deepEqual(
    await wrapper.send({ type: "role_task_deliver", message: "work", onAdmitted: async () => {} }),
    { status: "busy" },
  );
  assert.equal(prompted, false);
  gate.resolve();
  await defaults;
  // Once the switch has settled, a prompt is admitted normally.
  await wrapper.send({ type: "prompt", message: "work" });
  assert.equal(prompted, true);
});

test("defaults set_model is a true no-op for the recorded preference and never resets thinking", async () => {
  const { inner } = makeInner();
  const wrapper = new AgentSessionWrapper(inner, { roleTaskPath: ROLE_TASK_PATH, idleTimeoutMs: 0 });
  let setModelCalls = 0;
  // The SDK resets thinking from the model default even when the model is unchanged.
  inner.setModel = async (model) => {
    setModelCalls += 1;
    inner.agent.state.model = model;
    if (model.id === "alpha") inner.agent.state.thinkingLevel = "high";
  };
  // User chooses Alpha/low.
  await wrapper.send({ type: "set_model", provider: "alpha", modelId: "alpha" });
  await wrapper.send({ type: "set_thinking_level", level: "low" });
  assert.equal(setModelCalls, 1);
  assert.equal(inner.agent.state.thinkingLevel, "low");
  // Defaults align the same Alpha: preference and actual both match -> no SDK call.
  await wrapper.send({ type: "set_model", provider: "alpha", modelId: "alpha", roleModelSource: "defaults" });
  assert.equal(setModelCalls, 1);
  assert.equal(inner.agent.state.thinkingLevel, "low");
  assert.deepEqual((await wrapper.send({ type: "get_state" })).roleModelPreference, {
    version: 1, provider: "alpha", modelId: "alpha", thinkingLevel: "low",
  });
  // A differing default thinking level is refused, so the user's low is never overwritten.
  await assert.rejects(
    wrapper.send({ type: "set_thinking_level", level: "high", roleModelSource: "defaults" }),
    (error) => error.code === "role_model_preference_locked",
  );
  assert.equal(inner.agent.state.thinkingLevel, "low");
});

test("defaults may restore the recorded model when the actual model differs", async () => {
  const { inner } = makeInner();
  const wrapper = new AgentSessionWrapper(inner, { roleTaskPath: ROLE_TASK_PATH, idleTimeoutMs: 0 });
  await wrapper.send({ type: "set_model", provider: "alpha", modelId: "alpha" });
  // Drift the actual model without recording a new preference.
  inner.agent.state.model = { provider: "beta", id: "beta" };
  let setModelCalls = 0;
  inner.setModel = async (model) => { setModelCalls += 1; inner.agent.state.model = model; };
  await wrapper.send({ type: "set_model", provider: "alpha", modelId: "alpha", roleModelSource: "defaults" });
  // Not a wrong no-op: the preference model is restored.
  assert.equal(setModelCalls, 1);
  assert.equal(inner.agent.state.model.id, "alpha");
  assert.deepEqual((await wrapper.send({ type: "get_state" })).roleModelPreference, {
    version: 1, provider: "alpha", modelId: "alpha", thinkingLevel: "off",
  });
});
