# Pi Web - Development Notes

## Quick Start

```bash
npm run dev   # port 30141, listens on 0.0.0.0; use npm run dev:local for loopback only
```

- Typecheck: `node_modules/.bin/tsc --noEmit`
- Lint: `npm run lint`
- Synthetic session-list baseline: `npm run perf:sessions` (use `-- --dir <path>` for an explicit read-only session directory)
- Browser interaction baseline: `npm run perf:browser` (requires the dev server and local `google-chrome`; repeat `-- --file-label <root-file>` for sanitized Viewer open/switch/cache measurements)

**Never run `next build` during dev** — pollutes `.next/` and breaks `npm run dev`.

## Personal Fork Update Workflow

This fork keeps upstream code and personal UI changes separated:

- `upstream`: `https://github.com/agegr/pi-web.git`
- `origin`: `https://github.com/lyx2145181/pi-web.git`
- `main`: clean mirror of `upstream/main`; do not add personal changes here
- `ui-custom`: working branch containing personal UI changes

Run updates only from a clean worktree:

```bash
git fetch upstream
git switch main
git merge --ff-only upstream/main
git push origin main

git switch ui-custom
git merge --no-commit main
# Resolve conflicts, preserving UI customization while retaining upstream features.
# Do not choose --ours or --theirs for an entire conflicted UI file.
npm ci                         # when package-lock.json changed
node_modules/.bin/tsc --noEmit
npm run lint
git commit -m "merge(upstream): 同步原作者最新版本"
git push origin ui-custom
```

If conflict resolution is uncertain, stop with `git merge --abort` rather than discarding either side. Never push personal changes to `upstream`.

### Dev server troubleshooting

- Before starting a server, run `lsof -nP -iTCP:30141 -sTCP:LISTEN` and reuse the existing Pi Web process when it is healthy. A second `next dev` for the same checkout cannot use a different port as a workaround because both processes contend for `.next/dev/lock`.
- A browser-only `Module ... factory is not available` overlay usually means that tab has a stale Turbopack/HMR graph; it does not prove the server or source is broken. First call the browser's explicit reload action, then compare the current server log and a direct HTTP/API request.
- Restart only after the failure reproduces from a fresh page and the server-side checks also fail. Stop the exact dev process gracefully, move `.next` into a `mktemp -d` backup, and restart with the standard `npm run dev` command.
- Do not use `next dev --webpack` as a fallback. This repository's development graph can fail on `undici` imports such as `node:console`; development is expected to use Turbopack.
- Next.js may append a generated `BEGIN:nextjs-agent-rules` block to `AGENTS.md` when `next dev` starts. Treat that as generated tooling output, verify it with `git status`, and do not include it in an unrelated feature commit.

---

## Architecture

```
Browser                Next.js Server              AgentSession (in-process)
  │                        │                               │
  ├─ GET /api/sessions ────▶ reads ~/.pi/agent/sessions/   │
  ├─ GET /api/sessions/[id] reads .jsonl file directly     │
  ├─ GET /api/agent/running ───────▶ running id snapshot   │
  │                        │                               │
  ├─ send message ─────────▶ POST /api/agent/[id]          │
  │                        │   startRpcSession() ─────────▶│ createAgentSession()
  │                        │   session.send(cmd) ─────────▶│ session.prompt()
  │                        │                               │
  ├─ SSE connect ──────────▶ GET /api/agent/[id]/events    │
  │                        │   session.onEvent() ◀─────────│ session.subscribe()
  │◀── data: {...} ─────────│                               │
```

**Session browsing** (read-only): the session list uses Pi Web's fingerprinted derived index; session detail/context still reads `.jsonl` through SDK `SessionManager` helpers and `lib/session-reader.ts` — no AgentSession created.
**Sending a message**: `startRpcSession()` in `lib/rpc-manager.ts` creates an AgentSession in-process.

---

## File Map

```
app/api/
  sessions/route.ts               GET  list all sessions
  sessions/[id]/route.ts          GET/PATCH/DELETE session
  sessions/[id]/meta/route.ts     GET lightweight verified indexed metadata for one session
  sessions/[id]/context/route.ts  GET ?leafId= — context for a specific leaf
  sessions/[id]/export/route.ts   GET exported HTML for a session
  session-order/route.ts          GET/PUT project-scoped pinned session order
  agent/new/route.ts              POST { cwd, message, toolNames?, toolPolicy?, skillNames?, skillPolicy?, provider?, modelId? }
  agent/[id]/route.ts             GET state | POST any command
  agent/[id]/events/route.ts      GET SSE stream
  agent/running/route.ts          GET currently-running session ids
  auth/api-key/[provider]/route.ts POST/DELETE provider API key storage
  auth/login/[provider]/route.ts  GET OAuth/device-code SSE | POST manual code
  auth/logout/[provider]/route.ts POST OAuth logout
  auth/providers/route.ts         GET OAuth and API-key provider lists
  cwd/validate/route.ts           POST validate/select a cwd
  default-cwd/route.ts            POST create ~/pi-cwd-YYYYMMDD
  files/[...path]/route.ts        GET viewer/list content; POST uploads and batched directory versions
  home/route.ts                   GET user home directory
  models/route.ts                 GET { models, modelList, defaultModel }
  models/enabled/route.ts         GET/PUT enabledModels switches for the Models panel
  models/refresh/route.ts         POST fetch provider catalogs from pi.dev on demand
  models-config/route.ts          GET/PUT — read/write ~/.pi/agent/models.json
  models-config/catalog/route.ts  GET models.dev pricing presets
  models-config/discover/route.ts POST fetch a configured provider's upstream model list
  models-config/test/route.ts     POST test a configured model/provider
  plugins/route.ts                GET/POST package plugin management
  skills/route.ts                 GET/PATCH loaded skills and disable-model-invocation
  skills/install/route.ts         POST install skills through npx skills add
  skills/search/route.ts          GET/POST skills.sh search
  subagents/settings/route.ts     GET/PUT built-in subagent feature setting
  worktrees/route.ts              GET/POST/DELETE git worktrees

bin/
  process-lifecycle.js forwards shutdown signals to the spawned Next.js child
  pi-web-node-args.js adds the RISC-V Wasm startup flag without changing other platforms

instrumentation.ts / instrumentation-node.ts
  keep Node-only HTTP/SSE shutdown hooks out of the Edge instrumentation graph

scripts/
  interaction-browser-baseline.mjs measures local navigation, ordinary/rapid session switching, paged history loading, Viewer and Explorer refresh interactions, API request counts, and browser long tasks through a temporary headless Chrome profile
  session-list-baseline.mjs generates a temporary session corpus or reads an explicit directory and compares SDK scan/parse with index cold-build and warm-fingerprint P50/P95

lib/
  agent-client.ts      typed fetch helper for /api/agent commands
  auth-throttle.ts     process-wide backoff for failed web-password attempts
  agent-event-wire.ts  filters/projects SDK events into SSE-safe client deltas
  agent-session-services.ts serialized extension-aware SDK service creation
  draft-store.ts       local draft persistence helpers
  document-preview-cache.ts bounded, version-keyed DOCX conversion cache
  file-access.ts       allowed file roots for /api/files and worktrees
  file-paths.ts        client/server path encoding helpers
  enabled-models.ts    pure minimal-edit engine for the `enabledModels` pattern list
  enabled-models-runtime.ts  SDK adapter: per-pattern resolution, provider kinds, settings IO
  file-version.ts      opaque file identity, ETag, Last-Modified, and conditional request helpers
  git-changes.ts       bounded checkout/CWD status snapshots and on-demand file diff helpers
  git-process.ts       shared bounded-concurrency Git subprocess runner
  markdown.ts          shared markdown helpers
  model-runtime.ts     runtime adapter for provider models and auth capabilities
  node-cli.ts          locate npm/npx CLI scripts for shell-free child processes
  npx.ts               npx runner used by skill install
  pi-types.ts          local structural types for pi SDK objects
  project-command-env.ts sanitized built-in project shell operations
  project-groups.ts    stable-key project grouping and activity aggregation
  project-identity.ts  platform-aware internal project identity
  provider-usage.ts    provider quota/usage lookup helpers
  rpc-manager.ts      AgentSessionWrapper + registry + startRpcSession
  server-timing.ts    request-local, non-sensitive Server-Timing metric collector
  session-context-page.ts bounded tail/earlier context paging plus full-context stats/history summaries
  session-detail-cache.ts bounded fingerprint-keyed read-only SessionManager snapshot LRU
  session-index*.ts/mts derived metadata index, worker coordination, and private persistence
  session-reader.ts   indexed listing + SessionManager detail wrappers + path/context adapters
  session-order*.ts   pinned-session ordering helpers + private preference persistence
  streaming-message.ts reconstructs streamed assistant blocks and tool-call arguments
  tool-execution-progress.ts extracts bounded progress text from partial tool results
  subagent-settings.ts  read/write ~/.pi/agent/agents/settings.json
  tool-presets.ts     PRESET_NONE/READ_ONLY/DEFAULT/FULL + getPresetFromTools()
  tool-preset-preference.ts  browser-persisted default for fresh sessions
  types.ts            shared TypeScript types
  normalize.ts        normalizeToolCalls() — field name mismatch between file format and our types
  worktree.ts         project/worktree resolution and git worktree operations

components/
  AppShell.tsx        layout + URL state + tab management
  SessionSidebar.tsx  session tree + FileExplorer
  ChatWindow.tsx      chat composition + completion sound wrapper
  ChatInput.tsx       input bar + model/thinking/tools/compact controls
  MessageView.tsx     renders one message (user/assistant/toolCall/toolResult)
  BranchNavigator.tsx in-session branch switcher
  ChatMinimap.tsx     scroll minimap alongside the message list
  ExtensionStatusBar.tsx compact shelf for extension statuses and widgets
  ExtensionWidgets.tsx renders extension-provided widget content
  MarkdownBody.tsx    markdown renderer
  ModelsConfig.tsx    modal for editing models.json (opened from sidebar bottom)
  EnabledModelsSection.tsx  model switches inside ModelsConfig, backed by enabledModels
  AgentsConfig.tsx    built-in subagent toggle + agent profile editor
  PluginsConfig.tsx   modal for installed package plugins
  SkillsConfig.tsx    modal for loaded/search/installable skills
  FileExplorer.tsx    file tree inside sidebar
  FileIcons.tsx       file icon helpers
  FileViewer.tsx      file content in a tab
  file-content-cache.ts bounded authorization-context-aware text content LRU
  TabBar.tsx          tab bar (Chat + open file tabs)

hooks/
  useAgentSession.ts  messages + streaming + SSE + fork/navigate/reconciliation logic
  useAudio.ts         completion sound + browser AudioContext unlock
  useDragDrop.ts      shared drag/drop state
  useIsMobile.ts      responsive breakpoint hook
  useTheme.ts         theme state
```

---

## Key Design Decisions & Traps

### AgentSession lifecycle (`lib/rpc-manager.ts`)
- One `AgentSessionWrapper` per session id, keyed in `globalThis.__piSessions`
- `globalThis` survives Next.js hot-reload; plain module-level Map does not
- Idle timeout defaults to 10 minutes and is configurable through `PI_WEB_IDLE_TIMEOUT_MS` (`0` disables it). Normal expiry preserves work advertised by the synchronous session-liveness registry and by the public `pi-subagents` event-bus RPC snapshot; provider/probe failures are conservative. An explicit Stop may force cleanup of a run stuck active despite those providers. Async probe results are generation-checked so an old deadline cannot close a refreshed wrapper. Concurrent `startRpcSession()` calls share a single start Promise (`globalThis.__piStartLocks`).
- The package launcher forwards `SIGINT`/`SIGTERM` to the spawned Next.js child, force-kills only after a 5-second grace period or a repeated signal, and propagates the child's final exit status (`bin/process-lifecycle.js`).
- All Pi Web extension-factory evaluation goes through `lib/agent-session-services.ts`, which serializes extension loading so service discovery cannot race session startup. Service-only loads are marked transient: they preserve an unchanged active `pi-chrome` singleton, never revive one removed by concurrent session shutdown, and release any singleton they acquire because they never receive `session_shutdown`. Endpoints that do not need extensions must avoid evaluating them entirely: `lib/skills-service.ts` creates `DefaultResourceLoader` with `noExtensions: true` because static skill enumeration has no session lifecycle for `resources_discover` or `session_shutdown`. Otherwise `/chrome` and `chrome_*` tools can disappear from the next real session.

### Replacing forks must retire the source wrapper
`AgentSession.fork()` mutates its session state in place, so a registry wrapper must never remain under the old id after a replacing fork. Pi Web creates the child through a separate `SessionManager`, records the child path, then gracefully shuts down the source wrapper before returning its id; reopening the original creates clean state. `fork_branch` is different: it copies the selected assistant branch without replacing or shutting down the source wrapper.

### Two kinds of branching — don't confuse them
- **Fork** ("New session" on user message): creates a new independent `.jsonl` file. Shown as a child in the sidebar tree via `parentSession` header field.
- **In-session branch** ("Edit from here" / BranchNavigator): calls `navigate_tree` within the same file. Multiple entries share the same `parentId`. Switching between them calls `/api/sessions/[id]/context?leafId=`.

### Session files can be fully rewritten
`parentSession` in the header is **display metadata only** — has zero effect on chat content. Safe to `writeFileSync` the entire file (pi does this itself during migrations). Used when cascade-reparenting children on delete.

### ToolCall normalization and streaming
Pi stores toolCall blocks as `{type:"toolCall", id, name, arguments}` but `ToolCallContent` uses `{toolCallId, toolName, input}`. `normalizeToolCalls()` in `lib/normalize.ts` handles persisted and completed messages in `session-reader.ts` and `useAgentSession.ts`.

For in-flight assistant messages, `lib/agent-event-wire.ts` removes heavy partial snapshots while preserving streamed tool-call identity, and `lib/streaming-message.ts` immutably reconstructs text, thinking, and tool-call argument deltas. Reconnect snapshots use `normalizeStreamingToolCalls()` to preserve temporary raw tool input; the authoritative `toolcall_end` replaces that scratch data with parsed arguments. `tool_execution_update` events keep their partial result on the SSE wire; `lib/tool-execution-progress.ts` extracts the latest bounded text line so `ChatWindow` can show live tool progress.

### New session tool preset
Tool names are passed at session creation (`POST /api/agent/new` -> `toolNames[]`) and persisted in versioned `pi-web:tool-selection` custom entries. No entry means a legacy session and keeps Pi's default behavior; an empty array means Chat only. Version 1 entries restore as extension-inclusive selections; version 2 persists both `inclusive` or `exact` mode and the complete selected tool list. Omitting `toolPolicy` keeps the normal extension-inclusive behavior. New sessions may opt into `toolPolicy: "exact"`. Because extensions may register tools lazily from `session_start`, Pi Web activates the currently registered subset before binding, then validates and activates the complete requested built-in and extension tool set before startup returns or a prompt is accepted; reload follows the same pre-binding-subset and post-binding-validation sequence. Unknown or no-longer-registered exact names fail startup. Chat only resolves before services are created, loads no extensions/skills/prompts/themes, and replaces Pi's base prompt with the ordered contents of Pi's discovered context files. Crossing the Chat-only boundary rebuilds the wrapper; changing between nonempty presets updates it in place.

**Exact system prompts go through `before_agent_start`.** Since pi 0.86 the prompt lives in the transcript: `agent.state.systemPrompt` is a getter replayed from persisted system messages (assigning it throws), and the agent loop's request context has no `systemPrompt` field, so neither mutating the state nor patching `prepareNextTurnWithContext` reaches the model. Chat-only sessions and subagent profiles in replace mode register `lib/exact-system-prompt.ts` as an inline extension factory on the resource loader; its `before_agent_start` handler returns `{ systemPrompt }`, which the SDK projects as the provider's leading system prompt for the whole run while the transcript keeps recording Pi's structured sections. `get_state.systemPrompt` reports the exact prompt for those wrappers because the SDK state only shows the structured sections. Subagents persist their active tools plus profile-level skill and extension loading switches in `resourceSnapshot`; loaded extensions cannot expose the reserved `Agent`, `get_subagent_result`, or `steer_subagent` tools to a subagent. See `docs/adr/0002-chat-only-tool-selection.md`.

The last preset explicitly selected by the user is stored in browser `localStorage` and initializes fresh-session composers only. Existing sessions never trust that preference; they use their live `get_tools` state or pi's default when no wrapper exists.

### Exact skill selection
Normal user sessions keep Pi's inclusive skill discovery unless creation explicitly supplies `skillPolicy: "exact"` with `skillNames`. Exact mode filters the discovered catalog before system-prompt and slash-command construction, persists in `pi-web:skill-selection`, survives reload/reopen, and fails startup for unknown or removed names. An empty exact list exposes no skills. `get_skills` and session detail expose the effective contract for launcher verification. This is not a file-access boundary: tool policy still governs whether a model can read arbitrary skill paths.

### Model defaults for new sessions
`GET /api/models` returns `defaultModel` read from `~/.pi/agent/settings.json`. `ChatWindow` pre-selects this on mount for new sessions. Explicit browser model/thinking selections are applied atomically during AgentSession construction, then `lib/startup-preferences.ts` persists their effective values without replaying `set_model`/`set_thinking_level`; implicit `enabledModels` fallbacks and thinking pins are not persisted.

### Remote provider catalogs
pi's built-in model lists are generated when the SDK is built and pi-web pins one SDK version, so a model a provider ships after that release is invisible until pi-web publishes a new version (#914). The SDK carries the other half: each built-in provider is wrapped in a pi.dev catalog overlay that `ModelRuntime.refresh()` fetches and persists to `~/.pi/agent/models-store.json`, and restoring that overlay needs no network. Both of pi-web's refresh paths ask for the offline half only (`createAgentSessionServices()` and `lib/provider-usage.ts` pass `allowNetwork: false`), which is why running the pi CLI once used to be the fix — the CLI refreshed with the network on and pi-web read what it left behind.

`lib/model-catalog-refresh.ts` runs that network pass, and **only when the user asks for it**: the "Refresh catalog" button in `EnabledModelsSection` posts to `/api/models/refresh`. Nothing refreshes catalogs on a timer or on another request's path — a pass fetches a catalog per authenticated provider, and a save must not wait on a slow one, the same reason `/api/auth/api-key/[provider]` stores the credential itself instead of calling `ModelRuntime.login()`. `refresh()` is called with `force: true`, since pressing the button is exactly a request to skip the SDK's four-hour freshness window, but *without* `allowNetwork`, so the runtime keeps applying its own `PI_OFFLINE` rule instead of pi-web overriding it; the module reports `reason: "offline"` rather than pretending a pass ran. `shareModelCatalogRefresh()` joins concurrent presses for the same providers so two tabs cannot race over the store file.

Change detection compares the model ids and names the runtime exposes, never the stored bytes: a successful revalidation rewrites `checkedAt` and `etag` on every pass. It only decides whether `invalidateModelsCache()` runs and whether the panel reloads — the overlay itself reaches the UI through the ordinary `/api/models` and `/api/models/enabled` loads, which build a fresh runtime that restores the store, so the refresh route never returns a model list of its own.

### `enabledModels` scoping
The `enabledModels` setting uses pi's `--models` syntax: minimatch globs against `provider/modelId` or a bare `modelId`, fuzzy matching for non-glob patterns, and an optional `:thinkingLevel` suffix. Never compare those patterns as literal strings — `lib/model-scope.ts` delegates to the SDK's `resolveModelScopeWithDiagnostics()` so pi-web and the TUI agree on the visible model list, and falls back to all available models when patterns resolve to nothing. A non-glob entry that exactly matches the same bare model id from multiple providers is rejected as ambiguous; use `provider/modelId`. `startRpcSession()` resolves that scope before creating an AgentSession and passes the selected initial model, thinking pin, and SDK-native `scopedModels` atomically; `GET /api/models` reuses the helper only for selector data, `thinkingLevelPins`, and `modelScopeWarnings` display.

### Extension widgets and status bar
`ChatWindow` renders extension statuses and widgets together through `ExtensionStatusBar`; do not restore separate above/below-editor widget bands. The compact shelf owns widget expansion, truncation, and status-line presentation.

Editing that setting from the Models panel goes through `/api/models/enabled`, never through pattern strings composed in the browser. Each toggle is a **minimal edit** of the stored list (`lib/enabled-models.ts`): a pattern that matches no available model is preserved verbatim, only the pattern covering the switched-off model is expanded in place (keeping its `:level` suffix), and every provider that ends up fully enabled with two or more entries collapses back into one glob — pi refreshes provider catalogs from the network into `models-store.json`, so an enumerated list rots when a model is renamed (deepseek's `deepseek-v4-flash` became `deepseek-flash`), while a glob heals itself. A lone exact reference is a deliberate pick and is left alone. **Never assume `provider/*` covers a provider**: pi matches with minimatch, whose `*` stops at `/`, so that glob silently misses every nested model id (`commandcode/sakana/fugu-ultra`, most OpenRouter ids) — writing it turned "enable all" into 15 of 71 models. `resolveProviderGlobs()` resolves `provider/*` then `provider/**` and keeps one only when its match set is exactly the provider's models; a provider that neither covers is written model by model. Also never rewrite the whole list from `getAvailable()` the way the TUI's `/scoped-models` does — it only sees providers that currently pass `checkAuth()`, so that would delete every entry for a provider whose credential is missing right now, and flatten globs and pins.

Disabling the last enabled model is refused with `409 { reason: "last-model" }`: pi falls back to every model when a scope resolves to nothing, so an empty list silently means the opposite. Writes always target the global settings file; a project `.pi/settings.json` replaces the global array instead of merging, so the route reports `scope: "project"`, renders the switches read-only, and returns that file's path as `settingsPath` — the banner names the file it just wrote (`~/.pi/agent/settings.json · enabledModels 20/104`) instead of describing the effect in prose. Built-in *and* extension-registered providers get per-model switches; models.json providers are switched as a whole by `EnabledModelsProviderSwitch` in their detail header, next to Delete, because a custom model can simply be deleted and both bulk buttons only ever sent the same provider-wide write. That switch is on only when every model of the provider is on, so a partial selection reads as off beside the sidebar's `1/2` badge and one click completes it; reading it as "any enabled" would leave partial unreachable in both directions once the last-model guard blocks the way down. Why it cannot move is its tooltip, not body text. `op: "prune"` is the only operation that drops unmatched entries, for cleaning up after such a rename; everything else preserves them. Saving models.json re-reads the switches through `op: "resync"`, which repairs the stored patterns against the new catalog: it rewrites renamed **models** and then renamed **providers**, **cuts back entries whose provider prefix no longer scopes them**, and re-asserts the providers that were fully enabled before the save. (Model references first: they still spell the old provider id, which the provider rewrite would otherwise have replaced already.) All three are needed because a pattern's meaning depends on the catalog. pi matches a pattern against the bare `modelId` as well as `provider/modelId`, so `stepfun/*` also matches another provider's model whose id *is* `stepfun/Step-5-Preview` — renaming a provider to `stepfun` silently enabled three `commandcode` models, and switching stepfun off then wrote them into the file. In the other direction, renaming a model to an id with a slash drops it out of `provider/*` (minimatch `*` stops at `/`), so a fully enabled provider silently loses it. A model renamed in the panel is a known move, not the kind of mismatch worth preserving: leaving `stepfun/ddd` behind after it became `stepfun/ddd1` loses the selection, and when it was the only entry the scope resolves to nothing, which pi reads as "no scope" and quietly enables every model. `ModelsConfig` mirrors every array move of the draft in `savedModelIdsRef` so `collectModelRenames()` can tell a rename from an add or a delete without guessing. Only `resync` repairs entries; ordinary toggles stay minimal edits and never rewrite what the user did not touch. A models.json provider missing from the runtime (unsaved edits, no models, a key that does not work) must not be reported as a sign-in problem, which is why it has its own control: the switch renders disabled with that reason as its tooltip, while `EnabledModelsSection` — now built-in only — keeps the sign-in empty state. See `docs/adr/0004-enabled-models-toggles.md`.

### SSE reconnect on page refresh mid-stream
On `ChatWindow` mount, `GET /api/agent/[id]` is called. If `state.isStreaming === true`, SSE is reconnected automatically. `thinkingLevel` and `isCompacting` are also synced from this response.

### Compaction SSE events
Newer pi emits `compaction_start` / `compaction_end`; older versions emitted `auto_compaction_start` / `auto_compaction_end`. `handleAgentEvent` accepts both sets to keep `isCompacting` in sync. Manual compact is a blocking POST — the button stays disabled until the response returns.

### Transcript system messages, usage entries and context edits (pi >= 0.86)
- Every new session's first request persists a `message` entry with `role: "system"` holding the prompt sections and tool declarations; later prompt or tool changes append more. The agent loop announces them with `message_start` / `message_end` like any message. They are provider input, never conversation: `toClientAgentEvent()` drops them before the SSE stream (they carry every tool schema), `handleAgentEvent` skips any that slip through, `entryToUiMessage()` returns null for them, and `BranchNavigator` / `lib/project-tree.ts` never label or preview a branch with one. They still count toward `messageCount` and `totalMessages`, exactly as the SDK counts them.
- `usage` entries (`kind: "cache_warm"`) record prompt-cache warming that is billed but never enters model context. `computeSessionStats()` adds them like compaction usage so the token/cost counters match `/session` in the TUI.
- `context_edit` entries omit or replace an earlier entry's model context without changing raw history; the UI ignores them. A retain-none compaction stores its own id in `firstKeptEntryId`.
- `SessionManager.listAll()` now reads files newest-mtime first (then reverse filename) so `--resume` can render progressively; its stable sort keeps that order for sessions with equal activity time, and `listSessionsIncremental()` reproduces it from the stat fingerprints it already keeps.

### Running state polling + reconciliation
- The sidebar polls `/api/agent/running` every 2.5 seconds while the tab is visible and pauses polling in background tabs. The session-list response remains the initial fallback. This lightweight endpoint schedules coalesced, at-most-once-per-30-second index verification without awaiting disk work; accepted fingerprint changes invalidate the list cache and advance its version, including changes made by external Pi processes. Failed or superseded verification must not publish a change or imply deletion.
- `invalidateSessionListCache()` bumps the generation but **keeps** the previous scan, and the cache is fresh only while its recorded generation matches. Ordinary agent activity invalidates it constantly, and rebuilding costs hundreds of milliseconds because `loadAllSessions()` re-reads every forked and subagent session. Callers that only need metadata — mapping search hits to sidebar rows — pass `listAllSessions({ allowStale: true })` to read the previous scan and let the rebuild happen in the background. A stale scan is a complete catalogue apart from sessions created seconds ago, so those callers accept a brief window where a brand-new session is not yet listed.
- `useAgentSession` treats per-session SSE as primary for chat events and opens it before each prompt. `prompt_done` completes the current UI stage and notification immediately, but the idle SSE stays open for a 30-second grace window and is reused by the next prompt. `agent_start` cancels that close timer; `agent_settled` finishes extension-injected runs that have no wrapper-level `prompt_done` and starts a fresh grace window. Do not close on the first `agent_end`: retries, compaction, and extension-queued messages can continue the same logical prompt.
- While a run is active, `useAgentSession` periodically calls `GET /api/agent/[id]` and also reconciles on `visibilitychange`/`online`. This fixes missed terminal events from background tabs or half-open connections.
- Prompt runs use a monotonic run id; late SSE or slow reconciliation responses from an old run must be ignored so they cannot resurrect stale streaming bubbles.
- Every SSE (re)connection in `useAgentSession` is gated on `sessionHookMountedRef`. React Strict Mode (on by default in `next dev`) re-runs effects in declaration order after a simulated unmount: the mount-only effect's cleanup sets that ref to `false`, and it is only restored when that effect re-runs, *after* the warm-session effect. The warm-session effect therefore re-asserts the ref before `maintainEventsConnected()`. Without it a dev-server tab never opened the event stream on mount or when switching back to a running session, so streamed output and new messages stayed invisible until the 15-second reconcile poll or a page refresh (`next start` was unaffected).

### Worktrees and project grouping
- `lib/worktree.ts` resolves linked worktree top-levels back to the main repo `projectRoot`; `listAllSessions()` attaches both that display/filesystem path and a stable server-computed `projectKey` to each `SessionInfo` so all worktrees for one repo are grouped together in the sidebar.
- Grouping and equality use `projectKey` through `workspaceKeyOf()` / `lib/project-groups.ts`; keep `projectRoot` or `cwd` for display and filesystem operations. This is required on Windows, where project identity is case- and separator-insensitive.
- Worktree operations are served by `/api/worktrees` and guarded by the same allowed-root rules as `/api/files`. Canonical CWD project discovery uses a 60-second/256-entry LRU; `ProjectInfo.repositoryRoot` identifies the current checkout while `gitCommonRoot` identifies the main repo shared by linked worktrees. Worktree lists use a 5-second/64-project LRU plus common-root in-flight coalescing.
- New worktrees are created under `<repoRoot>-worktrees/<sanitized-branch>`. Existing branches are reused; otherwise `git worktree add -b` creates the branch from an already-fetched `origin/<branch>` ref when available, falling back to local `HEAD`; creation uses a five-minute Git timeout and does not fetch implicitly.
- Removing a dirty worktree returns `409` with `{ dirty: true }` so the UI can ask before retrying with `force`.
- Sessions whose cwd points at a removed worktree are inferred back into the main project instead of becoming a phantom project row.
- All Git callers share `lib/git-process.ts`'s eight-process global pool. Git status uses 1.5-second, 32-entry checkout/CWD LRUs: porcelain is shared per checkout, cwd-scoped line stats and untracked counts are stored in the response snapshot, and file Diff reuses porcelain while fetching the patch only on demand. Agent/Bash completion invalidates the affected checkout; explicit refresh uses `force=1`.
- git prints POSIX-style absolute paths even on Windows, so every path read out of git goes through `toNativePath()` (`lib/paths.ts`) before it is compared or returned. Compare paths with `samePath()`, never `===` — raw equality made `isTopLevel` permanently false on Windows and hid the worktree switcher entirely. Branch names are not paths and must keep their forward slashes. Browser code cannot apply Node path rules, so `/api/worktrees` resolves `currentWorktreePath` server-side; the sidebar must use that identity for highlighting and removal fallback.

### Project command environment
- Pi Web's built-in agent `bash` tool and direct shell commands use `lib/project-command-env.ts` to remove host-only `PORT`, `NODE_ENV`, `NEXT_*`, and `PI_WEB_PASSWORD` variables while preserving the SDK-managed PATH, Pi session metadata, and other user/project variables. Web terminal shells also omit `PI_WEB_PASSWORD`. See `docs/adr/0001-isolate-project-command-environments.md`.
- The host-provided bash extension is a fallback only: if a user extension already owns `bash`, `preferUserBashExtension()` removes the host fallback instead of intercepting the user tool.
- `startRpcSession()` must combine this extension configuration with `createPiWebAgentSessionServices()`; bypassing the serialized service wrapper can reintroduce extension singleton races.

### File access allow-list
- `/api/files` is intentionally not a general filesystem browser. Allowed roots come from session cwds, their resolved project roots, `~/pi-cwd-*`, and roots explicitly added with `allowFileRoot()`.
- `/api/cwd/validate`, `/api/default-cwd`, and `/api/worktrees` call `allowFileRoot()` when they make a new location browsable.
- Allowed roots are stored slash-normalized, but that is a Set-key convention, not a correctness requirement: `isPathWithinRoots()` (`lib/path-security.ts`, the single implementation behind `isFilePathAllowed()`) re-resolves and case-folds both sides, so either path form authorizes correctly. Keep that one implementation — it is the security boundary.

### File tree refresh
- Directory list responses include a metadata version. FileExplorer retains at most 512 directory versions and, on automatic/Agent refresh, validates expanded directories through bounded 128-path `directory-versions` batches; only changed directories re-enumerate. Root enumeration and Git status still refresh once.
- Explicit user refresh is stronger: it re-enumerates every expanded directory and forces Git and Worktrees validation. Session-list refresh alone never invalidates Worktrees.

### File viewer versioning and cache
- File `read`, `meta`, media/download streams, and DOCX preview expose one opaque metadata-derived version through `ETag`/`Last-Modified`; conditional checks happen only after lexical, session-reference, and realpath authorization.
- File watchers re-stat after `fs.watch` is established and send the same full version on `connected` and `change`, including explicit missing-file identity. Text, image, audio, video, PDF, and DOCX viewers start their only initial snapshot from that shared handshake; media URLs use its ETag as their identity. Cached text is bounded by requested path plus `sourceSessionId` and is not rendered until the current watcher or conditional request has re-authorized and validated it. Each EventSource owns one error listener and retains browser auto-reconnect after transient post-connect failures. Markdown local links preserve a valid PDF `#page=N` fragment through tab state and the versioned PDF URL.
- DOCX conversion output uses a separate bounded server LRU keyed by path and file ETag. Equal conversions share in-flight work, and route authorization still runs before every cache lookup or 304 response.

### Plugins and skills
- `/api/plugins` uses pi's `SettingsManager` + `DefaultPackageManager` for global/project package install, remove, update, enable, and disable. Disabling writes empty `extensions/skills/prompts/themes` arrays for that package entry.
- `/api/skills` uses `DefaultResourceLoader` so settings paths, package skills, and project `.agents/skills` are listed the same way the runtime sees them.
- Skill toggling edits only the `disable-model-invocation` frontmatter key on the target `SKILL.md`; keep that surgical so user formatting survives.
- `/api/skills/install` shells through `npx skills add ... --agent pi`; project installs run with the selected cwd.

### Built-in subagents
- The global `builtInEnabled` switch is persisted in `~/.pi/agent/agents/settings.json` and defaults to `false` when the file or field is absent. Malformed settings fail closed; atomic updates preserve unknown fields.
- The inline built-in extension factory is always present so reloading an existing wrapper can apply setting changes, but it registers no tools while disabled. After changing the switch, the user must explicitly reload the current session.
- When enabled, only a recognized legacy `pi-subagents` extension that registers any reserved tool (`Agent`, `get_subagent_result`, or `steer_subagent`) is removed. Unrelated extensions remain loaded, and resolved conflict diagnostics are discarded.
- Runtime `Agent` dispatch checks the setting again so a stale tool call cannot start a subagent after the feature is switched off. Provider-stream failures are persisted as failed runs, not completed runs.
- See `docs/adr/0003-built-in-subagent-toggle.md` for the precedence and persistence rationale.
- Individual built-in profiles (`general-purpose`, `explore`, `plan`) are switched off by name in the same file's `disabledBuiltIns` array, never by copying them out to a `.md` file: a copy freezes the built-in prompt at the version it was copied from and is visible to the other runtimes reading those directories. `builtInProfiles()` stamps `enabled` onto the constants so the panel, the `Agent` tool description, and `resolveSubagentProfile` agree; each write is a minimal edit that preserves names it did not touch, including ones no built-in claims (a newer build's). Reading the list fails *open* — the feature switch beside it has already failed closed — while `PATCH /api/subagents/profiles` with `scope: "builtin"` performs the write and `PUT`/`DELETE` still refuse that scope. A same-name file replaces the built-in outright and is switched off through its own frontmatter. Only the switch is live for a built-in; the rest of the form stays read-only. See `docs/adr/0005-built-in-subagent-disable.md`.
- A background run's completion notification (`notifyParent`) is skipped when the parent already collected the same result with `get_subagent_result`: the tool marks a finished background run consumed and the notification takes that mark. The check cannot happen only when the completion promise resolves — the parent is usually still inside its `get_subagent_result` poll at that moment (500ms interval) and `deliverAs: "followUp"` would just queue the duplicate until that turn ends. So `notifyParent` holds the message while the parent `isRunning()` and re-checks the mark before sending; an idle parent is still notified immediately.
- Agent profile files (`~/.pi/agent/agents/*.md`, project `.pi/agents/*.md`) are shared with other runtimes, so a save round-trips the frontmatter keys this app does not own (`name`, `allowed_subagents`, `exclude_extensions`, `disallowed_tools`, …) and carries foreign `ext:` tool selectors through. Managed keys are exactly `description`, `display_name`, `tools`, `load_skills`, `load_extensions`, `enabled`, `inherit_context`, `run_in_background`, `model`, `thinking`, `max_turns`.
- A background run's completion reaches the parent through `sendCustomMessage`, and pi's `convertToLlm` replays every `custom` message to the model as a plain `user` turn. `subagentNotificationText()` therefore prefixes the report with `SUBAGENT_NOTIFICATION_PREFIX` so a compaction pass — whose prompt asks what *the user* wants — does not file the subagent's output under Goal / Constraints (#875). Foreground `Agent` and `get_subagent_result` results keep the bare `subagentFinalText()`: they are already `toolResult` messages and need no marker. Keep the prefix in code, not in a profile prompt, so the model cannot drop it.
- The `skills` / `extensions` spellings pi-subagents reads are seeded on first save and kept in step while they are booleans; a hand-authored whitelist such as `extensions: pi-advisor-flow` is never rewritten, and the two flags fall back to those aliases when `load_skills` / `load_extensions` are absent.

### Auth and model config
- `ModelsConfig` combines models from `~/.pi/agent/models.json` with provider auth status from pi's `AuthStorage`/`ModelRegistry`.
- Provider listing is capability-driven, never id-driven: `lib/provider-listing.ts` decides membership from `auth.apiKey.login` / `auth.oauth` plus the stored credential type, so dual-auth providers (anthropic and github-copilot today — which providers declare both changes between SDK releases, so never assume it from an id) appear exactly once and never fall through both lists (#309). `lib/provider-listing-runtime.ts` adapts `ModelRuntime` to those pure helpers.
- auth.json holds **one** credential per provider and `ModelRuntime.logout()` deletes whichever it is. The delete routes therefore use `removeStoredCredentialIfType()` to compare and delete under the same file lock used by pi's auth storage. `ModelsConfig` also refreshes *both* provider lists after any auth change — refreshing one leaves a dual-auth provider rendered twice.
- OAuth/device-code/manual-code flows are streamed by `GET /api/auth/login/[provider]`; manual code responses POST back with a short-lived token stored in `globalThis.__piLoginCallbacks`.
- API-key routes store and remove keys through `AuthStorage`. Status endpoints must never return the raw key.
- Browser password auth uses a signed `pi_web_session` cookie with `SameSite=Lax`; the API keeps Basic Auth compatibility. Failed form and Basic password attempts share process-wide backoff and return `Retry-After`; signed sessions remain usable during a Basic block. Login return paths must resolve to the same origin.
- Provider model/auth listings include extension-registered providers, and OpenCode Go quota is exposed through the provider-usage helper when available.
- The model test route is `app/api/models-config/test/route.ts`; `app/api/models/test/` is not a real route.

### Runtime and PWA safety
- `next.config.ts` keeps the proxy request buffer above the 100 MiB upload route limit, and `public/sw.js` bounds navigation/static-asset fetches so a dead upstream cannot hang the app indefinitely.

### Completion sound
- `hooks/useAudio.ts` stores the toggle in `localStorage` as `pi-sound-enabled` and reuses one `AudioContext`.
- Browser autoplay policy means sound must be unlocked from a user gesture; `ChatInput` calls the unlock hook from interactive controls, and `ChatWindow` plays the tone from `onAgentEnd`.

### Exported session HTML
- `/api/sessions/[id]/export` delegates to pi's export helper, then patches recursive tree helpers in the generated HTML to iterative versions so very deep linear sessions do not overflow the browser call stack.

## Pi Session File Format

Location: `~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`

```jsonl
{"type":"session","version":3,"id":"<uuid>","timestamp":"...","cwd":"/path","parentSession":"/abs/path/to/parent.jsonl"}
{"type":"model_change","id":"<8hex>","parentId":null,"provider":"zenmux","modelId":"claude-sonnet-4-6","timestamp":"..."}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"user","content":"..."}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"assistant","content":[...],...}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"toolResult","toolCallId":"...","content":[...]}}
{"type":"compaction","id":"<8hex>","parentId":"<8hex>","summary":"...","firstKeptEntryId":"<8hex>","tokensBefore":N}
{"type":"session_info","id":"...","parentId":"...","name":"user-defined name"}
```

`entryIds[]` in `SessionContext` is a parallel array to `messages[]` — maps each displayed message back to its `.jsonl` entry id, used for fork and navigate_tree calls.

---

## CSS Variables (`app/globals.css`)

```
--bg --bg-panel --bg-hover --bg-selected --border
--text --text-muted --text-dim
--accent --user-bg --tool-bg
--font-mono
```

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
