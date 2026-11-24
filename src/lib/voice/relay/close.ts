import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../../../db';
import { schema } from '../../../db';
import { threadMessage, type Ctx } from '../../core';
import { scopedTranslator } from '../../i18n/scope';
import { schedule } from '../../jobs';
import { recordError } from '../../ops/errors';
import { recordingCallbackUrl, voiceUrl } from '../../twilio/voice';
import { scheduleMissedCallText } from '../missed';
import { recordingNoticeText, type VoiceSettings } from '../settings';
import {
  applyCallStatus,
  callById,
  claimTimelineEntry,
  logCallActivity,
  markMissed,
  retitleCallActivity,
  type Call,
} from '../store';
import { dialAnnounced, hangup, say, twiml } from '../twiml';
import { whisperBrief } from './brief';
import { voiceAiReadiness } from './readiness';
import { relayOpening } from './route';
import { closeSessionRow, dbSessionStore, hadUserTurn, markSessionRotating } from './store';
import { primaryTag, type EndReason, type HandoffData, type SessionOutcome, type SessionRow, type Turn } from './types';

/**
 * What happens when the socket closes: the `<Connect action>` webhook.
 *
 * Twilio posts here once per session with `SessionStatus` — `ended` when we
 * sent `end`, `completed` when the caller hung up, `failed` when something
 * broke — and the `HandoffData` we put in our `end`. This is the only place
 * that decides what TwiML comes next, and it is a place with two hard rules.
 *
 * TwiML is always returned. A `<Connect>` action is not retried; a 5xx here
 * makes Twilio play an error tone and hang up on a person who may have just
 * asked to be transferred. So every database write is wrapped, and a failed
 * write costs a row, never the call.
 *
 * The rotate path does the least possible before answering — one update and
 * a token — because every millisecond here is silence on the line after
 * "One second, please."
 */

type Params = Record<string, string>;

export interface RelayFallbacks {
  /** The voicemail greeting and beep for this call, built by the caller because it owns the verbs. */
  voicemail: () => Response;
}

/** Twilio error codes that mean the server side dropped — what a deadline kill mid-turn looks like from Twilio's side. */
const RESUMABLE_CODES = new Set([64105, 64103]);

/** Beyond this many re-connections a call is given up on, whatever the reason. */
const MAX_ROTATIONS = 8;

export async function relayDone(db: Db, call: Call, params: Params, settings: VoiceSettings, fallbacks: RelayFallbacks): Promise<Response> {
  const workspaceId = call.workspaceId;
  const store = dbSessionStore(db);
  const sessionStatus = (params.SessionStatus ?? '').toLowerCase();
  const handoff = parseHandoff(params.HandoffData);
  const errorCode = Number(params.ErrorCode ?? '') || null;

  let row: SessionRow | null = null;
  try {
    row = await store.byCall(workspaceId, call.id);
  } catch (error) {
    await safeRecord(db, workspaceId, error);
  }

  /* ---- We ended it ourselves: the reason says what comes next. ---------- */
  if (sessionStatus === 'ended' && handoff) {
    switch (handoff.reason) {
      case 'rotate': {
        if (row && row.rotateCount < MAX_ROTATIONS) {
          const next = await tryResume(db, call, settings, workspaceId, {});
          if (next) return next;
        }
        // Too many rotations, or nothing to resume: the call ends politely.
        await closeCall(db, call, row, 'max-minutes', fallbacks, { silent: true });
        return twiml(say('Thanks for calling. Goodbye.', 'en'), hangup);
      }
      case 'transfer':
        return transfer(db, call, row, settings, handoff, fallbacks);
      case 'voicemail':
        await closeCall(db, call, row, 'voicemail', fallbacks, { silent: true });
        return fallbacks.voicemail();
      case 'failed':
        await closeCall(db, call, row, 'failed', fallbacks, { silent: true });
        return fallbacks.voicemail();
      default:
        // assistant-ended, idle, max-minutes, max-turns: the goodbye was already said.
        await closeCall(db, call, row, handoff.reason, fallbacks, {});
        return twiml(hangup);
    }
  }

  /* ---- The caller hung up. ------------------------------------------------ */
  if (sessionStatus === 'completed') {
    await closeCall(db, call, row, 'caller-hung-up', fallbacks, {});
    return twiml(hangup);
  }

  /* ---- Twilio reports a failure. ----------------------------------------- */
  await safeRecord(db, workspaceId, new Error(`ConversationRelay ${sessionStatus || 'failed'} ${errorCode ?? ''} ${params.ErrorMessage ?? ''}`.trim()));
  const resumable =
    errorCode !== null &&
    RESUMABLE_CODES.has(errorCode) &&
    row !== null &&
    (row.status === 'live' || row.status === 'rotating') &&
    row.rotateCount < MAX_ROTATIONS &&
    !row.state.lastFailure;
  if (resumable && row) {
    /*
     * The socket dropped from our side with the row still live: that is what
     * the function deadline looks like when a turn overran it, not a broken
     * call. One resume is allowed; a second consecutive failure is a failure.
     */
    const next = await tryResume(db, call, settings, workspaceId, { lastFailure: errorCode });
    if (next) return next;
  }
  await closeCall(db, call, row, 'failed', fallbacks, { silent: true, missedIfUnspoken: true });
  return fallbacks.voicemail();
}

/* ------------------------------------------------------------------------ */
/*  Resume                                                                   */
/* ------------------------------------------------------------------------ */

async function tryResume(
  db: Db,
  call: Call,
  settings: VoiceSettings,
  workspaceId: string,
  patch: { lastFailure?: number },
  systemNote?: string,
): Promise<Response | null> {
  try {
    await markSessionRotating(db, workspaceId, call.id, Object.keys(patch).length ? patch : undefined);
    const fresh = (await callById(db, call.id)) ?? call;
    return await relayOpening(db, fresh, settings, { workspaceId, resume: true, systemNote });
  } catch (error) {
    await safeRecord(db, workspaceId, error);
    return null;
  }
}

/* ------------------------------------------------------------------------ */
/*  Transfer to a person                                                     */
/* ------------------------------------------------------------------------ */

async function transfer(db: Db, call: Call, row: SessionRow | null, settings: VoiceSettings, handoff: HandoffData, fallbacks: RelayFallbacks): Promise<Response> {
  const to = handoff.to ?? '';
  const action = voiceUrl('after-transfer', call.id);
  if (!to || !action) {
    await closeCall(db, call, row, 'voicemail', fallbacks, { silent: true });
    return fallbacks.voicemail();
  }
  /*
   * What the caller said about themselves goes on the call row next to the
   * number dialled: the whisper step is fetched by Twilio for the child leg
   * and has the call row in hand, not the session, so one merge here saves
   * it a second query on the critical path. Written best-effort like the
   * rest — a briefing that did not make it is a colleague who asks "who is
   * this?", not a caller who does not get through.
   */
  const brief = whisperBrief(row?.state.caller);
  try {
    // The session stays resumable: a no-answer brings the caller back to the assistant.
    await markSessionRotating(db, call.workspaceId, call.id, { transferAttempts: Math.max(1, row?.state.transferAttempts ?? 0) });
    await db
      .update(schema.calls)
      .set({
        meta: sql`${schema.calls.meta} || ${JSON.stringify({ aiTransferredAt: new Date().toISOString(), aiTransferTo: to, via: 'ai', ...(brief ? { aiTransferBrief: brief } : {}) })}::jsonb`,
      })
      .where(and(eq(schema.calls.id, call.id), eq(schema.calls.workspaceId, call.workspaceId)));
  } catch (error) {
    await safeRecord(db, call.workspaceId, error);
  }
  /*
   * The session has just said "one moment, I'm connecting you" in the
   * caller's own language and in the ElevenLabs voice; this `<Say>` is
   * Polly reading English, and to a caller mid-Spanish it is a second voice
   * saying the same thing in the wrong language. It is kept for English
   * callers, where it covers the silence while the dial sets up, and
   * skipped for everyone else — the recording announcement, if any, is a
   * legal sentence and is read regardless.
   */
  const english = primaryTag(row?.state.lang) === '' || primaryTag(row?.state.lang) === 'en';
  return twiml(
    ...(english ? [say('Connecting you now.', 'en')] : []),
    ...dialAnnounced(to, {
      callerId: call.toNumber,
      timeout: settings.ringSeconds,
      action,
      record: settings.record,
      recordingStatusCallback: recordingCallbackUrl(call.id),
      whisperUrl: voiceUrl('whisper', call.id, { via: 'ai' }),
      timeLimit: settings.maxCallMinutes * 60,
      notice: recordingNoticeText(settings),
      lang: 'en',
    }),
  );
}

/**
 * The `<Dial>` the assistant placed has finished. Answered: the human leg is
 * the call, filed as a transfer. Not answered: the caller is still on the
 * line and never "missed" anything — they spoke to the assistant — so they
 * go back to it once, with a note that the team did not pick up, and to the
 * voicemail after that.
 */
export async function afterTransfer(db: Db, call: Call, params: Params, settings: VoiceSettings, fallbacks: RelayFallbacks): Promise<Response> {
  const workspaceId = call.workspaceId;
  const store = dbSessionStore(db);
  const dialStatus = (params.DialCallStatus ?? '').toLowerCase();
  const seconds = Number(params.DialCallDuration ?? '0') || 0;
  const answered = dialStatus === 'completed' || dialStatus === 'answered';
  let row: SessionRow | null = null;
  try {
    row = await store.byCall(workspaceId, call.id);
  } catch (error) {
    await safeRecord(db, workspaceId, error);
  }
  const to = typeof call.meta.aiTransferTo === 'string' ? call.meta.aiTransferTo : '';

  if (answered) {
    try {
      const outcome = await applyCallStatus(db, call, {
        status: 'completed',
        durationSec: seconds,
        raw: dialStatus,
        meta: { dialStatus, leg: 'forward', via: 'ai' },
      });
      await closeSessionRow(db, workspaceId, call.id, { reason: 'transfer', outcome: 'transferred' });
      await fileAiCall(db, outcome.call, row, 'transferred', { transferredTo: to });
    } catch (error) {
      await safeRecord(db, workspaceId, error);
    }
    return twiml(hangup);
  }

  // Nobody picked up. Back to the assistant once; it will offer to take a message.
  try {
    const attempts = row?.state.transferAttempts ?? 1;
    const readiness = await voiceAiReadiness(db, workspaceId, settings, { dialedNumber: call.toNumber });
    if (readiness.ok && row && attempts <= 1 && row.rotateCount < MAX_ROTATIONS) {
      const next = await tryResume(db, call, settings, workspaceId, {}, 'The team did not pick up the transfer; offer to take a message.');
      if (next) return next;
    }
  } catch (error) {
    await safeRecord(db, workspaceId, error);
  }
  await closeCall(db, call, row, 'transfer', fallbacks, { silent: true, outcome: 'transferred' });
  return fallbacks.voicemail();
}

/* ------------------------------------------------------------------------ */
/*  Closing the call                                                         */
/* ------------------------------------------------------------------------ */

/**
 * The call is over as far as the assistant is concerned. Marks the row
 * completed with the real conversation length (from `answeredAt`, not
 * Twilio's per-segment `SessionDuration`), closes the session, files the
 * timeline entry exactly once, puts the transcript in the inbox and books
 * the summary. `silent` means TwiML that still speaks follows (voicemail,
 * a goodbye) so the call row is not completed here — the status callback
 * does that when the line actually drops.
 */
async function closeCall(
  db: Db,
  call: Call,
  row: SessionRow | null,
  reason: EndReason,
  _fallbacks: RelayFallbacks,
  opts: { silent?: boolean; missedIfUnspoken?: boolean; outcome?: SessionOutcome },
): Promise<void> {
  const workspaceId = call.workspaceId;
  const spoke = hadUserTurn(row?.turns);
  const outcome: SessionOutcome = opts.outcome ?? row?.outcome ?? (reason === 'voicemail' ? 'voicemail' : spoke ? 'info' : 'nothing');
  try {
    await closeSessionRow(db, workspaceId, call.id, { reason, outcome });
  } catch (error) {
    await safeRecord(db, workspaceId, error);
  }

  let ended: Call = call;
  if (!opts.silent) {
    try {
      const fresh = (await callById(db, call.id)) ?? call;
      const durationSec = fresh.answeredAt ? Math.max(0, Math.round((Date.now() - fresh.answeredAt.getTime()) / 1000)) : 0;
      const result = await applyCallStatus(db, fresh, { status: 'completed', durationSec, raw: 'relay-done', meta: { leg: 'relay' } });
      ended = result.call;
    } catch (error) {
      await safeRecord(db, workspaceId, error);
    }
  }

  /*
   * Only a session that never got a word from the caller is a missed call.
   * Everything else was handled — by a machine, but handled — and neither
   * the missed flag nor the missed-call text applies. The missed one is
   * filed like every other missed inbound call — the ordinary timeline entry
   * and the text-back — because the status callback will not do it: it sees
   * a session row and leaves AI calls to this file.
   */
  if (opts.missedIfUnspoken && !spoke) {
    try {
      await markMissed(db, call.id);
      const fresh = (await callById(db, call.id)) ?? { ...call, missed: true };
      if (await claimTimelineEntry(db, call.id)) {
        await logCallActivity({ db, workspaceId, actorId: null }, fresh);
      }
      if (fresh.direction === 'in') await scheduleMissedCallText(db, workspaceId, call.id);
    } catch (error) {
      await safeRecord(db, workspaceId, error);
    }
    return;
  }
  if (!row) return;
  await fileAiCall(db, ended, row, outcome);
}

/**
 * The status callback's share of an AI-answered call. It is the one terminal
 * webhook Twilio retries, so it is the safety net for everything the
 * `<Connect action>` was supposed to do and may not have: a function killed
 * at its deadline mid-turn whose `relay-done` then timed out, a caller who
 * abandoned the call while the assistant's `<Dial>` was ringing (that
 * `action` never comes). A row left `live` in either case would keep
 * counting toward the daily minutes cap until midnight and the call would
 * have no timeline entry, no transcript and no summary.
 *
 * Returns false when the session failed before the caller said anything:
 * that call is a missed call, filed by `closeCall` in the ordinary words,
 * and the caller falls back to its ordinary path if that never ran.
 */
export async function settleAiCallFromStatus(db: Db, call: Call, row: SessionRow): Promise<boolean> {
  const workspaceId = call.workspaceId;
  const spoke = hadUserTurn(row.turns);
  if (row.endReason === 'failed' && !spoke) return false;
  const outcome: SessionOutcome = row.outcome ?? (spoke ? 'info' : 'nothing');
  // `rotate` and `transfer` name a continuation; the line dropped, so it never came.
  const open = row.status !== 'ended' || row.endReason === 'rotate' || row.endReason === 'transfer';
  if (open) {
    try {
      await closeSessionRow(db, workspaceId, call.id, { reason: 'caller-hung-up', outcome });
    } catch (error) {
      await safeRecord(db, workspaceId, error);
    }
  }
  await fileAiCall(db, call, row, outcome);
  return true;
}

/**
 * The timeline entry, the inbox transcript and the summary job — once, and
 * from whichever webhook gets here first. Two claims on the call row make it
 * so: `logged` (shared with the ordinary call paths) for the timeline, and
 * `aiFiled` for the inbox message and the summary, which have no natural
 * key of their own and would otherwise be filed twice when the action
 * webhook and the status callback both settle the same call.
 */
async function fileAiCall(db: Db, call: Call, row: SessionRow | null, outcome: SessionOutcome, opts: { transferredTo?: string } = {}): Promise<void> {
  const workspaceId = call.workspaceId;
  const spoke = hadUserTurn(row?.turns);
  try {
    const ctx: Ctx = { db, workspaceId, actorId: null };
    const who = call.direction === 'out' ? call.toNumber : call.fromNumber;
    if (await claimTimelineEntry(db, call.id)) {
      await logCallActivity(ctx, call, { ai: true, outcome, ...(opts.transferredTo ? { transferredTo: opts.transferredTo } : {}) });
    } else if (spoke || opts.transferredTo) {
      // `voice-status` filed it first, with the ordinary wording; the assistant's is truer.
      if (opts.transferredTo) {
        await retitleCallActivity(db, workspaceId, call.id, 'Call transferred by the assistant to {who} · {time}', { who: opts.transferredTo, time: mmss(call.durationSec) });
      } else {
        await retitleCallActivity(db, workspaceId, call.id, 'Assistant answered a call from {who} · {time}', {
          who: String(call.meta.callerName ?? '').trim() || who,
          time: mmss(call.durationSec),
        });
      }
    }
  } catch (error) {
    await safeRecord(db, workspaceId, error);
  }
  if (!row) return;
  try {
    if (await claimTimelineEntry(db, call.id, 'aiFiled')) {
      await fileAiCallInInbox(db, call, { ...row, outcome });
      await scheduleSummary(db, call);
    }
  } catch (error) {
    await safeRecord(db, workspaceId, error);
  }
}

/* ------------------------------------------------------------------------ */
/*  Inbox, summary                                                           */
/* ------------------------------------------------------------------------ */

/**
 * The transcript, in the shared inbox, where the rest of the conversation
 * with this person is. Same shape as the voicemail entry (`voice` channel,
 * inbound), so a lead who called and then texted reads as one thread.
 * Never wakes the SMS agent: the assistant already answered, and a text
 * replying to a phone call that just ended would be a second conversation
 * nobody asked for.
 */
export async function fileAiCallInInbox(db: Db, call: Call, session: SessionRow): Promise<void> {
  if (!call.contactId) return;
  const transcript = renderTranscript(session.turns);
  const ctx: Ctx = { db, workspaceId: call.workspaceId, actorId: null };
  const filed = await threadMessage(ctx, {
    contactId: call.contactId,
    channel: 'voice',
    direction: 'in',
    body: transcript || transcriptPlaceholder(),
    status: 'received',
    providerId: `relay:${session.id}`,
    meta: { callId: call.id, from: call.fromNumber, to: call.toNumber, ai: true, sessionId: session.id, outcome: session.outcome },
    authorId: null,
    unread: true,
  });
  await db
    .update(schema.calls)
    .set({ conversationId: filed.conversation.id, transcript: transcript || null, transcriptStatus: 'done' })
    .where(eq(schema.calls.id, call.id));
}

/** One line per exchange, the way a person would read it back. Callers spoke English; the labels are for the team. */
export function renderTranscript(turns: Turn[]): string {
  const t = scopedTranslator();
  const caller = t('Caller');
  const assistant = t('Assistant');
  return turns
    .filter((turn) => turn.role !== 'system' && turn.text.trim())
    .map((turn) => `${turn.role === 'user' ? caller : assistant}: ${turn.text.trim()}`)
    .join('\n')
    .slice(0, 20_000);
}

function transcriptPlaceholder(): string {
  return scopedTranslator()('The assistant answered; nothing was said.');
}

async function scheduleSummary(db: Db, call: Call): Promise<void> {
  await schedule(db, {
    workspaceId: call.workspaceId,
    kind: 'call.transcribe',
    payload: { op: 'summarize', callId: call.id },
    dedupeKey: `voice:summary:${call.id}`,
    maxAttempts: 3,
  });
}

/* ------------------------------------------------------------------------ */

function parseHandoff(raw: string | undefined): HandoffData | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<HandoffData>;
    if (!parsed || typeof parsed.reason !== 'string') return null;
    return { reason: parsed.reason, ...(parsed.to ? { to: String(parsed.to) } : {}), ...(parsed.why ? { why: String(parsed.why) } : {}) };
  } catch {
    return null;
  }
}

function mmss(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

async function safeRecord(db: Db, workspaceId: string, error: unknown): Promise<void> {
  console.error('[twilio/relay-done]', error instanceof Error ? error.message : error);
  await recordError(db, { where: 'relay', error, workspaceId, path: '/api/twilio/voice?step=relay-done' }).catch(() => undefined);
}
