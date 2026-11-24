import { randomUUID } from 'node:crypto';
import type { SessionRow } from '../engine/types';
import type { Call } from '../support';
import { WORKSPACE, type ServiceStore } from './store';

/** Calls and sessions held in the process. Gone on restart; fine for one instance and for tests. */
export class MemoryStore implements ServiceStore {
  readonly calls = new Map<string, Call>();
  readonly sessions = new Map<string, SessionRow>();
  readonly errors: { where: string; error: unknown }[] = [];

  async createCall(input: { callSid: string; from: string | null; to: string | null }): Promise<Call> {
    for (const call of this.calls.values()) if (call.providerId === input.callSid) return call;
    const call: Call = { id: randomUUID(), workspaceId: WORKSPACE, contactId: null, fromNumber: input.from, toNumber: input.to, providerId: input.callSid, answeredAt: null, startedAt: new Date() };
    this.calls.set(call.id, call);
    return call;
  }

  async callById(id: string): Promise<Call | null> {
    return this.calls.get(id) ?? null;
  }

  async setCaller(callId: string, callerId: string): Promise<void> {
    const call = this.calls.get(callId);
    if (call) call.contactId = callerId;
  }

  async open(workspaceId: string, callId: string): Promise<SessionRow> {
    const existing = this.sessions.get(callId);
    if (existing) {
      // Opening a session that exists is a reconnection: same conversation, one rotation further.
      Object.assign(existing, { status: 'live', rotateCount: existing.rotateCount + 1, endReason: null, endedAt: null, handoff: null, outcome: null });
      return snapshot(existing);
    }
    const row: SessionRow = { id: randomUUID(), workspaceId, callId, status: 'live', turns: [], turnCount: 0, rotateCount: 0, state: { transferAttempts: 0 }, endReason: null, outcome: null, handoff: null, summary: null, costCents: 0, startedAt: new Date(), lastTurnAt: null, endedAt: null };
    this.sessions.set(callId, row);
    return snapshot(row);
  }

  async append(_workspaceId: string, callId: string, turns: SessionRow['turns']): Promise<void> {
    const row = this.sessions.get(callId);
    if (!row || !turns.length) return;
    row.turns.push(...turns);
    row.turnCount += turns.length;
    row.lastTurnAt = new Date();
  }

  async truncateLast(_workspaceId: string, callId: string, text: string): Promise<boolean> {
    const last = this.sessions.get(callId)?.turns.at(-1);
    if (!last || last.role !== 'assistant') return false;
    last.text = text;
    last.interrupted = true;
    return true;
  }

  async setState(_workspaceId: string, callId: string, patch: Partial<SessionRow['state']>): Promise<void> {
    const row = this.sessions.get(callId);
    if (row) row.state = { ...row.state, ...patch };
  }

  async end(_workspaceId: string, callId: string, input: Parameters<ServiceStore['end']>[2]): Promise<boolean> {
    const row = this.sessions.get(callId);
    // A connection that was replaced must not close the conversation its successor is having.
    if (!row || row.rotateCount !== input.expectedRotateCount) return false;
    row.status = 'ended';
    row.endReason = input.reason;
    if (input.outcome !== undefined) row.outcome = input.outcome;
    if (input.handoff !== undefined) row.handoff = input.handoff;
    row.costCents += Math.max(0, Math.round(input.costCents ?? 0));
    row.endedAt = new Date();
    return true;
  }

  async byCall(_workspaceId: string, callId: string): Promise<SessionRow | null> {
    const row = this.sessions.get(callId);
    return row ? snapshot(row) : null;
  }

  async markAnswered(call: Call): Promise<Call> {
    const stored = this.calls.get(call.id) ?? call;
    stored.answeredAt ??= new Date();
    return stored;
  }

  async recordError(input: { where: string; error: unknown }): Promise<void> {
    this.errors.push({ where: input.where, error: input.error });
    console.error(`[receptionist] ${input.where}:`, input.error instanceof Error ? input.error.message : input.error);
  }
}

const snapshot = (row: SessionRow): SessionRow => ({ ...row, turns: row.turns.map((t) => ({ ...t })), state: { ...row.state } });
