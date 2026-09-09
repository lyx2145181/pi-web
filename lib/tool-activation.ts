import type { AgentSessionLike } from "./pi-types";
import { resolveShellTools } from "./powershell-settings";

export const TOOL_ACTIVATION_POLICIES = ["inclusive", "exact"] as const;
export type ToolActivationPolicy = typeof TOOL_ACTIVATION_POLICIES[number];

const CODING_TOOL_NAMES = new Set([
  "read",
  "bash",
  "powershell",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
]);

export function validateToolActivationPolicy(value: unknown): ToolActivationPolicy {
  if (value === undefined || value === "inclusive") return "inclusive";
  if (value === "exact") return "exact";
  throw new Error('toolPolicy must be either "inclusive" or "exact"');
}

export function validateExactToolNames(value: unknown): string[] {
  if (
    !Array.isArray(value)
    || value.some((name) => typeof name !== "string" || name.length === 0 || name.trim() !== name)
  ) {
    throw new Error("toolNames must be an array of non-empty tool names for exact tool policy");
  }
  return [...new Set(value as string[])];
}

export function resolveRegisteredExactToolNames(
  session: Pick<AgentSessionLike, "getAllTools" | "settingsManager">,
  requestedToolNames: readonly string[],
): string[] {
  const availableToolNames = new Set(session.getAllTools().map((tool) => tool.name));
  return resolveShellTools(
    requestedToolNames,
    session.settingsManager.getDefaultTools(),
  ).filter((name) => availableToolNames.has(name));
}

/** Resolve the effective active set after every extension has registered its tools. */
export function resolveActiveToolNames(
  session: Pick<AgentSessionLike, "getAllTools" | "settingsManager">,
  requestedToolNames: readonly string[],
  policy: ToolActivationPolicy,
): string[] {
  if (requestedToolNames.length === 0) return [];

  const selectedToolNames = resolveShellTools(
    requestedToolNames,
    session.settingsManager.getDefaultTools(),
  );

  if (policy === "inclusive") {
    const extensionToolNames = session
      .getAllTools()
      .map((tool) => tool.name)
      .filter((name) => !CODING_TOOL_NAMES.has(name));
    return [...new Set([...selectedToolNames, ...extensionToolNames])];
  }

  const availableToolNames = new Set(session.getAllTools().map((tool) => tool.name));
  const unknownToolNames = selectedToolNames.filter((name) => !availableToolNames.has(name));
  if (unknownToolNames.length > 0) {
    throw new Error(`Unknown tools for exact tool policy: ${unknownToolNames.join(", ")}`);
  }
  return [...new Set(selectedToolNames)];
}
