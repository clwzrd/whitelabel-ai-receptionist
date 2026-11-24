import type { CallerIntake } from './types';

/**
 * The words a colleague hears before the bridge, and the line the summary
 * carries, both built from what the caller said before the transfer.
 *
 * Two renderings of one fact because they are heard and read in different
 * places: the whisper plays into the colleague's ear while the caller
 * waits in silence, so it is one short sentence in spoken order (who,
 * from where, what for); the summary line is for the timeline, where a
 * label per field reads better than prose. Neither invents: a field the
 * caller did not give is left out, and with nothing given at all both
 * return an empty string so the callers fall back to what they said before
 * this existed.
 *
 * Pure functions, so they are tested without a call.
 */

/** A spoken value: trimmed, cut so the whisper cannot run on, and free of the characters that read badly aloud. */
function spoken(raw: string | undefined, max: number): string {
  return (raw ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .replace(/[.!?;:,\s]+$/, '');
}

/**
 * "Dana Carter from Riverside Community Church, about managing their
 * social media." The whole thing fits in the time a person needs to lift the
 * phone to their ear: the reason keeps its first clause only and is cut at
 * a word before 140 characters, so the caller is not left listening to
 * ringing while a paragraph is read to the colleague; and a model that
 * wrote "the caller wants…" despite the tool's wording has that prefix
 * taken off, since the sentence already says who is asking.
 */
export function whisperBrief(caller: CallerIntake | null | undefined): string {
  if (!caller) return '';
  const name = spoken(caller.name || caller.onFile?.name, 80);
  const company = spoken(caller.company || caller.onFile?.company, 80);
  const wants = firstClause(spoken(caller.wants, 300), 140);
  const who = name && company ? `${name} from ${company}` : name || (company ? `Someone from ${company}` : '');
  if (!who && !wants.text) return '';
  const lead = caller.lead ? 'New business: ' : '';
  if (!who) return `${lead}The caller ${wants.verb ? lowerFirst(wants.text) : `is asking about ${lowerFirst(wants.text)}`}.`;
  if (!wants.text) return `${lead}${who}.`;
  return `${lead}${who}, ${wants.verb ? lowerFirst(wants.text) : `about ${lowerFirst(wants.text)}`}.`;
}

/**
 * "Caller gave: Dana Carter, Riverside Community Church. Asked for:
 * managing their social media. New business." Stamped on the summary by the
 * code, the way the language line is: a fact the session recorded, which a
 * model that forgot it would otherwise hide.
 */
export function summaryBrief(caller: CallerIntake | null | undefined): string {
  if (!caller) return '';
  const name = spoken(caller.name, 80);
  const company = spoken(caller.company, 80);
  const wants = spoken(caller.wants, 300);
  const parts: string[] = [];
  const who = [name, company].filter(Boolean).join(', ');
  if (who) parts.push(`Caller gave: ${who}.`);
  if (wants) parts.push(`Asked for: ${wants}.`);
  if (!parts.length) return '';
  if (caller.lead) parts.push('New business.');
  return parts.join(' ');
}

/**
 * The part of the reason a colleague needs before the bridge: up to the
 * first semicolon or " — ", cut at a word boundary, and shaped so it can
 * follow the caller's name. "Caller wants help with ads; scope is outside
 * the program" → "help with ads" (a thing, said as "about …"); "Wants to
 * reschedule Tuesday" → "wants to reschedule Tuesday" (a verb phrase, said
 * as is, `verb: true`). The subject ("the caller", "they") is optional:
 * a model writes the reason both ways.
 */
function firstClause(text: string, max: number): { text: string; verb: boolean } {
  let s = text.split(/;|\s[—–-]\s/)[0]!.trim();
  let verb = false;
  const subject = /^(the\s+)?(caller|she|he|they|customer|person|someone)\s+/i;
  const verbs = '(wants?|needs?|asking|asked|asks?|would like|is looking|looking|is calling|calling|is inquiring|inquiring|has a question|have a question|question|is interested|interested)';
  const asksFor = new RegExp(`^(is\\s+)?${verbs}\\s+(for|about|in|on|regarding)\\s+`, 'i');
  const asksTo = new RegExp(`^(is\\s+)?${verbs}\\s+to\\s+`, 'i');
  // "wants help with ads", "needs a quote": the verb goes, the thing stays.
  const asksThing = /^(is\s+)?(wants?|needs?|would like)\s+/i;
  const rest = s.replace(subject, '');
  if (asksFor.test(rest)) s = rest.replace(asksFor, '');
  else if (asksTo.test(rest)) {
    s = rest;
    verb = true;
  } else if (asksThing.test(rest)) s = rest.replace(asksThing, '');
  else if (/^to\s+/i.test(rest)) {
    s = `wants ${lowerFirst(rest)}`;
    verb = true;
  } else s = rest;
  if (s.length > max) {
    const cut = s.slice(0, max);
    const at = cut.lastIndexOf(' ');
    s = (at > max / 2 ? cut.slice(0, at) : cut).trim();
  }
  return { text: s.replace(/[.!?;:,\s]+$/, ''), verb };
}

/** "A quote for…" → "a quote for…", but an acronym or a name keeps its capital. */
function lowerFirst(s: string): string {
  if (!s) return s;
  const first = s[0]!;
  const second = s[1] ?? '';
  if (second && second === second.toUpperCase() && /[A-Za-z]/.test(second)) return s;
  return first.toLowerCase() + s.slice(1);
}
