// Post-build step: copy the prompt template .txt files into dist/prompts.
// (No source rewriting is needed anymore: the V2 plugin imports nothing from a
//  local shim, every tool uses plain JSON Schema.)
const fs = require('fs')
const path = require('path')

const distDir = path.join(__dirname, '..', 'dist')
const promptsSrc = path.join(__dirname, '..', 'src', 'prompts')
const promptsDst = path.join(distDir, 'prompts')

if (fs.existsSync(promptsSrc)) {
  fs.mkdirSync(promptsDst, { recursive: true })
  const txtFiles = fs.readdirSync(promptsSrc).filter(f => f.endsWith('.txt'))
  for (const file of txtFiles) {
    fs.copyFileSync(path.join(promptsSrc, file), path.join(promptsDst, file))
    console.log(`[postbuild] Copied prompt ${file}`)
  }
}

console.log('[postbuild] Done')
