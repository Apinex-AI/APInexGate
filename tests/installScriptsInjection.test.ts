import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { db } from '../server/db.js'
import { buildInstallScript } from '../server/installScripts.js'

test('install scripts are resistant to OS command injection via model catalog and keys', () => {
  const markerFile = path.join(os.tmpdir(), `test-marker-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`)
  const keyMarker = path.join(os.tmpdir(), `test-key-marker-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`)

  // Inject a malicious model into database
  const evilId = `free/evil-$(touch ${markerFile})`
  const evilName = `!000-evil-$(touch ${markerFile})`
  const evilKey = `sk-test-$(touch ${keyMarker})-"with-quote&amp`

  db.prepare(`
    INSERT OR REPLACE INTO model_catalog (id, provider, name, context_window, input_price_micros, output_price_micros, status, tags_json, created_at)
    VALUES (?, 'test', ?, '128k', 0, 0, 'active', '[]', CURRENT_TIMESTAMP)
  `).run(evilId, evilName)

  try {
    const tools: Array<'codex' | 'claude' | 'opencode' | 'hermes' | 'claude-desktop'> = ['codex', 'claude', 'opencode', 'hermes', 'claude-desktop']

    for (const tool of tools) {
      // 1. Verify Windows script generation does not contain unescaped/expandable subexpressions
      const winScript = buildInstallScript(tool, 'windows')
      assert.doesNotMatch(winScript, /@"[\s\S]*?\$\([\s\S]*?"@/, `${tool} Windows script should not use expandable here-strings with $(...)`)
      assert.doesNotMatch(winScript, /Write-Host\s+"[^"]*\$\([^"]*"/, `${tool} Windows script should not use double-quoted Write-Host with $(...)`)

      // 2. Verify Unix script generation does not evaluate $(...) when run in bash
      const unixScript = buildInstallScript(tool, 'linux')
      assert.doesNotMatch(unixScript, /<<EOF[\s\S]*?\$\([\s\S]*?EOF/, `${tool} Unix script should not use unquoted heredocs with $(...)`)

      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), `home-${tool}-`))
      const scriptPath = path.join(tmpHome, 'install.sh')
      fs.writeFileSync(scriptPath, unixScript, { mode: 0o755 })

      // Run script in bash with malicious key and temporary HOME
      try {
        execFileSync('bash', [scriptPath, evilKey], {
          env: {
            PATH: process.env.PATH,
            HOME: tmpHome,
          },
          stdio: 'pipe',
        })
      } catch (_err: unknown) {
        // Some tools might fail at downstream steps, but should NOT execute either marker
      }

      // Assert marker files were NOT created!
      assert.equal(fs.existsSync(markerFile), false, `${tool} script executed command injection: model marker file was created!`)
      assert.equal(fs.existsSync(keyMarker), false, `${tool} script executed command injection: key marker file was created!`)

      // Clean up tmpHome
      fs.rmSync(tmpHome, { recursive: true, force: true })
    }
  } finally {
    // Clean up DB and marker files
    db.prepare('DELETE FROM model_catalog WHERE id = ?').run(evilId)
    if (fs.existsSync(markerFile)) {
      fs.unlinkSync(markerFile)
    }
    if (fs.existsSync(keyMarker)) {
      fs.unlinkSync(keyMarker)
    }
  }
})
