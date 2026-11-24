import { SlotTaken, type Appointment, type BusinessFacts, type CallRecord, type Caller, type CrmPort, type Slot } from './port';

/**
 * whitelabel-crm, through its connector API.
 *
 * Everything goes over HTTPS with an owner connector key (created in the
 * CRM's Settings → API): contacts are searched and edited through
 * `/api/v1/connector/contacts`, open times come from
 * `/api/v1/connector/owner/calendar`, and bookings, tasks and the call log
 * are the CRM's own server actions, run through
 * `/api/v1/connector/owner/actions` with the same validation as its screens.
 *
 * The key acts as the owner it belongs to. It is only ever sent to
 * `origin`, and a redirect away from it is an error.
 */
export interface WhitelabelCrmOptions {
  /** https://crm.yourdomain.com */
  origin: string;
  apiKey: string;
  /** The booking calendar the assistant offers times from. */
  calendarId: string;
  /** What the assistant may say about the business; the CRM does not serve these over the connector. */
  business: Omit<BusinessFacts, 'timezone'> & { timezone?: string };
  /** For tests. */
  fetchImpl?: typeof fetch;
}

interface ContactView { id: string; first_name: string | null; last_name: string | null; email: string | null; phone: string | null; company: string | null; updated_at: string }

class CrmError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export class WhitelabelCrm implements CrmPort {
  private readonly origin: string;
  private readonly fetchImpl: typeof fetch;
  private timezone: string | null;

  constructor(private readonly options: WhitelabelCrmOptions) {
    const url = new URL(options.origin);
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error('CRM_ORIGIN must be an https address.');
    this.origin = url.origin;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timezone = options.business.timezone ?? null;
  }

  private async request<T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<T> {
    const response = await this.fetchImpl(new URL(`/api/v1/connector${path}`, this.origin), {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: { authorization: `Bearer ${this.options.apiKey}`, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!response.ok || data.ok === false) throw new CrmError(typeof data.error === 'string' ? data.error : `CRM returned HTTP ${response.status}.`, response.status);
    return data as T;
  }

  private action<T>(key: string, input: Record<string, unknown>): Promise<T> {
    return this.request<{ result: T }>('POST', '/owner/actions', { key, input, files: [] }).then((data) => data.result);
  }

  private calendar(query: Record<string, string>) {
    const search = new URLSearchParams({ calendar: this.options.calendarId, ...query });
    return this.request<{ calendar: { timezone: string; duration_min: number }; slots: { start: string }[]; appointments?: { id: string; start: string; title: string }[] }>('GET', `/owner/calendar?${search}`);
  }

  async business(): Promise<BusinessFacts> {
    // The calendar knows its own timezone and length; they win over what the environment guessed.
    const { calendar } = await this.calendar({ limit: '1' });
    this.timezone = calendar.timezone;
    return { ...this.options.business, timezone: calendar.timezone, appointmentMinutes: calendar.duration_min };
  }

  async findCallerByPhone(phone: string): Promise<Caller | null> {
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 7) return null;
    const { contacts } = await this.request<{ contacts: ContactView[] }>('GET', `/contacts?q=${encodeURIComponent(digits.slice(-10))}&limit=5`);
    // The search matches on the digits anywhere; only an exact number is this caller.
    const match = contacts.find((c) => (c.phone ?? '').replace(/\D/g, '').slice(-10) === digits.slice(-10));
    return match ? toCaller(match) : null;
  }

  async saveCaller(input: { id?: string | null; phone?: string | null; name?: string; email?: string; company?: string }): Promise<Caller> {
    const [firstName, ...rest] = (input.name ?? '').trim().split(/\s+/).filter(Boolean);
    const fields = {
      ...(input.name !== undefined ? { firstName: firstName ?? '', lastName: rest.join(' ') } : {}),
      ...(input.email !== undefined ? { email: input.email } : {}),
      ...(input.company !== undefined ? { company: input.company } : {}),
    };
    if (input.id) {
      // An edit names the version it read, so two writers cannot silently overwrite each other.
      const { contact } = await this.request<{ contact: ContactView }>('GET', `/contacts/${encodeURIComponent(input.id)}`);
      const { contact: saved } = await this.request<{ contact: ContactView }>('PATCH', `/contacts/${encodeURIComponent(input.id)}`, { expected_updated_at: contact.updated_at, fields });
      return toCaller(saved);
    }
    const created = await this.action<{ id: string }>('contacts.create', { ...fields, phone: input.phone ?? '', source: 'phone' });
    const { contact } = await this.request<{ contact: ContactView }>('GET', `/contacts/${encodeURIComponent(created.id)}`);
    return toCaller(contact);
  }

  async openSlots(input: { fromIso: string; toIso: string; limit: number }): Promise<Slot[]> {
    const { slots } = await this.calendar({ from: input.fromIso, to: input.toIso, limit: String(input.limit) });
    return slots.map((s) => ({ startIso: new Date(s.start).toISOString() }));
  }

  async appointmentsFor(callerId: string): Promise<Appointment[]> {
    const { appointments } = await this.calendar({ contact: callerId, limit: '1' });
    return (appointments ?? []).map((a) => ({ id: a.id, startIso: new Date(a.start).toISOString(), title: a.title }));
  }

  async book(input: { callerId: string; startIso: string; notes?: string }): Promise<Appointment> {
    try {
      const result = await this.action<{ id: string }>('calendar.book', { calendarId: this.options.calendarId, contactId: input.callerId, start: Date.parse(input.startIso), notes: input.notes ?? '', notify: 'on' });
      return { id: result.id, startIso: new Date(input.startIso).toISOString(), title: this.options.business.appointmentName };
    } catch (error) {
      if (error instanceof CrmError && error.status === 409) throw new SlotTaken();
      throw error;
    }
  }

  async reschedule(input: { appointmentId: string; startIso: string }): Promise<Appointment> {
    try {
      await this.action('calendar.move', { id: input.appointmentId, start: Date.parse(input.startIso), notify: 'on' });
      return { id: input.appointmentId, startIso: new Date(input.startIso).toISOString(), title: this.options.business.appointmentName };
    } catch (error) {
      if (error instanceof CrmError && error.status === 409) throw new SlotTaken();
      throw error;
    }
  }

  async cancel(input: { appointmentId: string; reason?: string }): Promise<void> {
    await this.action('calendar.cancel', { id: input.appointmentId, reason: input.reason ?? '', notify: 'on' });
  }

  async leaveMessage(input: { callerId: string | null; phone: string | null; text: string }): Promise<void> {
    const from = input.phone ? ` (${input.phone})` : '';
    // A task is what somebody will see and tick off; the note keeps the whole message on the contact.
    await this.action('contacts.task', { ...(input.callerId ? { contactId: input.callerId } : {}), title: `Phone message${from}: ${input.text}`.slice(0, 200) });
    if (input.callerId) await this.action('contacts.note', { contactId: input.callerId, body: `Message taken by the AI receptionist${from}:\n${input.text}`.slice(0, 5000) });
  }

  async recordCall(record: CallRecord): Promise<void> {
    // The CRM logs calls on a contact; a caller who never became one has nothing to log against.
    if (!record.callerId) return;
    const minutes = Math.max(1, Math.round((record.endedAt.getTime() - record.startedAt.getTime()) / 60_000));
    const lines = record.transcript.map((t) => `${t.role === 'caller' ? 'Caller' : 'Assistant'}: ${t.text}`);
    const body = [`AI receptionist · outcome: ${record.outcome} · ended: ${record.endReason}${record.language ? ` · language: ${record.language}` : ''}`, '', ...lines].join('\n');
    await this.action('contacts.logCall', { contactId: record.callerId, outcome: 'connected', minutes: String(minutes), body: body.slice(0, 5000) });
  }
}

function toCaller(c: ContactView): Caller {
  return { id: c.id, name: [c.first_name, c.last_name].filter(Boolean).join(' ') || null, company: c.company, email: c.email, phone: c.phone };
}
