const vr = require('../mcp-server/voice-resolution.js');

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}${detail ? `: ${detail}` : ''}`); }
}
function rejects(name, value) {
  try { vr.validateVoiceSetup(value); check(name, false); }
  catch (err) { check(name, err.code === 'INVALID_VOICE_SETUP', err.message); }
}

const setup = {
  version: 3,
  status: 'configured',
  languages: ['es'],
  default_language: 'es',
  defaults: { es: { identity: { mode: 'soul', soul: 'alya' }, audio: { profile: 'Priscilla', provider: 'omnivoice' } } },
  fallbacks: { es: [{ profile: 'Alya', provider: 'voicebox', engine: 'qwen', model_size: '0.6B' }] }
};
const snapshot = {
  profiles: [
    { id: 'p1', name: 'Priscilla', language: 'es', default_engine: 'qwen' },
    { id: 'p2', name: 'Alya', language: 'es', default_engine: 'qwen' },
    { id: 'p3', name: 'Emily', language: 'en', default_engine: 'kokoro' }
  ],
  voicebox: { reachable: true, startable: true, models: [
    { model_name: 'qwen-tts-0.6B', downloaded: true, loaded: false },
    { model_name: 'kokoro', downloaded: true, loaded: true }
  ] },
  omnivoice: { reachable: false, startable: true, weights_downloaded: true },
  samples: { p1: { sample_exists: true }, p2: { sample_exists: false } },
  souls: { alya: true }
};

vr.validateVoiceSetup(setup);
check('setup v3 válido', true);
rejects('rechaza default_language ausente', { ...setup, default_language: undefined });
rejects('rechaza Qwen sin model_size', { ...setup, defaults: { es: { identity: { mode: 'neutral' }, audio: { profile: 'Alya', provider: 'voicebox', engine: 'qwen' } } } });
rejects('rechaza engine en OmniVoice', { ...setup, defaults: { es: { identity: { mode: 'neutral' }, audio: { profile: 'Alya', provider: 'omnivoice', engine: 'qwen' } } } });
check('ausencia de setup = unconfigured', vr.setupState({}) === 'unconfigured');
check('voz_por_perfil = legacy', vr.setupState({ vozPorPerfil: { Alya: 'voicebox' } }) === 'legacy');
check('setup manual inválido no autoriza audio', vr.setupState({ voiceSetup: { version: 3, status: 'configured', languages: ['es'] } }) === 'invalid');

let r = vr.resolveVoice({ config: { voiceSetup: setup }, snapshot });
check('default conserva Soul y usa OmniVoice', r.status === 'audio' && r.audio.profile_name === 'Priscilla' && r.identity.soul === 'alya');
r = vr.resolveVoice({ args: { voice: 'Alya', personality: true }, config: {}, snapshot });
check('voice-only sigue funcionando', r.status === 'audio' && r.audio.provider === 'voicebox' && r.audio.model_size === '0.6B' && r.identity.mode === 'profile', JSON.stringify(r));
r = vr.resolveVoice({ args: { voice: 'Emily', language: 'es' }, config: {}, snapshot });
check('idioma contradictorio no cambia perfil', r.status === 'text-only' && r.reason === 'language_mismatch');
r = vr.resolveVoice({ args: { voice: 'Alya', motor: 'omnivoice' }, config: {}, snapshot });
check('OmniVoice sin muestra cae a texto, no a otra voz', r.status === 'text-only' && r.reason === 'sample_missing');
r = vr.resolveVoice({ args: { provider: 'voicebox', motor: 'omnivoice', voice: 'Alya' }, config: {}, snapshot });
check('aliases contradictorios fallan', r.reason === 'ambiguous_explicit_route');
r = vr.resolveVoice({ args: { voice: 'Priscilla', engine: 'qwen', model_size: '0.6B' }, config: {}, snapshot });
check('engine puntual implica Voicebox, no se pierde en OmniVoice', r.status === 'audio' && r.audio.provider === 'voicebox');
r = vr.resolveVoice({ args: { provider: 'voicebox' }, config: { voiceSetup: setup }, snapshot });
check('override de provider aplica sobre el default configurado', r.status === 'audio' && r.audio.provider === 'voicebox');
r = vr.resolveVoice({ args: { voice: 'Priscilla' }, config: { voiceSetup: setup, vozPorPerfil: { Priscilla: 'voicebox' } }, snapshot });
check('legacy no pisa voice_setup configurado', r.status === 'audio' && r.audio.provider === 'omnivoice');
r = vr.resolveVoice({ config: { voiceSetup: setup }, snapshot: { ...snapshot, omnivoice: {}, samples: {} } });
check('fallback acústico conserva Soul', r.status === 'audio' && r.fallback && r.audio.profile_name === 'Alya' && r.identity.soul === 'alya');
r = vr.resolveVoice({ config: { voiceSetup: setup }, snapshot: { ...snapshot, souls: {} } });
check('Soul ausente degrada visible a neutral', r.status === 'audio' && r.identity.mode === 'neutral' && r.identity.reason === 'identity_unavailable');
r = vr.resolveVoice({ config: {}, snapshot });
check('sin setup ni voz = setup_required', r.status === 'text-only' && r.reason === 'setup_required');
r = vr.resolveVoice({ config: { voiceSetup: { version: 3, status: 'configured', languages: ['es'] } }, snapshot });
check('setup manual inválido falla cerrado', r.status === 'text-only' && r.reason === 'invalid_setup');

console.log(`\nvoice-resolution: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
