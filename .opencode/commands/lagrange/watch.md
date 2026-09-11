---
description: Watch a running fan-out live in the browser - per-subagent progress and a stop button
---

Levantar el visor local de un fan-out en curso: una página en `127.0.0.1` que
muestra todos los subagentes a la vez, su estado, lo que va haciendo cada uno en
vivo, y un botón para detener cualquiera.

Argumentos (opcionales - sin nada, toma el lote más reciente):
$ARGUMENTS

Instrucciones:

1. El visor es un script standalone, **no** una tool MCP: se corre en una
   terminal y se queda ahí hasta que el usuario haga Ctrl+C. No lo lances vos en
   background ni intentes mantenerlo vivo desde acá - decile al usuario que lo
   corra él, o corrélo solo si te lo pide explícitamente.

2. El comando es:

   ```
   node mcp-server/fanout-watch.js [repoPath] [--slug <nombre>] [--port <N>]
   ```

   Sin `repoPath` usa el directorio actual; sin `--slug` toma el lote más
   reciente de `.claude/worktrees/`; el puerto por defecto es 4517 (si está
   ocupado, avisa y sugiere `--port`).

3. Pasale al usuario **la URL completa que imprime**, con el `?t=<token>` incluido
   (`http://127.0.0.1:<puerto>/?t=...`). Sin ese token el visor responde 403: es
   por sesión, cambia en cada arranque y no se persiste. Recortarla a
   `http://127.0.0.1:<puerto>` no funciona.

4. Si no hay ningún lote, el visor **igual arranca** y abre directamente la vista
   de agentes persistidos (`/agents`). Para la vista de fan-out sí hace falta
   haber corrido un `lagrange_agy_fanout` en ese repo: el visor lee lo que el fan-out deja
   (`.fanout-status-*.json` y `.agy-progress-*.jsonl` en `.claude/worktrees/`),
   no inventa nada.

5. La pestaña `/agents` lista los agentes persistidos y, al hacer clic en uno,
   muestra el criterio que fue acumulando en `mcp-memory` con la cantidad de
   veces que cada memoria se usó de verdad. No tiene decision gates ni estado
   "corriendo": ver el README.

Notas:

- El botón **Detener** escribe el mismo centinela que `fanout-stop.js`, así que
  el subagente muere en su próximo sondeo (unos segundos). Un worktree con
  trabajo a medio commitear se preserva: lo clasifica como "sucio" la limpieza
  de siempre.
- Escucha **solo en loopback** a propósito: los logs traen prompts y código
  generado. No lo expongas a la red. Pero loopback no alcanza - cualquier página
  abierta en otra pestaña puede postearle a `127.0.0.1`, así que el visor además
  exige un token por sesión, valida `Origin`/`Sec-Fetch-Site` en las mutaciones,
  rechaza el preflight CORS y exige `Host` de loopback.
- Sirve también para mirar un lote ya terminado: el estado y los logs quedan en
  disco hasta la próxima corrida con el mismo slug.
