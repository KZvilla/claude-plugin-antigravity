const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, removeFixture } = require('./lib/mcp-client');
const { check, group, report } = require('./lib/assert');

async function main() {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-setup-v3-'));
  const cwd = path.join(fixture, 'project');
  const home = path.join(fixture, 'home');
  fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const server = startServer({ cwd });
  try {
    await server.initialize();
    await group('instalación limpia no activa audio implícitamente', async () => {
      const say = await server.callTool('agy_say', {
        text: 'Este texto debe conservarse.', send_telegram: false, local_playback: true,
        voicebox_url: 'http://127.0.0.1:1'
      }, 10000);
      const output = say.result?.content?.[0]?.text || '';
      check('responde text-only, no como error', !say.result?.isError && /`text-only`/.test(output), output);
      check('explica setup_required', /`setup_required`/.test(output), output);
      check('conserva el texto', output.includes('Este texto debe conservarse.'));
      check('omite playback sin intentar audio', /playback_omitted_text_only/.test(output));

      const voices = await server.callTool('agy_narrate_voices', {
        language: 'all', voicebox_url: 'http://127.0.0.1:1'
      }, 10000);
      const discovery = voices.result?.content?.[0]?.text || '';
      check('discovery declara que no arrancó Voicebox', /no se inició durante discovery/.test(discovery), discovery);
      check('discovery informa setup unconfigured', /`unconfigured`/.test(discovery), discovery);
    });

    await group('voice_setup se valida antes de persistir', async () => {
      const configPath = path.join(cwd, '.claude', 'antigravity.json');
      let result = await server.callTool('agy_set_config', {
        scope: 'project', voice_setup: {
          version: 3, status: 'configured', languages: ['es'],
          defaults: {}, fallbacks: {}
        }
      });
      check('rechaza setup incompleto', result.result?.isError === true);
      check('no persiste configuración inválida', !fs.existsSync(configPath));

      const valid = {
        version: 3, status: 'configured', languages: ['es'], default_language: 'es',
        defaults: { es: { identity: { mode: 'neutral' }, audio: {
          profile: 'Alya', provider: 'voicebox', engine: 'qwen', model_size: '0.6B'
        } } },
        fallbacks: { es: [] }
      };
      result = await server.callTool('agy_set_config', { scope: 'project', voice_setup: valid });
      const stored = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      check('persiste setup válido como bloque', !result.result?.isError && JSON.stringify(stored.voice_setup) === JSON.stringify(valid));
    });
  } finally {
    await server.stop();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    removeFixture(fixture);
  }
  process.exit(report() ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
