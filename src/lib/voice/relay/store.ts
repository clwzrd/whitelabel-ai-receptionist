import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../../../db';
import { schema } from '../../../db';
import { recordError } from '../../ops/errors';
import { applyCallStatus, type Call } from '../store';
import type { SessionEndInput, SessionRow, SessionState, SessionStore, Turn } from './types';

/**
 * `voice_sessions`, written the only way a live conversation can be written
 * safely: appends and guarded updates, never read-modify-write.
 *
 * A session is one row per call, and while the call is up that row is being
 * changed from several places at once — the socket appending turns, a
 * `relay-done` webhook marking it rotating, a resumed connection bumping the
 * rotate count, a status callback closing the call. Reading the row, changing
 * a field in memory and writing the whole thing back would let any two of
 * those clobber each other; every statement here instead says what to do to
 * the row as it stands (`turns || $1`, `state || $1`, `rotate_count + 1`) and
 * the database serialises them. The one update that could go wrong — an old
 * invocation ending a session a newer one has already resumed — is guarded on
 * the rotate count it opened with.
 *
 * Every query is scoped by `workspace_id` as well as `call_id`. The call id
 * alone would do (it is unique), but the scope is the CRM's rule for every
 * table and a query that breaks it once is a query somebody copies.
 */
export function dbSessionStore(db: Db): SessionStore {
  const t = schema.voiceSessions;
  const scope = (workspaceId: string, callId: string) => and(eq(t.workspaceId, workspaceId), eq(t.callId, callId));

  return {
    async open(workspaceId, callId) {
      /*
       * One statement for both the first connection and every resume, so two
       * sockets racing for the same call cannot both believe they are first:
       * the insert wins for exactly one of them and the other lands in the
       * conflict branch with the transcript so far and a higher rotate count.
       */
      /*
       * A resume clears what the previous segment's `end()` wrote — its
       * reason, its end time, its hand-off — so the row reads as open again.
       * `closeSessionRow` fills those with `coalesce()` and the daily minutes
       * sum measures `started_at → coalesce(ended_at, now())`; a stale
       * `ended_at` from the first rotate would stop the clock at the rotate
       * and let a later close keep "rotate" as the reason for a call that
       * ended some other way.
       */
      const [row] = await db
        .insert(t)
        .values({ workspaceId, callId, status: 'live' })
        .onConflictDoUpdate({
          target: t.callId,
          set: { status: 'live', rotateCount: sql`${t.rotateCount} + 1`, endReason: null, endedAt: null, handoff: null, outcome: null },
          setWhere: eq(t.workspaceId, workspaceId),
        })
        .returning();
      if (!row) throw new Error('voice_sessions: the call belongs to another workspace');
      return row as SessionRow;
    },

    async append(workspaceId, callId, turns) {
      if (!turns.length) return;
      await db
        .update(t)
        .set({
          turns: sql`${t.turns} || ${JSON.stringify(turns)}::jsonb`,
          turnCount: sql`${t.turnCount} + ${turns.length}`,
          lastTurnAt: new Date(),
        })
        .where(scope(workspaceId, callId));
    },

    async truncateLast(workspaceId, callId, text) {
      /*
       * The caller spoke over the assistant, so what was persisted as the
       * reply is more than what was heard. The guard on the role is what
       * keeps a late interrupt — arriving after the next user turn was
       * already appended — from cutting the caller's own words.
       */
      const patch = JSON.stringify({ text, interrupted: true } satisfies Partial<Turn>);
      const changed = await db
        .update(t)
        .set({
          turns: sql`jsonb_set(${t.turns}, array[(${t.turnCount} - 1)::text], (${t.turns} -> (${t.turnCount} - 1)) || ${patch}::jsonb)`,
        })
        .where(and(scope(workspaceId, callId), sql`${t.turnCount} > 0`, sql`${t.turns} -> (${t.turnCount} - 1) ->> 'role' = 'assistant'`))
        .returning({ id: t.id });
      return changed.length > 0;
    },

    async setState(workspaceId, callId, patch) {
      await db
        .update(t)
        .set({ state: sql`${t.state} || ${JSON.stringify(patch)}::jsonb` })
        .where(scope(workspaceId, callId));
    },

    async end(workspaceId, callId, input) {
      const changed = await db
        .update(t)
        .set({
          status: 'ended',
          endReason: input.reason,
          ...(input.outcome !== undefined ? { outcome: input.outcome } : {}),
          ...(input.handoff !== undefined ? { handoff: input.handoff } : {}),
          costCents: sql`${t.costCents} + ${Math.max(0, Math.round(input.costCents ?? 0))}`,
          endedAt: new Date(),
        })
        .where(and(scope(workspaceId, callId), eq(t.rotateCount, input.expectedRotateCount)))
        .returning({ id: t.id });
      return changed.length > 0;
    },

    async byCall(workspaceId, callId) {
      const [row] = await db.select().from(t).where(scope(workspaceId, callId)).limit(1);
      return (row as SessionRow | undefined) ?? null;
    },

    async markAnswered(call: Call) {
      const outcome = await applyCallStatus(db, call, {
        status: 'in-progress',
        meta: { leg: 'relay', answeredBy: 'ai' },
      });
      return outcome.call;
    },

    async recordError(input) {
      await recordError(db, input);
    },
  };
}

/**
 * What `relay-done` or the status callback writes when the socket is gone
 * and the session's own `end` may never have run — a deadline kill, a caller
 * who hung up while the function was mid-write. The reason and the end time
 * are kept when the session wrote them itself; only the gaps are filled, and
 * the outcome the webhook decided is written on top because it knows more
 * than the socket did (whether the transfer was answered, for one).
 *
 * Two reasons are not kept: `rotate` and `transfer` name a continuation
 * (a resumed socket, a dial) and a close arriving while they stand means
 * that continuation never happened, so the closer's reason is the true one.
 * And `failed` from the caller always wins: the action webhook saw Twilio's
 * error code, which is more than a socket that merely closed knew.
 */
export async function closeSessionRow(
  db: Db,
  workspaceId: string,
  callId: string,
  input: Pick<SessionEndInput, 'reason' | 'outcome' | 'handoff'>,
): Promise<void> {
  const t = schema.voiceSessions;
  const endReason =
    input.reason === 'failed'
      ? sql`${input.reason}`
      : sql`case when ${t.endReason} is null or ${t.endReason} in ('rotate', 'transfer') then ${input.reason} else ${t.endReason} end`;
  await db
    .update(t)
    .set({
      status: 'ended',
      endReason,
      ...(input.outcome ? { outcome: input.outcome } : {}),
      ...(input.handoff ? { handoff: input.handoff } : {}),
      endedAt: sql`coalesce(${t.endedAt}, now())`,
    })
    .where(and(eq(t.workspaceId, workspaceId), eq(t.callId, callId)));
}

/** Flips a row back to `rotating` so the next `<Connect>` is treated as a resume, not a fresh session. */
export async function markSessionRotating(db: Db, workspaceId: string, callId: string, patch?: Partial<SessionState>): Promise<void> {
  const t = schema.voiceSessions;
  await db
    .update(t)
    .set({
      status: 'rotating',
      ...(patch ? { state: sql`${t.state} || ${JSON.stringify(patch)}::jsonb` } : {}),
    })
    .where(and(eq(t.workspaceId, workspaceId), eq(t.callId, callId)));
}

/** Whether the caller ever said anything to the assistant on this call — the line between "handled" and "missed". */
export function hadUserTurn(turns: Turn[] | null | undefined): boolean {
  return Boolean(turns?.some((turn) => turn.role === 'user'));
}
