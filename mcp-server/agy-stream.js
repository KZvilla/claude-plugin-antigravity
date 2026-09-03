/**
 * Invocacion de agy por stdin, sin pasar el prompt como argumento.
 *
 * Por que existe: un prompt viaja como argumento de linea de comandos y eso
 * tiene techo del sistema operativo, asi que por encima de ~24 KB el prompt se
 * volcaba a un PROMPT.md temporal y a agy se le pasaba un puntero de la forma
 * "lee este archivo antes de nada". Esa indirección es una instruccion mas, y
 * un modelo puede no seguirla.
 *
 * Medido sobre agy_session_summary con el mismo log de 6,7 MB: tres corridas,
 * tres comportamientos. Una leyo el fichero y respondio inline; otra lo leyo y
 * escribio el documento en OTRO fichero devolviendo solo el enlace; la tercera
 * no lo leyo y contesto "I'm ready for your next request". Ningun cambio de
 * redaccion del puntero arregla eso, porque el fallo es que el trabajo depende
 * de un paso que el modelo puede saltear.
 *
 * Por stdin el prompt llega entero como el turno del usuario, sin fichero
 * intermedio y sin nada que saltear. El esquema es el mismo que ya usa el modo
 * charla (`--input-format stream-json`), verificado en vivo el 2026-08-30.
 */
const { spawn } = require('child_process');
const readline = require('readline');

/**
 * Acumulador puro de la salida NDJSON de agy.
 *
 * Se separa del spawn para poder ejercitarlo con lineas sinteticas: el formato
 * no esta documentado en `agy --help` y se dedujo sondeando, asi que conviene
 * tener fijado por tests que hacemos con cada evento.
 */
function crearAcumuladorStream() {
  const estado = {
    conversationId: null,
    texto: '',
    respuestaFinal: null,
    usage: null,
    durationSeconds: null,
    error: null,
    eventos: 0,
    lineasIlegibles: [],
    cerrado: false
  };

  function primerTexto(...candidatos) {
    for (const c of candidatos) {
      if (typeof c === 'string' && c.length) return c;
    }
    return null;
  }

  function onLine(linea) {
    if (!linea || !linea.trim()) return;

    let ev;
    try {
      ev = JSON.parse(linea);
    } catch {
      // Una linea ilegible no invalida la corrida: agy puede intercalar avisos.
      if (estado.lineasIlegibles.length < 10) estado.lineasIlegibles.push(linea.slice(0, 200));
      return;
    }
    estado.eventos++;

    // El payload va ANIDADO bajo una clave con el mismo nombre del evento.
    // Sondeado en vivo (2026-09-03) contra agy en `--output-format stream-json`:
    //   {"event":"init","conversation_id":"...","init":{...}}
    //   {"event":"step_update","step_update":{step_index,state,step_type,text_delta,...}}
    //   {"event":"result","result":{conversation_id,status,response,duration_seconds,usage}}
    // Asumirlo plano deja la respuesta vacia sin que nada falle, asi que el
    // acceso anidado es lo que hay que fijar con tests.
    const cuerpo = (ev[ev.event] && typeof ev[ev.event] === 'object') ? ev[ev.event] : ev;

    const idConv = ev.conversation_id || cuerpo.conversation_id;
    if (idConv && !estado.conversationId) estado.conversationId = idConv;

    switch (ev.event) {
      case 'init':
        break;

      case 'step_update': {
        // Solo cuenta el texto que emite el agente: `user_input` es el eco del
        // propio prompt y duplicarlo en la respuesta seria un desastre.
        if (cuerpo.step_type && cuerpo.step_type !== 'agent_response') break;
        const delta = primerTexto(cuerpo.text_delta, cuerpo.delta, cuerpo.text);
        if (delta) estado.texto += delta;
        break;
      }

      case 'result': {
        estado.cerrado = true;
        estado.respuestaFinal = primerTexto(cuerpo.response, cuerpo.text, cuerpo.content);
        if (cuerpo.usage) estado.usage = cuerpo.usage;
        if (typeof cuerpo.duration_seconds === 'number') estado.durationSeconds = cuerpo.duration_seconds;
        if (cuerpo.status === 'ERROR' || cuerpo.error) {
          estado.error = cuerpo.error || 'Antigravity devolvio status ERROR';
        }
        break;
      }

      default: {
        // Eventos que no conocemos: si traen texto, no se descarta.
        const delta = primerTexto(cuerpo.text_delta);
        if (delta) estado.texto += delta;
        break;
      }
    }
  }

  function resultado() {
    // La respuesta del evento `result` manda; los deltas son el respaldo por si
    // ese evento no trae el texto completo.
    const respuesta = (estado.respuestaFinal && estado.respuestaFinal.trim())
      ? estado.respuestaFinal
      : estado.texto;
    return {
      conversationId: estado.conversationId,
      response: respuesta,
      usage: estado.usage,
      durationSeconds: estado.durationSeconds,
      error: estado.error,
      eventos: estado.eventos,
      cerrado: estado.cerrado,
      lineasIlegibles: estado.lineasIlegibles
    };
  }

  return { onLine, resultado };
}

/**
 * Lanza agy con el prompt por stdin y devuelve el mismo contrato que
 * executeAgy, para que quien lo llama no tenga que distinguir.
 */
function executeAgyStdin(binario, prompt, args, options = {}) {
  const timeoutMinutes = options.timeoutMinutes || 15;
  const timeoutMs = (timeoutMinutes + 1) * 60 * 1000;
  const cwd = options.cwd || process.cwd();
  const escribirLog = options.log || (() => {});

  const finalArgs = ['--input-format', 'stream-json', '--output-format', 'stream-json', ...args];

  return new Promise((resolve) => {
    const acumulador = crearAcumuladorStream();
    let stderr = '';
    let matado = false;
    const inicio = Date.now();

    escribirLog(`[antigravity-mcp] Spawning (stdin): ${binario} ${finalArgs.join(' ')} (cwd: ${cwd}, prompt: ${prompt.length} chars, timeout: ${timeoutMinutes}m)\n`);

    let child;
    try {
      child = spawn(binario, finalArgs, { cwd, shell: false, env: { ...process.env } });
    } catch (err) {
      return resolve({ success: false, error: `Failed to spawn ${binario}: ${err.message}`, stdout: '', stderr: '' });
    }

    const timer = setTimeout(() => {
      matado = true;
      if (options.terminate) options.terminate(child);
      else { try { child.kill('SIGKILL'); } catch {} }
      resolve({
        success: false,
        error: `Antigravity MCP process watchdog timed out after ${timeoutMinutes} minutes`,
        stdout: acumulador.resultado().response,
        stderr
      });
    }, timeoutMs);

    const rl = readline.createInterface({ input: child.stdout, terminal: false });
    rl.on('line', (linea) => acumulador.onLine(linea));

    child.stderr.on('data', (chunk) => {
      const t = chunk.toString('utf8');
      stderr += t;
      escribirLog(`[agy stderr] ${t}`);
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ success: false, error: `Failed to spawn ${binario}: ${err.message}`, stdout: '', stderr });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (matado) return;

      const r = acumulador.resultado();
      const data = {
        response: r.response,
        conversation_id: r.conversationId,
        duration_seconds: r.durationSeconds != null ? r.durationSeconds : (Date.now() - inicio) / 1000,
        usage: r.usage
      };

      if (code === 0 && !r.error) {
        resolve({ success: true, data, rawOutput: r.response });
        return;
      }

      let errorMsg = r.error
        ? `Antigravity error: "${r.error}".`
        : `Antigravity CLI exited with code ${code}.`;
      if (!r.eventos) {
        errorMsg += ' No se recibio ningun evento por stdout: revisa que esta version de agy acepte --input-format stream-json.';
      }
      if (stderr.trim()) errorMsg += ` Stderr: ${stderr.trim().slice(0, 500)}`;

      resolve({ success: false, data, error: errorMsg, stdout: r.response, stderr });
    });

    // El prompt entero como turno de usuario. Cerrar stdin es lo que le dice a
    // agy que no hay mas turnos y puede resolver.
    try {
      child.stdin.write(JSON.stringify({ event: 'user', message: { content: prompt } }) + '\n');
      child.stdin.end();
    } catch (err) {
      clearTimeout(timer);
      resolve({ success: false, error: `No se pudo escribir el prompt en stdin: ${err.message}`, stdout: '', stderr });
    }
  });
}

module.exports = { crearAcumuladorStream, executeAgyStdin };
