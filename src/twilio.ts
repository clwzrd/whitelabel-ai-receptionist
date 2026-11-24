import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The two things this service says to Twilio and hears from it: TwiML out,
 * signatures in.
 *
 * Every attribute written into `<ConversationRelay>` is one Twilio documents.
 * An attribute it does not know, or a provider and voice it cannot serve, is
 * an error at connect and the end of the call, so nothing speculative is
 * written here.
 */

const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

function attrs(values: Record<string, string | undefined>): string {
  return Object.entries(values)
    .filter((entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== '')
    .map(([name, value]) => ` ${name}="${escape(value)}"`)
    .join('');
}

export const twiml = (inner: string) => `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;
export const say = (text: string) => `<Say>${escape(text)}</Say>`;
export const hangup = () => '<Hangup/>';
export const dial = (to: string, callerId?: string) => `<Dial${attrs({ answerOnBridge: 'true', timeout: '20', callerId })}>${escape(to)}</Dial>`;

export interface RelayOptions {
  /** wss:// address of this service's socket, token included. */
  url: string;
  /** Where Twilio posts when the relay ends, to ask what to do next. */
  action: string;
  /** Spoken by Twilio the moment the call connects. Empty on a reconnection. */
  welcomeGreeting?: string;
  ttsProvider: 'Amazon' | 'Google' | 'ElevenLabs';
  voice: string;
  /** The language the assistant speaks first; the caller's own on a reconnection. */
  ttsLanguage?: string;
  /** Languages the call may switch to, each with its voice. ElevenLabs only. */
  languages: { code: string; voice: string }[];
  /** Read back to the socket in the `setup` message. Unsigned, so compared against the stored call, never believed. */
  parameters: Record<string, string>;
}

export function connectRelay(o: RelayOptions): string {
  const elevenLabs = o.ttsProvider === 'ElevenLabs';
  // Automatic language detection is paired with ElevenLabs only; elsewhere the line is English.
  const multi = elevenLabs && o.languages.length > 0;
  const relay = attrs({
    url: o.url,
    welcomeGreeting: o.welcomeGreeting,
    welcomeGreetingInterruptible: o.welcomeGreeting ? 'none' : undefined,
    language: multi ? 'multi' : 'en-US',
    ttsLanguage: multi ? o.ttsLanguage || 'en-US' : 'en-US',
    ttsProvider: o.ttsProvider,
    voice: o.voice || (o.ttsProvider === 'Amazon' ? 'Joanna-Neural' : undefined),
    transcriptionProvider: 'Deepgram',
    interruptible: 'any',
    interruptSensitivity: 'medium',
    ignoreBackchannel: 'true',
    reportInputDuringAgentSpeech: 'none',
    dtmfDetection: 'true',
    // Twilio reports what was actually played, so the session knows when the assistant stopped speaking.
    events: 'tokens-played',
  });
  const languages = multi ? o.languages.filter((l) => l.code && l.voice).map((l) => `<Language${attrs({ code: l.code, ttsProvider: 'ElevenLabs', voice: l.voice })}/>`).join('') : '';
  const params = Object.entries(o.parameters).map(([name, value]) => `<Parameter${attrs({ name, value })}/>`).join('');
  return `<Connect${attrs({ action: o.action, method: 'POST' })}><ConversationRelay${relay}>${languages}${params}</ConversationRelay></Connect>`;
}

/**
 * Twilio signs every request: HMAC-SHA1, keyed with the account's auth token,
 * over the full URL followed by each POST parameter's name and value in
 * alphabetical order. A WebSocket handshake is signed over its URL alone.
 */
export function twilioSignature(url: string, params: Record<string, string>, authToken: string): string {
  let data = url;
  for (const key of Object.keys(params).sort()) data += key + params[key];
  return createHmac('sha1', authToken).update(data, 'utf8').digest('base64');
}

export function verifyTwilioSignature(signature: string | null | undefined, urls: string[], params: Record<string, string>, authToken: string): boolean {
  if (!signature || !authToken) return false;
  const presented = Buffer.from(signature);
  return urls.some((url) => {
    const expected = Buffer.from(twilioSignature(url, params, authToken));
    return expected.length === presented.length && timingSafeEqual(expected, presented);
  });
}

/** Caller IDs Twilio sends when the number is hidden. Such a caller is never looked up or texted. */
export function isWithheld(from: string | null | undefined): boolean {
  const value = (from ?? '').trim().toLowerCase();
  return !value || !/^\+\d{7,15}$/.test(value);
}
