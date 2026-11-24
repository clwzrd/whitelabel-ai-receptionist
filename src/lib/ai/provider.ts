/**
 * The one shape the rest of the agent talks to.
 *
 * Which company answers the question is a commercial decision, not an
 * architectural one: Claude today, DeepSeek tomorrow if the arithmetic says so.
 * So the turn logic, the guardrails, the tool dispatch and the audit trail know
 * only `complete()` and the normalised result below, and the two implementations
 * under `providers/` do the translating. They are the only files in this feature
 * that know what a "content block" or a "tool_calls array" is.
 *
 * Both implementations are plain `fetch` against a documented REST API. No SDK:
 * the serverless bundle is small on purpose, and two SDKs would be two.
 */

export type ProviderId = 'anthropic' | 'openai_compatible';

export interface AiCreds {
  provider: ProviderId;
  apiKey: string;
  /** Origin only, no path. Defaults per provider in `config.ts`. */
  baseUrl: string;
  model: string;
}

/* ------------------------------------------------------------------------ */
/*  The conversation, in neither provider's vocabulary                        */
/* ------------------------------------------------------------------------ */

export type AiContent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; toolUseId: string; text: string; isError?: boolean };

export interface AiMessage {
  role: 'user' | 'assistant';
  content: AiContent[];
  /**
   * The assistant turn exactly as its provider wants it echoed back.
   *
   * Anthropic returns thinking blocks that must be replayed unchanged, and the
   * OpenAI shape wants its own `tool_calls` array back verbatim. Rebuilding
   * either from the normalised blocks above loses information, so the provider
   * that produced a turn is the one that reads it again. A provider never sees
   * another provider's `raw` — switching provider starts a fresh thread.
   */
  raw?: unknown;
}

/** A tool the model may call. One JSON Schema, translated per provider. */
export interface AiToolDef {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties: false;
  };
}

export interface CompleteInput {
  /**
   * Byte-identical on every call for a given agent: persona, rules, knowledge.
   * It comes first in the request because a prefix cache — Anthropic's
   * `cache_control` breakpoint, DeepSeek's automatic context cache — only hits
   * on an exact prefix, so anything that changes per message belongs in
   * `systemVariable`, never here. On DeepSeek a cache read costs a thirtieth of
   * a fresh one, so on a per-message agent this ordering is most of the bill;
   * nothing breaks on a provider that has no cache at all.
   */
  systemFixed: string;
  /** The clock, the contact, the turn counter. Always after the fixed part. */
  systemVariable: string;
  messages: AiMessage[];
  tools: AiToolDef[];
  /**
   * `none` keeps the tools in the request (an empty list is rejected by some
   * gateways, and the model still reads their names for context) but forbids
   * calling them, so the reply has to be words. The copilot uses it for the
   * closing call once its tool budget is spent. Omitted means `auto`.
   */
  toolChoice?: 'auto' | 'none';
  maxTokens: number;
  /**
   * Abort the HTTP call after this long. A caller with a budget (the
   * prospecting heartbeat) passes what it can afford; without it the request
   * keeps running, and being billed, after the caller has stopped waiting.
   */
  timeoutMs?: number;
  /**
   * `off` asks a reasoning model not to think before answering. Measured on
   * 2026-09-13 with the prospecting writer on DeepSeek: with thinking on, the
   * model spent all 3,000 output tokens reasoning and never wrote the e-mail;
   * with it off the same e-mail is under 500 tokens and a few seconds. A
   * provider that has no such switch ignores this.
   */
  reasoning?: 'off';
  /**
   * The caller's own way of giving up on the call. `timeoutMs` is a deadline
   * decided before the request goes out; this is for a deadline that moves
   * while it is in flight — the voice receptionist's turn budget shrinks as
   * the function's own deadline approaches, and a reply the caller can no
   * longer use is a reply nobody should be billed for. Aborting also ends
   * the provider's generation, which is what stops the meter.
   */
  signal?: AbortSignal;
}

export interface AiUsage {
  /** Every prompt token, cached or not. */
  inputTokens: number;
  /** Everything generated, reasoning included — that is how it is billed. */
  outputTokens: number;
  /** Read from the provider's cache, and therefore much cheaper. */
  cachedInputTokens: number;
  /** The part of `outputTokens` the model spent thinking. Reported, not billed apart. */
  reasoningTokens: number;
}

export interface CompleteResult {
  /** Everything the model said in plain text, joined. */
  text: string;
  toolCalls: { id: string; name: string; input: Record<string, unknown> }[];
  usage: AiUsage;
  /** What actually answered, as the provider named it — not what we asked for. */
  model: string;
  stopReason: string;
  /**
   * A reasoning model's working, where it returns one. It is never sent to the
   * contact and never replayed into the next request — DeepSeek rejects its own
   * `reasoning_content` coming back — but it is written into `ai_runs`, because
   * it is the closest thing there is to the agent's reasons in its own words.
   */
  reasoning: string;
  /** Fed straight back as `AiMessage.raw` on the next call. */
  raw: unknown;
}

/**
 * What one press of "Test connection" learned.
 *
 * Three separate facts, because they fail separately and the difference
 * decides whether this model can run the agent at all. A key can be valid and
 * the model still not do function calling — which is the normal state of the
 * cheap and free models — and this whole feature is tool use. So the check
 * asks a question that can only be answered by calling a tool, and reports
 * whether a well-formed call came back rather than whether words did.
 */
export interface CheckResult {
  /** The model id the provider says answered — not the one we asked for. */
  model: string;
  /** The key works and the model produced a response at all. */
  answered: boolean;
  /** It returned a syntactically valid call to the tool it was given. */
  toolCallOk: boolean;
  /** What came back instead, when the tool call did not. */
  toolCallDetail: string;
  latencyMs: number;
  usage: AiUsage;
}

/**
 * The probe. One trivial tool and one question that cannot be answered without
 * it. `tool_choice` is left alone on purpose: forcing a call proves only that
 * the provider can format one, and the agent itself never forces, so a forced
 * probe would pass for a model the agent then fails on.
 */
export const PROBE_TOOL: AiToolDef = {
  name: 'get_time',
  description: 'Returns the current local time in a city. The only way to know the time.',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string', description: 'City name, e.g. "Tokyo".' } },
    required: ['city'],
    additionalProperties: false,
  },
};

export const PROBE_PROMPT = 'What time is it in Tokyo right now? Use the get_time tool to find out.';

export interface AiProvider {
  id: ProviderId;
  complete(creds: AiCreds, input: CompleteInput): Promise<CompleteResult>;
  /** The smallest real call that proves the key, the model and tool calling. */
  check(creds: AiCreds): Promise<CheckResult>;
}

/* ------------------------------------------------------------------------ */
/*  Failures                                                                 */
/* ------------------------------------------------------------------------ */

/** The configuration is wrong. Retrying will not help; a human must fix it. */
export class AiRefused extends Error {}

/** The provider was reached and said no. `status` decides whether to retry. */
export class AiCallFailed extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly body?: string,
  ) {
    super(message);
    this.name = 'AiCallFailed';
  }

  /** 429 and 5xx are weather; 400 and 401 are a mistake somebody has to fix. */
  get retryable(): boolean {
    return this.status === null || this.status === 429 || this.status >= 500;
  }
}

/* ------------------------------------------------------------------------ */
/*  The registry                                                             */
/* ------------------------------------------------------------------------ */

const MODULES: Record<ProviderId, () => Promise<{ provider: AiProvider }>> = {
  anthropic: () => import('./providers/anthropic'),
  openai_compatible: () => import('./providers/openaiCompatible'),
};

export async function providerFor(id: ProviderId): Promise<AiProvider> {
  const mod = await MODULES[id]();
  return mod.provider;
}

/* ------------------------------------------------------------------------ */
/*  Shared HTTP                                                              */
/* ------------------------------------------------------------------------ */

/**
 * One POST, with a deadline.
 *
 * A Vercel function has a fixed number of seconds in total and the heartbeat
 * runs several jobs inside one, so a provider that hangs must not take the
 * whole tick with it. The abort is the caller's protection, not the
 * provider's. A caller that has its own reason to stop waiting — a voice turn
 * whose budget ran out while the model was still writing — passes `signal`,
 * and either the timer or the caller can cut the request; the message says
 * which one did, because "the model was slow" and "we stopped asking" call
 * for different fixes.
 */
export async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs = 30_000,
  signal?: AbortSignal,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const relay = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', relay, { once: true });
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    if (aborted && signal?.aborted) throw new AiCallFailed('The call was cancelled before the provider answered.', null);
    throw new AiCallFailed(aborted ? `No answer within ${Math.round(timeoutMs / 1000)}s.` : String(error), null);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', relay);
  }

  const text = await response.text();
  if (!response.ok) {
    throw new AiCallFailed(describeHttpError(response.status, text), response.status, text.slice(0, 1000));
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new AiCallFailed('The provider answered with something that is not JSON.', response.status, text.slice(0, 400));
  }
}

/**
 * The provider's own wording is written for whoever integrated it. The person
 * reading this pressed a button called "Test connection", so the sentence has
 * to say what they should do about it.
 */
function describeHttpError(status: number, body: string): string {
  const message = extractMessage(body);
  if (status === 401 || status === 403) {
    return `The provider refused this key (${status}). ${message ?? 'Check that it was pasted whole and has not been revoked.'}`;
  }
  if (status === 404) {
    return `Nothing at that address (404). ${message ?? 'Check the base URL and the model name.'}`;
  }
  if (status === 400) {
    return `The provider rejected the request (400). ${message ?? 'This usually means the model name does not exist on this account.'}`;
  }
  if (status === 429) return `Rate limited (429). ${message ?? 'Too many requests, or the account is out of credit.'}`;
  if (status >= 500) return `The provider is having trouble (${status}). ${message ?? 'Try again in a moment.'}`;
  return `${status}: ${message ?? body.slice(0, 200)}`;
}

function extractMessage(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string; message?: string };
    if (typeof parsed.error === 'string') return parsed.error;
    return parsed.error?.message ?? parsed.message ?? null;
  } catch {
    return null;
  }
}

/** `https://api.deepseek.com/` and `https://api.deepseek.com` are the same place. */
export function trimBase(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}
