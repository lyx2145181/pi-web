import { NextResponse } from "next/server";
import {
  attachSessionProjectInfo,
  listAllSessions,
  mergeSessionLists,
} from "@/lib/session-reader";
import { getRpcSessionInfos, getRunningRpcSessionIds } from "@/lib/rpc-manager";
import { createServerTiming } from "@/lib/server-timing";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const timing = createServerTiming();
  try {
    const force = new URL(req.url).searchParams.get("force") === "1";
    const [persistedSessions, runtimeSessions] = await Promise.all([
      timing.time("session-list", () => listAllSessions({
        force,
        onTiming: (stage, durationMs) => timing.record(stage, durationMs),
      })),
      timing.time("runtime-project", () => attachSessionProjectInfo(getRpcSessionInfos())),
    ]);
    const sessions = timing.timeSync("merge", () => mergeSessionLists(persistedSessions, runtimeSessions));
    const response = timing.timeSync("serialize", () => NextResponse.json(
      { sessions, runningSessionIds: getRunningRpcSessionIds() },
      { headers: { "Cache-Control": "no-store" } },
    ));
    return timing.finish(response);
  } catch (error) {
    return timing.finish(NextResponse.json(
      { error: String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    ));
  }
}
