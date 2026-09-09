import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const root = mkdtempSync(join(tmpdir(), "pi-web-exact-tools-"));
const agentDir = join(root, "agent");
const cwd = join(root, "project");
mkdirSync(join(agentDir, "extensions"), { recursive: true });
mkdirSync(join(agentDir, "skills", "fixture-selected"), { recursive: true });
mkdirSync(join(agentDir, "skills", "fixture-sibling"), { recursive: true });
mkdirSync(cwd, { recursive: true });
writeFileSync(join(agentDir, "skills", "fixture-selected", "SKILL.md"), `---
name: fixture-selected
description: Selected integration fixture skill.
---
# Selected
`);
writeFileSync(join(agentDir, "skills", "fixture-sibling", "SKILL.md"), `---
name: fixture-sibling
description: Sibling integration fixture skill.
---
# Sibling
`);
writeFileSync(join(agentDir, "extensions", "fixture-tools.ts"), `
export default function fixtureTools(pi) {
  let toolsRegistered = false;
  pi.on("session_start", () => {
    if (toolsRegistered) return;
    for (const name of ["fixture_selected", "fixture_sibling"]) {
      pi.registerTool({
        name,
        label: name,
        description: "integration fixture " + name,
        parameters: { type: "object", properties: {}, additionalProperties: false },
        async execute() {
          return { content: [{ type: "text", text: name }], details: {} };
        },
      });
    }
    toolsRegistered = true;
  });
}
`);

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
const jiti = createJiti(import.meta.url, { tsconfigPaths: true, moduleCache: true });
const { POST: createSession } = await jiti.import("../app/api/agent/new/route.ts");
const { getRpcSession, startRpcSession } = await jiti.import("./rpc-manager.ts");

const wrappers = new Set();
after(async () => {
  for (const wrapper of wrappers) {
    if (wrapper.isAlive()) await wrapper.shutdown();
  }
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(root, { recursive: true, force: true });
});

function activeToolNames(tools) {
  return tools.filter((tool) => tool.active).map((tool) => tool.name);
}

function persistedSessionText() {
  const sessionRoot = join(agentDir, "sessions");
  try {
    return readdirSync(sessionRoot, { recursive: true })
      .filter((name) => typeof name === "string" && name.endsWith(".jsonl"))
      .map((name) => readFileSync(join(sessionRoot, name), "utf8"))
      .join("\n");
  } catch {
    return "";
  }
}

test("unknown exact tools fail without persisting an unusable policy", async () => {
  const response = await createSession(new Request("http://localhost/api/agent/new", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      cwd,
      type: "ensure_session",
      toolPolicy: "exact",
      toolNames: ["read", "missing_fixture_tool"],
    }),
  }));
  const body = await response.json();
  assert.equal(response.status, 500);
  assert.match(body.error, /Unknown tools for exact tool policy: missing_fixture_tool/);
  assert.doesNotMatch(persistedSessionText(), /missing_fixture_tool/);
});

test("unknown exact skills fail without persisting an unusable policy", async () => {
  const response = await createSession(new Request("http://localhost/api/agent/new", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      cwd,
      type: "ensure_session",
      toolPolicy: "exact",
      toolNames: ["read"],
      skillPolicy: "exact",
      skillNames: ["missing-fixture-skill"],
    }),
  }));
  const body = await response.json();
  assert.equal(response.status, 500);
  assert.match(body.error, /Unknown skills for exact skill policy: missing-fixture-skill/);
  assert.doesNotMatch(persistedSessionText(), /missing-fixture-skill/);
});

test("an empty exact skill contract exposes no skills", async () => {
  const response = await createSession(new Request("http://localhost/api/agent/new", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      cwd,
      type: "ensure_session",
      toolPolicy: "exact",
      toolNames: ["read"],
      skillPolicy: "exact",
      skillNames: [],
    }),
  }));
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  const wrapper = getRpcSession(body.sessionId);
  assert.ok(wrapper?.isAlive());
  wrappers.add(wrapper);
  assert.deepEqual(await wrapper.send({ type: "get_skills" }), []);
  const state = await wrapper.send({ type: "get_state" });
  assert.doesNotMatch(state.systemPrompt, /<available_skills>/);
});

test("the new-session API persists and restores an exact skill set", async () => {
  const response = await createSession(new Request("http://localhost/api/agent/new", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      cwd,
      type: "ensure_session",
      toolPolicy: "exact",
      toolNames: ["read"],
      skillPolicy: "exact",
      skillNames: ["fixture-selected"],
    }),
  }));
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));

  const first = getRpcSession(body.sessionId);
  assert.ok(first?.isAlive());
  wrappers.add(first);
  assert.deepEqual(
    (await first.send({ type: "get_skills" })).map((skill) => skill.name),
    ["fixture-selected"],
  );
  const firstState = await first.send({ type: "get_state" });
  assert.match(firstState.systemPrompt, /<name>fixture-selected<\/name>/);
  assert.doesNotMatch(firstState.systemPrompt, /<name>fixture-sibling<\/name>/);

  await first.send({ type: "reload" });
  assert.deepEqual(
    (await first.send({ type: "get_skills" })).map((skill) => skill.name),
    ["fixture-selected"],
  );

  first.inner.sessionManager.appendMessage({ role: "user", content: "skill fixture prompt", timestamp: Date.now() });
  first.inner.sessionManager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "skill fixture response" }],
    api: "test",
    provider: "test",
    model: "test",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });

  const sessionFile = first.sessionFile;
  assert.ok(sessionFile);
  const persisted = readFileSync(sessionFile, "utf8");
  assert.match(persisted, /"customType":"pi-web:skill-selection"/);
  assert.match(persisted, /"skills":\["fixture-selected"\]/);

  await first.shutdown();
  const reopened = await startRpcSession(body.sessionId, sessionFile, undefined);
  wrappers.add(reopened.session);
  assert.deepEqual(
    (await reopened.session.send({ type: "get_skills" })).map((skill) => skill.name),
    ["fixture-selected"],
  );
  const reopenedState = await reopened.session.send({ type: "get_state" });
  assert.match(reopenedState.systemPrompt, /<name>fixture-selected<\/name>/);
  assert.doesNotMatch(reopenedState.systemPrompt, /<name>fixture-sibling<\/name>/);
});

test("the new-session API persists and restores an exact active tool set", async () => {
  const response = await createSession(new Request("http://localhost/api/agent/new", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      cwd,
      type: "ensure_session",
      toolPolicy: "exact",
      toolNames: ["read", "bash"],
    }),
  }));
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));

  const first = getRpcSession(body.sessionId);
  assert.ok(first?.isAlive());
  wrappers.add(first);
  const firstTools = await first.send({ type: "get_tools" });
  assert.deepEqual(activeToolNames(firstTools), ["read", "bash"]);
  const inclusiveSkillNames = (await first.send({ type: "get_skills" })).map((skill) => skill.name);
  assert.ok(inclusiveSkillNames.includes("fixture-selected"));
  assert.ok(inclusiveSkillNames.includes("fixture-sibling"));
  assert.ok(firstTools.some((tool) => tool.name === "fixture_sibling" && tool.active === false));

  await first.send({ type: "reload" });
  const reloadedTools = await first.send({ type: "get_tools" });
  assert.deepEqual(activeToolNames(reloadedTools), ["read", "bash"]);
  assert.ok(reloadedTools.some((tool) => tool.name === "fixture_sibling" && tool.active === false));

  // Pi intentionally delays creating a new JSONL file until an assistant result
  // exists. Append a completed synthetic turn through the real SessionManager so
  // this no-network integration test exercises the normal disk-flush boundary.
  first.inner.sessionManager.appendMessage({ role: "user", content: "fixture prompt", timestamp: Date.now() });
  first.inner.sessionManager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "fixture response" }],
    api: "test",
    provider: "test",
    model: "test",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });

  const sessionFile = first.sessionFile;
  assert.ok(sessionFile);
  const persisted = readFileSync(sessionFile, "utf8");
  assert.match(persisted, /"version":2/);
  assert.match(persisted, /"mode":"exact"/);
  assert.match(persisted, /"tools":\["read","bash"\]/);

  await first.shutdown();
  const reopened = await startRpcSession(body.sessionId, sessionFile, undefined);
  wrappers.add(reopened.session);
  const restoredTools = await reopened.session.send({ type: "get_tools" });
  assert.deepEqual(activeToolNames(restoredTools), ["read", "bash"]);
  assert.ok(restoredTools.some((tool) => tool.name === "fixture_sibling" && tool.active === false));
});
