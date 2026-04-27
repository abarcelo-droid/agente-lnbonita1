# deploy.ps1 — Smart deploy LNB APP
# Detecta archivos del repo en Downloads, los copia, hace commit + push.

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'

# === Configuración ===
$Downloads = Join-Path $env:USERPROFILE 'Downloads'
$MaxAgeMinutes = 30

# Mapeo nombre archivo -> path destino (relativo a la raíz del repo)
$Mapping = @{
    'panel.html'    = 'src\panel.html'
    'scout.html'    = 'src\scout.html'
    'login.html'    = 'src\login.html'
    'manifest.json' = 'src\manifest.json'
    'sw.js'         = 'src\sw.js'
    'index.js'      = 'src\index.js'
    'auth.js'       = 'src\rutas\auth.js'
    'produccion.js' = 'src\rutas\produccion.js'
    'scout.js'      = 'src\rutas\scout.js'
    'cuentas.js'    = 'src\rutas\cuentas.js'
    'db.js'         = 'src\servicios\db.js'
    'db_pa.js'      = 'src\servicios\db_pa.js'
}

# === Sanity checks ===
Set-Location $PSScriptRoot

if (-not (Test-Path '.git')) {
    Write-Host "[ERROR] Este script tiene que estar en la raíz del repo (donde está .git)." -ForegroundColor Red
    Read-Host "Enter para cerrar"
    exit 1
}

if (-not (Test-Path $Downloads)) {
    Write-Host "[ERROR] No encuentro la carpeta Downloads: $Downloads" -ForegroundColor Red
    Read-Host "Enter para cerrar"
    exit 1
}

# === Detección de archivos ===
$cutoff = (Get-Date).AddMinutes(-$MaxAgeMinutes)
$found = @()
$stale = @()

# Archivos del mapeo
foreach ($name in $Mapping.Keys) {
    $src = Join-Path $Downloads $name
    if (Test-Path $src) {
        $file = Get-Item $src
        $ageMin = [int]((Get-Date) - $file.LastWriteTime).TotalMinutes
        $entry = [PSCustomObject]@{
            Name   = $name
            Source = $file.FullName
            Dest   = $Mapping[$name]
            Age    = $ageMin
        }
        if ($file.LastWriteTime -ge $cutoff) { $found += $entry } else { $stale += $entry }
    }
}

# Íconos PWA (icon-*.png)
Get-ChildItem -Path $Downloads -Filter 'icon-*.png' -ErrorAction SilentlyContinue | ForEach-Object {
    $ageMin = [int]((Get-Date) - $_.LastWriteTime).TotalMinutes
    $entry = [PSCustomObject]@{
        Name   = $_.Name
        Source = $_.FullName
        Dest   = "src\$($_.Name)"
        Age    = $ageMin
    }
    if ($_.LastWriteTime -ge $cutoff) { $found += $entry } else { $stale += $entry }
}

# === Mostrar resultado ===
Write-Host ""
Write-Host "=== Smart Deploy LNB APP ===" -ForegroundColor Cyan
Write-Host ""

if ($found.Count -eq 0 -and $stale.Count -eq 0) {
    Write-Host "[INFO] No hay archivos del repo en Downloads." -ForegroundColor Yellow
    Read-Host "Enter para cerrar"
    exit 0
}

if ($found.Count -eq 0) {
    Write-Host "[WARN] Hay archivos pero todos son viejos (>$MaxAgeMinutes min). Redescargá desde el chat." -ForegroundColor Yellow
    foreach ($s in $stale) {
        Write-Host ("  [!] {0,-20} ({1} min)" -f $s.Name, $s.Age) -ForegroundColor DarkYellow
    }
    Read-Host "Enter para cerrar"
    exit 0
}

Write-Host "Archivos detectados (modificados en los últimos $MaxAgeMinutes min):" -ForegroundColor Cyan
foreach ($f in $found) {
    Write-Host ("  [+] {0,-20} -> {1,-30} ({2} min)" -f $f.Name, $f.Dest, $f.Age) -ForegroundColor Green
}

if ($stale.Count -gt 0) {
    Write-Host ""
    Write-Host "Archivos viejos (IGNORADOS - redescargá si los necesitás):" -ForegroundColor Yellow
    foreach ($s in $stale) {
        Write-Host ("  [!] {0,-20} ({1} min)" -f $s.Name, $s.Age) -ForegroundColor DarkYellow
    }
}

Write-Host ""
$confirm = Read-Host "¿Copiar y deployar estos archivos? (s/N)"
if ($confirm -ne 's' -and $confirm -ne 'S') {
    Write-Host "Cancelado." -ForegroundColor Yellow
    Read-Host "Enter para cerrar"
    exit 0
}

# === Copiar ===
Write-Host ""
Write-Host "Copiando..." -ForegroundColor Cyan
foreach ($f in $found) {
    $destDir = Split-Path $f.Dest -Parent
    if ($destDir -and -not (Test-Path $destDir)) {
        New-Item -ItemType Directory -Path $destDir -Force | Out-Null
    }
    Copy-Item -Path $f.Source -Destination $f.Dest -Force
    Write-Host "  [OK] $($f.Name)" -ForegroundColor Green
}

# === Verificar que hay cambios reales ===
$status = git status --porcelain
if ([string]::IsNullOrWhiteSpace($status)) {
    Write-Host ""
    Write-Host "[INFO] Los archivos copiados no cambiaron contenido. Nada para commitear." -ForegroundColor Yellow
    Read-Host "Enter para cerrar"
    exit 0
}

# === Mostrar diff stat ===
Write-Host ""
Write-Host "Cambios en el repo:" -ForegroundColor Cyan
git diff --stat

# === Mensaje commit ===
Write-Host ""
Write-Host "Sugerencia: prefija con feat: / fix: / refactor:" -ForegroundColor DarkGray
$msg = Read-Host "Mensaje de commit (vacío = cancelar)"
if ([string]::IsNullOrWhiteSpace($msg)) {
    Write-Host "[CANCELADO] Archivos copiados pero sin commit. Revertí con: git checkout -- ." -ForegroundColor Yellow
    Read-Host "Enter para cerrar"
    exit 0
}

# === Git add + commit + push ===
Write-Host ""
Write-Host "git add..." -ForegroundColor Cyan
$paths = $found | ForEach-Object { $_.Dest }
git add $paths
if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] git add falló" -ForegroundColor Red
    Read-Host "Enter para cerrar"
    exit 1
}

Write-Host "git commit..." -ForegroundColor Cyan
git commit -m $msg
if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] git commit falló" -ForegroundColor Red
    Read-Host "Enter para cerrar"
    exit 1
}

Write-Host "git push..." -ForegroundColor Cyan
git push
if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] git push falló. El commit ya está local; resolvé el problema y pusheá manualmente." -ForegroundColor Red
    Read-Host "Enter para cerrar"
    exit 1
}

Write-Host ""
Write-Host "=== [OK] Deploy disparado. Railway hará el resto. ===" -ForegroundColor Green
Write-Host ""
Read-Host "Enter para cerrar"
