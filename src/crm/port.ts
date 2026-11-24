/**
 * Everything the receptionist needs from a CRM, and nothing else.
 *
 * The assistant never touches a database. When it wants to know who is
 * calling, what times are open, or to book, move or cancel a call, it goes
 * through this interface. Implement it for your CRM and the receptionist
 * works with it: `memory.ts` is a complete in-memory example and
 * `whitelabel.ts` talks to whitelabel-crm over its connector API.
 *
 * Rules every implementation must keep:
 *  - times are ISO instants in UTC; the receptionist turns them into the
 *    business's local time when it speaks;
 *  - `book` and `reschedule` throw `SlotTaken` when the time is no longer
 *    free, so the assistant offers another instead of promising a slot it
 *    did not get;
 *  - a method that cannot do its job throws; the assistant then tells the
 *    caller it could not, and takes a message.
 */

export interface BusinessFacts {
  name: string;
  /** IANA timezone, e.g. "America/Chicago". Slots are spoken in it. */
  timezone: string;
  /** Opening hours as a sentence the assistant may read out. Empty: unknown, and it says so. */
  hours: string;
  /** What the business does, what it must not promise, anything the assistant may state as fact. */
  knowledge: string;
  /** What a booked call is called when spoken, e.g. "a discovery call". */
  appointmentName: string;
  /** Minutes one appointment lasts. */
  appointmentMinutes: number;
}

export interface Caller {
  id: string;
  name: string | null;
  company: string | null;
  email: string | null;
  phone: string | null;
}

export interface Slot {
  startIso: string;
}

export interface Appointment {
  id: string;
  startIso: string;
  title: string;
}

export interface CallRecord {
  callSid: string;
  from: string | null;
  to: string | null;
  callerId: string | null;
  startedAt: Date;
  endedAt: Date;
  /** What the call amounted to: booked, rescheduled, canceled, message, transferred, voicemail, info, nothing. */
  outcome: string;
  /** Why it ended: caller-hung-up, assistant-ended, transfer, idle, max-minutes, max-turns, failed. */
  endReason: string;
  /** The language the call ended in, as a BCP-47 code; null for English. */
  language: string | null;
  transcript: { role: 'caller' | 'assistant'; text: string; at: Date }[];
}

export class SlotTaken extends Error {
  constructor() {
    super('That time is no longer open.');
    this.name = 'SlotTaken';
  }
}

export interface CrmPort {
  business(): Promise<BusinessFacts>;
  /** The person behind a caller ID, or null. Never called for a withheld number. */
  findCallerByPhone(phone: string): Promise<Caller | null>;
  /** Creates the caller, or updates the one with this id. Only the fields given are written. */
  saveCaller(input: { id?: string | null; phone?: string | null; name?: string; email?: string; company?: string }): Promise<Caller>;
  /** Open times between two instants, soonest first. */
  openSlots(input: { fromIso: string; toIso: string; limit: number }): Promise<Slot[]>;
  /** Upcoming appointments of a caller, soonest first. */
  appointmentsFor(callerId: string): Promise<Appointment[]>;
  book(input: { callerId: string; startIso: string; notes?: string }): Promise<Appointment>;
  reschedule(input: { appointmentId: string; startIso: string }): Promise<Appointment>;
  cancel(input: { appointmentId: string; reason?: string }): Promise<void>;
  /** A message for the team, filed where a person will see it. */
  leaveMessage(input: { callerId: string | null; phone: string | null; text: string }): Promise<void>;
  /** The finished call, once, after the caller is gone. */
  recordCall(record: CallRecord): Promise<void>;
}
