import { randomUUID } from 'node:crypto';
import { SlotTaken, type Appointment, type BusinessFacts, type CallRecord, type Caller, type CrmPort, type Slot } from './port';

/**
 * A CRM that lives in memory.
 *
 * It is the reference implementation of `CrmPort`, the one the tests run
 * against, and what `CRM=memory` starts so the service can be tried with no
 * CRM at all. Open times are weekdays, on the hour, between `openHour` and
 * `closeHour` in the business's timezone; a booked time is no longer open.
 * Nothing survives a restart.
 */
export interface MemoryCrmOptions {
  business?: Partial<BusinessFacts>;
  openHour?: number;
  closeHour?: number;
  /** For tests: the clock. */
  nowMs?: () => number;
}

export class MemoryCrm implements CrmPort {
  readonly callers = new Map<string, Caller>();
  readonly appointments = new Map<string, Appointment & { callerId: string; notes: string; canceled: boolean }>();
  readonly messages: { callerId: string | null; phone: string | null; text: string; at: Date }[] = [];
  readonly calls: CallRecord[] = [];

  private readonly facts: BusinessFacts;
  private readonly openHour: number;
  private readonly closeHour: number;
  private readonly now: () => number;

  constructor(options: MemoryCrmOptions = {}) {
    this.facts = {
      name: 'the business',
      timezone: 'America/New_York',
      hours: 'Monday to Friday, 9 a.m. to 5 p.m.',
      knowledge: '',
      appointmentName: 'a call',
      appointmentMinutes: 30,
      ...options.business,
    };
    this.openHour = options.openHour ?? 9;
    this.closeHour = options.closeHour ?? 17;
    this.now = options.nowMs ?? (() => Date.now());
  }

  async business(): Promise<BusinessFacts> {
    return { ...this.facts };
  }

  async findCallerByPhone(phone: string): Promise<Caller | null> {
    for (const caller of this.callers.values()) if (caller.phone === phone) return { ...caller };
    return null;
  }

  async saveCaller(input: { id?: string | null; phone?: string | null; name?: string; email?: string; company?: string }): Promise<Caller> {
    const existing = input.id ? this.callers.get(input.id) : undefined;
    const caller: Caller = existing ?? { id: randomUUID(), name: null, company: null, email: null, phone: input.phone ?? null };
    if (input.name !== undefined) caller.name = input.name;
    if (input.email !== undefined) caller.email = input.email;
    if (input.company !== undefined) caller.company = input.company;
    if (input.phone && !caller.phone) caller.phone = input.phone;
    this.callers.set(caller.id, caller);
    return { ...caller };
  }

  async openSlots(input: { fromIso: string; toIso: string; limit: number }): Promise<Slot[]> {
    const from = Math.max(Date.parse(input.fromIso), this.now());
    const to = Date.parse(input.toIso);
    const taken = new Set([...this.appointments.values()].filter((a) => !a.canceled).map((a) => a.startIso));
    const out: Slot[] = [];
    // Walk hour by hour: simple, and correct across a daylight-saving change because each instant is tested in the zone.
    for (let t = Math.ceil(from / 3_600_000) * 3_600_000; t <= to && out.length < input.limit; t += 3_600_000) {
      const { weekday, hour } = localParts(t, this.facts.timezone);
      if (weekday === 'Sat' || weekday === 'Sun' || hour < this.openHour || hour >= this.closeHour) continue;
      const startIso = new Date(t).toISOString();
      if (!taken.has(startIso)) out.push({ startIso });
    }
    return out;
  }

  async appointmentsFor(callerId: string): Promise<Appointment[]> {
    return [...this.appointments.values()]
      .filter((a) => a.callerId === callerId && !a.canceled && Date.parse(a.startIso) >= this.now())
      .sort((a, b) => a.startIso.localeCompare(b.startIso))
      .map(({ id, startIso, title }) => ({ id, startIso, title }));
  }

  async book(input: { callerId: string; startIso: string; notes?: string }): Promise<Appointment> {
    const startIso = new Date(input.startIso).toISOString();
    await this.assertOpen(startIso);
    const caller = this.callers.get(input.callerId);
    const appointment = { id: randomUUID(), startIso, title: `${this.facts.appointmentName} with ${caller?.name ?? 'a caller'}`, callerId: input.callerId, notes: input.notes ?? '', canceled: false };
    this.appointments.set(appointment.id, appointment);
    return { id: appointment.id, startIso, title: appointment.title };
  }

  async reschedule(input: { appointmentId: string; startIso: string }): Promise<Appointment> {
    const appointment = this.appointments.get(input.appointmentId);
    if (!appointment || appointment.canceled) throw new Error('No such appointment.');
    const startIso = new Date(input.startIso).toISOString();
    await this.assertOpen(startIso);
    appointment.startIso = startIso;
    return { id: appointment.id, startIso, title: appointment.title };
  }

  async cancel(input: { appointmentId: string; reason?: string }): Promise<void> {
    const appointment = this.appointments.get(input.appointmentId);
    if (!appointment || appointment.canceled) throw new Error('No such appointment.');
    appointment.canceled = true;
    if (input.reason) appointment.notes = `${appointment.notes}\nCanceled: ${input.reason}`.trim();
  }

  async leaveMessage(input: { callerId: string | null; phone: string | null; text: string }): Promise<void> {
    this.messages.push({ ...input, at: new Date(this.now()) });
  }

  async recordCall(record: CallRecord): Promise<void> {
    this.calls.push(record);
  }

  private async assertOpen(startIso: string): Promise<void> {
    const open = await this.openSlots({ fromIso: startIso, toIso: startIso, limit: 1 });
    if (open[0]?.startIso !== startIso) throw new SlotTaken();
  }
}

function localParts(ms: number, timeZone: string): { weekday: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', hour12: false }).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return { weekday: get('weekday'), hour: Number(get('hour')) % 24 };
}
