<# : fichier hybride (cmd + PowerShell) : double-cliquer suffit
@echo off
chcp 65001 >nul
set "KAREER_DIR=%~dp0"
echo Reparation et diagnostic de Kareer : patientez 2 a 5 minutes...
powershell -NoProfile -ExecutionPolicy Bypass -Command "iex ((Get-Content -LiteralPath '%~f0' -Raw))"
echo.
echo Termine. Ecrivez a Claude : "diagnostic envoye".
pause
exit /b
#>

# ---------------------------------------------------------------------------
# PowerShell : met le dossier sur la version fusionnee, teste l'application,
# puis envoie un rapport (sans secrets) sur une branche GitHub "diagnostic-...".
# Ne lit jamais le contenu de .env (seulement sa presence).
# ---------------------------------------------------------------------------
$ErrorActionPreference = 'Continue'
Set-Location -LiteralPath $env:KAREER_DIR
$branche = 'claude/peaceful-tesla-0655tn'
$report = New-Object System.Collections.Generic.List[string]
function Log($t) { Write-Host $t; $report.Add([string]$t) }
function Run($title, [scriptblock]$sb) {
  Log ""
  Log "=== $title"
  try { $out = & $sb 2>&1 | Out-String; Log $out.TrimEnd() } catch { Log "ERREUR : $_" }
}

Run 'Versions' { "node $(node -v)"; "npm $(npm -v)"; git --version; [Environment]::OSVersion.VersionString; "dossier : $(Get-Location)" }
Run 'Git avant' { git branch --show-current; git log --oneline -3; git status --short | Select-Object -First 30 }

Run 'Sauvegarde puis passage sur la version fusionnee' {
  git add -A
  git rm -r -q --cached --ignore-unmatch .env .env.local .env.production node_modules dist 2>$null
  git diff --cached --quiet
  if ($LASTEXITCODE -ne 0) {
    $s = Get-Date -Format yyyyMMdd-HHmm
    git checkout -q -B "version-locale-$s"
    git -c user.name=Imad -c user.email=arabiimad@outlook.com commit -q -m "Version locale ($s)"
    git push -q -u origin "version-locale-$s"
    "modifications locales sauvegardees sur version-locale-$s"
  }
  git fetch origin $branche
  git checkout -B $branche "origin/$branche"
  "branche actuelle : $(git branch --show-current)"
  git log --oneline -1
}

Run 'Fichiers de la version fusionnee' {
  'src/components/KareerLogo.tsx', 'server/atsCheck.ts', 'src/components/tools/ToolsView.tsx', 'src/components/AccountGate.tsx' |
    ForEach-Object { "$_ : $(Test-Path -LiteralPath $_)" }
  ".env present : $(Test-Path -LiteralPath .env)"
}

Run 'npm install' { npm install --no-audit --no-fund 2>&1 | Select-Object -Last 25 }
Run 'Verification des types (npm run lint)' { npm run lint 2>&1 | Select-Object -Last 30 }

Run 'Demarrage de test (30 s, port 3099)' {
  $env:PORT = '3099'
  $out = Join-Path $env:TEMP 'kareer-serveur.log'
  $err = Join-Path $env:TEMP 'kareer-serveur.err.log'
  $p = Start-Process -FilePath node -ArgumentList 'node_modules/tsx/dist/cli.mjs', 'server.ts' -WorkingDirectory (Get-Location) `
    -RedirectStandardOutput $out -RedirectStandardError $err -PassThru -WindowStyle Hidden
  $ok = $false
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Seconds 1
    try { Invoke-WebRequest -UseBasicParsing http://localhost:3099/api/health -TimeoutSec 2 | Out-Null; $ok = $true; break } catch {}
  }
  "api/health repond : $ok"
  if ($ok) {
    try {
      $h = Invoke-WebRequest -UseBasicParsing http://localhost:3099/ -TimeoutSec 30
      "page d'accueil : $($h.StatusCode) ; Kareer dans la page : $($h.Content -match 'Kareer')"
      $t = Invoke-WebRequest -UseBasicParsing http://localhost:3099/src/main.tsx -TimeoutSec 60
      "script de l'application : $($t.StatusCode)"
    } catch { "page : ERREUR $_" }
  }
  Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
  Remove-Item Env:PORT -ErrorAction SilentlyContinue
  '--- journal du serveur'
  if (Test-Path $out) { Get-Content $out -Tail 40 }
  if (Test-Path $err) { Get-Content $err -Tail 40 }
}

# Rapport envoye sur une branche a part, sans toucher a vos fichiers ni a votre branche
$file = Join-Path $env:TEMP 'diagnostic-kareer.txt'
($report -join "`r`n") | Set-Content -LiteralPath $file -Encoding UTF8
$blob = (git hash-object -w $file).Trim()
$idx = Join-Path $env:TEMP 'kareer-diagnostic.index'
$env:GIT_INDEX_FILE = $idx
git read-tree --empty
git update-index --add --cacheinfo "100644,$blob,diagnostic.txt"
$tree = (git write-tree).Trim()
Remove-Item Env:GIT_INDEX_FILE
Remove-Item -LiteralPath $idx -ErrorAction SilentlyContinue
$commit = (git -c user.name=Imad -c user.email=arabiimad@outlook.com commit-tree $tree -m "Diagnostic Kareer").Trim()
$stamp = Get-Date -Format yyyyMMdd-HHmmss
git push origin "${commit}:refs/heads/diagnostic-$stamp"
Write-Host ""
Write-Host "Rapport envoye sur la branche diagnostic-$stamp (copie locale : $file)"
