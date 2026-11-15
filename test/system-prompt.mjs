import assert from "node:assert/strict"
import { applyRemoteContext } from "../dist/system-prompt.js"

const context = {
  remoteRoot: "/srv/project",
  platform: "posix",
  shellName: "bash",
  shellHint: "",
  isGitRepo: true,
  agentsMd: "Use the remote test runner. Keep $& literally.",
}

function fixture(includeInstructions = true) {
  // V2 source order: skills precede local instructions and environment.
  const sources = [
    { key: "core/codemode", text: "Code Mode catalog" },
    { key: "core/mcp", text: "MCP instructions" },
    { key: "core/references", text: "Reference guidance" },
    { key: "core/skills", text: "Skills provide specialized instructions\nAvailable skills" },
    ...(includeInstructions ? [{ key: "core/instructions", text: "Local AGENTS.md and configured instructions" }] : []),
    { key: "core/date", text: "Today's date: test-date" },
    { key: "core/environment", text: "Local workspace: /home/local; platform: linux" },
    { key: "entry/project", text: "Session instruction entry" },
  ]
  const agent = { type: "text", text: "Custom agent: review only", metadata: { custom: true } }
  const identity = { type: "text", text: "Current upstream model identity and provider" }
  const instructions = {
    type: "text",
    text: `Earlier hook prefix\n${sources.map((s) => s.text).join("\n\n")}\nEarlier hook suffix`,
    metadata: { custom: "keep", experimental: { other: true, instructions: sources } },
  }
  return { agent, identity, instructions, system: [agent, identity, instructions], sources }
}

const f = fixture()
const originals = structuredClone([f.agent, f.identity])
assert.equal(applyRemoteContext(f.system, context), true)
assert.deepEqual([f.agent, f.identity], originals)
assert.equal(f.system.length, 3)
assert.match(f.instructions.text, /Working directory: \/srv\/project/)
assert.match(f.instructions.text, /Instructions from: \/srv\/project\/AGENTS.md/)
assert.ok(f.instructions.text.includes("Keep $& literally."))
assert.doesNotMatch(f.instructions.text, /Local workspace|Local AGENTS/)
for (const source of f.sources.filter((s) => !["core/environment", "core/instructions"].includes(s.key))) {
  assert.ok(f.instructions.text.includes(source.text), source.key)
}
assert.ok(f.instructions.text.startsWith("Earlier hook prefix"))
assert.ok(f.instructions.text.endsWith("Earlier hook suffix"))
assert.equal(f.instructions.metadata.custom, "keep")
assert.equal(f.instructions.metadata.experimental.other, true)
assert.equal(f.sources.find((s) => s.key === "core/environment").text, "Local workspace: /home/local; platform: linux")
const once = structuredClone(f.system)
applyRemoteContext(f.system, context)
assert.deepEqual(f.system, once, "repeated application is idempotent")

const windows = fixture(false)
applyRemoteContext(windows.system, {
  ...context, remoteRoot: "C:/", platform: "windows", shellName: "PowerShell 5.1",
  shellHint: "Use PowerShell syntax.",
})
assert.match(windows.instructions.text, /Instructions from: C:\/AGENTS.md/)
assert.match(windows.instructions.text, /Use PowerShell syntax/)
assert.match(windows.instructions.text, /Platform: windows/)
const windowsOnce = structuredClone(windows.system)
applyRemoteContext(windows.system, {
  ...context, remoteRoot: "C:/", platform: "windows", shellName: "PowerShell 5.1",
  shellHint: "Use PowerShell syntax.",
})
assert.deepEqual(windows.system, windowsOnce)

const absent = fixture()
applyRemoteContext(absent.system, { ...context, agentsMd: undefined })
assert.match(absent.instructions.text, /No AGENTS.md was loaded/)
assert.doesNotMatch(absent.instructions.text, /Local AGENTS/)

const auxiliary = [{ text: "Summarize this conversation" }]
assert.equal(applyRemoteContext(auxiliary, context), false)
assert.deepEqual(auxiliary, [{ text: "Summarize this conversation" }])
const malformed = [{ text: "Preserve me", metadata: { experimental: { instructions: [null] } } }]
assert.equal(applyRemoteContext(malformed, context), false)
assert.equal(malformed[0].text, "Preserve me")

const conflicting = fixture()
conflicting.instructions.text = "Another hook replaced the instruction block"
assert.throws(() => applyRemoteContext(conflicting.system, context), /changed by another hook/)
assert.equal(conflicting.instructions.text, "Another hook replaced the instruction block")
console.log("PASS remote context: preserves V2 sources, agents and metadata; replaces remote context; handles auxiliary requests and conflicts")
