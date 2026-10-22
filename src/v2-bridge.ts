/**
 * Thin glue between the OpenCode V2 plugin context and the remote tools.
 *
 * The tools are deliberately framework-free (`{ name, description, input, execute }`
 * with a plain JSON Schema), so they only need two things from the V2 context:
 *
 *  1. the typed identity of the current tool call (`sessionID` / `messageID` / `id`),
 *  2. a way to ask for permission (`ctx.permission.assert`).
 *
 * Everything below is type-only except `createPermissionGateway`, which is
 * created once per plugin `setup()` and injected into every tool factory.
 */

import type { Plugin } from "@opencode/plugin"

type DefineInput = Parameters<typeof Plugin.define>[0]

/** The `ctx` object handed to `Plugin.define({ setup })`. */
export type PluginContext = Parameters<DefineInput["setup"]>[0]

export type PermissionDomain = PluginContext["permission"]

export type AssertInput = Parameters<PermissionDomain["assert"]>[0]

/**
 * Identifies the tool call that is asking for permission.
 * Structurally compatible with the V2 `ToolContext` (extra fields ignored).
 */
export interface ToolCallIdentity {
  readonly sessionID: AssertInput["sessionID"]
  readonly messageID: string
  readonly id: string
}

export interface PermissionRequest {
  /** V2 permission action (`read`, `edit`, `shell`, ...). V1 called this `permission`. */
  action: string
  /** V1 `patterns`. */
  resources: string[]
  /** V1 `always` — resources that should be remembered as "always allow". */
  save?: string[]
  metadata?: Record<string, unknown>
}

export type PermissionGateway = (
  identity: ToolCallIdentity,
  request: PermissionRequest
) => Promise<void>

/**
 * Build the `ctx.permission.assert` wrapper used by all tools.
 * This replaces V1's `ctx.ask({ permission, patterns, always, metadata })`.
 */
export function createPermissionGateway(permission: PermissionDomain): PermissionGateway {
  return async function assertPermission(identity, request) {
    if (!identity?.sessionID) {
      // Without a session we cannot evaluate permission rules; fail closed.
      throw new Error("Remote Code: permission check requires a session id")
    }
    // Optional keys are only added when present: V2 encodes `save`/`metadata`
    // as `optionalKey`, so an explicit `undefined` is not the same as omitting.
    await permission.assert({
      sessionID: identity.sessionID,
      action: request.action,
      resources: request.resources,
      ...(request.save ? { save: request.save } : {}),
      ...(request.metadata ? { metadata: request.metadata } : {}),
      source: {
        type: "tool",
        messageID: identity.messageID,
        id: identity.id,
      },
    } as AssertInput)
  }
}

/** What each tool `execute` resolves to (V2 `Tool.Result` subset we use). */
export interface RemoteToolResult {
  content: string
  metadata?: Record<string, any>
}

/**
 * The V2 tool shape, framework-free.
 *
 * `input` is a plain JSON Schema object (no zod, no effect Schema), which V2
 * accepts directly (`Tool.ValueSchema` includes `JsonSchema.JsonSchema`).
 */
export interface RemoteToolDefinition {
  name: string
  description: string
  input: Record<string, unknown>
  execute(input: any, context: ToolCallIdentity): Promise<RemoteToolResult>
}
