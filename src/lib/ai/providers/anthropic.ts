import {
  AiCallFailed,
  PROBE_PROMPT,
  PROBE_TOOL,
  postJson,
  trimBase,
  type AiCreds,
  type AiMessage,
  type AiProvider,
  type AiUsage,
  type CheckResult,
  type CompleteInput,
  type CompleteResult,
} from '../provider';

/**
 * Anthropic's Messages API, over `fetch`.
 *
 * Two shapes are peculiar to this provider and are the reason the interface
 * exists. A turn is an array of typed content blocks rather than a string plus
 * a side-channel, and thinking blocks that come back must be replayed
 * unchanged on the next request — so the assistant turn is echoed from `raw`
 * and never rebuilt from the normalised blocks.
 */

const VERSION = '2023-06-01';

interface AnthropicBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface AnthropicResponse {
  model: string;
  content: AnthropicBlock[];
  stop_reason: string | null;
  stop_details?: { type: string; category?: string | null; explanation?: string } | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

function url(creds: AiCreds): string {
  return `${trimBase(creds.baseUrl)}/v1/messages`;
}

function headers(creds: AiCreds): Record<string, string> {
  return { 'x-api-key': creds.apiKey, 'anthropic-version': VERSION };
}

/** Our blocks, in Anthropic's vocabulary. Only used for the user side. */
function toAnthropic(messages: AiMessage[]): { role: 'user' | 'assistant'; content: unknown }[] {
  return messages.map((m) => {
    // An assistant turn goes back exactly as it came, thinking blocks included.
    if (m.role === 'assistant' && m.raw) return { role: 'assistant' as const, content: m.raw };
    return {
      role: m.role,
      content: m.content.map((c) => {
        if (c.type === 'text') return { type: 'text', text: c.text };
        if (c.type === 'tool_use') return { type: 'tool_use', id: c.id, name: c.name, input: c.input };
        return { type: 'tool_result', tool_use_id: c.toolUseId, content: c.text, ...(c.isError ? { is_error: true } : {}) };
      }),
    };
  });
}

/**
 * Anthropic reports cache reads and cache writes *outside* `input_tokens`,
 * where DeepSeek reports them inside `prompt_tokens`. Both are normalised to
 * "inputTokens is every prompt token, cachedInputTokens is the cheap part", so
 * the cost arithmetic upstairs is one formula rather than one per vendor. Cache
 * *writes* are billed at a premium here and are counted at the plain input
 * rate, which understates them slightly on the first call of a thread.
 */
function usageOf(raw: AnthropicResponse['usage']): AiUsage {
  const read = raw.cache_read_input_tokens ?? 0;
  const written = raw.cache_creation_input_tokens ?? 0;
  return {
    inputTokens: (raw.input_tokens ?? 0) + read + written,
    outputTokens: raw.output_tokens ?? 0,
    cachedInputTokens: read,
    // Claude does not return a separate count for thinking; it is inside output.
    reasoningTokens: 0,
  };
}

function readResponse(json: AnthropicResponse): CompleteResult {
  const blocks = Array.isArray(json.content) ? json.content : [];
  return {
    text: blocks
      .filter((b) => b.type === 'text' && b.text)
      .map((b) => b.text!.trim())
      .join('\n')
      .trim(),
    toolCalls: blocks
      .filter((b) => b.type === 'tool_use' && b.name)
      .map((b) => ({ id: b.id ?? '', name: b.name!, input: (b.input ?? {}) as Record<string, unknown> })),
    usage: usageOf(json.usage ?? { input_tokens: 0, output_tokens: 0 }),
    model: json.model,
    stopReason: json.stop_reason ?? 'end_turn',
    reasoning: blocks
      .filter((b) => b.type === 'thinking' && b.text)
      .map((b) => b.text!.trim())
      .join('\n')
      .trim(),
    raw: blocks,
  };
}

export const provider: AiProvider = {
  id: 'anthropic',

  async complete(creds, input: CompleteInput): Promise<CompleteResult> {
    const body = {
      model: creds.model,
      max_tokens: input.maxTokens,
      /*
       * Two system blocks, in this order, with the cache breakpoint between
       * them: everything that repeats is billed once per five minutes, and the
       * clock and the contact — which change on every message — sit after it
       * where they cannot invalidate anything.
       */
      system: [
        { type: 'text', text: input.systemFixed, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: input.systemVariable },
      ],
      messages: toAnthropic(input.messages),
      tools: input.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
        // The arguments are dispatched straight into CRM writes, so they have
        // to validate against the schema rather than merely look like it.
        strict: true,
      })),
      ...(input.toolChoice === 'none' ? { tool_choice: { type: 'none' } } : {}),
      /*
       * A two-sentence reply to a text message is not where thinking earns its
       * cost, and this route is high volume. Low effort with adaptive thinking
       * left on is both cheaper and safer than turning thinking off, which on
       * this family can put a tool call into the visible text instead of into a
       * tool_use block.
       *
       * The summary is asked for so the audit trail has the agent's reasons in
       * its own words, the way DeepSeek's `reasoning_content` gives them. It is
       * a display setting: thinking happens and is billed the same either way,
       * but the default hides it and an empty reason is an empty audit trail.
       *
       * `input.reasoning === 'off'` is deliberately a no-op here. The voice
       * receptionist asks for it to keep a phone turn under a few seconds, and
       * on DeepSeek that is the right switch; on this family the same switch
       * would bring back the leaked tool call described above, spoken aloud to
       * a caller. Adaptive with low effort is already the fast setting, and
       * the timing script in the plan decides the model, not this flag.
       */
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'low' },
    };

    const json = (await postJson(url(creds), headers(creds), body, input.timeoutMs, input.signal)) as AnthropicResponse;
    if (json.stop_reason === 'refusal') {
      throw new AiCallFailed(
        `The model declined to answer (${json.stop_details?.category ?? 'no category given'}).`,
        200,
      );
    }
    return readResponse(json);
  },

  async check(creds): Promise<CheckResult> {
    const started = Date.now();
    const json = (await postJson(
      url(creds),
      headers(creds),
      {
        model: creds.model,
        max_tokens: 256,
        messages: [{ role: 'user', content: PROBE_PROMPT }],
        tools: [{ name: PROBE_TOOL.name, description: PROBE_TOOL.description, input_schema: PROBE_TOOL.parameters }],
      },
      20_000,
    )) as AnthropicResponse;
    const latencyMs = Date.now() - started;
    const result = readResponse(json);
    const call = result.toolCalls[0];
    return {
      model: json.model,
      answered: true,
      toolCallOk: Boolean(call && typeof call.input.city === 'string'),
      toolCallDetail: call
        ? `${call.name}(${JSON.stringify(call.input)})`
        : result.text
          ? `answered in words instead: "${result.text.slice(0, 120)}"`
          : 'returned nothing at all',
      latencyMs,
      usage: result.usage,
    };
  },
};
