/**
 * Shared limits and ignore defaults for the remote tools (DESIGN-V3 §7.2, §9).
 *
 * These live in their own module so `config.ts` (which parses the `limits`
 * option) and `tools/*` (which consume the values) can share one shape without
 * a layering cycle between them.
 */

export interface ToolLimits {
  /** `glob` — maximum number of returned paths. */
  globResults: number
  /** `grep` — maximum number of matches. */
  searchMatches: number
  /** `grep` — total bytes read across all files before the search stops. */
  searchBytes: number
  /** `grep` — files larger than this are skipped without being read. */
  searchFileSize: number
  /** `grep` — wall-clock budget. */
  searchMillis: number
  /** `glob`/`grep` — traversal depth (the search root is depth 0). */
  walkDepth: number
  /** `glob`/`grep` — maximum number of directory entries visited. */
  walkEntries: number
  /** `shell` — default command timeout. */
  shellTimeout: number
}

export const DEFAULT_TOOL_LIMITS: Readonly<ToolLimits> = Object.freeze({
  globResults: 100,
  searchMatches: 100,
  searchBytes: 64 * 1024 * 1024,
  searchFileSize: 2 * 1024 * 1024,
  searchMillis: 20_000,
  walkDepth: 12,
  walkEntries: 20_000,
  shellTimeout: 120_000,
})

/**
 * Directory names never traversed by `glob`/`grep`. Matched case-insensitively
 * on Windows (handled by the caller through `RemotePathOps.kind`).
 */
export const DEFAULT_IGNORE: readonly string[] = Object.freeze([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "dist",
  "build",
  "out",
  "target",
  ".venv",
  "venv",
  "vendor",
  "__pycache__",
  ".next",
  ".cache",
  ".turbo",
])

/** Merge a user-supplied partial `limits` option over the defaults, ignoring junk. */
export function resolveLimits(partial?: Record<string, unknown> | undefined): ToolLimits {
  const merged: ToolLimits = { ...DEFAULT_TOOL_LIMITS }
  if (!partial || typeof partial !== "object") return merged

  for (const key of Object.keys(DEFAULT_TOOL_LIMITS) as Array<keyof ToolLimits>) {
    const raw = partial[key]
    const value = typeof raw === "string" ? Number(raw) : raw
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      merged[key] = Math.floor(value)
    }
  }
  return merged
}

/** The default ignore list, optionally extended (never replaced) by user entries. */
export function resolveIgnore(extra?: unknown): string[] {
  const names = new Set<string>(DEFAULT_IGNORE)
  if (Array.isArray(extra)) {
    for (const item of extra) {
      if (typeof item === "string" && item.trim() !== "") names.add(item.trim())
    }
  }
  return [...names]
}
