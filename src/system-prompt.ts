/**
 * System prompt for remote mode (DESIGN-V3 §10).
 *
 * Supersedes `src/remote-system-prompt.ts` (V2), which did its own SSH round
 * trip (`cat AGENTS.md`) and assumed a POSIX remote. V3 has two rules here:
 *
 * 1. **No IO.** The caller has already probed the remote (platform, shell, git
 *    flag) and read `<workdir>/AGENTS.md` over SFTP; this module is a pure
 *    string builder, so it can be unit-tested and cannot hang a session.
 * 2. **Platform-aware.** On a Windows remote the model must not write
 *    `ls -la` / `cd x && y` / `cat`; `ctx.shellHint` (`RemoteDialect.promptHint()`)
 *    is appended as its own paragraph for exactly that reason.
 */
import { getProviderPrompt } from "./prompts/index.js"

export interface RemotePromptContext {
  modelID: string
  /** Canonical remote workdir. */
  remoteRoot: string
  platform: "posix" | "windows"
  /** "bash" | "PowerShell 5.1" | … */
  shellName: string
  /** Extra dialect instructions (`dialect.promptHint()`), empty for posix. */
  shellHint: string
  isGitRepo: boolean
  /** Contents of `<workdir>/AGENTS.md`, already read over SFTP by the caller. */
  agentsMd?: string
}

/**
 * `<workdir>/AGENTS.md` without doubling the separator: canonical remote paths
 * have no trailing slash except for the roots `"/"` and `"C:/"`.
 */
function joinRemoteFileName(root: string, name: string): string {
  const base = root.replace(/[/\\]+$/, "")
  return base === "" ? `/${name}` : `${base}/${name}`
}

function isPowerShell(shellName: string): boolean {
  return /powershell|pwsh/i.test(shellName)
}

/**
 * Build the replacement system prompt.
 *
 * Returns exactly one element, like V2: the whole prompt is a single text part
 * (the caller decides where to slot the preserved "title generator" part).
 * Stays `async` even though it does no IO — callers already `await` it, and that
 * keeps the signature stable if a future revision needs a round trip.
 */
export async function buildRemoteSystemPrompt(
  ctx: RemotePromptContext,
  originalSystem: string[]
): Promise<string[]> {
  // 1. Model-family prompt (unchanged V2 behaviour).
  const providerPrompt = getProviderPrompt(ctx.modelID)

  // 2. Remote environment block.
  const shellLine = isPowerShell(ctx.shellName)
    ? `  Shell: ${ctx.shellName} (use PowerShell syntax; path separators may be /)`
    : `  Shell: ${ctx.shellName}`

  const envBlock = [
    `You are powered by the model named ${ctx.modelID}.`,
    "Here is some useful information about the environment you are running in:",
    "<env>",
    `  Working directory: ${ctx.remoteRoot}`,
    `  Workspace root folder: ${ctx.remoteRoot}`,
    `  Platform: ${ctx.platform}`,
    shellLine,
    `  Is directory a git repo: ${ctx.isGitRepo ? "yes" : "no"}`,
    `  Today's date: ${new Date().toDateString()}`,
    "</env>",
  ].join("\n")

  // 3. Dialect instructions — the paragraph that stops `ls -la` on Windows.
  const shellHint = ctx.shellHint.trim()

  // 3b. Workspace-reach note. A remote workspace is frequently the login home
  //     (or a whole drive), and `glob`/`grep` default to walking it from the
  //     top: over SFTP that burns the traversal budget on unrelated trees. The
  //     model can do much better with a scoped `path`, and it can reach other
  //     volumes by absolute path — neither is guessable from the tool schemas.
  const reachHint = [
    `All file tools operate on the remote machine (${ctx.remoteRoot}) — there are no local tools in this session.`,
    `Pass "path" to narrow "glob"/"grep" whenever you know roughly where to look: they walk the workspace root by`,
    `default, which is slow and gets truncated on large trees (a login home or a whole drive).`,
    ctx.platform === "windows"
      ? `Any absolute path on the remote is reachable, including other volumes (e.g. 'D:/proj', 'F:/data');`
      : `Any absolute path on the remote is reachable (e.g. '/srv/data', '/etc').`,
    `paths outside the workspace may ask for permission.`,
  ].join("\n")

  // 4. Remote AGENTS.md (already fetched by the caller over SFTP).
  const agentsMd = (ctx.agentsMd ?? "").trim()
  const agentsSection =
    agentsMd === ""
      ? ""
      : `Instructions from: ${joinRemoteFileName(ctx.remoteRoot, "AGENTS.md")}\n${agentsMd}`

  // 5. Skills section carried over from the local prompt.
  const skillsSection = extractSkillsSection(originalSystem)

  const parts: string[] = [providerPrompt, envBlock]
  if (shellHint !== "") parts.push(shellHint)
  parts.push(reachHint)
  if (agentsSection !== "") parts.push(agentsSection)
  if (skillsSection !== undefined && skillsSection.trim() !== "") parts.push(skillsSection)

  return [parts.join("\n\n")]
}

/**
 * Skills are appended last by OpenCode, so we search the array from the END —
 * a model/tool description earlier in the prompt could otherwise contain the
 * same sentence and truncate the real section.
 */
function extractSkillsSection(system: string[]): string | undefined {
  for (let i = system.length - 1; i >= 0; i--) {
    const text = system[i]
    if (typeof text !== "string") continue
    const idx = text.lastIndexOf("Skills provide specialized instructions")
    if (idx !== -1) return text.slice(idx)
  }
  return undefined
}
