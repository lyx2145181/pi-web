import { execFile, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync, constants } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "./types";

export const ROLE_BINDING_TYPE = "pi-web:role-task-binding";
const stateDir = () => join(getAgentDir(), "runtime", "pi-web-role-tasks");
const key = (path: string) => createHash("sha256").update(path).digest("hex");
function noSymlink(path: string): void {
  let part = path;
  while (true) {
    const stat = lstatSync(part);
    if (stat.isSymbolicLink()) throw new Error("Symlink in role path");
    if (part !== path && !stat.isDirectory()) throw new Error("Non-directory in role path");
    if (part === dirname(part)) break;
    part = dirname(part);
  }
}
function storage(): string {
  const dir = stateDir();
  // Directory is host-owned, but never follow a substituted index directory.
  let part = dir;
  const missing: string[] = [];
  while (!existsSync(part)) { missing.push(part); part = dirname(part); }
  noSymlink(part);
  for (const name of missing.reverse()) mkdirSync(name, { mode: 0o700 });
  noSymlink(dir);
  if (!lstatSync(dir).isDirectory()) throw new Error("Invalid role index directory");
  return dir;
}
function stored(path: string): string {
  storage();
  if (existsSync(path) || (() => { try { lstatSync(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } })()) {
    if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error("Invalid role index entry");
  }
  return path;
}
const atomic = (path: string, value: unknown) => {
  stored(path);
  const temp = `${path}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    writeFileSync(fd, JSON.stringify(value));
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    stored(path);
    renameSync(temp, path);
    const dirFd = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
};
function strictJson(path: string): unknown {
  const raw = readFileSync(stored(path), "utf8");
  const value: unknown = JSON.parse(raw);
  // Host writes canonical compact JSON: rejects duplicate keys, trailing bytes,
  // unknown writers and noncanonical receipt/index payloads rather than trusting them.
  if (raw !== JSON.stringify(value)) throw new Error("Noncanonical role index JSON");
  return value;
}

export interface RoleTask {
  version: number;
  mode: string;
  status: string;
  project_root: string;
  dispatcher_session_id: string | null;
  monitor?: { interval_seconds?: number };
  work?: { id: string; session_id: string | null; status: string };
  mailbox?: Array<{ id: string; work_id: string; sender_id: string; recipient_id: string; kind: string; text: string; status: string }>;
}
export const roleFinished = (task: RoleTask) => task.status === "handoff_complete";
/** Trusted-host provenance guard; not an OS sandbox. */
export function readRoleTask(taskPath: string): RoleTask {
  if (typeof taskPath !== "string" || !isAbsolute(taskPath) || resolve(taskPath) !== taskPath || basename(taskPath) !== "任务.json") throw new Error("Invalid absolute role task path");
  noSymlink(taskPath);
  if (!lstatSync(taskPath).isFile()) throw new Error("Role task must be a regular file");
  const root = execFileSync("git", ["-C", dirname(taskPath), "rev-parse", "--show-toplevel"], { encoding: "utf8", timeout: 5000 }).trim();
  const rel = relative(root, taskPath).split(sep);
  if (rel.length < 4 || rel[0] !== "_交付记录" || rel[1] !== "start-leaf" || rel.at(-1) !== "任务.json" || rel.some((part) => part === ".." || part === "")) throw new Error("Task outside git delivery records");
  const task = JSON.parse(readFileSync(taskPath, "utf8")) as RoleTask;
  if (!task || task.version !== 1 || task.mode !== "dispatcher-message-work" || typeof task.status !== "string" || task.project_root !== root || (task.dispatcher_session_id !== null && typeof task.dispatcher_session_id !== "string")) throw new Error("Invalid dispatcher message task state");
  return task;
}
export function boundSession(task: RoleTask, sessionId: string): boolean {
  return sessionId === task.dispatcher_session_id || sessionId === task.work?.session_id;
}
export function readRoleBinding(entries: readonly SessionEntry[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === "custom" && entry.customType === ROLE_BINDING_TYPE) {
      const data = entry.data as { version?: unknown; taskPath?: unknown } | null;
      if (data?.version !== 1 || typeof data.taskPath !== "string") throw new Error("Invalid persisted role task binding");
      return data.taskPath;
    }
  }
}
export function appendRoleBinding(manager: SessionManager, taskPath: string): void {
  manager.appendCustomEntry(ROLE_BINDING_TYPE, { version: 1, taskPath });
}
export function roleMessageInput(taskPath: string, callerId: string, callId: string, kind: "progress" | "help" | "result" | "reply", text: string) {
  if (!callId || typeof callId !== "string") throw new Error("SDK tool call ID required");
  return { action: "message", task_path: taskPath, caller_id: callerId, call_id: callId, message: { kind, text } };
}
export const ROLE_NATIVE_TIMEOUT_MS = 120000;
export function nativeCall(input: object, timeout = ROLE_NATIVE_TIMEOUT_MS): Promise<unknown> {
  const driver = join(getAgentDir(), "skills", "start-leaf", "scripts", "native_call.py");
  return new Promise((ok, fail) => {
    const child = execFile("python3", [driver], { timeout, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) fail(err);
      else { try { ok(JSON.parse(stdout)); } catch (error) { fail(error); } }
    });
    child.stdin?.end(JSON.stringify(input));
  });
}
const monitorFile = (path: string) => join(stateDir(), `monitor-${key(path)}.json`);
type Runner = { timer?: ReturnType<typeof setTimeout>; quick?: ReturnType<typeof setTimeout>; running: boolean; pending: boolean; watching: boolean };
const global = globalThis as typeof globalThis & { __piRoleRunners?: Map<string, Runner> };
const runners = () => global.__piRoleRunners ??= new Map<string, Runner>();
function period(task: RoleTask): number {
  const seconds = task.monitor?.interval_seconds;
  return typeof seconds === "number" && Number.isInteger(seconds) && seconds >= 1 && seconds <= 86400 ? seconds * 1000 : 300000;
}
function schedule(path: string, runner: Runner, delay: number): void {
  if (runner.timer) clearTimeout(runner.timer);
  runner.timer = setTimeout(() => { runner.timer = undefined; void tick(path, runner); }, delay);
  runner.timer.unref();
}
async function tick(path: string, runner: Runner): Promise<void> {
  if (runner.running) { runner.pending = true; return; }
  runner.running = true;
  try {
    if (roleFinished(readRoleTask(path))) { unwatchRoleTask(path); return; }
    const response = await nativeCall({ action: "tick", task_path: path });
    if (response && typeof response === "object" && (response as { stop?: unknown }).stop === true) { unwatchRoleTask(path); return; }
    if (roleFinished(readRoleTask(path))) { unwatchRoleTask(path); return; }
  } catch (error) { console.error("[pi-web] role task tick gap:", error); }
  finally {
    runner.running = false;
    if (runners().get(path) === runner) {
      if (runner.watching) schedule(path, runner, periodSafe(path));
      if (runner.pending) { runner.pending = false; requestRoleTick(path); }
      else if (!runner.watching) runners().delete(path);
    }
  }
}
function periodSafe(path: string): number { try { return period(readRoleTask(path)); } catch { return 300000; } }
/** Fast coalesced check; never concurrent with the scheduled tick for this task. */
export function requestRoleTick(path: string): void {
  const task = readRoleTask(path);
  if (roleFinished(task)) { unwatchRoleTask(path); return; }
  const runner = runners().get(path) ?? { running: false, pending: false, watching: false };
  runners().set(path, runner);
  if (runner.running) { runner.pending = true; return; }
  if (runner.quick) return;
  runner.quick = setTimeout(() => { runner.quick = undefined; void tick(path, runner); }, 1000);
  runner.quick.unref();
}
export function watchRoleTask(path: string, firstDelay = 1000): void {
  const task = readRoleTask(path);
  if (roleFinished(task)) { unwatchRoleTask(path); return; }
  const existing = runners().get(path);
  if (existing?.watching) return;
  const index = monitorFile(path);
  try {
    const previous = strictJson(index) as { taskPath?: unknown };
    if (!previous || Object.keys(previous).length !== 1 || previous.taskPath !== path) throw new Error("Conflicting role monitor index");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  atomic(index, { taskPath: path });
  const runner = existing ?? { running: false, pending: false, watching: false };
  runner.watching = true;
  runners().set(path, runner);
  schedule(path, runner, firstDelay);
}
export function unwatchRoleTask(path: string): void {
  const runner = runners().get(path);
  if (runner?.timer) clearTimeout(runner.timer);
  if (runner?.quick) clearTimeout(runner.quick);
  runners().delete(path);
  const file = monitorFile(path);
  try { unlinkSync(stored(file)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
export function recoverRoleMonitors(): void {
  for (const name of readdirSync(storage())) {
    if (!/^monitor-[a-f0-9]{64}\.json$/.test(name)) continue;
    try {
      const record = strictJson(join(stateDir(), name)) as { taskPath?: unknown };
      if (!record || Object.keys(record).length !== 1 || typeof record.taskPath !== "string" || name !== `monitor-${key(record.taskPath)}.json`) throw new Error("Invalid monitor record");
      watchRoleTask(record.taskPath);
    } catch (error) { console.error("[pi-web] invalid role monitor index:", name, error); }
  }
}
export type DeliveryReceipt = { status: "delivered" | "uncertain"; eventId: string; recipientId: string; taskPath: string; text: string };
const receiptFile = (path: string, id: string) => join(stateDir(), `receipt-${key(path + "\0" + id)}.json`);
export function readDeliveryReceipt(path: string, id: string): DeliveryReceipt | undefined {
  let value: unknown;
  try { value = strictJson(receiptFile(path, id)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid role receipt");
  const receipt = value as DeliveryReceipt;
  if (Object.keys(receipt).sort().join() !== "eventId,recipientId,status,taskPath,text" || receipt.taskPath !== path || receipt.eventId !== id || typeof receipt.recipientId !== "string" || !receipt.recipientId || typeof receipt.text !== "string" || !["delivered", "uncertain"].includes(receipt.status)) throw new Error("Invalid role receipt schema");
  return receipt;
}
export function saveDeliveryReceipt(receipt: DeliveryReceipt): void {
  if (!["uncertain", "delivered"].includes(receipt.status) || !receipt.eventId || !receipt.recipientId || typeof receipt.text !== "string") throw new Error("Invalid role receipt write");
  const previous = readDeliveryReceipt(receipt.taskPath, receipt.eventId);
  if (previous && (previous.recipientId !== receipt.recipientId || previous.text !== receipt.text || (previous.status === "delivered" && receipt.status !== "delivered"))) throw new Error("Conflicting role receipt write");
  atomic(receiptFile(receipt.taskPath, receipt.eventId), receipt);
}
