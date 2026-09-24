@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Installation des commandes, sous-agents et skills Claude Code dans .claude ...
xcopy /E /I /Y "claude-kit" ".claude" >nul || goto :erreur
echo Termine. Ouvrez Claude Code dans ce dossier et tapez /audit
pause
exit /b 0
:erreur
echo Echec de la copie.
pause
exit /b 1
