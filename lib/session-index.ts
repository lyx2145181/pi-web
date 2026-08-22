import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { SessionIndexCoordinator } from "./session-index-coordinator";
import { indexedSessionMetadata, type IndexedSessionMetadata, type SessionIndexEntry } from "./session-index-core.mts";
import { defaultSessionIndexPath } from "./session-index-store.mts";
import {
  persistSessionIndexInWorker,
  runSessionIndexWorker,
} from "./session-index-worker-client";

export const SESSION_INDEX_PROJECTION_VERSION = "pi-web-session-list-v1-sdk-0.84.2";
const SESSION_INDEX_COORDINATOR_VERSION = 8;

interface GlobalSessionIndexState {
  version: number;
  coordinator: SessionIndexCoordinator;
}

declare global {
  var __piSessionIndexState: GlobalSessionIndexState | undefined;
}

export function createSessionIndexCoordinator(agentDirectory: string): SessionIndexCoordinator {
  const indexPath = defaultSessionIndexPath(agentDirectory);
  const sessionsDirectory = join(agentDirectory, "sessions");
  return new SessionIndexCoordinator(
    (onSnapshot, request) => runSessionIndexWorker({
      indexPath,
      paths: request.paths,
      previousEntries: request.previousEntries,
      projectionVersion: SESSION_INDEX_PROJECTION_VERSION,
      sessionsDirectory,
      onSnapshot,
    }),
    (entries) => persistSessionIndexInWorker({
      indexPath,
      projectionVersion: SESSION_INDEX_PROJECTION_VERSION,
    }, entries),
  );
}

function getCoordinator(): SessionIndexCoordinator {
  const existing = globalThis.__piSessionIndexState;
  if (existing?.version === SESSION_INDEX_COORDINATOR_VERSION) return existing.coordinator;
  const coordinator = createSessionIndexCoordinator(getAgentDir());
  globalThis.__piSessionIndexState = {
    version: SESSION_INDEX_COORDINATOR_VERSION,
    coordinator,
  };
  return coordinator;
}

export async function getIndexedSessionMetadata(
  options: { force?: boolean } = {},
): Promise<IndexedSessionMetadata[]> {
  const coordinator = getCoordinator();
  const entries = options.force
    ? await coordinator.forceRefresh()
    : await coordinator.getSnapshot();
  return indexedSessionMetadata(entries);
}

export function invalidateSessionIndex(paths?: string[]): void {
  getCoordinator().invalidate(paths);
}

export function getVerifiedSessionIndexEntries(): ReadonlyMap<string, SessionIndexEntry> | null {
  return getCoordinator().getVerifiedSnapshot();
}

export async function getVerifiedIndexedSessionMetadata(): Promise<IndexedSessionMetadata[]> {
  return indexedSessionMetadata(await getCoordinator().getVerifiedSnapshotOrRefresh());
}
