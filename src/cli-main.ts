#!/usr/bin/env node
import { runCLI } from "./cli.js"

try {
  process.exitCode = await runCLI(process.argv.slice(2))
} catch (error) {
  const message = error && typeof error === "object" && "message" in error && typeof error.message === "string"
    ? error.message : "Launch failed"
  console.error(`remote-opencode: ${message}`)
  process.exitCode = 1
}
