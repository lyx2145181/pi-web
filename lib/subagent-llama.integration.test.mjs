import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAgentSession, createAgentSessionFromServices, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";

const { createSubagentSessionServices } = await createJiti(import.meta.url).import("./subagent-resources.ts");

for (const extensions of [true, false, []]) {
  test(`child llama provider follows frozen extension selection ${JSON.stringify(extensions)} without adding tools`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "pi-child-llama-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
    t.after(() => runtime.dispose?.());
    const services = await createSubagentSessionServices({
      cwd: dir, agentDir: dir, modelRuntime: runtime,
      settingsManager: SettingsManager.create(dir, dir, { projectTrusted: false }),
      resourceLoaderOptions: { noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true },
    }, { version: 3, skills: false, extensions, builtinTools: ["read"], codeMode: false, loadMcp: false });
    assert.equal(Boolean(runtime.getProvider("llama.cpp")), extensions === true);
    assert.equal(services.mcpHost, undefined);
    for (const extension of services.resourceLoader.getExtensions().extensions) {
      assert.equal(extension.tools.size, 0, "the provider grants no tool or subagent-control surface");
    }
  });
}

test("a child never replaces its parent's existing llama provider or subsequent request implementation", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-child-llama-parent-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const faux = fauxProvider({ provider: "llama.cpp", models: [{ id: "parent-model" }] });
  faux.setResponses([fauxAssistantMessage([fauxText("parent before child")]), fauxAssistantMessage([fauxText("parent after child")])]);
  const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  runtime.registerNativeProvider(faux.provider);
  const original = runtime.getProvider("llama.cpp");
  const { session: parent } = await createAgentSession({
    cwd: dir, agentDir: dir, modelRuntime: runtime, model: faux.getModel("parent-model"), tools: [],
    settingsManager: SettingsManager.inMemory(), sessionManager: SessionManager.inMemory(dir),
  });
  t.after(() => parent.dispose());
  await parent.prompt("Before child");
  assert.equal(parent.getLastAssistantText(), "parent before child");
  await createSubagentSessionServices({
    cwd: dir, agentDir: dir, modelRuntime: runtime,
    settingsManager: SettingsManager.create(dir, dir, { projectTrusted: false }),
    resourceLoaderOptions: { noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true },
  }, { version: 3, skills: false, extensions: true, builtinTools: ["read"] });
  assert.equal(runtime.getProvider("llama.cpp"), original);
  await parent.prompt("After child");
  assert.equal(parent.getLastAssistantText(), "parent after child");
  assert.equal(faux.state.callCount, 2);
});

test("a child resolves llama's real scoped disable before resource clearing, and reload observes explicit enable", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-child-llama-switch-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cwd = join(dir, "project");
  await mkdir(cwd);
  const settingsPath = join(dir, "settings.json");
  await writeFile(settingsPath, JSON.stringify({ extensions: ["-builtin:llama.cpp"] }));
  const runtimes = [];
  t.after(() => runtimes.forEach((runtime) => runtime.dispose?.()));
  async function create() {
    const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
    runtimes.push(runtime);
    const services = await createSubagentSessionServices({
      cwd, agentDir: dir, modelRuntime: runtime,
      settingsManager: SettingsManager.create(cwd, dir, { projectTrusted: false }),
      resourceLoaderOptions: { noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true },
    }, { version: 3, skills: false, extensions: true, builtinTools: ["read"] });
    return { runtime, services };
  }
  const first = await create();
  assert.equal(first.runtime.getProvider("llama.cpp"), undefined);
  const { session } = await createAgentSessionFromServices({ services: first.services, sessionManager: SessionManager.inMemory(cwd), tools: ["read"] });
  t.after(() => session.dispose());
  await writeFile(settingsPath, JSON.stringify({ extensions: ["+builtin:llama.cpp"] }));
  await session.reload();
  assert.ok(first.runtime.getProvider("llama.cpp"), "reload reads the refreshed source, not the cleared memory settings");
  const reopened = await create();
  assert.ok(reopened.runtime.getProvider("llama.cpp"), "a fresh resource builder agrees with the reloaded child");
});
