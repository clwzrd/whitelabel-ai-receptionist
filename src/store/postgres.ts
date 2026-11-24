import { randomUUID } from 'node:crypto';
import type { SessionRow } from '../engine/types';
import type { Call } from '../support';
import { WORKSPACE, type ServiceStore } from './store';

/**
 * Calls and sessions in Postgres, for more than one instance or a restart in
 * the middle of a call.
 *
 * It takes a `query` function rather than a driver, so it runs on `pg`
 * (see `server.ts`), on a serverless driver, or on an in-process Postgres in
 * the tests. `ensureSchema()` creates the two tables it needs.
 */
export type Query = (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

export const SCHEMA = `
create table if not exists receptionist_calls (
  id uuid primary key,
  call_sid text not null unique,
  from_number text,
  to_number text,
  caller_id text,
  answered_at timestamptz,
  started_at timestamptz not null default now()
);
create table if not exists receptionist_sessions (
  id uuid primary key,
  call_id uuid not null unique references receptionist_calls(id) on delete cascade,
  status text not null default 'live',
  turns jsonb not null default '[]'::jsonb,
  turn_count integer not null default 0,
  rotate_count integer not null default 0,
  state jsonb not null default '{"transferAttempts":0}'::jsonb,
  end_reason text,
  outcome text,
  handoff jsonb,
  cost_cents integer not null default 0,
  started_at timestamptz not null default now(),
  last_turn_at timestamptz,
  ended_at timestamptz
);
`;

export class PostgresStore implements ServiceStore {
  constructor(private readonly query: Query) {}

  async ensureSchema(): Promise<void> {
    for (const statement of SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) await this.query(statement);
  }

  async createCall(input: { callSid: string; from: string | null; to: string | null }): Promise<Call> {
    const { rows } = await this.query(
      `insert into receptionist_calls (id, call_sid, from_number, to_number) values ($1, $2, $3, $4)
       on conflict (call_sid) do update set call_sid = excluded.call_sid returning *`,
      [randomUUID(), input.callSid, input.from, input.to],
    );
    return toCall(rows[0]!);
  }

  async callById(id: string): Promise<Call | null> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const { rows } = await this.query('select * from receptionist_calls where id = $1', [id]);
    return rows[0] ? toCall(rows[0]) : null;
  }

  async setCaller(callId: string, callerId: string): Promise<void> {
    await this.query('update receptionist_calls set caller_id = $2 where id = $1', [callId, callerId]);
  }

  async open(_workspaceId: string, callId: string): Promise<SessionRow> {
    // Opening a session that exists is a reconnection: same conversation, one rotation further.
    const { rows } = await this.query(
      `insert into receptionist_sessions (id, call_id) values ($1, $2)
       on conflict (call_id) do update set status = 'live', rotate_count = receptionist_sessions.rotate_count + 1,
         end_reason = null, ended_at = null, handoff = null, outcome = null
       returning *`,
      [randomUUID(), callId],
    );
    return toSession(rows[0]!);
  }

  async append(_workspaceId: string, callId: string, turns: SessionRow['turns']): Promise<void> {
    if (!turns.length) return;
    await this.query('update receptionist_sessions set turns = turns || $2::jsonb, turn_count = turn_count + $3, last_turn_at = now() where call_id = $1', [callId, JSON.stringify(turns), turns.length]);
  }

  async truncateLast(_workspaceId: string, callId: string, text: string): Promise<boolean> {
    const { rows } = await this.query(
      `update receptionist_sessions
         set turns = jsonb_set(turns, array[(turn_count - 1)::text], (turns -> (turn_count - 1)) || $2::jsonb)
       where call_id = $1 and turn_count > 0 and turns -> (turn_count - 1) ->> 'role' = 'assistant'
       returning id`,
      [callId, JSON.stringify({ text, interrupted: true })],
    );
    return rows.length > 0;
  }

  async setState(_workspaceId: string, callId: string, patch: Partial<SessionRow['state']>): Promise<void> {
    await this.query('update receptionist_sessions set state = state || $2::jsonb where call_id = $1', [callId, JSON.stringify(patch)]);
  }

  async end(_workspaceId: string, callId: string, input: Parameters<ServiceStore['end']>[2]): Promise<boolean> {
    // A connection that was replaced must not close the conversation its successor is having.
    const { rows } = await this.query(
      `update receptionist_sessions
         set status = 'ended', end_reason = $2, outcome = coalesce($3, outcome), handoff = coalesce($4::jsonb, handoff),
             cost_cents = cost_cents + $5, ended_at = now()
       where call_id = $1 and rotate_count = $6 returning id`,
      [callId, input.reason, input.outcome ?? null, input.handoff ? JSON.stringify(input.handoff) : null, Math.max(0, Math.round(input.costCents ?? 0)), input.expectedRotateCount],
    );
    return rows.length > 0;
  }

  async byCall(_workspaceId: string, callId: string): Promise<SessionRow | null> {
    const { rows } = await this.query('select * from receptionist_sessions where call_id = $1', [callId]);
    return rows[0] ? toSession(rows[0]) : null;
  }

  async markAnswered(call: Call): Promise<Call> {
    const { rows } = await this.query('update receptionist_calls set answered_at = coalesce(answered_at, now()) where id = $1 returning *', [call.id]);
    return rows[0] ? toCall(rows[0]) : call;
  }

  async recordError(input: { where: string; error: unknown }): Promise<void> {
    console.error(`[receptionist] ${input.where}:`, input.error instanceof Error ? input.error.message : input.error);
  }
}

const date = (value: unknown): Date | null => (value == null ? null : value instanceof Date ? value : new Date(String(value)));
const json = <T>(value: unknown, fallback: T): T => (value == null ? fallback : typeof value === 'string' ? (JSON.parse(value) as T) : (value as T));

function toCall(row: Record<string, unknown>): Call {
  return {
    id: String(row.id),
    workspaceId: WORKSPACE,
    contactId: (row.caller_id as string | null) ?? null,
    fromNumber: (row.from_number as string | null) ?? null,
    toNumber: (row.to_number as string | null) ?? null,
    providerId: String(row.call_sid),
    answeredAt: date(row.answered_at),
    startedAt: date(row.started_at) ?? new Date(),
  };
}

function toSession(row: Record<string, unknown>): SessionRow {
  return {
    id: String(row.id),
    workspaceId: WORKSPACE,
    callId: String(row.call_id),
    status: row.status as SessionRow['status'],
    turns: json(row.turns, []),
    turnCount: Number(row.turn_count),
    rotateCount: Number(row.rotate_count),
    state: json(row.state, { transferAttempts: 0 }),
    endReason: (row.end_reason as SessionRow['endReason']) ?? null,
    outcome: (row.outcome as SessionRow['outcome']) ?? null,
    handoff: json(row.handoff, null),
    summary: null,
    costCents: Number(row.cost_cents),
    startedAt: date(row.started_at) ?? new Date(),
    lastTurnAt: date(row.last_turn_at),
    endedAt: date(row.ended_at),
  };
}
