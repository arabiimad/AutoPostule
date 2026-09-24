@echo off
rem Met ce dossier a jour avec la version fusionnee (branche claude/peaceful-tesla-0655tn).
rem Les modifications locales non envoyees sont d'abord sauvegardees sur GitHub. Le fichier .env n'est jamais touche.
chcp 65001 >nul
cd /d "%~dp0"

where git >nul 2>&1
if errorlevel 1 (
  echo Git n'est pas installe : telechargez-le sur https://git-scm.com puis relancez ce fichier.
  pause
  exit /b 1
)

rem Date calculee hors du bloc IF (sinon la variable y reste vide)
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmm"') do set STAMP=%%i

rem 1. Sauvegarde de ce qui a change depuis le dernier envoi
git add -A
git rm -r -q --cached --ignore-unmatch .env .env.local .env.production node_modules dist >nul 2>&1
git diff --cached --quiet
if errorlevel 1 (
  git checkout -q -B version-locale-%STAMP%
  git -c user.name="Imad" -c user.email="arabiimad@outlook.com" commit -q -m "Version locale (%STAMP%)"
  git push -q -u origin version-locale-%STAMP%
  echo Vos modifications recentes sont sauvegardees sur la branche version-locale-%STAMP%.
)

rem 2. Passage sur la version fusionnee
git fetch -q origin claude/peaceful-tesla-0655tn
if errorlevel 1 (
  echo Echec du telechargement : verifiez votre connexion puis relancez.
  pause
  exit /b 1
)
git checkout -q -B claude/peaceful-tesla-0655tn origin/claude/peaceful-tesla-0655tn
if errorlevel 1 (
  echo Echec du changement de version : envoyez une capture de ce message a Claude.
  pause
  exit /b 1
)

rem 3. Dependances
call npm install --no-audit --no-fund

echo.
echo OK : dossier a jour. Lancez l'application avec lancer.bat, puis faites Ctrl+F5 dans le navigateur.
pause
