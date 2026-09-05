---
name: fanout
description: "[skill, loads itself] Background knowledge for running several Antigravity subagents concurrently, each confined to its own git worktree; /lagrange:fanout is the explicit trigger. Use when a plan is already broken into atomic tasks and the user wants them implemented in parallel, or mentions fan-out, subagentes concurrentes, paralelizar tareas, worktrees por subagente, or asks to split implementation work across several agy instances. Covers the disjointness contract, the branch and worktree conventions, what --sandbox actually does, and why auditing and testing must stay with Claude."
---

# Fan-out concurrente de subagentes de Antigravity

Ejecutar N subagentes de `agy` en paralelo, cada uno aislado en su propio git
worktree, reservándote la auditoría, los tests y la integración.

La especificación completa, con la evidencia empírica que la sostiene, está en
`docs/future-implementations/subagentes-concurrentes-agy.md`.

---

## Lo que hay que saber antes de usarlo

**El aislamiento es el worktree, no el sandbox.** Verificado el 2026-09-04:
`--sandbox` monta un jail sobre el `cwd`, con lo que el parámetro se ignora, las
escrituras de la herramienta nativa de archivos se fugan al repositorio
principal, la sesión exige elevación UAC en Windows —incompatible con cualquier
ejecución headless concurrente— y deja una montura que sobrevive al proceso.
Encima solo restringe el terminal: bajo sandbox el subagente igual escribe
archivos, lee rutas absolutas fuera de su workspace y sale a internet por sus
herramientas nativas. Por eso `agy_fanout` **no expone la opción**.

**`allow` / `deny` no son controles.** Se inyectan como texto en el prompt
(`buildSecurityRules` en `mcp-server/index.js`). Sirven como higiene, no como
frontera. El único read-only con enforcement real es `mode: "plan"` — que en el
fan-out se pide por tarea con `soloLectura: true`.

**El confinamiento es de escritura, no de lectura.** Un subagente con permisos
auto-aprobados puede leer cualquier ruta absoluta de la máquina. Asumilo antes de
lanzarlo sobre un repositorio con secretos en disco.

**Dos worktrees no pueden compartir rama.** Cada subagente estrena la suya,
derivada de la base. "Todos apuntan a nuestra rama" es imposible en git.

---

## El contrato de tarea atómica

El fan-out solo compensa si las tareas son **disjuntas en archivos**. Los
worktrees aíslan la ejecución, no la integración: si dos tareas tocan el mismo
archivo, el conflicto no desaparece, se traslada al merge.

Cada tarea declara:

```json
{
  "id": "auth",
  "prompt": "Implementá el rate limiting del endpoint de login...",
  "archivos": ["src/auth.js", "test/auth.test.js"],
  "modelo": "gemini-3.8-flash",
  "effort": "high",
  "soloLectura": false
}
```

`archivos` son rutas relativas a la raíz del repo. Una barra final marca un
subárbol completo (`src/api/`). Las rutas absolutas y los `..` se rechazan.

`agy_fanout` valida la disjunción **antes** de crear worktrees o gastar cuota, y
rechaza el lote entero si hay solapamiento. Si dos tareas tienen que tocar el
mismo archivo, o las redividís, o las corrés en serie.

Sobre `effort`: los valores son `low`, `medium` y `high`. **No existe `xhigh`.**
La familia `pro` solo admite `low` y `high`.

---

## El ciclo

`agy_fanout` cubre solo los pasos 1 a 3. Del 4 en adelante es tuyo, y esa
frontera es deliberada.

1. **Descomponer** en tareas atómicas disjuntas en archivos.
2. **Validar y lanzar** con `agy_fanout`. Resuelve la rama base (nunca
   `main`/`master`: si estás ahí crea `feat/<slug>`; si estás en `dev`/`develop`
   o en una rama de trabajo, la usa), crea un worktree y una rama por tarea, y
   ejecuta en lotes con tope de concurrencia y backoff ante cuota.
3. **Recoger** los resultados: rama, estado y `conversation_id` por tarea.
4. **Cribar** con `agy_review` en paralelo sobre cada diff. Es read-only y
   barato; sirve de primer filtro para no saturar tu contexto con N diffs.
5. **Auditar** vos lo que el filtro marque, más el diff completo de lo crítico.
   Para una auditoría hostil, `/lagrange:audit`.
6. **Corregir** reanudando con `conversation_id`. Máximo dos rondas; agotadas,
   la tarea la tomás vos. Sin tope se entra en un bucle caro.
7. **Testear vos.** Los subagentes tienen prohibido escribir y correr tests.
   No es desconfianza: un modelo que escribe el código y su propio test optimiza
   para que el test pase, no para que el código funcione.
8. **Integrar vos**, mergeando en orden. Los subagentes nunca mergean.
9. **Limpiar** los worktrees. Solo se borran los que no tienen trabajo
   pendiente; los que conservan commits sin mergear se preservan y se informan.

---

## Elegir la concurrencia

El tope existe por cuota, no por CPU. El defecto es 3. Subirlo multiplica el
riesgo de 429 y, con N grande, satura tu propio contexto en la fase de
auditoría. `quota_status` en `agy_usage` avisa cuando la cuota ya está tocada.

Los fallos por cuota se reintentan con backoff exponencial (dos reintentos); los
errores de código no se reintentan, porque repetirlos cuesta lo mismo y da lo
mismo.

---

## Cuándo NO usarlo

- **Tareas que se solapan en archivos.** El validador las va a rechazar, y tiene
  razón: en serie salen antes que resolviendo el merge.
- **Menos de tres tareas.** El coste fijo de worktrees, auditoría e integración
  no se amortiza. Usá `agy_run` directo.
- **Trabajo exploratorio.** El fan-out asume un plan ya cerrado. Si todavía no
  sabés qué archivos toca cada parte, no está descompuesto: usá
  `/lagrange:plan` primero.
