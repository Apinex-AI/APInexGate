import { db } from './db.js'
import { apiBaseUrl, apiOrigin, brandSlug, siteName, siteUrl } from '../shared/brand.js'

export type InstallTool = 'cursor' | 'codex' | 'claude' | 'claude-desktop' | 'opencode' | 'hermes' | 'kimi'
export type InstallOs = 'macos' | 'linux' | 'windows'

const SITE_URL = () => siteUrl()
/** Origin only — Claude Code appends /v1/messages itself. */
const API_ORIGIN = () => apiOrigin()
/** OpenAI-compatible clients (Cursor, Codex, SDK) use .../v1 as base_url. */
const API_BASE = () => apiBaseUrl()
const NAME = () => siteName()
const SLUG = () => brandSlug()

type ModelSpec = { id: string; name: string }

function activeModelSpecs(limit = 12): ModelSpec[] {
  const rows = db
    .prepare(
      `SELECT id, name FROM model_catalog
       WHERE status = 'active'
       ORDER BY name ASC
       LIMIT ?`,
    )
    .all(limit) as Array<{ id: string; name: string }>
  if (rows.length > 0) return rows.map((row) => ({ id: row.id, name: row.name }))
  return [
    { id: 'free/glm-5.3-flash', name: 'GLM 5.3 Flash' },
    { id: 'gpt-5.6-terra', name: 'GPT 5.6 Terra' },
  ]
}

function defaultModelId(specs: ModelSpec[]) {
  return specs[0]?.id ?? 'free/glm-5.3-flash'
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function pyString(value: string) {
  return JSON.stringify(value)
}

export function isInstallTool(value: string): value is InstallTool {
  return value === 'cursor' || value === 'codex' || value === 'claude' || value === 'claude-desktop' || value === 'opencode' || value === 'hermes' || value === 'kimi'
}

export function resolveInstallOs(raw: string | undefined, userAgent: string | undefined): InstallOs {
  const explicit = (raw ?? '').toLowerCase()
  if (explicit === 'windows' || explicit === 'macos' || explicit === 'linux') return explicit
  if ((userAgent ?? '').toLowerCase().includes('windows')) return 'windows'
  if ((userAgent ?? '').toLowerCase().includes('mac')) return 'macos'
  return 'linux'
}

export function buildInstallScript(tool: InstallTool, os: InstallOs) {
  if (os === 'windows') return buildWindowsScript(tool)
  return buildUnixScript(tool)
}

function installEndpoint(tool: InstallTool, os?: InstallOs) {
  const site = SITE_URL()
  const q = new URLSearchParams({ tool })
  if (os) q.set('os', os)
  return `${site}/i?${q.toString()}`
}

function buildUnixScript(tool: InstallTool) {
  switch (tool) {
    case 'cursor':
      return cursorUnix()
    case 'codex':
      return codexUnix()
    case 'claude':
      return claudeCodeUnix()
    case 'claude-desktop':
      return claudeDesktopUnix()
    case 'opencode':
      return opencodeUnix()
    case 'kimi':
      return kimiUnix()
    case 'hermes':
      return hermesUnix()
  }
}

function buildWindowsScript(tool: InstallTool) {
  switch (tool) {
    case 'cursor':
      return cursorWindows()
    case 'codex':
      return codexWindows()
    case 'claude':
      return claudeCodeWindows()
    case 'claude-desktop':
      return claudeDesktopWindows()
    case 'opencode':
      return opencodeWindows()
    case 'kimi':
      return kimiWindows()
    case 'hermes':
      return hermesWindows()
  }
}

function cursorUnix() {
  const specs = activeModelSpecs()
  const baseUrl = API_BASE()
  const defaultModel = defaultModelId(specs)
  const modelSpecsPy = specs
    .map((spec) => `    (${pyString(spec.id)}, ${pyString(spec.name)}),`)
    .join('\n')
  const endpoint = installEndpoint('cursor')

  return `#!/usr/bin/env sh
set -eu
API_KEY="\${1:-\${API_KEY:-\${AM_KEY:-}}}"
if [ -z "$API_KEY" ]; then
  echo "Usage: bash <(curl -fsSL ${endpoint}) <YOUR_API_KEY>" >&2
  exit 1
fi
if command -v python3 >/dev/null 2>&1; then PY=python3
elif command -v python >/dev/null 2>&1; then PY=python
else echo "Python 3 is required to configure Cursor." >&2; exit 1
fi
API_KEY="$API_KEY" BASE_URL=${shellQuote(baseUrl)} DEFAULT_MODEL=${shellQuote(defaultModel)} "$PY" - <<'PY_SETUP'
import json
import os
import shutil
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

APP_STATE_KEY = "src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser"
OPENAI_KEY_ITEM = "cursorAuth/openAIKey"
SURFACES = [
    "cmd-k", "composer", "background-composer", "composer-ensemble",
    "plan-execution", "spec", "deep-search", "quick-agent",
]
MODEL_SPECS = [
${modelSpecsPy}
]

def fail(message):
    print(message, file=sys.stderr)
    raise SystemExit(1)

def resolve_state_db():
    env_path = os.environ.get("STATE_DB_PATH", "").strip()
    if env_path:
        return Path(env_path).expanduser()
    candidates = []
    appdata = os.environ.get("APPDATA")
    if appdata:
        candidates.append(Path(appdata) / "Cursor" / "User" / "globalStorage" / "state.vscdb")
    home = Path.home()
    candidates.append(home / ".config" / "Cursor" / "User" / "globalStorage" / "state.vscdb")
    candidates.append(home / "Library" / "Application Support" / "Cursor" / "User" / "globalStorage" / "state.vscdb")
    for c in candidates:
        if c.exists():
            return c
    return candidates[-1]

def read_item(cur, key):
    row = cur.execute("SELECT value FROM ItemTable WHERE key = ?", (key,)).fetchone()
    return row[0] if row else None

def upsert_item(cur, key, value):
    if cur.execute("SELECT 1 FROM ItemTable WHERE key = ?", (key,)).fetchone():
        cur.execute("UPDATE ItemTable SET value = ? WHERE key = ?", (value, key))
    else:
        cur.execute("INSERT INTO ItemTable(key, value) VALUES (?, ?)", (key, value))

def dedupe(items):
    seen, out = set(), []
    for it in items:
        if it not in seen:
            seen.add(it)
            out.append(it)
    return out

def custom_model(name, display):
    return {
        "name": name, "defaultOn": False, "parameterDefinitions": [], "variants": [],
        "legacySlugs": [], "idAliases": [], "supportsAgent": True, "supportsImages": True,
        "clientDisplayName": display, "serverModelName": name, "supportsNonMaxMode": True,
        "supportsPlanMode": True, "isUserAdded": True, "inputboxShortModelName": display,
        "supportsSandboxing": True, "namedModelSectionIndex": 1,
    }

def model_config(model_name):
    return {"modelName": model_name, "maxMode": False, "selectedModels": None}

api_key = os.environ.get("API_KEY", "").strip()
base_url = os.environ.get("BASE_URL", "").strip().rstrip("/")
default_model = os.environ.get("DEFAULT_MODEL", "").strip() or ${pyString(defaultModel)}

if not api_key:
    fail("${NAME()} API key is empty.")
if not base_url:
    fail("Base URL is empty.")

state_db = resolve_state_db()
if not state_db.exists():
    fail("Cursor state database not found: %s\\nOpen Cursor once, then re-run." % state_db)

ts = datetime.now().strftime("%Y%m%d-%H%M%S")
backup = state_db.with_name(state_db.name + ".bak." + ts)
shutil.copy2(state_db, backup)
for suffix in ("-wal", "-shm"):
    side = state_db.with_name(state_db.name + suffix)
    if side.exists():
        shutil.copy2(side, side.with_name(side.name + ".bak." + ts))

custom_models = [custom_model(n, d) for n, d in MODEL_SPECS]
custom_names = [m["name"] for m in custom_models]

try:
    conn = sqlite3.connect(str(state_db), timeout=10)
    cur = conn.cursor()
    cur.execute("PRAGMA busy_timeout = 10000")
    cur.execute("BEGIN IMMEDIATE")

    raw_state = read_item(cur, APP_STATE_KEY)
    if raw_state is None:
        fail("Cursor app state not found. Sign in to Cursor once, then re-run.")

    app_state = json.loads(raw_state)
    ai = app_state.setdefault("aiSettings", {})

    app_state["openAIBaseUrl"] = base_url
    app_state["useOpenAIKey"] = True

    ai["userAddedModels"] = dedupe((ai.get("userAddedModels") or []) + custom_names)
    ai["modelOverrideEnabled"] = dedupe((ai.get("modelOverrideEnabled") or []) + custom_names)
    ai["modelOverrideDisabled"] = [x for x in (ai.get("modelOverrideDisabled") or []) if x not in custom_names]

    by_name = {m["name"]: m for m in custom_models}
    merged, seen = [], set()
    for m in (app_state.get("availableDefaultModels2") or []):
        if not isinstance(m, dict):
            merged.append(m)
            continue
        nm = m.get("name")
        if not nm or nm in seen:
            continue
        merged.append(by_name.get(nm, m))
        seen.add(nm)
    for m in custom_models:
        if m["name"] not in seen:
            merged.append(m)
            seen.add(m["name"])
    app_state["availableDefaultModels2"] = merged

    mc = ai.setdefault("modelConfig", {})
    for surface in SURFACES:
        mc[surface] = model_config(default_model)

    for item_key, item_value in cur.execute("SELECT key, value FROM ItemTable WHERE key LIKE 'composerData:%'").fetchall():
        try:
            data = json.loads(item_value)
        except json.JSONDecodeError:
            continue
        data["modelConfig"] = model_config(default_model)
        upsert_item(cur, item_key, json.dumps(data, ensure_ascii=False, separators=(",", ":")))

    upsert_item(cur, APP_STATE_KEY, json.dumps(app_state, ensure_ascii=False, separators=(",", ":")))
    upsert_item(cur, OPENAI_KEY_ITEM, api_key)

    conn.commit()
    conn.close()
except sqlite3.OperationalError as error:
    fail("Failed to update Cursor. Fully quit Cursor and try again. Details: %s" % error)

print("Cursor configured for ${NAME()}.")
print("State DB: %s" % state_db)
print("Backup:   %s" % backup)
print("Base URL: %s" % base_url)
print("Default model: %s" % default_model)
print("Restart Cursor to load the models and key.")
PY_SETUP
`
}

function codexUnix() {
  const baseUrl = API_BASE()
  const model = defaultModelId(activeModelSpecs())
  const endpoint = installEndpoint('codex')
  return `#!/usr/bin/env bash
set -euo pipefail

KEY="\${1:-\${API_KEY:-\${AM_KEY:-}}}"
if [[ -z "$KEY" ]]; then
  echo "Usage: bash <(curl -fsSL ${endpoint}) <API_KEY>" >&2
  exit 1
fi

echo ""
echo "============================================================"
echo " ${NAME()} — connect Codex"
echo "============================================================"
echo ""
CODEX_DIR="\${HOME}/.codex"
mkdir -p "$CODEX_DIR"
BACKUP_DIR="\${CODEX_DIR}/backups/before-${SLUG()}-$(date +%Y%m%d-%H%M%S)-$$"
mkdir -p "$BACKUP_DIR"
[[ -f "$CODEX_DIR/config.toml" ]] && cp "$CODEX_DIR/config.toml" "$BACKUP_DIR/config.toml"
[[ -f "$CODEX_DIR/auth.json" ]] && cp "$CODEX_DIR/auth.json" "$BACKUP_DIR/auth.json"

cat > "$CODEX_DIR/config.toml" <<EOF
model = "${model}"
model_provider = "${SLUG()}"

[model_providers.${SLUG()}]
name = "${NAME()}"
base_url = "${baseUrl}"
wire_api = "responses"
requires_openai_auth = true
EOF

cat > "$CODEX_DIR/auth.json" <<EOF
{
  "auth_mode": "apikey",
  "OPENAI_API_KEY": "$KEY"
}
EOF

echo "Done. Config written to $CODEX_DIR"
echo "Backup: $BACKUP_DIR"
echo "Restart Codex."
`
}

function claudeCodeUnix() {
  // Claude Code always joins BASE + "/v1/messages". Do NOT include /v1 here.
  const baseUrl = API_ORIGIN()
  const specs = activeModelSpecs()
  const opus = specs.find((s) => /opus/i.test(s.id) || /opus/i.test(s.name))?.id ?? 'claude/opus-5'
  const sonnet =
    specs.find((s) => /sonnet/i.test(s.id) || /sonnet/i.test(s.name))?.id ??
    specs.find((s) => /claude/i.test(s.id))?.id ??
    'claude/sonnet-5'
  const haiku = specs.find((s) => s.id === 'gpt/5.6-terra')?.id ?? 'gpt/5.6-terra'
  const endpoint = installEndpoint('claude')
  return `#!/usr/bin/env bash
set -euo pipefail

KEY="\${1:-\${API_KEY:-\${AM_KEY:-}}}"
if [[ -z "$KEY" ]]; then
  echo "Usage: bash <(curl -fsSL ${endpoint}) <API_KEY>" >&2
  exit 1
fi

echo ""
echo "============================================================"
echo " ${NAME()} — connect Claude Code"
echo "============================================================"
echo ""
CLAUDE_DIR="\${HOME}/.claude"
mkdir -p "$CLAUDE_DIR"
SETTINGS="$CLAUDE_DIR/settings.json"
[[ -f "$SETTINGS" ]] && cp "$SETTINGS" "$SETTINGS.${SLUG()}.bak"

cat > "$SETTINGS" <<EOF
{
  "hasCompletedOnboarding": true,
  "env": {
    "ANTHROPIC_BASE_URL": "${baseUrl}",
    "ANTHROPIC_AUTH_TOKEN": "$KEY",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "${opus}",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "${sonnet}",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "${haiku}"
  }
}
EOF

echo "Done. Config written to $SETTINGS"
echo "ANTHROPIC_BASE_URL=${baseUrl}  (Claude Code calls ${baseUrl}/v1/messages)"
echo "Models: opus=${opus}  sonnet=${sonnet}  haiku=${haiku}"
echo "Fully quit and reopen Claude Code."
`
}

function claudeDesktopUnix() {
  const baseUrl = API_BASE()
  const endpoint = installEndpoint('claude-desktop')
  const profileId = 'a7e21c0e-9f4b-4d2e-8c11-${SLUG()}000001'
  return `#!/usr/bin/env bash
set -euo pipefail

KEY="\${1:-\${API_KEY:-\${AM_KEY:-}}}"
if [[ -z "$KEY" ]]; then
  echo "Usage: bash <(curl -fsSL ${endpoint}) <API_KEY>" >&2
  exit 1
fi

echo ""
echo "============================================================"
echo " ${NAME()} — connect Claude Desktop"
echo "============================================================"
echo ""
echo "Note: Claude Desktop gateway mode may require Anthropic-compatible"
echo "API. Prefer Cursor auto-setup if this profile does not activate."
echo ""
case "$(uname -s)" in
  Darwin) P3_ROOT="\${HOME}/Library/Application Support/Claude-3p"; P1_ROOT="\${HOME}/Library/Application Support/Claude" ;;
  *)      P3_ROOT="\${HOME}/.config/Claude-3p";                     P1_ROOT="\${HOME}/.config/Claude" ;;
esac
LIB="$P3_ROOT/configLibrary"
mkdir -p "$LIB" "$P1_ROOT"
umask 077

PROFILE="$LIB/${profileId}.json"
META="$LIB/_meta.json"
P1_CONFIG="$P1_ROOT/claude_desktop_config.json"

STATE="$LIB/.${SLUG()}-preinstall"
if [[ ! -f "$STATE" ]]; then
  : > "$STATE"
  for f in "$PROFILE" "$META" "$P1_CONFIG"; do
    if [[ -f "$f" ]]; then
      cp "$f" "$f.${SLUG()}.bak"
      printf '%s\\n' "$f" >> "$STATE"
    fi
  done
fi

cat > "$PROFILE" <<EOF
{
  "name": "${NAME()}",
  "baseURL": "${baseUrl}",
  "apiKey": "$KEY",
  "provider": "openai"
}
EOF

cat > "$META" <<EOF
{
  "appliedId": "${profileId}",
  "entries": [
    { "id": "${profileId}", "name": "${NAME()}" }
  ]
}
EOF

if command -v python3 >/dev/null 2>&1; then
  P1_CONFIG="$P1_CONFIG" python3 - <<'PY'
import json, os, pathlib
path = pathlib.Path(os.environ["P1_CONFIG"])
try:
    data = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(data, dict):
        data = {}
except Exception:
    data = {}
data["deploymentMode"] = "3p"
path.write_text(json.dumps(data, indent=2) + "\\n", encoding="utf-8")
PY
elif [[ ! -f "$P1_CONFIG" ]]; then
  printf '{\\n  "deploymentMode": "3p"\\n}\\n' > "$P1_CONFIG"
else
  echo "WARNING: python3 missing — add \\"deploymentMode\\": \\"3p\\" to $P1_CONFIG manually."
fi

echo "Done. Profile: $PROFILE"
echo "Fully quit Claude Desktop (Cmd+Q) and reopen."
`
}

function opencodeUnix() {
  const baseUrl = API_BASE()
  const specs = activeModelSpecs()
  const defaultModel = defaultModelId(specs)
  const modelsMap: Record<string, { name: string }> = {}
  for (const m of specs.slice(0, 12)) {
    modelsMap[m.id] = { name: m.name }
  }
  const configObj = {
    $schema: 'https://opencode.ai/config.json',
    model: `${SLUG()}/${defaultModel}`,
    provider: {
      [SLUG()]: {
        npm: '@ai-sdk/openai-compatible',
        name: NAME(),
        options: {
          baseURL: baseUrl,
          apiKey: '__API_KEY__',
        },
        models: modelsMap,
      },
    },
  }
  const jsonStr = JSON.stringify(configObj, null, 2)
    .replace('"$schema"', '"\\$schema"')
    .replace('"__API_KEY__"', '"$KEY"')
  const endpoint = installEndpoint('opencode')

  return `#!/usr/bin/env bash
set -euo pipefail

KEY="\${1:-\${API_KEY:-\${AM_KEY:-}}}"
if [[ -z "$KEY" ]]; then
  echo "Usage: bash <(curl -fsSL ${endpoint}) <API_KEY>" >&2
  exit 1
fi

echo ""
echo "============================================================"
echo " ${NAME()} — connect OpenCode"
echo "============================================================"
echo ""
OPENCODE_DIR="\${HOME}/.config/opencode"
mkdir -p "$OPENCODE_DIR"
CONFIG="$OPENCODE_DIR/opencode.json"
[[ -f "$CONFIG" ]] && cp "$CONFIG" "$CONFIG.${SLUG()}.bak"

cat > "$CONFIG" <<EOF
${jsonStr}
EOF

echo "Done. Config written to $CONFIG"
echo "Active model set to: ${SLUG()}/${defaultModel}"
echo "Run 'opencode' to start."
`
}

function psHeader(title: string) {
  return `$ErrorActionPreference = "Stop"
$Key = if ($env:API_KEY) { $env:API_KEY } elseif ($env:AM_KEY) { $env:AM_KEY } else { $null }
if (-not $Key) { Write-Error 'Set $env:API_KEY then: irm ${SITE_URL()}/i?os=windows&tool=… | iex'; exit 1 }
function Write-Utf8NoBom {
  param([Parameter(Mandatory=$true, Position=0)][string]$Path,
        [Parameter(ValueFromPipeline=$true)][string]$Content)
  process { [System.IO.File]::WriteAllText($Path, $Content, (New-Object System.Text.UTF8Encoding($false))) }
}
Write-Host ""
Write-Host "${NAME()} — ${title}"
Write-Host ""
`
}

function cursorWindows() {
  const specs = activeModelSpecs()
  const baseUrl = API_BASE()
  const defaultModel = defaultModelId(specs)
  return `${psHeader('connect Cursor')}
$py = Get-Command python3 -ErrorAction SilentlyContinue
if (-not $py) { $py = Get-Command python -ErrorAction SilentlyContinue }
if (-not $py) { Write-Error 'Python 3 is required to configure Cursor on Windows.'; exit 1 }

$env:API_KEY = $Key
$env:BASE_URL = '${baseUrl}'
$env:DEFAULT_MODEL = '${defaultModel}'
$env:MODELS_JSON = @'
${JSON.stringify(specs)}
'@

$script = @'
import json, os, shutil, sqlite3, sys
from datetime import datetime
from pathlib import Path
APP_STATE_KEY = "src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser"
OPENAI_KEY_ITEM = "cursorAuth/openAIKey"
SURFACES = ["cmd-k","composer","background-composer","composer-ensemble","plan-execution","spec","deep-search","quick-agent"]
MODEL_SPECS = [(m["id"], m["name"]) for m in json.loads(os.environ["MODELS_JSON"])]
def fail(m):
    print(m, file=sys.stderr); raise SystemExit(1)
def resolve_state_db():
    appdata = os.environ.get("APPDATA")
    if not appdata: fail("APPDATA is not set")
    return Path(appdata) / "Cursor" / "User" / "globalStorage" / "state.vscdb"
def read_item(cur, key):
    row = cur.execute("SELECT value FROM ItemTable WHERE key = ?", (key,)).fetchone()
    return row[0] if row else None
def upsert_item(cur, key, value):
    if cur.execute("SELECT 1 FROM ItemTable WHERE key = ?", (key,)).fetchone():
        cur.execute("UPDATE ItemTable SET value = ? WHERE key = ?", (value, key))
    else:
        cur.execute("INSERT INTO ItemTable(key, value) VALUES (?, ?)", (key, value))
def dedupe(items):
    seen, out = set(), []
    for it in items:
        if it not in seen:
            seen.add(it); out.append(it)
    return out
def custom_model(name, display):
    return {"name": name, "defaultOn": False, "parameterDefinitions": [], "variants": [], "legacySlugs": [], "idAliases": [], "supportsAgent": True, "supportsImages": True, "clientDisplayName": display, "serverModelName": name, "supportsNonMaxMode": True, "supportsPlanMode": True, "isUserAdded": True, "inputboxShortModelName": display, "supportsSandboxing": True, "namedModelSectionIndex": 1}
def model_config(model_name):
    return {"modelName": model_name, "maxMode": False, "selectedModels": None}
api_key = os.environ["API_KEY"].strip()
base_url = os.environ["BASE_URL"].strip().rstrip("/")
default_model = os.environ.get("DEFAULT_MODEL", "").strip() or MODEL_SPECS[0][0]
state_db = resolve_state_db()
if not state_db.exists(): fail("Cursor state DB not found. Open Cursor once, then re-run.")
ts = datetime.now().strftime("%Y%m%d-%H%M%S")
backup = state_db.with_name(state_db.name + ".bak." + ts)
shutil.copy2(state_db, backup)
custom_models = [custom_model(n, d) for n, d in MODEL_SPECS]
custom_names = [m["name"] for m in custom_models]
conn = sqlite3.connect(str(state_db), timeout=10)
cur = conn.cursor()
cur.execute("BEGIN IMMEDIATE")
raw_state = read_item(cur, APP_STATE_KEY)
if raw_state is None: fail("Cursor app state missing. Sign in once.")
app_state = json.loads(raw_state)
ai = app_state.setdefault("aiSettings", {})
app_state["openAIBaseUrl"] = base_url
app_state["useOpenAIKey"] = True
ai["userAddedModels"] = dedupe((ai.get("userAddedModels") or []) + custom_names)
ai["modelOverrideEnabled"] = dedupe((ai.get("modelOverrideEnabled") or []) + custom_names)
by_name = {m["name"]: m for m in custom_models}
merged, seen = [], set()
for m in (app_state.get("availableDefaultModels2") or []):
    if not isinstance(m, dict):
        merged.append(m); continue
    nm = m.get("name")
    if not nm or nm in seen: continue
    merged.append(by_name.get(nm, m)); seen.add(nm)
for m in custom_models:
    if m["name"] not in seen:
        merged.append(m); seen.add(m["name"])
app_state["availableDefaultModels2"] = merged
mc = ai.setdefault("modelConfig", {})
for surface in SURFACES:
    mc[surface] = model_config(default_model)
upsert_item(cur, APP_STATE_KEY, json.dumps(app_state, ensure_ascii=False, separators=(",", ":")))
upsert_item(cur, OPENAI_KEY_ITEM, api_key)
conn.commit(); conn.close()
print("Cursor configured for ${NAME()}.")
print("Backup:", backup)
print("Restart Cursor.")
'@
$tmp = Join-Path $env:TEMP ("${SLUG()}-cursor-" + [guid]::NewGuid().ToString() + ".py")
Write-Utf8NoBom $tmp $script
try { & $py.Source $tmp } finally { Remove-Item $tmp -ErrorAction SilentlyContinue }
`
}

function codexWindows() {
  const baseUrl = API_BASE()
  const model = defaultModelId(activeModelSpecs())
  return `${psHeader('connect Codex')}
$dir = Join-Path $env:USERPROFILE ".codex"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
@"
model = "${model}"
model_provider = "${SLUG()}"

[model_providers.${SLUG()}]
name = "${NAME()}"
base_url = "${baseUrl}"
wire_api = "responses"
requires_openai_auth = true
"@ | Write-Utf8NoBom (Join-Path $dir "config.toml")
@"
{
  "auth_mode": "apikey",
  "OPENAI_API_KEY": "$Key"
}
"@ | Write-Utf8NoBom (Join-Path $dir "auth.json")
Write-Host "Done. Config written to $dir. Restart Codex."
`
}

function claudeCodeWindows() {
  // Claude Code always joins BASE + "/v1/messages". Do NOT include /v1 here.
  const baseUrl = API_ORIGIN()
  const specs = activeModelSpecs()
  const opus = specs.find((s) => /opus/i.test(s.id) || /opus/i.test(s.name))?.id ?? 'claude/opus-5'
  const sonnet =
    specs.find((s) => /sonnet/i.test(s.id) || /sonnet/i.test(s.name))?.id ??
    specs.find((s) => /claude/i.test(s.id))?.id ??
    'claude/sonnet-5'
  const haiku = specs.find((s) => s.id === 'gpt/5.6-terra')?.id ?? 'gpt/5.6-terra'
  return `${psHeader('connect Claude Code')}
$dir = Join-Path $env:USERPROFILE ".claude"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$settings = Join-Path $dir "settings.json"
if (Test-Path $settings) { Copy-Item $settings "$settings.${SLUG()}.bak" -Force }
@"
{
  "hasCompletedOnboarding": true,
  "env": {
    "ANTHROPIC_BASE_URL": "${baseUrl}",
    "ANTHROPIC_AUTH_TOKEN": "$Key",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "${opus}",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "${sonnet}",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "${haiku}"
  }
}
"@ | Write-Utf8NoBom $settings
Write-Host "Done. ANTHROPIC_BASE_URL=${baseUrl} (Claude Code calls ${baseUrl}/v1/messages)"
Write-Host "Fully quit and reopen Claude Code."
`
}

function claudeDesktopWindows() {
  const baseUrl = API_BASE()
  const profileId = 'a7e21c0e-9f4b-4d2e-8c11-${SLUG()}000001'
  return `${psHeader('connect Claude Desktop')}
Write-Host "Note: Prefer Cursor auto-setup if Claude Desktop gateway does not pick this up."
$p3 = Join-Path $env:LOCALAPPDATA "Claude-3p"
$p1 = Join-Path $env:APPDATA "Claude"
$lib = Join-Path $p3 "configLibrary"
New-Item -ItemType Directory -Force -Path $lib | Out-Null
New-Item -ItemType Directory -Force -Path $p1 | Out-Null
$profilePath = Join-Path $lib "${profileId}.json"
$metaPath = Join-Path $lib "_meta.json"
$p1Config = Join-Path $p1 "claude_desktop_config.json"
@"
{
  "name": "${NAME()}",
  "baseURL": "${baseUrl}",
  "apiKey": "$Key",
  "provider": "openai"
}
"@ | Write-Utf8NoBom $profilePath
@"
{
  "appliedId": "${profileId}",
  "entries": [{ "id": "${profileId}", "name": "${NAME()}" }]
}
"@ | Write-Utf8NoBom $metaPath
$data = @{ deploymentMode = "3p" }
if (Test-Path $p1Config) {
  try { $existing = Get-Content $p1Config -Raw | ConvertFrom-Json } catch { $existing = $null }
  if ($existing) {
    $existing | Add-Member -NotePropertyName deploymentMode -NotePropertyValue "3p" -Force
    ($existing | ConvertTo-Json -Depth 20) | Write-Utf8NoBom $p1Config
  } else {
    ($data | ConvertTo-Json) | Write-Utf8NoBom $p1Config
  }
} else {
  ($data | ConvertTo-Json) | Write-Utf8NoBom $p1Config
}
Write-Host "Done. Fully quit Claude Desktop and reopen."
`
}

function opencodeWindows() {
  const specs = activeModelSpecs()
  const baseUrl = API_BASE()
  const defaultModel = defaultModelId(specs)
  const modelsMap: Record<string, { name: string }> = {}
  for (const m of specs.slice(0, 12)) {
    modelsMap[m.id] = { name: m.name }
  }
  const configObj = {
    $schema: 'https://opencode.ai/config.json',
    model: `${SLUG()}/${defaultModel}`,
    provider: {
      [SLUG()]: {
        npm: '@ai-sdk/openai-compatible',
        name: NAME(),
        options: {
          baseURL: baseUrl,
          apiKey: '__API_KEY__',
        },
        models: modelsMap,
      },
    },
  }
  const jsonTemplate = JSON.stringify(configObj, null, 2)

  return `${psHeader('connect OpenCode')}
$dir = Join-Path $env:USERPROFILE ".config\\opencode"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$configPath = Join-Path $dir "opencode.json"
if (Test-Path $configPath) { Copy-Item $configPath "$configPath.${SLUG()}.bak" -Force }
$jsonContent = @'
${jsonTemplate}
'@.Replace('__API_KEY__', $Key)
$jsonContent | Write-Utf8NoBom $configPath
Write-Host "Done. Config written to $configPath."
Write-Host "Active model set to: ${SLUG()}/${defaultModel}"
Write-Host "Run opencode in your terminal to start."
`
}

function hermesUnix() {
  const baseUrl = API_BASE()
  const specs = activeModelSpecs(24)
  const defaultModel = defaultModelId(specs)
  const yamlModels = specs.map((s) => `      - "${s.id}"`).join('\n')
  const endpoint = installEndpoint('hermes')

  return `#!/usr/bin/env bash
set -euo pipefail

KEY="\${1:-\${API_KEY:-\${AM_KEY:-}}}"
if [[ -z "$KEY" ]]; then
  echo "Usage: bash <(curl -fsSL ${endpoint}) <API_KEY>" >&2
  exit 1
fi

echo ""
echo "============================================================"
echo " ${NAME()} — connect Hermes"
echo "============================================================"
echo ""
H_DIR="\${HOME}/.hermes"
mkdir -p "$H_DIR"
[[ -f "$H_DIR/config.yaml" ]] && cp "$H_DIR/config.yaml" "$H_DIR/config.yaml.${SLUG()}.bak"

cat > "$H_DIR/config.yaml" <<EOF
custom_providers:
  - name: "${NAME()}"
    base_url: "${baseUrl}"
    key_env: "OPENAI_API_KEY"
    api_mode: "chat_completions"
    discover_models: false
    models:
${yamlModels}
model:
  default: "${defaultModel}"
  provider: "custom:${SLUG()}"
  base_url: "${baseUrl}"
  context_length: 1000000
EOF

touch "$H_DIR/.env"
cp "$H_DIR/.env" "$H_DIR/.env.${SLUG()}.bak" 2>/dev/null || true
grep -vE '^(OPENAI_API_KEY|OPENAI_BASE_URL)=' "$H_DIR/.env" > "$H_DIR/.env.tmp" 2>/dev/null || true
printf 'OPENAI_API_KEY=%s\nOPENAI_BASE_URL=%s\n' "$KEY" "${baseUrl}" >> "$H_DIR/.env.tmp"
mv "$H_DIR/.env.tmp" "$H_DIR/.env"

[[ -f "$H_DIR/auth.json" ]] && mv "$H_DIR/auth.json" "$H_DIR/auth.json.${SLUG()}.bak"

echo "Done. Config written to $H_DIR (backups: *.${SLUG()}.bak)."
echo "IMPORTANT: Fully quit Hermes (Quit / Cmd+Q, not just closing the window) and reopen it — otherwise changes won't apply."
`
}

function hermesWindows() {
  const specs = activeModelSpecs(24)
  const baseUrl = API_BASE()
  const defaultModel = defaultModelId(specs)
  const yamlModels = specs.map((s) => `      - "${s.id}"`).join('\n')

  return `${psHeader('connect Hermes')}
$dir = Join-Path $env:USERPROFILE ".hermes"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$configPath = Join-Path $dir "config.yaml"
if (Test-Path $configPath) { Copy-Item $configPath "$configPath.${SLUG()}.bak" -Force }
@"
custom_providers:
  - name: "${NAME()}"
    base_url: "${baseUrl}"
    key_env: "OPENAI_API_KEY"
    api_mode: "chat_completions"
    discover_models: false
    models:
${yamlModels}
model:
  default: "${defaultModel}"
  provider: "custom:${SLUG()}"
  base_url: "${baseUrl}"
  context_length: 1000000
"@ | Write-Utf8NoBom $configPath

$envPath = Join-Path $dir ".env"
if (Test-Path $envPath) { Copy-Item $envPath "$envPath.${SLUG()}.bak" -Force }
@"
OPENAI_API_KEY=$Key
OPENAI_BASE_URL=${baseUrl}
"@ | Write-Utf8NoBom $envPath

$auth = Join-Path $dir "auth.json"
if (Test-Path $auth) { Move-Item -Force $auth "$auth.${SLUG()}.bak" }
Write-Host "Done. Fully quit Hermes Desktop (Quit), then open it again."
`
}

const KIMI_MODELS = [
  { alias: '${SLUG()}/free/kimi-k3', id: 'free/kimi-k3', context: 1_000_000 },
  { alias: '${SLUG()}/gpt-6-sol', id: 'gpt-6-sol', context: 1_000_000 },
  { alias: '${SLUG()}/claude-opus-5.5', id: 'claude-opus-5.5', context: 1_000_000 },
  { alias: '${SLUG()}/grok-4.7', id: 'grok-4.7', context: 500_000 },
] as const

function kimiToml(keyExpression: string) {
  const models = KIMI_MODELS.map(
    (model) => `[models."${model.alias}"]
provider = "${SLUG()}"
model = "${model.id}"
max_context_size = ${model.context}
capabilities = ["tool_use", "thinking"]`,
  ).join('\n\n')
  return `default_model = "${SLUG()}/free/kimi-k3"

[providers.${SLUG()}]
type = "openai"
base_url = "${API_BASE()}"
api_key = "${keyExpression}"

${models}
`
}

function kimiUnix() {
  const endpoint = installEndpoint('kimi')
  return `#!/usr/bin/env bash
set -euo pipefail
KEY="\${1:-\${API_KEY:-}}"
if [ -z "$KEY" ]; then
  echo "Usage: bash <(curl -fsSL ${endpoint}) <YOUR_API_KEY>" >&2
  exit 1
fi
if ! command -v kimi >/dev/null 2>&1; then
  echo "Kimi Code CLI is not installed. Install it from https://www.kimi.com/code/docs/en/kimi-code-cli/guides/getting-started.html then run this script again." >&2
  exit 1
fi
DIR="\${KIMI_CODE_HOME:-$HOME/.kimi-code}"
mkdir -p "$DIR"
CONFIG="$DIR/config.toml"
if [ -f "$CONFIG" ]; then
  cp "$CONFIG" "$CONFIG.${SLUG()}.bak"
fi
umask 077
cat > "$CONFIG" <<'TOML_SETUP'
${kimiToml('$KEY')}
TOML_SETUP
if command -v python3 >/dev/null 2>&1; then PY=python3
else PY=python
fi
"$PY" - "$CONFIG" "$KEY" <<'PY'
import pathlib, sys
path, key = sys.argv[1], sys.argv[2]
file = pathlib.Path(path)
file.write_text(file.read_text().replace("$KEY", key))
PY
echo "Wrote $CONFIG"
echo "Models: free/kimi-k3, gpt-6-sol, claude-opus-5.5, grok-4.7"
echo "Try: kimi -p 'Reply with the single word pong' -m ${SLUG()}/gpt-6-sol"
`
}

function kimiWindows() {
  const endpoint = installEndpoint('kimi', 'windows')
  return `# ${NAME()} → Kimi Code CLI
#   irm "${endpoint}" | iex
#   Pass the key first: $env:API_KEY="sk-..."; irm "${endpoint}" | iex
$ErrorActionPreference = "Stop"
$key = $env:API_KEY
if (-not $key -and $args.Count -gt 0) { $key = $args[0] }
if (-not $key) {
  Write-Error "Set API_KEY to your sk- key, then run this script again."
}
if (-not (Get-Command kimi -ErrorAction SilentlyContinue)) {
  Write-Error "Kimi Code CLI is not installed. Install it, then run this script again. https://www.kimi.com/code/docs/en/kimi-code-cli/guides/getting-started.html"
}
$dir = if ($env:KIMI_CODE_HOME) { $env:KIMI_CODE_HOME } else { Join-Path $env:USERPROFILE ".kimi-code" }
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$configPath = Join-Path $dir "config.toml"
if (Test-Path $configPath) { Copy-Item $configPath "$configPath.${SLUG()}.bak" -Force }
$toml = @'
${kimiToml('$key')}
'@
$toml = $toml.Replace('$key', $key)
[System.IO.File]::WriteAllText($configPath, $toml)
Write-Host "Wrote $configPath"
Write-Host "Models: free/kimi-k3, gpt-6-sol, claude-opus-5.5, grok-4.7"
Write-Host "Try: kimi -p 'Reply with the single word pong' -m ${SLUG()}/gpt-6-sol"
`
}

export function installMeta() {
  const specs = activeModelSpecs()
  return {
    baseUrl: API_BASE(),
    siteUrl: SITE_URL(),
    defaultModel: defaultModelId(specs),
    models: specs,
    tools: [
      { id: 'cursor' as const, label: 'Cursor', support: 'full' as const },
      { id: 'opencode' as const, label: 'OpenCode', support: 'full' as const },
      { id: 'kimi' as const, label: 'Kimi Code CLI', support: 'full' as const },
      { id: 'codex' as const, label: 'Codex', support: 'full' as const },
      { id: 'claude' as const, label: 'Claude Code', support: 'full' as const },
      { id: 'claude-desktop' as const, label: 'Claude Desktop', support: 'experimental' as const },
    ],
  }
}
