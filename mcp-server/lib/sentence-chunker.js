/**
 * Sentence Chunker (Fase 3 — Modo Charla)
 * Consumes incremental text_delta fragments from an agy_voice_stream session and
 * groups them into complete sentences ready for the TTS synthesis queue.
 *
 * Cut criteria (docs/architecture/voice-chat-architecture.md, section 4.2):
 *   - Strong sentence enders: . ! ? \n
 *   - Soft pauses: ; :
 *   - Minimum word count before emitting, to avoid firing on abbreviations (e.g. "Dr.", "pág.")
 */

const SENTENCE_ENDERS = new Set(['.', '!', '?', '\n']);
const PAUSE_ENDERS = new Set([';', ':']);

const DEFAULT_ABBREVIATIONS = [
  // Spanish
  'sr', 'sra', 'srta', 'dr', 'dra', 'lic', 'ing', 'prof', 'profa', 'gral',
  'av', 'avda', 'pág', 'pag', 'ej', 'etc', 'vs', 'no', 'num', 'núm', 'depto',
  'apto', 'aprox', 'ud', 'uds', 'cía', 'cia', 'sa', 'srl',
  // English
  'mr', 'mrs', 'ms', 'jr', 'st', 'eg', 'ie', 'inc', 'ltd', 'co', 'approx',
  'fig', 'vol', 'p', 'pp'
];

function wordCount(str) {
  const matches = str.trim().match(/\S+/g);
  return matches ? matches.length : 0;
}

class SentenceChunker {
  constructor(options = {}) {
    this.minWords = options.minWords ?? 3;
    this.abbreviations = new Set(
      (options.abbreviations || DEFAULT_ABBREVIATIONS).map(a => a.toLowerCase())
    );
    this.buffer = '';
  }

  /** Feed a new text_delta fragment. Returns an array of complete sentences (may be empty). */
  push(delta) {
    if (!delta) return [];
    this.buffer += delta;
    return this._extractComplete();
  }

  /** Force-emit whatever remains buffered (call when the turn ends, e.g. on a `result` event). */
  flush() {
    const sentences = this._extractComplete();
    const remainder = this.buffer.trim();
    if (remainder) {
      sentences.push(remainder);
    }
    this.buffer = '';
    return sentences;
  }

  reset() {
    this.buffer = '';
  }

  _wordBefore(str, idx) {
    const before = str.slice(0, idx);
    const m = before.match(/([A-Za-zÀ-ÿ]+)\s*$/);
    return m ? m[1].toLowerCase() : '';
  }

  _isAbbreviation(str, idx) {
    const word = this._wordBefore(str, idx);
    return word.length > 0 && this.abbreviations.has(word);
  }

  _isMidNumberOrTime(str, idx) {
    // "3.14", "3:00" — a digit immediately before AND after the punctuation
    const prev = str[idx - 1];
    const next = str[idx + 1];
    return /\d/.test(prev || '') && /\d/.test(next || '');
  }

  _isEllipsisRun(str, idx) {
    // don't split in the middle of "..." — wait for the run to end
    return str[idx] === '.' && str[idx + 1] === '.';
  }

  _isUrlColon(str, idx) {
    // "http://..." — don't treat the scheme colon as a pause
    return str[idx] === ':' && str.slice(idx + 1, idx + 3) === '//';
  }

  _extractComplete() {
    const sentences = [];
    let scanFrom = 0;

    while (true) {
      let cutIdx = -1;

      for (let i = scanFrom; i < this.buffer.length; i++) {
        const ch = this.buffer[i];
        const isEnder = SENTENCE_ENDERS.has(ch);
        const isPause = PAUSE_ENDERS.has(ch);
        if (!isEnder && !isPause) continue;

        if (ch === '.') {
          if (this._isMidNumberOrTime(this.buffer, i)) continue;
          if (this._isEllipsisRun(this.buffer, i)) continue;
          if (this._isAbbreviation(this.buffer, i)) continue;
        } else if (ch === ':') {
          if (this._isMidNumberOrTime(this.buffer, i)) continue;
          if (this._isUrlColon(this.buffer, i)) continue;
        }

        cutIdx = i;
        break;
      }

      if (cutIdx === -1) break;

      const candidate = this.buffer.slice(0, cutIdx + 1);
      if (wordCount(candidate) < this.minWords) {
        // Not enough words yet (e.g. an abbreviation-like short fragment) — keep
        // scanning past this boundary instead of cutting here.
        scanFrom = cutIdx + 1;
        continue;
      }

      sentences.push(candidate.trim());
      this.buffer = this.buffer.slice(cutIdx + 1).replace(/^\s+/, '');
      scanFrom = 0;
    }

    return sentences;
  }
}

module.exports = { SentenceChunker, DEFAULT_ABBREVIATIONS };
