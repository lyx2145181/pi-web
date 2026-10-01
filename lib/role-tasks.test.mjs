import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const maintenanceDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "role-host-tests");
mkdirSync(maintenanceDir, { recursive: true });
const root = mkdtempSync(join(maintenanceDir, "case-"));
const oldAgent = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
const project = join(root, "project");
mkdirSync(project);
execFileSync("git", ["init", "-q", project]);
const dir = join(project, "_交付记录", "start-leaf", "leaf");
mkdirSync(dir, { recursive: true });
const path = join(dir, "任务.json");
const state = { version: 1, mode: "dispatcher-message-work", project_root: project, status: "running", dispatcher_session_id: "dispatcher", work: { id: "work-1", session_id: "worker", status: "running" }, mailbox: [] };
writeFileSync(path, JSON.stringify(state));
const jiti = createJiti(import.meta.url, { tsconfigPaths: true, moduleCache: true });
const role = await jiti.import("./role-tasks.ts");
after(() => {
  role.unwatchRoleTask(path);
  if (oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = oldAgent;
  rmSync(root, { recursive: true, force: true });
});
test("git-root scoped regular task, registered SDK identities and persistent binding", () => {
  assert.equal(role.readRoleTask(path).work.id, "work-1");
  assert.equal(role.boundSession(state, "worker"), true);
  assert.equal(role.boundSession(state, "outsider"), false);
  let entry;
  role.appendRoleBinding({ appendCustomEntry: (type, data) => { entry = { type: "custom", customType: type, data }; } }, path);
  assert.equal(role.readRoleBinding([entry]), path);
  assert.throws(() => role.readRoleTask("relative/任务.json"));
  const linkDir = join(project, "_交付记录", "start-leaf", "link-leaf");
  symlinkSync(dir, linkDir);
  assert.throws(() => role.readRoleTask(join(linkDir, "任务.json")), /Symlink/);
  const outside = join(project, "elsewhere", "任务.json"); mkdirSync(join(project, "elsewhere")); writeFileSync(outside, "{}");
  assert.throws(() => role.readRoleTask(outside));
});
test("malformed latest persisted binding fails closed instead of falling back to an older binding", () => {
  const valid = { type: "custom", customType: role.ROLE_BINDING_TYPE, data: { version: 1, taskPath: path } };
  for (const data of [null, { version: 2, taskPath: path }, { version: 1, taskPath: 42 }]) {
    assert.throws(() => role.readRoleBinding([valid, { ...valid, data }]), /Invalid persisted role task binding/);
  }
});
test("SDK call identity is top-level, not model message input", () => {
  assert.equal(role.ROLE_NATIVE_TIMEOUT_MS, 120000);
  const input = role.roleMessageInput(path, "worker", "sdk-call-1", "help", "please check");
  assert.deepEqual(input, { action: "message", task_path: path, caller_id: "worker", call_id: "sdk-call-1", message: { kind: "help", text: "please check" } });
  assert.throws(() => role.roleMessageInput(path, "worker", "", "help", "text"));
});
test("monitor index and durable uncertain/delivered receipt", () => {
  role.watchRoleTask(path, 600000);
  role.watchRoleTask(path, 600000);
  assert.equal(role.readDeliveryReceipt(path, "event-1"), undefined);
  const receipt = { taskPath: path, eventId: "event-1", recipientId: "worker", text: "msg", status: "uncertain" };
  role.saveDeliveryReceipt(receipt);
  assert.deepEqual(role.readDeliveryReceipt(path, "event-1"), receipt);
  role.saveDeliveryReceipt({ ...receipt, status: "delivered" });
  assert.equal(role.readDeliveryReceipt(path, "event-1").status, "delivered");
});
test("receipt rejects duplicate keys, symlinks and substituted index directory", () => {
  role.unwatchRoleTask(path);
  const directory = join(process.env.PI_CODING_AGENT_DIR, "runtime", "pi-web-role-tasks");
  const hash = createHash("sha256").update(path + "\0event-1").digest("hex");
  const file = join(directory, `receipt-${hash}.json`);
  writeFileSync(file, '{"status":"delivered","status":"uncertain","eventId":"event-1","recipientId":"worker","taskPath":"' + path + '","text":"msg"}');
  assert.throws(() => role.readDeliveryReceipt(path, "event-1"), /Noncanonical/);
  rmSync(file);
  symlinkSync(join(root, "other"), file);
  assert.throws(() => role.readDeliveryReceipt(path, "event-1"), /Invalid role index entry/);
  rmSync(file);
  const moved = `${directory}-original`;
  renameSync(directory, moved);
  symlinkSync(moved, directory);
  try { assert.throws(() => role.saveDeliveryReceipt({ taskPath: path, eventId: "event-1", recipientId: "worker", text: "msg", status: "uncertain" }), /Symlink/); }
  finally { rmSync(directory); renameSync(moved, directory); }
});
