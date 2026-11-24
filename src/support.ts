/**
 * The few shapes the session engine needs from the outside world.
 *
 * The engine (`engine/session.ts`) was written inside a CRM, against that
 * CRM's call row and settings. Here they are plain types this service owns,
 * so the engine runs unchanged.
 */

/** The language the team reads in. Everything written for people is English here. */
export type Lang = 'en' | 'pt';

/** One phone call, from the moment Twilio rings the line. */
export interface Call {
  /** This service's own id for the call; travels in the socket URL and the TwiML parameters. */
  id: string;
  workspaceId: string;
  /** The CRM's id for the caller, once known. */
  contactId: string | null;
  fromNumber: string | null;
  toNumber: string | null;
  /** Twilio's CallSid. */
  providerId: string;
  answeredAt: Date | null;
  startedAt: Date;
}

export interface AiVoiceSettings {
  /** The name the assistant answers with. Empty: "I'm the AI assistant here". */
  persona: string;
  /** Empty means the default sentence, which discloses that it is an AI assistant. */
  greeting: string;
  ttsProvider: 'Amazon' | 'Google' | 'ElevenLabs';
  /** Empty means the provider's default English voice. */
  voice: string;
  /** BCP-47 codes the assistant may switch to. English is always the primary language and never listed. */
  languages: string[];
  voicesByLanguage: Record<string, string>;
  /** E.164. Empty: nobody to transfer to, the assistant takes a message instead. */
  transferTo: string;
  maxMinutes: number;
  maxTurns: number;
}

export interface VoiceSettings {
  ai: AiVoiceSettings;
}

/**
 * The languages a call may be moved to. Twilio pairs automatic language
 * detection with ElevenLabs only, so on any other provider the list is empty
 * and the line is English-only.
 */
export function switchableLanguages(ai: Pick<AiVoiceSettings, 'ttsProvider' | 'languages'> | undefined | null): string[] {
  if (!ai || ai.ttsProvider !== 'ElevenLabs') return [];
  return ai.languages ?? [];
}

/** The CRM scoped team-facing text to a language per request; this service writes English, so it is a pass-through. */
export function withLang<T>(_lang: Lang, fn: () => T): T {
  return fn();
}

/** Twilio's own default ElevenLabs voice for English. An id Twilio does not know ends the call at connect. */
export const ELEVENLABS_EN_US_VOICE = 'UgBBYS2sOqTuMpoF3BR0';

/** Twilio's default ElevenLabs voice per language. */
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

export function voiceForLanguage(ai: Pick<AiVoiceSettings, 'voicesByLanguage'>, code: string): string {
  return ai.voicesByLanguage?.[code] || LANGUAGE_VOICES[code] || '';
}
