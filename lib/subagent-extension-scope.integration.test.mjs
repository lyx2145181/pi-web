import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxProvider, fauxAssistantMessage, fauxText, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { createAgentSessionServices, createAgentSessionFromServices, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

// Each extension adds a tool, a prompt marker from a handler and a provider, so a test can
// see whether the child bound any part of it.
function extensionSource(name) {
  return `export default function (pi) {
  pi.registerTool({ name: "${name}_tool", label: "${name}", description: "${name}", parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [{ type: "text", text: "${name}" }] }) });
  pi.on("before_agent_start", (event) => ({ systemPrompt: event.systemPrompt + "\\n${name.toUpperCase()}_HANDLER" }));
  pi.registerProvider("${name}-provider", { baseUrl: "http://127.0.0.1:9", apiKey: "dummy", api: "openai-completions",
    models: [{ id: "${name}-model", name: "${name}", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 }] });
}
`;
}

for (const [label, pick, wantAlpha, wantBeta] of [
  ["an explicit path list", (alphaPath) => [alphaPath], true, false],
  ["both explicit paths", (alphaPath, betaPath) => [alphaPath, betaPath], true, true],
  ["an unknown name fails closed", () => ["missing-extension"], false, false],
]) {
  test(`fresh child, reload, live resume and RPC reopen honor ${label}`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "subagent-extension-scope-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    // Keep the extensions under a sibling agentDir: an extension inside the project cwd needs
    // a real project-trust decision before the local pre-import loader admits it.
    const cwd = join(dir, "cwd");
    const agentDir = join(dir, "agent");
    await mkdir(cwd);
    const previousDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    t.after(() => { if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousDir; });
    await mkdir(join(agentDir, "extensions"), { recursive: true });
    await writeFile(join(agentDir, "extensions", "alpha.ts"), extensionSource("alpha"));
    await writeFile(join(agentDir, "extensions", "beta.ts"), extensionSource("beta"));
    const alphaPath = join(agentDir, "extensions", "alpha.ts");
    const betaPath = join(agentDir, "extensions", "beta.ts");
    const extensions = pick(alphaPath, betaPath);
    await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
    const yamlList = extensions.map((entry) => `"${entry.replaceAll("\\", "/")}"`).join(", ");
    await writeFile(join(cwd, ".pi", "agents", "scoped.md"), `---\ndescription: Scoped\ntools: read\nextensions: [${yamlList}]\n---\nCHILD_PROFILE\n`);

    const faux = fauxProvider({ models: [{ id: "faux-model" }] });
    const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
    modelRuntime.registerNativeProvider(faux.provider);
    const services = await createAgentSessionServices({ cwd, agentDir, modelRuntime, settingsManager: SettingsManager.inMemory(),
      resourceLoaderOptions: { noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true } });
    const { session: parentSession } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.inMemory(cwd), model: faux.getModel("faux-model") });
    t.after(() => parentSession.dispose());

    const jiti = createJiti(import.meta.url);
    const { createSubagentController } = await jiti.import("./subagent-runtime.ts");
    const { readSubagentSessionResources } = await jiti.import("./subagents.ts");
    const { AgentSessionWrapper, startRpcSession } = await jiti.import("./rpc-manager.ts");
    const parentId = parentSession.sessionId;
    const wrappers = new Map();
    const parent = { inner: parentSession, cwd, sessionFile: join(cwd, "parent.jsonl"), isAlive: () => true, isRunning: () => false };
    let child;
    const controller = createSubagentController({
      getSession: (id) => id === parentId ? parent : wrappers.get(id),
      registerSession(inner, options) {
        child = new AgentSessionWrapper(inner, options);
        child.start(); child.beginExtensionBinding(); wrappers.set(inner.sessionId, child);
      },
      reopenSession: async () => { throw new Error("unused"); }, resolveSessionPath: async () => child.sessionFile,
      invalidateSessionList() {}, isBuiltInSubagentsEnabled: () => true,
    });
    let input;
    const respond = () => faux.setResponses([(context) => {
      input = getCurrentSystemPrompt(context.messages);
      return fauxAssistantMessage([fauxText("completed")]);
    }]);
    const assertScope = (session, runtime) => {
      assert.equal(input.includes("ALPHA_HANDLER"), wantAlpha, "alpha handler");
      assert.equal(input.includes("BETA_HANDLER"), wantBeta, "beta handler");
      const tools = session.getAllTools().map((tool) => tool.name);
      assert.equal(tools.includes("alpha_tool"), wantAlpha, "alpha tool");
      assert.equal(tools.includes("beta_tool"), wantBeta, "beta tool");
      if (wantAlpha) assert.ok(session.getActiveToolNames().includes("alpha_tool"));
      assert.equal(Boolean(runtime.getProvider("alpha-provider")), wantAlpha, "alpha provider");
      assert.equal(Boolean(runtime.getProvider("beta-provider")), wantBeta, "beta provider");
    };

    respond();
    const execution = await controller.extensionRuntime.start({ parentContext: parentSession, parentToolCallId: "start", profile: "scoped", task: "work", description: "work" });
    t.after(async () => { if (child?.isAlive()) await child.shutdown(); });
    assert.equal((await execution.completion).status, "completed");
    assertScope(child.inner, modelRuntime);
    assert.deepEqual(readSubagentSessionResources(child.inner.sessionManager.getEntries()).extensions, extensions);

    // The local loader reapplies the pre-import scope on reload.
    await child.send({ type: "reload" });
    respond();
    const resumed = await controller.extensionRuntime.resume({ parentContext: parentSession, parentToolCallId: "resume", sessionId: child.inner.sessionId, task: "again", description: "again" });
    assert.equal((await resumed.completion).status, "completed");
    assertScope(child.inner, modelRuntime);
    // Code mode is an independent, default-off capability; an extensions scope never activates it.
    assert.equal(child.inner.getActiveToolNames().includes("codemode"), false);

    // Reopening rebuilds the scope from the snapshot. Only provider construction is replaced.
    const id = child.inner.sessionId, file = child.sessionFile;
    await child.shutdown();
    const originalCreate = ModelRuntime.create;
    let reopenedRuntime;
    ModelRuntime.create = async (...args) => {
      reopenedRuntime = await originalCreate.apply(ModelRuntime, args);
      reopenedRuntime.registerNativeProvider(faux.provider);
      return reopenedRuntime;
    };
    t.after(() => { ModelRuntime.create = originalCreate; });
    child = (await startRpcSession(id, file)).session;
    await child.waitUntilReady();
    respond();
    await child.inner.prompt("reopened");
    assertScope(child.inner, reopenedRuntime);
    assert.equal(child.inner.getActiveToolNames().includes("codemode"), false);
  });
}
