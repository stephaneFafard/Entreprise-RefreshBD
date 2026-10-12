@echo off
setlocal
title Refresh Local BD
cd /D "%~dp0"

set "APP_PORT=3100"
set "DB_PORT=3306"
set "XAMPP_DIR=C:\xampp"

echo ==========================================
echo   Refresh Local BD - demarrage
echo ==========================================
echo.

rem --- 1. Node.js -------------------------------------------------------
where node >nul 2>&1
if errorlevel 1 (
  echo [ERREUR] Node.js est introuvable. Installe-le depuis https://nodejs.org
  pause
  exit /b 1
)

rem --- 2. Dependances npm -------------------------------------------------
if not exist "node_modules\" (
  echo [..] Installation des dependances npm...
  call npm install
  if errorlevel 1 (
    echo [ERREUR] npm install a echoue.
    pause
    exit /b 1
  )
)
echo [OK] Dependances npm

rem --- 3. Fichier .env ----------------------------------------------------
if not exist ".env" (
  copy /Y ".env.example" ".env" >nul
  echo [!!] Fichier .env cree a partir de .env.example.
  echo      Renseigne LOCAL_DB_PASSWORD dans .env puis relance Start.bat.
  notepad ".env"
  pause
  exit /b 1
)
echo [OK] Fichier .env

rem --- 4. MariaDB locale (XAMPP) -----------------------------------------
call :is_listening %DB_PORT%
if errorlevel 1 (
  if not exist "%XAMPP_DIR%\mysql_start.bat" (
    echo [ERREUR] MariaDB ne tourne pas sur le port %DB_PORT% et XAMPP est introuvable dans %XAMPP_DIR%.
    pause
    exit /b 1
  )
  echo [..] Demarrage de MariaDB ^(XAMPP^)...
  start "MariaDB (XAMPP)" /MIN cmd /c "%XAMPP_DIR%\mysql_start.bat"
  call :wait_for_port %DB_PORT% 30
  if errorlevel 1 (
    echo [ERREUR] MariaDB n'a pas demarre dans les 30 secondes.
    pause
    exit /b 1
  )
)
echo [OK] MariaDB sur le port %DB_PORT%

rem --- 5. Serveur de l'application ---------------------------------------
call :is_listening %APP_PORT%
if errorlevel 1 (
  echo [..] Demarrage du serveur Refresh Local BD...
  start "Refresh Local BD - serveur" cmd /k "node server.js"
  call :wait_for_port %APP_PORT% 15
  if errorlevel 1 (
    echo [ERREUR] Le serveur n'a pas demarre. Regarde la fenetre "Refresh Local BD - serveur".
    pause
    exit /b 1
  )
)
echo [OK] Serveur sur le port %APP_PORT%

rem --- 6. Navigateur ------------------------------------------------------
start "" "http://localhost:%APP_PORT%"
echo.
echo Tout est demarre : http://localhost:%APP_PORT%
echo Pour arreter le serveur, ferme la fenetre "Refresh Local BD - serveur".
timeout /t 5 >nul
exit /b 0

rem ===========================================================================
:is_listening
netstat -ano | findstr /R /C:":%~1 .*LISTENING" >nul
exit /b %errorlevel%

:wait_for_port
set /a "_remaining=%~2"
:wait_loop
call :is_listening %~1
if not errorlevel 1 exit /b 0
if %_remaining% LEQ 0 exit /b 1
set /a "_remaining-=1"
timeout /t 1 /nobreak >nul
goto wait_loop
