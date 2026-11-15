import { Rpc } from "@opencode/plugin/rpc"

const session = { type: "string", minLength: 1 } as const
const sessionInput = { type: "object", properties: { sessionID: session }, required: ["sessionID"], additionalProperties: false } as const

/** Target values are ephemeral. agentSocket is a path on the OpenCode server. */
export interface RuntimeTarget {
  ssh?: string
  host?: string
  port?: number
  user?: string
  key?: string
  password?: string
  agentSocket?: string
  workdir?: string
  platform?: "auto" | "posix" | "windows"
  shell?: string
}
export interface RuntimeConnectInput { sessionID: string; target: RuntimeTarget }
export interface RuntimeSessionInput { sessionID: string }
export interface RuntimeStatus {
  sessionID: string
  phase: "local" | "connecting" | "connected" | "failed"
  workdir?: string
  platform?: string
  host?: string
  port?: number
  user?: string
}
export const RuntimeTargetSchema = {
  type: "object",
  properties: {
    ssh: { type: "string" }, host: { type: "string" }, port: { type: "integer", minimum: 1, maximum: 65535 },
    user: { type: "string" }, key: { type: "string" }, password: { type: "string" },
    agentSocket: { type: "string", minLength: 1 }, workdir: { type: "string" },
    platform: { enum: ["auto", "posix", "windows"] }, shell: { type: "string" },
  },
  additionalProperties: false,
} as const
const output = {
  type: "object", properties: {
    sessionID: session, phase: { enum: ["local", "connecting", "connected", "failed"] },
    workdir: { type: "string" }, platform: { type: "string" },
    host: { type: "string" }, port: { type: "integer" }, user: { type: "string" },
  }, required: ["sessionID", "phase"], additionalProperties: false,
} as const
const errors = { operation_failed: { type: "object", additionalProperties: false } } as const

export const RemoteRuntime = Rpc.define({
  id: "remote-code.runtime",
  events: {},
  methods: {
    connect: { input: { type: "object", properties: { sessionID: session, target: RuntimeTargetSchema }, required: ["sessionID", "target"], additionalProperties: false }, output, errors },
    status: { input: sessionInput, output, errors },
    disconnect: { input: sessionInput, output, errors },
  },
})
