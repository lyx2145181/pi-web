/** Resolve a login return path only when it stays on the current origin. */
export function safeLoginDestination(next: string | null, origin: string): string {
  if (!next?.startsWith("/")) return "/";
  try {
    const url = new URL(next, origin);
    // A leading slash is insufficient: the URL parser treats /\host and
    // /<TAB>/host as protocol-relative URLs pointing at another origin.
    return url.origin === origin ? url.href : "/";
  } catch {
    return "/";
  }
}
