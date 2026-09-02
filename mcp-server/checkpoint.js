/**
 * Extraccion del ultimo checkpoint del log de sesion de Claude Code.
 *
 * Vive en su propio modulo -y no dentro de index.js- porque requerir index.js
 * arranca el servidor MCP: engancha stdin y deja vivo el event loop. Esto es
 * una funcion pura sobre un fichero, y tiene que poder afirmarse en un test.
 *
 * La fuente es el JSONL que Claude Code ya escribe. Deliberadamente NO se
 * intercepta la API con un proxy (ANTHROPIC_BASE_URL): el log contiene los
 * comandos, sus resultados y las ediciones, que es todo lo que hace falta. Un
 * proxy anadiria un punto de fallo en el camino de la API sin aportar dato
 * nuevo.
 */

const fs = require('node:fs');

// Cuantos turnos de usuario se puede retroceder buscando trabajo que narrar.
// Con un tope, porque narrar algo de hace media hora como si acabara de pasar
// es peor que decir que no hay nada.
const MAX_RETROCESO_TURNOS = 3;

// ==============================================================================
// Deteccion de ejecuciones de tests
// ==============================================================================
//
// La version anterior era `comando.toLowerCase().includes('test')` sobre una
// lista de palabras. Medido contra 1141 comandos de 13 sesiones reales de este
// proyecto, eso marcaba 280 comandos como tests con un 68% de falsos positivos:
// leer `test-bridge.js` con sed, un heredoc cuyo CONTENIDO menciona «test», un
// `grep`, o un `echo "npm test: $?"`. Y como el estado global lo fija el ULTIMO
// comando que casa, bastaba que el ultimo fuese un `sed` para que el veredicto
// saliera de ahi.

// Ruido que puede preceder al ejecutor sin cambiar que lo sea. Incluye
// `bash -c`, cuyo payload SI es shell — al reves que el `-e` de node, que es
// programa; ver SCRIPT_EN_LINEA.
const PREFIJO_RUIDO = /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+|sudo\s+|timeout\s+\d+\s+|time\s+|env\s+|(?:ba|z|k)?sh\s+-c\s+['"]?)+/;

// Se separa por operadores de shell Y por `$(`, backtick y `do `, porque una
// suite lanzada dentro de una sustitucion o de un bucle sigue siendo una suite.
const SEPARADORES = /&&|\|\||[;|]|\$\(|`|\bdo\s/;

const EJECUTOR_TESTS = new RegExp([
  // npm/pnpm/yarn/bun: `test`, `run test`, `run test:x`, `run x:test`, admitiendo
  // banderas en medio (`npm run --silent bridge:test`).
  String.raw`^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:-{1,2}[\w-]+(?:=\S+)?\s+)*(?:test|test:[\w:-]+|[\w-]+:test)\b`,
  // Ejecutores invocados directamente.
  String.raw`^(?:npx\s+)?(?:jest|vitest|mocha|ava|pytest|tap|phpunit|rspec)\b`,
  // Ecosistemas con subcomando `test`.
  String.raw`^(?:cargo|go|dotnet|mix|swift|flutter)\s+test\b`,
  String.raw`^ctest\b`,
  // Un fichero de test ejecutado a mano: bajo test/ o tests/, o con «test» en
  // el nombre. Cubre `node test/run.js` y `node test-bridge.js`.
  String.raw`^(?:node|python3?|deno\s+run)\s+(?:-{1,2}[\w-]+(?:=\S+)?\s+)*"?(?:[^"\s]*[\\/])?(?:tests?[\\/][^"\s]*|[\w.-]*test[\w.-]*)\.(?:m?js|cjs|ts|py)"?(?:\s|$)`
].join('|'), 'i');

/**
 * Recorta la parte EJECUTABLE de un comando, descartando el contenido de los
 * heredocs.
 *
 * Un heredoc (`cat > x.js <<'EOF'`) mete el contenido de un fichero en las
 * lineas siguientes, y ahi la palabra «test» aparece por casualidad — era una
 * de las fuentes de falsos positivos.
 *
 * La primera version resolvia eso quedandose solo con la PRIMERA linea, y esa
 * regla estaba mal: un bloque multilinea legitimo pone el `cd` en la primera y
 * el ejecutor en la segunda, asi que `npm test` dejaba de detectarse. Se vio
 * ejercitando el extractor sobre una sesion real, no en los tests.
 *
 * Se conserva la linea que ABRE el heredoc, porque el ejecutor puede estar
 * antes del `<<` en esa misma linea.
 */
function parteEjecutable(command) {
  const lineas = String(command || '').split('\n');
  const corte = lineas.findIndex(l => /<<-?\s*['"]?[A-Za-z_]\w*['"]?\s*$/.test(l));
  return (corte === -1 ? lineas : lineas.slice(0, corte + 1)).join('\n');
}

// Un interprete con script en linea: lo que sigue es PROGRAMA, no shell. Un
// `node -e "...npm test..."` lleva ese texto como cadena literal, no lo
// ejecuta. Se distingue por el interprete: en `bash -c "npm test"` el payload
// si es shell y ahi los tests son reales.
const SCRIPT_EN_LINEA = /^(?:node|python3?|deno)\b[^\n]*?(?:^|\s)(?:-e|--eval|-p|--print|-c)(?:\s|$|=)/;

/**
 * ¿Este comando ejecuta una suite de tests?
 */
function isTestExecution(command) {
  for (const bruto of parteEjecutable(command).split(/\n/).join(';').split(SEPARADORES)) {
    const seg = bruto.trim().replace(PREFIJO_RUIDO, '').trim();
    if (!seg) continue;
    // A partir de un script en linea, el resto del comando es su contenido.
    if (SCRIPT_EN_LINEA.test(seg)) break;
    // `node --check fichero.test.js` comprueba la sintaxis, no ejecuta nada.
    if (/^node\b/.test(seg) && /(?:^|\s)--check(?:\s|$)/.test(seg)) continue;
    if (EJECUTOR_TESTS.test(seg)) return true;
  }
  return false;
}

/**
 * Veredicto de una ejecucion de tests.
 *
 * `is_error` NO basta por si solo: canalizar la salida (`| tail`, `| grep`,
 * `> fichero`) enmascara el codigo de salida, y medido sobre 91 ejecuciones
 * reales de este proyecto hubo 7 fallos autenticos que `is_error` no vio y que
 * la busqueda en la salida si atrapo. Se usan las dos senales.
 *
 * El orden importa: primero se descartan los recuentos en cero («0 failed»,
 * «0 failing»), que de otro modo marcarian como fallida una corrida limpia.
 */
function testFailed(resultado) {
  if (!resultado) return null;
  if (resultado.isError) return true;

  const salida = String(resultado.content || '').toLowerCase();
  const sinCeros = salida
    .replace(/\b0\s+(?:tests?\s+)?(?:failed|failing|failures?)\b/g, '')
    .replace(/\bfailures?\s*[:=]\s*0\b/g, '')
    .replace(/\bfailed\s*[:=]\s*0\b/g, '');

  return /\bfail(?:ed|ing|ures?)\b/.test(sinCeros);
}

// ==============================================================================
// Lectura del log
// ==============================================================================

function esMensajeRealDeUsuario(obj) {
  if (obj.type !== 'user' || obj.isMeta) return false;
  const c = obj.message?.content;
  if (!c) return false;
  if (Array.isArray(c)) {
    if (c.some(item => item.type === 'tool_result')) return false;
    return c.some(item => item.type === 'text' && item.text && item.text.trim());
  }
  return typeof c === 'string' && c.trim().length > 0;
}

function textoDeUsuario(obj) {
  const c = obj.message?.content;
  if (typeof c === 'string') return c.trim();
  if (Array.isArray(c)) {
    return c.filter(item => item.type === 'text').map(item => item.text || '').join(' ').trim();
  }
  return '';
}

function checkpointVacio() {
  return {
    userGoal: 'General development task',
    filesModified: [],
    commandsCount: 0,
    testExecutions: [],
    overallTestStatus: 'NO_TESTS',
    assistantNotes: '',
    turnsBack: 0
  };
}

/**
 * Construye el checkpoint a partir de una ventana que empieza en `startIndex`.
 */
function construirDesde(lines, startIndex, userGoal) {
  const filesModified = new Set();
  const commandsRun = [];
  const toolResults = new Map();
  let latestAssistantText = '';

  for (const line of lines.slice(startIndex)) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }

    if (obj.type === 'assistant' && obj.message?.content) {
      for (const item of obj.message.content) {
        if (item.type === 'tool_use') {
          const name = item.name || '';
          const inp = item.input || {};

          if (['Edit', 'Write', 'NotebookEdit'].includes(name) && inp.file_path) {
            filesModified.add(inp.file_path);
          } else if (['write_to_file', 'replace_file_content'].includes(name) && inp.TargetFile) {
            filesModified.add(inp.TargetFile);
          }

          if (name === 'Bash' || name === 'run_command') {
            const cmd = inp.command || inp.CommandLine || '';
            if (cmd) commandsRun.push({ id: item.id, command: cmd, ts: obj.timestamp });
          }
        } else if (item.type === 'text' && item.text && item.text.trim()) {
          if (!item.text.includes('agy_narrate')) latestAssistantText = item.text.trim();
        }
      }
    } else if (obj.type === 'user' && Array.isArray(obj.message?.content)) {
      for (const item of obj.message.content) {
        if (item.type === 'tool_result' && item.tool_use_id) {
          toolResults.set(item.tool_use_id, {
            isError: Boolean(item.is_error),
            content: typeof item.content === 'string' ? item.content : JSON.stringify(item.content)
          });
        }
      }
    }
  }

  const testExecutions = [];
  for (const cmd of commandsRun) {
    if (!isTestExecution(cmd.command)) continue;
    const res = toolResults.get(cmd.id);
    const fallo = testFailed(res);
    testExecutions.push({
      command: cmd.command.split('\n')[0].slice(0, 120),
      passed: fallo === null ? null : !fallo,
      outputSnippet: res ? res.content.slice(0, 200) : ''
    });
  }

  let overallTestStatus = 'NO_TESTS';
  if (testExecutions.length > 0) {
    // Si CUALQUIER ejecucion de la ventana fallo, el checkpoint fallo. Antes se
    // miraba solo la ultima, asi que una suite rota seguida de una verde se
    // narraba como exito.
    const algunFallo = testExecutions.some(t => t.passed === false);
    const algunaPaso = testExecutions.some(t => t.passed === true);
    overallTestStatus = algunFallo ? 'FAILED' : (algunaPaso ? 'PASSED' : 'PENDING');
  }

  return {
    userGoal,
    filesModified: Array.from(filesModified),
    commandsCount: commandsRun.length,
    testExecutions,
    overallTestStatus,
    assistantNotes: latestAssistantText.slice(0, 500),
    turnsBack: 0
  };
}

/**
 * Extrae el ultimo checkpoint con trabajo dentro.
 *
 * La ventana arranca en el ultimo mensaje del usuario. El problema: si ese
 * mensaje ES la peticion de narrar, la ventana no contiene nada, porque el
 * trabajo ocurrio ANTES. Medido en una sesion real, el checkpoint salio con 0
 * comandos y 0 tests -y por tanto NO_TESTS- cuando un turno antes habia 32
 * comandos y 12 suites en verde. La narracion dijo fielmente que no se habian
 * corrido tests: el modelo no invento nada, se le paso un checkpoint vacio.
 *
 * La version anterior intentaba detectarlo con
 * `texto.length < 50 && texto.includes('narra')`, que falla en cuanto la
 * peticion se redacta como una frase normal (el caso real median 157
 * caracteres). En vez de adivinar la INTENCION por el texto, se mira el
 * CONTENIDO: si la ventana no tiene ni comandos ni ediciones, no hay nada que
 * narrar ahi, y se retrocede un turno. Funciona en cualquier idioma y con
 * cualquier fraseo, incluido el comando `/lagrange:narrate`.
 */
function extractLastCheckpoint(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Session log file not found: ${filePath}`);
  }

  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(l => l.trim());

  const userMessages = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      const obj = JSON.parse(lines[i]);
      if (esMensajeRealDeUsuario(obj)) {
        userMessages.push({ lineIndex: i, text: textoDeUsuario(obj), ts: obj.timestamp });
      }
    } catch {}
  }

  if (userMessages.length === 0) return checkpointVacio();

  let idx = userMessages.length - 1;
  let checkpoint = construirDesde(lines, userMessages[idx].lineIndex, userMessages[idx].text);
  let retrocesos = 0;

  while (
    checkpoint.commandsCount === 0 &&
    checkpoint.filesModified.length === 0 &&
    idx > 0 &&
    retrocesos < MAX_RETROCESO_TURNOS
  ) {
    idx--;
    retrocesos++;
    checkpoint = construirDesde(lines, userMessages[idx].lineIndex, userMessages[idx].text);
  }

  checkpoint.turnsBack = retrocesos;
  return checkpoint;
}

module.exports = {
  MAX_RETROCESO_TURNOS,
  isTestExecution,
  testFailed,
  extractLastCheckpoint
};
