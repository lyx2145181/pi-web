import { configureHttpDispatcher } from "@/lib/http-dispatcher";
import { closeAllAgentEventStreams } from "@/lib/agent-event-stream";
import { recoverRoleMonitors } from "@/lib/role-tasks";

export function registerNodeInstrumentation(): void {
  configureHttpDispatcher();
  try { recoverRoleMonitors(); } catch (error) { console.error("[pi-web] role monitor recovery failed:", error); }

  // In production Next 16 answers SIGINT/SIGTERM with server.close() and waits
  // for every connection to end, without a timeout. SSE streams only end when
  // the client disconnects, so close them here or the process never exits.
  const shutdownStreams = () => closeAllAgentEventStreams();
  process.on("SIGINT", shutdownStreams);
  process.on("SIGTERM", shutdownStreams);
}
