import { and, desc, eq } from 'drizzle-orm';
import { schema } from '../../db';
import type { Consent } from '../../db/schema';
import { manageUrl } from '../calendar/notify';
import { mergeConsent } from '../consent';
import { updateContact, type Ctx } from '../core';
import { SmsRefused, sendSms, type SendSmsInput, type SendSmsResult } from '../twilio/sms';
import type { Agent } from './config';
import type { ContactField } from './details';
import { customerOrigin } from './facts';
import type { AiToolDef } from './provider';
import { dispatch, toolDefs, type ToolCtx, type ToolOutcome } from './tools';
import { realCallerName } from '../voice/caller-name';
import { fileCallerIntake, type IntakeFiled } from '../voice/intake';
import { normalizeSpokenEmail } from '../voice/relay/spoken';
import { languageName, type CallerIntake } from '../voice/relay/types';

/**
 * The hands the receptionist has that the text agent does not.
 *
 * A phone call can be transferred, ended, or sent to voicemail; a caller can
 * say yes to texts out loud, which the CRM must write down as evidence the
 * way the website form writes it; an address said letter by letter has to
 * be turned into one before anything is sent to it; and a caller who opens
 * in Spanish has to be answered in Spanish by a voice that can say it. Seven
 * tools, each a few lines, because each one either changes what the session
 * does next or writes something that later has to stand up on its own.
 *
 * `voiceDispatch` sits in front of the ordinary dispatcher: it answers these
 * seven, routes a stray `hand_over` to the transfer (which takes the caller's
 * name and company down first, `transferToHuman`), remembers which slots
 * `list_free_slots` read out, and hands everything else through untouched.
 * The writes it makes go through `VoiceToolEnv` so a unit test can watch
 * them without a database; production uses the real functions.
 */

export const VOICE_TOOL_NAMES = [
  'transfer_to_human',
  'record_text_consent',
  'send_text_with_link',
  'normalize_spoken_email',
  'end_call',
  'leave_voicemail',
  'switch_language',
] as const;

/** The code the assistant is in when nothing has been switched: the call's primary language, always allowed back. */
export const PRIMARY_LANGUAGE = 'en-US';

/**
 * What a withheld number takes away. No number means no text and no way to
 * know who is calling, so nothing that texts, looks up, or changes a booking
 * is even described to the model.
 */
export const WITHHELD_REMOVES = ['send_text_with_link', 'record_text_consent', 'look_up_contact', 'cancel_appointment', 'reschedule_appointment'] as const;

/**
 * @param languages The extra BCP-47 codes the assistant may switch to
 *   (`settings.ai.languages`). Empty leaves `switch_language` out of the
 *   list entirely: a line that takes calls in English only should not
 *   have a tool that says otherwise.
 */
export function voiceToolDefs(languages: readonly string[] = []): AiToolDef[] {
  const defs: AiToolDef[] = [
    {
      name: 'transfer_to_human',
      description:
        'Connects the caller to a person from the team, live. Use it when they ask for a person, when something sounds like a complaint, money, anything legal or medical, or when the sources do not answer. Before calling it, unless they already told you, ask in one question for their name and the company they are with; then call it with what they said. The person picking up hears callerName, company and reason before the line connects, and the CRM files them. Say one sentence first ("one moment"), then call it; the system says the rest. If it answers that nobody can be reached, take a message with leave_message_for_team instead.',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'What they need, in a few words, the way you would tell a colleague before handing them the phone ("a quote for managing their social media", "a question about an invoice"). In English. No "the caller wants", no commentary on fit or scope.' },
          callerName: { type: 'string', description: 'Their name as they gave it on this call, or the name the CRM has them down as. "declined" if they would rather not say.' },
          company: { type: 'string', description: 'The business or organization they are with, as they said it. Empty if they did not say or it does not apply.' },
          isLead: { type: 'boolean', description: 'true when they are a prospective client asking about the services; false for an existing client, a vendor, a personal or unrelated call.' },
        },
        required: ['reason', 'callerName', 'company', 'isLead'],
        additionalProperties: false,
      },
    },
    {
      name: 'record_text_consent',
      description:
        'Writes down the caller\'s answer to "May I text you at this number?". Ask that exact question before booking or offering to text a link, and call this with what they said. Never call it with agreed=true unless they clearly said yes.',
      parameters: {
        type: 'object',
        properties: { agreed: { type: 'boolean', description: 'true when they said yes; false when they said no.' } },
        required: ['agreed'],
        additionalProperties: false,
      },
    },
    {
      name: 'send_text_with_link',
      description:
        'Texts the caller a link at the number they are calling from: the booking page, the link to move or cancel their appointment, or the website. Only after record_text_consent with agreed=true. Never read a link aloud; offer this instead.',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['booking', 'manage', 'website'], description: 'Which link: the booking page, their manage-appointment link, or the website.' },
          note: { type: 'string', description: 'One short line to go with the link, if any.' },
        },
        required: ['kind'],
        additionalProperties: false,
      },
    },
    {
      name: 'normalize_spoken_email',
      description:
        'Turns an e-mail address as the caller said it ("john dot smith at gmail dot com", "j-o-h-n at acme dot com") into a written address, and gives you the letters to read back. Call it before save_contact_details or book_appointment with an e-mail, then read the spelling back and ask "is that right?".',
      parameters: {
        type: 'object',
        properties: { spoken: { type: 'string', description: 'The address exactly as transcribed.' } },
        required: ['spoken'],
        additionalProperties: false,
      },
    },
    {
      name: 'end_call',
      description: 'Hangs up. Only after you have said goodbye, or when the caller said goodbye. The only way to end the call.',
      parameters: {
        type: 'object',
        properties: { reason: { type: 'string', description: 'One line on why the call ended, for the record.' } },
        required: ['reason'],
        additionalProperties: false,
      },
    },
    {
      name: 'leave_voicemail',
      description: 'Sends the caller to the voicemail box, when they would rather leave a recording than talk to you. Say one sentence first; the system takes it from there.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  ];
  if (languages.length) {
    /*
     * The codes are an enum rather than free text so the model cannot ask
     * for a language the voice provider has no voice for: an unknown code
     * on the wire is an error that ends the Twilio session, and the schema
     * is the cheapest place to make it impossible. English is in the enum
     * so a caller who switches back mid-call can be followed back.
     */
    const codes = [...new Set([...languages, PRIMARY_LANGUAGE])];
    defs.push({
      name: 'switch_language',
      description:
        `Switches the voice on this call to another language, and yours with it. Call it the moment the caller speaks a language other than English (you will see "[caller spoke in …]") or asks for one, before you answer; then continue in that language for the rest of the call. Available: ${codes.map((code) => `${languageName(code)} (${code})`).join(', ')}. Names, links and the business name stay as they are. Everything you write into other tools (messages for the team, notes, details) stays in English.`,
      parameters: {
        type: 'object',
        properties: { code: { type: 'string', enum: codes, description: 'The language to continue in, as one of the codes listed.' } },
        required: ['code'],
        additionalProperties: false,
      },
    });
  }
  return defs;
}

/**
 * The receptionist's whole list for one turn: the agent's tools for the
 * phone, plus the seven above, minus what the situation takes away — the
 * transfer once it has been tried or when nobody can be rung, the texting and
 * lookup tools when the number is withheld, the language switch when the
 * workspace allows no language but English.
 */
export function voiceToolList(
  agent: Agent,
  canBook: boolean,
  fields: ContactField[],
  opts: { callerWithheld: boolean; transferAttempts: number; transferTo: string | null; languages?: readonly string[] },
): AiToolDef[] {
  const removed = new Set<string>();
  if (opts.callerWithheld) for (const name of WITHHELD_REMOVES) removed.add(name);
  if (opts.transferAttempts >= 1 || !opts.transferTo) removed.add('transfer_to_human');
  return [...toolDefs(agent, canBook, fields, 'phone'), ...voiceToolDefs(opts.languages ?? [])].filter((t) => !removed.has(t.name));
}

/* ------------------------------------------------------------------------ */
/*  Running one                                                              */
/* ------------------------------------------------------------------------ */

/**
 * The writes and reads the voice tools make, behind names so a test can
 * substitute them. Production never passes this; the defaults are the real
 * functions.
 */
export interface VoiceToolEnv {
  dispatch: (ctx: ToolCtx, name: string, input: Record<string, unknown>) => Promise<ToolOutcome>;
  updateContact: (ctx: Ctx, id: string, patch: Parameters<typeof updateContact>[2]) => Promise<unknown>;
  sendSms: (ctx: ToolCtx, input: SendSmsInput) => Promise<SendSmsResult>;
  /** The caller's next appointment's manage link, or null. */
  manageLink: (ctx: ToolCtx) => Promise<string | null>;
  /**
   * The contact's consent as it is on the row right now, or null when the
   * row cannot be read. Optional so a fake env without a database falls back
   * to the snapshot the session took at admit time.
   */
  readConsent?: (ctx: ToolCtx) => Promise<Consent | null>;
  /** What `transfer_to_human` writes on the file before the call goes through (`voice/intake.ts`). */
  fileIntake: (ctx: ToolCtx, intake: CallerIntake) => Promise<IntakeFiled>;
}

export const DEFAULT_VOICE_ENV: VoiceToolEnv = {
  dispatch,
  updateContact,
  sendSms: (ctx, input) => sendSms(ctx.db, ctx.workspaceId, input),
  manageLink: async (ctx) => {
    const rows = await ctx.db
      .select({ token: schema.appointments.token, startAt: schema.appointments.startAt, status: schema.appointments.status })
      .from(schema.appointments)
      .where(and(eq(schema.appointments.workspaceId, ctx.workspaceId), eq(schema.appointments.contactId, ctx.contact.id)))
      .orderBy(desc(schema.appointments.startAt))
      .limit(5);
    const next = rows
      .filter((a) => a.startAt.getTime() > ctx.nowMs && a.status !== 'canceled')
      .sort((a, b) => a.startAt.getTime() - b.startAt.getTime())[0];
    return next ? manageUrl(customerOrigin(ctx.workspace), next.token) : null;
  },
  readConsent: async (ctx) => {
    const [row] = await ctx.db
      .select({ consent: schema.contacts.consent })
      .from(schema.contacts)
      .where(and(eq(schema.contacts.workspaceId, ctx.workspaceId), eq(schema.contacts.id, ctx.contact.id)))
      .limit(1);
    return row?.consent ?? null;
  },
  fileIntake: fileCallerIntake,
};

/** The consent record a spoken yes writes, in the shape the website form writes. */
export const VOICE_CONSENT_VERSION = 'voice-1';
export const VOICE_CONSENT_TEXT = 'Spoken yes to service texts on a call with the automated assistant';

/** One line of `list_free_slots` output: `start=<iso> — <label>`, with or without the summary indent. */
const SLOT_LINE = /start=(\S+)\s+—\s+(.+)$/;

export async function voiceDispatch(ctx: ToolCtx, name: string, input: Record<string, unknown>, env: VoiceToolEnv = DEFAULT_VOICE_ENV): Promise<ToolOutcome> {
  const voice = ctx.voice;
  if (!voice) return { text: 'This tool only exists on a phone call.', isError: true };
  try {
    switch (name) {
      // A model that reaches for the text agent's hand-over on the phone
      // means the same thing: get a person. It is answered as the transfer.
      case 'hand_over':
      case 'transfer_to_human':
        return await transferToHuman(ctx, input, env);
      case 'record_text_consent':
        return await recordTextConsent(ctx, input.agreed === true, env);
      case 'send_text_with_link':
        return await sendTextWithLink(ctx, String(input.kind ?? ''), String(input.note ?? ''), env);
      case 'normalize_spoken_email':
        return normalizeEmail(String(input.spoken ?? ''));
      case 'end_call':
        return { text: 'Ending the call now. Say nothing more.', action: { kind: 'end' } };
      case 'leave_voicemail':
        return { text: 'Sending the caller to voicemail now. Say nothing more.', action: { kind: 'voicemail' } };
      case 'switch_language':
        return switchLanguage(ctx, String(input.code ?? ''));
      default: {
        const outcome = await env.dispatch(ctx, name, input);
        if (name === 'list_free_slots' && !outcome.isError) rememberOffered(voice.state, outcome.text);
        return outcome;
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[ai/voice-tools]', name, error);
    return { text: `That did not work: ${message}`, isError: true };
  }
}

/**
 * The transfer is decided before the socket opened (`transferTo`) and tried
 * at most once per call: a second "one moment, connecting you" after the
 * team already failed to pick up is the loop the plan rules out. The refusal
 * text tells the model what to do instead, because on the phone "I cannot"
 * without an alternative is a dead line.
 *
 * Before the dial there is the intake. A call arriving without a name is
 * sent back with the question to ask, and `intakeAskedTurn` remembers on
 * which turn: a call on a later turn goes through with whatever it carries,
 * so a caller who would rather not say still reaches a person and a model
 * that asked and heard nothing is not asked to ask again; a retry on the
 * same turn is refused again, because nobody has answered yet. The name is
 * what is gated on; the company is welcome and not required, since not
 * every caller has one.
 * What was said is kept in the session state — persisted before the `end`
 * message, read by the whisper and the summary — and written on the file by
 * `fileIntake`, whose failures are words in the tool result, never a reason
 * the caller does not get their person.
 */
async function transferToHuman(ctx: ToolCtx, input: Record<string, unknown>, env: VoiceToolEnv): Promise<ToolOutcome> {
  const voice = ctx.voice!;
  const reason = String(input.reason ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!voice.transferTo) {
    return {
      text: 'Nobody from the team can be reached by phone right now. Do not say you will transfer them. Take a message with leave_message_for_team and say when someone will follow up.',
      isError: true,
    };
  }
  if (voice.state.transferAttempts >= 1) {
    return {
      text: 'The team was already tried on this call and did not pick up. Do not try again; take a message with leave_message_for_team.',
      isError: true,
    };
  }

  const said = (key: string, max: number) => String(input[key] ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  const givenName = said('callerName', 120);
  /*
   * Three things can arrive in `callerName` besides a name. An explicit
   * refusal ("declined", "prefers not to say") means the question was asked
   * and answered: no name, and no reason to ask again. A placeholder
   * ("unknown", "n/a", "none") means the model filled a required field
   * without asking: no name, and the question is still owed. Both are kept
   * off the file, the whisper and the deal title; only the second is gated.
   */
  const declined = /\b(declin|refus|rather not|prefer(s|red)? not|not (to |going to )?say|did ?n[o']?t (say|give|want)|would ?n[o']?t (say|give)|withheld|no name given|not given|not provided|not shared)/i.test(givenName);
  const placeholder = /^(unknown|none|n\/?a|null|undefined|no|-+|\?+|caller|customer|unnamed|anonymous|tbd|\.+)$/i.test(givenName);
  const name = declined || placeholder ? '' : realCallerName(givenName);
  const turn = voice.turn ?? 0;
  const askedOn = voice.state.intakeAskedTurn;
  const askedEarlier = typeof askedOn === 'number' && askedOn < turn;
  if (!name && !declined && !askedEarlier) {
    const sameTurn = askedOn === turn;
    voice.state.intakeAskedTurn = turn;
    return {
      text: sameTurn
        ? 'Still no name, and the caller has not spoken since you were told to ask. Your reply to them IS the question ("May I have your name and the company you are with, so I can let them know who is calling?"); do not call transfer_to_human again until they answer.'
        : 'Not yet: first ask, in one question, for their name and the company they are with ("May I have your name and the company you are with, so I can let them know who is calling?"). Then call transfer_to_human again with callerName, company, reason and isLead. If they already told you, use what they said; if they would rather not say, put "declined" as the name.',
      isError: true,
    };
  }

  const company = said('company', 160);
  const isLead = input.isLead === true || /^(true|yes)$/i.test(String(input.isLead ?? ''));
  const intake: CallerIntake = {
    ...(name ? { name } : {}),
    ...(company ? { company } : {}),
    ...(reason ? { wants: reason } : {}),
    lead: isLead,
  };
  // What the file already had, for the whisper only: a name from an earlier call, a company on record.
  const onFile = {
    ...(!intake.name ? { name: realCallerName([ctx.contact.firstName, ctx.contact.lastName].filter(Boolean).join(' ')) } : {}),
    ...(!intake.company ? { company: (ctx.contact.company ?? '').trim() } : {}),
  };
  const kept = Object.fromEntries(Object.entries(onFile).filter(([, v]) => v)) as CallerIntake['onFile'];
  voice.state.caller = { ...intake, ...(kept && Object.keys(kept).length ? { onFile: kept } : {}) };

  let filed = '';
  if (ctx.dry) {
    filed = ' (Test run — nothing was written on the file.)';
  } else {
    const result = await env.fileIntake(ctx, intake);
    if (result.wrote.length) filed = ` Filed on the contact: ${result.wrote.join(', ')}.`;
    if (result.failed.length) filed += ` Could not write ${result.failed.map((f) => f.split(':')[0]).join(', ')}; the transfer goes ahead anyway.`;
  }
  return {
    text: `Connecting the caller to a person now.${filed} Say nothing more.`,
    action: { kind: 'transfer', to: voice.transferTo },
    handoff: reason || 'The caller asked for a person.',
  };
}

/**
 * A spoken yes is consent the way a ticked box is consent, and it is written
 * the same way: `sms: true` with evidence saying what was agreed to, where,
 * and when — merged into the record, never written over it. `updateContact`
 * replaces `consent` wholesale (`core.ts`), so a bare `{ sms: true }` here
 * would erase an e-mail opt-in the person gave on the website last month.
 *
 * A STOP by text outranks a yes by phone: the number opted out on the
 * channel itself, and only a START on that channel brings it back.
 */
async function recordTextConsent(ctx: ToolCtx, agreed: boolean, env: VoiceToolEnv): Promise<ToolOutcome> {
  const voice = ctx.voice!;
  if (voice.callerWithheld) return { text: 'The caller withheld their number, so there is no number to text. Ask for an e-mail instead.', isError: true };
  if (!agreed) {
    voice.state.textConsentDeclined = true;
    return { text: 'Noted: no texts. Do not ask again on this call. For anything written, ask for an e-mail address.' };
  }
  // `ctx.contact` is a snapshot taken when the socket was admitted. A consent
  // written while the person is on the phone (a website form they submitted
  // during the call, a STOP text a minute ago) is only on the row, and a
  // merge into the stale snapshot would write over it. So the row is read
  // again right before the merge; the spoken yes is added to what is there now.
  const existing = (await env.readConsent?.(ctx)) ?? ctx.contact.consent ?? {};
  if (existing.smsOptOut) {
    return {
      text: 'This number opted out of texts by replying STOP. It cannot be switched back on by phone; only a START text from them can. Ask for an e-mail instead.',
      isError: true,
    };
  }
  if (ctx.contact.dnc) {
    return { text: 'This person is marked do-not-contact. Do not text them; ask for an e-mail only if they want a confirmation.', isError: true };
  }
  const at = new Date(ctx.nowMs).toISOString();
  const consent = mergeConsent(existing, {
    sms: true,
    recordedAt: at,
    smsEvidence: { version: VOICE_CONSENT_VERSION, text: VOICE_CONSENT_TEXT, source: 'voice', captured_at: at },
  });
  if (ctx.dry) return { text: '(Test run — nothing was written.) This would have recorded their yes to service texts.' };
  await env.updateContact({ db: ctx.db, workspaceId: ctx.workspaceId, actorId: null }, ctx.contact.id, { consent });
  ctx.contact.consent = consent;
  voice.state.textConsentDeclined = false;
  return { text: 'Recorded: they agreed to service texts at this number. You may now book with a text confirmation or send a link.' };
}

/**
 * The link goes by text through `sendSms`, which is the same gate a person
 * pressing Send goes through: consent, do-not-contact, a sending number. A
 * refusal comes back as words for the model, because the right next move —
 * ask, record, try again — is a conversation, not an exception.
 */
async function sendTextWithLink(ctx: ToolCtx, kind: string, note: string, env: VoiceToolEnv): Promise<ToolOutcome> {
  const voice = ctx.voice!;
  if (voice.callerWithheld) return { text: 'The caller withheld their number, so nothing can be texted. Offer to take an e-mail address.', isError: true };
  let link: string | null = null;
  let what = '';
  if (kind === 'booking') {
    link = voice.bookingUrl;
    what = 'the booking page';
    if (!link) return { text: 'There is no booking page for this calendar. Offer to book for them on this call instead.', isError: true };
  } else if (kind === 'manage') {
    link = await env.manageLink(ctx);
    what = 'the link to move or cancel their appointment';
    if (!link) return { text: 'They have no upcoming appointment, so there is no manage link to send.', isError: true };
  } else if (kind === 'website') {
    link = ctx.workspace.domainVerifiedAt && ctx.workspace.domain ? customerOrigin(ctx.workspace) : null;
    what = 'the website';
    if (!link) return { text: 'No website address is on file for this business. Offer the booking page instead, or take a message.', isError: true };
  } else {
    return { text: 'kind must be booking, manage or website.', isError: true };
  }
  const line = note.trim().slice(0, 160);
  const body = `${line ? `${line} ` : ''}${link}`;
  if (ctx.dry) return { text: `(Test run — nothing was sent.) This would have texted ${what}: ${link}` };
  try {
    const sent = await env.sendSms(ctx, { contactId: ctx.contact.id, body, actorId: null, purpose: 'service', audit: { via: 'agent', label: 'voice agent' } });
    if (!sent.ok) return { text: `The text did not go through${sent.error ? ` (${sent.error})` : ''}. Say so, and offer e-mail instead.`, isError: true };
    return { text: `Texted ${what} to the caller's number. Tell them it is on its way; do not read the link.` };
  } catch (error) {
    if (error instanceof SmsRefused) {
      return {
        text: `Not sent: ${error.message} They have not agreed to texts on this call; ask "May I text you at this number?" and call record_text_consent, then try again.`,
        isError: true,
      };
    }
    throw error;
  }
}

/**
 * The language switch is a note for the engine, not an action: an action
 * ends the tool loop (`run.ts`), and here the model must go on to write its
 * reply in the new language. So the code is left on the tool context, and
 * `runVoiceTurn` turns it into the `language` action once the reply exists;
 * the engine then tells Twilio to change the voice before speaking it.
 *
 * The codes are checked against the workspace's list even though the schema
 * already enumerates them, because a provider that ignores enums (or a
 * model that does) would otherwise put an unknown voice on the wire, and an
 * unknown voice ends the session. English is always allowed back.
 */
function switchLanguage(ctx: ToolCtx, code: string): ToolOutcome {
  const voice = ctx.voice!;
  const wanted = code.trim();
  const allowed = new Set([...(voice.languages ?? []), PRIMARY_LANGUAGE]);
  if (!allowed.has(wanted)) {
    const list = [...allowed].map((c) => `${languageName(c)} (${c})`).join(', ');
    return { text: `"${wanted.slice(0, 20)}" is not a language this line can speak. Available: ${list}. Continue in English, or in one of those.`, isError: true };
  }
  const current = voice.state.lang ?? PRIMARY_LANGUAGE;
  const label = languageName(wanted);
  if (wanted === current) {
    return { text: `The call is already in ${label}. Carry on in ${label}; no switch needed.` };
  }
  voice.langSwitch = wanted;
  const rest = 'Keep names, links and the business name as they are, and keep everything you write into other tools (messages for the team, notes, details) in English.';
  return {
    text:
      wanted === PRIMARY_LANGUAGE
        ? `Switched back to English. From now on, everything you say to the caller is in English. ${rest}`
        : `Switched to ${label}. From now on, everything you say to the caller is in ${label}, natural and spoken, as a receptionist who speaks it would. ${rest}`,
  };
}

function normalizeEmail(spoken: string): ToolOutcome {
  const { address, spelled } = normalizeSpokenEmail(spoken);
  if (!address) {
    return { text: `"${spoken.trim().slice(0, 120)}" could not be turned into an address. Ask them to say it again slowly, one part at a time: the part before the at sign, then the domain.`, isError: true };
  }
  return { text: `Address: ${address}. Read it back exactly like this and ask if it is right: ${spelled}.` };
}

/**
 * The slots the caller has heard, kept so "the nine-thirty one" resolves to
 * an exact `start` on the next turn without a second look at the calendar.
 * The prompt shows them; the engine persists them with the session state.
 */
export function rememberOffered(state: { offered?: { startIso: string; spoken: string }[] }, resultText: string): void {
  const found: { startIso: string; spoken: string }[] = [];
  for (const raw of resultText.split('\n')) {
    const m = SLOT_LINE.exec(raw.trim());
    if (m) found.push({ startIso: m[1]!, spoken: m[2]!.trim() });
  }
  if (!found.length) return;
  const seen = new Set((state.offered ?? []).map((o) => o.startIso));
  const merged = [...(state.offered ?? []), ...found.filter((f) => !seen.has(f.startIso))];
  // The prompt should not grow without bound on a long call; the last twelve read out are the ones still in play.
  state.offered = merged.slice(-12);
}
