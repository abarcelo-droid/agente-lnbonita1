# deploy.ps1 — Smart deploy LNB APP
# Detecta archivos del repo en Downloads, los copia, hace commit + push.

# Forzar UTF-8 en todos los streams (entrada, salida, default de PowerShell)
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding  = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$PSDefaultParameterValues['*:Encoding'] = 'utf8'
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

# === Chequeo de branch ===
# Workflow colaborativo: nadie pushea directo a main. Siempre branch + PR.
$currentBranch = (git rev-parse --abbrev-ref HEAD 2>$null).Trim()
if ([string]::IsNullOrWhiteSpace($currentBranch)) {
    Write-Host "[ERROR] No pude leer la branch actual (¿el repo está OK?)" -ForegroundColor Red
    Read-Host "Enter para cerrar"
    exit 1
}
if ($currentBranch -eq 'main' -or $currentBranch -eq 'master') {
    Write-Host ""
    Write-Host "===========================================================" -ForegroundColor Red
    Write-Host " Estás parado en la branch '$currentBranch'." -ForegroundColor Red
    Write-Host " No se puede deployar directamente a main en el workflow" -ForegroundColor Red
    Write-Host " colaborativo. Creá una branch primero:" -ForegroundColor Red
    Write-Host ""
    Write-Host "    nuevabranch andy/feat-loquesea" -ForegroundColor Yellow
    Write-Host ""
    Write-Host " (o reemplazá 'andy' por tu prefijo y 'feat-loquesea'" -ForegroundColor Red
    Write-Host "  por una descripción corta de qué estás haciendo)" -ForegroundColor Red
    Write-Host "===========================================================" -ForegroundColor Red
    Write-Host ""
    Read-Host "Enter para cerrar"
    exit 1
}
Write-Host ""
Write-Host "Branch actual: " -NoNewline -ForegroundColor DarkGray
Write-Host $currentBranch -ForegroundColor Cyan

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
if ($confirm -notmatch '^[sSyY]') {
    Write-Host "Cancelado." -ForegroundColor Yellow
    Read-Host "Enter para cerrar"
    exit 0
}

# === Copiar ===
Write-Host ""
Write-Host "Copiando..." -ForegroundColor Cyan
$copiedSources = @()  # paths originales en Downloads que se copiaron OK
foreach ($f in $found) {
    $destDir = Split-Path $f.Dest -Parent
    if ($destDir -and -not (Test-Path $destDir)) {
        New-Item -ItemType Directory -Path $destDir -Force | Out-Null
    }
    try {
        Copy-Item -Path $f.Source -Destination $f.Dest -Force -ErrorAction Stop
        Write-Host "  [OK] $($f.Name)" -ForegroundColor Green
        $copiedSources += $f.Source
    } catch {
        Write-Host "  [ERR] $($f.Name): $_" -ForegroundColor Red
    }
}

# === Borrar de Downloads (los que se copiaron OK) ===
# Esto evita que la próxima descarga del navegador genere "panel (1).html" etc.
if ($copiedSources.Count -gt 0) {
    Write-Host ""
    Write-Host "Limpiando Downloads..." -ForegroundColor Cyan
    foreach ($src in $copiedSources) {
        try {
            Remove-Item -Path $src -Force -ErrorAction Stop
            Write-Host "  [DEL] $(Split-Path $src -Leaf)" -ForegroundColor DarkGray
        } catch {
            Write-Host "  [WARN] No se pudo borrar $(Split-Path $src -Leaf): $_" -ForegroundColor Yellow
        }
    }
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
# -u set-upstream para que la primera vez en una branch nueva sepa a dónde pushear
git push -u origin $currentBranch
if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] git push falló. El commit ya está local; resolvé el problema y pusheá manualmente." -ForegroundColor Red
    Read-Host "Enter para cerrar"
    exit 1
}

# Detectar URL del repo en GitHub para mostrar el link de creación de PR
$remoteUrl = (git config --get remote.origin.url 2>$null).Trim()
$prUrl = $null
if ($remoteUrl -match 'github\.com[:/](.+?)(\.git)?$') {
    $repoPath = $matches[1]
    $prUrl = "https://github.com/$repoPath/pull/new/$currentBranch"
}

Write-Host ""
Write-Host "===========================================================" -ForegroundColor Green
Write-Host " [OK] Push hecho a la branch '$currentBranch'" -ForegroundColor Green
Write-Host ""
Write-Host " Próximo paso: crear el Pull Request en GitHub" -ForegroundColor Green
if ($prUrl) {
    Write-Host ""
    Write-Host "    $prUrl" -ForegroundColor Cyan
    Write-Host ""
    $abrir = Read-Host "¿Abrir esta URL en el navegador? (s/N)"
    if ($abrir -match '^[sSyY]') {
        Start-Process $prUrl
    }
}
Write-Host ""
Write-Host " Cuando se mergee el PR, Railway hará el deploy a producción." -ForegroundColor DarkGray
Write-Host "===========================================================" -ForegroundColor Green
Write-Host ""
Read-Host "Enter para cerrar"
