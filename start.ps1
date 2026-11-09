# Restarts fomo locally: database first, then the app (which also runs the indexer).
# Keys are read from .env (copy .env.example to .env and fill it in). Logs: db.log, api.log
Set-Location $PSScriptRoot
if (-not (Test-Path .env)) { Write-Host "Create .env first (copy .env.example and fill it in)."; exit 1 }

# The local database only allows one connection, so always restart both together.
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'pglite-server|api\.ts' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep 2

function WaitPort($port, $name) {
  for ($i = 0; $i -lt 60; $i++) {
    if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) { Write-Host "$name is up"; return }
    Start-Sleep 1
  }
  Write-Host "$name didn't start; see the log file"; exit 1
}

Start-Process cmd -ArgumentList '/c', 'bun run db:local > db.log 2>&1' -WindowStyle Hidden
WaitPort 5434 "Database"
# Bun 1.2.x drops Postgres connections; pin a version known to work until `bun upgrade`
Start-Process cmd -ArgumentList '/c', 'npx -y bun@1.4.2 api.ts > api.log 2>&1' -WindowStyle Hidden
WaitPort 3000 "App"
Start-Process "http://localhost:3000"
