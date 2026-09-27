@echo off
chcp 65001 >nul
cd /d "%~dp0"
title AutoPostule - serveur
echo Arret d un ancien serveur AutoPostule (port 3000) s il tourne encore...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":3000 " ^| findstr LISTENING') do taskkill /PID %%p /F >nul 2>&1
timeout /t 2 >nul
if not exist "node_modules\@supabase\supabase-js" (
  echo Installation des dependances...
  call npm install || goto :erreur
)
echo Demarrage d AutoPostule sur http://localhost:3000 ...
start "" cmd /c "timeout /t 6 >nul & start http://localhost:3000"
node "node_modules\tsx\dist\cli.mjs" server.ts
pause
exit /b 0
:erreur
echo Echec de l installation : lisez le message ci-dessus.
pause
exit /b 1
