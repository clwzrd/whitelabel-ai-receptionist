import type { ProviderId } from './provider';

/**
 * The AI vendors this installation can talk to.
 *
 * A vendor is an address, a wire protocol and the name of the environment
 * variable its key usually lives in — nothing else. The agent, the copilot,
 * the voice receptionist and the background readers all go through
 * `providerFor()` in `provider.ts`, which speaks two protocols: Anthropic's
 * Messages API and the OpenAI chat-completions shape. Almost every other
 * vendor publishes an endpoint in the second shape, so adding one is a row
 * here, not a new adapter.
 *
 * No model ids are listed for the vendors below on purpose: model line-ups
 * change faster than this file would, and a stale id fails at the first call.
 * The operator types the model id the vendor currently publishes, and "Test
 * connection" proves it — including that it can make a tool call, which is
 * what the agent runs on. Models whose prices are on file are in `MODELS`
 * (`config.ts`); for any other, the operator types the rates on the same
 * screen so the daily cost cap stays honest.
 */
export interface VendorPreset {
  id: string;
  label: string;
  /** The wire protocol, i.e. which adapter under `providers/` is used. */
  provider: ProviderId;
  /** Origin the key belongs to. Empty: the operator types it. */
  baseUrl: string;
  /** The environment variable read as the platform-wide fallback key. */
  envKey: string | null;
  /** Shown as the placeholder of the key field. */
  keyHint: string;
  /** Where conversations physically go, for the notice next to the choice. */
  residency: string;
}

export const VENDORS: VendorPreset[] = [
  { id: 'anthropic', label: 'Anthropic (Claude)', provider: 'anthropic', baseUrl: 'https://api.anthropic.com', envKey: 'ANTHROPIC_API_KEY', keyHint: 'sk-ant-…', residency: 'Anthropic (United States)' },
  { id: 'openai', label: 'OpenAI (GPT / ChatGPT models)', provider: 'openai_compatible', baseUrl: 'https://api.openai.com', envKey: 'OPENAI_API_KEY', keyHint: 'sk-…', residency: 'OpenAI (United States)' },
  { id: 'google', label: 'Google (Gemini)', provider: 'openai_compatible', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', envKey: 'GEMINI_API_KEY', keyHint: 'AIza…', residency: 'Google' },
  { id: 'deepseek', label: 'DeepSeek', provider: 'openai_compatible', baseUrl: 'https://api.deepseek.com', envKey: 'DEEPSEEK_API_KEY', keyHint: 'sk-…', residency: 'DeepSeek (China)' },
  { id: 'xai', label: 'xAI (Grok)', provider: 'openai_compatible', baseUrl: 'https://api.x.ai', envKey: 'XAI_API_KEY', keyHint: 'xai-…', residency: 'xAI (United States)' },
  { id: 'mistral', label: 'Mistral', provider: 'openai_compatible', baseUrl: 'https://api.mistral.ai', envKey: 'MISTRAL_API_KEY', keyHint: 'API key', residency: 'Mistral (European Union)' },
  { id: 'groq', label: 'Groq', provider: 'openai_compatible', baseUrl: 'https://api.groq.com/openai', envKey: 'GROQ_API_KEY', keyHint: 'gsk_…', residency: 'Groq (United States)' },
  { id: 'openrouter', label: 'OpenRouter (many vendors, one key)', provider: 'openai_compatible', baseUrl: 'https://openrouter.ai/api', envKey: 'OPENROUTER_API_KEY', keyHint: 'sk-or-…', residency: 'OpenRouter and the vendor it routes to' },
  { id: 'ollama', label: 'Ollama (a model on your own server)', provider: 'openai_compatible', baseUrl: 'http://localhost:11434', envKey: null, keyHint: 'any text; Ollama ignores it', residency: 'your own server' },
  { id: 'custom', label: 'Other (any OpenAI-compatible endpoint)', provider: 'openai_compatible', baseUrl: '', envKey: null, keyHint: 'API key', residency: 'the provider at that address' },
];

const hostOf = (url: string): string => {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return '';
  }
};

/** The vendor a base URL belongs to, by host. Null for an address nobody here knows. */
export function vendorForBaseUrl(baseUrl: string | null | undefined): VendorPreset | null {
  const host = hostOf((baseUrl ?? '').trim());
  if (!host) return null;
  return VENDORS.find((v) => v.baseUrl && hostOf(v.baseUrl) === host) ?? null;
}

export function vendorById(id: string | null | undefined): VendorPreset | null {
  return VENDORS.find((v) => v.id === id) ?? null;
}

/**
 * The name of the environment variable holding the platform's key for the
 * vendor at `baseUrl`, in the order the fallback tries them: the vendor's own
 * variable first, then `AI_API_KEY`, the catch-all for an installation that
 * uses a single vendor everywhere.
 */
export function envKeyNamesFor(provider: ProviderId, baseUrl: string): string[] {
  const vendor = vendorForBaseUrl(baseUrl);
  const names: string[] = [];
  if (vendor?.envKey) names.push(vendor.envKey);
  else if (provider === 'anthropic') names.push('ANTHROPIC_API_KEY');
  names.push('AI_API_KEY');
  return names;
}
