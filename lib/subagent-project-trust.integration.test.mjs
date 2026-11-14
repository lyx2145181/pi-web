import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  ModelRuntime,
  ProjectTrustStore,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const { createSubagentController } = await createJiti(import.meta.url).import("./subagent-runtime.ts");
const { startRpcSession } = await createJiti(import.meta.url).import("./rpc-manager.ts");
const exec = promisify(execFile);

// This fork retains actual child-resource trust: parent approval never grants a sibling
// worktree access to executable project settings. An explicit child decision reaches reload.
async function runChild(t, { trusted, isolation, loadExtensions, approveChild = false }) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "pi-web-subagent-trust-")));
  const worktrees = `${dir}-worktrees`;
  t.after(() => rm(dir, { recursive: true, force: true }));
  t.after(() => rm(worktrees, { recursive: true, force: true }));
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => { if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgentDir; });

  // Cold restoration must find the recorded model without the in-memory faux registry.
  // No request is made to this loopback-only definition when reopening the idle session.
  await writeFile(join(dir, "models.json"), JSON.stringify({ providers: { faux: {
    api: "openai-completions", baseUrl: "http://127.0.0.1:9/v1", apiKey: "fixture-only",
    models: [{ id: "faux-model", contextWindow: 128000, maxTokens: 4096 }],
  } } }));
  await mkdir(join(dir, "agents"));
  await writeFile(join(dir, "agents", "fixture.md"), [
    "---", "description: Trust fixture.", "tools: read", "load_skills: false", `load_extensions: ${loadExtensions}`, "max_turns: 1",
    "---", "Complete the assigned task.",
  ].join("\n"));
  await mkdir(join(dir, ".pi"));
  await writeFile(join(dir, ".pi", "settings.json"), JSON.stringify({ shellCommandPrefix: "echo project-prefix;" }));
  for (const args of [["init", "-q"], ["config", "user.email", "test@example.com"], ["config", "user.name", "Pi Web Test"],
    ["add", ".pi/settings.json"], ["commit", "-qm", "initial"]]) await exec("git", ["-C", dir, ...args]);
  if (trusted) new ProjectTrustStore(dir).set(dir, true);

  const faux = fauxProvider({ models: [{ id: "faux-model" }] });
  const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const services = await createAgentSessionServices({
    cwd: dir, agentDir: dir, modelRuntime, settingsManager: SettingsManager.inMemory(),
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true },
  });
  const { session: parent } = await createAgentSessionFromServices({
    services, sessionManager: SessionManager.create(dir, join(dir, "sessions")), model: faux.getModel("faux-model"),
  });
  const sessions = new Map();
  let child;
  const registerSession = async (inner) => {
    if (inner !== parent) {
      child = inner;
      if (approveChild) {
        assert.equal(inner.settingsManager.isProjectTrusted(), false, "parent approval does not pre-authorize the child");
        assert.equal(inner.settingsManager.getShellCommandPrefix(), undefined);
        new ProjectTrustStore(dir).set(inner.sessionManager.getCwd(), true);
        await inner.resourceLoader.reload();
      }
    }
    const wrapper = { inner, cwd: dir, sessionFile: inner.sessionFile ?? "", isAlive: () => true, isRunning: () => inner.isStreaming, waitUntilReady: async () => {} };
    sessions.set(inner.sessionId, wrapper);
    return wrapper;
  };
  await registerSession(parent);
  t.after(() => { for (const { inner } of sessions.values()) inner.dispose(); });
  const controller = createSubagentController({
    getSession: (id) => sessions.get(id), registerSession,
    resolveSessionPath: async (id) => sessions.get(id)?.sessionFile ?? null,
    reopenSession: async () => { throw new Error("unused"); },
    invalidateSessionList() {}, isBuiltInSubagentsEnabled: () => true,
  });
  faux.setResponses([fauxAssistantMessage([fauxText("done")])]);
  const execution = await controller.extensionRuntime.start({
    parentContext: { sessionManager: parent.sessionManager }, parentToolCallId: "call", profile: "fixture",
    task: "Report.", description: "Trust fixture", runInBackground: false, ...(isolation ? { isolation } : {}),
  });
  const result = await execution.completion;
  assert.equal(result.status, "completed", result.error);
  return child;
}

for (const loadExtensions of [false, true]) {
  test(`a child in a folder never trusted reads no project settings (load_extensions: ${loadExtensions})`, async (t) => {
    const child = await runChild(t, { trusted: false, loadExtensions });
    assert.equal(child.settingsManager.isProjectTrusted(), false);
    assert.equal(child.settingsManager.getShellCommandPrefix(), undefined);

    // Reopened from its file (a server restart), it decides the same way.
    const reopened = (await startRpcSession(child.sessionId, child.sessionFile)).session;
    t.after(() => reopened.shutdown());
    await reopened.waitUntilReady();
    assert.equal(reopened.inner.settingsManager.isProjectTrusted(), false);
    assert.equal(reopened.inner.settingsManager.getShellCommandPrefix(), undefined);
  });
}

for (const loadExtensions of [false, true]) {
  for (const approveChild of [false, true]) {
    test(`an isolated child uses its own trust after reload (load_extensions: ${loadExtensions}, child approved: ${approveChild})`, async (t) => {
      const { settingsManager } = await runChild(t, { trusted: true, isolation: "worktree", loadExtensions, approveChild });
      assert.equal(settingsManager.isProjectTrusted(), approveChild);
      assert.equal(settingsManager.getShellCommandPrefix(), approveChild ? "echo project-prefix;" : undefined);
    });
  }
}
