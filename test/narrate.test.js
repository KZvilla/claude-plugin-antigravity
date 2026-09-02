/**
 * agy_narrate y agy_say son dos herramientas con contratos distintos.
 *
 * Contexto: `agy_narrate` nacio como «una pequena narracion de la sesion»: no
 * recibe texto, lo deriva del log. Cuando hizo falta narrar un texto concreto,
 * la opcion facil era anadirle un `text` opcional — y eso degrada la seleccion
 * de herramienta, porque la mitad de los parametros quedan sin sentido en cada
 * modo y la descripcion tiene que decir «narra la sesion, salvo que pases
 * texto». Los modelos eligen leyendo esa descripcion.
 *
 * Esta suite fija las dos mitades del contrato: la separacion en la superficie
 * de herramientas, y el saneado determinista del texto hablado, que es donde
 * vive el riesgo real — ese texto se sintetiza, se manda al chat de Telegram y
 * queda escrito en daemon.log.
 */
const path = require('path');
const { startServer, REPO_ROOT } = require('./lib/mcp-client');
const { check, group, report } = require('./lib/assert');
const {
  normalizeSpokenText,
  getPolishPrompt,
  SPOKEN_TEXT_LIMIT
} = require(path.join(REPO_ROOT, 'mcp-server', 'spoken-text.js'));

const FAKE_TOKEN = '1234567890:AAFakeTokenForTestingOnly_DoNotUse';

async function main() {
  // --- Superficie de herramientas ----------------------------------------
  const server = startServer({ cwd: REPO_ROOT });
  await server.initialize();
  const tools = (await server.listTools()).result.tools;
  const say = tools.find(t => t.name === 'agy_say');
  const narrate = tools.find(t => t.name === 'agy_narrate');

  await group('agy_say y agy_narrate son herramientas separadas', () => {
    check('agy_say esta en tools/list', !!say);
    check('agy_narrate sigue existiendo', !!narrate);
    check('agy_say exige `text`', say && JSON.stringify(say.inputSchema.required) === '["text"]');
    check('agy_say acepta `polish`', !!(say && say.inputSchema.properties.polish));
    // La razon de ser de la division: cada descripcion tiene que decir cuando
    // NO usarse, o el modelo elegira la equivocada.
    check('agy_say remite a agy_narrate para resumir la sesion', !!(say && /agy_narrate/.test(say.description)));
    check('agy_narrate declara que no recibe texto', !!(narrate && /takes no text/i.test(narrate.description)));
    check('agy_narrate NO acepta `text`', narrate && !narrate.inputSchema.properties.text);
    check('agy_say NO acepta `session_id`', say && !say.inputSchema.properties.session_id);
  });

  await group('telegram_bridge_status diagnostica el desfase entre copias', async () => {
    // Existe por una razon concreta: durante el desarrollo, el daemon y las
    // herramientas MCP pueden salir de copias distintas del bridge. No es un
    // fallo -el estado se comparte-, pero explica por que un cambio de codigo
    // solo lo ve una mitad, y sin esta herramienta hay que deducirlo a mano.
    const t = tools.find(x => x.name === 'telegram_bridge_status');
    check('esta en tools/list', !!t);
    check('no necesita argumentos', t && JSON.stringify(t.inputSchema.properties) === '{}');
    check('se describe como read-only', !!(t && /read-only/i.test(t.description)));
    check('nombra el sintoma que resuelve', !!(t && /telegram_ask/i.test(t.description)));

    const res = await server.callTool('telegram_bridge_status', {});
    const texto = res.result && res.result.content && res.result.content[0].text;
    check('no es un error', !(res.result && res.result.isError), texto);
    check('informa que codigo corre cada mitad', !!(texto && /Herramientas MCP/.test(texto)));
    check('informa el .env efectivo', !!(texto && /Credenciales/.test(texto)));
    check('informa el estado compartido', !!(texto && /Estado compartido/.test(texto)));
    check('nombra el directorio de datos', !!(texto && /antigravity-telegram-bridge/.test(texto)));
  });

  await group('agy_say rechaza una llamada sin texto util', async () => {
    const res = await server.callTool('agy_say', { text: '   ' });
    const texto = res.result && res.result.content && res.result.content[0].text;
    check('devuelve isError', !!(res.result && res.result.isError));
    check('explica que falta `text`', !!(texto && /text/.test(texto)));
  });

  server.stop();

  // --- Saneado del texto hablado -----------------------------------------
  await group('normalizeSpokenText redacta secretos SIEMPRE', () => {
    // Es lo que hace seguro aceptar texto libre: el resultado se sintetiza, se
    // manda como caption a Telegram y se escribe en daemon.log.
    const r = normalizeSpokenText(`El token es ${FAKE_TOKEN} y ya esta`);
    check('el token no sobrevive', !r.text.includes('AAFakeToken'), r.text);
    check('queda marcado como redactado', /\[REDACTED\]/.test(r.text), r.text);

    const url = normalizeSpokenText(`fallo en https://api.telegram.org/bot${FAKE_TOKEN}/sendMessage`);
    check('tambien dentro de una URL de la API', !url.text.includes('AAFakeToken'), url.text);
  });

  await group('normalizeSpokenText produce texto decible', () => {
    const md = normalizeSpokenText('**Listo**: revisa `bot.js` y el [informe](https://ejemplo.com/x).');
    check('quita el enfasis', !/[*_~#]/.test(md.text), md.text);
    check('conserva el texto del enlace', /informe/.test(md.text), md.text);
    check('descarta la URL', !/ejemplo\.com/.test(md.text), md.text);

    const code = normalizeSpokenText('Antes del bloque\n```js\nconst x = 1;\n```\ndespues del bloque');
    check('elimina el bloque de codigo entero', !/const x/.test(code.text), code.text);
    check('conserva lo que lo rodea', /Antes del bloque/.test(code.text) && /despues del bloque/.test(code.text), code.text);

    const ruta = normalizeSpokenText('Se modifico C:\\vs work\\proyecto\\telegram-bridge\\bot.js hoy');
    check('deja solo el nombre del fichero', /bot\.js/.test(ruta.text) && !/telegram-bridge/.test(ruta.text), ruta.text);

    const emoji = normalizeSpokenText('✅ Deploy listo 🚀 sin incidencias');
    check('descarta los emoji', !/[✅🚀]/.test(emoji.text), emoji.text);
    check('conserva las palabras', /Deploy listo/.test(emoji.text) && /sin incidencias/.test(emoji.text), emoji.text);

    const espacios = normalizeSpokenText('  varias   lineas\n\n  y   espacios  ');
    check('colapsa el espacio en blanco', espacios.text === 'varias lineas y espacios', espacios.text);

    // Quitar el enfasis deja el hueco que ocupaba: «**Listo**:» daba «Listo :».
    const puntuacion = normalizeSpokenText('**Listo**: todo bien **ya** , de verdad ¿ seguro ?');
    check('la puntuacion queda pegada a su palabra', !/\s[,.;:!?]/.test(puntuacion.text), puntuacion.text);
    check('empieza por la palabra, no por el hueco', /^Listo:/.test(puntuacion.text), puntuacion.text);
  });

  await group('normalizeSpokenText acota la longitud', () => {
    const corto = normalizeSpokenText('Una frase corta.');
    check('un texto corto no se trunca', corto.truncated === false);
    check('informa la longitud original', corto.originalLength === 'Una frase corta.'.length);

    const largo = normalizeSpokenText(('Frase de relleno numero uno. ').repeat(200));
    check('un texto largo se marca truncado', largo.truncated === true);
    check('respeta el tope', largo.text.length <= SPOKEN_TEXT_LIMIT, String(largo.text.length));
    // Cortar a media palabra suena a fallo; cortar en un punto suena a final.
    check('corta en final de frase', /\.$/.test(largo.text), largo.text.slice(-40));

    const soloRuido = normalizeSpokenText('```\ncodigo\n```');
    check('un texto que era solo codigo queda vacio', soloRuido.text === '', soloRuido.text);
  });

  await group('el prompt de polish prohibe inventar', () => {
    // Un modelo que «mejora» anadiendo hechos convierte una nota de voz en una
    // fuente de datos falsos que suena igual de fiable que una correcta.
    const p = getPolishPrompt('Deploy hecho', 'es', { name: 'Diego Alvarez' });
    check('incluye el texto original', /Deploy hecho/.test(p));
    check('prohibe anadir hechos', /Do not add facts/i.test(p));
    check('prohibe inventar un estado', /Never invent a status/i.test(p));
    check('fija el idioma', /Spanish/.test(p));
    check('pide solo el texto final', /Output ONLY the final spoken text/i.test(p));

    const en = getPolishPrompt('x', 'en', { name: 'Emily' });
    check('respeta el ingles', /English/.test(en) && !/Spanish/.test(en));

    const persona = getPolishPrompt('x', 'es', { name: 'Emily', personality: 'calida' }, true);
    check('la persona no puede cambiar el mensaje', /never at the cost of changing what the message says/i.test(persona));
  });

  report();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
