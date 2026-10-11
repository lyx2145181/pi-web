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
  type SubagentMetadata,
  type SubagentProfile,
  type SubagentResultMetadata,
  type SubagentRunInfo,
} from "./subagents";
import type { SessionEntry } from "./types";
import { buildSubagentPromptPlan } from "./subagent-prompt";
import { createExactSystemPromptExtension } from "./exact-system-prompt";
import { appendSubagentInputFiles, loadSubagentInputFiles } from "./subagent-input";
import { getProjectTrustStatus, projectTrustReloadOptions } from "./project-trust";
import { createSubagentSessionServices } from "./subagent-resources";
import { subagentToolExclusions, subagentToolPolicy } from "./subagent-tool-policy";
import { resolveShellTools } from "./powershell-settings";
import { isBuiltInSubagentsEnabled, readSubagentSettings } from "./subagent-settings";
import { SubagentQueue } from "./subagent-queue";
import { addWorktree, removeWorktree } from "./worktree";
import { randomUUID } from "node:crypto";

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
}

type StoredSubagentExecution = {
  run: SubagentRunInfo;
  completion: Promise<SubagentRunInfo>;
  abortRequested: boolean;
  /** Set once the turn limit ends the run; later steering is refused instead of starting another turn. */
  turnLimitReached?: boolean;
  cancelQueued?: () => boolean;
  promptController?: AbortController;
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

declare global {
  var __piSubagentRuns: Map<string, StoredSubagentExecution> | undefined;
  var __piSubagentQueue: SubagentQueue<SubagentRunInfo> | undefined;
  var __piSubagentConsumedResults: Map<string, string> | undefined;
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

function getSubagentQueue(): SubagentQueue<SubagentRunInfo> {
  if (!globalThis.__piSubagentQueue) globalThis.__piSubagentQueue = new SubagentQueue();
  return globalThis.__piSubagentQueue;
}

type SubagentRunIdentity = Pick<SubagentRunInfo, "sessionId" | "completedAt">;

/**
 * Background runs whose terminal result the parent already collected with `get_subagent_result`,
 * keyed by subagent session ID and holding the collected run's `completedAt`. `resume` reruns
 * the same session ID, so the mark must name the run: a parent that polls *after* a run's
 * notification was delivered leaves a mark nothing consumes, and a bare session ID would let it
 * swallow the next run's notification (#987). `resume` deliberately does not clear the entry:
 * the parent can collect a run and resume it in the same turn while that run's notification is
 * still held, and the mark must keep suppressing it. Only background runs are recorded — a
 * foreground run never notifies — and each session holds at most one entry.
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
  return run.status === "running" || run.status === "queued" ? { ...run, status: "interrupted" } : run;
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

function parentContextText(parent: HostSession): string {
  const messages = parent.inner.sessionManager.buildSessionContext().messages;
  const serialized = JSON.stringify(messages);
  if (serialized.length <= SUBAGENT_CONTEXT_LIMIT) return serialized;
  return `${serialized.slice(0, SUBAGENT_CONTEXT_LIMIT)}\n[Parent context truncated]`;
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

      // Resolve before creating child resources; an unavailable selected model must not leave an orphan.
      const parentModelRuntime = (parent.inner as unknown as { modelRuntime: ModelRuntime }).modelRuntime;
      const requestedModel = resolveSubagentModel(parentModelRuntime, profile, request.model);

      const runInBackground = request.runInBackground ?? profile.runInBackground;
      const isolation = profile.isolation === "off" ? undefined : request.isolation ?? profile.isolation;
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
      // D3 priority: an explicit call level wins, then the profile's own `thinking`, then the
      // chosen model's `:level` suffix, then the parent's level. A protected profile already
      // ignored the call's model (and its suffix) above.
      const thinking = request.thinking ?? profile.thinking ?? requestedModel?.thinkingLevel ?? parent.inner.agent.state?.thinkingLevel;
      if (thinking && !THINKING_LEVELS.has(thinking as ThinkingLevel)) {
        throw new Error(`Invalid subagent thinking level: ${thinking}`);
      }

      const agentDir = getAgentDir();
      const settingsManager = SettingsManager.create(childCwd, agentDir, { projectTrusted: getProjectTrustStatus(childCwd, agentDir).trusted });
      const inheritedParentContext = inheritContext
        ? `The following is the active conversation context from the parent session. Use it only as background for the delegated task:\n${parentContextText(parent)}`
        : undefined;
      const inputFiles = loadSubagentInputFiles(parent.cwd, request.inputFiles ?? []);
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
      }, { ...profile, builtinTools, toolPolicy });

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
      };
      getSubagentRuns().set(initialRun.sessionId, stored);
      request.onUpdate?.(initialRun);
      dependencies.invalidateSessionList();

      const handleParentAbort = () => {
        stored.abortRequested = true;
        if (stored.run.status === "queued") stored.cancelQueued?.();
        else void abortDelegated(dependencies.getSession(inner.sessionId), inner, stored);
      };
      if (!runInBackground) request.signal?.addEventListener("abort", handleParentAbort, { once: true });

      const execute = async (): Promise<SubagentRunInfo> => {
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
        const persisted: SubagentResultMetadata = {
          version: 1,
          status: result.status as SubagentResultMetadata["status"],
          completedAt: result.completedAt!,
          ...(result.result ? { result: result.result } : {}),
          ...(result.error ? { error: result.error } : {}),
          ...(result.worktreeCleanupError ? { worktreeCleanupError: result.worktreeCleanupError } : {}),
        };
        sessionManager.appendCustomEntry(SUBAGENT_RESULT_TYPE, persisted);
        stored.run = result;
        request.onUpdate?.(result);
        getSubagentRuns().delete(initialRun.sessionId);
        dependencies.invalidateSessionList();
        return result;
      };

      const finishQueuedAbort = async () => {
        if (stored.run.status !== "queued") return;
        request.signal?.removeEventListener("abort", handleParentAbort);
        const result: SubagentRunInfo = { ...initialRun, status: "aborted", completedAt: new Date().toISOString() };
        const cleanupError = await cleanupWorktree(parent.cwd, isolatedWorktree);
        const finalResult = cleanupError ? { ...result, worktreeCleanupError: cleanupError } : result;
        sessionManager.appendCustomEntry(SUBAGENT_RESULT_TYPE, { version: 1, status: "aborted", completedAt: finalResult.completedAt, ...(cleanupError ? { worktreeCleanupError: cleanupError } : {}) });
        stored.run = finalResult;
        request.onUpdate?.(finalResult);
        getSubagentRuns().delete(initialRun.sessionId);
        dependencies.invalidateSessionList();
        resolveCompletion(finalResult);
      };
      const queued = getSubagentQueue().enqueue(
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
      stored.cancelQueued = queued.cancel;
      // Synchronous update callbacks may abort before the listener/cancel hook exists.
      if (!runInBackground && request.signal?.aborted) stored.abortRequested = true;
      if (stored.abortRequested) stored.cancelQueued();
      void queued.promise.then(resolveCompletion, (error) => {
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
      resumed: true,
    };
    const manager = wrapper.inner.sessionManager;
    let resolveCompletion!: (run: SubagentRunInfo) => void;
    const completion = new Promise<SubagentRunInfo>((resolve) => { resolveCompletion = resolve; });
    const stored: StoredSubagentExecution = { run: initialRun, completion, abortRequested: !runInBackground && request.signal?.aborted === true };
    getSubagentRuns().set(request.sessionId, stored);
    request.onUpdate?.(initialRun);
    dependencies.invalidateSessionList();
    const handleParentAbort = () => {
      stored.abortRequested = true;
      if (stored.run.status === "queued") stored.cancelQueued?.();
      else void abortDelegated(wrapper, wrapper!.inner, stored);
    };
    if (!runInBackground) request.signal?.addEventListener("abort", handleParentAbort, { once: true });

    const execute = async (): Promise<SubagentRunInfo> => {
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
      manager.appendCustomEntry(SUBAGENT_RESULT_TYPE, {
        version: 1,
        status: result.status as "completed" | "failed" | "aborted",
        completedAt: result.completedAt!,
        ...(result.result ? { result: result.result } : {}),
        ...(result.error ? { error: result.error } : {}),
      });
      stored.run = result;
      request.onUpdate?.(result);
      getSubagentRuns().delete(request.sessionId);
      dependencies.invalidateSessionList();
      return result;
    };
    const finishQueuedAbort = () => {
      if (stored.run.status !== "queued") return;
      request.signal?.removeEventListener("abort", handleParentAbort);
      const result: SubagentRunInfo = { ...initialRun, status: "aborted", completedAt: new Date().toISOString() };
      manager.appendCustomEntry(SUBAGENT_RESULT_TYPE, { version: 1, status: "aborted", completedAt: result.completedAt });
      stored.run = result;
      request.onUpdate?.(result);
      getSubagentRuns().delete(request.sessionId);
      dependencies.invalidateSessionList();
      resolveCompletion(result);
    };
    const queued = getSubagentQueue().enqueue(parentSessionId, readSubagentSettings().maxConcurrent, execute, (state) => {
      if (state === "queued") manager.appendCustomEntry(SUBAGENT_STATUS_TYPE, { version: 1, status: "queued" });
      stored.run = { ...stored.run, status: state };
      request.onUpdate?.(stored.run);
      dependencies.invalidateSessionList();
    }, finishQueuedAbort);
    stored.cancelQueued = queued.cancel;
    // Synchronous update callbacks may abort before the listener/cancel hook exists.
    if (!runInBackground && request.signal?.aborted) stored.abortRequested = true;
    if (stored.abortRequested) stored.cancelQueued();
    void queued.promise.then(resolveCompletion, (error) => resolveCompletion({ ...initialRun, status: "failed", completedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) }));
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
    await parent.inner.sendCustomMessage({
      customType: "pi-web:subagent-notification",
      content: subagentNotificationText(run),
      display: true,
      details: subagentToolDetails(run),
    }, { deliverAs: "followUp", triggerTurn: true });
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

  return {
    extensionRuntime: { start, resume, get, steer, notifyParent, markResultConsumed },
    get,
    steer,
    abort,
  };
}
