import { NextResponse } from "next/server";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import {
  attachSessionProjectInfo,
  listAllSessions,
  mergeSessionLists,
  resolveSessionPath,
  resolveSessionIdByPath,
  invalidateSessionPathCache,
  invalidateSessionListCache,
  buildSessionContext,
  readSessionHeader,
} from "@/lib/session-reader";
import { sessionPathKey } from "@/lib/session-path";
import { abortSubagent, getRpcSession, getRpcSessionInfos } from "@/lib/rpc-manager";
import { projectTreeForResponse } from "@/lib/project-tree";
import { computeSessionTotalActiveMs } from "@/lib/session-timing";
import { createServerTiming } from "@/lib/server-timing";
import {
  getParsedSessionSnapshot,
  getSessionContextFromSnapshot,
  invalidateParsedSession,
} from "@/lib/session-detail-cache";
import {
  computeSessionContextStats,
  computeSessionInputHistory,
  paginateSessionContext,
  parseSessionContextPageRequest,
  SessionContextPageRequestError,
} from "@/lib/session-context-page";
import { computeSessionStats } from "@/lib/session-stats";
import type { SessionEntry } from "@/lib/types";
import { readSubagentRun, readSubagentSessionResources, SUBAGENT_META_TYPE } from "@/lib/subagents";
import { readSessionToolSelection } from "@/lib/session-tool-selection";
import { readSessionSkillSelection } from "@/lib/session-skill-selection";
import { jsonResponse } from "@/lib/json-response";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const timing = createServerTiming();
  const { id } = await params;
  try {
    const rpc = getRpcSession(id);
    const searchParams = new URL(req.url).searchParams;
    const force = searchParams.get("force") === "1";

    // A live wrapper only reflects the appends pi-web itself made. When another
    // pi process (the TUI) writes the same session file, the in-memory index
    // stays stale. Only probe on ?force=1 (session mount / page refresh): two
    // processes writing one JSONL is unsupported, so post-turn reads must not
    // scan disk. Eviction is idle-only; mid-run the wrapper owns the write path.
    let liveWrapper = rpc?.isAlive() ? rpc : undefined;
    let wrapperRebuilt = false;
    if (force && liveWrapper?.evictIfDiskAhead()) {
      wrapperRebuilt = true;
      liveWrapper = undefined;
    }
    const liveRpc = liveWrapper;
    const resolvedPath = liveRpc
      ? null
      : await timing.time("resolve", () => resolveSessionPath(id));
    if (!liveRpc && !resolvedPath) {
      return timing.finish(NextResponse.json({ error: "Session not found" }, { status: 404 }));
    }

    const diskSnapshot = liveRpc
      ? null
      : await timing.time("parse", () => getParsedSessionSnapshot(resolvedPath!));
    const sm = liveRpc?.inner.sessionManager;
    const { filePath, entries, leafId, tree } = timing.timeSync("session-read", () => ({
      filePath: liveRpc?.sessionFile || diskSnapshot?.filePath || resolvedPath || "",
      entries: sm?.getEntries() ?? diskSnapshot!.entries,
      leafId: sm ? sm.getLeafId() : diskSnapshot!.leafId,
      tree: sm ? projectTreeForResponse(sm.getTree()) : diskSnapshot!.tree,
    }));
    const deferThinking = searchParams.has("deferThinking");
    const deferToolResultImages = searchParams.has("deferMedia");
    const pageRequest = parseSessionContextPageRequest(searchParams);
    const contextOptions = { deferThinking, deferToolResultImages, sessionId: id };
    const { fullContext, totalActiveMs } = timing.timeSync("context", () => ({
      fullContext: diskSnapshot
        ? getSessionContextFromSnapshot(
            diskSnapshot,
            leafId,
            contextOptions,
            () => buildSessionContext(entries as never, leafId, contextOptions),
          )
        : buildSessionContext(entries as never, leafId, contextOptions),
      totalActiveMs: computeSessionTotalActiveMs(entries),
    }));
    const { context, page: contextPage } = pageRequest
      ? paginateSessionContext(fullContext, pageRequest)
      : {
          context: fullContext,
          page: {
            startIndex: 0,
            endIndex: fullContext.messages.length,
            totalMessages: fullContext.messages.length,
            hasEarlier: false,
          },
        };
    const contextStats = computeSessionContextStats(fullContext);
    const inputHistory = computeSessionInputHistory(fullContext);

    const stats = diskSnapshot?.stats ?? computeSessionStats(entries as unknown as SessionEntry[]);
    const subagentResources = readSubagentSessionResources(entries as never);
    const toolSelection = subagentResources
      ? { mode: "exact" as const, tools: subagentResources.tools }
      : readSessionToolSelection(entries as never);
    const skillSelection = subagentResources
      ? subagentResources.loadSkills
        ? undefined
        : { mode: "exact" as const, skills: [] }
      : readSessionSkillSelection(entries as never);
    const info = await timing.time("metadata", async () => {
      const header = sm?.getHeader() ?? diskSnapshot?.header ?? null;
      if (!header) return null;
      let modified = header.timestamp;
      try { modified = statSync(filePath).mtime.toISOString(); } catch { /* use header timestamp */ }
      const subagent = readSubagentRun(entries as never, header.id, filePath);
      const originSessionId = header.parentSession
        ? await resolveSessionIdByPath(header.parentSession)
        : undefined;
      const firstEntry = entries.find((entry) => entry.type === "message" && entry.message.role === "user");
      const content = firstEntry?.type === "message" && firstEntry.message.role === "user"
        ? firstEntry.message.content
        : undefined;
      const firstMessage = typeof content === "string" ? content
        : Array.isArray(content) ? content.filter((block) => block.type === "text").map((block) => block.text).join(" ") : "";
      return (await attachSessionProjectInfo([{
        path: filePath,
        id: header.id,
        cwd: header.cwd ?? "",
        name: sm?.getSessionName() ?? diskSnapshot?.sessionName,
        created: header.timestamp,
        modified,
        messageCount: stats.totalMessages,
        firstMessage: firstMessage || "(no messages)",
        parentSessionId: subagent?.parentSessionId ?? originSessionId,
        ...(subagent
          ? { relation: { kind: "subagent" as const, parentSessionId: subagent.parentSessionId, profile: subagent.profile, description: subagent.description, status: liveRpc?.isRunning() ? "running" as const : subagent.status } }
          : header.parentSession
            ? { relation: { kind: "fork" as const, ...(originSessionId ? { originSessionId } : {}) } }
            : {}),
        transient: !filePath || !existsSync(filePath),
      }]))[0];
    });

    const response = timing.timeSync("serialize", () => jsonResponse(
      req,
      {
        sessionId: id,
        filePath,
        info,
        leafId,
        tree,
        context,
        contextPage,
        contextStats,
        inputHistory,
        stats,
        totalActiveMs,
        ...(toolSelection !== undefined
          ? { toolNames: toolSelection.tools, toolPolicy: toolSelection.mode }
          : {}),
        ...(skillSelection !== undefined
          ? { skillNames: skillSelection.skills, skillPolicy: skillSelection.mode }
          : {}),
        ...(wrapperRebuilt ? { wrapperRebuilt: true } : {}),
      },
    ));
    return timing.finish(response);
  } catch (error) {
    const status = error instanceof SessionContextPageRequestError ? 400 : 500;
    return timing.finish(NextResponse.json({ error: String(error) }, { status }));
  }
}

// PATCH /api/sessions/[id]  body: { name: string }
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const { name } = await req.json() as { name?: string };
    if (typeof name !== "string") {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    const manager = SessionManager.open(filePath);
    manager.appendSessionInfo(name.trim());
    invalidateParsedSession(filePath);
    invalidateSessionListCache([filePath]);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// DELETE /api/sessions/[id]
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const runtime = getRpcSession(id);
    const filePath = runtime?.sessionFile || await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    // Read only the bounded header before deleting.
    let parentSessionPath: string | undefined;
    try {
      parentSessionPath = readSessionHeader(filePath)?.parentSession;
    } catch (error) {
      // Empty runtime sessions have a cached path before their first disk write.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    let parentSessionId: string | undefined;
    if (parentSessionPath) {
      try {
        // The parent may have been deleted or moved already; treat it as absent.
        parentSessionId = readSessionHeader(parentSessionPath)?.id;
      } catch {
        parentSessionId = undefined;
      }
    }

    const targetPathKey = sessionPathKey(filePath);
    const reparentedPaths: string[] = [];
    const dir = dirname(filePath);
    // Deleting a session also deletes every persisted or live subagent below it.
    const sessions = mergeSessionLists(
      await listAllSessions({ force: true }),
      getRpcSessionInfos({ includeTransient: true }),
    );
    const childrenByParent = new Map<string, string[]>();
    for (const session of sessions) {
      if (session.relation?.kind !== "subagent") continue;
      const children = childrenByParent.get(session.relation.parentSessionId) ?? [];
      children.push(session.id);
      childrenByParent.set(session.relation.parentSessionId, children);
    }
    const sessionPaths = new Map(sessions.map((session) => [session.id, session.path]));
    // Include local files even when the global catalogue is stale or incomplete.
    try {
      for (const file of readdirSync(dir).filter((name) => name.endsWith(".jsonl"))) {
        const childPath = join(dir, file);
        if (sessionPathKey(childPath) === targetPathKey) continue;
        try {
          const lines = readFileSync(childPath, "utf8").split("\n");
          const header = JSON.parse(lines[0]) as { type?: string; id?: string };
          if (header.type !== "session" || typeof header.id !== "string") continue;
          const entries = lines.slice(1).flatMap((line) => {
            try { return [JSON.parse(line) as SessionEntry]; } catch { return []; }
          });
          const subagent = readSubagentRun(entries, header.id, childPath);
          if (!subagent) continue;
          const children = childrenByParent.get(subagent.parentSessionId) ?? [];
          children.push(header.id);
          childrenByParent.set(subagent.parentSessionId, children);
          sessionPaths.set(header.id, childPath);
        } catch { /* skip malformed or concurrently removed sessions */ }
      }
    } catch { /* skip if dir unreadable */ }
    const deletedSessionIds = new Set<string>([id]);
    const pending = [id];
    while (pending.length > 0) {
      const parentId = pending.pop()!;
      for (const childId of childrenByParent.get(parentId) ?? []) {
        if (deletedSessionIds.has(childId)) continue;
        deletedSessionIds.add(childId);
        pending.push(childId);
      }
    }
    const deletedPaths = new Map<string, string>([[id, filePath]]);
    for (const deletedId of deletedSessionIds) {
      const sessionPath = sessionPaths.get(deletedId);
      if (sessionPath) deletedPaths.set(deletedId, sessionPath);
    }
    for (const deletedId of deletedSessionIds) {
      if (deletedPaths.has(deletedId)) continue;
      const runtimePath = getRpcSession(deletedId)?.sessionFile;
      if (runtimePath) deletedPaths.set(deletedId, runtimePath);
      else {
        const resolvedPath = await resolveSessionPath(deletedId);
        if (resolvedPath) deletedPaths.set(deletedId, resolvedPath);
      }
    }
    const deletedPathKeys = new Set([...deletedPaths.values()].map((path) => sessionPathKey(path)));

    // Re-attach all direct children to this session's parent (cascade re-parent)
    // Scan sibling files in the same directory
    try {
      const files = readdirSync(dir).filter(
        (file) => file.endsWith(".jsonl") && sessionPathKey(join(dir, file)) !== targetPathKey,
      );
      for (const file of files) {
        const childPath = join(dir, file);
        if (deletedPathKeys.has(sessionPathKey(childPath))) continue;
        try {
          const content = readFileSync(childPath, "utf8");
          const lines = content.split("\n");
          const header = JSON.parse(lines[0]) as { type?: string; parentSession?: string };
          if (
            header.type === "session" &&
            header.parentSession &&
            sessionPathKey(header.parentSession) === targetPathKey
          ) {
            // Rewrite header with new parentSession
            header.parentSession = parentSessionPath;
            lines[0] = JSON.stringify(header);
            if (parentSessionPath && parentSessionId) {
              for (let index = 1; index < lines.length; index += 1) {
                let entry: { type?: string; customType?: string; data?: unknown };
                try {
                  entry = JSON.parse(lines[index]);
                } catch {
                  continue;
                }
                if (
                  entry.type !== "custom"
                  || entry.customType !== SUBAGENT_META_TYPE
                  || typeof entry.data !== "object"
                  || entry.data === null
                  || Array.isArray(entry.data)
                ) continue;
                entry.data = {
                  ...entry.data,
                  parentSessionId,
                  parentSessionPath,
                };
                lines[index] = JSON.stringify(entry);
                break;
              }
            }
            writeFileSync(childPath, lines.join("\n"));
            invalidateParsedSession(childPath);
            reparentedPaths.push(childPath);
          }
        } catch { /* skip malformed */ }
      }
    } catch { /* skip if dir unreadable */ }

    for (const deletedId of [...deletedSessionIds].reverse()) {
      if (deletedId === id) continue;
      try { await abortSubagent(deletedId); } catch { /* idle or completed */ }
      await getRpcSession(deletedId)?.shutdown();
    }
    try { await abortSubagent(id); } catch { /* ordinary session */ }
    await runtime?.shutdown();
    for (const [deletedId, deletedPath] of deletedPaths) {
      try {
        unlinkSync(deletedPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      invalidateParsedSession(deletedPath);
      invalidateSessionPathCache(deletedId);
    }
    invalidateSessionListCache([...deletedPaths.values(), ...reparentedPaths]);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
