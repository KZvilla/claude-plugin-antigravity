'use strict';

const LANGUAGES = new Set(['es', 'en']);
const PROVIDERS = new Set(['voicebox', 'omnivoice']);
const IDENTITY_MODES = new Set(['neutral', 'soul', 'profile']);
const MAX_FALLBACKS = 3;

function language(value) {
  const lang = String(value || '').trim().toLowerCase().slice(0, 2);
  return LANGUAGES.has(lang) ? lang : null;
}

function fail(message) {
  const error = new Error(message);
  error.code = 'INVALID_VOICE_SETUP';
  throw error;
}

function validateIdentity(identity, where) {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) fail(`${where}.identity debe ser un objeto.`);
  if (!IDENTITY_MODES.has(identity.mode)) fail(`${where}.identity.mode debe ser neutral, soul o profile.`);
  const allowed = identity.mode === 'soul' ? ['mode', 'soul'] : ['mode'];
  for (const key of Object.keys(identity)) if (!allowed.includes(key)) fail(`${where}.identity.${key} no está permitido.`);
  if (identity.mode === 'soul' && (typeof identity.soul !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(identity.soul))) {
    fail(`${where}.identity.soul debe ser una clave de Soul válida.`);
  }
}

function validateAudio(audio, where) {
  if (!audio || typeof audio !== 'object' || Array.isArray(audio)) fail(`${where}.audio debe ser un objeto.`);
  for (const key of Object.keys(audio)) {
    if (!['profile', 'provider', 'engine', 'model_size'].includes(key)) fail(`${where}.audio.${key} no está permitido.`);
  }
  if (typeof audio.profile !== 'string' || !audio.profile.trim() || audio.profile.length > 128) fail(`${where}.audio.profile es obligatorio.`);
  if (!PROVIDERS.has(audio.provider)) fail(`${where}.audio.provider debe ser voicebox u omnivoice.`);
  if (audio.provider === 'omnivoice') {
    if (audio.engine !== undefined || audio.model_size !== undefined) fail(`${where}.audio no admite engine/model_size con omnivoice.`);
  } else {
    if (typeof audio.engine !== 'string' || !audio.engine.trim() || audio.engine.length > 64) fail(`${where}.audio.engine es obligatorio con voicebox.`);
    const qwen = audio.engine === 'qwen' || audio.engine === 'qwen_custom_voice';
    if (qwen && (typeof audio.model_size !== 'string' || !audio.model_size.trim() || audio.model_size.length > 32)) {
      fail(`${where}.audio.model_size es obligatorio para motores Qwen.`);
    }
    if (!qwen && audio.model_size !== undefined) fail(`${where}.audio.model_size solo aplica a motores Qwen.`);
  }
}

function validateVoiceSetup(setup) {
  if (!setup || typeof setup !== 'object' || Array.isArray(setup)) fail('voice_setup debe ser un objeto.');
  for (const key of Object.keys(setup)) {
    if (!['version', 'status', 'languages', 'default_language', 'defaults', 'fallbacks'].includes(key)) fail(`voice_setup.${key} no está permitido.`);
  }
  if (setup.version !== 3) fail('voice_setup.version debe ser 3.');
  if (!['configured', 'unconfigured'].includes(setup.status)) fail('voice_setup.status debe ser configured o unconfigured.');
  if (!Array.isArray(setup.languages) || new Set(setup.languages).size !== setup.languages.length || setup.languages.some(x => !LANGUAGES.has(x))) {
    fail('voice_setup.languages debe contener es/en sin duplicados.');
  }
  if (setup.status === 'unconfigured') return setup;
  if (!LANGUAGES.has(setup.default_language) || !setup.languages.includes(setup.default_language)) fail('voice_setup.default_language debe estar en languages.');
  if (!setup.defaults || typeof setup.defaults !== 'object' || Array.isArray(setup.defaults)) fail('voice_setup.defaults es obligatorio.');
  if (!setup.fallbacks || typeof setup.fallbacks !== 'object' || Array.isArray(setup.fallbacks)) fail('voice_setup.fallbacks es obligatorio.');
  for (const lang of Object.keys(setup.defaults)) if (!LANGUAGES.has(lang)) fail(`voice_setup.defaults.${lang} no está permitido.`);
  for (const lang of setup.languages) {
    const value = setup.defaults[lang];
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`voice_setup.defaults.${lang} es obligatorio.`);
    for (const key of Object.keys(value)) if (!['identity', 'audio'].includes(key)) fail(`voice_setup.defaults.${lang}.${key} no está permitido.`);
    validateIdentity(value.identity, `voice_setup.defaults.${lang}`);
    validateAudio(value.audio, `voice_setup.defaults.${lang}`);
    const fallbacks = setup.fallbacks[lang] || [];
    if (!Array.isArray(fallbacks) || fallbacks.length > MAX_FALLBACKS) fail(`voice_setup.fallbacks.${lang} admite hasta ${MAX_FALLBACKS} alternativas.`);
    fallbacks.forEach((audio, i) => validateAudio(audio, `voice_setup.fallbacks.${lang}[${i}]`));
  }
  if (!setup.defaults[setup.default_language]) fail('voice_setup.default_language debe señalar un default válido.');
  return setup;
}

function setupState(config = {}, requestedLanguage = null) {
  const setup = config.voiceSetup || config.voice_setup || null;
  if (!setup) return Object.keys(config.vozPorPerfil || config.voz_por_perfil || {}).length ? 'legacy' : 'unconfigured';
  try { validateVoiceSetup(setup); } catch { return 'invalid'; }
  if (setup.status !== 'configured') return 'unconfigured';
  const lang = language(requestedLanguage) || setup.default_language;
  return setup.defaults && setup.defaults[lang] ? 'configured' : 'partially_configured';
}

function profileKey(profile) {
  return String(profile && (profile.id || profile.name) || '').toLowerCase();
}

function findProfile(profiles, requested, partial = false) {
  const needle = String(requested || '').trim().toLowerCase();
  if (!needle) return null;
  const exact = profiles.find(p => String(p.id || '').toLowerCase() === needle || String(p.name || '').toLowerCase() === needle);
  if (exact || !partial) return exact || null;
  return profiles.find(p => String(p.name || '').toLowerCase().includes(needle)) || null;
}

function modelName(engine, size) {
  if (engine === 'qwen') return size ? `qwen-tts-${size}` : null;
  if (engine === 'qwen_custom_voice') return size ? `qwen-custom-voice-${size}` : null;
  if (engine === 'chatterbox') return 'chatterbox-tts';
  if (engine === 'chatterbox_turbo') return 'chatterbox-turbo';
  return engine || null;
}

function sampleFor(snapshot, profile) {
  const samples = snapshot.samples || {};
  return samples[profileKey(profile)] || samples[String(profile.id || '')] || samples[String(profile.name || '')] || null;
}

function voiceboxRoute(audio, profile, snapshot) {
  const engine = audio.engine || profile.default_engine || null;
  if (!engine) return { ok: false, reason: 'compatibility_unknown' };
  let size = audio.model_size || null;
  const models = (snapshot.voicebox && snapshot.voicebox.models) || [];
  if ((engine === 'qwen' || engine === 'qwen_custom_voice') && !size) {
    const prefix = engine === 'qwen' ? 'qwen-tts-' : 'qwen-custom-voice-';
    const matches = models.filter(m => m.downloaded === true && String(m.model_name || '').startsWith(prefix));
    if (matches.length !== 1) return { ok: false, reason: matches.length ? 'compatibility_unknown' : 'model_not_downloaded' };
    size = String(matches[0].model_name).slice(prefix.length);
  }
  const name = modelName(engine, size);
  if (!name || !models.some(m => m.model_name === name && m.downloaded === true)) return { ok: false, reason: 'model_not_downloaded' };
  if (!(snapshot.voicebox && (snapshot.voicebox.reachable || snapshot.voicebox.startable))) return { ok: false, reason: 'provider_unavailable' };
  return { ok: true, audio: { profile: profile.id || profile.name, profile_name: profile.name, provider: 'voicebox', engine, model_size: size } };
}

function omniRoute(profile, snapshot) {
  const omni = snapshot.omnivoice || {};
  if (!(omni.reachable || (omni.startable && omni.weights_downloaded === true))) return { ok: false, reason: 'provider_unavailable' };
  const sample = sampleFor(snapshot, profile);
  if (!(sample && sample.sample_exists)) return { ok: false, reason: 'sample_missing' };
  return { ok: true, audio: { profile: profile.id || profile.name, profile_name: profile.name, provider: 'omnivoice', engine: null, model_size: null } };
}

function resolveAudioCandidate(audio, snapshot, { partial = false, mode = 'inmediato', legacyProvider = null } = {}) {
  const profiles = snapshot.profiles || [];
  const profile = findProfile(profiles, audio.profile, partial);
  if (!profile) return { ok: false, reason: 'profile_missing', requested: audio.profile };
  const profileLang = language(profile.language);
  if (audio.language && profileLang && audio.language !== profileLang) return { ok: false, reason: 'language_mismatch', requested: audio.profile, profile };
  const explicit = audio.provider || legacyProvider;
  const providers = explicit ? [explicit] : (mode === 'diferido' ? ['voicebox', 'omnivoice'] : ['omnivoice', 'voicebox']);
  const reasons = [];
  for (const provider of providers) {
    const result = provider === 'omnivoice' ? omniRoute(profile, snapshot) : voiceboxRoute(audio, profile, snapshot);
    if (result.ok) return { ...result, profile };
    reasons.push(result.reason);
  }
  return { ok: false, reason: reasons[0] || 'provider_unavailable', reasons, requested: audio.profile, profile };
}

function resolveVoice({ args = {}, config = {}, snapshot = {} } = {}) {
  const setup = config.voiceSetup || config.voice_setup || null;
  const requestedProvider = args.provider || args.motor || ((args.engine || args.model_size) ? 'voicebox' : null);
  if (args.provider && args.motor && args.provider !== args.motor) return { status: 'text-only', reason: 'ambiguous_explicit_route', reasons: ['ambiguous_explicit_route'] };
  const explicitVoice = args.profile || args.voice || null;
  if (setup && !explicitVoice) {
    try { validateVoiceSetup(setup); }
    catch { return { status: 'text-only', language: language(args.language), identity: { mode: 'neutral', available: true }, reason: 'invalid_setup', reasons: ['invalid_setup'] }; }
  }
  let lang = language(args.language);
  if (!lang && !explicitVoice && setup && setup.status === 'configured') lang = setup.default_language;

  let identity = { mode: 'neutral', available: true };
  if (args.personality !== false) {
    if (args.soul) identity = { mode: 'soul', soul: args.soul, available: Boolean((snapshot.souls || {})[args.soul]) };
    else if (!explicitVoice && setup && setup.status === 'configured' && setup.defaults && setup.defaults[lang]) identity = { ...setup.defaults[lang].identity };
    else if (args.personality === true) identity = { mode: 'profile', available: true };
  }
  if (identity.mode === 'soul' && !Boolean((snapshot.souls || {})[identity.soul])) identity = { mode: 'neutral', available: false, reason: 'identity_unavailable', requested_soul: identity.soul };

  if (explicitVoice) {
    const legacy = (!setup || setup.status !== 'configured') ? (config.vozPorPerfil || config.voz_por_perfil || {}) : {};
    const exactKey = Object.keys(legacy).find(k => k.toLowerCase() === String(explicitVoice).toLowerCase());
    const candidate = {
      profile: explicitVoice,
      provider: requestedProvider || (exactKey ? legacy[exactKey] : null),
      engine: args.engine || null,
      model_size: args.model_size || null,
      language: lang
    };
    const r = resolveAudioCandidate(candidate, snapshot, { partial: true, mode: args.modo });
    if (!r.ok) return { status: 'text-only', language: lang || language(r.profile && r.profile.language), identity, profile: r.profile || null, requested_profile: explicitVoice, reason: r.reason, reasons: r.reasons || [r.reason] };
    return { status: 'audio', language: lang || language(r.profile.language) || 'es', identity, audio: r.audio, profile: r.profile, fallback: false, reasons: [] };
  }

  if (!setup || setup.status !== 'configured' || !lang || !setup.defaults || !setup.defaults[lang]) {
    return { status: 'text-only', language: lang || null, identity, reason: 'setup_required', reasons: ['setup_required'] };
  }
  const declared = [setup.defaults[lang].audio, ...((setup.fallbacks && setup.fallbacks[lang]) || [])];
  const rejected = [];
  for (let i = 0; i < declared.length; i++) {
    const candidate = {
      ...declared[i],
      provider: requestedProvider || declared[i].provider,
      engine: args.engine || declared[i].engine,
      model_size: args.model_size || declared[i].model_size,
      language: lang
    };
    const r = resolveAudioCandidate(candidate, snapshot, { mode: args.modo });
    if (r.ok) return { status: 'audio', language: lang, identity, audio: r.audio, profile: r.profile, fallback: i > 0, reasons: rejected };
    rejected.push(r.reason);
  }
  return { status: 'text-only', language: lang, identity, reason: rejected[0] || 'provider_unavailable', reasons: rejected };
}

module.exports = {
  LANGUAGES,
  MAX_FALLBACKS,
  language,
  validateVoiceSetup,
  setupState,
  findProfile,
  modelName,
  resolveAudioCandidate,
  resolveVoice
};
