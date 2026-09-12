/**
 * SEC-013 — Escaneo de lo que un alma quiere recordar.
 *
 * La memoria se inyecta en cada llamada conversacional: es un vector de
 * inyección persistente. Este módulo es la capa higiénica (capa 1 del RFC).
 * La barrera dura es otra: las llamadas que leen memoria corren como el agente
 * `lagrange-alma`, sin tools nativas y con el MCP negado (capa 3). Por eso el
 * escaneo prefiere dejar pasar una frase rara antes que rechazar frases
 * comunes: un verbo de ejecución solo cuenta con un objeto técnico ("ejecutá
 * este comando"), no suelto ("ejecuta sus tareas a tiempo").
 *
 * El motivo del rechazo nunca incluye el contenido: termina en el diario y en
 * la salida de las tools.
 */

const PATRONES_ORDEN = [
  /\bignor[aáe]\w*\s+(las\s+|todas\s+las\s+)?instruc/i,
  /\bignore\s+(all\s+|previous\s+|the\s+)*instruc/i,
  /\b(ejecut|corr)[aáeé]n?\s+(el|este|un|ese|esta|una)?\s*(comando|script|c[oó]digo|binario|programa|proceso)\b/i,
  /\b(run|execute|eval)\s+(the|this|a|that)?\s*(command|script|code|binary|program|shell)\b/i,
  /\brm\s+-/i,
  /\bcurl\s/i,
  /\b(powershell|bash|cmd)(\.exe)?\s+-/i
];

const PATRONES_URL = [/https?:\/\//i, /\bwww\./i];

const PATRONES_SECRETO = [
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bghp_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[bp]-[A-Za-z0-9-]{10,}/,
  /\beyJ[\w-]+\.eyJ[\w-]+\./,
  /PRIVATE KEY/,
  // El token de bot de Telegram, el mismo que tapa `redactSecrets`.
  /(bot)?\d{6,}:[A-Za-z0-9_-]{20,}/
];

/** Control C0, DEL, ancho cero, marcas de dirección e invisibles de formato. */
function esInvisible(codigo) {
  return codigo <= 0x1f
    || codigo === 0x7f
    || (codigo >= 0x200b && codigo <= 0x200f)
    || (codigo >= 0x202a && codigo <= 0x202e)
    || (codigo >= 0x2060 && codigo <= 0x2064)
    || codigo === 0xfeff;
}

function tieneInvisibles(texto) {
  for (const ch of texto) {
    if (esInvisible(ch.codePointAt(0))) return true;
  }
  return false;
}

/**
 * Una cadena larga sin espacios que mezcla mayúsculas, minúsculas y dígitos
 * parece una clave. Una que es solo hexadecimal no: un SHA de git no es un
 * secreto.
 */
function pareceClaveSuelta(texto) {
  return texto.split(' ').some(t =>
    t.length >= 32
    && !/^[0-9a-f]+$/i.test(t)
    && /[A-Z]/.test(t) && /[a-z]/.test(t) && /[0-9]/.test(t)
  );
}

/** Una línea: tabulaciones y saltos no son invisibles sospechosos, son formato. */
function normalizar(texto) {
  return String(texto ?? '').replace(/\s+/g, ' ').trim();
}

/** `{ ok: true, texto }` con el texto normalizado, o `{ ok: false, motivo }`. */
function escanear(texto) {
  const limpio = normalizar(texto);
  if (!limpio) return { ok: false, motivo: 'vacío' };
  if (tieneInvisibles(limpio)) return { ok: false, motivo: 'caracteres invisibles o de control' };
  if (PATRONES_URL.some(p => p.test(limpio))) return { ok: false, motivo: 'contiene una URL' };
  if (PATRONES_ORDEN.some(p => p.test(limpio))) return { ok: false, motivo: 'parece una orden' };
  if (PATRONES_SECRETO.some(p => p.test(limpio)) || pareceClaveSuelta(limpio)) {
    return { ok: false, motivo: 'parece un secreto' };
  }
  return { ok: true, texto: limpio };
}

module.exports = { escanear, normalizar };
