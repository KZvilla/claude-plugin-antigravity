---
description: Inspect Lagrange's local inventory and optionally watch a fan-out live
argument-hint: [slug del lote (opcional) o --port N]
---

Levantar Lagrange Watch: una consola read-only en `127.0.0.1` que muestra un inventario de
agentes, almas, memorias y perfiles por origen, y conserva el visor en vivo de
fan-out con diff y detención.

Argumentos opcionales:
$ARGUMENTS

Instrucciones:

1. El visor es un script standalone, **no** una tool MCP: se corre en una
   terminal y se queda ahí hasta que el usuario haga Ctrl+C. No lo lances vos en
   background ni intentes mantenerlo vivo desde acá — decile al usuario que lo
   corra él, o corrélo solo si te lo pide explícitamente.

2. El comando es:

   ```
   node <plugin>/mcp-server/fanout-watch.js [repoPath] [--slug <nombre>] [--port <N>]
   ```

   Sin `repoPath` usa el directorio actual. Sin `--slug` abre el dashboard
   global; el lote más reciente queda disponible en la sección fan-out. El
   puerto por defecto es 4517.

3. Pasale al usuario **la URL completa que imprime**, con el `?t=<token>` incluido
   (`http://127.0.0.1:<puerto>/?t=...`). Sin ese token el visor responde 403: es
   por sesión, cambia en cada arranque y no se persiste. Recortarla a
   `http://127.0.0.1:<puerto>` no funciona.

4. Si no hay ningún lote, el visor **igual arranca** y abre el dashboard. Para la vista de fan-out sí hace falta
   haber corrido un `agy_fanout` en ese repo: el visor lee lo que el fan-out deja
   (`.fanout-status-*.json` y `.agy-progress-*.jsonl` en `.claude/worktrees/`),
   no inventa nada.

5. `/agents` muestra registro, SKILL, `agent.md`, resolución, divergencia,
   criterio y un preview basal de `mcp-memory`. `/almas`, `/memories` y
   `/profiles` conservan la procedencia. `CACHE` no significa live y `DERIVED`
   no significa inyectado en una sesión.

6. FEAT-050 V1.0 es read-only. No inventes ni ofrezcas endpoints de edición.

Notas:

- El botón **Detener** escribe el mismo centinela que `fanout-stop.js`, así que
  el subagente muere en su próximo sondeo (unos segundos). Un worktree con
  trabajo a medio commitear se preserva: lo clasifica como "sucio" la limpieza
  de siempre.
- Escucha **solo en loopback** a propósito: los logs traen prompts y código
  generado. No lo expongas a la red. Pero loopback no alcanza — cualquier página
  abierta en otra pestaña puede postearle a `127.0.0.1`, así que desde `SEC-011`
  el visor además exige un token por sesión, valida `Origin`/`Sec-Fetch-Site` en
  las mutaciones, rechaza el preflight CORS y exige `Host` de loopback.
- Sirve también para mirar un lote ya terminado: el estado y los logs quedan en
  disco hasta la próxima corrida con el mismo slug.
