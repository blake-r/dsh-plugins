// Syntax-check every plugin entry file in the monorepo.
// Usage: node scripts/check.mjs
import { execSync } from 'node:child_process'
import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(new URL('..', import.meta.url)))
const packagesDir = join(root, 'packages')
let failed = false

for (const pkg of readdirSync(packagesDir)) {
  const srcDir = join(packagesDir, pkg, 'src')
  if (!existsSync(srcDir)) continue
  for (const file of readdirSync(srcDir)) {
    if (!/\.(js|mjs)$/.test(file)) continue
    const path = join(srcDir, file)
    try {
      execSync(`node --check "${path}"`, { stdio: 'pipe' })
      console.log(`ok   ${pkg}/src/${file}`)
    } catch (e) {
      failed = true
      console.error(`FAIL ${pkg}/src/${file}\n${e.stderr}`)
    }
  }
}

if (failed) {
  console.error('Syntax check failed.')
  process.exit(1)
}
console.log('All plugin entry files pass node --check.')
