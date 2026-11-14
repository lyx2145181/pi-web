import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";

const { AgentSessionWrapper } = await createJiti(import.meta.url).import("./rpc-manager.ts");

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-abort-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const faux = fauxProvider({ models: [{ id: "abort-faux" }] });
  const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  runtime.registerNativeProvider(faux.provider);
  const services = await createAgentSessionServices({
    cwd: dir,
    modelRuntime: runtime,
    settingsManager: SettingsManager.inMemory(),
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true },
  });
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.inMemory(dir),
    model: faux.getModel("abort-faux"),
  });
  const wrapper = new AgentSessionWrapper(session);
  wrapper.beginExtensionBinding();
  await wrapper.waitUntilReady();
  t.after(() => wrapper.destroy());
  return { wrapper, faux };
}

// A Stop with nothing running is a no-op for later work: no sticky flag, no leaked run slot.
test("an idle Stop does not poison a later delegated run", async (t) => {
  const { wrapper, faux } = await fixture(t);
  let calls = 0;
  faux.setResponses([() => { calls += 1; return fauxAssistantMessage([fauxText("answer")]); }]);
  await wrapper.send({ type: "abort" });
  await wrapper.promptDelegated("new task");
  assert.equal(calls, 1, "the new task still runs");
  assert.equal(wrapper.pendingPromptCount, 0, "no leaked pending count");
  assert.equal(wrapper.isRunning(), false);
  // A second run on the same wrapper is not rejected as "already running".
  let next;
  try { await wrapper.promptDelegated("resume"); } catch (error) { next = error; }
  assert.equal(next, undefined, "a resume after the idle Stop is not rejected");
  assert.equal(wrapper.pendingPromptCount, 0);
});

test("a cancelled readiness wait does not poison the next run", async (t) => {
  const { wrapper, faux } = await fixture(t);
  let release;
  wrapper.waitUntilReady = () => new Promise((resolve) => { release = resolve; });
  const signal = new AbortController();
  const run = wrapper.promptDelegated("cancelled task", signal.signal);
  await wrapper.send({ type: "abort" });
  signal.abort();
  release();
  await assert.rejects(run, /cancelled before prompting/);
  assert.equal(wrapper.pendingPromptCount, 0, "the withdrawn run left no pending count");
  wrapper.waitUntilReady = async () => {};
  let calls = 0;
  faux.setResponses([() => { calls += 1; return fauxAssistantMessage([fauxText("answer")]); }]);
  await wrapper.promptDelegated("new run");
  assert.equal(calls, 1, "the next run is not cancelled by the earlier Stop");
  assert.equal(wrapper.pendingPromptCount, 0);
});

// A Stop between MCP preparation and the SDK prompt withdraws the prompt: no request is sent.
test("a Stop after delegated admission sends no request", async (t) => {
  const { wrapper, faux } = await fixture(t);
  let calls = 0;
  faux.setResponses([() => { calls += 1; return fauxAssistantMessage([fauxText("answer")]); }]);
  wrapper.prepareMcpPrompt = async () => { await wrapper.send({ type: "abort" }); };
  await assert.rejects(wrapper.promptDelegated("stopped before SDK prompt"), /cancelled before prompting/);
  assert.equal(calls, 0, "the withdrawn prompt sent no request");
  assert.equal(wrapper.pendingPromptCount, 0);
  assert.equal(wrapper.isRunning(), false);
});
