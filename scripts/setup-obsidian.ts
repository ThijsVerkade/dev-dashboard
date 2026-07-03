/**
 * Stage the Obsidian "Local REST API" plugin into the Knowledge Brain vault so
 * the MCP server (used by the committed .mcp.json) is available. Idempotent —
 * safe to re-run, e.g. to update the plugin.
 *
 *   npm run obsidian:setup
 *   npm run obsidian:setup -- --force   # re-download plugin files
 *
 * After running: open ./brain in Obsidian, turn off Restricted Mode, enable
 * "Local REST API with MCP", turn on its Non-encrypted (HTTP) Server, copy the
 * API key, and add `export OBSIDIAN_API_KEY=<key>` to your shell. The committed
 * .mcp.json wires Claude Code to http://127.0.0.1:27123/mcp/ on next restart.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const PLUGIN_ID = 'obsidian-local-rest-api'
const RELEASE = 'https://github.com/coddingtonbear/obsidian-local-rest-api/releases/latest/download'
const ASSETS = ['main.js', 'manifest.json', 'styles.css']

const force = process.argv.includes('--force')
const brainDir = process.env.BRAIN_DIR || 'brain'
const obsidianDir = join(process.cwd(), brainDir, '.obsidian')
const pluginDir = join(obsidianDir, 'plugins', PLUGIN_ID)

async function download(name: string, dest: string): Promise<number> {
  const res = await fetch(`${RELEASE}/${name}`)
  if (!res.ok) throw new Error(`Failed to download ${name}: HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  writeFileSync(dest, buf)
  return buf.length
}

async function main(): Promise<void> {
  mkdirSync(pluginDir, { recursive: true })

  for (const asset of ASSETS) {
    const dest = join(pluginDir, asset)
    if (existsSync(dest) && !force) {
      console.log(`  ✓ ${asset} (present — pass --force to re-download)`)
      continue
    }
    console.log(`  ↓ ${asset} (${await download(asset, dest)} bytes)`)
  }

  // Enable the plugin in the vault's community-plugins list (idempotent).
  const cpPath = join(obsidianDir, 'community-plugins.json')
  let list: string[] = []
  if (existsSync(cpPath)) {
    try {
      const parsed = JSON.parse(readFileSync(cpPath, 'utf8'))
      if (Array.isArray(parsed)) list = parsed
    } catch {
      list = []
    }
  }
  if (!list.includes(PLUGIN_ID)) {
    list.push(PLUGIN_ID)
    writeFileSync(cpPath, JSON.stringify(list, null, 2) + '\n')
    console.log(`  + enabled ${PLUGIN_ID} in community-plugins.json`)
  } else {
    console.log(`  ✓ ${PLUGIN_ID} already enabled`)
  }

  console.log(`\nObsidian plugin staged in ${brainDir}/.obsidian/. Next steps:`)
  console.log(`  1. Open ./${brainDir} in Obsidian → Settings → Community plugins → turn off Restricted Mode`)
  console.log('  2. Enable "Local REST API with MCP", then enable its Non-encrypted (HTTP) Server')
  console.log('  3. Copy the API key → add `export OBSIDIAN_API_KEY=<key>` to your shell profile (e.g. ~/.zshrc)')
  console.log('  4. Restart Claude Code to load the obsidian MCP (config is committed in .mcp.json)')
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
