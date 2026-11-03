@echo off
setlocal
set "PROJECT=%~dp0lector-md"
set "RUNTIME=%LOCALAPPDATA%\LectorMD-runtime"
set "VENV=%RUNTIME%\venv"

if not exist "%PROJECT%\app.py" (
    echo No se encontro app.py en la carpeta lector-md.
    pause
    exit /b 1
)

if not exist "%PROJECT%\.venv\Scripts\pythonw.exe" (
    echo No se encontro el entorno .venv del proyecto.
    echo Ejecuta primero: python -m venv .venv
    pause
    exit /b 1
)

if not exist "%VENV%\Scripts\pythonw.exe" (
    echo Preparando Lector MD por primera vez...
    robocopy "%PROJECT%\.venv" "%VENV%" /MIR /NFL /NDL /NJH /NJS /NP >nul
    if errorlevel 8 (
        echo No se pudo preparar el entorno local.
        pause
        exit /b 1
    )
)

start "" "%VENV%\Scripts\pythonw.exe" "%PROJECT%\app.py" %*
exit /b 0
