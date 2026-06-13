# nuevabranch.ps1 — Crea una nueva branch desde main actualizado.
# Uso: nuevabranch andy/feat-loquesea
# Si no se pasa nombre, lo pide.

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding  = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'

Set-Location $PSScriptRoot

if (-not (Test-Path '.git')) {
    Write-Host "[ERROR] Este script tiene que estar en la raíz del repo (donde está .git)." -ForegroundColor Red
    Read-Host "Enter para cerrar"
    exit 1
}

# === Recibir nombre ===
$nombre = $args[0]
if ([string]::IsNullOrWhiteSpace($nombre)) {
    Write-Host ""
    Write-Host "Convención: prefijo/tipo-descripción" -ForegroundColor DarkGray
    Write-Host "Ejemplos:" -ForegroundColor DarkGray
    Write-Host "  andy/feat-plan-cuentas-fase2" -ForegroundColor DarkGray
    Write-Host "  pablo/fix-fichaje-gps" -ForegroundColor DarkGray
    Write-Host "  andy/refactor-modal-orden" -ForegroundColor DarkGray
    Write-Host ""
    $nombre = Read-Host "Nombre de la nueva branch"
}
$nombre = $nombre.Trim()
if ([string]::IsNullOrWhiteSpace($nombre)) {
    Write-Host "[CANCELADO] Sin nombre." -ForegroundColor Yellow
    Read-Host "Enter para cerrar"
    exit 0
}

# Validar formato básico (sin espacios, caracteres raros)
if ($nombre -notmatch '^[a-z0-9][a-z0-9/_\-]*$') {
    Write-Host "[ERROR] Nombre inválido: '$nombre'" -ForegroundColor Red
    Write-Host "  Solo letras minúsculas, números, guiones, guiones bajos y barras." -ForegroundColor DarkGray
    Read-Host "Enter para cerrar"
    exit 1
}

# === Verificar estado limpio ===
$status = git status --porcelain
if (-not [string]::IsNullOrWhiteSpace($status)) {
    Write-Host ""
    Write-Host "[WARN] Hay cambios sin commitear:" -ForegroundColor Yellow
    git status --short
    Write-Host ""
    Write-Host "Si creás la branch ahora, esos cambios se llevan con vos a la nueva branch." -ForegroundColor DarkGray
    $cont = Read-Host "¿Continuar? (s/N)"
    if ($cont -notmatch '^[sSyY]') {
        Write-Host "Cancelado." -ForegroundColor Yellow
        Read-Host "Enter para cerrar"
        exit 0
    }
}

# === Verificar que la branch no exista ya (local o remota) ===
$existeLocal = git rev-parse --verify --quiet "refs/heads/$nombre" 2>$null
if ($existeLocal) {
    Write-Host "[ERROR] Ya existe una branch local con ese nombre: $nombre" -ForegroundColor Red
    Write-Host "  Si querés cambiarte a ella: git checkout $nombre" -ForegroundColor DarkGray
    Read-Host "Enter para cerrar"
    exit 1
}

# === Sincronizar main y crear branch ===
Write-Host ""
Write-Host "Sincronizando main..." -ForegroundColor Cyan
$currentBranch = (git rev-parse --abbrev-ref HEAD).Trim()
if ($currentBranch -ne 'main') {
    git checkout main
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[ERROR] No pude cambiarme a main." -ForegroundColor Red
        Read-Host "Enter para cerrar"
        exit 1
    }
}
git pull origin main
if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] No pude pullear main desde origin." -ForegroundColor Red
    Read-Host "Enter para cerrar"
    exit 1
}

Write-Host ""
Write-Host "Creando branch '$nombre' desde main..." -ForegroundColor Cyan
git checkout -b $nombre
if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] No pude crear la branch." -ForegroundColor Red
    Read-Host "Enter para cerrar"
    exit 1
}

Write-Host ""
Write-Host "===========================================================" -ForegroundColor Green
Write-Host " [OK] Estás en la branch nueva: $nombre" -ForegroundColor Green
Write-Host ""
Write-Host " Tu próximo paso:" -ForegroundColor Green
Write-Host "   1) Trabajá normalmente (descargá archivos del chat a Downloads)" -ForegroundColor DarkGray
Write-Host "   2) Cuando estés listo, ejecutá:  deploy" -ForegroundColor DarkGray
Write-Host "   3) Eso pushea a esta branch y te da el link para crear el PR" -ForegroundColor DarkGray
Write-Host "===========================================================" -ForegroundColor Green
Write-Host ""
Read-Host "Enter para cerrar"
