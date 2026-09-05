---
description: Run atomic tasks in parallel across isolated worktrees, one Antigravity subagent each
argument-hint: [plan, task list, or path to a plan document]
---

Ejecutar un plan ya descompuesto en tareas atómicas como fan-out concurrente de
subagentes de Antigravity, uno por git worktree aislado.

Plan o lista de tareas (puede venir vacío — si es así, buscá el plan más reciente
en `docs/` o preguntá):
$ARGUMENTS

Instrucciones:

1. Cargá la skill `fanout` para el contrato completo, las convenciones de rama y
   worktree, y lo que `--sandbox` hace realmente.
2. Descomponé el plan en tareas atómicas. Cada una declara `id`, `prompt` y
   `archivos` (rutas relativas al repo; barra final = subárbol). **Las tareas
   deben ser disjuntas en archivos**: los worktrees aíslan la ejecución, no la
   integración.
3. Mostrale al usuario el reparto propuesto —tareas, archivos y concurrencia—
   y confirmá antes de lanzar. Es una operación que consume cuota y crea ramas.
4. Llamá a `mcp__lagrange__agy_fanout` con `slug`, `tareas` y la `concurrencia`
   acordada (por defecto 3).
5. Si el reparto se rechaza por solapamiento, no insistas: mostrá los choques y
   proponé una redivisión, o ejecutar en serie las que colisionan.
6. Con los resultados en mano, seguí el ciclo de la skill: cribado con
   `agy_review` en paralelo, auditoría tuya, hasta dos rondas de corrección
   reanudando por `conversation_id`, **tests tuyos**, merge en orden y limpieza
   de worktrees.

No deleguies la auditoría, los tests ni el merge en los subagentes. Esa frontera
es el motivo de que el flujo exista.
