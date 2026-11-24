import type { AiToolDef } from './ai/provider';
import { SlotTaken, type BusinessFacts, type Caller, type CrmPort } from './crm/port';
import { normalizeSpokenEmail } from './engine/spoken';
import { languageName, type SessionState, type VoiceTurnResult } from './engine/types';

/**
 * What the assistant can do on a call, and the rules that hold whatever the
 * model decides.
 *
 * The model chooses; this file enforces. A time is booked only if the CRM
 * says it is open, a booking needs a name on file, a caller who hid their
 * number is never looked up, and a transfer happens only when there is
 * somebody to transfer to. Every result is a short English sentence written
 * for the model, not for the caller.
 */

export const PRIMARY_LANGUAGE = 'en-US';

export interface ToolContext {
  crm: CrmPort;
  facts: BusinessFacts;
  state: SessionState;
  /** The caller as the CRM knows them right now; replaced when a tool saves details. */
  caller: Caller | null;
  /** The caller ID, or null when it was withheld. */
  phone: string | null;
  transferTo: string | null;
  /** Languages the call may be moved to, besides English. */
  languages: readonly string[];
  nowMs: number;
}

export interface ToolOutcome {
  text: string;
  action?: Exclude<VoiceTurnResult['action'], null>;
  booked?: { appointmentId: string; startAt: Date };
}

const obj = (properties: Record<string, unknown>, required: string[] = []): AiToolDef['parameters'] => ({ type: 'object', properties, required, additionalProperties: false });

export function toolDefs(ctx: Pick<ToolContext, 'phone' | 'languages'>): AiToolDef[] {
  const defs: AiToolDef[] = [
    { name: 'save_caller_details', description: "Saves the caller's name, e-mail or company. Call it as soon as they say one of them. Spell an e-mail back before saving it.", parameters: obj({ name: { type: 'string' }, email: { type: 'string' }, company: { type: 'string' } }) },
    { name: 'normalize_spoken_email', description: 'Turns an e-mail address as it was spoken ("jane dot doe at example dot com") into a written address, with a spelling you can read back.', parameters: obj({ spoken: { type: 'string' } }, ['spoken']) },
    { name: 'list_open_times', description: 'Lists open appointment times. The only source of times you may offer. Optionally from a given day.', parameters: obj({ day: { type: 'string', description: 'YYYY-MM-DD in the business timezone. Omit for the soonest times.' } }) },
    { name: 'book_appointment', description: 'Books an open time. `start` must be the bracketed value of a time list_open_times returned on this call.', parameters: obj({ start: { type: 'string', description: 'ISO instant from list_open_times.' }, notes: { type: 'string', description: 'What the caller wants to talk about.' } }, ['start']) },
    { name: 'reschedule_appointment', description: "Moves the caller's upcoming appointment to another open time from list_open_times.", parameters: obj({ start: { type: 'string' } }, ['start']) },
    { name: 'cancel_appointment', description: "Cancels the caller's upcoming appointment. Confirm with the caller first.", parameters: obj({ reason: { type: 'string' } }) },
    { name: 'leave_message_for_team', description: 'Files a message for the team when the caller wants a person, a call back, or something you cannot do.', parameters: obj({ message: { type: 'string', description: 'What the caller said and what they need, in one or two sentences.' } }, ['message']) },
    { name: 'transfer_to_human', description: 'Transfers the call to a person. Only when the caller asks for one or the matter is urgent.', parameters: obj({ reason: { type: 'string' } }, ['reason']) },
    { name: 'end_call', description: 'Ends the call after the caller has said goodbye or has nothing else.', parameters: obj({}) },
  ];
  if (ctx.phone) defs.unshift({ name: 'look_up_caller', description: "Reads who is calling from the caller ID: their name on file and any upcoming appointment.", parameters: obj({}) });
  if (ctx.languages.length) {
    defs.push({ name: 'switch_language', description: `Moves the call to another language when the caller speaks it. Allowed: ${[PRIMARY_LANGUAGE, ...ctx.languages].map((c) => `${c} (${languageName(c)})`).join(', ')}.`, parameters: obj({ code: { type: 'string' } }, ['code']) });
  }
  return defs;
}

/** A time as the caller should hear it, with the exact instant in brackets for the model to pass back. */
export function spokenTime(startIso: string, timeZone: string): string {
  const d = new Date(startIso);
  const day = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long', month: 'long', day: 'numeric' }).format(d);
  const time = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(d);
  return `${day} at ${time}`;
}

function dayRange(day: string | undefined, timeZone: string, nowMs: number): { fromIso: string; toIso: string } {
  const fortnight = 14 * 86_400_000;
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return { fromIso: new Date(nowMs).toISOString(), toIso: new Date(nowMs + fortnight).toISOString() };
  // Midnight of that day in the business timezone, found by correcting a UTC guess with the zone's offset at that instant.
  const guess = Date.parse(`${day}T00:00:00Z`);
  const local = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(guess));
  const get = (type: string) => Number(local.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'));
  const start = guess - (asUtc - guess);
  return { fromIso: new Date(Math.max(start, nowMs)).toISOString(), toIso: new Date(start + 86_400_000 - 1).toISOString() };
}

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

export async function runTool(ctx: ToolContext, name: string, input: Record<string, unknown>): Promise<ToolOutcome> {
  const { crm, facts, state } = ctx;
  switch (name) {
    case 'look_up_caller': {
      if (!ctx.phone) return { text: 'The caller ID is withheld, so there is nothing to look up. Ask for their name.' };
      const caller = ctx.caller ?? (await crm.findCallerByPhone(ctx.phone));
      if (!caller) return { text: 'Nobody is on file for this number. Ask for their name.' };
      ctx.caller = caller;
      state.lookedUp = caller.id;
      const upcoming = await crm.appointmentsFor(caller.id);
      const next = upcoming[0] ? ` Upcoming: ${upcoming[0].title}, ${spokenTime(upcoming[0].startIso, facts.timezone)}.` : ' No upcoming appointment.';
      return { text: `On file: ${caller.name ?? 'no name'}${caller.company ? `, ${caller.company}` : ''}${caller.email ? `, ${caller.email}` : ''}.${next}` };
    }
    case 'save_caller_details': {
      const patch: { name?: string; email?: string; company?: string } = {};
      if (str(input.name)) patch.name = str(input.name);
      if (str(input.company)) patch.company = str(input.company);
      if (str(input.email)) {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str(input.email))) return { text: `"${str(input.email)}" does not look like an e-mail address. Ask them to spell it.` };
        patch.email = str(input.email).toLowerCase();
      }
      if (!Object.keys(patch).length) return { text: 'Nothing to save. Give a name, an e-mail or a company.' };
      ctx.caller = await crm.saveCaller({ id: ctx.caller?.id ?? null, phone: ctx.phone, ...patch });
      state.lookedUp = ctx.caller.id;
      state.caller = { ...state.caller, ...(patch.name ? { name: patch.name } : {}), ...(patch.company ? { company: patch.company } : {}) };
      return { text: `Saved: ${Object.entries(patch).map(([k, v]) => `${k} ${v}`).join(', ')}.` };
    }
    case 'normalize_spoken_email': {
      const heard = normalizeSpokenEmail(str(input.spoken));
      return { text: heard.address ? `Written: ${heard.address}. Read it back as: ${heard.spelled}. Save it only after the caller confirms.` : 'That did not form an e-mail address. Ask them to say it again, slowly.' };
    }
    case 'list_open_times': {
      const { fromIso, toIso } = dayRange(str(input.day) || undefined, facts.timezone, ctx.nowMs);
      const slots = await crm.openSlots({ fromIso, toIso, limit: 6 });
      if (!slots.length) return { text: str(input.day) ? 'Nothing is open that day. Offer another day.' : 'Nothing is open in the next two weeks. Offer to take a message.' };
      state.offered = slots.map((s) => ({ startIso: s.startIso, spoken: spokenTime(s.startIso, facts.timezone) }));
      return { text: `Open times (offer two or three, not the whole list): ${state.offered.map((s) => `${s.spoken} [${s.startIso}]`).join('; ')}.` };
    }
    case 'book_appointment':
    case 'reschedule_appointment': {
      const start = str(input.start);
      const offered = state.offered?.find((s) => s.startIso === start);
      if (!offered) return { text: 'That time was not offered on this call. Use list_open_times and book one of its times.' };
      if (name === 'book_appointment') {
        if (!ctx.caller?.name) return { text: 'A name is needed before booking. Ask for it and save it with save_caller_details.' };
        try {
          const appointment = await crm.book({ callerId: ctx.caller.id, startIso: start, notes: str(input.notes) || undefined });
          return { text: `Booked ${facts.appointmentName} for ${offered.spoken}. Tell the caller it is confirmed.`, booked: { appointmentId: appointment.id, startAt: new Date(appointment.startIso) } };
        } catch (error) {
          if (error instanceof SlotTaken) return { text: 'That time was just taken. Use list_open_times and offer another.' };
          throw error;
        }
      }
      const current = ctx.caller ? (await crm.appointmentsFor(ctx.caller.id))[0] : undefined;
      if (!current) return { text: 'There is no upcoming appointment on file for this caller. Offer to book one.' };
      try {
        await crm.reschedule({ appointmentId: current.id, startIso: start });
        return { text: `Moved the appointment to ${offered.spoken}. Tell the caller it is confirmed.` };
      } catch (error) {
        if (error instanceof SlotTaken) return { text: 'That time was just taken. Use list_open_times and offer another.' };
        throw error;
      }
    }
    case 'cancel_appointment': {
      const current = ctx.caller ? (await crm.appointmentsFor(ctx.caller.id))[0] : undefined;
      if (!current) return { text: 'There is no upcoming appointment on file for this caller.' };
      await crm.cancel({ appointmentId: current.id, reason: str(input.reason) || undefined });
      return { text: `Canceled the appointment on ${spokenTime(current.startIso, facts.timezone)}. Tell the caller, and offer another time.` };
    }
    case 'leave_message_for_team': {
      const message = str(input.message);
      if (!message) return { text: 'Say what the message is.' };
      await crm.leaveMessage({ callerId: ctx.caller?.id ?? null, phone: ctx.phone, text: message });
      return { text: 'The team has the message. Tell the caller somebody will get back to them, without promising a time.' };
    }
    case 'transfer_to_human': {
      if (!ctx.transferTo) return { text: 'Nobody can take the call right now. Say so, and offer to take a message with leave_message_for_team.' };
      state.transferAttempts = (state.transferAttempts ?? 0) + 1;
      return { text: 'Transferring.', action: { kind: 'transfer', to: ctx.transferTo } };
    }
    case 'end_call':
      return { text: 'Ending the call.', action: { kind: 'end' } };
    case 'switch_language': {
      const code = str(input.code);
      if (code !== PRIMARY_LANGUAGE && !ctx.languages.includes(code)) return { text: `This line cannot move to ${code}. Stay in the current language.` };
      return { text: `The call is now in ${languageName(code)}. Answer in it from here on.`, action: { kind: 'language', code } };
    }
    default:
      return { text: `There is no tool called ${name}.` };
  }
}
