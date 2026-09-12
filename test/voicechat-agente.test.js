/**
 * Charla con freno, lado Python (plan-charla-modo-agente): qué cuenta como
 * "sí", qué acción de agy_voice_stream corresponde a cada frase, cómo pregunta
 * la charla por lo que agy tuvo negado y cómo avisa de lo que escribió sin
 * preguntar.
 *
 * Corre common.py de verdad con Python. Sin Python en el PATH, se omite y lo
 * dice.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { check, group, report } = require('./lib/assert');

const REPO_ROOT = path.join(__dirname, '..');

const SCRIPT = `
import sys, json
sys.path.insert(0, ${JSON.stringify(path.join(REPO_ROOT, 'voice-chat'))})
import common
r = {}

ic = common.interpretar_confirmacion
r["confirmacion_es"] = [ic(x, "es") for x in [
    "Sí.", "si", "Dale", "¡Hacelo!", "Sí, dale.", "No.", "Cancelá", "mejor no",
    "sí pero antes contame qué vas a hacer", "hola", "", None]]
r["confirmacion_en"] = [ic(x, "en") for x in ["Yes.", "Go ahead!", "No", "Cancel.", "yes I think you should do that"]]

apt = common.accion_para_turno
r["acciones"] = [
    apt("Sí.", "es", 100.0, 150.0),
    apt("Sí.", "es", 100.0, 191.0),
    apt("Sí.", "es", None, 150.0),
    apt("No.", "es", 100.0, 150.0),
    apt("contame un chiste", "es", 100.0, 150.0),
    apt("Pará.", "es", None, 0, True),
    apt("seguí nomás con eso", "es", None, 0, True),
]
r["cancelado"] = common.TURNO_CANCELADO["es"]

pn = common.pregunta_de_negaciones
r["preguntas"] = [
    pn([{"tipo": "command", "objetivo": "git status"}], "es"),
    pn([{"tipo": "mcp", "objetivo": "playwright/browser_navigate"}], "es"),
    pn([{"tipo": "mcp", "objetivo": "jira/create_issue"}], "es"),
    pn([{"tipo": "read_url", "objetivo": "nodejs.org"}], "es"),
    pn([{"tipo": "mcp", "objetivo": "playwright/browser_navigate"}, {"tipo": "mcp", "objetivo": "playwright/browser_click"},
        {"tipo": "command", "objetivo": "ls"}], "es"),
    pn([{"tipo": "command", "objetivo": 'git commit -m "arreglo del bug de la charla que no frenaba nada de nada"'}], "es"),
    pn([{"tipo": "command", "objetivo": "git status"}], "en"),
    pn([], "es"),
]

ae = common.aviso_escrituras
r["avisos"] = [ae(["C:\\\\vs work\\\\repo\\\\notas.txt"], "es"), ae(["/a/x.js", "C:\\\\b\\\\y.js", "/a/x.js"], "es"),
               ae([], "es"), ae(["/a/x.js"], "en")]

cp = common.clave_de_paso
r["pasos"] = [
    cp({"nombre": "run_command", "servidor": None, "accion": None, "destino": None}, True),
    cp({"nombre": "run_command"}, False),
    cp({"nombre": "write_to_file", "destino": "C:\\\\vs work\\\\repo\\\\a.txt"}, False),
    cp({"nombre": "write_to_file", "destino": "C:\\\\Users\\\\u\\\\.gemini\\\\antigravity-cli\\\\brain\\\\c\\\\plan.md"}),
    cp({"nombre": "write_to_file", "destino": "/home/u/.gemini/antigravity-cli/scratch/x"}),
    cp({"nombre": "call_mcp_tool", "servidor": "playwright"}, False),
    cp("run_command", False),
]
r["aviso_arranque"] = "sin tu sí" in common.AVISO_CONFIRMACION["es"]
r["senales"] = common.ORDEN_SENALES[-2:] == ["comando", "escribiendo"] and all(
    k in common.FRASES_SENAL[l] for l in ("es", "en") for k in common.ORDEN_SENALES)
print("RESULTADO " + json.dumps(r, ensure_ascii=False))
`;

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-agente-'));
  try {
    const r = spawnSync('python', ['-c', SCRIPT], {
      encoding: 'utf8',
      env: { ...process.env, LAGRANGE_VOICEBOX_DIR: dir, PYTHONIOENCODING: 'utf-8' },
      timeout: 60000
    });

    await group('charla con freno (voice-chat)', () => {
      if (r.error || (r.status !== 0 && /not found|no se encontr|was not found/i.test(r.stderr || ''))) {
        console.log('  (Python no disponible: se omite)');
        check('python no disponible — omitido', true);
        return;
      }
      const linea = (r.stdout || '').split(/\r?\n/).find((l) => l.startsWith('RESULTADO '));
      check('el script corrió', !!linea, r.stderr);
      if (!linea) return;
      const x = JSON.parse(linea.slice('RESULTADO '.length));
      const igual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

      check('qué cuenta como sí o no (es)', igual(x.confirmacion_es,
        ['si', 'si', 'si', 'si', 'si', 'no', 'no', 'no', null, null, null, null]), JSON.stringify(x.confirmacion_es));
      check('qué cuenta como sí o no (en)', igual(x.confirmacion_en, ['si', 'si', 'no', 'no', null]), JSON.stringify(x.confirmacion_en));
      check('acción por frase: sí, vencida, sin pendiente, no, otra cosa, pará, seguir', igual(x.acciones, [
        ['confirm', null], ['send', 'Sí.'], ['send', 'Sí.'], ['send', x.cancelado], ['send', 'contame un chiste'],
        ['stop_exec', null], ['send', 'seguí nomás con eso']]), JSON.stringify(x.acciones));
      check('preguntas por lo negado', igual(x.preguntas, [
        'Agy quiere ejecutar el comando git status. ¿Lo hago?',
        'Agy quiere usar el navegador. ¿Lo hago?',
        'Agy quiere usar jira. ¿Lo hago?',
        'Agy quiere leer nodejs.org. ¿Lo hago?',
        'Agy quiere usar el navegador y una cosa más. ¿Lo hago?',
        'Agy quiere ejecutar el comando git commit -m arreglo del bug de la charla que no frenaba. ¿Lo hago?',
        'Agy wants to run the command git status. Should I?',
        null]), JSON.stringify(x.preguntas));
      check('aviso de escrituras sin preguntar', igual(x.avisos, [
        'Agy modificó notas.txt sin preguntar.', 'Agy modificó 2 archivos sin preguntar.', null,
        'Agy changed x.js without asking.']), JSON.stringify(x.avisos));
      check('señales: comando solo en ejecución, escrituras de agy sin señal', igual(x.pasos,
        ['comando', null, 'escribiendo', null, null, 'navegador', null]), JSON.stringify(x.pasos));
      check('aviso de arranque', x.aviso_arranque);
      check('claves nuevas al final y con frase en los dos idiomas', x.senales);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  process.exit(report() ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
