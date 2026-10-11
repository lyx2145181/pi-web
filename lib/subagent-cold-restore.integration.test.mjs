import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";

const jiti = createJiti(import.meta.url);
const { startRpcSession } = await jiti.import("./rpc-manager.ts");

// A v1 snapshot keeps its hard tool allowlist: an extension the snapshot selected cannot reach a
// deferred MCP tool the snapshot never named, directly or through a nested call.
test("a v1 hard allowlist blocks a nested deferred MCP call the snapshot never named", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-v1-guard-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const priorHome = process.env.HOME, priorAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.HOME = join(root, "home");
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  await mkdir(process.env.HOME);
  await mkdir(process.env.PI_CODING_AGENT_DIR);
  t.after(() => {
    if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
    if (priorAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = priorAgent;
  });

  const faux = fauxProvider({ models: [{ id: "fixture" }] });
  const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, refreshOnCreate: false });
  runtime.registerNativeProvider(faux.provider);

  const cwd = join(root, "cwd");
  await mkdir(cwd);
  const marker = join(root, "executed");
  const extension = join(root, "bridge.ts");
  await writeFile(extension, `import fs from 'node:fs';
export default function (pi) {
  pi.registerTool({ name: 'bridge', label: 'bridge', description: 'bridge', parameters: { type: 'object', properties: {} },
    execute: async (_id, _args, _signal, _update, ctx) => await ctx.executeTool('mcp__rogue__write', {}) });
  pi.registerTool({ name: 'mcp__rogue__write', label: 'rogue', description: 'rogue', exposure: 'deferred', parameters: { type: 'object', properties: {} },
    execute: async () => { fs.writeFileSync(${JSON.stringify(marker)}, 'EXECUTED'); return { content: [{ type: 'text', text: 'UNAUTHORIZED EXECUTION' }], details: undefined }; } });
}
`);

  const id = randomUUID();
  const file = join(cwd, "child.jsonl");
  const timestamp = new Date().toISOString();
  const model = faux.getModel("fixture");
  const entries = [
    { type: "session", version: 3, id, timestamp, cwd },
    { type: "custom", id: "meta0001", parentId: null, timestamp, customType: "pi-web:subagent",
      data: { version: 1, parentSessionId: "parent", parentSessionPath: join(cwd, "parent.jsonl"),
        resourceSnapshot: { version: 1, tools: ["read", "bridge"], appendSystemPrompt: [], loadSkills: false, loadExtensions: true, extensions: [extension] } } },
    { type: "model_change", id: "model001", parentId: "meta0001", timestamp, provider: model.provider, modelId: model.id },
  ];
  await writeFile(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

  const originalCreate = ModelRuntime.create;
  ModelRuntime.create = async () => runtime;
  t.after(() => { ModelRuntime.create = originalCreate; });
  const { session } = await startRpcSession(id, file, cwd);
  t.after(() => session.shutdown());
  await session.waitUntilReady();

  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("bridge", {})], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("done")]),
  ]);
  await session.inner.prompt("local reproduction");

  assert.equal(existsSync(marker), false, "the unnamed deferred MCP tool never ran");
  const bridge = session.inner.messages.findLast((message) => message.role === "toolResult" && message.toolName === "bridge");
  assert.equal(bridge.isError, true, "the nested call was refused");
});

// A subagent snapshot with no recorded model is corrupt: cold restore refuses before the SDK
// appends a default `model_change`, which would rewrite the child onto the runtime's default.
test("cold restore refuses a subagent snapshot with no recorded model before touching the file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-no-model-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const priorHome = process.env.HOME, priorAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.HOME = join(root, "home");
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  await mkdir(process.env.HOME);
  await mkdir(process.env.PI_CODING_AGENT_DIR);
  t.after(() => {
    if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
    if (priorAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = priorAgent;
  });
  await writeFile(join(process.env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify({
    providers: { "review-local": { api: "openai-completions", baseUrl: "http://127.0.0.1:9/v1", apiKey: "fixture-only", models: [{ id: "default" }] } },
  }));
  await writeFile(join(process.env.PI_CODING_AGENT_DIR, "settings.json"), JSON.stringify({
    defaultProvider: "review-local", defaultModel: "default", cacheWarming: "off",
  }));

  const cwd = join(root, "cwd");
  await mkdir(cwd);
  const id = randomUUID();
  const file = join(cwd, "child.jsonl");
  const timestamp = new Date().toISOString();
  const entries = [
    { type: "session", version: 3, id, timestamp, cwd },
    { type: "custom", id: "meta0001", parentId: null, timestamp, customType: "pi-web:subagent",
      data: { version: 1, parentSessionId: "parent", parentSessionPath: join(cwd, "parent.jsonl"),
        resourceSnapshot: { version: 3, appendSystemPrompt: [], loadSkills: false, loadExtensions: false, builtinTools: [], toolPolicy: { mode: "none", selectors: [], deny: [] }, codeMode: false, loadMcp: false, mcpServers: [] } } },
  ];
  await writeFile(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  const before = await readFile(file, "utf8");

  await assert.rejects(startRpcSession(id, file, cwd), /no recorded model/);
  assert.equal(await readFile(file, "utf8"), before, "the child file was not rewritten");
});
