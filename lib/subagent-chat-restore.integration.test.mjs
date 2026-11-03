import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// This file has its own test process. Keep the same real idle/disposal path, with a short
// local deadline; fake clocks across SDK wrapper lifetimes would hide resource leaks.
process.env.PI_WEB_IDLE_TIMEOUT_MS = "150";
const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
const { fauxProvider } = await import("@earendil-works/pi-ai");
const { startRpcSession, getRpcSession } = await createJiti(import.meta.url).import("./rpc-manager.ts");

test("opening a finished frozen child initializes only approved resources, sends no model request and idles out", { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-child-chat-idle-"));
  const prior = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
  const createRuntime = ModelRuntime.create;
  let wrapper;
  try {
    const cwd = join(root, "cwd"), agentDir = join(root, "agent");
    await mkdir(cwd); await mkdir(agentDir);
    process.env.HOME = join(root, "home"); process.env.PI_CODING_AGENT_DIR = agentDir;
    await mkdir(process.env.HOME);
    const approved = join(agentDir, "approved.ts"), excluded = join(agentDir, "excluded.ts");
    globalThis.__chatRestoreCounts = { factory: 0, bind: 0, shutdown: 0, excluded: 0 };
    await writeFile(approved, `export default function(pi) {
      globalThis.__chatRestoreCounts.factory++;
      pi.on('session_start', () => { globalThis.__chatRestoreCounts.bind++; });
      pi.on('session_shutdown', () => { globalThis.__chatRestoreCounts.shutdown++; });
    }`);
    await writeFile(excluded, "globalThis.__chatRestoreCounts.excluded++; export default function() {}\n");
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ extensions: [approved, excluded], cacheWarming: "off", defaultThinkingLevel: "minimal" }));
    const faux = fauxProvider({ models: [{ id: "recorded", reasoning: true }] });
    const runtime = await createRuntime({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
    runtime.registerNativeProvider(faux.provider);
    ModelRuntime.create = async () => runtime;
    const id = randomUUID(), file = join(cwd, "child.jsonl"), timestamp = new Date().toISOString();
    const resources = { version: 3, builtinTools: ["read"], toolPolicy: { mode: "none", selectors: [], deny: [] }, appendSystemPrompt: [], loadSkills: false, loadExtensions: true, skills: false, extensions: [approved], codeMode: false, loadMcp: false, mcpServers: [] };
    const entries = [
      { type: "session", version: 3, id, timestamp, cwd },
      { type: "custom", id: "metadata", parentId: null, timestamp, customType: "pi-web:subagent", data: { version: 1, parentSessionId: "parent", parentSessionPath: join(cwd, "parent.jsonl"), profile: "changed-today", resourceSnapshot: resources } },
      { type: "model_change", id: "model001", parentId: "metadata", timestamp, provider: "faux", modelId: "recorded" },
      { type: "thinking_level_change", id: "think001", parentId: "model001", timestamp, thinkingLevel: "high" },
      { type: "custom", id: "result01", parentId: "think001", timestamp, customType: "pi-web:subagent-result", data: { version: 1, status: "completed", completedAt: timestamp, result: "finished" } },
    ];
    await writeFile(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    const before = await readFile(file, "utf8");
    wrapper = (await startRpcSession(id, file, cwd)).session;
    await wrapper.waitUntilReady();
    assert.equal(wrapper.inner.model.id, "recorded");
    assert.equal(wrapper.inner.thinkingLevel, "high", "setup-only recovery keeps the record, not today's minimal default");
    assert.deepEqual(wrapper.inner.getActiveToolNames(), ["read"]);
    assert.equal(faux.state.callCount, 0, "opening never prompts the provider");
    assert.deepEqual(globalThis.__chatRestoreCounts, { factory: 1, bind: 1, shutdown: 0, excluded: 0 });
    assert.equal(await wrapper.waitUntilDisposed(2000), true, "no lease: the actual SDK wrapper is released");
    assert.equal(getRpcSession(id), undefined);
    assert.equal(globalThis.__chatRestoreCounts.shutdown, 1);
    const after = await readFile(file, "utf8");
    assert.ok(after.startsWith(before), "opening preserves every saved entry");
    const initialized = after.slice(before.length).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.ok(initialized.every((entry) => (entry.type === "thinking_level_change" && entry.thinkingLevel === "high")
      || (entry.type === "model_change" && entry.provider === "faux" && entry.modelId === "recorded")),
    "successful SDK setup may record only its recorded model/thinking, never conversation or wider authority");
    assert.equal(faux.state.callCount, 0);
  } finally {
    await wrapper?.shutdown();
    ModelRuntime.create = createRuntime;
    delete globalThis.__chatRestoreCounts;
    for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true });
  }
});
