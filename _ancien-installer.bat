@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo === 1/3 Dependances : deja installees ===
echo.
echo === 2/3 Installation de Chromium pour les PDF ===
node "node_modules\playwright\cli.js" install chromium || goto :erreur
echo.
echo === 3/3 Envoi sur GitHub (main puis phase-1) ===
git push -u origin main || goto :erreur
git push -u origin phase-1 || goto :erreur
echo.
echo Termine : tout est installe et en ligne sur GitHub.
pause
exit /b 0
:erreur
echo.
echo Une etape a echoue : lisez le message ci-dessus.
pause
exit /b 1
