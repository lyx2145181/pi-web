import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  createAgentSessionFromServices,
  getAgentDir,
  initTheme,
  SessionManager,
  SettingsManager,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type { AgentSessionLike } from "./pi-types";
import {
  subagentNotificationText,
  subagentToolDetails,
  type ResumeSubagentRequest,
  type StartSubagentRequest,
  type SubagentExecution,
  type SubagentExtensionRuntime,
} from "./subagent-extension";
import {
  readSubagentRun,
  readSubagentSessionResources,
  resolveSubagentProfile,
  SUBAGENT_META_TYPE,
  SUBAGENT_STATUS_TYPE,
  SUBAGENT_RESULT_TYPE,
  settleOrphanedSubagentStatus,
  type SubagentMetadata,
  type SubagentProfile,
  type SubagentResultMetadata,
  type SubagentRunInfo,
} from "./subagents";
import type { SessionEntry } from "./types";
import type { DebugParentNotification, DebugSubagentRun } from "./debug-types";
import { buildSubagentPromptPlan } from "./subagent-prompt";
import { createExactSystemPromptExtension } from "./exact-system-prompt";
import { appendSubagentInputFiles, loadSubagentInputFiles, subagentInputLimits } from "./subagent-input";
import { getProjectTrustStatus, projectTrustReloadOptions } from "./project-trust";
import { createSubagentSessionServices } from "./subagent-resources";
import { subagentToolExclusions, subagentToolPolicy } from "./subagent-tool-policy";
import { resolveShellTools } from "./powershell-settings";
import { isBuiltInSubagentsEnabled, readSubagentSettings } from "./subagent-settings";
import { SubagentQueue } from "./subagent-queue";
import { addWorktree, removeWorktree } from "./worktree";
import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";

interface HostSession {
  readonly inner: AgentSessionLike;
  readonly sessionFile: string;
  readonly cwd: string;
  isAlive(): boolean;
  isRunning(): boolean;
  waitUntilReady(): Promise<void>;
  promptDelegated?(message: string, signal?: AbortSignal): Promise<void>;
  abortDelegated?(): Promise<void>;
}

export interface SubagentRuntimeDependencies {
  getSession(sessionId: string): HostSession | undefined;
  registerSession(
    inner: AgentSessionLike,
    options?: { exactSystemPrompt?: string; chatOnly?: boolean; mcpHost?: import("./mcp-host").McpHost },
  ): void | Promise<void>;
  reopenSession(sessionId: string, sessionFile: string): Promise<HostSession>;
  resolveSessionPath(sessionId: string): Promise<string | null>;
  invalidateSessionList(): void;
  isBuiltInSubagentsEnabled?(): boolean;
}

export interface SubagentController {
  readonly extensionRuntime: SubagentExtensionRuntime;
  get(sessionId: string): Promise<SubagentRunInfo | null>;
  steer(sessionId: string, message: string): Promise<void>;
  abort(sessionId: string): Promise<void>;
  /** A turn in a child's own chat ended: settles the run a restart cut off, if that is what the file holds. */
  settleDirectTurn(sessionId: string, aborted: boolean, fromIndex?: number): void;
}

type StoredSubagentExecution = {
  run: SubagentRunInfo;
  completion: Promise<SubagentRunInfo>;
  abortRequested: boolean;
  /** Set once the turn limit ends the run; later steering is refused instead of starting another turn. */
  turnLimitReached?: boolean;
  cancelQueued?: () => boolean;
  promptController?: AbortController;
  /** Dispatch time of this run, including resumes. */
  dispatchedAt?: number;
  /** Legacy hot-reload diagnostic field. Preparation now belongs to the wrapper. */
  mcpWait?: AbortController;
};

function isAbortError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { name?: unknown }).name === "AbortError");
}

async function promptDelegated(wrapper: HostSession | undefined, inner: AgentSessionLike, message: string, stored: StoredSubagentExecution): Promise<void> {
  throwIfSubagentCancelled(stored);
  const resources = readSubagentSessionResources(inner.sessionManager.getEntries() as unknown as SessionEntry[]);
  if (resources?.version === 3 && (resources.codeMode || resources.loadMcp)
    && (typeof wrapper?.promptDelegated !== "function" || typeof wrapper.waitUntilReady !== "function")) {
    throw new Error("Subagent host capabilities require delegated wrapper preparation");
  }
  if (wrapper?.promptDelegated) return wrapper.promptDelegated(message, (stored.promptController ??= new AbortController()).signal);
  await inner.prompt(message, { source: "rpc" });
}

function abortDelegated(wrapper: HostSession | undefined, inner: AgentSessionLike, stored?: StoredSubagentExecution): Promise<void> {
  stored?.promptController?.abort();
  return wrapper?.abortDelegated ? wrapper.abortDelegated() : inner.abort();
}

/** Check admission after every readiness await; aborting an idle SDK session alone cannot stop a later prompt. */
function throwIfSubagentCancelled(stored: StoredSubagentExecution, signal?: AbortSignal): void {
  if (signal?.aborted) stored.abortRequested = true;
  if (stored.abortRequested) throw new Error("Subagent cancelled before prompting");
}

/** A run's completion `notifyParent()` is delivering; `since` is absent on one added before a hot reload. */
type ParentNotification = Pick<SubagentRunInfo, "sessionId" | "parentSessionId" | "completedAt"> & { since?: number };

declare global {
  var __piSubagentRuns: Map<string, StoredSubagentExecution> | undefined;
  var __piSubagentQueue: SubagentQueue<SubagentRunInfo> | undefined;
  var __piSubagentConsumedResults: Map<string, string> | undefined;
  var __piSubagentParentNotifications: Set<ParentNotification> | undefined;
}
const SUBAGENT_CONTEXT_LIMIT = 50_000;
const PARENT_IDLE_POLL_MS = 200;
const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

const TURN_LIMIT_INSTRUCTION = "You have reached your turn limit. Wrap up immediately and provide your final answer now.";

function entryCount(sessionManager: { getEntries?: () => unknown }): number {
  const entries = sessionManager.getEntries?.();
  return Array.isArray(entries) ? entries.length : 0;
}

/**
 * The outcome of the last assistant message appended *since `fromIndex`*, so one run never reads
 * an earlier aborted/failed turn. pi resolves `prompt()` normally for provider failures and
 * child-chat stops, recording the reason and any partial text on the assistant message.
 */
function lastAssistantOutcome(
  sessionManager: { getEntries?: () => unknown },
  fromIndex: number,
): { text?: string; aborted?: true; error?: string } | undefined {
  const entries = sessionManager.getEntries?.();
  if (!Array.isArray(entries)) return undefined;
  for (let i = entries.length - 1; i >= fromIndex; i -= 1) {
    const entry = entries[i] as { type?: unknown; message?: { role?: unknown; stopReason?: unknown; errorMessage?: unknown; content?: unknown } };
    if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
    const message = entry.message;
    const content = Array.isArray(message.content) ? message.content : [];
    let text = "";
    for (const part of content) {
      if (part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string") {
        text += (part as { text: string }).text;
      }
    }
    const trimmed = text.trim();
    if (message.stopReason === "aborted") return { aborted: true, ...(trimmed ? { text: trimmed } : {}) };
    if (message.stopReason === "error") {
      const error = typeof message.errorMessage === "string" && message.errorMessage ? message.errorMessage : "Provider returned an error";
      return { error, ...(trimmed ? { text: trimmed } : {}) };
    }
    return trimmed ? { text: trimmed } : {};
  }
  return undefined;
}

function turnLimitError(turnLimit: number, undelivered: readonly string[]): string {
  const error = `Subagent reached its turn limit (${turnLimit}) without completing the task.`;
  if (undelivered.length === 0) return error;
  return `${error} These queued messages were not delivered:\n${undelivered.map((text) => `- ${text}`).join("\n")}`;
}

function getSubagentRuns(): Map<string, StoredSubagentExecution> {
  if (!globalThis.__piSubagentRuns) globalThis.__piSubagentRuns = new Map();
  return globalThis.__piSubagentRuns;
}

/**
 * Cancel the current stored run of a session, as the wrapper's Stop does: mark only a queued or
 * running run aborted, end a queued one, and abort its per-run controller so a run still waiting
 * on the wrapper (readiness or MCP preparation) never sends its prompt. An idle or finished
 * session is untouched, so a Stop cannot poison a later run on the same wrapper.
 */
export function requestSubagentRunAbort(sessionId: string): boolean {
  const stored = getSubagentRuns().get(sessionId);
  if (!stored || (stored.run.status !== "running" && stored.run.status !== "queued")) return false;
  stored.abortRequested = true;
  if (stored.run.status === "queued") {
    stored.cancelQueued?.();
    return true;
  }
  stored.promptController?.abort();
  return true;
}

/**
 * Take a run out of the run map unless a newer run of that session took its place; true when it
 * was still there. Runs call it from `finally` too: a throw before the result entry is written (a
 * session file append failing) must not leave it there, where it would read as running and keep
 * `hasUnsettledSubagentRun()` true for its parent until the server restarts.
 */
function dropSubagentRun(sessionId: string, stored: StoredSubagentExecution): boolean {
  const runs = getSubagentRuns();
  if (runs.get(sessionId) !== stored) return false;
  runs.delete(sessionId);
  return true;
}

/**
 * Runs whose completion `notifyParent()` is still delivering: the run has left the
 * run map, but the parent's turn starts only once the parent is ready and idle. An entry leaves
 * as soon as that turn starts, since the parent is running from then on.
 */
function getParentNotifications(): Set<ParentNotification> {
  globalThis.__piSubagentParentNotifications ??= new Set();
  return globalThis.__piSubagentParentNotifications;
}

/**
 * Runs that can still start a turn in their parent: those in the run map, and notifications
 * not yet delivered whose result the parent has not collected with `get_subagent_result`
 * (`deliverParentNotification()` drops a collected one without a turn).
 */
function unsettledSubagentRuns(): ParentNotification[] {
  const consumed = getConsumedSubagentResults();
  return [
    ...[...getSubagentRuns().values()].map((stored) => stored.run),
    ...[...getParentNotifications()].filter((run) => !run.completedAt || consumed.get(run.sessionId) !== run.completedAt),
  ];
}

/**
 * Whether a subagent run under this session, at any depth, is still unsettled: its end can
 * start a turn there (`notifyParent()`, `triggerTurn`). A run counts from dispatch until its
 * result is written (the run map), then until the turn its parent notification triggers starts,
 * or the delivery is dropped or fails. A hidden page keeps the session's event stream while this
 * holds (#1283), and a main session's run that ends meanwhile announces no completion: the
 * turn a report starts decides that (#1434).
 */
export function hasUnsettledSubagentRun(sessionId: string): boolean {
  return subagentFamily(sessionId, unsettledSubagentRuns()).size > 1;
}

/** `sessionId` and every session under it, at any depth, by the rows' direct parents. */
function subagentFamily(sessionId: string, runs: readonly Pick<SubagentRunInfo, "sessionId" | "parentSessionId">[]): Set<string> {
  const family = new Set([sessionId]);
  for (let grew = true; grew;) {
    grew = false;
    for (const run of runs) {
      if (!family.has(run.parentSessionId) || family.has(run.sessionId)) continue;
      family.add(run.sessionId);
      grew = true;
    }
  }
  return family;
}

/**
 * The run map and the parent notifications for the debug panel: every row, or with a session id
 * the rows under it at any depth (the family `hasUnsettledSubagentRun()` walks). States, flags and
 * times only, never a task, a result, an error or a path. It reads the tables as they are: nothing
 * is created, cancelled or aborted.
 */
export function subagentDebugSnapshot(sessionId?: string): { runs: DebugSubagentRun[]; notifications: DebugParentNotification[] } {
  const stored = [...(globalThis.__piSubagentRuns?.values() ?? [])];
  const pending = [...(globalThis.__piSubagentParentNotifications ?? [])];
  const family = sessionId === undefined
    ? undefined
    : subagentFamily(sessionId, [...stored.map((entry) => entry.run), ...pending]);
  const under = (row: Pick<SubagentRunInfo, "parentSessionId">) => !family || family.has(row.parentSessionId);
  return {
    runs: stored.filter((entry) => under(entry.run)).map((entry) => ({
      sessionId: entry.run.sessionId,
      parentSessionId: entry.run.parentSessionId,
      status: typeof entry.run.status === "string" ? entry.run.status : "unknown",
      profile: typeof entry.run.profile === "string" && entry.run.profile ? entry.run.profile : null,
      background: entry.run.runInBackground === true,
      resumed: entry.run.resumed === true,
      dispatchedAt: typeof entry.dispatchedAt === "number" ? entry.dispatchedAt : null,
      abortRequested: entry.abortRequested === true,
      mcpWaiting: globalThis.__piSessions?.get(entry.run.sessionId)?.getDebugSnapshot?.().run.waitingForMcp ?? Boolean(entry.mcpWait),
    })),
    notifications: pending.filter(under).map((row) => ({
      sessionId: row.sessionId,
      parentSessionId: row.parentSessionId,
      since: typeof row.since === "number" ? row.since : null,
    })),
  };
}

/** Every session `hasUnsettledSubagentRun()` holds for: the parents of the unsettled runs. */
export function getSessionIdsWithUnsettledSubagentRuns(): string[] {
  return [...new Set(unsettledSubagentRuns().map((run) => run.parentSessionId))];
}

function getSubagentQueue(): SubagentQueue<SubagentRunInfo> {
  if (!globalThis.__piSubagentQueue) globalThis.__piSubagentQueue = new SubagentQueue();
  return globalThis.__piSubagentQueue;
}

type SubagentRunIdentity = Pick<SubagentRunInfo, "sessionId" | "completedAt">;

/**
 * Runs whose terminal result the parent already collected with `get_subagent_result`,
 * keyed by subagent session ID and holding the collected run's `completedAt`. `resume` reruns
 * the same session ID, so the mark must name the run: a parent that polls *after* a run's
 * notification was delivered leaves a mark nothing consumes, and a bare session ID would let it
 * swallow the next run's notification (#987). `resume` deliberately does not clear the entry:
 * the parent can collect a run and resume it in the same turn while that run's notification is
 * still held, and the mark must keep suppressing it. A foreground run whose Agent wait expired
 * also notifies; collecting any terminal run can suppress its report. Each session holds at most
 * one entry.
 */
function getConsumedSubagentResults(): Map<string, string> {
  // A hot reload can leave the pre-#987 Set on globalThis; replace it rather than call Map methods on it.
  if (!(globalThis.__piSubagentConsumedResults instanceof Map)) globalThis.__piSubagentConsumedResults = new Map();
  return globalThis.__piSubagentConsumedResults;
}

function markResultConsumed(run: SubagentRunIdentity): void {
  // A terminal run without `completedAt` (interrupted) never notifies, so there is nothing to drop.
  if (!run.completedAt) return;
  getConsumedSubagentResults().set(run.sessionId, run.completedAt);
}

/** Take the mark only when it names this very run; a mark left by an earlier run is ignored. */
function takeResultConsumed(run: SubagentRunIdentity): boolean {
  const consumed = getConsumedSubagentResults();
  if (!run.completedAt || consumed.get(run.sessionId) !== run.completedAt) return false;
  consumed.delete(run.sessionId);
  return true;
}

/**
 * A run lives in `getSubagentRuns()` from dispatch until its result entry is written, so a
 * persisted `running` / `queued` status reaching `get()` without that entry (and without a running
 * wrapper) was left by a process that stopped mid-run and will never be finished. Report it as
 * `interrupted` so `get_subagent_result({ wait: true })` returns instead of polling forever, and
 * `resume` can pick the session up again.
 */
function settleOrphanedRun(run: SubagentRunInfo): SubagentRunInfo {
  return { ...run, status: settleOrphanedSubagentStatus(run.status) };
}

/** The status of a run this process still holds, so a listing does not have to guess from its file. */
export function getLiveSubagentStatus(sessionId: string): SubagentRunInfo["status"] | undefined {
  return getSubagentRuns().get(sessionId)?.run.status;
}

function findSubagentModel(runtime: ModelRuntime, reference: string) {
  const slash = reference.indexOf("/");
  if (slash > 0) return runtime.getModel(reference.slice(0, slash), reference.slice(slash + 1));
  const matches = runtime.getModels().filter((model) => model.id === reference);
  if (matches.length > 1) throw new Error(`Subagent model is ambiguous; use provider/modelId: ${reference}`);
  return matches[0];
}

/**
 * Reads a model reference as pi's `--model` does: `provider/modelId` or a bare id, optionally
 * followed by `:<thinking level>`. The whole reference is tried first, so an id that itself
 * contains a colon (`qwen3:8b`) still matches; a suffix that is no thinking level never matches.
 */
function parseSubagentModel(runtime: ModelRuntime, value: string | undefined) {
  if (!value?.trim()) return undefined;
  const requested = value.trim();
  const exact = findSubagentModel(runtime, requested);
  if (exact) return { model: exact };
  const colon = requested.lastIndexOf(":");
  const level = requested.slice(colon + 1) as ThinkingLevel;
  if (colon > 0 && THINKING_LEVELS.has(level)) {
    const model = findSubagentModel(runtime, requested.slice(0, colon));
    if (model) return { model, thinkingLevel: level };
  }
  throw new Error(`Subagent model not found: ${requested}`);
}

/** A protected role ignores the parent's model parameter, even if that parameter is invalid. */
function resolveSubagentModel(
  runtime: ModelRuntime,
  profile: Pick<SubagentProfile, "model" | "allowParentModelOverride">,
  requestModel: string | undefined,
): ReturnType<typeof parseSubagentModel> {
  if (profile.model?.trim() && profile.allowParentModelOverride !== true) {
    return parseSubagentModel(runtime, profile.model);
  }
  return parseSubagentModel(runtime, requestModel) ?? parseSubagentModel(runtime, profile.model);
}

/**
 * The model the child is expected to run (the call's, else the profile's, else the parent's),
 * looked up early to size `input_files` before a worktree or child session exists (#1199). It
 * never throws: the child's model is resolved for real, and a bad reference refused, only after
 * the child's services have refreshed the shared runtime from models.json and registered its
 * extensions' providers. A reference this lookup misses leaves the files the flat limit.
 */
function expectedSubagentModel(
  runtime: ModelRuntime,
  profile: Pick<SubagentProfile, "model" | "allowParentModelOverride">,
  callModel: string | undefined,
  parentModel: AgentSessionLike["model"],
) {
  try {
    return resolveSubagentModel(runtime, profile, callModel)?.model ?? parentModel;
  } catch {
    return undefined;
  }
}

function parentContextText(parent: HostSession): string {
  const messages = parent.inner.sessionManager.buildSessionContext().messages;
  const serialized = JSON.stringify(messages);
  if (serialized.length <= SUBAGENT_CONTEXT_LIMIT) return serialized;
  return `${serialized.slice(0, SUBAGENT_CONTEXT_LIMIT)}\n[Parent context truncated]`;
}

/**
 * pi creates a session file only once the session holds a user or assistant message, so a run
 * that ended before its prompt reached the model (stopped while queued or connecting MCP servers,
 * a provider without credentials) kept its metadata and result in memory only. Once the idle
 * child's wrapper was released, `get_subagent_result` and `resume` answered `Subagent not found`
 * for an id the parent had been given, and the session left the sidebar. Write the file when the
 * child is dispatched; `setSessionFile()` reloads it, so pi appends every later entry to it.
 */
function persistChildSession(sessionManager: SessionManager): void {
  const sessionFile = sessionManager.getSessionFile();
  const header = sessionManager.getHeader();
  if (!sessionFile || !header || existsSync(sessionFile)) return;
  const lines = [header, ...sessionManager.getEntries()].map((entry) => JSON.stringify(entry));
  writeFileSync(sessionFile, `${lines.join("\n")}\n`, { flag: "wx" });
  sessionManager.setSessionFile(sessionFile);
}

async function cleanupWorktree(
  parentCwd: string,
  worktree: { path: string; branch: string } | undefined,
): Promise<string | undefined> {
  if (!worktree) return undefined;
  try {
    await removeWorktree(parentCwd, worktree.path);
    return undefined;
  } catch (error) {
    return `Worktree retained at ${worktree.path}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Writes a settled run's result entry, which `readSubagentRun()` reads back, and returns the run as
 * recorded. An isolated run's entry keeps whether its worktree path still exists now, which decides
 * what the parent is told about it, live and read back alike (#1202): a checkout removed during
 * the run is gone though git's removal then failed, and a resumed run removes nothing.
 */
function recordResult(sessionManager: SessionManager, run: SubagentRunInfo): SubagentRunInfo {
  const recorded = run.worktreePath ? { ...run, worktreeExists: existsSync(run.worktreePath) } : run;
  const entry: SubagentResultMetadata = {
    version: 1,
    status: recorded.status as SubagentResultMetadata["status"],
    completedAt: recorded.completedAt!,
    ...(recorded.result ? { result: recorded.result } : {}),
    ...(recorded.error ? { error: recorded.error } : {}),
    ...(recorded.worktreeCleanupError ? { worktreeCleanupError: recorded.worktreeCleanupError } : {}),
    ...(recorded.worktreeExists !== undefined ? { worktreeExists: recorded.worktreeExists } : {}),
  };
  sessionManager.appendCustomEntry(SUBAGENT_RESULT_TYPE, entry);
  return recorded;
}

export function createSubagentController(
  dependencies: SubagentRuntimeDependencies,
): SubagentController {
  async function start(request: StartSubagentRequest): Promise<SubagentExecution> {
    const enabled = dependencies.isBuiltInSubagentsEnabled ?? isBuiltInSubagentsEnabled;
    if (!enabled()) throw new Error("Pi Web built-in sub-agents are disabled");
    const parentSessionId = request.parentContext.sessionManager.getSessionId();
    const parent = dependencies.getSession(parentSessionId);
    if (!parent?.isAlive()) throw new Error("Parent session is no longer available");
    if (!parent.sessionFile) throw new Error("Parent session must be persisted before starting a subagent");

    let isolatedWorktree: { path: string; branch: string } | undefined;
    try {
      const profile = resolveSubagentProfile(parent.cwd, request.profile);
      if (!profile) throw new Error(`Unknown or disabled subagent profile: ${request.profile}`);

      const parentModelRuntime = (parent.inner as unknown as { modelRuntime: ModelRuntime }).modelRuntime;

      const runInBackground = request.runInBackground ?? profile.runInBackground;
      const isolation = profile.isolation === "off" ? undefined : request.isolation ?? profile.isolation;
      // Sized by the window of the model expected to read the copy, and refused before a worktree
      // or child session exists.
      const inputFiles = loadSubagentInputFiles(parent.cwd, request.inputFiles ?? [], subagentInputLimits(
        expectedSubagentModel(parentModelRuntime, profile, request.model, parent.inner.model),
      ));
      if (isolation === "worktree") {
        isolatedWorktree = await addWorktree(parent.cwd, `pi-web-agent-${randomUUID()}`);
      }
      const childCwd = isolatedWorktree?.path ?? parent.cwd;
      const inheritContext = request.inheritContext ?? profile.inheritContext;
      const maxTurns = request.maxTurns ?? profile.maxTurns;
      if (maxTurns !== undefined && (!Number.isFinite(maxTurns) || maxTurns < 0)) {
        throw new Error("max_turns must be a non-negative number");
      }
      const turnLimit = maxTurns && maxTurns > 0 ? Math.floor(maxTurns) : undefined;
      const agentDir = getAgentDir();
      const settingsManager = SettingsManager.create(childCwd, agentDir, { projectTrusted: getProjectTrustStatus(childCwd, agentDir).trusted });
      const inheritedParentContext = inheritContext
        ? `The following is the active conversation context from the parent session. Use it only as background for the delegated task:\n${parentContextText(parent)}`
        : undefined;
      const promptPlan = buildSubagentPromptPlan({
        profileSystemPrompt: profile.systemPrompt,
        tools: profile.tools,
        loadSkills: profile.loadSkills,
        loadExtensions: profile.loadExtensions,
        codeMode: profile.codeMode,
        loadMcp: profile.loadMcp,
        promptMode: profile.promptMode,
        task: appendSubagentInputFiles(request.task, inputFiles),
        inheritedParentContext,
      });
      const { chatOnly, appendSystemPrompt, delegatedTask } = promptPlan;
      if (!chatOnly) initTheme();
      const builtinTools = resolveShellTools(profile.tools, settingsManager.getDefaultTools());
      const toolPolicy = subagentToolPolicy(profile);
      const services = await createSubagentSessionServices({
        cwd: childCwd,
        agentDir,
        modelRuntime: parentModelRuntime,
        settingsManager,
        resourceLoaderOptions: {
          noExtensions: !profile.loadExtensions,
          noSkills: !profile.loadSkills,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
          ...(chatOnly || promptPlan.exactSystemPrompt !== undefined
            ? {
                systemPrompt: " ",
                systemPromptOverride: () => undefined,
              }
            : {}),
          appendSystemPrompt,
          // The exact prompt is sent through before_agent_start; see lib/exact-system-prompt.ts.
          ...(promptPlan.exactSystemPrompt !== undefined
            ? { extensionFactories: [createExactSystemPromptExtension(() => promptPlan.exactSystemPrompt)] }
            : {}),
        },
        ...((profile.loadExtensions || profile.loadSkills)
          ? { resourceLoaderReloadOptions: projectTrustReloadOptions(childCwd, agentDir) }
          : {}),
      }, { ...profile, version: 3, builtinTools, toolPolicy });

      // Approved services may refresh models.json or register a child-only provider. Resolve
      // against that runtime, retaining role protection, before a child SessionManager can write.
      const requestedModel = resolveSubagentModel(services.modelRuntime, profile, request.model);
      const thinking = request.thinking ?? profile.thinking ?? requestedModel?.thinkingLevel ?? parent.inner.agent.state?.thinkingLevel;
      if (thinking && !THINKING_LEVELS.has(thinking as ThinkingLevel)) {
        throw new Error(`Invalid subagent thinking level: ${thinking}`);
      }
      const sessionManager = isolatedWorktree
        ? SessionManager.create(childCwd, undefined, { parentSession: parent.sessionFile })
        : SessionManager.create(parent.cwd, undefined, { parentSession: parent.sessionFile });
      const createdAt = new Date().toISOString();
      const metadata: SubagentMetadata = {
        version: 1,
        parentSessionId,
        parentSessionPath: parent.sessionFile,
        parentToolCallId: request.parentToolCallId,
        profile: profile.name,
        description: request.description.trim() || profile.displayName,
        task: request.task,
        runInBackground,
        createdAt,
        resourceSnapshot: {
          version: 3,
          codeMode: profile.codeMode === true,
          loadMcp: profile.loadMcp === true,
          mcpServers: structuredClone(profile.mcpServers ?? []),
          appendSystemPrompt: [...appendSystemPrompt],
          builtinTools: [...builtinTools],
          toolPolicy,
          loadSkills: profile.loadSkills,
          loadExtensions: profile.loadExtensions,
          skills: profile.skills ?? profile.loadSkills,
          extensions: profile.extensions ?? profile.loadExtensions,
          ...(promptPlan.exactSystemPrompt !== undefined ? { exactSystemPrompt: promptPlan.exactSystemPrompt } : {}),
        },
        ...(isolatedWorktree ? { worktreePath: isolatedWorktree.path, worktreeBranch: isolatedWorktree.branch } : {}),
      };
      sessionManager.appendCustomEntry(SUBAGENT_META_TYPE, metadata);
      sessionManager.appendSessionInfo(metadata.description);

      const parentModel = parent.inner.model as ReturnType<ModelRuntime["getModel"]>;
      const { session: inner } = await createAgentSessionFromServices({
        services,
        sessionManager,
        model: requestedModel?.model ?? parentModel,
        ...(thinking ? { thinkingLevel: thinking as ThinkingLevel } : {}),
        noTools: "builtin",
        excludeTools: subagentToolExclusions(builtinTools),
      });
      persistChildSession(sessionManager);
      // Public loadout API, not tools' immutable hard allowlist. Preserve extension
      // exposure/defaultActive; never force hidden/codemode/deferred tools active.
      inner.setActiveToolsByName([...new Set([...builtinTools, ...inner.getActiveToolNames()])]);
      // Handle rejection at registration, even if this run remains queued or is cancelled.
      // Keep the error as data until execution so a failed bind never admits a prompt.
      const ready = Promise.resolve(dependencies.registerSession(inner, {
        ...(promptPlan.exactSystemPrompt !== undefined
          ? { exactSystemPrompt: promptPlan.exactSystemPrompt }
          : {}),
        chatOnly,
        mcpHost: services.mcpHost,
      })).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );

      const initialRun: SubagentRunInfo = {
        sessionId: inner.sessionId,
        sessionPath: inner.sessionFile ?? sessionManager.getSessionFile() ?? "",
        parentSessionId,
        parentToolCallId: request.parentToolCallId,
        profile: profile.name,
        description: metadata.description,
        task: request.task,
        runInBackground,
        status: "queued",
        createdAt,
        ...(isolatedWorktree ? { worktreePath: isolatedWorktree.path, worktreeBranch: isolatedWorktree.branch } : {}),
      };

      let resolveCompletion!: (run: SubagentRunInfo) => void;
      const completion = new Promise<SubagentRunInfo>((resolve) => { resolveCompletion = resolve; });
      const stored: StoredSubagentExecution = {
        run: initialRun,
        completion,
        abortRequested: !runInBackground && request.signal?.aborted === true,
        dispatchedAt: Date.now(),
      };
      getSubagentRuns().set(initialRun.sessionId, stored);
      request.onUpdate?.(initialRun);
      dependencies.invalidateSessionList();

      const handleParentAbort = () => {
        stored.abortRequested = true;
        if (stored.run.status === "queued") stored.cancelQueued?.();
        else void abortDelegated(dependencies.getSession(inner.sessionId), inner, stored);
      };
      if (!runInBackground) {
        if (request.signal?.aborted) handleParentAbort();
        else request.signal?.addEventListener("abort", handleParentAbort, { once: true });
      }

      const runToResult = async (): Promise<SubagentRunInfo> => {
        // Reached only when the abort fires while the run is being queued, before `cancelQueued`
        // is set; a run aborted later in the queue ends in `finishQueuedAbort`.
        if (stored.abortRequested) {
          const cleanupError = await cleanupWorktree(parent.cwd, isolatedWorktree);
          const result = recordResult(sessionManager, {
            ...initialRun,
            status: "aborted",
            completedAt: new Date().toISOString(),
            ...(cleanupError ? { worktreeCleanupError: cleanupError } : {}),
          });
          stored.run = result;
          request.onUpdate?.(result);
          getSubagentRuns().delete(initialRun.sessionId);
          dependencies.invalidateSessionList();
          return result;
        }
        stored.run = { ...stored.run, status: "running" };
        sessionManager.appendCustomEntry(SUBAGENT_STATUS_TYPE, { version: 1, status: "running" });
        request.onUpdate?.(stored.run);
        dependencies.invalidateSessionList();
        // Entries present before this run; scopes stop/text to this run's messages.
        const runStart = entryCount(sessionManager);
        let turnCount = 0;
        let maxTurnsReached = false;
        let undelivered: string[] = [];
        const previousFinishTurn = inner.agent.finishTurn;
        const previousSteeringMode = inner.agent.steeringMode;
        let unsubscribeTools: (() => void) | undefined;
        if (turnLimit) {
          // Finalized events retain the SDK's terminate hint; tool-result messages do not.
          const terminatingTools = new Set<string>();
          unsubscribeTools = inner.subscribe((event) => {
            if (event.type === "tool_execution_end" && event.result?.terminate === true) {
              terminatingTools.add(event.toolCallId);
            }
          });
          inner.agent.finishTurn = async (turn, signal) => {
            const decision = (await previousFinishTurn?.(turn, signal)) ?? undefined;
            const toolsContinue = turn.toolResults.some((message) => !terminatingTools.has(message.toolCallId));
            terminatingTools.clear();
            turnCount += 1;
            // A cancelled run, or a turn that ended in an error / child-chat abort, is final and
            // never drains the budget.
            if (signal?.aborted || turn.message.stopReason === "error" || turn.message.stopReason === "aborted") return decision;
            const atOrPastLimit = turnCount >= turnLimit;
            // Budget boundary: drain and record anything already queued *before* an `end` decision
            // can let AgentSession start another run for it. Otherwise a queued steer silently
            // consumes a request past the limit.
            if (atOrPastLimit && inner.agent.hasQueuedMessages()
              && (decision?.action === "end" || turnCount >= turnLimit + 1)) {
              maxTurnsReached = true;
              stored.turnLimitReached = true;
              const { steering, followUp } = inner.clearQueue();
              undelivered = [...undelivered, ...steering, ...followUp];
              return { action: "end" };
            }
            if (decision?.action === "end") return decision;
            const needsAnotherTurn = toolsContinue || decision?.action === "continue" || inner.agent.hasQueuedMessages();
            if (!needsAnotherTurn || !atOrPastLimit) return decision;
            if (turnCount >= turnLimit + 1) {
              maxTurnsReached = true;
              stored.turnLimitReached = true;
              // AgentSession starts another run for anything still queued, past an `end`
              // decision, so the limit holds only once the queues are empty.
              const { steering, followUp } = inner.clearQueue();
              undelivered = [...undelivered, ...steering, ...followUp];
              return { action: "end" };
            }
            // The awaited SDK boundary delivers the instruction before the wrap-up request.
            // In one-at-a-time mode a steer queued earlier would take the wrap-up turn and
            // leave the instruction for later, so that turn takes everything queued.
            inner.agent.steeringMode = "all";
            await inner.steer(TURN_LIMIT_INSTRUCTION);
            return decision;
          };
        }
        let result: SubagentRunInfo;
        try {
          throwIfSubagentCancelled(stored, runInBackground ? undefined : request.signal);
          const registration = await ready;
          throwIfSubagentCancelled(stored, runInBackground ? undefined : request.signal);
          if (!registration.ok) throw registration.error;
          await dependencies.getSession(inner.sessionId)?.waitUntilReady?.();
          throwIfSubagentCancelled(stored, runInBackground ? undefined : request.signal);
          await promptDelegated(dependencies.getSession(inner.sessionId), inner, delegatedTask, stored);
          const outcome = lastAssistantOutcome(sessionManager, runStart);
          const text = outcome?.text;
          const aborted = stored.abortRequested || outcome?.aborted === true;
          const errorMessage = aborted ? undefined : outcome?.error ??
            (maxTurnsReached && turnLimit ? turnLimitError(turnLimit, undelivered) : undefined);
          result = {
            ...initialRun,
            status: aborted ? "aborted" : errorMessage ? "failed" : "completed",
            completedAt: new Date().toISOString(),
            ...(text ? { result: text } : {}),
            ...(errorMessage ? { error: errorMessage } : {}),
          };
        } catch (error) {
          const text = lastAssistantOutcome(sessionManager, runStart)?.text;
          const aborted = stored.abortRequested || request.signal?.aborted || isAbortError(error);
          result = {
            ...initialRun,
            status: aborted ? "aborted" : "failed",
            completedAt: new Date().toISOString(),
            ...(text ? { result: text } : {}),
            ...(!aborted
              ? { error: error instanceof Error ? error.message : String(error) }
              : {}),
          };
        } finally {
          if (turnLimit) {
            inner.agent.finishTurn = previousFinishTurn;
            inner.agent.steeringMode = previousSteeringMode;
          }
          unsubscribeTools?.();
          request.signal?.removeEventListener("abort", handleParentAbort);
        }

        const cleanupError = await cleanupWorktree(parent.cwd, isolatedWorktree);
        if (cleanupError) result = { ...result, worktreeCleanupError: cleanupError };
        result = recordResult(sessionManager, result);
        stored.run = result;
        request.onUpdate?.(result);
        getSubagentRuns().delete(initialRun.sessionId);
        dependencies.invalidateSessionList();
        return result;
      };
      const execute = async (): Promise<SubagentRunInfo> => {
        try {
          return await runToResult();
        } finally {
          if (dropSubagentRun(initialRun.sessionId, stored)) dependencies.invalidateSessionList();
        }
      };

      const finishQueuedAbort = async () => {
        if (stored.run.status !== "queued") return;
        request.signal?.removeEventListener("abort", handleParentAbort);
        try {
          const result: SubagentRunInfo = { ...initialRun, status: "aborted", completedAt: new Date().toISOString() };
          const cleanupError = await cleanupWorktree(parent.cwd, isolatedWorktree);
          const finalResult = recordResult(sessionManager, cleanupError ? { ...result, worktreeCleanupError: cleanupError } : result);
          stored.run = finalResult;
          request.onUpdate?.(finalResult);
          getSubagentRuns().delete(initialRun.sessionId);
          dependencies.invalidateSessionList();
          resolveCompletion(finalResult);
        } finally {
          if (dropSubagentRun(initialRun.sessionId, stored)) dependencies.invalidateSessionList();
        }
      };
      let queued: ReturnType<SubagentQueue<SubagentRunInfo>["enqueue"]>;
      try {
        queued = getSubagentQueue().enqueue(
          parentSessionId,
          readSubagentSettings().maxConcurrent,
          execute,
          (state) => {
            if (state === "queued") {
              sessionManager.appendCustomEntry(SUBAGENT_STATUS_TYPE, { version: 1, status: "queued" });
            }
            request.onUpdate?.({ ...stored.run, status: state });
            stored.run = { ...stored.run, status: state };
            dependencies.invalidateSessionList();
          },
          finishQueuedAbort,
        );
      } catch (error) {
        request.signal?.removeEventListener("abort", handleParentAbort);
        if (dropSubagentRun(initialRun.sessionId, stored)) dependencies.invalidateSessionList();
        throw error;
      }
      stored.cancelQueued = queued.cancel;
      // Synchronous update callbacks may abort before the listener/cancel hook exists.
      if (!runInBackground && request.signal?.aborted) stored.abortRequested = true;
      if (stored.abortRequested) stored.cancelQueued();
      void queued.promise.then(resolveCompletion, (error) => {
        if (dropSubagentRun(initialRun.sessionId, stored)) dependencies.invalidateSessionList();
        resolveCompletion({ ...initialRun, status: "failed", completedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) });
      });

      return { run: stored.run, completion: stored.completion };
    } catch (error) {
      if (isolatedWorktree) {
        try { await removeWorktree(parent.cwd, isolatedWorktree.path); } catch { /* preserve setup failure and avoid force deletion */ }
      }
      throw error;
    }
  }

  async function resume(request: ResumeSubagentRequest): Promise<SubagentExecution> {
    const enabled = dependencies.isBuiltInSubagentsEnabled ?? isBuiltInSubagentsEnabled;
    if (!enabled()) throw new Error("Pi Web built-in sub-agents are disabled");
    const parentSessionId = request.parentContext.sessionManager.getSessionId();
    const existing = await get(request.sessionId);
    if (!existing) throw new Error(`Subagent not found: ${request.sessionId}`);
    if (existing.parentSessionId !== parentSessionId) throw new Error("Subagent does not belong to this parent session");
    if (existing.status === "running" || existing.status === "queued") throw new Error("Subagent is already running");
    const parent = dependencies.getSession(parentSessionId);
    if (!parent?.isAlive()) throw new Error("Parent session is no longer available");
    const sessionPath = existing.sessionPath || await dependencies.resolveSessionPath(request.sessionId);
    if (!sessionPath) throw new Error(`Subagent session file not found: ${request.sessionId}`);
    let wrapper = dependencies.getSession(request.sessionId);
    if (!wrapper?.isAlive()) wrapper = await dependencies.reopenSession(request.sessionId, sessionPath);
    if (!wrapper.isAlive()) throw new Error("Subagent session is no longer available");
    if (wrapper.isRunning()) throw new Error("Subagent is already running");
    // The run prompts the SDK session directly, past the wrapper's `send()`, so refuse here as
    // `send()` does: an isolated child's worktree is removed when its run ends, and a run in the
    // missing folder would only let the model's tools fail (and `write` recreate it outside git).
    // The error reaches the model, so it also says what to do instead.
    if (!existsSync(wrapper.cwd)) throw new Error(`Directory does not exist: ${wrapper.cwd}. Start a new subagent instead.`);

    const runInBackground = request.runInBackground ?? existing.runInBackground;
    const initialRun: SubagentRunInfo = {
      ...existing,
      parentToolCallId: request.parentToolCallId,
      task: request.task,
      description: request.description.trim() || existing.description,
      runInBackground,
      status: "queued",
      completedAt: undefined,
      result: undefined,
      error: undefined,
      // Resume removes no worktree: this run's result says only whether it is still there.
      worktreeCleanupError: undefined,
      worktreeExists: undefined,
      resumed: true,
    };
    const manager = wrapper.inner.sessionManager;
    let resolveCompletion!: (run: SubagentRunInfo) => void;
    const completion = new Promise<SubagentRunInfo>((resolve) => { resolveCompletion = resolve; });
    const stored: StoredSubagentExecution = { run: initialRun, completion, abortRequested: !runInBackground && request.signal?.aborted === true, dispatchedAt: Date.now() };
    getSubagentRuns().set(request.sessionId, stored);
    request.onUpdate?.(initialRun);
    dependencies.invalidateSessionList();
    const handleParentAbort = () => {
      stored.abortRequested = true;
      if (stored.run.status === "queued") stored.cancelQueued?.();
      else void abortDelegated(wrapper, wrapper!.inner, stored);
    };
    if (!runInBackground) {
      if (request.signal?.aborted) handleParentAbort();
      else request.signal?.addEventListener("abort", handleParentAbort, { once: true });
    }

    const runToResult = async (): Promise<SubagentRunInfo> => {
      if (stored.abortRequested) {
        const result = recordResult(manager, { ...initialRun, status: "aborted", completedAt: new Date().toISOString() });
        stored.run = result;
        getSubagentRuns().delete(request.sessionId);
        resolveCompletion(result);
        return result;
      }
      stored.run = { ...stored.run, status: "running" };
      manager.appendCustomEntry(SUBAGENT_STATUS_TYPE, { version: 1, status: "running" });
      request.onUpdate?.(stored.run);
      // Entries present before this resume; scopes stop/text to this run's messages.
      const runStart = entryCount(manager);
      let result: SubagentRunInfo;
      try {
        throwIfSubagentCancelled(stored, runInBackground ? undefined : request.signal);
        await wrapper!.waitUntilReady();
        throwIfSubagentCancelled(stored, runInBackground ? undefined : request.signal);
        await promptDelegated(wrapper, wrapper!.inner, request.task, stored);
        const outcome = lastAssistantOutcome(manager, runStart);
        const text = outcome?.text;
        const aborted = stored.abortRequested || outcome?.aborted === true;
        const providerError = aborted ? undefined : outcome?.error;
        result = {
          ...initialRun,
          status: aborted ? "aborted" : providerError ? "failed" : "completed",
          completedAt: new Date().toISOString(),
          ...(text ? { result: text } : {}),
          ...(providerError ? { error: providerError } : {}),
        };
      } catch (error) {
        const text = lastAssistantOutcome(manager, runStart)?.text;
        result = {
          ...initialRun,
          status: stored.abortRequested || request.signal?.aborted || isAbortError(error) ? "aborted" : "failed",
          completedAt: new Date().toISOString(),
          ...(text ? { result: text } : {}),
          ...(!stored.abortRequested && !request.signal?.aborted && !isAbortError(error) ? { error: error instanceof Error ? error.message : String(error) } : {}),
        };
      } finally {
        request.signal?.removeEventListener("abort", handleParentAbort);
      }
      result = recordResult(manager, result);
      stored.run = result;
      request.onUpdate?.(result);
      getSubagentRuns().delete(request.sessionId);
      dependencies.invalidateSessionList();
      return result;
    };
    const execute = async (): Promise<SubagentRunInfo> => {
      try {
        return await runToResult();
      } finally {
        if (dropSubagentRun(request.sessionId, stored)) dependencies.invalidateSessionList();
      }
    };
    const finishQueuedAbort = () => {
      if (stored.run.status !== "queued") return;
      request.signal?.removeEventListener("abort", handleParentAbort);
      try {
        const result = recordResult(manager, { ...initialRun, status: "aborted", completedAt: new Date().toISOString() });
        stored.run = result;
        request.onUpdate?.(result);
        getSubagentRuns().delete(request.sessionId);
        dependencies.invalidateSessionList();
        resolveCompletion(result);
      } finally {
        if (dropSubagentRun(request.sessionId, stored)) dependencies.invalidateSessionList();
      }
    };
    let queued: ReturnType<SubagentQueue<SubagentRunInfo>["enqueue"]>;
    try {
      queued = getSubagentQueue().enqueue(parentSessionId, readSubagentSettings().maxConcurrent, execute, (state) => {
        if (state === "queued") manager.appendCustomEntry(SUBAGENT_STATUS_TYPE, { version: 1, status: "queued" });
        stored.run = { ...stored.run, status: state };
        request.onUpdate?.(stored.run);
        dependencies.invalidateSessionList();
      }, finishQueuedAbort);
    } catch (error) {
      request.signal?.removeEventListener("abort", handleParentAbort);
      if (dropSubagentRun(request.sessionId, stored)) dependencies.invalidateSessionList();
      throw error;
    }
    stored.cancelQueued = queued.cancel;
    // Synchronous callbacks may abort before the cancel hook exists.
    if (!runInBackground && request.signal?.aborted) stored.abortRequested = true;
    if (stored.abortRequested) queued.cancel();
    void queued.promise.then(resolveCompletion, (error) => {
      if (dropSubagentRun(request.sessionId, stored)) dependencies.invalidateSessionList();
      resolveCompletion({ ...initialRun, status: "failed", completedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) });
    });
    return { run: stored.run, completion };
  }

  async function get(sessionId: string): Promise<SubagentRunInfo | null> {
    const stored = getSubagentRuns().get(sessionId);
    if (stored) return stored.run;
    const wrapper = dependencies.getSession(sessionId);
    if (wrapper?.isAlive()) {
      const run = readSubagentRun(
        wrapper.inner.sessionManager.getEntries() as unknown as SessionEntry[],
        sessionId,
        wrapper.sessionFile,
      );
      if (run && wrapper.isRunning()) return { ...run, status: "running" };
      if (run) return settleOrphanedRun(run);
    }
    const sessionPath = await dependencies.resolveSessionPath(sessionId);
    if (!sessionPath) return null;
    const manager = SessionManager.open(sessionPath);
    const run = readSubagentRun(manager.getEntries() as unknown as SessionEntry[], sessionId, sessionPath);
    return run && settleOrphanedRun(run);
  }

  async function steer(sessionId: string, message: string): Promise<void> {
    const wrapper = dependencies.getSession(sessionId);
    if (!wrapper?.isAlive() || !wrapper.isRunning()) throw new Error("Subagent is not running");
    if (getSubagentRuns().get(sessionId)?.turnLimitReached) throw new Error("Subagent reached its turn limit and is stopping; resume it to continue");
    if (!message.trim()) throw new Error("Steering message is required");
    await wrapper.inner.steer(message.trim());
  }

  async function notifyParent(run: SubagentRunInfo): Promise<void> {
    const pending = { sessionId: run.sessionId, parentSessionId: run.parentSessionId, completedAt: run.completedAt, since: Date.now() };
    const notifications = getParentNotifications();
    notifications.add(pending);
    try {
      await deliverParentNotification(run, () => notifications.delete(pending));
    } finally {
      notifications.delete(pending);
    }
  }

  async function deliverParentNotification(run: SubagentRunInfo, onTurnStarted: () => void): Promise<void> {
    if (takeResultConsumed(run)) return;
    let parent = dependencies.getSession(run.parentSessionId);
    if (!parent?.isAlive()) {
      const sessionFile = await dependencies.resolveSessionPath(run.parentSessionId);
      if (!sessionFile) throw new Error(`Parent session not found: ${run.parentSessionId}`);
      parent = await dependencies.reopenSession(run.parentSessionId, sessionFile);
    }
    await parent.waitUntilReady();
    // The parent may still be inside the `get_subagent_result` call that collects this result,
    // and `deliverAs: "followUp"` would only queue the message until that turn ends anyway.
    // Hold the notification until the parent is idle and re-check the mark, so a result the
    // parent already consumed never triggers a duplicate turn.
    while (parent.isAlive() && parent.isRunning()) {
      if (takeResultConsumed(run)) return;
      await new Promise<void>((resolve) => { setTimeout(resolve, PARENT_IDLE_POLL_MS); });
    }
    if (takeResultConsumed(run)) return;
    if (!parent.isAlive()) throw new Error(`Parent session is no longer available: ${run.parentSessionId}`);
    const delivery = parent.inner.sendCustomMessage({
      customType: "pi-web:subagent-notification",
      content: subagentNotificationText(run),
      display: true,
      details: subagentToolDetails(run),
    }, { deliverAs: "followUp", triggerTurn: true });
    // pi starts the turn before its first await, and resolves only once that turn settled. From
    // here the parent's own run stands for this result: its end must not see the result as pending.
    if (parent.isRunning()) onTurnStarted();
    await delivery;
  }

  async function abort(sessionId: string): Promise<void> {
    const wrapper = dependencies.getSession(sessionId);
    const stored = getSubagentRuns().get(sessionId);
    if (stored?.run.status === "queued") {
      stored.abortRequested = true;
      if (!stored.cancelQueued?.()) throw new Error("Subagent is no longer queued");
      return;
    }
    // The controller owns a running slot while binding, before the SDK is streaming.
    if (!wrapper?.isAlive() || (!wrapper.isRunning() && stored?.run.status !== "running")) throw new Error("Subagent is not running");
    if (stored) stored.abortRequested = true;
    await abortDelegated(wrapper, wrapper.inner, stored);
  }

  function settleDirectTurn(sessionId: string, aborted: boolean, fromIndex = 0): void {
    // A run in the map records its own result, and a settled run keeps its report.
    if (getSubagentRuns().has(sessionId)) return;
    const wrapper = dependencies.getSession(sessionId);
    if (!wrapper?.isAlive()) return;
    const manager = wrapper.inner.sessionManager;
    const run = readSubagentRun(manager.getEntries() as unknown as SessionEntry[], sessionId, wrapper.sessionFile);
    if (!run || (run.status !== "running" && run.status !== "queued")) return;
    const stop = lastAssistantOutcome(manager, fromIndex);
    const text = stop?.text;
    recordResult(manager, {
      ...run,
      status: aborted || stop?.aborted ? "aborted" : stop?.error ? "failed" : "completed",
      completedAt: new Date().toISOString(),
      ...(text ? { result: text } : {}),
      ...(!aborted && stop?.error ? { error: stop.error } : {}),
    });
    dependencies.invalidateSessionList();
  }

  return {
    extensionRuntime: { start, resume, get, steer, notifyParent, markResultConsumed },
    get,
    steer,
    abort,
    settleDirectTurn,
  };
}
