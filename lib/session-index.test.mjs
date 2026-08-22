import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import packageJson from "../package.json" with { type: "json" };

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const {
  SESSION_INDEX_PROJECTION_VERSION,
  createSessionIndexCoordinator,
} = await jiti.import("./session-index.ts");

function writeSession(filePath) {
  writeFileSync(filePath, [
    JSON.stringify({
      type: "session",
      version: 3,
      id: "session",
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd: "/tmp/project",
    }),
    JSON.stringify({
      type: "message",
      id: "user",
      parentId: null,
      timestamp: "2026-01-01T00:00:01.000Z",
      message: { role: "user", content: "request" },
    }),
    "",
  ].join("\n"), { mode: 0o600 });
}

test("projection version is pinned to the installed SDK dependency", () => {
  assert.match(
    SESSION_INDEX_PROJECTION_VERSION,
    new RegExp(`sdk-${packageJson.dependencies["@earendil-works/pi-coding-agent"].replaceAll(".", "\\.")}$`),
  );
});

test("session index coordinator persists a reusable worker snapshot and refreshes changes", async (t) => {
  const agentDirectory = mkdtempSync(join(tmpdir(), "pi-web-session-index-"));
  t.after(() => rmSync(agentDirectory, { recursive: true, force: true }));
  const projectDirectory = join(agentDirectory, "sessions", "project");
  mkdirSync(projectDirectory, { recursive: true });
  const filePath = join(projectDirectory, "session.jsonl");
  writeSession(filePath);

  const originalSessionContent = readFileSync(filePath, "utf8");
  const firstCoordinator = createSessionIndexCoordinator(agentDirectory);
  const first = await firstCoordinator.getSnapshot();
  assert.equal(first.get(filePath)?.metadata?.messageCount, 1);
  await firstCoordinator.waitForPersistence();

  const restartedCoordinator = createSessionIndexCoordinator(agentDirectory);
  const restarted = await restartedCoordinator.getSnapshot();
  assert.equal(restarted.get(filePath)?.metadata?.firstMessage, "request");

  appendFileSync(filePath, `${JSON.stringify({
    type: "message",
    id: "assistant",
    parentId: "user",
    timestamp: "2026-01-01T00:00:02.000Z",
    message: { role: "assistant", provider: "test", model: "test", content: "answer" },
  })}\n`);
  const refreshed = await restartedCoordinator.forceRefresh();
  assert.equal(refreshed.get(filePath)?.metadata?.messageCount, 2);
  await restartedCoordinator.waitForPersistence();
  assert.equal(readFileSync(filePath, "utf8").startsWith(originalSessionContent), true);

  const indexPath = join(agentDirectory, "cache", "pi-web", "session-index-v1.json");
  writeFileSync(indexPath, "{truncated", { mode: 0o600 });
  const rebuiltCoordinator = createSessionIndexCoordinator(agentDirectory);
  const rebuilt = await rebuiltCoordinator.getSnapshot();
  assert.equal(rebuilt.get(filePath)?.metadata?.messageCount, 2);
  await rebuiltCoordinator.waitForPersistence();
  assert.doesNotThrow(() => JSON.parse(readFileSync(indexPath, "utf8")));
});
