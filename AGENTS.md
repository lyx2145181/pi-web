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
  agent/new/route.ts              POST { cwd, message, toolNames?, provider?, modelId? }
  agent/[id]/route.ts             GET state | POST any command
  agent/[id]/events/route.ts      GET SSE stream
  agent/running/route.ts          GET currently-running session ids
  agent/running/events/route.ts   GET SSE stream of currently-running session ids
  auth/all-providers/route.ts     GET API-key provider list
  auth/api-key/[provider]/route.ts GET/POST/DELETE provider API key status/storage
  auth/login/[provider]/route.ts  GET OAuth/device-code SSE | POST manual code
  auth/logout/[provider]/route.ts POST OAuth logout
  auth/providers/route.ts         GET OAuth provider list
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
  streaming-message.ts reconstructs streamed assistant blocks and tool-call arguments
  tool-execution-progress.ts extracts bounded progress text from partial tool results
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
- Idle timeout: 10 minutes. Before shutdown, Pi Web queries the public `pi-subagents` event-bus RPC status snapshot; a session that still owns queued/running background subagents is retained so its completion notifier remains alive. Missing extensions keep the normal timeout, while an advertised bridge failure is handled conservatively. Concurrent `startRpcSession()` calls share a single start Promise (`globalThis.__piStartLocks`).
- The package launcher forwards `SIGINT`/`SIGTERM` to the spawned Next.js child, force-kills only after a 5-second grace period or a repeated signal, and propagates the child's final exit status (`bin/process-lifecycle.js`).
- All Pi Web extension-factory evaluation goes through `lib/agent-session-services.ts`, which serializes extension loading so service discovery cannot race session startup. Service-only loads are marked transient: they preserve an unchanged active `pi-chrome` singleton, never revive one removed by concurrent session shutdown, and release any singleton they acquire because they never receive `session_shutdown`. Endpoints that do not need extensions must avoid evaluating them entirely: `lib/skills-service.ts` creates `DefaultResourceLoader` with `noExtensions: true` because static skill enumeration has no session lifecycle for `resources_discover` or `session_shutdown`. Otherwise `/chrome` and `chrome_*` tools can disappear from the next real session.

### Fork must destroy the wrapper immediately
`AgentSession.fork()` **mutates the wrapper's inner state in-place** — after fork, `inner.sessionId` is the *new* session's id. If the wrapper stays alive in the registry under the old id, the next request gets the already-forked state and subsequent forks produce a corrupt `parentSession` chain.

**Fix**: `send("fork")` captures `newSessionId`, then calls `this.destroy()` before returning. The next request for the original session reloads a clean AgentSession from the original file.

### Two kinds of branching — don't confuse them
- **Fork** (Fork button on user message): creates a new independent `.jsonl` file. Shown as a child in the sidebar tree via `parentSession` header field.
- **In-session branch** (Continue button / BranchNavigator): calls `navigate_tree` within the same file. Multiple entries share the same `parentId`. Switching between them calls `/api/sessions/[id]/context?leafId=`.

### Session files can be fully rewritten
`parentSession` in the header is **display metadata only** — has zero effect on chat content. Safe to `writeFileSync` the entire file (pi does this itself during migrations). Used when cascade-reparenting children on delete.

### ToolCall normalization and streaming
Pi stores toolCall blocks as `{type:"toolCall", id, name, arguments}` but `ToolCallContent` uses `{toolCallId, toolName, input}`. `normalizeToolCalls()` in `lib/normalize.ts` handles persisted and completed messages in `session-reader.ts` and `useAgentSession.ts`.

For in-flight assistant messages, `lib/agent-event-wire.ts` removes heavy partial snapshots while preserving streamed tool-call identity, and `lib/streaming-message.ts` immutably reconstructs text, thinking, and tool-call argument deltas. Reconnect snapshots use `normalizeStreamingToolCalls()` to preserve temporary raw tool input; the authoritative `toolcall_end` replaces that scratch data with parsed arguments. `tool_execution_update` events keep their partial result on the SSE wire; `lib/tool-execution-progress.ts` extracts the latest bounded text line so `ChatWindow` can show live tool progress.

### New session tool preset
Tool names are passed at session creation (`POST /api/agent/new` → `toolNames[]`). For existing sessions, the active preset is inferred on mount via `get_tools` → `getPresetFromTools()`. When tools are fully disabled (`toolNames = []`), `rpc-manager.ts` passes an empty tool allow-list and forces `agent.state.systemPrompt = ""` after startup/reload/resource discovery.

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
- The sidebar polls `/api/agent/running` every 2.5 seconds while the tab is visible and pauses polling in background tabs. The session-list response remains the initial fallback.
- `useAgentSession` treats per-session SSE as primary for chat events and opens it before each prompt. `prompt_done` completes the current UI stage and notification immediately, but the idle SSE stays open for a 30-second grace window and is reused by the next prompt. `agent_start` cancels that close timer; `agent_settled` finishes extension-injected runs that have no wrapper-level `prompt_done` and starts a fresh grace window. Do not close on the first `agent_end`: retries, compaction, and extension-queued messages can continue the same logical prompt.
- While a run is active, `useAgentSession` periodically calls `GET /api/agent/[id]` and also reconciles on `visibilitychange`/`online`. This fixes missed terminal events from background tabs or half-open connections.
- Prompt runs use a monotonic run id; late SSE or slow reconciliation responses from an old run must be ignored so they cannot resurrect stale streaming bubbles.
- Existing-session A→B switches keep one ChatWindow shell. Detail and leaf-context fetches each abort predecessors and use monotonic generations; the target remains loading until its own payload arrives, so controls cannot act on the previous session's messages. Fresh composers and project lifecycle resets still use explicit shell remounts.
- Read-only detail/context responses support absolute-index tail/earlier paging. The client initially requests 60 messages and prepends contiguous 120-message pages while preserving `messages[]`/`entryIds[]` alignment and scroll distance. Full active-branch statistics and the bounded 50-item input history are computed from the complete cached context, so paging does not weaken stats or prompt recall.

### Session-list refresh, index, and request ordering
- The sidebar's initial list effect is idempotent under React Strict Effects. Lifecycle refreshes and background completion discovery use the normal cached endpoint; only explicit user refresh uses `force=1`.
- `listAllSessions({ force: true })` coalesces concurrent callers into one refresh that remains pending across generation invalidation retries. Browser list, file-tree, Git, Worktrees, and workspace-restore requests abort predecessors and guard against stale responses. Workspace restore resolves its remembered id through `/api/sessions/[id]/meta`, not a full session-list response; the meta route waits for a current-process verified index snapshot before confirming presence.
- Session list metadata is a derived, versioned index under the agent cache directory. A worker enumerates SDK-compatible session paths and reparses only files whose size/nanosecond times/device/inode fingerprint changed; session details and context remain SDK-authoritative.
- Worker reconciliation and persistence are separate generation-gated phases. Only accepted generations update memory, and accepted snapshots persist serially with private permissions, integrity checks, and entry/byte limits. Known Agent, naming, fork, delete, and reparent mutations pass exact session paths so the worker patches only those entries; manual force and periodic external-change validation still enumerate all fingerprints. Authorization callers use the same periodic verified refresh rather than retaining a startup-verified root indefinitely.
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
- File watchers re-stat after `fs.watch` is established and send the same full version on `connected` and `change`, including explicit missing-file identity. Text and media viewers start their only initial snapshot from that handshake and use a bounded cache keyed by requested path plus `sourceSessionId`; cached text is not rendered until the current watcher or conditional request has re-authorized and validated it. Each EventSource owns one error listener and retains browser auto-reconnect after transient post-connect failures.
- DOCX conversion output uses a separate bounded server LRU keyed by path and file ETag. Equal conversions share in-flight work, and route authorization still runs before every cache lookup or 304 response.

### Plugins and skills
- `/api/plugins` uses pi's `SettingsManager` + `DefaultPackageManager` for global/project package install, remove, update, enable, and disable. Disabling writes empty `extensions/skills/prompts/themes` arrays for that package entry.
- `/api/skills` uses `DefaultResourceLoader` so settings paths, package skills, and project `.agents/skills` are listed the same way the runtime sees them.
- Skill toggling edits only the `disable-model-invocation` frontmatter key on the target `SKILL.md`; keep that surgical so user formatting survives.
- `/api/skills/install` shells through `npx skills add ... --agent pi`; project installs run with the selected cwd.

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
