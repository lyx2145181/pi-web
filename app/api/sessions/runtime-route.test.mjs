import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const listRoute = await readFile(new URL("./route.ts", import.meta.url), "utf8");
const detailRoute = await readFile(new URL("./[id]/route.ts", import.meta.url), "utf8");
const contextRoute = await readFile(new URL("./[id]/context/route.ts", import.meta.url), "utf8");
const stateRoute = await readFile(new URL("./[id]/state/route.ts", import.meta.url), "utf8");
const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET: getSessionDetail } = await jiti.import("./[id]/route.ts");
const { GET: getSessionContext } = await jiti.import("./[id]/context/route.ts");
const { GET: getSessionMeta } = await jiti.import("./[id]/meta/route.ts");
const { GET: getSessionState } = await jiti.import("./[id]/state/route.ts");

test("session listing merges live registry snapshots and honors force refresh", () => {
  assert.match(listRoute, /searchParams\.get\("force"\) === "1"/);
  assert.match(listRoute, /listAllSessions\(\{\s*force,/);
  assert.match(listRoute, /attachSessionProjectInfo\(getRpcSessionInfos\(\)\)/);
  assert.match(listRoute, /mergeSessionLists\(persistedSessions, runtimeSessions\)/);
  assert.match(listRoute, /onTiming: \(stage, durationMs\) => timing\.record\(stage, durationMs\)/);
  assert.match(listRoute, /timing\.timeSync\("serialize"/);
  assert.match(listRoute, /"Cache-Control": "no-store"/);
});

test("session reads use the live SessionManager before requiring a JSONL path", () => {
  for (const source of [detailRoute, contextRoute]) {
    const liveLookup = source.indexOf("getRpcSession(id)");
    const pathLookup = source.indexOf("resolveSessionPath(id)");
    assert.ok(liveLookup >= 0);
    assert.ok(pathLookup > liveLookup);
    assert.match(source, /const diskSnapshot = liveRpc\s*\? null\s*:\s*await timing\.time\("parse", \(\) => getParsedSessionSnapshot/);
    assert.match(source, /liveRpc\?\.inner\.sessionManager/);
  }
});

test("live agent state is available before the session file is persisted", () => {
  const liveLookup = stateRoute.indexOf("getRpcSession(id)");
  const pathLookup = stateRoute.indexOf("resolveSessionPath(id)");
  assert.ok(liveLookup >= 0);
  assert.ok(pathLookup > liveLookup);
  assert.match(stateRoute, /if \(rpc\?\.isAlive\(\)\)/);
});

test("live detail and state routes work without a persisted JSONL file", async (t) => {
  const previousRegistry = globalThis.__piSessions;
  const id = "live-route-test";
  const timestamp = "2026-08-12T01:02:03.000Z";
  const entry = {
    type: "message",
    id: "u1",
    parentId: null,
    timestamp,
    message: { role: "user", content: "hello live" },
  };
  const secondEntry = {
    type: "message",
    id: "u2",
    parentId: entry.id,
    timestamp: "2026-08-12T01:02:04.000Z",
    message: { role: "user", content: "second live message" },
  };
  const sessionManager = {
    getHeader: () => ({ type: "session", id, cwd: "/tmp", timestamp }),
    getEntries: () => [entry, secondEntry],
    getLeafId: () => secondEntry.id,
    getTree: () => [],
    getSessionName: () => undefined,
    getSessionFile: () => `/tmp/pi-web-live-route-not-persisted-${process.pid}.jsonl`,
  };
  globalThis.__piSessions = new Map([[id, {
    isAlive: () => true,
    isRunning: () => true,
    inner: { sessionManager },
    sessionFile: sessionManager.getSessionFile(),
    sessionId: id,
    cwd: "/tmp",
    send: async () => ({ isStreaming: true }),
  }]]);
  t.after(() => {
    globalThis.__piSessions = previousRegistry;
  });

  const routeContext = { params: Promise.resolve({ id }) };
  const detailResponse = await getSessionDetail(
    new Request(`http://localhost/api/sessions/${id}`),
    routeContext,
  );
  const pagedResponse = await getSessionDetail(
    new Request(`http://localhost/api/sessions/${id}?tail=1`),
    routeContext,
  );
  const earlierResponse = await getSessionContext(
    new Request(`http://localhost/api/sessions/${id}/context?before=1&limit=1`),
    routeContext,
  );
  const invalidPageResponse = await getSessionContext(
    new Request(`http://localhost/api/sessions/${id}/context?tail=0`),
    routeContext,
  );
  const metaResponse = await getSessionMeta(
    new Request(`http://localhost/api/sessions/${id}/meta`),
    routeContext,
  );
  const stateResponse = await getSessionState(
    new Request(`http://localhost/api/sessions/${id}/state`),
    routeContext,
  );
  const detail = await detailResponse.json();
  const paged = await pagedResponse.json();
  const earlier = await earlierResponse.json();
  const meta = await metaResponse.json();

  assert.equal(detailResponse.status, 200);
  assert.match(detailResponse.headers.get("Server-Timing") ?? "", /session-read;dur=\d+\.\d/);
  assert.match(detailResponse.headers.get("Server-Timing") ?? "", /context;dur=\d+\.\d/);
  assert.match(detailResponse.headers.get("Server-Timing") ?? "", /serialize;dur=\d+\.\d/);
  assert.match(detailResponse.headers.get("Server-Timing") ?? "", /total;dur=\d+\.\d/);
  assert.equal(detail.info.transient, true);
  assert.deepEqual(
    detail.context.messages.map((message) => message.content),
    ["hello live", "second live message"],
  );
  assert.equal(pagedResponse.status, 200);
  assert.deepEqual(paged.context.messages.map((message) => message.content), ["second live message"]);
  assert.deepEqual(paged.contextPage, {
    startIndex: 1,
    endIndex: 2,
    totalMessages: 2,
    hasEarlier: true,
  });
  assert.equal(paged.contextStats.totalMessages, 2);
  assert.deepEqual(paged.inputHistory, ["hello live", "second live message"]);
  assert.equal(earlierResponse.status, 200);
  assert.equal(invalidPageResponse.status, 400);
  assert.deepEqual(earlier.context.messages.map((message) => message.content), ["hello live"]);
  assert.deepEqual(earlier.page, {
    startIndex: 0,
    endIndex: 1,
    totalMessages: 2,
    hasEarlier: false,
  });
  assert.equal(metaResponse.status, 200);
  assert.equal(meta.session.id, id);
  assert.equal(meta.session.transient, true);
  assert.equal(typeof meta.session.projectKey, "string");
  assert.equal(stateResponse.status, 200);
  assert.deepEqual(await stateResponse.json(), {
    running: true,
    state: { isStreaming: true },
  });
});
