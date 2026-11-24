import { and, asc, desc, eq } from 'drizzle-orm';
import type { Db } from '../../db';
import { schema } from '../../db';
import { hoursOf, withinBusinessHours, type HoursSource } from '../ai/hours';
import { cleanPhone } from '../core';
import { getIntegration, saveIntegration } from '../integrations';
import { alertSettingsOf, isUsPhone } from '../twilio/alerts';
import { ELEVENLABS_EN_US_VOICE } from './twiml';
import { LANGUAGE_NAMES, primaryTag } from './relay/types';

/**
 * Everything about calling that is a decision rather than a fact.
 *
 * It lives in the `twilio` integration's `config.voice`, next to `config.alerts`,
 * for the same reason: the schema has no per-workspace settings table and adding
 * one would mean editing it. `saveIntegration` merges config keys, so writing
 * `voice` never disturbs `alerts` and vice versa.
 */

export interface MissedCallText {
  /**
   * Off until somebody turns it on, deliberately. A business that starts
   * texting every missed caller without knowing it has a compliance problem,
   * not a feature.
   */
  enabled: boolean;
  /** A pause, so the person who calls back within the minute wins the race. */
  delaySeconds: number;
  /**
   * How long after texting somebody back the CRM stays quiet, however many
   * more times they ring.
   *
   * Somebody who cannot get through dials three times in five minutes, and a
   * dedupe that keys on the call rather than the person answers all three —
   * which is a documented complaint about the competitor's version of this
   * feature and would be the same complaint about ours.
   */
  cooldownMinutes: number;
  /** Merge fields as everywhere else: {{first_name}}, {{business}}. */
  body: string;
}

/**
 * When the AI receptionist answers an inbound call.
 *
 * `always`: it picks up at once and the forwarding number is only used when
 * it transfers. `after_hours`: inside business hours the human rings as
 * today; outside them, or with nobody to forward to, the assistant answers.
 * `overflow`: the human rings first and the assistant takes the call nobody
 * answered, instead of voicemail. The clock is the workspace's business hours
 * read directly, not `ringingAllowedNow` — that one says "ring anyway" for a
 * workspace that chose to, and would never hand a 3 a.m. call over.
 */
export type AiMode = 'always' | 'after_hours' | 'overflow';

export interface AiVoiceSettings {
  /** Off until somebody turns it on. Separate from the SMS agent's own switch. */
  enabled: boolean;
  mode: AiMode;
  /**
   * The name the assistant answers with ("This is Ava, the AI assistant").
   * Empty means no name: "I'm the AI assistant here". A name makes the call
   * feel like a person picked up; the disclosure that it is an AI stays in
   * the greeting either way, because that is what US callers expect and
   * several states require.
   */
  persona: string;
  /** Empty means the default sentence, which discloses that it is an AI assistant. */
  greeting: string;
  /**
   * Always explicit, never empty. ElevenLabs is the default since 2026-09-14:
   * it is the one provider Twilio pairs with automatic language detection,
   * and the one whose voices do not sound like a machine reading. Amazon
   * and Google stay selectable for a workspace that wants the cheaper leg,
   * and lose the language switching with it (the readiness card says so).
   */
  ttsProvider: 'Amazon' | 'Google' | 'ElevenLabs';
  /**
   * The provider's voice name or id. Empty means Joanna-Neural on Amazon and
   * Twilio's own default English voice on ElevenLabs (`LANGUAGE_VOICES['en-US']`).
   * An ElevenLabs id Twilio does not know ends the call at connect, so the
   * card offers the curated list and asks for a test call after a change.
   */
  voice: string;
  /**
   * The languages the assistant may switch to when the caller does not speak
   * English, as BCP-47 codes from `LANGUAGE_VOICES`. English is never in the
   * list: it is always the primary language, the greeting's and the team's.
   * Empty means the assistant stays in English whatever the caller speaks.
   */
  languages: string[];
  /**
   * An ElevenLabs voice per language, overriding Twilio's default for it.
   * Keyed by the same codes; a language without an entry falls back to
   * `LANGUAGE_VOICES`. Config-only for now — no field on the card.
   */
  voicesByLanguage: Record<string, string>;
  /** E.164. Empty means the number's forwarding target, then the first member who takes calls. */
  transferTo: string;
  /** Total across reconnections; the call is wrapped up past it. */
  maxMinutes: number;
  /** Exchanges before the assistant wraps up and ends the call. */
  maxTurns: number;
  /**
   * Minutes of assistant talk time per day for the whole workspace. Twilio
   * bills ConversationRelay per minute on top of the voice leg, which makes a
   * chatty day the biggest line on the bill — bigger than the model.
   */
  dailyMinutesCap: number;
  /** Words the transcriber should expect: the business name, services, street names. */
  hints: string;
}

/** What one workspace number may say differently from the rest of them. */
export interface NumberVoice {
  /** Empty means "whatever the workspace says". */
  spokenLang: '' | 'pt' | 'en';
  voicemailGreeting: string;
  /** Zero means "whatever the workspace says". */
  ringSeconds: number;
  /**
   * Whether the assistant answers this line, and when. Empty inherits the
   * workspace's `ai.mode` (or its off switch); `off` keeps the assistant away
   * from this one number even when the workspace has it on. Optional only so
   * the writers that predate it keep compiling; the parser always fills it in,
   * and a writer that rebuilds the override must carry it over or it is lost.
   */
  aiMode?: '' | 'off' | AiMode;
}

export interface VoiceSettings {
  /** Record both sides. Off means no recording is ever asked of Twilio. */
  record: boolean;
  /**
   * Read to both parties before the recorder starts, and the reason recording
   * is safe to offer at all.
   *
   * There is no switch to turn it off. California — where this business is —
   * and eleven other states require *every* party to a call to agree before it
   * is recorded (Cal. Penal Code §632: $2,500 per violation, plus a private
   * right of action), and the announcement is what makes that agreement
   * happen: the caller is told, and carrying on with the call is the consent.
   * A checkbox that separated "record" from "announce" would exist only to be
   * left in the one combination that is unlawful, so it does not exist.
   *
   * Empty falls back to the sentence for the spoken language, which is why
   * blanking the box cannot produce a silent recording either.
   */
  recordingNotice: string;
  /**
   * The language Twilio reads the greeting in. It is separate from the
   * interface language, which is a cookie on one person's browser: a caller
   * hears whatever the business chose, not whatever the last admin was reading.
   */
  spokenLang: 'pt' | 'en';
  /** How long the forwarding number rings before the caller gets voicemail. */
  ringSeconds: number;
  /** Read to the caller before the beep. */
  voicemailGreeting: string;
  /** Said after the beep, so the caller knows the message was taken. */
  voicemailThanks: string;
  /** Voicemail longer than this is cut off; Twilio's own ceiling is 3600. */
  voicemailMaxSeconds: number;
  /**
   * Twilio hangs up on a call that runs this long. It is a cap on the bill and
   * on the recording alike: a call nobody ended is the one that produces audio
   * too big to fetch and too long to transcribe inside a serverless function.
   *
   * `DialOptions.timeLimit` was declared and never passed before this, so there
   * was no cap at all and Twilio's own default of four hours applied. Measured:
   * a four-hour recording is 110 MB, four and a half times the transcriber's
   * ceiling.
   */
  maxCallMinutes: number;
  /**
   * What an inbound call does outside the business's own hours. Voicemail by
   * default, because a forwarding number that rings at three in the morning is
   * a setting nobody chose. The hours are the workspace's own, on the
   * workspace's clock — see `src/lib/ai/hours.ts`.
   */
  afterHours: 'ring' | 'voicemail';
  /**
   * O atendente de fora do horário.
   *
   * Teclado, não conversa: fora do expediente o CRM oferece duas coisas — um
   * horário na agenda ou um recado — e a pessoa aperta um número. Sem
   * reconhecimento de fala e sem modelo de linguagem, de propósito: a única
   * coisa que ainda não se sabe é se alguém que liga às nove da noite aceita
   * marcar com uma máquina, e essa pergunta não precisa de IA para ser
   * respondida. Desligado, a ligação fora do horário cai na secretária
   * eletrônica exatamente como antes.
   */
  reception: {
    enabled: boolean;
    /** A agenda em que ele marca. Sem ela, não há o que oferecer. */
    calendarId: string | null;
    /** Quantos horários ler em voz alta por vez. Dois é o que uma pessoa guarda. */
    slots: number;
    /** Até quantos dias à frente procurar horário livre. */
    daysAhead: number;
    /** A primeira frase. Vazia, o CRM usa a sua, no idioma da linha. */
    greeting: string;
  };
  /**
   * Per-number overrides, keyed by the number in E.164. A business with a
   * second line answers it with its own greeting; everything absent here falls
   * through to the workspace's settings above.
   */
  numbers: Record<string, NumberVoice>;
  missedCallText: MissedCallText;
  /** The AI receptionist on Twilio ConversationRelay. English first, the caller's language when they have one. */
  ai: AiVoiceSettings;
  /** Speech-to-text. The key itself is a secret, so it is not in here. */
  stt: {
    /** Only shape there is today; the field exists so a second one can arrive. */
    provider: 'openai_audio';
    /** Origin only, no path. OpenAI, Groq and any look-alike share this API. */
    baseUrl: string;
    model: string;
    /** ISO-639-1 hint. Empty means "let the model decide", which is worse. */
    language: string;
  };
}

/**
 * Everything a caller hears, in each language the CRM speaks.
 *
 * The greeting default follows the spoken language rather than being one fixed
 * string, so switching the dropdown on a workspace that never edited the words
 * changes the words too. A business that had typed its own greeting keeps it:
 * the saved value wins over everything here.
 *
 * The recording sentence deliberately offers a way out. "This call may be
 * recorded" states a possibility; an all-party-consent state wants the caller
 * to have had the chance to object, and "hang up now" is that chance.
 */
export const VOICE_TEXT: Record<'pt' | 'en', { greeting: string; thanks: string; notice: string }> = {
  en: {
    greeting: "Hello! We can't take your call right now. Leave a message after the tone and we'll call you straight back.",
    thanks: "Thank you. We'll call you back shortly.",
    notice: 'This call is being recorded for quality and training. If you would rather not be recorded, please hang up now.',
  },
  pt: {
    greeting: 'Olá! Não podemos atender agora. Deixe seu recado após o sinal e retornamos em seguida.',
    thanks: 'Obrigado. Retornaremos a ligação em breve.',
    notice: 'Esta chamada está sendo gravada para fins de qualidade e treinamento. Se preferir não ser gravado, desligue agora.',
  },
};

export const DEFAULT_VOICE: VoiceSettings = {
  /*
   * Off, and not because the announcement is missing — it is mandatory now and
   * cannot be switched off. Off because whether to record customers at all is
   * the owner's decision to make and not a CRM's to make for them: twelve
   * states require every party to agree, this workspace sits in the strictest
   * of them, and no call has ever been placed here for the setting to be
   * preserving. It is one checkbox, on a screen that says what will be
   * announced and where it is required.
   */
  record: false,
  recordingNotice: '',
  /*
   * English, because the caller decides this and not the operator. The number
   * is a Los Angeles number on a United States business; the person dialling it
   * is American. The interface stays Portuguese for the team — they are two
   * different questions and this is the one the caller hears.
   */
  spokenLang: 'en',
  ringSeconds: 20,
  voicemailGreeting: VOICE_TEXT.en.greeting,
  voicemailThanks: VOICE_TEXT.en.thanks,
  voicemailMaxSeconds: 120,
  /*
   * Forty-five minutes, because that is what stays transcribable rather than
   * what sounds round. Measured against the real fetch-and-upload path: a
   * 45-minute recording is 10.4 MB at 32 kbit/s and 21.6 MB at 64, both under
   * the transcriber's 24 MB ceiling, and our own side of it — fetch, multipart,
   * POST — costs 135 ms, not the 45 seconds the abort allows. At an hour the
   * 64 kbit/s case is 27.5 MB and is refused.
   */
  maxCallMinutes: 45,
  afterHours: 'voicemail',
  /* Desligado até alguém escolher a agenda: um atendente sem agenda é uma
   * promessa de marcar horário que não tem horário para oferecer. */
  reception: { enabled: false, calendarId: null, slots: 2, daysAhead: 7, greeting: '' },
  numbers: {},
  missedCallText: {
    enabled: false,
    delaySeconds: 60,
    cooldownMinutes: 60,
    /*
     * No {{first_name}} in the default, on purpose. The person this text goes
     * to has just rung a business for the first time; the contact row was
     * created by that call and has no name in it, so a greeting built round the
     * name renders "Oi , desculpe" to every single first-time caller. The
     * screen warns about it if somebody puts the field back, and
     * `sendMissedCallText` refuses rather than sending the gap.
     */
    body: 'Oi! Desculpe, perdemos sua ligação. Responda por aqui que a gente te ajuda agora. — {{business}}',
  },
  /*
   * No language hint by default: an American business takes calls in English
   * and in Spanish, and a wrong hint is worse than none — Whisper forced into
   * Portuguese returns Portuguese-shaped nonsense for an English voicemail.
   * Fill the box in when the workspace really does call in one language.
   */
  stt: { provider: 'openai_audio', baseUrl: 'https://api.openai.com', model: 'whisper-1', language: '' },
  /*
   * Off, and after-hours when turned on: the mode that changes the least for
   * a business that already has a person answering the phone. Ten minutes and
   * thirty exchanges is a conversation that booked something or should have
   * handed over; two hours a day is the bill guard, and it is the workspace's
   * own to raise.
   */
  ai: {
    enabled: false,
    mode: 'after_hours',
    persona: '',
    greeting: '',
    ttsProvider: 'ElevenLabs',
    voice: '',
    /*
     * The five languages a Los Angeles business is most likely to be called
     * in besides English. Each is a voice Twilio itself ships, so the default
     * can never be the unknown id that ends a call.
     */
    languages: ['es-US', 'pt-BR', 'fr-FR', 'de-DE', 'it-IT'],
    voicesByLanguage: {},
    transferTo: '',
    maxMinutes: 10,
    maxTurns: 30,
    dailyMinutesCap: 120,
    hints: '',
  },
};

/**
 * Twilio's own default ElevenLabs voice for each language it lists, copied
 * from the ConversationRelay docs on 2026-09-14. These are the only ids the
 * CRM ever writes into TwiML on its own: an ElevenLabs voice Twilio cannot
 * find is not a wrong voice but an error that ends the session at connect,
 * and a table of ids Twilio itself ships is the one list that cannot do that.
 * A voice the owner types by hand is written as typed, and the card says to
 * test it with one call.
 */
export const LANGUAGE_VOICES: Record<string, string> = {
  'en-US': ELEVENLABS_EN_US_VOICE,
  'en-GB': 'Fahco4VZzobUeiPqni1S',
  'es-US': 'CaJslL1xziwefCeTNzHv',
  'es-ES': '6xftrpatV0jGmFHxDjUv',
  'pt-BR': 'CstacWqMhJQlnfLPxRG4',
  'pt-PT': 'TsZfI8Nbn2Xd7ArC76n9',
  'fr-FR': 'a5n9pJUnAhX4fn7lx3uo',
  'fr-CA': 'IPgYtHTNLjC7Bq7IPHrm',
  'de-DE': 'FTNCalFNG5bRnkkaP5Ug',
  'it-IT': 'uScy1bXtKz8vPzfdFsFw',
  'ja-JP': '3JDquces8E8bkmvbh6Bc',
  'ko-KR': 'uyVNoMrnUku1dZyVEXwD',
  'nl-NL': 'UNBIyLbtFB9k7FKW8wJv',
  'hi-IN': 'IvLWq57RKibBrqZGpQrC',
};

/**
 * The English voices the card offers by name, for the datalist under the
 * voice field. Twilio's own default first; the two others are the ids
 * Twilio's docs use in their examples, so they are known to be valid on a
 * Twilio account. Anything else the owner types is taken as typed.
 */
export const CURATED_VOICES: readonly { id: string; label: string }[] = [
  { id: LANGUAGE_VOICES['en-US']!, label: 'Twilio default (en-US)' },
  { id: LANGUAGE_VOICES['en-GB']!, label: 'Twilio default (en-GB)' },
  { id: 'XrExE9yKIg1WjnnlVkGX', label: 'Matilda' },
  { id: 'NYC9WEgkq1u4jiqBseQ9', label: 'Twilio docs example' },
];

/** The codes the assistant may be allowed to switch to: every voice Twilio ships, minus English, which is always primary. */
export const SWITCHABLE_LANGUAGES: readonly string[] = Object.keys(LANGUAGE_VOICES).filter((code) => primaryTag(code) !== 'en');

const REGION_LABEL: Record<string, string> = {
  US: 'US',
  GB: 'UK',
  ES: 'Spain',
  BR: 'Brazil',
  PT: 'Portugal',
  FR: 'France',
  CA: 'Canada',
};

/**
 * "es-US" → "Spanish (US)", "pt-BR" → "Portuguese (Brazil)", "de-DE" → "German".
 * English words: the card wraps the result in `t()` and the Portuguese
 * entries are written by hand in `src/lib/i18n/voice.ts`. The region is
 * only spelled out where Twilio ships two voices for the same language,
 * because "German (Germany)" says nothing a person needs.
 */
export function languageLabel(code: string): string {
  const [tag, region] = code.split('-');
  const name = LANGUAGE_NAMES[primaryTag(tag)] ?? code;
  const siblings = Object.keys(LANGUAGE_VOICES).filter((c) => primaryTag(c) === primaryTag(tag));
  if (siblings.length < 2 || !region) return name;
  return `${name} (${REGION_LABEL[region.toUpperCase()] ?? region.toUpperCase()})`;
}

/** The ElevenLabs voice the session switches to for `code`: the workspace's own choice, else Twilio's default for it. */
export function voiceForLanguage(ai: AiVoiceSettings, code: string): string {
  return ai.voicesByLanguage[code] || LANGUAGE_VOICES[code] || '';
}

/**
 * The languages a call may actually be switched to: the workspace's list on
 * ElevenLabs, nothing on Amazon or Google. Twilio pairs `language="multi"`
 * and the `<Language>` children with ElevenLabs only, so `connectRelay`
 * writes an English-only TwiML for the other two providers whatever the
 * list says (`twiml.ts`), and the readiness card reports it. This is the
 * one place the model's tool list (`voiceTurnFor`), the engine's `language`
 * message (`RelaySession.switchLanguage`) and that TwiML agree on: a
 * workspace still on Amazon with the default five languages stored gets
 * no `switch_language` tool, a prompt that says the line is English-only,
 * and an engine that refuses a switch — instead of a `language` message
 * for a voice the TwiML never declared, which is unverified on Polly.
 */
export function switchableLanguages(ai: Pick<AiVoiceSettings, 'ttsProvider' | 'languages'> | undefined | null): string[] {
  if (!ai || ai.ttsProvider !== 'ElevenLabs') return [];
  return ai.languages ?? [];
}

/** The longest voice string accepted: a 20-character ElevenLabs id with its model and tuning suffix is under 50, so this is generous, not tight. */
export const VOICE_MAX_LENGTH = 120;

/**
 * A voice id or name as the provider expects it: letters, digits, the
 * "-model-speed_stability_similarity" suffix ElevenLabs allows, a dot for
 * Amazon's "Polly.Joanna". Anything else is not a voice and is dropped
 * rather than written into TwiML, where it would end the call. Too long is
 * dropped too, never cut: a voice id with its tail sliced off is still an
 * unknown voice to Twilio, and the empty string falls back to a known one.
 */
function voiceOf(raw: unknown): string {
  const value = (typeof raw === 'string' ? raw : '').trim();
  if (!value || value.length > VOICE_MAX_LENGTH) return '';
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) ? value : '';
}

/** Only codes from the table, never English, no duplicates, in the table's own order so the TwiML is stable. */
function languagesOf(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const wanted = new Set(raw.filter((c): c is string => typeof c === 'string').map((c) => c.trim()));
  return SWITCHABLE_LANGUAGES.filter((code) => wanted.has(code));
}

function voicesByLanguageOf(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [code, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!(code in LANGUAGE_VOICES)) continue;
    const voice = voiceOf(value);
    if (voice) out[code] = voice;
  }
  return out;
}

/** The values a mode field may hold, for the parsers and the settings form. */
export const AI_MODES: readonly AiMode[] = ['always', 'after_hours', 'overflow'];

function aiModeOf(raw: unknown, fallback: AiMode): AiMode {
  return (AI_MODES as readonly unknown[]).includes(raw) ? (raw as AiMode) : fallback;
}

function aiVoiceSettingsOf(raw: unknown): AiVoiceSettings {
  const ai = (raw ?? {}) as Partial<AiVoiceSettings>;
  const d = DEFAULT_VOICE.ai;
  // ElevenLabs unless the workspace chose otherwise: a stored 'Amazon' or
  // 'Google' stays as chosen, and only an absent or unknown value takes the
  // default. A workspace saved before 2026-09-14 therefore keeps Amazon and
  // needs the card to move to ElevenLabs before it can switch languages.
  const tts = ai.ttsProvider === 'Google' || ai.ttsProvider === 'Amazon' ? ai.ttsProvider : 'ElevenLabs';
  // The action cleans the transfer number on the way in; a stored value that
  // is still not E.164 is not a number the assistant may dial, so it reads as
  // empty and the fallback chain in `relay/transfer.ts` decides.
  const transferTo = cleanPhone(typeof ai.transferTo === 'string' ? ai.transferTo : '');
  return {
    enabled: Boolean(ai.enabled),
    mode: aiModeOf(ai.mode, d.mode),
    persona: (typeof ai.persona === 'string' ? ai.persona : '').trim().slice(0, 60),
    greeting: (typeof ai.greeting === 'string' ? ai.greeting : '').slice(0, 500),
    ttsProvider: tts,
    voice: voiceOf(ai.voice),
    // Absent (a row saved before the field existed) means the default five; an
    // explicit empty list means the owner unticked them all, and is kept.
    languages: Array.isArray(ai.languages) ? languagesOf(ai.languages) : [...d.languages],
    voicesByLanguage: voicesByLanguageOf(ai.voicesByLanguage),
    transferTo: transferTo && transferTo.startsWith('+') ? transferTo : '',
    maxMinutes: clamp(ai.maxMinutes, 1, 30, d.maxMinutes),
    maxTurns: clamp(ai.maxTurns, 5, 60, d.maxTurns),
    dailyMinutesCap: clamp(ai.dailyMinutesCap, 10, 600, d.dailyMinutesCap),
    hints: (typeof ai.hints === 'string' ? ai.hints : '').slice(0, 500),
  };
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}

function numberOverrides(raw: unknown): Record<string, NumberVoice> {
  const out: Record<string, NumberVoice> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [number, value] of Object.entries(raw as Record<string, unknown>)) {
    const v = (value ?? {}) as Partial<NumberVoice>;
    const lang = v.spokenLang === 'pt' || v.spokenLang === 'en' ? v.spokenLang : '';
    const greeting = (v.voicemailGreeting ?? '').slice(0, 800);
    const ring = clamp(v.ringSeconds, 0, 120, 0);
    const aiMode: NumberVoice['aiMode'] =
      v.aiMode === 'off' ? 'off' : (AI_MODES as readonly unknown[]).includes(v.aiMode) ? (v.aiMode as AiMode) : '';
    // An override that overrides nothing is noise in the config and a row in
    // the settings screen that says the same thing twice.
    if (!lang && !greeting && !ring && !aiMode) continue;
    out[number] = { spokenLang: lang, voicemailGreeting: greeting, ringSeconds: ring, aiMode };
  }
  return out;
}

export function voiceSettingsOf(config: Record<string, unknown> | undefined | null): VoiceSettings {
  const raw = (config?.voice ?? {}) as Partial<VoiceSettings>;
  const text = (raw.missedCallText ?? {}) as Partial<MissedCallText>;
  const stt = (raw.stt ?? {}) as Partial<VoiceSettings['stt']>;
  const reception = (raw.reception ?? {}) as Partial<VoiceSettings['reception']>;
  const spokenLang = raw.spokenLang === 'pt' ? 'pt' : 'en';
  return {
    record: raw.record ?? DEFAULT_VOICE.record,
    recordingNotice: (raw.recordingNotice ?? '').slice(0, 500),
    spokenLang,
    // Twilio hangs up on a <Dial timeout> above 600, and below 5 the phone
    // barely finishes its first ring.
    ringSeconds: clamp(raw.ringSeconds, 5, 120, DEFAULT_VOICE.ringSeconds),
    voicemailGreeting: (raw.voicemailGreeting ?? VOICE_TEXT[spokenLang].greeting).slice(0, 800),
    voicemailThanks: (raw.voicemailThanks ?? VOICE_TEXT[spokenLang].thanks).slice(0, 400),
    voicemailMaxSeconds: clamp(raw.voicemailMaxSeconds, 10, 600, DEFAULT_VOICE.voicemailMaxSeconds),
    // Twilio's own ceiling for <Dial timeLimit> is 14400 seconds; four hours of
    // recording is a bill and a file nothing downstream can handle.
    maxCallMinutes: clamp(raw.maxCallMinutes, 1, 240, DEFAULT_VOICE.maxCallMinutes),
    afterHours: raw.afterHours === 'ring' ? 'ring' : 'voicemail',
    reception: {
      enabled: Boolean(reception.enabled),
      calendarId: typeof reception.calendarId === 'string' && reception.calendarId ? reception.calendarId : null,
      slots: clamp(reception.slots, 1, 3, DEFAULT_VOICE.reception.slots),
      /* Uma semana é o teto: quem liga hoje à noite não quer ouvir uma vaga de
       * daqui a três semanas, e a agenda muda antes de ela chegar. */
      daysAhead: clamp(reception.daysAhead, 1, 7, DEFAULT_VOICE.reception.daysAhead),
      greeting: (reception.greeting ?? '').slice(0, 500),
    },
    numbers: numberOverrides(raw.numbers),
    missedCallText: {
      enabled: text.enabled ?? DEFAULT_VOICE.missedCallText.enabled,
      delaySeconds: clamp(text.delaySeconds, 0, 3600, DEFAULT_VOICE.missedCallText.delaySeconds),
      cooldownMinutes: clamp(text.cooldownMinutes, 0, 10080, DEFAULT_VOICE.missedCallText.cooldownMinutes),
      body: (text.body ?? DEFAULT_VOICE.missedCallText.body).slice(0, 1000),
    },
    stt: {
      provider: 'openai_audio',
      baseUrl: (stt.baseUrl ?? DEFAULT_VOICE.stt.baseUrl).trim().replace(/\/+$/, '') || DEFAULT_VOICE.stt.baseUrl,
      model: (stt.model ?? DEFAULT_VOICE.stt.model).trim() || DEFAULT_VOICE.stt.model,
      language: (stt.language ?? '').trim().slice(0, 8),
    },
    ai: aiVoiceSettingsOf(raw.ai),
  };
}

/**
 * The workspace's settings as one particular number answers with them.
 *
 * Everything a caller hears can differ per line — a second number belonging to
 * a second trade answers in its own words — while recording, the announcement,
 * the missed-call text and the transcription stay workspace-wide, because those
 * are policy and a business does not have two policies.
 */
export function voiceSettingsForNumber(settings: VoiceSettings, number: string | null | undefined): VoiceSettings {
  const override = number ? settings.numbers[number] : undefined;
  if (!override) return settings;
  const spokenLang = override.spokenLang || settings.spokenLang;
  return {
    ...settings,
    spokenLang,
    ringSeconds: override.ringSeconds || settings.ringSeconds,
    voicemailGreeting: override.voicemailGreeting || settings.voicemailGreeting,
    // The thanks and the announcement follow the language the line speaks even
    // when only the greeting was overridden; a greeting in English answered by
    // a Portuguese "obrigado" is worse than either on its own.
    voicemailThanks:
      override.spokenLang && override.spokenLang !== settings.spokenLang
        ? VOICE_TEXT[spokenLang].thanks
        : settings.voicemailThanks,
    /*
     * The assistant is the one thing a line may switch on or off on its own:
     * a second number bought for one campaign can be answered by the
     * assistant while the main line stays with a person, or the reverse.
     * `off` is a real off — `enabled` goes false for this number — and a mode
     * turns it on for the line even when the workspace default is off, because
     * that is what "per number" has to mean for the setting to be useful.
     */
    ai:
      override.aiMode === 'off'
        ? { ...settings.ai, enabled: false }
        : override.aiMode
          ? { ...settings.ai, enabled: true, mode: override.aiMode }
          : settings.ai,
  };
}

/** The sentence read before the recorder starts. Never empty while recording. */
export function recordingNoticeText(settings: VoiceSettings): string {
  return settings.recordingNotice.trim() || VOICE_TEXT[settings.spokenLang].notice;
}

export async function loadVoiceSettings(db: Db, workspaceId: string): Promise<VoiceSettings> {
  const integration = await getIntegration(db, workspaceId, 'twilio');
  return voiceSettingsOf(integration?.config);
}

export async function saveVoiceSettings(db: Db, workspaceId: string, voice: VoiceSettings) {
  await saveIntegration(db, workspaceId, 'twilio', { config: { voice } });
}

/* ------------------------------------------------------------------------ */
/*  The clock                                                                */
/* ------------------------------------------------------------------------ */

/**
 * Whether an inbound call should ring a phone at all right now.
 *
 * The hours are the workspace's own (Settings → Workspace), read on the
 * workspace's clock by the same `hoursOf` the AI agent and the flow engine
 * use for the same question. Two notions of "open" in one product is how a
 * business ends up with an assistant answering at hours its phone does not.
 */
export function ringingAllowedNow(
  voice: VoiceSettings,
  workspace: { timezone: string; settings: HoursSource },
  nowMs = Date.now(),
): boolean {
  if (voice.afterHours === 'ring') return true;
  return withinBusinessHours(hoursOf(workspace.settings), workspace.timezone, nowMs);
}

/* ------------------------------------------------------------------------ */
/*  Numbers                                                                  */
/* ------------------------------------------------------------------------ */

/** The number this workspace calls from: the chosen one, else the default. */
export async function callingNumber(db: Db, workspaceId: string, wanted?: string | null) {
  const rows = await db
    .select()
    .from(schema.phoneNumbers)
    .where(and(eq(schema.phoneNumbers.workspaceId, workspaceId), eq(schema.phoneNumbers.voice, true)))
    .orderBy(desc(schema.phoneNumbers.isDefault), asc(schema.phoneNumbers.createdAt));
  if (!rows.length) return null;
  if (wanted) return rows.find((r) => r.number === wanted) ?? null;
  return rows[0];
}

/**
 * The mobile the CRM rings first on a click-to-call.
 *
 * It is the same number Settings → Messaging already collects for inbox alerts,
 * and deliberately so: asking a salesperson for their mobile twice, in two
 * screens, is how the two end up different and how a call rings a phone nobody
 * is holding.
 */
export async function memberPhone(db: Db, workspaceId: string, userId: string): Promise<string | null> {
  const integration = await getIntegration(db, workspaceId, 'twilio');
  const alerts = alertSettingsOf(integration?.config);
  const phone = cleanPhone(alerts.members[userId]?.phone ?? '');
  // The same rule as the alerts: a number outside the United States, or one
  // that cannot exist, is not a mobile the CRM texts or rings.
  return phone && isUsPhone(phone) ? phone : null;
}

/** One person on the team, and the handset the CRM would ring for them. */
export interface CallMember {
  id: string;
  name: string;
  /** E.164, or null while nobody has typed one in Settings → Messaging. */
  phone: string | null;
  /** False when this mobile takes the alert texts but no calls. */
  calls: boolean;
}

/**
 * Everyone on the team, with the mobile each would answer on.
 *
 * The Call button offers this list so the person pressing it says *whose phone
 * rings* — the owner dials a lead and hands it to whoever is free, and before
 * this the only possible answer was "the phone of whoever is logged in". The
 * ones who cannot be rung — no number, or a number that takes texts only — are
 * still listed, disabled and labelled: a colleague missing from a dropdown
 * reads as a bug, while a greyed name reads as the setting it actually is.
 */
export async function callMembers(db: Db, workspaceId: string): Promise<CallMember[]> {
  const [rows, integration] = await Promise.all([
    db
      .select({ id: schema.user.id, name: schema.user.name })
      .from(schema.workspaceMembers)
      .innerJoin(schema.user, eq(schema.user.id, schema.workspaceMembers.userId))
      .where(eq(schema.workspaceMembers.workspaceId, workspaceId))
      .orderBy(asc(schema.user.name)),
    getIntegration(db, workspaceId, 'twilio'),
  ]);
  const alerts = alertSettingsOf(integration?.config);
  return rows.map((row) => {
    const member = alerts.members[row.id];
    const phone = cleanPhone(member?.phone ?? '');
    return { id: row.id, name: row.name, phone: phone && phone.startsWith('+') ? phone : null, calls: member?.calls !== false };
  });
}

/** Trial accounts may only reach numbers proved in the Twilio console. */
export async function verifiedNumbers(db: Db, workspaceId: string): Promise<Set<string>> {
  const rows = await db
    .select({ number: schema.verifiedNumbers.number })
    .from(schema.verifiedNumbers)
    .where(eq(schema.verifiedNumbers.workspaceId, workspaceId));
  return new Set(rows.map((r) => r.number));
}
