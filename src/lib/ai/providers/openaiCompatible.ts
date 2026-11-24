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
 * The OpenAI chat-completions shape, over `fetch`, against whatever base URL
 * the key belongs to.
 *
 * One implementation covers every gateway that speaks it; today that is
 * DeepSeek, whose `deepseek-flash` is the agent's default because its tool
 * calling was measured and its replies cost about a tenth of Claude's. The
 * differences from Anthropic that matter here are all envelope: the
 * system prompt is a message rather than a field, a tool is wrapped in
 * `{type:'function', function:{...}}`, arguments arrive as a **JSON string**
 * rather than an object, and a tool result is a message with `role:'tool'`
 * instead of a block inside a user turn.
 */

interface OaiToolCall {
  id: string;
  type?: string;
  function: { name: string; arguments: string };
}

interface OaiMessage {
  role?: string;
  content: string | null;
  /** DeepSeek's reasoning models return their working in its own field. */
  reasoning_content?: string | null;
  tool_calls?: OaiToolCall[];
}

interface OaiResponse {
  model: string;
  choices: { message: OaiMessage; finish_reason: string | null }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    /** DeepSeek: these two add up to prompt_tokens. */
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}

/**
 * Gateways disagree about whether the version segment is part of the base URL
 * they hand out, so both forms are accepted and neither produces `/v1/v1/`.
 */
function url(creds: AiCreds): string {
  const base = trimBase(creds.baseUrl);
  if (!base) throw new AiCallFailed('No base URL set for this provider.', null);
  // A full endpoint is used as given; a base that already carries a version
  // segment — `/v1`, `/v4`, Gemini's `/v1beta/openai` — only needs the path.
  if (/\/chat\/completions$/.test(base)) return base;
  return /\/v\d+[a-z0-9]*(\/|$)/.test(new URL(base).pathname) ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
}

function headers(creds: AiCreds): Record<string, string> {
  return { authorization: `Bearer ${creds.apiKey}` };
}

function toolsFor(tools: { name: string; description: string; parameters: unknown }[]) {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

/**
 * Our messages, flattened into the chat-completions list.
 *
 * A tool result is its own message here, so one of our user turns carrying
 * several results becomes several messages — and they must follow the assistant
 * turn that asked for them, in order, or the gateway rejects the request.
 */
function toChat(systemText: string, messages: AiMessage[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [{ role: 'system', content: systemText }];
  for (const m of messages) {
    if (m.role === 'assistant') {
      // Echoed verbatim: the gateway matches its own tool_call ids.
      if (m.raw) out.push(m.raw as Record<string, unknown>);
      else out.push({ role: 'assistant', content: m.content.map((c) => (c.type === 'text' ? c.text : '')).join('') });
      continue;
    }
    const text = m.content.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text);
    for (const c of m.content) {
      if (c.type === 'tool_result') out.push({ role: 'tool', tool_call_id: c.toolUseId, content: c.text });
    }
    if (text.length) out.push({ role: 'user', content: text.join('\n') });
  }
  return out;
}

/**
 * `prompt_tokens` already includes whatever came out of the cache here, which
 * is the opposite of Anthropic's convention — normalising the difference is
 * half the reason this layer exists.
 */
function usageOf(raw: OaiResponse['usage']): AiUsage {
  return {
    inputTokens: raw?.prompt_tokens ?? 0,
    outputTokens: raw?.completion_tokens ?? 0,
    cachedInputTokens: raw?.prompt_cache_hit_tokens ?? raw?.prompt_tokens_details?.cached_tokens ?? 0,
    reasoningTokens: raw?.completion_tokens_details?.reasoning_tokens ?? 0,
  };
}

/**
 * Arguments arrive as a string of JSON the model wrote, so it is parsed rather
 * than trusted: a model that emits `{"city": }` must produce a tool call this
 * layer reports as malformed, not an exception three files away in the
 * dispatcher.
 */
function parseArguments(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function readResponse(json: OaiResponse): CompleteResult {
  const choice = json.choices?.[0];
  const message: OaiMessage = choice?.message ?? { content: null };
  const calls = message.tool_calls ?? [];
  /*
   * The working is stripped before the turn is stored for replay. DeepSeek
   * rejects its own `reasoning_content` coming back in the history, and even
   * where a provider tolerates it, replaying last turn's thoughts as though the
   * model had said them out loud is how an agent starts arguing with itself.
   */
  const { reasoning_content: reasoning, ...replayable } = message;
  return {
    text: (message.content ?? '').trim(),
    toolCalls: calls
      .map((c) => ({ id: c.id, name: c.function?.name ?? '', input: parseArguments(c.function?.arguments ?? '{}') }))
      .filter((c): c is { id: string; name: string; input: Record<string, unknown> } => Boolean(c.name && c.input)),
    usage: usageOf(json.usage),
    model: json.model,
    stopReason: choice?.finish_reason ?? 'stop',
    reasoning: (reasoning ?? '').trim(),
    raw: replayable,
  };
}

export const provider: AiProvider = {
  id: 'openai_compatible',

  async complete(creds, input: CompleteInput): Promise<CompleteResult> {
    // One system message, fixed part first: the gateways that cache do it on an
    // exact prefix, and the ones that do not are unaffected by the ordering.
    const systemText = `${input.systemFixed}\n\n${input.systemVariable}`;
    const body = {
      model: creds.model,
      max_tokens: input.maxTokens,
      messages: toChat(systemText, input.messages),
      tools: toolsFor(input.tools),
      tool_choice: input.toolChoice ?? 'auto',
      // DeepSeek's switch (probed 2026-09-13: `thinking: {type: 'disabled'}`
      // drops `reasoning_tokens` to none). Only sent to DeepSeek; another
      // gateway would refuse a field it does not know.
      ...(input.reasoning === 'off' && /deepseek/i.test(creds.baseUrl) ? { thinking: { type: 'disabled' } } : {}),
    };
    const json = (await postJson(url(creds), headers(creds), body, input.timeoutMs, input.signal)) as OaiResponse;
    if (!json.choices?.length) throw new AiCallFailed('The provider returned no choices.', 200);
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
        tools: toolsFor([PROBE_TOOL]),
        tool_choice: 'auto',
      },
      20_000,
    )) as OaiResponse;
    const latencyMs = Date.now() - started;
    const result = readResponse(json);
    const raw = json.choices?.[0]?.message?.tool_calls ?? [];
    const call = result.toolCalls[0];
    return {
      model: json.model || creds.model,
      answered: true,
      toolCallOk: Boolean(call && typeof call.input.city === 'string'),
      toolCallDetail: call
        ? `${call.name}(${JSON.stringify(call.input)})`
        : raw.length
          ? `returned a tool call this shape could not read: ${JSON.stringify(raw[0]).slice(0, 160)}`
          : result.text
            ? `answered in words instead: "${result.text.slice(0, 120)}"`
            : 'returned nothing at all',
      latencyMs,
      usage: result.usage,
    };
  },
};
