import { NextResponse } from "next/server";
import {
  attachSessionProjectInfo,
  getSessionListVersion,
  listAllSessions,
  mergeSessionLists,
} from "@/lib/session-reader";
import { createServerTiming } from "@/lib/server-timing";
import {
  getCompletionNotificationSuppressedRpcSessionIds,
  getRpcSessionInfos,
  getRunningRpcSessionIds,
} from "@/lib/rpc-manager";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const timing = createServerTiming();
  try {
    const force = new URL(req.url).searchParams.get("force") === "1";
    const persistedSessionsPromise = timing.time("session-list", () => listAllSessions({
      force,
      onTiming: (stage, durationMs) => timing.record(stage, durationMs),
    }));
    // Capture before awaiting: mutations during the scan still require a later refresh.
    const sessionListVersion = getSessionListVersion();
    const [persistedSessions, runtimeSessions] = await Promise.all([
      persistedSessionsPromise,
      timing.time("runtime-project", () => attachSessionProjectInfo(getRpcSessionInfos())),
    ]);
    const sessions = timing.timeSync("merge", () => mergeSessionLists(persistedSessions, runtimeSessions));
    const response = timing.timeSync("serialize", () => NextResponse.json(
      {
        sessions,
        sessionListVersion,
        runningSessionIds: getRunningRpcSessionIds(),
        completionNotificationSuppressedSessionIds: getCompletionNotificationSuppressedRpcSessionIds(),
      },
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
