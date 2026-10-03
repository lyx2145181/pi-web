import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { createJiti } from "jiti";

// Maintenance-only fixture: never consults HOME, launches a web server or invokes a model.
// Kept under the checkout's parent (not /tmp) and removed per case.
const base = process.env.PI_WEB_ROLE_TEST_BASE
  ? join(process.env.PI_WEB_ROLE_TEST_BASE, "role-host-monitor")
  : join(dirname(fileURLToPath(import.meta.url)), "..", "..", "role-host-monitor");
mkdirSync(base, { recursive: true });
const root = mkdtempSync(join(base, "role-monitor-"));
const previous = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
const project = join(root, "project");
mkdirSync(project);
execFileSync("git", ["init", "-q", project]);
const record = join(project, "_交付记录", "start-leaf", "case");
mkdirSync(record, { recursive: true });
const taskPath = join(record, "任务.json");
const state = { version: 1, mode: "dispatcher-message-work", project_root: project, dispatcher_session_id: "dispatcher", status: "running", monitor: { interval_seconds: 2 } };
const persist = () => writeFileSync(taskPath, JSON.stringify(state));
persist();
const log = join(root, "ticks.jsonl");
const script = join(process.env.PI_CODING_AGENT_DIR, "skills", "start-leaf", "scripts", "native_call.py");
mkdirSync(dirname(script), { recursive: true });
writeFileSync(script, `import json, time\nfrom pathlib import Path\nrequest = json.load(__import__('sys').stdin)\nassert request['action'] == 'tick'\nassert request['task_path'] == ${JSON.stringify(taskPath)}\nwith Path(${JSON.stringify(log)}).open('a') as f:\n f.write(json.dumps(['start', time.monotonic()]) + '\\n')\ntime.sleep(0.25)\nwith Path(${JSON.stringify(log)}).open('a') as f:\n f.write(json.dumps(['end', time.monotonic()]) + '\\n')\nprint(json.dumps({}))\n`);
const role = await createJiti(import.meta.url, { tsconfigPaths: true, moduleCache: true }).import("./role-tasks.ts");
const indexDir = join(process.env.PI_CODING_AGENT_DIR, "runtime", "pi-web-role-tasks");
const index = join(indexDir, `monitor-${createHash("sha256").update(taskPath).digest("hex")}.json`);
const events = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
async function until(predicate, description, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`timeout waiting for ${description}: ${JSON.stringify(events())}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
after(() => {
  role.unwatchRoleTask(taskPath);
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});

test("durable index recovers a single runner; concurrent tick requests coalesce and respect interval", async () => {
  role.watchRoleTask(taskPath, 200);
  assert.deepEqual(JSON.parse(readFileSync(index, "utf8")), { taskPath });
  // Emulate a fresh process: old in-memory timer is cancelled but durable index survives.
  const runners = globalThis.__piRoleRunners;
  for (const runner of runners.values()) {
    if (runner.timer) clearTimeout(runner.timer);
    if (runner.quick) clearTimeout(runner.quick);
  }
  runners.clear();
  role.recoverRoleMonitors();
  role.recoverRoleMonitors();
  assert.equal(runners.size, 1);
  await until(() => events().some(([event]) => event === "start"), "first recovered tick");
  for (let i = 0; i < 6; i++) role.requestRoleTick(taskPath);
  await until(() => events().filter(([event]) => event === "end").length === 2, "coalesced pending tick");
  const snapshot = events();
  assert.deepEqual(snapshot.map(([event]) => event), ["start", "end", "start", "end"]);
  assert.ok(snapshot[2][1] >= snapshot[1][1], "no overlap between native calls");
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(events().length, 4, "no extra tick before configured two-second interval");
  await until(() => events().filter(([event]) => event === "end").length === 3, "scheduled interval", 3500);
  assert.ok(events()[4][1] - events()[3][1] >= 1.8, "scheduled tick uses the task interval");
  state.status = "handoff_complete";
  persist();
  await until(() => !existsSync(index) && runners.size === 0, "terminal task unregisters index and runner", 4500);
  const count = events().length;
  role.recoverRoleMonitors();
  role.requestRoleTick(taskPath);
  await new Promise((resolve) => setTimeout(resolve, 1150));
  assert.equal(events().length, count, "no resurrection after terminal state");
});

test("recovery rejects substituted index symlinks and malformed monitor records without starting runners", () => {
  state.status = "running";
  persist();
  writeFileSync(index, JSON.stringify({ taskPath: join(root, "elsewhere") }));
  const originalError = console.error;
  console.error = () => {};
  try {
    role.recoverRoleMonitors();
    assert.equal(globalThis.__piRoleRunners.size, 0);
    rmSync(index);
    symlinkSync(taskPath, index);
    role.recoverRoleMonitors();
    assert.equal(globalThis.__piRoleRunners.size, 0);
  } finally { console.error = originalError; rmSync(index, { force: true }); }
  assert.equal(readdirSync(indexDir).filter((name) => name.startsWith("monitor-")).length, 0);
});
