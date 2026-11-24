import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../../../db';
import { schema } from '../../../db';
import { hoursOf, withinBusinessHours } from '../../ai/hours';
import { recordError } from '../../ops/errors';
import { relayUrl, voiceUrl } from '../../twilio/voice';
import { voiceForLanguage, type AiMode, type VoiceSettings } from '../settings';
import type { Call } from '../store';
import { connectRelay, twiml } from '../twiml';
import { voiceAiReadiness } from './readiness';
import { dbSessionStore } from './store';
import { mintRelayToken } from './token';

/**
 * Whether the assistant answers this call, and the TwiML that hands it over.
 *
 * The decision is a pure function of five facts so it can be tested as a
 * truth table with no database (`decideRelay`); `relayDecision` gathers the
 * facts. `relayOpening` is the one place that turns a "yes" into a
 * `<Connect>` — writing the `routed` flag, minting the token and emitting
 * the TwiML — and it is also the one place that refuses to re-open a call
 * whose session already ended for good.
 */

export type RelayVerdict = 'now' | 'after-ring' | 'no';

export interface RelayDecisionInput {
  mode: AiMode | 'off';
  /** `voiceAiReadiness().ok`. */
  ready: boolean;
  /** Outside the business's own hours, on the business clock (not the ringing clock). */
  aiClosed: boolean;
  forwardTo: string | null;
  /** `inbound` before any phone rang; `after-dial` once the human's line rang out. */
  stage: 'inbound' | 'after-dial';
}

export function decideRelay(i: RelayDecisionInput): RelayVerdict {
  if (i.mode === 'off' || !i.ready) return 'no';
  if (i.mode === 'always') return 'now';
  if (i.mode === 'after_hours') {
    /*
     * Inside hours with somebody to ring, the human is rung and a no-answer
     * goes to voicemail as it always did — the mode's whole promise is that
     * the assistant only ever speaks when the business is closed. The
     * `after-dial` stage therefore reads the clock alone: `afterDial` passes
     * no forwarding number, and "no number" must not be mistaken for "no
     * human", which is what it means before the phone has rung.
     */
    if (i.stage === 'after-dial') return i.aiClosed ? 'now' : 'no';
    return i.aiClosed || !i.forwardTo ? 'now' : 'no';
  }
  // overflow: the human first, then the assistant instead of voicemail.
  if (i.aiClosed || !i.forwardTo) return 'now';
  return i.stage === 'inbound' ? 'after-ring' : 'now';
}

export interface RelayDecisionContext {
  workspaceId: string;
  workspace: typeof schema.workspaces.$inferSelect;
  settings: VoiceSettings;
  forwardTo: string | null;
  stage: 'inbound' | 'after-dial';
  call: Call;
  nowMs?: number;
}

/**
 * The facts, then the verdict.
 *
 * Two clocks, on purpose: `ringingAllowedNow` (the dial decision) says "ring
 * anyway" for a workspace that chose to, and would never hand a 3 a.m. call
 * to the assistant. `after_hours` and `overflow` mean the business's own
 * hours, so that is the clock read here. Readiness is wrapped: a failing
 * query (the `voice_sessions` table missing on a database the migration has
 * not reached, a slow Neon wake-up that times out) must degrade to "no" —
 * the human rings, the voicemail answers, exactly as before the assistant
 * existed — and never to a 500 that Twilio turns into an error tone.
 */
export async function relayDecision(db: Db, ctx: RelayDecisionContext): Promise<RelayVerdict> {
  // A transfer or a resume must never re-enter through the inbound path.
  if (ctx.call.meta.routed === 'ai') return 'no';
  const mode: AiMode | 'off' = ctx.settings.ai.enabled ? ctx.settings.ai.mode : 'off';
  if (mode === 'off') return 'no';

  const nowMs = ctx.nowMs ?? Date.now();
  let ready = false;
  try {
    const readiness = await voiceAiReadiness(db, ctx.workspaceId, ctx.settings, { dialedNumber: ctx.call.toNumber, nowMs });
    ready = readiness.ok;
  } catch (error) {
    await recordError(db, { where: 'relay', error, workspaceId: ctx.workspaceId, path: '/api/twilio/voice' });
    return 'no';
  }
  const aiClosed = !withinBusinessHours(hoursOf(ctx.workspace.settings), ctx.workspace.timezone, nowMs);
  return decideRelay({ mode, ready, aiClosed, forwardTo: ctx.forwardTo, stage: ctx.stage });
}

/**
 * The first sentence the caller hears. The owner's own words when they
 * wrote some; otherwise a sentence that names the business, names the
 * assistant by its persona and says it is an AI — the disclosure US clients
 * expect and several states require. Always English: it is the primary
 * language, and the transcriber has not heard the caller yet. Used for the
 * TwiML and for the transcript, so the two cannot disagree.
 */
export async function relayGreeting(db: Db, workspaceId: string, settings: VoiceSettings): Promise<string> {
  const custom = settings.ai.greeting.trim();
  if (custom) return custom;
  const workspace = await db
    .select({ name: schema.workspaces.name })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1)
    .then((r) => r[0] ?? null);
  return greetingSentence(custom, workspace?.name, settings.ai.persona);
}

/**
 * The one place the greeting's words are decided. `relayGreeting` above
 * (the TwiML and the transcript) and `voiceTurnFor` in `src/lib/ai/voice.ts`
 * (the variable prompt on turn 1) both call this, so the sentence the model
 * is told it said and the sentence Twilio spoke cannot drift apart. Pure, so
 * the AI side can use it with rows it has already loaded.
 *
 * The third argument is the persona from Calls → Call settings
 * (`settings.ai.persona`), not the agent's name from Settings → AI: the
 * agent's name is what the text agent signs with, and a business may want
 * the phone answered under a different one, or under none.
 */
export function greetingSentence(custom: string, businessName: string | null | undefined, persona: string | null | undefined): string {
  const own = custom.trim();
  if (own) return own;
  const business = businessName?.trim() || 'the business';
  const name = persona?.trim();
  return name
    ? `Hi, thanks for calling ${business}. This is ${name}, the AI assistant. How can I help you today?`
    : `Hi, thanks for calling ${business}. I'm the AI assistant here. How can I help you today?`;
}

/** How many times a call may be re-connected before it is given up on. Eight is forty minutes at a 300 s deadline. */
export const MAX_ROTATIONS = 8;

export interface RelayOpeningOptions {
  workspaceId: string;
  /** The human's line rang out first; only the log wording differs. */
  afterRing?: boolean;
  /** A re-connection: no greeting, and the `resume` parameter counts up. */
  resume?: boolean;
  /** A note for the model on a resume ("the team did not pick up"), appended before the socket opens. */
  systemNote?: string;
  nowMs?: number;
}

/**
 * `<Connect><ConversationRelay>` for this call, or null when it cannot be
 * offered — no public address for the socket, or a session that already
 * ended for a reason other than a rotate or a transfer. The caller then gets
 * whatever the inbound path would have given them without the assistant.
 *
 * The `routed` flag is written with `meta || …`, never by spreading
 * `call.meta`: the row is being written by other hands at the same moment
 * (the status callback, the session's own `markAnswered`) and a spread would
 * carry a stale copy over theirs.
 */
export async function relayOpening(db: Db, call: Call, settings: VoiceSettings, opts: RelayOpeningOptions): Promise<Response | null> {
  if (!call.providerId) return null;
  const action = voiceUrl('relay-done', call.id);
  if (!action) return null;

  const store = dbSessionStore(db);
  const row = await store.byCall(opts.workspaceId, call.id);
  if (row) {
    if (row.rotateCount >= MAX_ROTATIONS) return null;
    if (row.status === 'ended' && row.endReason !== 'rotate' && row.endReason !== 'transfer') return null;
  }
  const resume = opts.resume ?? Boolean(row);

  if (opts.systemNote && row) {
    await store.append(opts.workspaceId, call.id, [{ role: 'system', text: opts.systemNote, ts: opts.nowMs ?? Date.now() }]);
  }

  const token = await mintRelayToken(call.id, call.providerId, opts.nowMs);
  const url = relayUrl(call.id, token);
  if (!url) return null;

  await db
    .update(schema.calls)
    .set({
      meta: sql`${schema.calls.meta} || ${JSON.stringify({ routed: 'ai', ...(opts.afterRing ? { aiAfterRing: true } : {}) })}::jsonb`,
    })
    .where(and(eq(schema.calls.id, call.id), eq(schema.calls.workspaceId, opts.workspaceId)));

  const greeting = resume ? undefined : await relayGreeting(db, opts.workspaceId, settings);
  /*
   * A resumed connection opens in the language the caller had switched to,
   * read from the row the session persisted it on: without it the fresh
   * `<Connect>` would default to English and the first sentence after "one
   * second, please" would come out in the wrong voice. `connectRelay` only
   * honours `multi` under ElevenLabs; under another provider the languages
   * are dropped there and the readiness card has already said why.
   */
  const languages = settings.ai.languages.map((code) => ({ code, voice: voiceForLanguage(settings.ai, code) })).filter((l) => l.voice);
  return twiml(
    connectRelay({
      url,
      action,
      welcomeGreeting: greeting,
      ttsProvider: settings.ai.ttsProvider,
      voice: settings.ai.voice || undefined,
      hints: settings.ai.hints || undefined,
      languages,
      multi: languages.length > 0,
      textNormalization: true,
      ttsLanguage: resume ? row?.state.lang || undefined : undefined,
      parameters: { call: call.id, ws: opts.workspaceId, resume: String(row ? row.rotateCount + 1 : 0) },
    }),
  );
}
