import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const {
  TOOL_SELECTION_TYPE,
  appendClearedSessionToolSelection,
  appendSessionToolSelection,
  readSessionToolSelection,
  validateSessionToolSelection,
} = await createJiti(import.meta.url).import("./session-tool-selection.ts");

function entry(data, customType = TOOL_SELECTION_TYPE) {
  return {
    type: "custom",
    customType,
    data,
    id: Math.random().toString(16),
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
  };
}

test("a missing tool-selection entry identifies a legacy session", () => {
  assert.equal(readSessionToolSelection([]), undefined);
  assert.equal(readSessionToolSelection([entry({ version: 1, tools: [] }, "other")]), undefined);
});

test("version 1 selections restore as extension-inclusive selections", () => {
  assert.deepEqual(
    readSessionToolSelection([entry({ version: 1, tools: [] })]),
    { mode: "inclusive", tools: [] },
  );
  assert.deepEqual(
    readSessionToolSelection([entry({ version: 1, tools: ["bash", "read", "bash"] })]),
    { mode: "inclusive", tools: ["bash", "read"] },
  );
});

test("version 2 preserves exact extension tool names", () => {
  assert.deepEqual(
    readSessionToolSelection([entry({
      version: 2,
      mode: "exact",
      tools: ["read", "browser_snapshot", "read"],
    })]),
    { mode: "exact", tools: ["read", "browser_snapshot"] },
  );
});

test("the newest valid selection wins and malformed newer entries are ignored", () => {
  const entries = [
    entry({ version: 1, tools: ["read"] }),
    entry({ version: 2, mode: "unknown", tools: [] }),
    entry({ version: 2, mode: "exact", tools: ["read", ""] }),
    entry({ version: 2, mode: "exact", tools: ["bash", "browser_snapshot"] }),
  ];
  assert.deepEqual(readSessionToolSelection(entries), {
    mode: "exact",
    tools: ["bash", "browser_snapshot"],
  });

  entries.push(entry({ version: 2, mode: "exact", tools: "read" }));
  assert.deepEqual(readSessionToolSelection(entries), {
    mode: "exact",
    tools: ["bash", "browser_snapshot"],
  });
});

test("inclusive selections still accept only built-in tools", () => {
  assert.deepEqual(validateSessionToolSelection(["read", "write", "read"]), ["read", "write"]);
  assert.throws(() => validateSessionToolSelection(["read", "extension-tool"]), /built-in tool names/);
  assert.throws(() => validateSessionToolSelection(undefined), /built-in tool names/);
  assert.equal(readSessionToolSelection([entry({
    version: 2,
    mode: "inclusive",
    tools: ["read", "extension-tool"],
  })]), undefined);
});

test("appending selections writes the version 2 policy", () => {
  const calls = [];
  const manager = { appendCustomEntry: (...args) => calls.push(args) };
  appendSessionToolSelection(manager, [], "inclusive");
  appendSessionToolSelection(manager, ["read", "browser_snapshot"], "exact");
  assert.deepEqual(calls, [
    [TOOL_SELECTION_TYPE, { version: 2, mode: "inclusive", tools: [] }],
    [TOOL_SELECTION_TYPE, { version: 2, mode: "exact", tools: ["read", "browser_snapshot"] }],
  ]);
});

test("a cleared entry retracts an earlier pin so the session follows configured defaults", () => {
  const pinned = [entry({ version: 1, tools: ["read", "bash"] })];
  assert.deepEqual(readSessionToolSelection(pinned), { mode: "inclusive", tools: ["read", "bash"] });

  assert.equal(readSessionToolSelection([...pinned, entry({ version: 1, cleared: true })]), undefined);

  // A pin made after the clear wins again: newest valid entry still decides.
  assert.deepEqual(
    readSessionToolSelection([
      ...pinned,
      entry({ version: 1, cleared: true }),
      entry({ version: 1, tools: ["read"] }),
    ]),
    { mode: "inclusive", tools: ["read"] },
  );

  // Only an explicit `cleared: true` counts, and only at version 1.
  assert.deepEqual(
    readSessionToolSelection([...pinned, entry({ version: 1, cleared: false })]),
    { mode: "inclusive", tools: ["read", "bash"] },
  );
  assert.deepEqual(
    readSessionToolSelection([...pinned, entry({ version: 2, cleared: true })]),
    { mode: "inclusive", tools: ["read", "bash"] },
  );
});

test("a cleared entry is not a usable tool selection", () => {
  assert.throws(() => validateSessionToolSelection({ cleared: true }), /built-in tool names/);
});

test("appending a clear writes the versioned custom entry", () => {
  const calls = [];
  appendClearedSessionToolSelection({
    appendCustomEntry: (...args) => calls.push(args),
  });
  assert.deepEqual(calls, [[TOOL_SELECTION_TYPE, { version: 1, cleared: true }]]);
});
