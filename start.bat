@echo off
chcp 65001 >nul
title MAZZ Agent Studio Launcher

echo ========================================================
echo   MAZZ AENGENIUM - Agent Studio Launcher
echo ========================================================
echo.

cd /d "%~dp0"

:: Verifie si le port 3333 est deja actif
netstat -ano | findstr /R /C:":3333 .*LISTENING" >nul
if %errorlevel% equ 0 (
    echo [INFO] Le serveur MAZZ Studio est deja actif sur le port 3333.
    echo [INFO] Ouverture de l'interface dans votre navigateur...
    start http://127.0.0.1:3333/
    exit /b 0
)

echo [INFO] Demarrage du serveur MAZZ Studio (port 3333)...
start "MAZZ Agent Studio Server" cmd /k "cd /d %~dp0 && npm start"

:: Attend 2 secondes que le serveur initialise
timeout /t 2 /nobreak >nul

echo [INFO] Ouverture de l'interface dans votre navigateur...
start http://127.0.0.1:3333/

echo [OK] MAZZ Studio lance avec succes.
