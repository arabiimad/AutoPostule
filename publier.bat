@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo === 1/2 Mise a jour des dependances ===
call npm install || goto :erreur
echo.
echo === 2/2 Envoi sur GitHub de toutes les branches ===
git push --all -u origin || goto :erreur
echo.
echo Termine : dependances a jour et code sur GitHub.
pause
exit /b 0
:erreur
echo.
echo Une etape a echoue : lisez le message ci-dessus.
pause
exit /b 1
