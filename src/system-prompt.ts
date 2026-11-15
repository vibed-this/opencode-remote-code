/** Remote context edits for OpenCode V2's keyed instruction sources. */
export interface RemotePromptContext {
  remoteRoot: string
  platform: "posix" | "windows"
  shellName: string
  shellHint: string
  isGitRepo: boolean
  /** Contents of <remoteRoot>/AGENTS.md, read over SFTP during setup. */
  agentsMd?: string
}

interface InstructionSource {
  key: string
  text: string
}

interface SystemPart {
  text: string
  metadata?: Record<string, unknown>
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function instructionSources(part: SystemPart): InstructionSource[] | undefined {
  const experimental = part.metadata?.experimental
  if (!record(experimental)) return
  const sources = experimental.instructions
  if (!Array.isArray(sources) || !sources.every((source) =>
    record(source) && typeof source.key === "string" && typeof source.text === "string"
  )) return
  return sources
}

function remoteEnvironment(ctx: RemotePromptContext): string {
  return [
    "Here is some useful information about the remote environment:",
    "<env>",
    `  Working directory: ${ctx.remoteRoot}`,
    `  Workspace root folder: ${ctx.remoteRoot}`,
    `  Platform: ${ctx.platform}`,
    `  Shell: ${ctx.shellName}`,
    `  Is directory a git repo: ${ctx.isGitRepo ? "yes" : "no"}`,
    "</env>",
    "",
    "The shell, glob, grep, read, write, edit and patch tools operate on the remote machine.",
    "Other tools and integrations retain their own execution environments.",
    "Use the remote environment above for these file and shell tools, including when older conversation",
    "messages describe the local session directory. Local instruction-file updates do not describe the remote project.",
    'Pass "path" to narrow "glob"/"grep" when possible: walking the whole remote workspace is slow and may be truncated.',
    ctx.platform === "windows"
      ? "Absolute remote paths can reach other volumes (e.g. D:/proj); paths outside the workspace may ask for permission."
      : "Absolute remote paths can reach outside the workspace (e.g. /srv/data); those paths may ask for permission.",
    ...(ctx.shellHint.trim() ? ["", ctx.shellHint.trim()] : []),
  ].join("\n")
}

function remoteInstructions(ctx: RemotePromptContext): string {
  const agents = ctx.agentsMd?.trim()
  if (!agents) return "No AGENTS.md was loaded from the remote workspace root."
  const root = ctx.remoteRoot.replace(/[/\\]+$/, "")
  return `Instructions from: ${root}/AGENTS.md\n${agents}`
}

/**
 * Preserve agent/model prompts and all unrelated instruction sources. V2 2.2.7+
 * exposes source metadata on the joined instructions part. Replace source text
 * in place instead of rebuilding the entire part, preserving other hooks' edits.
 * Metadata is a copy, so update it alongside the model-visible text.
 * Auxiliary requests without instruction sources are left alone.
 */
export function applyRemoteContext(system: SystemPart[], ctx: RemotePromptContext): boolean {
  let foundEnvironment = false
  for (const part of system) {
    const sources = instructionSources(part)
    if (!sources) continue
    const replacements = sources.map((source) => {
      if (source.key === "core/environment") {
        foundEnvironment = true
        return { ...source, text: remoteEnvironment(ctx) }
      }
      if (source.key === "core/instructions") return { ...source, text: remoteInstructions(ctx) }
      return source
    })
    if (replacements.every((source, index) => source === sources[index])) continue
    // When there are no local instruction files, core/instructions may be absent.
    if (sources.some((source) => source.key === "core/environment") &&
        !sources.some((source) => source.key === "core/instructions")) {
      const remote = { key: "core/instructions", text: remoteInstructions(ctx) }
      replacements.push(remote)
    }
    const original = sources.map((source) => source.text).join("\n\n")
    if (!original || !part.text.includes(original)) {
      throw new Error("Remote Code: instruction source text was changed by another hook")
    }
    part.text = part.text.replace(original, () => replacements.map((source) => source.text).join("\n\n"))
    part.metadata = {
      ...part.metadata,
      experimental: {
        ...(part.metadata!.experimental as Record<string, unknown>),
        instructions: replacements,
      },
    }
  }
  return foundEnvironment
}
