# Reglas para Claude Code trabajando en este repo

## Comportamiento general
- Trabajá de forma autónoma. NO pidas confirmaciones intermedias.
- Decidí vos los detalles cuando no estén especificados.
- Solo pausá si:
  - Necesitás info que NO está en el repo ni en el brief
  - Vas a hacer algo destructivo (rm, force-push, reset --hard, drop table)
  - Encontrás un blocker técnico real
- Avisame al final con un resumen de qué hiciste.

## Workflow de cambios
- Branch nueva siempre: `andy/feat-...` o `andy/fix-...`
- Commits con Conventional Commits: `feat(scope):`, `fix(scope):`, `refactor(scope):`
- Push + abrir PR siempre, NO mergees a main directo
- Pegame el link del PR al terminar

## Stack
- Node.js v24 + Express + better-sqlite3 + ES Modules
- SQLite en `data/clientes.db` (Railway volume persistente)
- Deploy automático en Railway al mergear a main
- Path Windows local: `C:\Users\Lenovo\Documents\Cloude\agente-lnbonita`

## Estructura
- `src/index.js` — entry point
- `src/panel.html` — frontend (un solo archivo grande, ~1.6MB)
- `src/rutas/` — routers Express por módulo (abasto, auth, ifco, org, etc)
- `src/servicios/` — DB, mail, OCR, helpers

## Convenciones
- Usuario admin tiene rol `'admin'`. Hay flag `solo_lectura` que NO aplica a admin.
- Auth por cookie `lnb_user` (JSON con id, nombre, rol, etc)
- Las acciones de cambio (POST/PUT/PATCH/DELETE) van con `requireAuth`
- Soft delete usa columna `eliminado_en` (TIMESTAMP)
- Pablo trabaja paralelo en módulos AB (abasto) y MD (módulos contables); coordinar antes de tocar esos archivos

## Limitaciones del entorno
- Si npm install falla en Windows, ya está resuelto: tenemos Node y npm OK
- No hay tests automáticos, validación es manual
