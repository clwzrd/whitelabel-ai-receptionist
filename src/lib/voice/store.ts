import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../../db';
import { schema } from '../../db';
import type { CallStatus } from '../../db/schema';
import { addActivity, recordEvent, setActivityBody, setMessageBody, type Ctx } from '../core';
import { hasEnded, isLate } from './outcome';

/**
 * The `calls` row, and the one rule that keeps it honest.
 *
 * Twilio does not promise its callbacks arrive in order, and it retries the
 * ones it did not get a 2xx from. Without a ranking a replayed "ringing" lands
 * after "completed" and the call log tells the team a finished call is still in
 * flight — which is exactly the bug the messaging chunk fixed in
 * `api/twilio/status.ts`, so the same shape is used here rather than a second
 * invention of it.
 */

export type Call = typeof schema.calls.$inferSelect;

export { callStatusOf, ENDED, hasEnded, isLate, isMissedOutcome } from './outcome';

/* ------------------------------------------------------------------------ */
/*  Finding rows                                                             */
/* ------------------------------------------------------------------------ */

/**
 * The call a webhook is talking about, found by Twilio's own sid.
 *
 * Nothing else identifies it: the sid is what Twilio sends, and it is unique
 * across the account. The workspace comes off the row, which is also how the
 * auth token to verify the signature with is found — the same order as
 * `api/twilio/status.ts`.
 */
export async function callBySid(db: Db, sid: string): Promise<Call | null> {
  const [row] = await db.select().from(schema.calls).where(eq(schema.calls.providerId, sid)).limit(1);
  return row ?? null;
}

/**
 * The call one of our own TwiML URLs names.
 *
 * The id is ours and it travels in a query string Twilio echoes back, so it is
 * covered by the signature and cannot be tampered with — but the row is still
 * looked up on its own and the workspace taken from it, never from anything
 * else in the request.
 */
export async function callById(db: Db, id: string): Promise<Call | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [row] = await db.select().from(schema.calls).where(eq(schema.calls.id, id)).limit(1);
  return row ?? null;
}

/** Scoped to a workspace, for anything a signed-in person asks for. */
export async function ownedCall(db: Db, workspaceId: string, id: string): Promise<Call | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [row] = await db
    .select()
    .from(schema.calls)
    .where(and(eq(schema.calls.id, id), eq(schema.calls.workspaceId, workspaceId)))
    .limit(1);
  return row ?? null;
}

/* ------------------------------------------------------------------------ */
/*  Writing the outcome                                                      */
/* ------------------------------------------------------------------------ */

export interface StatusUpdate {
  status: CallStatus;
  durationSec?: number | null;
  priceCents?: number | null;
  /** Twilio's own wording for the row's audit trail. */
  raw?: string;
  meta?: Record<string, unknown>;
}

export interface StatusOutcome {
  applied: boolean;
  /** The row as it stands afterwards, whether or not the update was applied. */
  call: Call;
  /** Set when the call ended on this callback, so the caller can file it once. */
  ended: boolean;
}

/**
 * Applies one callback to one call.
 *
 * The write is conditional on the row still holding the status it was read
 * with, so two callbacks racing each other cannot both decide the ending: the
 * loser sees zero rows updated, re-reads and reports what actually stands.
 */
export async function applyCallStatus(db: Db, call: Call, update: StatusUpdate): Promise<StatusOutcome> {
  const late = isLate(call.status, update.status);
  const now = new Date();
  const ending = !late && hasEnded(update.status);

  /*
   * Only the keys this update brings are written, concatenated onto the row's
   * `meta` as it stands (`meta || $1`), never a spread of the `call` snapshot
   * the handler loaded a moment ago. Several hands write this row within the
   * same second on a live call — a status callback, the relay's `routed`
   * flag, the assistant's `markAnswered` — and a spread would carry a stale
   * copy of somebody else's flag back over theirs.
   */
  const patch: Record<string, unknown> = {
    ...(update.meta ?? {}),
    // A late callback is filed under its own key. Writing it to `twilioStatus`
    // would leave the row claiming its last word was the stale one.
    ...(update.raw ? (late ? { lateCallback: update.raw } : { twilioStatus: update.raw }) : {}),
  };
  const meta = sql`${schema.calls.meta} || ${JSON.stringify(patch)}::jsonb`;

  if (late) {
    // Recorded, not applied — the same choice `api/twilio/status.ts` makes, so
    // a replayed callback leaves a trace instead of a silent no-op.
    await db.update(schema.calls).set({ meta }).where(eq(schema.calls.id, call.id));
    return { applied: false, call: { ...call, meta: { ...call.meta, ...patch } }, ended: false };
  }

  const changed = await db
    .update(schema.calls)
    .set({
      status: update.status,
      meta,
      /*
       * Stamped the first time anything says somebody talked: Twilio's
       * `in-progress`, or an ending that carries seconds. Only outbound calls
       * ever get `in-progress` — on an inbound one the customer's leg is the
       * call itself — so this second clause is the only thing that stamps an
       * inbound answer at all.
       */
      ...(!call.answeredAt && (update.status === 'in-progress' || (hasEnded(update.status) && (update.durationSec ?? 0) > 0))
        ? { answeredAt: now }
        : {}),
      ...(ending && !call.endedAt ? { endedAt: now } : {}),
      ...(typeof update.durationSec === 'number' ? { durationSec: Math.max(0, Math.round(update.durationSec)) } : {}),
      ...(typeof update.priceCents === 'number' ? { priceCents: update.priceCents } : {}),
    })
    .where(and(eq(schema.calls.id, call.id), eq(schema.calls.status, call.status)))
    .returning();

  if (!changed.length) {
    // Somebody else moved it while this callback was in flight. Their verdict
    // stands; ours is not re-applied on top of it.
    const fresh = (await callById(db, call.id))!;
    return { applied: false, call: fresh, ended: false };
  }
  if (ending) {
    try {
      const { syncPhoneContact } = await import('./contact-stage');
      await syncPhoneContact(db, changed[0]!.workspaceId, changed[0]!.id);
    } catch (error) {
      console.error('[voice] pipeline contact sync deferred to retry', call.id, error);
    }
  }
  return { applied: true, call: changed[0], ended: ending };
}

/** What Twilio ended up charging for every leg, once it has decided. */
export async function setCallPrice(db: Db, callId: string, cents: number): Promise<void> {
  await db.update(schema.calls).set({ priceCents: cents }).where(eq(schema.calls.id, callId));
}

/**
 * Twilio never put a price on this one, and the screen should say so rather
 * than showing a blank that reads as "free".
 *
 * `checks` e `waitedMinutes` são o que a escada de `voice/price.ts` gastou
 * antes de desistir: sem eles, "sem preço" não distingue uma ligação que
 * esperou 24 horas de uma que morreu em oito minutos, que é exatamente o que
 * aconteceu com as quatro primeiras. São números, não frase de tela — a
 * tradução vive em `pages/app/calls/index.astro`, com `t()`.
 */
export async function noteCallUnpriced(
  db: Db,
  callId: string,
  waited?: { checks: number; waitedMinutes: number },
): Promise<void> {
  const call = await callById(db, callId);
  if (!call) return;
  await db
    .update(schema.calls)
    .set({
      meta: {
        ...call.meta,
        priceUnavailable: true,
        priceCheckedAt: new Date().toISOString(),
        ...(waited ? { priceChecks: waited.checks, priceWaitedMinutes: waited.waitedMinutes } : {}),
      },
    })
    .where(eq(schema.calls.id, callId));
}

/** Marks the call as one nobody answered. Separate, because it is a judgement. */
export async function markMissed(db: Db, callId: string): Promise<void> {
  await db.update(schema.calls).set({ missed: true }).where(eq(schema.calls.id, callId));
}

/* ------------------------------------------------------------------------ */
/*  The timeline                                                             */
/* ------------------------------------------------------------------------ */

function mmss(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * A call is a timeline event, so it lands on the timeline the way notes and
 * e-mails do — through `addActivity`, with the call id in `meta` so the contact
 * page can offer the recording next to it.
 *
 * It is filed once, when the call ends, rather than when it starts. A row that
 * says "called" and never says what happened is worse than no row: the whole
 * value of the entry is the outcome and the length, and neither exists until
 * the call is over.
 */
/**
 * Who the other end of this call was, in the best words the row has.
 *
 * Twilio's caller-name lookup fills `meta.callerName` when the business pays
 * for it, and the row is worth nothing if that name is captured and then never
 * shown. Falling back to the number is what the timeline did before.
 */
export function callerLabel(call: Call): string {
  const name = String(call.meta.callerName ?? '').trim();
  const number = call.direction === 'out' ? call.toNumber : call.fromNumber;
  return name || number;
}

/** "Los Angeles, CA", when Twilio told us and there is something to tell. */
export function callerPlace(call: Call): string {
  const city = String(call.meta.city ?? '').trim();
  const state = String(call.meta.state ?? '').trim();
  if (city && state) return `${titleCase(city)}, ${state}`;
  return titleCase(city) || state;
}

/** Twilio sends the city shouting; a timeline entry should not. */
function titleCase(value: string): string {
  return value.replace(/\S+/g, (word) => word[0]!.toUpperCase() + word.slice(1).toLowerCase());
}

export interface CallActivityOptions {
  voicemail?: boolean;
  /** The AI receptionist answered; the title says so and `outcome` says what came of it. */
  ai?: boolean;
  outcome?: 'booked' | 'rescheduled' | 'canceled' | 'message' | 'transferred' | 'voicemail' | 'info' | 'nothing';
  /** The person the assistant handed the call to, for the transfer wording. */
  transferredTo?: string;
}

/**
 * Seconds a completed call must last before it counts as a conversation.
 *
 * Measured in prod (2026-10-01): 44 of the 80 `call_answered` events came from
 * calls under 30 s, and nearly all of those were an outbound dial that reached
 * a voicemail greeting (10 to 11 s, the transcript only the carrier's "when you
 * have finished recording, you may hang up"). `status=completed` and
 * `durationSec>0` are true for a voicemail too, and each one paid +10 under the
 * rule "Spoke on the phone". Twilio's AnsweredBy is not requested on these
 * calls and is not stored, so duration plus the transcript below are the signals.
 */
export { MIN_CONVERSATION_SEC, looksLikeVoicemail, isRealConversation } from './contact-policy';
import { isRealConversation } from './contact-policy';

/**
 * How the call ended, as an event the scoring rules can price: `call_answered`
 * when somebody (or the assistant) actually spoke with the contact,
 * `inbound_call_missed` when they tried to reach us and got nobody (or left a
 * voicemail), `outbound_call_unanswered` when we tried them and they did not
 * pick up. Once per call, keyed by its id; quiet, because the call itself is
 * the timeline entry. Never lets an error escape: the entry is filed either way.
 */
async function recordCallOutcome(ctx: Ctx, call: Call, opts: CallActivityOptions): Promise<void> {
  if (!call.contactId) return;
  const inbound = call.direction === 'in';
  const spoke = opts.ai
    ? opts.outcome !== 'nothing' && opts.outcome !== 'voicemail'
    : call.status === 'completed' && !call.missed && !opts.voicemail && isRealConversation(call);
  const name = spoke ? 'call_answered' : inbound ? 'inbound_call_missed' : 'outbound_call_unanswered';
  try {
    await recordEvent(ctx, {
      contactId: call.contactId,
      name,
      source: 'voice',
      dedupeKey: `call:${call.id}`,
      payload: {
        direction: call.direction,
        durationSec: call.durationSec,
        status: call.status,
        ...(opts.ai ? { ai: true, ...(opts.outcome ? { outcome: opts.outcome } : {}) } : {}),
        ...(opts.voicemail ? { voicemail: true } : {}),
      },
      quiet: true,
    });
  } catch (error) {
    console.error('[voice] could not record the call outcome', call.id, error);
  }
}

export async function logCallActivity(ctx: Ctx, call: Call, opts: CallActivityOptions = {}): Promise<void> {
  if (!call.contactId) return;
  await recordCallOutcome(ctx, call, opts);
  if (!opts.voicemail) {
    try {
      const { syncPhoneContact } = await import('./contact-stage');
      await syncPhoneContact(ctx.db, ctx.workspaceId, call.id);
    } catch (error) {
      console.error('[voice] pipeline contact sync deferred to retry', call.id, error);
    }
  }
  const outgoing = call.direction === 'out';
  const who = callerLabel(call);

  if (opts.ai) {
    /*
     * A call the assistant answered is neither "completed" nor "missed" in the
     * old sense: somebody spoke to the caller, and it was a machine. The
     * duration is measured from the moment it picked up, because the row's
     * own `durationSec` is written by the status callback and this entry is
     * usually filed a moment before that callback arrives.
     */
    const seconds = call.durationSec || (call.answeredAt ? Math.max(0, Math.round((Date.now() - call.answeredAt.getTime()) / 1000)) : 0);
    const transferred = opts.outcome === 'transferred' && opts.transferredTo;
    const titleKey = transferred ? 'Call transferred by the assistant to {who} · {time}' : 'Assistant answered a call from {who} · {time}';
    const titleVars = { who: transferred ? opts.transferredTo! : who, time: mmss(seconds) };
    const title = titleKey.replace('{who}', titleVars.who).replace('{time}', titleVars.time);
    const place = callerPlace(call);
    await addActivity(ctx, {
      contactId: call.contactId,
      opportunityId: (call.meta.opportunityId as string | undefined) ?? null,
      type: 'call',
      title,
      body: call.transcript ? call.transcript.slice(0, 2000) : null,
      meta: {
        callId: call.id,
        direction: call.direction,
        outcome: call.status,
        durationSec: seconds,
        titleKey,
        titleVars,
        ai: true,
        ...(opts.outcome ? { aiOutcome: opts.outcome } : {}),
        ...(place ? { place } : {}),
      },
    });
    return;
  }
  /*
   * "Completed" is Twilio's word for a call that ran its course, not for one
   * somebody answered. An inbound call that rang out and took a voicemail
   * completes too, and its duration counts the greeting and the message — so
   * without `missed` here the timeline claims a 34-second conversation that
   * nobody was on.
   */
  const spoke = call.status === 'completed' && call.durationSec > 0 && !call.missed;

  /*
   * Two spellings of the same sentence, for the reason the automations chunk
   * stores both on an enrolment log: `title` is English and is what anything
   * reading this row without a translator sees, `titleKey` and `titleVars` are
   * the same sentence taken apart so the timeline can say it in Portuguese.
   *
   * A template literal is invisible to `scripts/i18n-keys.py`, which is exactly
   * how "Voicemail from +1…" sat untranslated on a Portuguese page behind a
   * green report. The keys below are literals, and every one of them has an
   * entry in `src/lib/i18n/voice.ts`.
   */
  const outcome = call.status === 'busy' ? 'busy' : call.status === 'failed' ? 'failed' : 'no answer';
  const titleKey = opts.voicemail
    ? 'Voicemail from {who}'
    : spoke
      ? outgoing
        ? 'Called {who} · {time}'
        : 'Call from {who} · {time}'
      : outgoing
        ? outcome === 'busy'
          ? 'Called {who} · busy'
          : outcome === 'failed'
            ? 'Called {who} · failed'
            : 'Called {who} · no answer'
        : outcome === 'busy'
          ? 'Call from {who} · busy'
          : outcome === 'failed'
            ? 'Call from {who} · failed'
            : 'Call from {who} · no answer';
  const titleVars = { who, time: mmss(call.durationSec) };
  const title = titleKey.replace('{who}', who).replace('{time}', titleVars.time);

  const place = callerPlace(call);

  await addActivity(ctx, {
    contactId: call.contactId,
    opportunityId: (call.meta.opportunityId as string | undefined) ?? null,
    type: 'call',
    title,
    body: call.transcript ? call.transcript.slice(0, 2000) : null,
    meta: {
      callId: call.id,
      direction: call.direction,
      outcome: call.status,
      durationSec: call.durationSec,
      titleKey,
      titleVars,
      ...(place ? { place } : {}),
      ...(opts.voicemail ? { voicemail: true } : {}),
      ...(call.recordingSid ? { recordingSid: call.recordingSid } : {}),
    },
  });
}

/**
 * A better title for an entry somebody else filed first.
 *
 * The call ends on two webhooks — the relay's own action and the status
 * callback — and either may win the `logged` claim. When the status
 * callback wins, the entry says "Call from +1… · 0:42", which is true and
 * misses the point: the assistant answered. The loser rewrites the title
 * rather than filing a second entry, finding the row by the call id in its
 * meta, which is the same key `backfillTranscript` uses — inside the
 * workspace, as every query here is, so a call id from elsewhere finds
 * nothing.
 */
export async function retitleCallActivity(
  db: Db,
  workspaceId: string,
  callId: string,
  titleKey: string,
  titleVars: Record<string, string | number>,
): Promise<boolean> {
  const [activity] = await db
    .select({ id: schema.activities.id, workspaceId: schema.activities.workspaceId, meta: schema.activities.meta })
    .from(schema.activities)
    .where(and(eq(schema.activities.workspaceId, workspaceId), eq(schema.activities.type, 'call'), sql`${schema.activities.meta} ->> 'callId' = ${callId}`))
    .orderBy(sql`${schema.activities.createdAt} desc`)
    .limit(1);
  if (!activity) return false;
  let title = titleKey;
  for (const [key, value] of Object.entries(titleVars)) title = title.replace(`{${key}}`, String(value));
  const meta = { ...((activity.meta ?? {}) as Record<string, unknown>), titleKey, titleVars, ai: true };
  await db
    .update(schema.activities)
    .set({ title, meta })
    .where(and(eq(schema.activities.id, activity.id), eq(schema.activities.workspaceId, activity.workspaceId)));
  return true;
}

/**
 * The words, once they exist, on the entry that was filed without them.
 *
 * `logCallActivity` runs the moment the caller hangs up, and the transcript is
 * a background job that finishes a minute later — so the timeline entry is
 * always written with `transcript` still null. Filing a second entry when the
 * text arrives would tell the same event twice; this fills in the one that is
 * already there, and does nothing at all if somebody has since typed over it.
 */
export async function backfillTranscript(db: Db, call: Call, transcript: string): Promise<boolean> {
  const ctx: Ctx = { db, workspaceId: call.workspaceId, actorId: null };
  const body = transcript.slice(0, 2000);

  const [activity] = await db
    .select({ id: schema.activities.id })
    .from(schema.activities)
    .where(
      and(
        eq(schema.activities.workspaceId, call.workspaceId),
        eq(schema.activities.type, 'call'),
        sql`${schema.activities.meta} ->> 'callId' = ${call.id}`,
      ),
    )
    .orderBy(sql`${schema.activities.createdAt} desc`)
    .limit(1);
  const filled = activity ? await setActivityBody(ctx, activity.id, body) : false;

  if (call.conversationId) {
    // The inbox got a placeholder — "Voicemail, 31s" — at the same moment, and
    // it is the same fix: the thread should read as the message it is.
    const [message] = await db
      .select({ id: schema.messages.id })
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.workspaceId, call.workspaceId),
          eq(schema.messages.conversationId, call.conversationId),
          sql`${schema.messages.meta} ->> 'callId' = ${call.id}`,
        ),
      )
      .limit(1);
    if (message) await setMessageBody(ctx, message.id, body);
  }
  return filled;
}

/**
 * Wins the right to file this call on the timeline, exactly once.
 *
 * Twilio retries any callback it did not get a 2xx from, and a call ends on
 * both the status callback and the dial action — so "it only happens once" is
 * not true of either path. The marker is set by a single statement the database
 * arbitrates: whoever flips `meta.logged` from absent to true is the one that
 * writes the activity, and every retry after it sees zero rows.
 */
export async function claimTimelineEntry(db: Db, callId: string, key = 'logged'): Promise<boolean> {
  const changed = await db
    .update(schema.calls)
    .set({ meta: sql`${schema.calls.meta} || ${JSON.stringify({ [key]: true })}::jsonb` })
    .where(and(eq(schema.calls.id, callId), sql`coalesce(${schema.calls.meta} ->> ${key}, 'false') <> 'true'`))
    .returning({ id: schema.calls.id });
  return changed.length > 0;
}
