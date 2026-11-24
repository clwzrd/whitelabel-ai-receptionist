import type { AiProvider, CompleteInput, CompleteResult } from './ai/provider';
import type { Config } from './config';

/**
 * Shared by the tests: a model that follows a script, and a configuration
 * that needs no environment.
 */

export type Step = (input: CompleteInput) => Partial<CompleteResult>;

/** A provider that answers each request with the next step of a script, and records what it was asked. */
export function scriptedProvider(steps: Step[]): AiProvider & { asked: CompleteInput[] } {
  const asked: CompleteInput[] = [];
  let n = 0;
  return {
    id: 'openai_compatible',
    asked,
    async complete(_creds, input) {
      asked.push(input);
      const step = steps[n++];
      if (!step) throw new Error(`the script has no step ${n}`);
      return { text: '', toolCalls: [], usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 0, reasoningTokens: 0 }, model: 'scripted', stopReason: 'end', reasoning: '', raw: null, ...step(input) };
    },
    async check() {
      throw new Error('not used');
    },
  };
}

let id = 0;
/** One tool call, as a model would return it. */
export const call = (name: string, input: Record<string, unknown> = {}) => ({ toolCalls: [{ id: `t${++id}`, name, input }] });
export const say = (text: string) => ({ text });

/** Everything the model has been shown so far, as one string, to pull a value out of a tool result. */
export const seen = (input: CompleteInput) => JSON.stringify(input.messages);

export const TEST_AUTH_TOKEN = 'test-twilio-auth-token';
export const TEST_ACCOUNT = 'AC00000000000000000000000000000000';

export function testConfig(over: Partial<Config> = {}): Config {
  return {
    port: 0,
    publicUrl: 'https://receptionist.example.com',
    twilio: { accountSid: TEST_ACCOUNT, authToken: TEST_AUTH_TOKEN },
    allowUnsigned: false,
    ai: { creds: { provider: 'openai_compatible', apiKey: 'test-key', baseUrl: 'https://ai.example.com', model: 'scripted' }, priceIn: 1, priceOut: 2 },
    voice: { persona: 'Ava', greeting: '', ttsProvider: 'ElevenLabs', voice: '', languages: ['es-US', 'pt-BR'], voicesByLanguage: {}, transferTo: '', maxMinutes: 10, maxTurns: 40 },
    crm: { kind: 'memory' },
    business: { name: 'Acme Plumbing', timezone: 'America/New_York', hours: 'Monday to Friday, 9 a.m. to 5 p.m.', knowledge: '', appointmentName: 'a discovery call', appointmentMinutes: 30 },
    databaseUrl: null,
    ...over,
  };
}

/** Timers shrunk to milliseconds, so a whole call runs in well under a second. */
export const FAST = { fillerMs: 15, dtmfBufferMs: 10, speakMsPerChar: 0, speakMinMs: 4, speakMaxMs: 4, rotateWaitMs: 4 };

export async function until(condition: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
