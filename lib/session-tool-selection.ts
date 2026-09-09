import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { PRESET_FULL } from "./tool-presets";
import type { SessionEntry } from "./types";
import {
  type ToolActivationPolicy,
  validateExactToolNames,
} from "./tool-activation";

export const TOOL_SELECTION_TYPE = "pi-web:tool-selection";

export interface SessionToolSelection {
  mode: ToolActivationPolicy;
  tools: string[];
}

export type SessionToolSelectionData =
  | { version: 1; tools: string[] }
  | { version: 2; mode: ToolActivationPolicy; tools: string[] };

const BUILTIN_TOOL_NAMES = new Set(PRESET_FULL);

function parseInclusiveToolNames(value: unknown): string[] | undefined {
  if (
    !Array.isArray(value)
    || value.some((tool) => typeof tool !== "string" || !BUILTIN_TOOL_NAMES.has(tool))
  ) return undefined;
  return [...new Set(value as string[])];
}

function parseToolSelectionData(data: unknown): SessionToolSelection | undefined {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
  const candidate = data as { version?: unknown; mode?: unknown; tools?: unknown };

  if (candidate.version === 1) {
    const tools = parseInclusiveToolNames(candidate.tools);
    return tools === undefined ? undefined : { mode: "inclusive", tools };
  }

  if (candidate.version !== 2 || (candidate.mode !== "inclusive" && candidate.mode !== "exact")) {
    return undefined;
  }

  try {
    const tools = candidate.mode === "exact"
      ? validateExactToolNames(candidate.tools)
      : parseInclusiveToolNames(candidate.tools);
    return tools === undefined ? undefined : { mode: candidate.mode, tools };
  } catch {
    return undefined;
  }
}

/** Return the newest valid persisted selection. Undefined identifies legacy sessions. */
export function readSessionToolSelection(
  entries: readonly SessionEntry[],
): SessionToolSelection | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type !== "custom" || entry.customType !== TOOL_SELECTION_TYPE) continue;
    const selection = parseToolSelectionData(entry.data);
    if (selection !== undefined) return selection;
  }
  return undefined;
}

export function validateSessionToolSelection(tools: unknown): string[] {
  const parsed = parseInclusiveToolNames(tools);
  if (parsed === undefined) {
    throw new Error("toolNames must contain only built-in tool names");
  }
  return parsed;
}

export function appendSessionToolSelection(
  sessionManager: SessionManager,
  tools: readonly string[],
  mode: ToolActivationPolicy = "inclusive",
): void {
  sessionManager.appendCustomEntry(TOOL_SELECTION_TYPE, {
    version: 2,
    mode,
    tools: [...tools],
  } satisfies SessionToolSelectionData);
}
