import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const {
  resolveActiveToolNames,
  resolveRegisteredExactToolNames,
  validateExactToolNames,
  validateToolActivationPolicy,
} = await createJiti(import.meta.url).import("./tool-activation.ts");

function session(toolNames) {
  return {
    getAllTools: () => toolNames.map((name) => ({ name })),
    settingsManager: { getDefaultTools: () => ["read", "bash", "edit", "write"] },
  };
}

test("exact policy activates only explicitly requested registered tools", () => {
  const active = resolveActiveToolNames(
    session(["read", "bash", "edit", "browser_snapshot", "web_search"]),
    ["read", "bash"],
    "exact",
  );
  assert.deepEqual(active, ["read", "bash"]);
});

test("pre-binding exact resolution keeps registered names and defers lazy names", () => {
  const active = resolveRegisteredExactToolNames(
    session(["read", "bash"]),
    ["read", "bash", "browser_snapshot"],
  );
  assert.deepEqual(active, ["read", "bash"]);
});

test("exact policy accepts selected extension tools without activating their siblings", () => {
  const active = resolveActiveToolNames(
    session(["read", "browser_snapshot", "browser_click", "web_search"]),
    ["read", "browser_snapshot"],
    "exact",
  );
  assert.deepEqual(active, ["read", "browser_snapshot"]);
});

test("exact policy rejects unknown tools instead of silently dropping them", () => {
  assert.throws(
    () => resolveActiveToolNames(session(["read"]), ["read", "missing_tool"], "exact"),
    /Unknown tools for exact tool policy: missing_tool/,
  );
});

test("inclusive policy preserves the existing extension-inclusive behavior", () => {
  const active = resolveActiveToolNames(
    session(["read", "bash", "edit", "browser_snapshot", "web_search"]),
    ["read", "bash"],
    "inclusive",
  );
  assert.deepEqual(active, ["read", "bash", "browser_snapshot", "web_search"]);
});

test("exact policy input is normalized and validated", () => {
  assert.equal(validateToolActivationPolicy(undefined), "inclusive");
  assert.equal(validateToolActivationPolicy("exact"), "exact");
  assert.throws(() => validateToolActivationPolicy("all"), /toolPolicy/);
  assert.deepEqual(validateExactToolNames(["read", "read", "browser_snapshot"]), ["read", "browser_snapshot"]);
  assert.throws(() => validateExactToolNames(["read", ""]), /non-empty tool names/);
});
