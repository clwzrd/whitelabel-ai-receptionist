/**
 * TwiML, built by hand.
 *
 * Twilio's helper library builds this XML, and it is the same library the rest
 * of this integration deliberately does without: a few hundred kilobytes of
 * serverless bundle to concatenate strings. The whole language this feature
 * speaks is `<Dial>`, `<Record>`, `<Say>`, `<Play>` and `<Hangup>`, so it is
 * written out here, escaped once, in one place.
 *
 * Everything that reaches an attribute or a text node goes through `esc`. A
 * caller id is a phone number and a greeting is typed by an admin, but a
 * contact's name is not — it arrives from a form, an import or a webhook, and
 * an unescaped `&` in it is a 12100 "document parse failure" that drops the
 * call rather than corrupting anything. Escaping is cheaper than remembering
 * which strings are safe.
 */

export function esc(value: string | number | boolean): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Attributes, skipping anything undefined so the XML stays readable. */
export function attrs(map: Record<string, string | number | boolean | undefined | null>): string {
  return Object.entries(map)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => ` ${k}="${esc(v as string | number | boolean)}"`)
    .join('');
}

/** Wraps verbs in the document Twilio expects and answers with the right type. */
export function twiml(...verbs: string[]): Response {
  const body = `<?xml version="1.0" encoding="UTF-8"?><Response>${verbs.join('')}</Response>`;
  return new Response(body, { status: 200, headers: { 'content-type': 'text/xml; charset=utf-8' } });
}

/**
 * Twilio's own voices. `Polly.Camila-Neural` reads Portuguese as a Brazilian
 * would; `alice` is the old multilingual fallback and costs nothing extra.
 * The language matters more than the voice: `alice` reading a Portuguese
 * greeting in `en-US` is unintelligible, which is worse than a robot.
 */
export function say(text: string, lang: 'pt' | 'en'): string {
  const voice = lang === 'pt' ? 'Polly.Camila-Neural' : 'Polly.Joanna-Neural';
  const language = lang === 'pt' ? 'pt-BR' : 'en-US';
  return `<Say${attrs({ voice, language })}>${esc(text)}</Say>`;
}

export interface DialOptions {
  /** The number shown to whoever is being dialled. */
  callerId?: string | null;
  /** Seconds of ringing before Twilio gives up and follows `action`. */
  timeout?: number;
  /** Where Twilio posts the outcome of the dial, so voicemail can follow. */
  action?: string | null;
  record?: boolean;
  recordingStatusCallback?: string | null;
  /** Twilio hangs up on the whole call after this many seconds. */
  timeLimit?: number;
  /**
   * TwiML played to the person being dialled, alone, the moment they answer and
   * before the two legs are bridged. Twilio calls this a whisper, and it is the
   * only way to say something to one side of a call: a `<Say>` in front of the
   * `<Dial>` is heard by the caller and by nobody else. It is what carries the
   * recording announcement to the second party.
   */
  whisperUrl?: string | null;
}

/**
 * One `<Dial>` to one number.
 *
 * `record-from-answer-dual` is the only recording mode worth having: it starts
 * when the other end picks up rather than during the ringing, and it keeps the
 * two sides on separate channels, so a transcript can tell the salesperson from
 * the customer. The single-channel modes cannot, and a transcript that cannot
 * say who said what is a wall of text nobody reads twice.
 */
export function dialNumber(number: string, opts: DialOptions = {}): string {
  const dial = attrs({
    callerId: opts.callerId ?? undefined,
    timeout: opts.timeout,
    action: opts.action ?? undefined,
    method: opts.action ? 'POST' : undefined,
    record: opts.record ? 'record-from-answer-dual' : undefined,
    recordingStatusCallback: opts.record ? (opts.recordingStatusCallback ?? undefined) : undefined,
    recordingStatusCallbackMethod: opts.record && opts.recordingStatusCallback ? 'POST' : undefined,
    // "completed" alone would miss a recording that failed to store, which is
    // the case worth knowing about: the call happened and the audio did not.
    recordingStatusCallbackEvent: opts.record && opts.recordingStatusCallback ? 'completed absent' : undefined,
    timeLimit: opts.timeLimit,
    answerOnBridge: 'true',
  });
  const num = attrs({
    url: opts.whisperUrl ?? undefined,
    method: opts.whisperUrl ? 'POST' : undefined,
  });
  return `<Dial${dial}><Number${num}>${esc(number)}</Number></Dial>`;
}

export interface AnnouncedDialOptions extends DialOptions {
  /** The sentence both parties hear before the recorder starts. */
  notice: string;
  lang: 'pt' | 'en';
}

/**
 * A `<Dial>` and, when it records, the announcement that makes recording lawful.
 *
 * The two are returned together and never separately, because the failure worth
 * designing against is not "somebody wrote the wrong sentence" — it is
 * `record` being switched on months later by a hand that did not know an
 * announcement was owed. The caller hears the `<Say>` in front of the `<Dial>`;
 * the person being dialled hears the same words as a whisper the instant they
 * pick up, which is the only moment either party can still hang up. Both sides
 * covered, or neither: an empty notice or a missing whisper address turns the
 * recording off rather than proceeding without it.
 */
export function dialAnnounced(number: string, opts: AnnouncedDialOptions): string[] {
  const announce = Boolean(opts.record && opts.notice.trim() && opts.whisperUrl);
  const dial = dialNumber(number, { ...opts, record: announce });
  return announce ? [say(opts.notice, opts.lang), dial] : [dial];
}

export interface RecordOptions {
  action: string;
  maxLength: number;
  /** Seconds of silence that end the message. Twilio's own default is 5. */
  timeout?: number;
  transcribe?: boolean;
}

/**
 * Voicemail. `trim="trim-silence"` matters more than it looks: without it every
 * message begins with the second and a half between the beep and the caller
 * drawing breath, and a transcription service charges for that silence on
 * every single voicemail.
 */
export function record(opts: RecordOptions): string {
  return `<Record${attrs({
    action: opts.action,
    method: 'POST',
    maxLength: opts.maxLength,
    timeout: opts.timeout ?? 5,
    playBeep: 'true',
    trim: 'trim-silence',
    // Twilio's own transcription is English-only and mediocre; this feature
    // does it properly from the recording instead. See lib/voice/transcribe.ts.
    transcribe: 'false',
  })}/>`;
}

export const hangup = '<Hangup/>';

/** Refuses the call at the carrier: no ring, no voicemail, nothing billed to the caller's patience. */
export const reject = '<Reject reason="rejected"/>';

/**
 * Twilio's own default ElevenLabs voice for US English (verified in Twilio's
 * ConversationRelay docs on 2026-09-14). It is the one voice id guaranteed to
 * exist on every account, which matters more than it sounds: an ElevenLabs
 * voice id Twilio does not know is not a wrong voice, it is an error message
 * and the end of the session at connect time. So an empty voice setting
 * resolves to this rather than to nothing.
 */
export const ELEVENLABS_EN_US_VOICE = 'UgBBYS2sOqTuMpoF3BR0';

/** One `<Language>` child: the voice Twilio switches to when the session asks for this language. */
export interface RelayLanguage {
  /** BCP-47, as Twilio spells it: "es-US", "pt-BR". */
  code: string;
  /** An ElevenLabs voice id, optionally with "-<model>" or "-<model>-<speed>_<stability>_<similarity>". */
  voice: string;
}

export interface RelayOptions {
  /** The `wss://` address of the relay route, token included. */
  url: string;
  /** Where Twilio posts when the session ends, however it ends. */
  action: string;
  /** Spoken by Twilio the moment the socket is up, on a first connection only. */
  welcomeGreeting?: string;
  ttsProvider: 'Amazon' | 'Google' | 'ElevenLabs';
  voice?: string;
  /** Words the transcriber should expect: the business name, street names, services. */
  hints?: string;
  /**
   * The languages the session may switch to besides English, each with its
   * voice. Rendered as `<Language>` children, and only under ElevenLabs: the
   * children name that provider, and a child on a different provider from
   * its parent is a combination Twilio refuses at connect.
   */
  languages?: RelayLanguage[];
  /**
   * Let the transcriber detect the caller's language (`language="multi"`).
   * Twilio allows it only with Deepgram and ElevenLabs together; asked for
   * with another TTS provider it is silently dropped here and the session
   * runs in English, which is what the readiness card warns about, rather
   * than sent and refused, which would end the call.
   */
  multi?: boolean;
  /** `elevenlabsTextNormalization="on"`: prices, times and numbers read as a person says them. ElevenLabs only. */
  textNormalization?: boolean;
  /**
   * On a resume (rotate, back from a transfer): the language the caller had
   * switched to, so the reconnected session opens with that voice instead of
   * flipping back to English for the rest of the call.
   */
  ttsLanguage?: string;
  /** Echoed back unsigned in `setup.customParameters`; informational only. */
  parameters: Record<string, string>;
}

/**
 * The AI receptionist's verb: `<Connect>` with a `<ConversationRelay>` inside.
 *
 * Nothing follows the `<Connect>` in the document on purpose. What happens
 * when the socket closes — a transfer, the voicemail, a fresh connection to
 * dodge the function deadline — is decided by the signed `action` URL with the
 * session row in hand, not guessed here before the conversation has happened.
 *
 * English is the primary language whatever the number's `spokenLang` says;
 * the greeting is always English, and with `multi` the transcriber detects
 * a caller who answers in something else so the session can follow them.
 * `ttsProvider` is always written out: Twilio's own default is ElevenLabs,
 * and a default that nobody chose is not a choice. The greeting is not
 * interruptible so the disclosure that this is an AI assistant is heard
 * whole; every later reply can be spoken over.
 *
 * Every attribute here is one Twilio documented for `<ConversationRelay>`
 * on 2026-09-14; an attribute Twilio does not know, or a provider/voice pair
 * it cannot serve, is an error at connect and the end of the call, so
 * nothing speculative is written.
 */
export function connectRelay(o: RelayOptions): string {
  const elevenLabs = o.ttsProvider === 'ElevenLabs';
  const multi = Boolean(o.multi && elevenLabs);
  const relay = attrs({
    url: o.url,
    welcomeGreeting: o.welcomeGreeting,
    welcomeGreetingInterruptible: o.welcomeGreeting ? 'none' : undefined,
    language: multi ? 'multi' : 'en-US',
    // Always written, even when it equals `language`: with `multi` the
    // greeting still needs a language to be read in, and on a resume it is
    // the caller's own, so the first thing they hear after "one second,
    // please" is not a change of voice. Without ElevenLabs there is no
    // switching, so a caller's language on a resume is dropped back to
    // English rather than sent to a provider that cannot serve it.
    ttsLanguage: multi ? o.ttsLanguage || 'en-US' : 'en-US',
    ttsProvider: o.ttsProvider,
    voice: o.voice || (o.ttsProvider === 'Amazon' ? 'Joanna-Neural' : elevenLabs ? ELEVENLABS_EN_US_VOICE : undefined),
    transcriptionProvider: 'Deepgram',
    elevenlabsTextNormalization: elevenLabs && o.textNormalization ? 'on' : undefined,
    hints: o.hints,
    interruptible: 'any',
    interruptSensitivity: 'medium',
    ignoreBackchannel: 'true',
    reportInputDuringAgentSpeech: 'none',
    dtmfDetection: 'true',
    // Twilio reports what has just been played over TTS; the session uses it
    // as the true end of the assistant's speech instead of guessing from the
    // text's length (the guess stays as the fallback).
    events: 'tokens-played',
  });
  const languages = elevenLabs
    ? (o.languages ?? [])
        .filter((l) => l.code && l.voice)
        .map((l) => `<Language${attrs({ code: l.code, ttsProvider: 'ElevenLabs', voice: l.voice })}/>`)
        .join('')
    : '';
  const params = Object.entries(o.parameters)
    .map(([name, value]) => `<Parameter${attrs({ name, value })}/>`)
    .join('');
  return `<Connect${attrs({ action: o.action, method: 'POST' })}><ConversationRelay${relay}>${languages}${params}</ConversationRelay></Connect>`;
}

export interface GatherOptions {
  /** Para onde a Twilio manda o dígito. */
  action: string;
  /** Quantos dígitos esperar. Um, sempre, nesta versão. */
  numDigits?: number;
  /** Segundos de silêncio antes de desistir e seguir para o próximo verbo. */
  timeout?: number;
  /** O que é falado enquanto ele escuta. */
  say?: string;
  lang?: 'pt' | 'en';
}

/**
 * Um menu de teclado.
 *
 * A frase vai **dentro** do `<Gather>` de propósito: assim quem já conhece o
 * menu pode apertar antes de a frase terminar, que é como uma pessoa usa um
 * atendimento eletrônico de verdade. O que vier depois do `<Gather>` no mesmo
 * documento é o caminho de quem não apertou nada.
 */
export function gather(opts: GatherOptions): string {
  const inner = opts.say ? say(opts.say, opts.lang ?? 'en') : '';
  return `<Gather${attrs({
    input: 'dtmf',
    numDigits: String(opts.numDigits ?? 1),
    timeout: String(opts.timeout ?? 6),
    action: opts.action,
    method: 'POST',
  })}>${inner}</Gather>`;
}

/** Nothing to say and nothing to do. Twilio hangs up when the document ends. */
export function emptyResponse(): Response {
  return twiml();
}

/**
 * What a caller hears when the CRM cannot serve them.
 *
 * A stranger dialling a number whose workspace has nothing configured must not
 * hear silence or a Twilio error tone: they hear a sentence and the call ends.
 * This is the honest end of every path that cannot continue.
 */
export function apology(lang: 'pt' | 'en' = 'en'): Response {
  const text =
    lang === 'pt'
      ? 'Não conseguimos atender esta chamada agora. Tente novamente mais tarde.'
      : 'We cannot take this call right now. Please try again later.';
  return twiml(say(text, lang), hangup);
}
