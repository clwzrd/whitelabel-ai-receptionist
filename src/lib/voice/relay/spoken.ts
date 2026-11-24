/**
 * An e-mail address, as a transcriber hears it, and as the assistant reads
 * it back.
 *
 * Nobody says "maria.lopez@gmail.com" on the phone. They say "maria dot lopez
 * at gmail dot com", or "m underscore lopez at yahoo", or spell the front
 * half out, "j o h n at acme dot com", and Deepgram writes down what it
 * heard — capitals, spaces and the sentence around it included ("sure, my
 * e-mail is …, thanks"). The model could be asked to do the conversion, but a
 * model that guesses at an address books a meeting for nobody, and the
 * spell-back the prompt requires ("M, A, R, I, A, dot, …, is that right?")
 * needs a deterministic spelling of the same string. Both live here, pure,
 * with tests, and both sides of the receptionist (the tool in
 * `src/lib/ai/voice-tools.ts`, the tests here) use this one copy.
 *
 * The rules, in the order they run: sentence punctuation is dropped but a
 * standalone period is kept as a symbol; the well-known domains said in
 * pieces are joined ("g mail", "gee mail"); words that stand for a symbol
 * become the symbol; "double l" becomes "ll"; single letters said one at a
 * time are glued ("j o h n", "j-o-h-n"); numbers said as words become digits;
 * a top-level domain said without its dot gets it back ("gmail com"). Then
 * the words around the "@" are read outwards — the local part backwards,
 * the domain forwards — and everything past the first word that cannot be
 * part of an address ("is", "thanks", "did you get that") is left behind.
 *
 * This is deliberately not an e-mail validator, and null means "ask again",
 * never "best guess": a wrong address means a confirmation that goes to a
 * stranger. The answer is handed back to the model to read aloud and
 * confirm; the contact form's own validation runs when the address is saved.
 */

/** Spoken words that stand for one character. Longest phrases first so "at sign" beats "at". */
const WORDS: [RegExp, string][] = [
  [/\b(?:at sign|at symbol|at the rate|arroba)\b/g, '@'],
  [/\bat\b/g, '@'],
  [/\b(?:dot|period|point|ponto)\b/g, '.'],
  [/\b(?:underscore|under score|sublinhado)\b/g, '_'],
  [/\b(?:dash|hyphen|minus|tra[cç]o|h[ií]fen)\b/g, '-'],
  [/\b(?:plus sign|plus|mais)\b/g, '+'],
];

/** Domains the transcriber tends to split or misspell, back to their real spelling. */
const DOMAINS: [RegExp, string][] = [
  [/\b(?:g|gee|jee)\s*mail\b/g, 'gmail'],
  [/\bhot\s*mail\b/g, 'hotmail'],
  [/\bout\s*look\b/g, 'outlook'],
  [/\bi\s*cloud\b/g, 'icloud'],
  [/\byahoo\b/g, 'yahoo'],
  [/\bproton\s*mail\b/g, 'protonmail'],
  [/\bcom\s*cast\b/g, 'comcast'],
];

/** "double u", "double l" and the like — one letter said twice. */
const DOUBLED = /\bdouble\s+([a-z])\b/g;

/** Single letters said one at a time, with spaces or the transcriber's hyphens between them. */
const LETTER_RUN = /\b[a-z](?:[\s-]+[a-z]\b)+/g;

const WORD_NUMBERS: Record<string, string> = {
  zero: '0',
  oh: '0',
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
};

/** Top-level domains read as words, so "gmail dot com" and "gmail com" both land. */
const TLDS = ['com', 'net', 'org', 'edu', 'gov', 'io', 'co', 'us', 'biz', 'info', 'me', 'br', 'uk'];

/**
 * Words that end the local part when read backwards from the "@": the
 * sentence the address was said inside. Anything with a character an address
 * cannot hold (an apostrophe, say) ends it too, without being listed.
 */
const STOP_WORDS = new Set([
  'is', 'its', 'be', 'it', 'my', 'the', 'an', 'a', 'and', 'or', 'so', 'to', 'of', 'on', 'in', 'as', 'was', 'would', 'use',
  'email', 'e-mail', 'mail', 'address', 'sure', 'yeah', 'yes', 'okay', 'ok', 'um', 'uh', 'well', 'hi', 'hello', 'i',
  'you', 'can', 'reach', 'me', 'send', 'try', 'that', 'this', 'one', 'with', 'at', 'for', 'just', 'like',
]);

const ADDRESS = /^[a-z0-9](?:[a-z0-9._+-]*[a-z0-9])?@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

export interface SpokenEmail {
  /** The address as best understood, lower-case, or null when nothing address-shaped was said. */
  address: string | null;
  /** The address letter by letter, for the model to read back. Empty when `address` is null. */
  spelled: string;
}

const NONE: SpokenEmail = { address: null, spelled: '' };

export function normalizeSpokenEmail(spoken: string): SpokenEmail {
  let text = ` ${spoken.toLowerCase().trim()} `;
  if (!text.trim()) return NONE;
  /*
   * Sentence punctuation is not part of the address. A period glued to the
   * word before it and followed by a space or the end ("dot com. Did you")
   * is the transcriber closing a sentence; a period standing on its own
   * ("JOHN . SMITH") is the transcriber writing a symbol, and stays.
   */
  text = text.replace(/[,;:!?]+/g, ' ').replace(/(?<=\S)\.(?=\s|$)/g, ' ');
  for (const [pattern, real] of DOMAINS) text = text.replace(pattern, real);
  for (const [pattern, symbol] of WORDS) text = text.replace(pattern, ` ${symbol} `);
  text = text.replace(DOUBLED, (_, letter: string) => ` ${letter}${letter} `);
  text = text.replace(LETTER_RUN, (run) => run.replace(/[\s-]+/g, ''));
  text = text.replace(/\b([a-z]+)\b/g, (word) => WORD_NUMBERS[word] ?? word);
  /*
   * A TLD spoken after the domain with no "dot" in between ("gmail com") is
   * the most common gap; the dot is restored only there, never inside the
   * local part, where "sam com" could be a name.
   */
  text = text.replace(new RegExp(`@\\s*([a-z0-9-]+)\\s+(${TLDS.join('|')})\\b`, 'g'), '@$1.$2');
  // The "@" is read as its own word below, whether the transcriber glued it to a name or not.
  const words = text.replace(/@/g, ' @ ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);

  /*
   * "You can reach me at bob at acme dot com" has two "@"; the one that
   * carries the address is tried first from the end, and the first "@" that
   * yields something address-shaped wins.
   */
  for (let at = words.length - 1; at >= 0; at -= 1) {
    if (words[at] !== '@') continue;
    const local = localPart(words.slice(0, at));
    const domain = domainPart(words.slice(at + 1));
    if (!local || !domain) continue;
    const address = `${local}@${domain}`.replace(/\.{2,}/g, '.');
    if (ADDRESS.test(address)) return { address, spelled: spellOut(address) };
  }
  return NONE;
}

/**
 * The local part: the words before the "@", read backwards until the
 * sentence starts. Symbols join what is on either side of them; plain words
 * are glued to each other ("john smith" → "johnsmith", which is what a
 * caller who did not say "dot" most likely has) until a stop word or a word
 * that cannot be part of an address ends the run.
 */
function localPart(before: string[]): string {
  let out = '';
  for (let i = before.length - 1; i >= 0; i -= 1) {
    const w = before[i]!;
    const symbol = /^[._+-]+$/.test(w);
    if (!symbol && (STOP_WORDS.has(w) || !/^[a-z0-9._+-]+$/.test(w))) break;
    out = w + out;
  }
  return out;
}

/**
 * The domain: the words after the "@", read forwards. Before the first dot,
 * plain words are glued ("acme corp dot com" → "acmecorp.com"); once a dot
 * has been read, the first word not joined by a symbol is the sentence going
 * on ("gmail dot com thanks") and ends the run.
 */
function domainPart(after: string[]): string {
  let out = '';
  let dotted = false;
  for (let i = 0; i < after.length; i += 1) {
    const w = after[i]!;
    const symbol = /^[.-]+$/.test(w);
    if (!symbol && (STOP_WORDS.has(w) || !/^[a-z0-9.-]+$/.test(w))) break;
    const prev = after[i - 1];
    const joined = symbol || /[.-]$/.test(out) || (prev !== undefined && /^[.-]/.test(w));
    if (dotted && !joined) break;
    out += w;
    if (w.includes('.')) dotted = true;
  }
  return out.replace(/^[.-]+|[.-]+$/g, '');
}

const SYMBOL_WORDS: Record<string, string> = { '@': 'at', '.': 'dot', _: 'underscore', '-': 'dash', '+': 'plus' };

/**
 * The address letter by letter, for the TTS: "J, O, H, N, dot, S, M, I, T,
 * H, at, gmail dot com". Letters are upper-case so the voice reads them as
 * letters rather than as words ("a", "i"); symbols are named because a voice
 * reading "." says nothing at all; the domain is read as a word when it is
 * one everybody knows, because spelling "gmail" is noise and the part that
 * goes wrong is always the local part.
 */
export function spellOut(address: string): string {
  const [local, domain] = address.toLowerCase().split('@');
  const letters = (part: string) => [...part].map((ch) => SYMBOL_WORDS[ch] ?? ch.toUpperCase()).join(', ');
  if (!domain) return letters(local ?? '');
  const known = /^(gmail|hotmail|outlook|icloud|yahoo|protonmail|comcast|aol|me|live|msn)\.(com|net|org|me)$/.test(domain);
  return `${letters(local ?? '')}, at, ${known ? domain.replace('.', ' dot ') : letters(domain)}`;
}
