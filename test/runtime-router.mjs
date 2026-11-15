import assert from "node:assert/strict"
import { RuntimeRouter } from "../dist/runtime-router.js"

const markers = new Set()
const router = new RuntimeRouter(async (id, remote) => remote ? markers.add(id) : markers.delete(id))
let localCalls = 0
let closed = 0
const local = async () => { localCalls++; return "local" }
const remote = async () => "remote"
const open = async () => ({ close: async () => { closed++ } })
const before = router.snapshot()
await router.connect("remote", open)
assert.equal(await router.route(before, "local", local, remote), "local")
await assert.rejects(router.route(before, "remote", local, remote), /Target changed/)
const connected = router.snapshot()
assert.equal(await router.route(connected, "remote", local, remote), "remote")
await assert.rejects(router.route(connected, "remote", local, async () => { throw Error("SSH lost") }), /SSH lost/)
assert.equal(localCalls, 1)
await router.connect("second", open)
assert.equal(await router.route(connected, "remote", local, remote), "remote")
await router.disconnect("remote")
assert.equal(closed, 1)
assert(!markers.has("remote"))
await assert.rejects(router.route(connected, "remote", local, remote), /Target changed/)
assert.equal(await router.route(router.snapshot(), "remote", local, remote), "local")
await router.connect("remote", open)
await assert.rejects(router.route(connected, "remote", local, remote), /Target changed/)
assert.equal(await router.route(router.snapshot(), "remote", local, remote), "remote")

await assert.rejects(router.connect("failed", async () => { throw Error("unreachable") }), /unreachable/)
assert.equal(router.status("failed"), "failed")
await assert.rejects(router.route(router.snapshot(), "failed", local, remote), /Local execution is blocked/)
assert(markers.has("failed"))
const restored = new RuntimeRouter()
restored.restore("failed")
await assert.rejects(restored.route(restored.snapshot(), "failed", local, remote), /blocked/)

let release
const running = router.route(router.snapshot(), "local", () => new Promise(resolve => { release = resolve }), remote)
await assert.rejects(router.connect("local", open), /still running/)
release()
await running

let finishConnect
const pending = router.connect("pending", () => new Promise(resolve => { finishConnect = resolve }))
await Promise.resolve()
await assert.rejects(router.disconnect("pending"), /still pending/)
const closing = router.close()
finishConnect(await open())
await assert.rejects(pending, /cancelled/)
await closing
assert.equal(closed, 4)
await assert.rejects(router.route(connected, "local", local, remote), /unavailable/)
const deletion = new RuntimeRouter()
let deletedClosed = 0
await deletion.connect("deleted", async () => ({ close: async () => { deletedClosed++ } }))
const deletedSnapshot = deletion.snapshot()
await deletion.forget("deleted")
assert.equal(deletedClosed, 1)
await assert.rejects(deletion.route(deletedSnapshot, "deleted", local, remote), /Target changed/)
await assert.rejects(deletion.route(deletion.snapshot(), "deleted", local, remote), /blocked/)
await deletion.close()
console.log("PASS runtime router: session isolation, failures, stale snapshots, disconnect, active calls, restart markers, cleanup")
