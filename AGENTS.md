# Pi Web - Development Notes

## Quick Start

```bash
npm run dev   # port 30141
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
  agent/new/route.ts              POST { cwd, message, toolNames?, provider?, modelId? }
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

scripts/
  interaction-browser-baseline.mjs measures local navigation, ordinary/rapid session switching, paged history loading, Viewer and Explorer refresh interactions, API request counts, and browser long tasks through a temporary headless Chrome profile
  session-list-baseline.mjs generates a temporary session corpus or reads an explicit directory and compares SDK scan/parse with index cold-build and warm-fingerprint P50/P95

lib/
  agent-client.ts      typed fetch helper for /api/agent commands
  agent-event-wire.ts  filters/projects SDK events into SSE-safe client deltas
  agent-session-services.ts serialized extension-aware SDK service creation
  draft-store.ts       local draft persistence helpers
  document-preview-cache.ts bounded, version-keyed DOCX conversion cache
  file-access.ts       allowed file roots for /api/files and worktrees
  file-paths.ts        client/server path encoding helpers
  file-version.ts      opaque file identity, ETag, Last-Modified, and conditional request helpers
  git-changes.ts       bounded checkout/CWD status snapshots and on-demand file diff helpers
  git-process.ts       shared bounded-concurrency Git subprocess runner
  markdown.ts          shared markdown helpers
  npx.ts               npx runner used by skill install
  pi-types.ts          local structural types for pi SDK objects
  project-command-env.ts sanitized built-in project shell operations
  project-groups.ts    stable-key project grouping and activity aggregation
  project-identity.ts  platform-aware internal project identity
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
- **Fork** (Fork button on user message): creates a new independent `.jsonl` file. Shown as a child in the sidebar tree via `parentSession` header field.
- **In-session branch** (Continue button / BranchNavigator): calls `navigate_tree` within the same file. Multiple entries share the same `parentId`. Switching between them calls `/api/sessions/[id]/context?leafId=`.

### Session files can be fully rewritten
`parentSession` in the header is **display metadata only** — has zero effect on chat content. Safe to `writeFileSync` the entire file (pi does this itself during migrations). Used when cascade-reparenting children on delete.

### ToolCall normalization and streaming
Pi stores toolCall blocks as `{type:"toolCall", id, name, arguments}` but `ToolCallContent` uses `{toolCallId, toolName, input}`. `normalizeToolCalls()` in `lib/normalize.ts` handles persisted and completed messages in `session-reader.ts` and `useAgentSession.ts`.

For in-flight assistant messages, `lib/agent-event-wire.ts` removes heavy partial snapshots while preserving streamed tool-call identity, and `lib/streaming-message.ts` immutably reconstructs text, thinking, and tool-call argument deltas. Reconnect snapshots use `normalizeStreamingToolCalls()` to preserve temporary raw tool input; the authoritative `toolcall_end` replaces that scratch data with parsed arguments. `tool_execution_update` events keep their partial result on the SSE wire; `lib/tool-execution-progress.ts` extracts the latest bounded text line so `ChatWindow` can show live tool progress.

### New session tool preset
Tool names are passed at session creation (`POST /api/agent/new` -> `toolNames[]`) and persisted in versioned `pi-web:tool-selection` custom entries. No entry means a legacy session and keeps Pi's default behavior; an empty array means Chat only. Chat only resolves before services are created, loads no extensions/skills/prompts/themes, and replaces Pi's base prompt with the ordered contents of Pi's discovered context files. Crossing the Chat-only boundary rebuilds the wrapper; changing between nonempty presets updates it in place. Subagents persist their active tools plus profile-level skill and extension loading switches in `resourceSnapshot`; loaded extensions cannot expose the reserved `Agent`, `get_subagent_result`, or `steer_subagent` tools to a subagent. See `docs/adr/0002-chat-only-tool-selection.md`.

The last preset explicitly selected by the user is stored in browser `localStorage` and initializes fresh-session composers only. Existing sessions never trust that preference; they use their live `get_tools` state or pi's default when no wrapper exists.

### Model defaults for new sessions
`GET /api/models` returns `defaultModel` read from `~/.pi/agent/settings.json`. `ChatWindow` pre-selects this on mount for new sessions. Explicit browser model/thinking selections are applied atomically during AgentSession construction, then `lib/startup-preferences.ts` persists their effective values without replaying `set_model`/`set_thinking_level`; implicit `enabledModels` fallbacks and thinking pins are not persisted.

### `enabledModels` scoping
The `enabledModels` setting uses pi's `--models` syntax: minimatch globs against `provider/modelId` or a bare `modelId`, fuzzy matching for non-glob patterns, and an optional `:thinkingLevel` suffix. Never compare those patterns as literal strings — `lib/model-scope.ts` delegates to the SDK's `resolveModelScopeWithDiagnostics()` so pi-web and the TUI agree on the visible model list, and falls back to all available models when patterns resolve to nothing. A non-glob entry that exactly matches the same bare model id from multiple providers is rejected as ambiguous; use `provider/modelId`. `startRpcSession()` resolves that scope before creating an AgentSession and passes the selected initial model, thinking pin, and SDK-native `scopedModels` atomically; `GET /api/models` reuses the helper only for selector data, `thinkingLevelPins`, and `modelScopeWarnings` display.

### Extension widgets and status bar
`ChatWindow` renders extension statuses and widgets together through `ExtensionStatusBar`; do not restore separate above/below-editor widget bands. The compact shelf owns widget expansion, truncation, and status-line presentation.

### SSE reconnect on page refresh mid-stream
On `ChatWindow` mount, `GET /api/agent/[id]` is called. If `state.isStreaming === true`, SSE is reconnected automatically. `thinkingLevel` and `isCompacting` are also synced from this response.

### Compaction SSE events
Newer pi emits `compaction_start` / `compaction_end`; older versions emitted `auto_compaction_start` / `auto_compaction_end`. `handleAgentEvent` accepts both sets to keep `isCompacting` in sync. Manual compact is a blocking POST — the button stays disabled until the response returns.

### Running state polling + reconciliation
- The sidebar polls `/api/agent/running` every 2.5 seconds while the tab is visible and pauses polling in background tabs. The session-list response remains the initial fallback. This lightweight endpoint schedules coalesced, at-most-once-per-30-second index verification without awaiting disk work; accepted fingerprint changes invalidate the list cache and advance its version, including changes made by external Pi processes. Failed or superseded verification must not publish a change or imply deletion.
- `useAgentSession` treats per-session SSE as primary for chat events and opens it before each prompt. `prompt_done` completes the current UI stage and notification immediately, but the idle SSE stays open for a 30-second grace window and is reused by the next prompt. `agent_start` cancels that close timer; `agent_settled` finishes extension-injected runs that have no wrapper-level `prompt_done` and starts a fresh grace window. Do not close on the first `agent_end`: retries, compaction, and extension-queued messages can continue the same logical prompt.
- While a run is active, `useAgentSession` periodically calls `GET /api/agent/[id]` and also reconciles on `visibilitychange`/`online`. This fixes missed terminal events from background tabs or half-open connections.
- Prompt runs use a monotonic run id; late SSE or slow reconciliation responses from an old run must be ignored so they cannot resurrect stale streaming bubbles.
- Existing-session A→B switches keep one ChatWindow shell. Detail and leaf-context fetches each abort predecessors and use monotonic generations; the target remains loading until its own payload arrives, so controls cannot act on the previous session's messages. Fresh composers and project lifecycle resets still use explicit shell remounts.
- Read-only detail/context responses support absolute-index tail/earlier paging. The client initially requests 60 messages and prepends contiguous 120-message pages while preserving `messages[]`/`entryIds[]` alignment and scroll distance. `before` is an exclusive numeric message index, not an entry id; requests are strictly validated and capped at 240 messages. Omitting paging parameters preserves the full-branch response. Full active-branch statistics and the bounded 50-item input history are computed from the complete cached browsing history, including messages before compaction; this does not change the SDK's effective model context. Detail also exposes separate all-file usage statistics, including compaction and branch-summary usage, cached with the parsed snapshot. The legacy `oldestEntryId`/`hasMore` response fields describe the returned window but do not redefine the numeric request contract.
- A null active leaf means an empty branch, not a missing disk snapshot or the latest entry. On the context endpoint, `leafId=` explicitly selects that empty branch; omitting `leafId` uses the active leaf. Context-cache keys distinguish null/default/explicit leaves and the session id used for lazy tool-image URLs. Active wrappers bypass disk snapshots; immutable disk snapshots reuse their precomputed all-file usage until the file fingerprint changes.
- Ordinary history scrolling, search positioning, and reading-position restoration share the same numeric page loader, cancellation, and generation checks. Advance its cursor synchronously on accepted pages so multi-page lookups do not depend on React committing a render between requests. Prepend persisted history to both displayed messages and the loaded statistics baseline; otherwise old usage is counted again as a live delta.
- Reading-position restoration is initialized by session identity, not only on ChatWindow mount. Preserve the chat shell on ordinary selection, park fresh drafts by cwd, and defer automatic tail scrolling while a saved anchor or search target is being located. Position capture is frame-coalesced and finds its anchor without measuring every rendered row; reset/cancel pending work when the session changes.

### Session pinning and manual order
- Pinning is project-scoped and applies only to top-level session trees. A pinned root moves together with its fork subtree; child sessions retain recent-activity order. Persisted subagent rows are hidden and aggregated into their owning visible conversation for selected/running/unread state, while ordinary fork descendants remain visible.
- Pinned roots use their stored manual order above ordinary roots, while ordinary roots continue sorting by `modified` descending. Dragging is limited to the pinned section. The sidebar virtualizes variable-height root subtrees (including visible fork descendants) and force-keeps the focused or dragged root mounted.
- Order preferences live in the private Pi Web preference file under the agent directory, not in session `.jsonl` files or the derived session index. Pinning must never change session activity timestamps.

### Session-list refresh, index, and request ordering
- The sidebar's initial list effect is idempotent under React Strict Effects. Lifecycle refreshes and background completion discovery use the normal cached endpoint; only explicit user refresh uses `force=1`.
- `listAllSessions({ force: true })` coalesces concurrent callers into one refresh that remains pending across generation invalidation retries. Browser list, file-tree, Git, Worktrees, and workspace-restore requests abort predecessors and guard against stale responses. Workspace restore resolves its remembered id through `/api/sessions/[id]/meta`, not a full session-list response; the meta route waits for a current-process verified index snapshot before confirming presence.
- Session list metadata is a derived, versioned index under the agent cache directory. A worker enumerates SDK-compatible session paths and reparses only files whose size/nanosecond times/device/inode fingerprint changed; session details and context remain SDK-authoritative.
- Persisted built-in subagent relations are projected during that same changed-file parse (first metadata entry, latest result). The index stores only parent id, profile, description, and persisted status, never task bodies, resource snapshots, or result bodies. List and lightweight metadata lookup reuse this projection without a second relation-file scan. Unknown or absent terminal results mean `interrupted`, not inferred completion or runtime liveness. List merging may overlay a live wrapper's subagent status only when its parent identity agrees with disk; disk naming, identity, and other metadata remain authoritative. SDK/projection changes must invalidate old persisted snapshots through the projection version.
- Worker reconciliation and persistence are separate generation-gated phases. Only accepted generations update memory, and accepted snapshots persist serially with private permissions, integrity checks, and entry/byte limits. Known Agent, naming, fork, delete, and reparent mutations publish the list version immediately and pass exact session paths so the worker patches only those entries; accepting that derived refresh must not publish the same version change again. Manual force and periodic external-change validation still enumerate all fingerprints and publish newly discovered changes. Authorization callers use the same periodic verified refresh rather than retaining a startup-verified root indefinitely.
- Session-index worker sources remain `.mts` so Node executes them as ESM. Production Webpack applies `scripts/next-mts-loader.cjs` only when `NODE_ENV=production`; development stays on native Turbopack handling. Node workers are constructed indirectly so Turbopack does not misclassify a `worker_threads` entry as a browser worker and traverse arbitrary project files.
- Persisted startup snapshots may accelerate list display but are not authorization evidence. `getAllowedFileRoots()` waits for the current process's reconciled snapshot before deriving cwd/project roots; lexical and realpath checks remain the final security boundary.
- Read-only session detail/context routes share bounded path-fingerprint parsed-snapshot and fingerprint/leaf context LRUs. Active RPC wrappers always bypass them, and known writes, naming, fork, delete, and reparent operations invalidate the affected paths.

### Worktrees and project grouping
- `lib/worktree.ts` resolves linked worktree top-levels back to the main repo `projectRoot`; `listAllSessions()` attaches both that display/filesystem path and a stable server-computed `projectKey` to each `SessionInfo` so all worktrees for one repo are grouped together in the sidebar.
- Grouping and equality use `projectKey` through `workspaceKeyOf()` / `lib/project-groups.ts`; keep `projectRoot` or `cwd` for display and filesystem operations. This is required on Windows, where project identity is case- and separator-insensitive.
- Worktree operations are served by `/api/worktrees` and guarded by the same allowed-root rules as `/api/files`. Canonical CWD project discovery uses a 60-second/256-entry LRU; `ProjectInfo.repositoryRoot` identifies the current checkout while `gitCommonRoot` identifies the main repo shared by linked worktrees. Worktree lists use a 5-second/64-project LRU plus common-root in-flight coalescing.
- New worktrees are created under `<repoRoot>-worktrees/<sanitized-branch>`. Existing branches are reused; otherwise `git worktree add -b` creates the branch.
- Removing a dirty worktree returns `409` with `{ dirty: true }` so the UI can ask before retrying with `force`.
- Sessions whose cwd points at a removed worktree are inferred back into the main project instead of becoming a phantom project row.
- All Git callers share `lib/git-process.ts`'s eight-process global pool. Git status uses 1.5-second, 32-entry checkout/CWD LRUs: porcelain is shared per checkout, cwd-scoped line stats and untracked counts are stored in the response snapshot, and file Diff reuses porcelain while fetching the patch only on demand. Agent/Bash completion invalidates the affected checkout; explicit refresh uses `force=1`.
- git prints POSIX-style absolute paths even on Windows, so every path read out of git goes through `toNativePath()` (`lib/paths.ts`) before it is compared or returned. Compare paths with `samePath()`, never `===` — raw equality made `isTopLevel` permanently false on Windows and hid the worktree switcher entirely. Branch names are not paths and must keep their forward slashes. Browser code cannot apply Node path rules, so `/api/worktrees` resolves `currentWorktreePath` server-side; the sidebar must use that identity for highlighting and removal fallback.

### Project command environment
- Pi Web's built-in agent `bash` tool and direct shell commands use `lib/project-command-env.ts` to remove host-only `PORT`, `NODE_ENV`, and `NEXT_*` variables while preserving the SDK-managed PATH, Pi session metadata, and user/project variables. See `docs/adr/0001-isolate-project-command-environments.md`.
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
- File watchers re-stat after `fs.watch` is established and send the same full version on `connected` and `change`, including explicit missing-file identity. Text, image, audio, video, PDF, and DOCX viewers start their only initial snapshot from that shared handshake; media URLs use its ETag as their identity. Cached text is bounded by requested path plus `sourceSessionId` and is not rendered until the current watcher or conditional request has re-authorized and validated it. Each EventSource owns one error listener and retains browser auto-reconnect after transient post-connect failures.
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
- Runtime `Agent` dispatch checks the setting again so a stale tool call cannot start a subagent after the feature is switched off.
- See `docs/adr/0003-built-in-subagent-toggle.md` for the precedence and persistence rationale.

### Auth and model config
- `ModelsConfig` combines models from `~/.pi/agent/models.json` with provider auth status from pi's `AuthStorage`/`ModelRegistry`.
- Provider listing is capability-driven, never id-driven: `lib/provider-listing.ts` decides membership from `auth.apiKey.login` / `auth.oauth` plus the stored credential type, so dual-auth providers (anthropic and github-copilot today — which providers declare both changes between SDK releases, so never assume it from an id) appear exactly once and never fall through both lists (#309). `lib/provider-listing-runtime.ts` adapts `ModelRuntime` to those pure helpers.
- auth.json holds **one** credential per provider and `ModelRuntime.logout()` deletes whichever it is. The delete routes therefore use `removeStoredCredentialIfType()` to compare and delete under the same file lock used by pi's auth storage. `ModelsConfig` also refreshes *both* provider lists after any auth change — refreshing one leaves a dual-auth provider rendered twice.
- OAuth/device-code/manual-code flows are streamed by `GET /api/auth/login/[provider]`; manual code responses POST back with a short-lived token stored in `globalThis.__piLoginCallbacks`.
- API-key routes store and remove keys through `AuthStorage`. Status endpoints must never return the raw key.
- The model test route is `app/api/models-config/test/route.ts`; `app/api/models/test/` is not a real route.

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
