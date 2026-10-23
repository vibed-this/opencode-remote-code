// OpenCode v2 plugin entry (directory form).
//
// V2 resolves a local plugin **directory** to `<dir>/index.js` (or `<dir>/server.js`)
// and ignores `package.json` `main` / `exports` — see `PluginModule` in the v2 CLI.
// The real build output lives in `dist/`, so this file bridges to it. Keep it in
// sync with `dist/index.js` by re-exporting rather than duplicating anything.
export * from "./dist/index.js"
export { default } from "./dist/index.js"
