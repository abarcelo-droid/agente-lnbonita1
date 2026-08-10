@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Sincronizar Transoft con el ERP

rem ── Doble clic y listo ───────────────────────────────────────────────────
rem Corre bt_sync.py sin que haga falta abrir una consola ni saber donde esta
rem instalado Python. Este archivo va AL LADO de bt_sync.py.
rem
rem La ventana NO se cierra sola al terminar: lo que queda en pantalla es el
rem resultado, y hace falta poder leerlo y copiarlo.

echo.
echo   ============================================================
echo    Sincronizando Transoft con el ERP
echo   ============================================================
echo.
echo   Esto LEE los archivos de Transoft y los manda al ERP.
echo   No escribe nada en Transoft.
echo.
echo   La primera vez son unas 330.000 filas: puede tardar
echo   varios minutos. Mientras aparezcan numeros, esta trabajando.
echo.

rem ── Buscar Python donde suele estar ──────────────────────────────────────
set "PY=C:\dashboard_barcelo\pyportable\python.exe"
if exist "%PY%" goto :correr

set "PY=python"
python --version >nul 2>&1
if not errorlevel 1 goto :correr

set "PY=py"
py --version >nul 2>&1
if not errorlevel 1 goto :correr

echo   ------------------------------------------------------------
echo    NO ENCUENTRO PYTHON EN ESTA MAQUINA.
echo    Copiame este mensaje y te digo como seguir.
echo   ------------------------------------------------------------
echo.
pause
exit /b 1

:correr
if not exist "%~dp0bt_sync.py" (
  echo   ------------------------------------------------------------
  echo    FALTA bt_sync.py
  echo    Tiene que estar en esta misma carpeta:
  echo    %~dp0
  echo   ------------------------------------------------------------
  echo.
  pause
  exit /b 1
)

if not exist "%~dp0bt_sync_config.json" (
  echo   ------------------------------------------------------------
  echo    FALTA bt_sync_config.json
  echo    Es el archivo con la llave, que se copia del panel.
  echo    Tiene que estar en esta misma carpeta:
  echo    %~dp0
  echo.
  echo    OJO: si lo guardaste con el Bloc de notas puede haber
  echo    quedado como bt_sync_config.json.txt y no sirve.
  echo   ------------------------------------------------------------
  echo.
  pause
  exit /b 1
)

"%PY%" "%~dp0bt_sync.py"
set "RES=%errorlevel%"

echo.
echo   ============================================================
if "%RES%"=="0" (
  echo    TERMINO BIEN.
) else (
  echo    TERMINO CON ERRORES. Copia todo y pegaselo a Claude.
)
echo   ============================================================
echo.
echo   Para copiar: clic derecho sobre esta ventana ^> Marcar,
echo   seleccionar con el mouse, y Enter.
echo.
pause
exit /b %RES%
