import { providerFor, type AiContent, type AiCreds, type AiMessage, type AiProvider, type AiUsage } from './ai/provider';
import type { BusinessFacts, Caller, CrmPort } from './crm/port';
import { languageName, type SessionState, type Turn, type VoiceTurnCall, type VoiceTurnFn, type VoiceTurnResult } from './engine/types';
import { PRIMARY_LANGUAGE, runTool, toolDefs, type ToolContext } from './tools';

/**
 * One turn of the conversation: what the caller just said goes in, what the
 * assistant says (and does) comes out.
 *
 * The session engine owns the timing; this file owns the thinking. It builds
 * the prompt, lets the model call tools against the CRM port for a few
 * rounds, and returns the reply together with anything the engine must act
 * on: a transfer, the end of the call, a change of language, a booking made.
 *
 * The model is whichever one the operator configured. Nothing here knows a
 * vendor: `ai/provider.ts` speaks Anthropic's Messages API and the OpenAI
 * chat-completions shape, and everything else is an address and a key.
 */

export interface TurnOptions {
  crm: CrmPort;
  creds: AiCreds;
  /** The caller ID, or null when it was withheld. */
  phone: string | null;
  persona: string;
  transferTo: string | null;
  /** Languages the call may be moved to, besides English. */
  languages: readonly string[];
  /** US dollars per million tokens, for the cost the engine totals. Zero when unknown. */
  priceIn?: number;
  priceOut?: number;
  /** For tests: a scripted provider instead of a real one. */
  provider?: AiProvider;
}

/** Tool rounds per turn. A caller is waiting in silence while they run, so this is small on purpose. */
const MAX_ROUNDS = 4;
/** A spoken reply is short; a long one is a monologue nobody asked for. */
const MAX_TOKENS = 500;
const ROUND_TIMEOUT_MS = 12_000;

export function createTurn(options: TurnOptions): VoiceTurnFn {
  let facts: BusinessFacts | null = null;
  let caller: Caller | null = null;
  let lookedUp = false;

  return async (input: VoiceTurnCall): Promise<VoiceTurnResult> => {
    const started = Date.now();
    const provider = options.provider ?? (await providerFor(options.creds.provider));
    facts ??= await options.crm.business();
    const state: SessionState = { ...input.state };

    // Who is calling, read once from the caller ID. A hidden number is never looked up.
    if (!lookedUp && options.phone) {
      lookedUp = true;
      caller = await options.crm.findCallerByPhone(options.phone).catch(() => null);
      if (caller) state.lookedUp = caller.id;
    }

    const ctx: ToolContext = { crm: options.crm, facts, state, caller, phone: options.phone, transferTo: options.transferTo, languages: options.languages, nowMs: input.nowMs };
    const tools = toolDefs(ctx);
    const messages = voiceHistory(input.history);
    const usage: AiUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 };
    const trace: { name: string; result: string }[] = [];
    let reply = '';
    let model = options.creds.model;
    let action: VoiceTurnResult['action'] = null;
    let language: string | null = null;
    let booked: VoiceTurnResult['booked'] = null;
    const deadline = started + Math.max(2_000, input.budgetMs);

    for (let round = 1; round <= MAX_ROUNDS + 1; round += 1) {
      const lastRound = round > MAX_ROUNDS;
      const out = await provider.complete(options.creds, {
        systemFixed: systemFixed(facts, options),
        systemVariable: systemVariable(facts, ctx, state),
        messages,
        tools,
        // Out of rounds: the tools stay in the request, but the answer has to be words.
        toolChoice: lastRound ? 'none' : 'auto',
        maxTokens: MAX_TOKENS,
        timeoutMs: Math.max(1_000, Math.min(ROUND_TIMEOUT_MS, deadline - Date.now())),
      });
      usage.inputTokens += out.usage.inputTokens;
      usage.outputTokens += out.usage.outputTokens;
      usage.cachedInputTokens += out.usage.cachedInputTokens;
      usage.reasoningTokens += out.usage.reasoningTokens;
      model = out.model || model;
      if (!out.toolCalls.length || lastRound) {
        reply = out.text.trim();
        break;
      }

      const said: AiContent[] = [...(out.text.trim() ? [{ type: 'text' as const, text: out.text.trim() }] : []), ...out.toolCalls.map((c) => ({ type: 'tool_use' as const, id: c.id, name: c.name, input: c.input }))];
      messages.push({ role: 'assistant', content: said, raw: out.raw });
      const results: AiContent[] = [];
      let stop = false;
      for (const call of out.toolCalls) {
        let text: string;
        let isError = false;
        try {
          const outcome = await runTool(ctx, call.name, call.input);
          text = outcome.text;
          if (outcome.booked) booked = outcome.booked;
          if (outcome.action?.kind === 'language') language = outcome.action.code;
          else if (outcome.action) {
            action = outcome.action;
            stop = true;
          }
        } catch (error) {
          // The CRM could not do it. The model is told, so the caller hears an honest sentence instead of silence.
          isError = true;
          text = `That did not work (${error instanceof Error ? error.message : 'unknown error'}). Tell the caller you could not do it and offer to take a message.`;
        }
        trace.push({ name: call.name, result: text });
        results.push({ type: 'tool_result', toolUseId: call.id, text, isError });
      }
      caller = ctx.caller;
      messages.push({ role: 'user', content: results });
      // A transfer or the end of the call is spoken by the engine as a fixed sentence; the model has nothing left to say.
      if (stop) break;
      input.onRound?.(round);
    }

    if (!action && language) action = { kind: 'language', code: language };
    return {
      reply,
      action,
      language,
      state,
      runId: null,
      booked,
      usage,
      costUsd: (usage.inputTokens * (options.priceIn ?? 0) + usage.outputTokens * (options.priceOut ?? 0)) / 1_000_000,
      model,
      latencyMs: Date.now() - started,
      tools: trace,
    };
  };
}

/* ------------------------------------------------------------------------ */
/*  The prompt                                                               */
/* ------------------------------------------------------------------------ */

/** Identical on every turn of every call for this business, so a provider's prompt cache can hold it. */
function systemFixed(facts: BusinessFacts, options: Pick<TurnOptions, 'persona' | 'languages' | 'transferTo'>): string {
  const who = options.persona.trim() ? `${options.persona.trim()}, the AI assistant` : 'the AI assistant';
  return [
    `You are ${who} answering the phone for ${facts.name}. You are speaking, not writing: the caller hears every word through text-to-speech.`,
    '',
    'How to speak:',
    '- One or two short sentences per turn. One question at a time. No lists, no markdown, no emoji, no URLs read aloud.',
    '- Say numbers and times the way a person would. Spell an e-mail address back before saving it.',
    '- If asked, say plainly that you are an AI assistant. Never claim to be a person.',
    '- If you did not catch something, ask once more, briefly.',
    '',
    'What you may do, only through tools:',
    `- Book, move or cancel ${facts.appointmentName}. Offer only times that list_open_times returned on this call, and book with the exact bracketed value.`,
    '- Before booking you need the caller\'s name. Ask for an e-mail too, so the confirmation can reach them.',
    '- Take a message for the team when the caller wants a person, a call back, or anything you cannot do.',
    options.transferTo ? '- Transfer to a person only when the caller asks for one or the matter is urgent.' : '- Nobody can take a transfer right now: when the caller asks for a person, take a message.',
    '- End the call once the caller has nothing else.',
    '',
    'What you must not do:',
    '- Never invent a price, a time, an address, a policy or a promise. If it is not in the facts below or in a tool result, say you do not have that and offer to take a message.',
    '- Never say something was booked, moved, canceled or saved unless the tool result says so.',
    '- Never read out or repeat a tool result word for word; say it naturally.',
    '',
    options.languages.length
      ? `Language: the call starts in English. If the caller speaks one of ${options.languages.map(languageName).join(', ')}, call switch_language and continue in it. A note like "[caller spoke in Spanish]" tells you what was heard.`
      : 'Language: this line is English-only. If the caller speaks another language, say so kindly in English and offer to take a message.',
    '',
    `Facts about ${facts.name}:`,
    `- Hours: ${facts.hours || 'not on file; do not guess'}.`,
    `- ${facts.appointmentName} lasts ${facts.appointmentMinutes} minutes.`,
    facts.knowledge.trim() || '- Nothing else is on file.',
  ].join('\n');
}

/** What changes per turn: the clock, who is on the line, what has happened so far. */
function systemVariable(facts: BusinessFacts, ctx: ToolContext, state: SessionState): string {
  const now = new Intl.DateTimeFormat('en-US', { timeZone: facts.timezone, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(ctx.nowMs));
  const who = ctx.caller
    ? `On file for this number: ${ctx.caller.name ?? 'no name'}${ctx.caller.company ? `, ${ctx.caller.company}` : ''}${ctx.caller.email ? `, ${ctx.caller.email}` : ', no e-mail'}.`
    : ctx.phone
      ? 'Nobody is on file for this number yet.'
      : 'The caller ID is withheld: ask for a name, and do not offer to text or look anything up.';
  return [
    `Now: ${now} (${facts.timezone}).`,
    who,
    `The call is in ${languageName(state.lang ?? PRIMARY_LANGUAGE)}.`,
    state.transferAttempts ? `A transfer was already tried ${state.transferAttempts} time(s) and nobody picked up: take a message instead.` : '',
  ].filter(Boolean).join('\n');
}

/* ------------------------------------------------------------------------ */
/*  The transcript, as the model reads it                                     */
/* ------------------------------------------------------------------------ */

/**
 * The engine's transcript as alternating user and assistant messages.
 *
 * The greeting is not a reply, so nothing from the assistant is sent before
 * the caller has spoken. System notes ("[caller spoke in Spanish]") and what
 * tools returned on earlier turns travel with the caller's next words, so
 * the roles always alternate and the model still sees them.
 */
export function voiceHistory(turns: Turn[]): AiMessage[] {
  const out: AiMessage[] = [];
  let pending: string[] = [];
  const push = (role: 'user' | 'assistant', text: string) => {
    const last = out[out.length - 1];
    if (last?.role === role && last.content[0]?.type === 'text') (last.content[0] as { text: string }).text += `\n${text}`;
    else out.push({ role, content: [{ type: 'text', text }] });
  };
  for (const turn of turns) {
    if (turn.role === 'system') {
      if (turn.text.trim()) pending.push(`[note: ${turn.text.trim()}]`);
      continue;
    }
    if (turn.role === 'assistant') {
      if (out.length) {
        const text = turn.text.trim();
        if (text) push('assistant', turn.interrupted ? `${text} [cut off by the caller]` : text);
      }
      if (turn.tools?.length) pending.push(`[tool results: ${turn.tools.map((tool) => `${tool.name}: ${tool.result}`).join(' | ')}]`);
      continue;
    }
    const spoken = turn.text.trim() || (turn.dtmf ? `[pressed ${turn.dtmf}]` : '');
    const text = [...pending, spoken].filter(Boolean).join('\n');
    pending = [];
    if (text) push('user', text);
  }
  // Notes with nothing said after them become the caller's turn, so the model has something to answer.
  if (pending.length) push('user', pending.join('\n'));
  return out;
}
