@echo off
rem Envoie la version locale de ce dossier sur GitHub (nouvelle branche), sans rien modifier d'autre.
rem A placer dans le dossier du projet, puis double-cliquer. Le fichier .env n'est jamais envoye.
chcp 65001 >nul
cd /d "%~dp0"
if exist "%~dp0..\package.json" if not exist "%~dp0package.json" cd /d "%~dp0.."

where git >nul 2>&1
if errorlevel 1 (
  echo Git n'est pas installe : telechargez-le sur https://git-scm.com puis relancez ce fichier.
  pause
  exit /b 1
)

if not exist ".git" (
  echo Initialisation de Git dans ce dossier...
  git init -q
)
git remote get-url origin >nul 2>&1
if errorlevel 1 git remote add origin https://github.com/arabiimad/AutoPostule.git

for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmm"') do set STAMP=%%i
set BRANCHE=version-locale-%STAMP%

git checkout -q -B %BRANCHE%
git add -A
rem Securite : les secrets ne partent jamais, meme si .gitignore est incomplet
git rm -r -q --cached --ignore-unmatch .env .env.local .env.production node_modules dist >nul 2>&1
git -c user.name="Imad" -c user.email="arabiimad@outlook.com" commit -q -m "Version locale (%STAMP%)"
git push -u origin %BRANCHE%
if errorlevel 1 (
  echo.
  echo Echec de l'envoi. Verifiez votre connexion GitHub ^(le meme compte que pour publier.cmd^) puis relancez.
  pause
  exit /b 1
)

echo.
echo OK : votre version locale est sur GitHub, branche %BRANCHE%.
echo Ecrivez a Claude : "c'est pousse".
pause
