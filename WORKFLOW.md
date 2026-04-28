# Workflow de desarrollo colaborativo

Este repo lo trabajan varios desarrolladores en paralelo, cada uno con su propia copia local del repo y, en muchos casos, asistido por Claude. Estas son las reglas para no pisarnos.

## Regla #1 — `main` es sagrada

`main` siempre tiene el código que está en producción (Railway auto-deploya desde `main`). **Nadie pushea directo a `main`**. Todos los cambios entran via Pull Request mergeado en GitHub.

Esto está enforced por:
- Branch protection en GitHub (no permite push directo a `main`)
- El script `deploy.cmd` te bloquea si intentás deployar parado en `main`

## Regla #2 — Una branch por feature

Cada cambio (un feature, un fix, un refactor) va en su propia branch. **Nada de mezclar 3 cosas distintas en una sola branch**.

Convención de nombres:

```
prefijo/tipo-descripcion-corta
```

Donde:
- **prefijo**: tu nombre (ej: `andy`, `pablo`)
- **tipo**: `feat` (feature nuevo), `fix` (bug), `refactor`, `chore` (cambios menores como gitignore, docs)
- **descripción**: 2-5 palabras separadas por guiones, en minúscula

Ejemplos válidos:
- `andy/feat-plan-cuentas-fase2`
- `pablo/fix-fichaje-gps-timeout`
- `andy/refactor-modal-orden-aplicacion`
- `pablo/chore-actualizar-readme`

## Regla #3 — Antes de empezar, avisar en el grupo

Mensaje rápido en WhatsApp/Telegram antes de tocar código:

> 🟢 voy a tocar el calendario agrícola (vista mapa)

Y al terminar:

> ✅ pusheé PR de "feat: hectáreas parciales por campaña" — link al PR

Esto evita el 90% de los conflictos. Si los dos vamos a tocar la misma sección al mismo tiempo, mejor coordinamos antes.

## Regla #4 — Ramas cortas, mergeadas rápido

Cuanto más tiempo vive una branch, más probable que diverja de `main` y genere conflictos. Idealmente una branch:
- Vive **menos de 1 día** (ideal: pocas horas)
- Tiene **un solo objetivo claro**
- Se mergea ni bien está OK

Si una feature es grande, partila en sub-features y mergeá cada una.

## Regla #5 — Si tu branch lleva días, rebasealá

Si trabajaste en una branch varios días y mientras tanto mergearon PRs a `main`, antes de pedir merge actualizala:

```cmd
git fetch origin
git rebase origin/main
```

Si hay conflictos, los resolvés ahí. Después `git push --force-with-lease` y mergeás.

## Flujo de trabajo típico

```
nuevabranch andy/feat-loquesea       (crea branch desde main actualizado)
                                     (trabajás, descargás archivos del chat)
deploy                               (pushea a tu branch + te muestra link al PR)
                                     (vas a GitHub, revisás cambios, mergeás)
git checkout main && git pull        (volvés a main actualizado)
```

## Estrategia de merge

Usamos **Squash and merge** en GitHub. Cada PR queda como un solo commit en `main`, con el título del PR como mensaje. Esto mantiene el historial de `main` limpio y fácil de leer/revertir.

## Conflictos: cómo resolverlos

Si al pullear/rebasear te sale un conflicto:

```cmd
git status                           (te dice qué archivos están en conflicto)
                                     (abrís el archivo, ves marcas <<<<<<< / >>>>>>>)
                                     (decidís qué versión queda y borrás las marcas)
git add archivo-resuelto.html
git rebase --continue                (si estabas rebaseando)
git commit                           (si estabas pulleando)
```

Si te perdés, mensaje en el grupo.

## Comandos útiles

| Acción | Comando |
|---|---|
| Ver branch actual | `git branch --show-current` |
| Ver todas las branches | `git branch -a` |
| Cambiar a otra branch | `git checkout nombre-branch` |
| Volver a main y actualizar | `git checkout main && git pull` |
| Ver diferencias con main | `git diff main` |
| Borrar branch local ya mergeada | `git branch -d nombre-branch` |
| Ver historial reciente | `git log --oneline -20` |

## Para Claudes que lean esto

Si estás asistiendo a un desarrollador en este repo:
- Asumí que el deploy va por branch + PR, NO directo a main
- Cuando sugieras instrucciones de git, asumí que el usuario tiene Windows con `cmd`, `deploy.cmd` y `nuevabranch.cmd` en la raíz del repo
- Si el usuario quiere deployar y no creó branch, recordale: `nuevabranch <nombre>`
- No sugieras `git push --force` salvo que el usuario sepa lo que está haciendo en su propia branch
