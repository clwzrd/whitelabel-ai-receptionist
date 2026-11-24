import type { SessionStore } from '../engine/types';
import type { Call } from '../support';

/**
 * What this service remembers while a call is live.
 *
 * Two things, and only for the length of a call: the call itself (so the
 * socket Twilio opens can be matched to the ring that announced it) and the
 * session (the transcript and the state the model needs between turns, so a
 * reconnection picks up where it was). The finished call is the CRM's to
 * keep: it is handed over through `CrmPort.recordCall`.
 *
 * `memory.ts` keeps both in the process, which is right for one instance and
 * for tests. `postgres.ts` keeps them in two tables, which is what more than
 * one instance, or a restart in the middle of a call, needs.
 */
export interface ServiceStore extends SessionStore {
  /** The same call announced twice (Twilio retries its webhook) is one call. */
  createCall(input: { callSid: string; from: string | null; to: string | null }): Promise<Call>;
  callById(id: string): Promise<Call | null>;
  setCaller(callId: string, callerId: string): Promise<void>;
}

/** One business per installation. The engine was written for many, so it still asks. */
export const WORKSPACE = 'default';
