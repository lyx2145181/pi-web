import type { SessionIndexEntry } from "./session-index-core.mts";

export interface SessionIndexRefreshResult {
  entries: Map<string, SessionIndexEntry>;
}

export interface SessionIndexRefreshRequest {
  paths?: string[];
  previousEntries?: ReadonlyMap<string, SessionIndexEntry>;
}

type RefreshOperation = (
  onSnapshot: (entries: Map<string, SessionIndexEntry>) => void,
  request: SessionIndexRefreshRequest,
) => Promise<SessionIndexRefreshResult>;

type PersistOperation = (entries: ReadonlyMap<string, SessionIndexEntry>) => Promise<void>;

interface ActiveRefresh {
  generation: number;
  initial: Promise<ReadonlyMap<string, SessionIndexEntry>>;
  final: Promise<ReadonlyMap<string, SessionIndexEntry>>;
}

export class SessionIndexCoordinator {
  private generation = 0;
  private snapshot: ReadonlyMap<string, SessionIndexEntry> | null = null;
  private verifiedSnapshot: ReadonlyMap<string, SessionIndexEntry> | null = null;
  private activeRefresh: ActiveRefresh | null = null;
  private forcePromise: Promise<ReadonlyMap<string, SessionIndexEntry>> | null = null;
  private persistTail: Promise<void> = Promise.resolve();
  private freshRequired = false;
  private lastVerifiedAt = 0;
  private pendingFullRefresh = true;
  private readonly pendingPaths = new Set<string>();

  constructor(
    private readonly refresh: RefreshOperation,
    private readonly persist: PersistOperation,
    private readonly refreshIntervalMs = 30_000,
  ) {}

  invalidate(paths?: string[]): void {
    this.generation += 1;
    this.freshRequired = true;
    this.verifiedSnapshot = null;
    if (!paths || paths.length === 0 || !this.snapshot) {
      this.pendingFullRefresh = true;
      this.pendingPaths.clear();
      return;
    }
    if (!this.pendingFullRefresh) {
      for (const filePath of paths) this.pendingPaths.add(filePath);
    }
  }

  getVerifiedSnapshot(): ReadonlyMap<string, SessionIndexEntry> | null {
    return this.verifiedSnapshot;
  }

  getVerifiedSnapshotOrRefresh(): Promise<ReadonlyMap<string, SessionIndexEntry>> {
    if (this.verifiedSnapshot && !this.freshRequired) {
      if (Date.now() - this.lastVerifiedAt < this.refreshIntervalMs) {
        return Promise.resolve(this.verifiedSnapshot);
      }
      this.pendingFullRefresh = true;
      this.pendingPaths.clear();
    }
    return this.ensureRefresh().final;
  }

  async getSnapshot(): Promise<ReadonlyMap<string, SessionIndexEntry>> {
    if (!this.snapshot) return this.ensureRefresh().initial;
    if (this.freshRequired) return this.ensureRefresh().final;
    if (Date.now() - this.lastVerifiedAt >= this.refreshIntervalMs) {
      this.pendingFullRefresh = true;
      this.pendingPaths.clear();
      return this.ensureRefresh().final;
    }
    return this.snapshot;
  }

  forceRefresh(): Promise<ReadonlyMap<string, SessionIndexEntry>> {
    if (this.forcePromise) return this.forcePromise;
    this.invalidate();
    const forcePromise = this.ensureRefresh().final.finally(() => {
      if (this.forcePromise === forcePromise) this.forcePromise = null;
    });
    this.forcePromise = forcePromise;
    return forcePromise;
  }

  async waitForPersistence(): Promise<void> {
    await this.persistTail;
  }

  private ensureRefresh(): ActiveRefresh {
    if (this.activeRefresh?.generation === this.generation) return this.activeRefresh;

    const generation = this.generation;
    const fullRefresh = this.pendingFullRefresh || !this.snapshot;
    const refreshRequest: SessionIndexRefreshRequest = fullRefresh
      ? {}
      : {
          paths: [...this.pendingPaths],
          previousEntries: this.snapshot!,
        };
    this.pendingFullRefresh = false;
    this.pendingPaths.clear();
    let resolveInitial!: (entries: ReadonlyMap<string, SessionIndexEntry>) => void;
    let rejectInitial!: (error: unknown) => void;
    let initialSettled = false;
    const initial = new Promise<ReadonlyMap<string, SessionIndexEntry>>((resolve, reject) => {
      resolveInitial = resolve;
      rejectInitial = reject;
    });
    void initial.catch(() => undefined);
    const settleInitial = (entries: ReadonlyMap<string, SessionIndexEntry>) => {
      if (initialSettled) return;
      initialSettled = true;
      resolveInitial(entries);
    };

    const refresh = {} as ActiveRefresh;
    refresh.generation = generation;
    refresh.initial = initial;
    refresh.final = this.refresh((entries) => {
      if (generation !== this.generation || this.snapshot) return;
      this.snapshot = entries;
      settleInitial(entries);
    }, refreshRequest).then(async (result) => {
      if (generation !== this.generation) {
        const current = this.ensureRefresh();
        const entries = await current.final;
        settleInitial(entries);
        return entries;
      }

      this.snapshot = result.entries;
      this.verifiedSnapshot = result.entries;
      this.freshRequired = false;
      this.lastVerifiedAt = Date.now();
      settleInitial(result.entries);
      this.enqueuePersistence(result.entries);
      return result.entries;
    }).catch((error) => {
      if (!initialSettled) {
        initialSettled = true;
        rejectInitial(error);
      }
      throw error;
    }).finally(() => {
      if (this.activeRefresh === refresh) this.activeRefresh = null;
    });
    this.activeRefresh = refresh;
    return refresh;
  }

  private enqueuePersistence(entries: ReadonlyMap<string, SessionIndexEntry>): void {
    this.persistTail = this.persistTail
      .catch(() => undefined)
      .then(() => this.persist(entries));
    void this.persistTail.catch(() => undefined);
  }
}
