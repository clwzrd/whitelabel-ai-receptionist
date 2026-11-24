import type { AiCreds, ProviderId } from './ai/provider';
import { envKeyNamesFor, vendorById, vendorForBaseUrl } from './ai/presets';
import { env, requireEnv } from './env';
import type { AiVoiceSettings } from './support';

/**
 * Everything the service is told, read from the environment once at start.
 * `.env.example` lists every variable with what it does.
 */
export interface Config {
  port: number;
  /** The address Twilio reaches this service at, no trailing slash: https://receptionist.yourdomain.com */
  publicUrl: string;
  twilio: { accountSid: string; authToken: string };
  /** Development only: accept requests without Twilio's signature. */
  allowUnsigned: boolean;
  ai: { creds: AiCreds; priceIn: number; priceOut: number };
  voice: AiVoiceSettings;
  crm: { kind: 'memory' } | { kind: 'whitelabel'; origin: string; apiKey: string; calendarId: string };
  business: { name: string; timezone: string; hours: string; knowledge: string; appointmentName: string; appointmentMinutes: number };
  databaseUrl: string | null;
}

const number = (name: string, fallback: number): number => {
  const value = Number(env(name));
  return Number.isFinite(value) && value > 0 ? value : fallback;
};
const list = (name: string): string[] => (env(name) ?? '').split(',').map((s) => s.trim()).filter(Boolean);

/** The model the assistant thinks with: a vendor id or a base URL, a model id and a key. */
export function aiCreds(): AiCreds {
  const named = (env('AI_PROVIDER') ?? '').trim().toLowerCase();
  const baseUrlGiven = (env('AI_BASE_URL') ?? '').trim().replace(/\/+$/, '');
  const vendor = vendorById(named) ?? vendorForBaseUrl(baseUrlGiven);
  const provider: ProviderId = named === 'anthropic' || named === 'openai_compatible' ? named : (vendor?.provider ?? 'openai_compatible');
  const baseUrl = baseUrlGiven || vendor?.baseUrl || (provider === 'anthropic' ? 'https://api.anthropic.com' : '');
  if (!baseUrl) throw new Error('Set AI_PROVIDER to a vendor (anthropic, openai, google, deepseek, …) or AI_BASE_URL to an OpenAI-compatible endpoint.');
  const apiKey = envKeyNamesFor(provider, baseUrl).map((name) => env(name)).find(Boolean);
  if (!apiKey) throw new Error(`No API key for the model: set AI_API_KEY (or ${vendor?.envKey ?? "the vendor's own variable"}).`);
  return { provider, baseUrl, apiKey, model: requireEnv('AI_MODEL') };
}

export function loadConfig(): Config {
  const ttsProvider = env('TTS_PROVIDER') ?? 'ElevenLabs';
  if (!['Amazon', 'Google', 'ElevenLabs'].includes(ttsProvider)) throw new Error('TTS_PROVIDER must be ElevenLabs, Amazon or Google.');
  const crmKind = (env('CRM') ?? 'memory').toLowerCase();
  if (crmKind !== 'memory' && crmKind !== 'whitelabel') throw new Error('CRM must be "memory" or "whitelabel".');
  return {
    port: number('PORT', 8080),
    publicUrl: requireEnv('PUBLIC_URL').replace(/\/+$/, ''),
    twilio: { accountSid: requireEnv('TWILIO_ACCOUNT_SID'), authToken: requireEnv('TWILIO_AUTH_TOKEN') },
    allowUnsigned: env('ALLOW_UNSIGNED') === '1',
    ai: { creds: aiCreds(), priceIn: Number(env('AI_PRICE_IN') ?? 0) || 0, priceOut: Number(env('AI_PRICE_OUT') ?? 0) || 0 },
    voice: {
      persona: env('PERSONA') ?? '',
      greeting: env('GREETING') ?? '',
      ttsProvider: ttsProvider as AiVoiceSettings['ttsProvider'],
      voice: env('VOICE') ?? '',
      languages: list('LANGUAGES'),
      voicesByLanguage: {},
      transferTo: env('TRANSFER_TO') ?? '',
      maxMinutes: number('MAX_MINUTES', 10),
      maxTurns: number('MAX_TURNS', 40),
    },
    crm: crmKind === 'whitelabel'
      ? { kind: 'whitelabel', origin: requireEnv('CRM_ORIGIN').replace(/\/+$/, ''), apiKey: requireEnv('CRM_CONNECTOR_API_KEY'), calendarId: requireEnv('CRM_CALENDAR_ID') }
      : { kind: 'memory' },
    business: {
      name: env('BUSINESS_NAME') ?? 'the business',
      timezone: env('BUSINESS_TIMEZONE') ?? 'America/New_York',
      hours: env('BUSINESS_HOURS') ?? '',
      knowledge: env('BUSINESS_KNOWLEDGE') ?? '',
      appointmentName: env('APPOINTMENT_NAME') ?? 'a call',
      appointmentMinutes: number('APPOINTMENT_MINUTES', 30),
    },
    databaseUrl: env('DATABASE_URL') ?? null,
  };
}
