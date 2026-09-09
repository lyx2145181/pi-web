import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "./types";

export const SKILL_SELECTION_TYPE = "pi-web:skill-selection";

export type SkillActivationPolicy = "inclusive" | "exact";

export interface SessionSkillSelection {
  mode: "exact";
  skills: string[];
}

type SkillLike = {
  name: string;
  description: string;
  filePath: string;
};

type SkillLoadResult<T extends SkillLike = SkillLike, D = unknown> = {
  skills: T[];
  diagnostics: D[];
};

export function validateSkillActivationPolicy(value: unknown): SkillActivationPolicy {
  if (value === undefined || value === "inclusive") return "inclusive";
  if (value === "exact") return "exact";
  throw new Error(`Invalid skillPolicy: ${String(value)}`);
}

export function validateExactSkillNames(value: unknown): string[] {
  if (
    !Array.isArray(value)
    || value.some((name) => typeof name !== "string" || name.trim() === "")
  ) {
    throw new Error("skillNames must be an array of non-empty skill names");
  }
  return [...new Set(value as string[])];
}

function parseSelectionData(data: unknown): SessionSkillSelection | undefined {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
  const candidate = data as { version?: unknown; mode?: unknown; skills?: unknown };
  if (candidate.version !== 1 || candidate.mode !== "exact") return undefined;
  try {
    return { mode: "exact", skills: validateExactSkillNames(candidate.skills) };
  } catch {
    return undefined;
  }
}

/** Return the newest valid exact selection. Undefined preserves legacy inclusive discovery. */
export function readSessionSkillSelection(
  entries: readonly SessionEntry[],
): SessionSkillSelection | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type !== "custom" || entry.customType !== SKILL_SELECTION_TYPE) continue;
    const selection = parseSelectionData(entry.data);
    if (selection !== undefined) return selection;
  }
  return undefined;
}

export function filterExactSkills<T extends SkillLike, D>(
  base: SkillLoadResult<T, D>,
  requestedNames: readonly string[],
): SkillLoadResult<T, D> {
  const requested = new Set(requestedNames);
  const available = new Set(base.skills.map((skill) => skill.name));
  const missing = [...requested].filter((name) => !available.has(name)).sort();
  if (missing.length > 0) {
    throw new Error(`Unknown skills for exact skill policy: ${missing.join(", ")}`);
  }
  return {
    skills: base.skills.filter((skill) => requested.has(skill.name)),
    diagnostics: base.diagnostics,
  };
}

export function verifyExactSkillNames(
  actualNames: readonly string[],
  requestedNames: readonly string[],
): string[] {
  const actual = [...new Set(actualNames)].sort();
  const requested = [...new Set(requestedNames)].sort();
  const missing = requested.filter((name) => !actual.includes(name));
  const unexpected = actual.filter((name) => !requested.includes(name));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `Exact skill selection mismatch: missing=${missing.join(",")}; unexpected=${unexpected.join(",")}`,
    );
  }
  return actual;
}

export function appendSessionSkillSelection(
  sessionManager: SessionManager,
  skillNames: readonly string[],
): void {
  sessionManager.appendCustomEntry(SKILL_SELECTION_TYPE, {
    version: 1,
    mode: "exact",
    skills: [...skillNames],
  });
}
