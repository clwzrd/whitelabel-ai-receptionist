import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../../db';
import { schema } from '../../db';
import { localeOf, workspaceLang, type Lang } from '../i18n';
import { scopedTranslator } from '../i18n/scope';
import { markError, markOk } from '../integrations';
import { greetingSentence } from '../voice/relay/route';
import { realCallerName } from '../voice/caller-name';
import { transferTarget } from '../voice/relay/transfer';
import { languageName, primaryTag, type Turn, type VoiceTurnBundle, type VoiceTurnCall, type VoiceTurnResult } from '../voice/relay/types';
import { switchableLanguages, type VoiceSettings } from '../voice/settings';
import type { Call } from '../voice/store';
import { enableBlockedReason, loadAgent, loadConnection, type Agent, type AiConnection } from './config';
import { VOICE_KIND, costUsd, priceFor } from './cost';
import type { ContactField } from './details';
import { businessFacts, type BusinessFacts } from './facts';
import { checkOutput } from './guard';
import { systemFixed, systemVariable, type PromptContext } from './prompt';
import { AiCallFailed, AiRefused, providerFor, type AiMessage, type AiProvider, type AiUsage } from './provider';
import { contactFields, converse, guardSources, record, type ConverseOutput, type Decision, type RecordInput } from './run';
import type { ToolCtx } from './tools';
import { DEFAULT_VOICE_ENV, voiceDispatch, voiceToolList, type VoiceToolEnv } from './voice-tools';

/**
 * The AI side of the voice receptionist: one bundle per call, one model
 * turn per thing the caller says.
 *
 * The relay engine (`src/lib/voice/relay/session.ts`) owns the socket, the
 * timers and the transcript; this file owns the model. The split is the
 * same as the text agent's: everything that can be looked up once is looked
 * up once, when the bundle is built (the workspace, the agent, the
 * connection, the contact, the fields, the facts, where a transfer goes),
 * and each turn is then a pure function of the transcript so far and the
 * state the tools left behind. A turn is a `converse()` with the phone tool
 * list and a budget, an output guard with one retry, and a row in `ai_runs`
 * stamped `kind: 'voice'` so the usage screen counts it as a call and the
 * text agent's message cap leaves it alone.
 *
 * The caller hears English until they speak something else: the engine
 * folds "[caller spoke in Spanish]" into their line, the model calls
 * `switch_language`, and from then on the reply and this file's own
 * fallback sentences are in that language while the voice on the wire is
 * changed by the engine (`action.kind === 'language'`). Everything the team
 * reads — the audit trail's reasons, and everything the tools write — stays
 * in English or goes through `t`, in the team's language, which the engine
 * puts in scope with `withLang(teamLang)` before calling the turn.
 */

const t = scopedTranslator();

const EMPTY_USAGE: AiUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 };

/** How long one model request may take on the phone. Longer than this is a caller listening to silence. */
const CALL_TIMEOUT_MS = 12_000;
/** Two sentences, spoken. Anything longer is cut off by the prompt, not the token ceiling. */
const CALL_MAX_TOKENS = 200;
/** Look-up, slots, consent, book, close: five, with one to spare. */
const MAX_ROUNDS = 6;
/** The engine will not start a model round with less than this of the budget left. */
const ROUND_FLOOR_MS = 8_000;
/** What a tool's name and result take up in the persisted turn, each. */
const TOOL_TRACE_CHARS = 400;

/**
 * Fixed sentences: the receptionist's fallbacks, said when the model could
 * not be. They follow the language the call is in, keyed by the primary
 * tag of `state.lang`, because a Spanish call that hits a model timeout and
 * hears "Sorry, I lost you for a second" in English has just been told the
 * receptionist was never really speaking Spanish. English for anything not
 * in the table; the engine's own sentences (filler, transfer, idle) have
 * their own table in `relay/session.ts`.
 */
type Fallback = 'sayAgain' | 'lostYou' | 'getSomeone' | 'optOutDone';
const FALLBACKS: Record<string, Record<Fallback, string>> = {
  en: {
    sayAgain: 'Sorry, could you say that again?',
    lostYou: 'Sorry, I lost you for a second. Could you say that again?',
    getSomeone: "Let me get someone from the team who can answer that properly.",
    optOutDone: "Done — you won't get any more messages from us.",
  },
  es: {
    sayAgain: 'Perdón, ¿podría repetirlo?',
    lostYou: 'Perdón, le perdí un segundo. ¿Podría repetirlo?',
    getSomeone: 'Déjeme pasarle con alguien del equipo que pueda responder eso bien.',
    optOutDone: 'Listo, no recibirá más mensajes nuestros.',
  },
  pt: {
    sayAgain: 'Desculpe, pode repetir?',
    lostYou: 'Desculpe, perdi você por um segundo. Pode repetir?',
    getSomeone: 'Vou chamar alguém da equipe para responder isso direito.',
    optOutDone: 'Pronto, você não vai receber mais mensagens nossas.',
  },
  fr: {
    sayAgain: 'Pardon, pouvez-vous répéter ?',
    lostYou: 'Pardon, je vous ai perdu une seconde. Pouvez-vous répéter ?',
    getSomeone: "Je vais demander à quelqu'un de l'équipe de vous répondre correctement.",
    optOutDone: "C'est fait, vous ne recevrez plus de messages de notre part.",
  },
  de: {
    sayAgain: 'Entschuldigung, könnten Sie das wiederholen?',
    lostYou: 'Entschuldigung, ich habe Sie kurz verloren. Könnten Sie das wiederholen?',
    getSomeone: 'Ich hole jemanden aus dem Team, der das richtig beantworten kann.',
    optOutDone: 'Erledigt, Sie erhalten keine weiteren Nachrichten von uns.',
  },
  it: {
    sayAgain: 'Scusi, può ripetere?',
    lostYou: "Scusi, l'ho persa un attimo. Può ripetere?",
    getSomeone: 'Faccio rispondere qualcuno del team, così le risponde come si deve.',
    optOutDone: 'Fatto, non riceverà più messaggi da parte nostra.',
  },
};

/** One of the fallbacks above in the language of the call (`lang` is BCP-47 or null for English). */
export function fallbackSentence(key: Fallback, lang: string | null | undefined): string {
  return (FALLBACKS[primaryTag(lang)] ?? FALLBACKS.en!)[key];
}

/** For the model, not the caller, so English. */
const RETRY_NUDGE = 'Say that again without any price or link.';

/* ------------------------------------------------------------------------ */
/*  The bundle                                                               */
/* ------------------------------------------------------------------------ */

/**
 * Twilio sends "anonymous", "restricted", "unknown", or the number that
 * spells ANONYMOUS on a keypad when the caller withheld theirs; `inbound()`
 * stores whatever arrived as `fromNumber`. Anything that is not a plain
 * E.164 number is treated as withheld: no texts, no lookups, no bookings
 * changed, and the shared "anonymous" contact's history is not attached.
 */
export function isWithheldCaller(fromNumber: string | null | undefined): boolean {
  const from = (fromNumber ?? '').trim();
  if (!/^\+[1-9]\d{6,14}$/.test(from)) return true;
  return from === '+266696687';
}

export async function voiceTurnFor(
  db: Db,
  call: Call,
  settings: VoiceSettings,
  opts: { nowMs?: number; dry?: boolean },
): Promise<VoiceTurnBundle> {
  const workspaceId = call.workspaceId;
  const [workspace] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)).limit(1);
  if (!workspace) throw new AiRefused('That call is not in a workspace that exists.');
  const teamLang: Lang = workspaceLang(workspace.settings);

  const [agent, connection, contactRow, transferTo] = await Promise.all([
    loadAgent(db, workspaceId),
    loadConnection(db, workspaceId),
    call.contactId
      ? db
          .select()
          .from(schema.contacts)
          .where(and(eq(schema.contacts.id, call.contactId), eq(schema.contacts.workspaceId, workspaceId)))
          .limit(1)
          .then((rows) => rows[0] ?? null)
      : Promise.resolve(null),
    transferTarget(db, workspaceId, settings, call.toNumber),
  ]);
  if (!agent) throw new AiRefused('No agent has been set up in this workspace.');
  if (!agent.enabled) throw new AiRefused('The agent is switched off.');
  if (!contactRow) throw new AiRefused('The call has no contact in this workspace.');
  const blocked = enableBlockedReason(connection);
  if (blocked) throw new AiRefused(blocked.key);

  const [facts, fields] = await Promise.all([businessFacts(db, workspace, agent), contactFields(db, workspaceId, agent.collectFields)]);
  const provider = await providerFor(connection.settings.provider);
  const callerWithheld = isWithheldCaller(call.fromNumber);
  const greeting = greetingSentence(settings.ai.greeting, workspace.name, settings.ai.persona);

  const session: VoiceSession = {
    db,
    workspace,
    agent,
    connection,
    provider,
    contact: contactRow,
    fields,
    facts,
    call,
    teamLang,
    transferTo,
    greeting,
    persona: settings.ai.persona,
    // Empty on Amazon or Google, where the TwiML declared no other language: no switch tool, English-only prompt.
    languages: switchableLanguages(settings.ai),
    maxTurns: settings.ai.maxTurns,
    callerWithheld,
    dry: opts.dry === true,
  };

  return {
    turn: (input) => runVoiceTurn(session, input),
    transferTo,
    greeting,
    maxTurns: settings.ai.maxTurns,
    maxMinutes: settings.ai.maxMinutes,
    teamLang,
    contactId: contactRow.id,
    callerWithheld,
  };
}

/* ------------------------------------------------------------------------ */
/*  The turn                                                                 */
/* ------------------------------------------------------------------------ */

/** Everything bound once per call. */
export interface VoiceSession {
  db: Db;
  workspace: typeof schema.workspaces.$inferSelect;
  agent: Agent;
  connection: AiConnection;
  provider: AiProvider;
  contact: typeof schema.contacts.$inferSelect;
  fields: ContactField[];
  facts: BusinessFacts;
  call: Pick<Call, 'id' | 'providerId' | 'fromNumber' | 'conversationId' | 'workspaceId'>;
  teamLang: Lang;
  transferTo: string | null;
  greeting: string;
  /** The name the assistant answers with (`settings.ai.persona`); empty means it is just "the AI assistant". */
  persona: string;
  /** The BCP-47 codes other than English the call may be switched to: `switchableLanguages(settings.ai)`, so empty unless the voice is ElevenLabs. */
  languages: string[];
  maxTurns: number;
  callerWithheld: boolean;
  dry: boolean;
  /**
   * The seams a unit test replaces: the tools' writes and the audit row.
   * Production leaves both unset and gets the real functions.
   */
  env?: VoiceToolEnv;
  recordRun?: (input: RecordInput) => Promise<string>;
  /** The one `ToolCtx` of the session, created on the first turn; `saveDetails` mutates `ctx.contact`, and a later turn must see it. */
  toolCtx?: ToolCtx;
}

export async function runVoiceTurn(session: VoiceSession, input: VoiceTurnCall): Promise<VoiceTurnResult> {
  const { db, workspace, agent, connection, provider, contact, facts, call } = session;
  const workspaceId = session.call.workspaceId;
  const nowMs = input.nowMs;
  const state = input.state;
  const writeRun = session.recordRun ?? record;
  const env = session.env ?? DEFAULT_VOICE_ENV;

  /*
   * One `ToolCtx` for the whole call. The tools write into `ctx.contact` (a
   * name learned on turn two is what `book_appointment` uses on turn five)
   * and into the session state the engine hands back each turn; the clock
   * and the state are the two things refreshed per turn.
   */
  const toolCtx: ToolCtx =
    session.toolCtx ??
    (session.toolCtx = {
      db,
      workspaceId,
      workspace,
      agent,
      contact,
      fields: session.fields,
      lang: 'en',
      nowMs,
      channel: 'voice',
      dry: session.dry,
      voice: {
        state,
        transferTo: session.transferTo,
        callerWithheld: session.callerWithheld,
        bookingUrl: facts.bookingUrl,
        languages: session.languages,
        langSwitch: null,
      },
    });
  toolCtx.nowMs = nowMs;
  toolCtx.voice!.state = state;
  toolCtx.voice!.turn = input.turn;
  // A switch is a per-turn note; one left over from the last turn would be reported to the engine twice.
  toolCtx.voice!.langSwitch = null;

  const canBook = agent.canBook && Boolean(agent.bookingCalendarId);
  const history = voiceHistory(input.history);
  const promptCtx: PromptContext = {
    agent,
    fields: session.fields,
    businessName: workspace.name,
    contactName: session.callerWithheld ? '' : knownName(toolCtx.contact),
    channel: 'voice',
    nowLabel: new Intl.DateTimeFormat(localeOf('en'), { timeZone: workspace.timezone, dateStyle: 'full', timeStyle: 'short' }).format(new Date(nowMs)),
    timezone: workspace.timezone,
    facts,
    locale: localeOf('en'),
    nowMs,
    turn: input.turn - 1,
    maxTurns: session.maxTurns,
    canBook,
    voice: {
      persona: session.persona,
      languages: session.languages.map((code) => ({ code, label: languageName(code) })),
      lang: state.lang ? { code: state.lang, label: languageName(state.lang) } : null,
      callerNumber: session.callerWithheld ? null : call.fromNumber,
      offered: state.offered ?? [],
      textConsent: state.textConsentDeclined ? 'declined' : toolCtx.contact.consent?.sms === true && !toolCtx.contact.dnc ? 'on-file' : 'none',
      transferReturned: state.transferAttempts >= 1,
      transferPossible: Boolean(session.transferTo) && state.transferAttempts < 1,
      companyOnFile: !session.callerWithheld && Boolean((toolCtx.contact.company ?? '').trim()),
      greeting: session.greeting,
    },
  };
  const tools = voiceToolList(agent, canBook, session.fields, {
    callerWithheld: session.callerWithheld,
    transferAttempts: state.transferAttempts,
    transferTo: session.transferTo,
    languages: session.languages,
  });
  const dispatchFn = (ctx: ToolCtx, name: string, args: Record<string, unknown>) => voiceDispatch(ctx, name, args, env);

  const base = {
    db,
    workspaceId,
    agentId: agent.id,
    contactId: contact.id,
    conversationId: call.conversationId ?? null,
    messageId: null,
  };
  const fixed = systemFixed(promptCtx);
  const variable = systemVariable(promptCtx);
  const transcriptChars = input.history.reduce((n, turn) => n + turn.text.length, 0);
  /** The `prompt` column, without anything that is only known after the model answered. */
  const promptOf = (out: ConverseOutput | null, spend: number) => ({
    kind: VOICE_KIND,
    callId: call.id,
    callSid: call.providerId,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    turn: input.turn,
    channel: 'voice',
    // The fixed half is several kilobytes and identical on every turn of the
    // call; it is written once, on the first turn, and fingerprinted after.
    system: { fixed: input.turn === 1 ? fixed : { sha256: sha256(fixed), length: fixed.length }, variable },
    reasoning: out?.reasoning ?? [],
    cache: { readTokens: out?.usage.cachedInputTokens ?? 0, freshTokens: Math.max(0, (out?.usage.inputTokens ?? 0) - (out?.usage.cachedInputTokens ?? 0)) },
    reasoningTokens: out?.usage.reasoningTokens ?? 0,
    // Metered by `usage.ts` from `prompt->>'costUsd'`; `cost_cents` rounds a phone turn to zero.
    costUsd: spend,
    transcriptChars,
  });

  const converseArgs = {
    provider,
    connection,
    agent,
    toolCtx,
    promptCtx,
    canBook,
    tools,
    dispatch: dispatchFn,
    call: { timeoutMs: CALL_TIMEOUT_MS, reasoning: 'off' as const, maxTokens: CALL_MAX_TOKENS },
    maxRounds: MAX_ROUNDS,
    closeWithText: true,
    onRound: input.onRound,
    budgetMs: input.budgetMs,
    roundFloorMs: ROUND_FLOOR_MS,
  };

  /*
   * The language the reply will be spoken in: what `switch_language` asked
   * for on this turn, else what the call was already in. The fallback
   * sentences below are picked from it, and it is what the engine is told
   * to move the voice to — as an action when nothing else took the slot,
   * and always as `result.language`, so a switch made on the same turn as
   * a transfer, an end or a voicemail is not lost: the engine moves the
   * voice before it speaks the farewell.
   */
  const spokenLang = () => toolCtx.voice!.langSwitch ?? state.lang ?? null;
  const say = (key: Fallback) => fallbackSentence(key, spokenLang());
  const langAction = (): VoiceTurnResult['action'] => (toolCtx.voice!.langSwitch ? { kind: 'language', code: toolCtx.voice!.langSwitch } : null);

  /*
   * `tools` is what the engine persists on the assistant turn (`Turn.tools`,
   * name and result cut to 400 characters each) so the next turn's history
   * carries the slots that were read out; the state's `offered` list carries
   * them for the prompt as well.
   */
  const finish = (reply: string, action: VoiceTurnResult['action'], runId: string | null, out: ConverseOutput | null, spend: number): VoiceTurnResult => {
    const result: VoiceTurnResult = {
      reply,
      action,
      language: toolCtx.voice!.langSwitch ?? null,
      state,
      runId,
      booked: out?.booked ?? null,
      usage: out?.usage ?? EMPTY_USAGE,
      costUsd: spend,
      model: out?.model ?? '',
      latencyMs: out?.latencyMs ?? 0,
      tools: out ? toolTrace(out) : [],
    };
    return result;
  };

  /* -- the model ---------------------------------------------------------- */

  let out: ConverseOutput;
  try {
    out = await converse({ ...converseArgs, history });
  } catch (error) {
    const message = error instanceof AiRefused || error instanceof AiCallFailed ? error.message : String((error as Error)?.message ?? error);
    console.error('[ai/voice]', error);
    await markError(db, workspaceId, 'anthropic', message).catch(() => {});
    const reason = t('The model could not be reached: {message}', { message });
    const runId = await safeRecord(writeRun, { ...base, decision: 'failed', reason, error: message, prompt: promptOf(null, 0) });
    // The call goes on: an apology and another try beats a dead line.
    return finish(say('lostYou'), null, runId, null, 0);
  }
  if (connection.lastError) await markOk(db, workspaceId, 'anthropic').catch(() => {});

  let spend = costUsd(out.usage, priceFor(out.model, connection.settings));
  const shared = () => ({
    ...base,
    prompt: promptOf(out, spend),
    toolCalls: out.toolCalls,
    model: out.model,
    usage: out.usage,
    costUsd: spend,
    latencyMs: out.latencyMs,
  });

  /* -- what the tools decided --------------------------------------------- */

  /*
   * A caller who asked to stop is answered with the confirmation and the
   * call ends; the text agent's `optOutConfirmation` SMS never fires,
   * because the confirmation is being spoken to them right now.
   */
  if (out.optOut) {
    const reply = out.text || say('optOutDone');
    const reason = out.handoff ?? t('They asked to stop being messaged, and were marked do-not-contact.');
    const runId = await safeRecord(writeRun, { ...shared(), decision: 'handoff', reason, output: reply });
    return finish(reply, { kind: 'end' }, runId, out, spend);
  }

  if (out.action) {
    const reason =
      out.action.kind === 'transfer'
        ? (out.handoff ?? t('The caller asked for a person.'))
        : out.action.kind === 'voicemail'
          ? t('The caller chose to leave a voicemail.')
          : t('The assistant ended the call.');
    const decision: Decision = out.action.kind === 'transfer' ? 'handoff' : out.booked ? 'booked' : 'reply';
    const runId = await safeRecord(writeRun, { ...shared(), decision, reason, output: out.text || null });
    return finish(out.text, out.action, runId, out, spend);
  }

  // A `hand_over` that slipped past the dispatcher's alias, or another tool that asked for a person.
  if (out.handoff) {
    const canTransfer = Boolean(session.transferTo) && state.transferAttempts < 1;
    const runId = await safeRecord(writeRun, { ...shared(), decision: 'handoff', reason: out.handoff, output: out.text || null });
    return finish(out.text || say('getSomeone'), canTransfer ? { kind: 'transfer', to: session.transferTo! } : langAction(), runId, out, spend);
  }

  if (!out.text) {
    const reason = t('The model stopped without writing anything ({stop}), so nothing was sent.', { stop: out.stopReason });
    const runId = await safeRecord(writeRun, { ...shared(), decision: 'failed', reason, error: out.stopReason });
    return finish(say('sayAgain'), langAction(), runId, out, spend);
  }

  /* -- the last look before speaking ------------------------------------- */

  let sources = guardSources(agent, workspace.name, facts, out.toolCalls, history);
  let guard = checkOutput(out.text, sources);
  let reply = out.text;
  if (!guard.ok) {
    /*
     * One retry, with tools forbidden and the refused sentence in view: a
     * price or a link the model made up is usually a sentence it can say
     * without. On the phone the alternative — a person — is a transfer when
     * one is possible and a message when not; never silence.
     */
    try {
      const again = await converse({
        ...converseArgs,
        history: [...history, { role: 'assistant', content: [{ type: 'text', text: out.text }] }, { role: 'user', content: [{ type: 'text', text: RETRY_NUDGE }] }],
        tools,
        maxRounds: 1,
        closeWithText: false,
        call: { ...converseArgs.call, toolChoice: 'none' },
        budgetMs: input.budgetMs === undefined ? undefined : Math.max(0, input.budgetMs - out.latencyMs),
      });
      out = { ...out, text: again.text, usage: addUsage(out.usage, again.usage), model: again.model || out.model, latencyMs: out.latencyMs + again.latencyMs, reasoning: [...out.reasoning, ...again.reasoning], rounds: out.rounds + again.rounds };
      spend = costUsd(out.usage, priceFor(out.model, connection.settings));
      sources = guardSources(agent, workspace.name, facts, out.toolCalls, history);
      guard = out.text ? checkOutput(out.text, sources) : { ok: false, reason: 'empty retry' };
      reply = out.text;
    } catch (error) {
      console.error('[ai/voice] retry failed', error);
      guard = { ok: false, reason: guard.reason };
    }
  }
  if (!guard.ok) {
    const reason = t('The agent wrote something it could not back up, so a person was put on it: {why}', { why: guard.reason ?? 'unverifiable claim' });
    const canTransfer = Boolean(session.transferTo) && state.transferAttempts < 1;
    const runId = await safeRecord(writeRun, { ...shared(), decision: 'handoff', reason, output: out.text || null });
    return finish(say('getSomeone'), canTransfer ? { kind: 'transfer', to: session.transferTo! } : langAction(), runId, out, spend);
  }

  const reason = out.booked ? t('Booked an appointment and told them.') : t('Answered the message.');
  const runId = await safeRecord(writeRun, { ...shared(), decision: out.booked ? 'booked' : 'reply', reason, output: reply });
  return finish(reply, langAction(), runId, out, spend);
}

/* ------------------------------------------------------------------------ */
/*  The transcript as the model sees it                                       */
/* ------------------------------------------------------------------------ */

/**
 * `voice_sessions.turns` → `AiMessage[]`.
 *
 * Four rules, each there because of something a caller does. A `system`
 * turn (the engine's note: "the team did not pick up") is folded into the
 * next thing the caller says as `[note: …]`, because both providers want
 * alternating user/assistant and a note is context, not a line. The tools an
 * assistant turn ran are folded into the following user message as `[tool
 * results: …]`, which is what lets "the nine-thirty one" resolve without a
 * second `list_free_slots`. Two turns in a row from the same side are one
 * message, as in the text agent. And the leading greeting is dropped: the
 * first message must be the caller's, and the greeting is in the variable
 * prompt anyway.
 */
export function voiceHistory(turns: Turn[]): AiMessage[] {
  const out: AiMessage[] = [];
  let pending: string[] = [];

  const push = (role: 'user' | 'assistant', text: string) => {
    const last = out[out.length - 1];
    if (last?.role === role && last.content[0]?.type === 'text') {
      (last.content[0] as { text: string }).text += `\n${text}`;
    } else {
      out.push({ role, content: [{ type: 'text', text }] });
    }
  };

  for (const turn of turns) {
    if (turn.role === 'system') {
      if (turn.text.trim()) pending.push(`[note: ${turn.text.trim()}]`);
      continue;
    }
    if (turn.role === 'assistant') {
      // Nothing from the assistant before the caller has spoken: the greeting is not a reply.
      if (out.length) {
        const text = turn.text.trim();
        if (text) push('assistant', turn.interrupted ? `${text} [cut off by the caller]` : text);
      }
      if (turn.tools?.length) {
        pending.push(`[tool results: ${turn.tools.map((tool) => `${tool.name}: ${tool.result}`).join(' | ')}]`);
      }
      continue;
    }
    const spoken = turn.text.trim() || (turn.dtmf ? `[pressed ${turn.dtmf}]` : '');
    const text = [...pending, spoken].filter(Boolean).join('\n');
    pending = [];
    if (text) push('user', text);
  }
  /*
   * Notes with nothing said after them — a transfer came back unanswered and
   * the assistant has to speak first — become the caller's turn, so the
   * model has something to answer and the roles still alternate.
   */
  if (pending.length) push('user', pending.join('\n'));
  return out;
}

/* ------------------------------------------------------------------------ */
/*  Helpers                                                                  */
/* ------------------------------------------------------------------------ */

/** The name on file for the greeting line, or empty when there is none worth saying. */
function knownName(contact: { firstName?: string | null; lastName?: string | null }): string {
  // A caller-ID label seeded as a name ("WIRELESS CALLER") is not a name the assistant should use or skip the question for.
  return realCallerName([contact.firstName, contact.lastName].filter(Boolean).join(' '));
}

/** What the assistant looked at this turn, small enough to live in the transcript row. */
export function toolTrace(out: Pick<ConverseOutput, 'toolCalls'>): { name: string; result: string }[] {
  return out.toolCalls.map((c) => ({ name: c.name.slice(0, TOOL_TRACE_CHARS), result: String(c.result ?? '').slice(0, TOOL_TRACE_CHARS) }));
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function addUsage(a: AiUsage, b: AiUsage): AiUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
  };
}

/**
 * The audit row must never take the call down with it: a database hiccup
 * while writing `ai_runs` is logged, and the caller still hears the reply.
 */
async function safeRecord(write: (input: RecordInput) => Promise<string>, input: RecordInput): Promise<string | null> {
  try {
    return await write(input);
  } catch (error) {
    console.error('[ai/voice] ai_runs write failed', error);
    return null;
  }
}
