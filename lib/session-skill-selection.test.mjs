import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true, moduleCache: true });
const {
  filterExactSkills,
  readSessionSkillSelection,
  validateExactSkillNames,
  validateSkillActivationPolicy,
  verifyExactSkillNames,
} = await jiti.import("./session-skill-selection.ts");

test("skill policy defaults to inclusive and validates exact", () => {
  assert.equal(validateSkillActivationPolicy(undefined), "inclusive");
  assert.equal(validateSkillActivationPolicy("exact"), "exact");
  assert.throws(() => validateSkillActivationPolicy("all"), /skillPolicy/);
});

test("exact skill names are de-duplicated and malformed values fail", () => {
  assert.deepEqual(validateExactSkillNames(["verify-project", "verify-project"]), ["verify-project"]);
  assert.throws(() => validateExactSkillNames(["verify-project", ""]), /skillNames/);
  assert.throws(() => validateExactSkillNames("verify-project"), /skillNames/);
});

test("exact filtering preserves requested skills only and rejects unknown names", () => {
  const base = {
    skills: [
      { name: "verify-project", description: "verify", filePath: "/verify/SKILL.md" },
      { name: "sync-project", description: "sync", filePath: "/sync/SKILL.md" },
    ],
    diagnostics: [],
  };
  assert.deepEqual(
    filterExactSkills(base, ["verify-project"]).skills.map((skill) => skill.name),
    ["verify-project"],
  );
  assert.throws(
    () => filterExactSkills(base, ["missing-skill"]),
    /Unknown skills for exact skill policy: missing-skill/,
  );
});

test("exact verification rejects missing and unexpected skills", () => {
  assert.deepEqual(verifyExactSkillNames(["verify-project"], ["verify-project"]), ["verify-project"]);
  assert.throws(
    () => verifyExactSkillNames(["verify-project", "sync-project"], ["verify-project"]),
    /unexpected=sync-project/,
  );
});

test("session persistence reads the newest valid exact selection", () => {
  const entries = [
    { type: "custom", customType: "pi-web:skill-selection", data: { version: 1, mode: "exact", skills: ["old"] } },
    { type: "custom", customType: "pi-web:skill-selection", data: { version: 1, mode: "exact", skills: ["verify-project"] } },
  ];
  assert.deepEqual(readSessionSkillSelection(entries), { mode: "exact", skills: ["verify-project"] });
  assert.equal(readSessionSkillSelection([
    { type: "custom", customType: "pi-web:skill-selection", data: { version: 2, mode: "exact", skills: [] } },
  ]), undefined);
});
