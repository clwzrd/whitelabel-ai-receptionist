import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Db } from '../../db';
import type { CallerIntake, SessionState, Turn } from '../voice/relay/types';
import type { Agent, AiConnection } from './config';
import type { ContactField } from './details';
import type { BusinessFacts } from './facts';
import { provider as openai } from './providers/openaiCompatible';
import { installReplayFetch } from './replay';
import type { RecordInput } from './run';
import type { ToolCtx, ToolOutcome } from './tools';
import { dayMatches } from './tools';
import { DEFAULT_VOICE, switchableLanguages } from '../voice/settings';
import { fallbackSentence, runVoiceTurn, voiceHistory, type VoiceSession } from './voice';
import { VOICE_CONSENT_TEXT, rememberOffered, voiceDispatch, voiceToolList, type VoiceToolEnv } from './voice-tools';

/*
 * The voice turn without a database or a phone: the model is the replay
 * harness answering on the wire in DeepSeek's own JSON (so the provider
 * translation is the production code), the tools' writes go to fakes that
 * remember what they were asked, and the audit row is captured instead of
 * inserted. What is under test is everything between the transcript and the
 * sentence the caller hears.
 */

/* ------------------------------------------------------------------------ */
/*  History folding                                                          */
/* ------------------------------------------------------------------------ */

const SLOTS_RESULT = [
  'Calendar "Discovery", 30 minutes, times shown in America/Los_Angeles, on 2026-09-15 in the morning:',
  'start=2026-09-15T16:30:00.000Z — Tue, 09/15, 09:30 AM',
  'start=2026-09-15T18:00:00.000Z — Tue, 09/15, 11:00 AM',
  'Copy a `start` value exactly when you book. Do not offer a time that is not on this list.',
].join('\n');

test('voiceHistory: greeting dropped, tool results and notes folded into the next user turn, same roles merged', () => {
  const turns: Turn[] = [
    { role: 'assistant', text: 'Thanks for calling Acme. This is Ana, an automated assistant. How can I help?', ts: 1 },
    { role: 'user', text: 'Hi, I would like to book a discovery call on Tuesday morning.', ts: 2 },
    { role: 'assistant', text: 'I have nine thirty or eleven on Tuesday. Which works?', ts: 3, tools: [{ name: 'list_free_slots', result: SLOTS_RESULT }] },
    { role: 'system', text: 'The team did not pick up the transfer.', ts: 4 },
    { role: 'user', text: 'Nine thirty.', ts: 5 },
    { role: 'user', text: 'And yes, you can text me.', ts: 6 },
    { role: 'assistant', text: 'One second, please.', ts: 7, interrupted: true },
    { role: 'user', text: '', ts: 8, dtmf: '12' },
  ];
  const history = voiceHistory(turns);
  assert.equal(history[0]!.role, 'user', 'the first message is the caller, not the greeting');
  assert.equal(history.length, 5);
  const first = (history[0]!.content[0] as { text: string }).text;
  assert.equal(first, 'Hi, I would like to book a discovery call on Tuesday morning.');
  const second = (history[1]!.content[0] as { text: string }).text;
  assert.equal(second, 'I have nine thirty or eleven on Tuesday. Which works?');
  const third = (history[2]!.content[0] as { text: string }).text;
  assert.ok(third.startsWith('[tool results: list_free_slots: Calendar "Discovery"'), 'the tool result rides with the next user turn');
  assert.ok(third.includes('[note: The team did not pick up the transfer.]'), 'the system note is folded, not spoken');
  assert.ok(third.endsWith('Nine thirty.\nAnd yes, you can text me.'), 'two user turns in a row are one message');
  assert.equal((history[3]!.content[0] as { text: string }).text, 'One second, please. [cut off by the caller]', 'an interrupted reply says so');
  assert.equal((history[4]!.content[0] as { text: string }).text, '[pressed 12]', 'keypad digits become a user turn');
});

test('voiceHistory: a trailing note with nothing said after it becomes the caller turn', () => {
  const history = voiceHistory([
    { role: 'assistant', text: 'Hello.', ts: 1 },
    { role: 'user', text: 'Get me a person.', ts: 2 },
    { role: 'assistant', text: 'One moment.', ts: 3 },
    { role: 'system', text: 'The team did not pick up the transfer.', ts: 4 },
  ]);
  assert.equal(history[history.length - 1]!.role, 'user');
  assert.equal((history[history.length - 1]!.content[0] as { text: string }).text, '[note: The team did not pick up the transfer.]');
});

test('dayMatches: the ways a caller names the day of their appointment', () => {
  const at = new Date('2026-09-15T16:30:00Z');
  const zone = 'America/Los_Angeles';
  for (const said of ['Tuesday', 'tue', 'the 15th', 'the fifteenth', 'September 15', 'sep 15th', '9/15', '2026-09-15', 'next Tuesday morning', 'the fifteenth of the month']) {
    assert.equal(dayMatches(said, at, zone), true, said);
  }
  for (const said of ['Monday', 'the 16th', 'October 15', 'wednesday the 15th', 'Tuesday the 16th']) {
    assert.equal(dayMatches(said, at, zone), false, said);
  }
});

/* ------------------------------------------------------------------------ */
/*  Tool list                                                                */
/* ------------------------------------------------------------------------ */

const AGENT = {
  id: 'agent-1',
  workspaceId: 'ws-1',
  name: 'Ana',
  enabled: true,
  channels: ['sms'],
  persona: '',
  goal: 'Book discovery calls.',
  knowledge: 'We build websites and run ads for small businesses.',
  model: 'deepseek-flash',
  maxTokens: 1024,
  whenever: 'after_hours',
  businessHours: { start: 9, end: 17, days: [1, 2, 3, 4, 5] },
  delaySeconds: 60,
  maxTurns: 6,
  handoffKeywords: [],
  handoffMessage: '',
  canBook: true,
  canTag: false,
  canScore: false,
  bookingCalendarId: 'cal-1',
  qualifyQuestions: [],
  collectFields: [],
  handoffUserId: null,
  dailyMessageCap: 200,
  createdAt: new Date(0),
  updatedAt: new Date(0),
} as unknown as Agent;

test('voiceToolList: a withheld number takes away texting, lookup and booking changes; a tried transfer takes away the transfer', () => {
  const names = (list: { name: string }[]) => list.map((t) => t.name);
  const full = names(voiceToolList(AGENT, true, [], { callerWithheld: false, transferAttempts: 0, transferTo: '+13105550000' }));
  for (const name of ['look_up_contact', 'list_free_slots', 'book_appointment', 'reschedule_appointment', 'cancel_appointment', 'leave_message_for_team', 'save_contact_details', 'stop_messages', 'transfer_to_human', 'record_text_consent', 'send_text_with_link', 'normalize_spoken_email', 'end_call', 'leave_voicemail']) {
    assert.ok(full.includes(name), `${name} is offered`);
  }
  assert.ok(!full.includes('hand_over'), 'hand_over is replaced by transfer_to_human on the phone');

  const withheld = names(voiceToolList(AGENT, true, [], { callerWithheld: true, transferAttempts: 0, transferTo: '+13105550000' }));
  for (const name of ['send_text_with_link', 'record_text_consent', 'look_up_contact', 'cancel_appointment', 'reschedule_appointment']) {
    assert.ok(!withheld.includes(name), `${name} is not offered to a withheld number`);
  }
  assert.ok(withheld.includes('book_appointment') && withheld.includes('leave_message_for_team') && withheld.includes('transfer_to_human'));

  const tried = names(voiceToolList(AGENT, true, [], { callerWithheld: false, transferAttempts: 1, transferTo: '+13105550000' }));
  assert.ok(!tried.includes('transfer_to_human'));
  const nobody = names(voiceToolList(AGENT, true, [], { callerWithheld: false, transferAttempts: 0, transferTo: null }));
  assert.ok(!nobody.includes('transfer_to_human'));

  const cancel = voiceToolList(AGENT, true, [], { callerWithheld: false, transferAttempts: 0, transferTo: null }).find((t) => t.name === 'cancel_appointment')!;
  assert.deepEqual(cancel.parameters.required, ['confirmedName', 'confirmedDay'], 'the identity check is required on the phone');
});

test('switchableLanguages: the list the model and the engine get is the workspace’s on ElevenLabs and empty on Amazon or Google, so no switch_language tool there', () => {
  const ai = { ...DEFAULT_VOICE.ai, languages: ['es-US', 'pt-BR'] };
  assert.deepEqual(switchableLanguages({ ...ai, ttsProvider: 'ElevenLabs' }), ['es-US', 'pt-BR']);
  // The real workspace still has Amazon stored with the default five languages: the TwiML is English-only, so the model must not be offered a switch.
  assert.deepEqual(switchableLanguages({ ...ai, ttsProvider: 'Amazon' }), []);
  assert.deepEqual(switchableLanguages({ ...ai, ttsProvider: 'Google' }), []);
  assert.deepEqual(switchableLanguages(undefined), []);
  const amazon = voiceToolList(AGENT, true, [], { callerWithheld: false, transferAttempts: 0, transferTo: null, languages: switchableLanguages({ ...ai, ttsProvider: 'Amazon' }) });
  assert.ok(!amazon.some((t) => t.name === 'switch_language'), 'languages set + Amazon: no switch_language tool');
});

test('voiceToolList: switch_language is offered only when the workspace allows other languages, with English always in the enum', () => {
  const none = voiceToolList(AGENT, true, [], { callerWithheld: false, transferAttempts: 0, transferTo: null });
  assert.ok(!none.some((t) => t.name === 'switch_language'), 'an English-only line has no switch');
  const some = voiceToolList(AGENT, true, [], { callerWithheld: false, transferAttempts: 0, transferTo: null, languages: ['es-US', 'pt-BR'] });
  const tool = some.find((t) => t.name === 'switch_language');
  assert.ok(tool, 'offered when languages are set');
  const code = (tool!.parameters.properties as { code: { enum: string[] } }).code;
  assert.deepEqual(code.enum, ['es-US', 'pt-BR', 'en-US'], 'the codes the model may pick, English last as the way back');
  assert.ok(tool!.description.includes('Spanish (es-US)') && tool!.description.includes('(pt-BR)') && tool!.description.includes('English (en-US)'), 'the description names each language');
  assert.ok(tool!.description.includes('stays in English'), 'what goes into the tools stays in English');
  assert.ok(some.find((t) => t.name === 'leave_message_for_team')!.description.includes('in English, whatever language the caller is speaking'));
});

test('switch_language: validated against the workspace list, refused when already there, noted on the context and never an action', async () => {
  const state: SessionState = { transferAttempts: 0 };
  const ctx = { voice: { state, transferTo: null, callerWithheld: false, bookingUrl: null, languages: ['es-US'], langSwitch: null } } as unknown as ToolCtx;
  const env = { dispatch: async () => ({ text: 'unused' }) } as unknown as VoiceToolEnv;

  const bad = await voiceDispatch(ctx, 'switch_language', { code: 'ja-JP' }, env);
  assert.equal(bad.isError, true);
  assert.ok(bad.text.includes('Spanish (es-US)') && bad.text.includes('English (en-US)'), 'the refusal lists what is allowed');
  assert.equal(ctx.voice!.langSwitch, null);

  const same = await voiceDispatch(ctx, 'switch_language', { code: 'en-US' }, env);
  assert.equal(same.isError, undefined);
  assert.ok(same.text.includes('already in English'));
  assert.equal(ctx.voice!.langSwitch, null, 'no switch to the language the call is already in');

  const ok = await voiceDispatch(ctx, 'switch_language', { code: 'es-US' }, env);
  assert.equal(ok.isError, undefined);
  assert.equal(ok.action, undefined, 'a switch does not end the tool loop; the model still has to answer');
  assert.ok(ok.text.startsWith('Switched to Spanish.'));
  assert.ok(ok.text.includes('in English'), 'the tool text repeats that tool inputs stay in English');
  assert.equal(ctx.voice!.langSwitch, 'es-US');

  state.lang = 'es-US';
  ctx.voice!.langSwitch = null;
  const back = await voiceDispatch(ctx, 'switch_language', { code: 'en-US' }, env);
  assert.ok(back.text.startsWith('Switched back to English.'));
  assert.equal(ctx.voice!.langSwitch, 'en-US', 'the way back is always allowed');
});

test('fallbackSentence: the receptionist apologises in the language of the call, English for anything unknown', () => {
  assert.equal(fallbackSentence('lostYou', null), 'Sorry, I lost you for a second. Could you say that again?');
  assert.equal(fallbackSentence('sayAgain', 'es-US'), 'Perdón, ¿podría repetirlo?');
  assert.equal(fallbackSentence('getSomeone', 'pt-BR'), 'Vou chamar alguém da equipe para responder isso direito.');
  assert.ok(fallbackSentence('optOutDone', 'fr-FR').startsWith("C'est fait"));
  assert.ok(fallbackSentence('lostYou', 'de-DE').startsWith('Entschuldigung'));
  assert.ok(fallbackSentence('sayAgain', 'it-IT').startsWith('Scusi'));
  assert.equal(fallbackSentence('sayAgain', 'ja-JP'), 'Sorry, could you say that again?');
});

test('rememberOffered: the slots read out are kept with the exact start to copy', () => {
  const state: SessionState = { transferAttempts: 0 };
  rememberOffered(state, SLOTS_RESULT);
  assert.deepEqual(state.offered, [
    { startIso: '2026-09-15T16:30:00.000Z', spoken: 'Tue, 09/15, 09:30 AM' },
    { startIso: '2026-09-15T18:00:00.000Z', spoken: 'Tue, 09/15, 11:00 AM' },
  ]);
  rememberOffered(state, '  start=2026-09-15T18:00:00.000Z — Tue, 09/15, 11:00 AM\n  start=2026-09-16T16:00:00.000Z — Wed, 09/16, 09:00 AM');
  assert.equal(state.offered!.length, 3, 'a slot read out twice is kept once');
});

/* ------------------------------------------------------------------------ */
/*  A full turn                                                              */
/* ------------------------------------------------------------------------ */

const WORKSPACE = {
  id: 'ws-1',
  name: 'Acme Plumbing',
  slug: 'acme',
  timezone: 'America/Los_Angeles',
  settings: {},
  brand: {},
  domain: null,
  domainVerifiedAt: null,
} as unknown as VoiceSession['workspace'];

const CONNECTION: AiConnection = {
  settings: {
    provider: 'openai_compatible',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    priceIn: 0.28,
    priceOut: 0.42,
    priceCacheRead: 0.028,
    dailyCostCapCents: 0,
    check: null,
  },
  apiKey: 'sk-replay',
  keySource: 'workspace',
  enabled: true,
  lastError: null,
};

const FACTS: BusinessFacts = {
  hours: { start: 9, end: 17, days: [1, 2, 3, 4, 5] },
  timezone: 'America/Los_Angeles',
  bookingUrl: 'https://crm.example.com/book/acme/discovery',
  email: null,
};

function contactRow() {
  return {
    id: 'contact-1',
    workspaceId: 'ws-1',
    firstName: 'Maria',
    lastName: 'Lopez',
    email: 'maria@example.com',
    phone: '+13105551234',
    company: null,
    source: 'call',
    tags: [],
    custom: {},
    consent: { email: true, recordedAt: '2026-08-01T00:00:00.000Z' },
    dnc: false,
    timezone: null,
  } as unknown as VoiceSession['contact'];
}

interface Harness {
  session: VoiceSession;
  updates: { id: string; patch: Record<string, unknown> }[];
  runs: RecordInput[];
  dispatched: { name: string; input: Record<string, unknown> }[];
  /** What `transfer_to_human` asked to be written on the file, per call. */
  intakes: CallerIntake[];
}

function harness(overrides: Partial<VoiceSession> = {}, dispatchFake?: (ctx: ToolCtx, name: string, input: Record<string, unknown>) => Promise<ToolOutcome>): Harness {
  const updates: Harness['updates'] = [];
  const runs: RecordInput[] = [];
  const dispatched: Harness['dispatched'] = [];
  const intakes: CallerIntake[] = [];
  const env: VoiceToolEnv = {
    fileIntake: async (_ctx, intake) => {
      intakes.push(intake);
      return { wrote: intake.name ? ['name'] : [], failed: [] };
    },
    dispatch: async (ctx, name, input) => {
      dispatched.push({ name, input });
      if (dispatchFake) return dispatchFake(ctx, name, input);
      return { text: `There is no fake for ${name}.`, isError: true };
    },
    updateContact: async (_ctx, id, patch) => {
      updates.push({ id, patch: patch as Record<string, unknown> });
    },
    sendSms: async () => ({ ok: true, messageId: 'm-1', conversationId: 'c-1', providerId: 'SM1', segments: 1 }),
    manageLink: async () => null,
  };
  const session: VoiceSession = {
    db: {} as Db,
    workspace: WORKSPACE,
    agent: AGENT,
    connection: CONNECTION,
    provider: openai,
    contact: contactRow(),
    fields: [] as ContactField[],
    facts: FACTS,
    call: { id: 'call-1', providerId: 'CA123', fromNumber: '+13105551234', conversationId: 'conv-1', workspaceId: 'ws-1' },
    teamLang: 'en',
    transferTo: '+13105550000',
    greeting: 'Hi, thanks for calling Acme Plumbing. This is Ana, the AI assistant. How can I help you today?',
    persona: 'Ana',
    languages: ['es-US', 'pt-BR'],
    maxTurns: 30,
    callerWithheld: false,
    dry: false,
    env,
    recordRun: async (input) => {
      runs.push(input);
      return `run-${runs.length}`;
    },
    ...overrides,
  };
  return { session, updates, runs, dispatched, intakes };
}

const BOOKING_HISTORY: Turn[] = [
  { role: 'assistant', text: 'Thanks for calling Acme Plumbing. This is Ana, an automated assistant. How can I help?', ts: 1 },
  { role: 'user', text: 'Hi, I would like to book a discovery call on Tuesday morning.', ts: 2 },
  {
    role: 'assistant',
    text: 'I have nine thirty AM or eleven AM on Tuesday, September fifteenth. Which works for you? And may I text you at this number?',
    ts: 3,
    tools: [{ name: 'list_free_slots', result: SLOTS_RESULT }],
  },
  { role: 'user', text: 'Nine thirty, and yes you can text me.', ts: 4 },
];

test('a full turn: consent is recorded by merge, the booking goes through, the reply is spoken and the run is stamped voice', async () => {
  const h = harness({}, async (_ctx, name, input) => {
    if (name === 'book_appointment') {
      assert.equal(input.start, '2026-09-15T16:30:00.000Z');
      return {
        text: 'Booked. Discovery at 2026-09-15T16:30:00.000Z (America/Los_Angeles). The confirmation went out by text. Tell them in one sentence and stop.',
        booked: { appointmentId: 'appt-1', startAt: new Date('2026-09-15T16:30:00.000Z') },
      };
    }
    return { text: `There is no fake for ${name}.`, isError: true };
  });
  const replay = installReplayFetch('openai', 'deepseek-flash', [
    {
      toolCalls: [
        { name: 'record_text_consent', input: { agreed: true } },
        { name: 'book_appointment', input: { start: '2026-09-15T16:30:00.000Z', notes: 'Discovery call, Tuesday morning' } },
      ],
    },
    { text: "You're all set for Tuesday at nine thirty AM, and the confirmation is on its way by text. Anything else I can help with?" },
  ]);
  const state: SessionState = { transferAttempts: 0, offered: [{ startIso: '2026-09-15T16:30:00.000Z', spoken: 'nine thirty AM on Tuesday, September fifteenth' }] };
  const onRound: number[] = [];
  try {
    const result = await runVoiceTurn(h.session, {
      history: BOOKING_HISTORY,
      state,
      turn: 2,
      budgetMs: 60_000,
      nowMs: Date.parse('2026-09-14T17:00:00Z'),
      onRound: (n) => onRound.push(n),
    });

    assert.equal(result.reply, "You're all set for Tuesday at nine thirty AM, and the confirmation is on its way by text. Anything else I can help with?");
    assert.equal(result.action, null);
    assert.deepEqual(result.booked, { appointmentId: 'appt-1', startAt: new Date('2026-09-15T16:30:00.000Z') });
    assert.equal(result.runId, 'run-1');
    assert.ok(result.costUsd > 0, 'the turn is priced from the tokens');
    assert.deepEqual(onRound, [1, 2], 'the engine is told before each model round');

    // Consent: merged into the record, the e-mail opt-in from the website survives.
    assert.equal(h.updates.length, 1);
    const consent = h.updates[0]!.patch.consent as Record<string, unknown>;
    assert.equal(consent.sms, true);
    assert.equal(consent.email, true, 'a bare { sms: true } would have erased this');
    assert.deepEqual((consent.smsEvidence as { source: string; text: string }).source, 'voice');
    assert.equal((consent.smsEvidence as { text: string }).text, VOICE_CONSENT_TEXT);
    assert.equal(h.session.contact.consent.sms, true, 'the in-memory contact sees it for the rest of the call');

    // The booking went to the ordinary dispatcher, after the consent.
    assert.deepEqual(h.dispatched.map((d) => d.name), ['book_appointment']);

    // The audit row.
    assert.equal(h.runs.length, 1);
    const run = h.runs[0]!;
    assert.equal(run.decision, 'booked');
    assert.equal(run.conversationId, 'conv-1');
    assert.equal(run.messageId, null);
    const prompt = run.prompt as Record<string, unknown>;
    assert.equal(prompt.kind, 'voice');
    assert.equal(prompt.callId, 'call-1');
    assert.equal(prompt.callSid, 'CA123');
    assert.equal(prompt.turn, 2);
    assert.equal(typeof prompt.costUsd, 'number');
    const system = prompt.system as { fixed: unknown; variable: string };
    assert.equal(typeof (system.fixed as { sha256: string }).sha256, 'string', 'after turn 1 the fixed half is a fingerprint');
    assert.ok(system.variable.includes('Times you already offered'), 'the offered slots are in the variable prompt');
    assert.ok(system.variable.includes("Caller's number: +13105551234"));
    assert.equal(run.toolCalls?.length, 2);

    // What went over the wire: the phone tool list, the caller first, the tool result folded in.
    assert.equal(replay.log.calls.length, 2);
    const first = replay.log.calls[0]!.body as { messages: { role: string; content: string }[]; tools: { function: { name: string } }[] };
    const toolNames = first.tools.map((t) => t.function.name);
    assert.ok(toolNames.includes('record_text_consent') && toolNames.includes('transfer_to_human') && toolNames.includes('end_call'));
    assert.ok(!toolNames.includes('hand_over'));
    assert.equal(first.messages[0]!.role, 'system');
    assert.ok(first.messages[0]!.content.includes('You are on a phone call.'), 'the voice branch of the prompt');
    const fixedHalf = first.messages[0]!.content;
    assert.ok(fixedHalf.startsWith('You are Ana, the AI assistant answering the phone for Acme Plumbing.'), 'the persona from the voice settings, not the text agent\'s name');
    assert.ok(fixedHalf.includes("say you're an AI assistant; never claim to be a person"), 'the disclosure survives the warmer prompt');
    assert.ok(fixedHalf.includes('contractions, short sentences, one idea per turn'), 'the receptionist voice');
    assert.ok(fixedHalf.includes('# Language') && fixedHalf.includes('You may switch to: Spanish (es-US), ') && fixedHalf.includes('(pt-BR)'), 'the language policy lists what the workspace allows');
    assert.ok(fixedHalf.includes('call switch_language first') && fixedHalf.includes('stays in English, whatever language the call is in'));
    for (const rule of ['record_text_consent BEFORE booking', 'Never read back an e-mail, company or appointment already on file', 'ask for the name on the booking and the day', 'never guess a time, a price or a name', 'End the call only with end_call', 'offer to text the link instead']) {
      assert.ok(fixedHalf.includes(rule), `safety rule kept: ${rule}`);
    }
    assert.ok(!fixedHalf.includes('The call is in'), 'no language line while the call is in English');
    assert.equal(first.messages[1]!.role, 'user', 'the greeting is not the first message');
    assert.ok(first.messages[3]!.content.startsWith('[tool results: list_free_slots:'), 'the slots ride with the caller turn');
    const second = replay.log.calls[1]!.body as { messages: { role: string }[] };
    assert.equal(second.messages.filter((m) => m.role === 'tool').length, 2, 'both tool results went back');
  } finally {
    replay.restore();
  }
  assert.equal(replay.log.remaining, 0, 'the script was used up');
});

test('a caller who says "stop": the confirmation is spoken and the call ends, with no SMS', async () => {
  const h = harness({}, async (_ctx, name) => {
    if (name === 'stop_messages') {
      return { text: 'Done: they are marked do-not-contact.', handoff: 'They asked to stop being messaged.', optOut: true };
    }
    return { text: `There is no fake for ${name}.`, isError: true };
  });
  const replay = installReplayFetch('openai', 'deepseek-flash', [{ toolCalls: [{ name: 'stop_messages', input: { words: 'take me off your list' } }] }]);
  try {
    const result = await runVoiceTurn(h.session, {
      history: [...BOOKING_HISTORY.slice(0, 2), { role: 'user', text: 'Actually, take me off your list.', ts: 9 }],
      state: { transferAttempts: 0 },
      turn: 1,
      budgetMs: 60_000,
      nowMs: Date.now(),
    });
    assert.deepEqual(result.action, { kind: 'end' });
    assert.equal(result.reply, "Done — you won't get any more messages from us.");
    assert.equal(h.runs[0]!.decision, 'handoff');
    assert.equal(typeof (h.runs[0]!.prompt as { system: { fixed: unknown } }).system.fixed, 'string', 'turn 1 writes the fixed half whole');
  } finally {
    replay.restore();
  }
});

test('transfer_to_human: the action carries the number decided before the socket opened, and a second try is refused', async () => {
  const h = harness();
  const replay = installReplayFetch('openai', 'deepseek-flash', [
    {
      text: 'One moment, I will connect you.',
      toolCalls: [{ name: 'transfer_to_human', input: { reason: 'Wants to talk about an invoice.', callerName: 'Maria Lopez', company: 'Lopez Dental', isLead: false } }],
    },
  ]);
  try {
    const state: SessionState = { transferAttempts: 0 };
    const result = await runVoiceTurn(h.session, {
      history: [...BOOKING_HISTORY.slice(0, 2), { role: 'user', text: 'I need to talk to someone about my invoice.', ts: 9 }],
      state,
      turn: 1,
      budgetMs: 60_000,
      nowMs: Date.now(),
    });
    assert.deepEqual(result.action, { kind: 'transfer', to: '+13105550000' });
    assert.equal(result.reply, 'One moment, I will connect you.');
    assert.equal(h.runs[0]!.decision, 'handoff');
    assert.equal(h.runs[0]!.reason, 'Wants to talk about an invoice.');
    // What the colleague hears and the file gets is on the state, persisted before the end message.
    assert.deepEqual(result.state.caller, { name: 'Maria Lopez', company: 'Lopez Dental', wants: 'Wants to talk about an invoice.', lead: false });
    assert.deepEqual(h.intakes, [{ name: 'Maria Lopez', company: 'Lopez Dental', wants: 'Wants to talk about an invoice.', lead: false }]);
  } finally {
    replay.restore();
  }

  const again = installReplayFetch('openai', 'deepseek-flash', [
    { toolCalls: [{ name: 'transfer_to_human', input: { reason: 'Still wants a person.' } }] },
    { text: 'I am sorry, nobody is picking up right now. I can take a message for the team instead.' },
  ]);
  try {
    const result = await runVoiceTurn(h.session, {
      history: [...BOOKING_HISTORY.slice(0, 2), { role: 'system', text: 'The team did not pick up the transfer.', ts: 10 }, { role: 'user', text: 'Try them again.', ts: 11 }],
      state: { transferAttempts: 1 },
      turn: 2,
      budgetMs: 60_000,
      nowMs: Date.now(),
    });
    assert.equal(result.action, null, 'the refused transfer is words for the model, not an action');
    assert.ok(result.reply.includes('take a message'));
    const first = again.log.calls[0]!.body as { tools: { function: { name: string } }[]; messages: { role: string; content: string }[] };
    assert.ok(!first.tools.some((t) => t.function.name === 'transfer_to_human'), 'the tool is not even offered after a failed transfer');
    assert.ok(first.messages[0]!.content.includes('The team did not pick up the transfer; offer to take a message.'));
  } finally {
    again.restore();
  }
});

test('transfer_to_human without a name is sent back with the question until the caller has had a turn; a decline or a later turn goes through', async () => {
  const state: SessionState = { transferAttempts: 0 };
  const intakes: CallerIntake[] = [];
  const ctx = {
    contact: contactRow(),
    dry: false,
    voice: { state, transferTo: '+13105550000', callerWithheld: false, bookingUrl: null, languages: [], langSwitch: null, turn: 2 },
  } as unknown as ToolCtx;
  const env = {
    dispatch: async () => ({ text: 'unused' }),
    fileIntake: async (_ctx: ToolCtx, intake: CallerIntake) => {
      intakes.push(intake);
      return { wrote: [], failed: [] };
    },
  } as unknown as VoiceToolEnv;

  const first = await voiceDispatch(ctx, 'transfer_to_human', { reason: 'Wants a person.' }, env);
  assert.equal(first.isError, true);
  assert.equal(first.action, undefined, 'no dial until the question was asked');
  assert.ok(first.text.includes('May I have your name and the company'), first.text);
  assert.equal(state.intakeAskedTurn, 2);
  assert.deepEqual(intakes, []);

  // A retry inside the same turn, with a placeholder for a name: the caller has not spoken. Refused again, sharper.
  for (const filler of ['unknown', 'N/A', 'none', '']) {
    const retry = await voiceDispatch(ctx, 'transfer_to_human', { reason: 'Wants a person.', callerName: filler, company: '', isLead: true }, env);
    assert.equal(retry.isError, true, `"${filler}" is not a name and nobody answered yet`);
    assert.equal(retry.action, undefined);
    assert.ok(retry.text.includes('Your reply to them IS the question'), retry.text);
  }
  assert.deepEqual(intakes, []);

  // Next turn: the model asked; the caller would rather not say. The transfer goes ahead, nameless.
  ctx.voice!.turn = 3;
  const second = await voiceDispatch(ctx, 'transfer_to_human', { reason: 'Wants a person.', callerName: 'declined', company: '', isLead: false }, env);
  assert.deepEqual(second.action, { kind: 'transfer', to: '+13105550000' });
  assert.deepEqual(intakes, [{ wants: 'Wants a person.', lead: false }]);
  // The whisper still names whoever the file has; the summary will not say the caller gave it.
  assert.deepEqual(state.caller, { wants: 'Wants a person.', lead: false, onFile: { name: 'Maria Lopez' } });

  // A later turn with nothing at all: asked already, nobody answered with a name — no second interrogation.
  const later: SessionState = { transferAttempts: 0, intakeAskedTurn: 1 };
  ctx.voice!.state = later;
  const third = await voiceDispatch(ctx, 'transfer_to_human', { reason: 'Still wants a person.' }, env);
  assert.deepEqual(third.action, { kind: 'transfer', to: '+13105550000' });

  // A refusal in words is a refusal, not a name; on the first call it even skips the question.
  const fresh: SessionState = { transferAttempts: 0 };
  ctx.voice!.state = fresh;
  const before = intakes.length;
  for (const words of ['Declined to say', 'Prefers not to say', 'did not give a name', 'Would rather not say']) {
    const out = await voiceDispatch(ctx, 'transfer_to_human', { reason: 'A quote.', callerName: words, company: 'Acme', isLead: true }, env);
    assert.deepEqual(out.action, { kind: 'transfer', to: '+13105550000' }, words);
    assert.equal(fresh.intakeAskedTurn, undefined, 'a decline means the question was asked');
    const last: CallerIntake = intakes[intakes.length - 1]!;
    assert.equal(last.name, undefined, `"${words}" never reaches the file`);
    assert.equal(last.company, 'Acme');
  }
  assert.equal(intakes.length, before + 4);
});

test('transfer_to_human: a caller-ID label on the file is not a name, and isLead may arrive as a string', async () => {
  const state: SessionState = { transferAttempts: 0 };
  const intakes: CallerIntake[] = [];
  const ctx = {
    contact: { ...contactRow(), firstName: 'WIRELESS', lastName: 'CALLER', company: null },
    dry: false,
    voice: { state, transferTo: '+13105550000', callerWithheld: false, bookingUrl: null, languages: [], langSwitch: null, turn: 2 },
  } as unknown as ToolCtx;
  const env = {
    dispatch: async () => ({ text: 'unused' }),
    fileIntake: async (_ctx: ToolCtx, intake: CallerIntake) => {
      intakes.push(intake);
      return { wrote: ['name'], failed: [] };
    },
  } as unknown as VoiceToolEnv;
  const out = await voiceDispatch(ctx, 'transfer_to_human', { reason: 'A quote for HVAC ads.', callerName: 'Ann Lee', company: '', isLead: 'true' }, env);
  assert.deepEqual(out.action, { kind: 'transfer', to: '+13105550000' });
  assert.deepEqual(state.caller, { name: 'Ann Lee', wants: 'A quote for HVAC ads.', lead: true }, 'no onFile: the label is not a name worth whispering');
  assert.equal(intakes[0]!.lead, true);

  // Nothing given and only the label on file: the whisper names nobody rather than "WIRELESS CALLER".
  const again: SessionState = { transferAttempts: 0, intakeAskedTurn: 1 };
  ctx.voice!.state = again;
  await voiceDispatch(ctx, 'transfer_to_human', { reason: 'A quote.', callerName: 'declined', company: '', isLead: false }, env);
  assert.deepEqual(again.caller, { wants: 'A quote.', lead: false });
});

test('transfer_to_human: a stray hand_over on the phone is the same intake, and a lead is filed as one', async () => {
  const state: SessionState = { transferAttempts: 0 };
  const intakes: CallerIntake[] = [];
  const ctx = {
    contact: { ...contactRow(), firstName: '', lastName: '', company: null },
    dry: false,
    voice: { state, transferTo: '+13105550000', callerWithheld: false, bookingUrl: null, languages: [], langSwitch: null },
  } as unknown as ToolCtx;
  const env = {
    dispatch: async () => ({ text: 'unused' }),
    fileIntake: async (_ctx: ToolCtx, intake: CallerIntake) => {
      intakes.push(intake);
      return { wrote: ['name', 'company', 'lead tag', 'deal', 'note'], failed: [] };
    },
  } as unknown as VoiceToolEnv;

  const refused = await voiceDispatch(ctx, 'hand_over', { reason: 'Asking about the program.' }, env);
  assert.equal(refused.isError, true, 'hand_over on the phone is gated the same way');
  ctx.voice!.turn = (ctx.voice!.turn ?? 0) + 1;

  const out = await voiceDispatch(
    ctx,
    'hand_over',
    { reason: 'Wants help running Facebook and Instagram for the church.', callerName: ' Dana  Carter ', company: 'Riverside Community Church', isLead: true },
    env,
  );
  assert.deepEqual(out.action, { kind: 'transfer', to: '+13105550000' });
  assert.equal(out.handoff, 'Wants help running Facebook and Instagram for the church.');
  assert.ok(out.text.includes('Filed on the contact: name, company, lead tag, deal, note.'), out.text);
  assert.deepEqual(intakes, [{ name: 'Dana Carter', company: 'Riverside Community Church', wants: 'Wants help running Facebook and Instagram for the church.', lead: true }]);
  assert.deepEqual(state.caller, intakes[0]);
});

test('transfer_to_human: a filing that fails is words in the result, and the caller still gets a person', async () => {
  const state: SessionState = { transferAttempts: 0 };
  const ctx = {
    contact: contactRow(),
    dry: false,
    voice: { state, transferTo: '+13105550000', callerWithheld: false, bookingUrl: null, languages: [], langSwitch: null },
  } as unknown as ToolCtx;
  const env = {
    dispatch: async () => ({ text: 'unused' }),
    fileIntake: async () => ({ wrote: ['company'], failed: ['deal: This workspace has no pipeline.'] }),
  } as unknown as VoiceToolEnv;
  const out = await voiceDispatch(ctx, 'transfer_to_human', { reason: 'Wants a quote.', callerName: 'Maria Lopez', company: 'Lopez Dental', isLead: true }, env);
  assert.deepEqual(out.action, { kind: 'transfer', to: '+13105550000' });
  assert.ok(out.text.includes('Filed on the contact: company.'), out.text);
  assert.ok(out.text.includes('Could not write deal; the transfer goes ahead anyway.'), out.text);

  const dry = { ...ctx, dry: true, voice: { ...ctx.voice!, state: { transferAttempts: 0 } } } as ToolCtx;
  assert.ok(dry.voice!.turn === undefined, 'direct dispatch has no turn; the name given below is what lets it through');
  const env2 = { ...env, fileIntake: async () => assert.fail('a test run writes nothing') } as unknown as VoiceToolEnv;
  const trial = await voiceDispatch(dry, 'transfer_to_human', { reason: 'Wants a quote.', callerName: 'Maria Lopez', company: '', isLead: false }, env2);
  assert.deepEqual(trial.action, { kind: 'transfer', to: '+13105550000' });
  assert.ok(trial.text.includes('Test run'), trial.text);
});

test('the prompt tells the model to take name and company before a transfer, and whether a company is already on file', async () => {
  const h = harness({ contact: { ...contactRow(), company: 'Lopez Dental' } });
  const replay = installReplayFetch('openai', 'deepseek-flash', [{ text: 'Sure. May I have your name, so I can let them know who is calling?' }]);
  try {
    await runVoiceTurn(h.session, {
      history: [...BOOKING_HISTORY.slice(0, 2), { role: 'user', text: 'Can I talk to a person?', ts: 9 }],
      state: { transferAttempts: 0 },
      turn: 1,
      budgetMs: 60_000,
      nowMs: Date.now(),
    });
    const body = replay.log.calls[0]!.body as { messages: { role: string; content: string }[]; tools: { function: { name: string; parameters: { required: string[] } } }[] };
    const system = body.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    assert.ok(system.includes('ask in one question for their name and the company they are with'), 'the rule is in the fixed half');
    assert.ok(system.includes('# Transfer to a person when'), 'the heading no longer says "at once"');
    assert.ok(system.includes('A company is on file for this caller (do not read it back)'), 'the variable half says the file has a company');
    assert.ok(!system.includes('Lopez Dental'), 'the company itself stays off the prompt');
    const transfer = body.tools.find((t) => t.function.name === 'transfer_to_human')!;
    assert.deepEqual(transfer.function.parameters.required, ['reason', 'callerName', 'company', 'isLead']);
  } finally {
    replay.restore();
  }
});

test('a withheld number: the texting and lookup tools are gone and the prompt says so', async () => {
  const h = harness({ callerWithheld: true, call: { id: 'call-2', providerId: 'CA456', fromNumber: 'anonymous', conversationId: null, workspaceId: 'ws-1' } });
  const replay = installReplayFetch('openai', 'deepseek-flash', [{ text: 'Happy to help. What number can the team call you back on?' }]);
  try {
    const result = await runVoiceTurn(h.session, {
      history: [BOOKING_HISTORY[0]!, { role: 'user', text: 'Can someone call me back?', ts: 2 }],
      state: { transferAttempts: 0 },
      turn: 1,
      budgetMs: 60_000,
      nowMs: Date.now(),
    });
    assert.equal(result.action, null);
    const body = replay.log.calls[0]!.body as { tools: { function: { name: string } }[]; messages: { role: string; content: string }[] };
    const names = body.tools.map((t) => t.function.name);
    for (const gone of ['send_text_with_link', 'record_text_consent', 'look_up_contact', 'cancel_appointment', 'reschedule_appointment']) assert.ok(!names.includes(gone), gone);
    assert.ok(body.messages[0]!.content.includes("Caller's number: withheld."));
    assert.ok(!body.messages[0]!.content.includes('Maria'), 'the shared anonymous contact is not greeted by name');
  } finally {
    replay.restore();
  }
});

test('the model out of reach: an apology, a failed run, and the call goes on', async () => {
  const h = harness();
  const real = globalThis.fetch;
  // A provider that never answers; only the abort ends the wait.
  globalThis.fetch = ((_url: unknown, init?: RequestInit) =>
    new Promise((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    })) as typeof fetch;
  try {
    const started = Date.now();
    const result = await runVoiceTurn(h.session, {
      history: [BOOKING_HISTORY[0]!, { role: 'user', text: 'Are you open on Saturdays?', ts: 2 }],
      state: { transferAttempts: 0 },
      turn: 1,
      // 8.5 s of budget minus the 8 s floor leaves half a second for the request.
      budgetMs: 8_500,
      nowMs: Date.now(),
    });
    assert.ok(Date.now() - started < 5_000, 'the turn gave up on the budget, not on the provider');
    assert.equal(result.reply, 'Sorry, I lost you for a second. Could you say that again?');
    assert.equal(result.action, null);
    assert.equal(h.runs[0]!.decision, 'failed');
    assert.ok(String(h.runs[0]!.error).includes('No answer within'));

    // The same failure on a call already in Spanish apologises in Spanish.
    const spanish = await runVoiceTurn(h.session, {
      history: [BOOKING_HISTORY[0]!, { role: 'user', text: '¿Abren los sábados?', ts: 2 }],
      state: { transferAttempts: 0, lang: 'es-US' },
      turn: 2,
      budgetMs: 8_500,
      nowMs: Date.now(),
    });
    assert.equal(spanish.reply, 'Perdón, le perdí un segundo. ¿Podría repetirlo?');
    assert.equal(spanish.action, null, 'no switch: the call was already in Spanish');
  } finally {
    globalThis.fetch = real;
  }
});

test('a caller who speaks Spanish: switch_language becomes the language action, the reply is spoken as written, and the next turn is told to stay in Spanish', async () => {
  const h = harness();
  const replay = installReplayFetch('openai', 'deepseek-flash', [
    { toolCalls: [{ name: 'switch_language', input: { code: 'es-US' } }] },
    { text: 'Claro, con gusto. ¿Para qué día le gustaría la llamada?' },
  ]);
  const state: SessionState = { transferAttempts: 0, langHint: 'es' };
  try {
    const result = await runVoiceTurn(h.session, {
      history: [BOOKING_HISTORY[0]!, { role: 'user', text: '[caller spoke in Spanish]\nHola, quisiera agendar una llamada.', ts: 2 }],
      state,
      turn: 1,
      budgetMs: 60_000,
      nowMs: Date.now(),
    });
    assert.deepEqual(result.action, { kind: 'language', code: 'es-US' }, 'the engine is asked to move the voice');
    assert.equal(result.language, 'es-US', 'and the switch rides on the result as well, for the turns where the action slot is taken');
    assert.equal(result.reply, 'Claro, con gusto. ¿Para qué día le gustaría la llamada?');
    assert.equal(result.state.lang, undefined, 'the tool does not stamp the state; the engine does, once the language message is sent');
    assert.equal(h.runs[0]!.decision, 'reply');
    assert.deepEqual(result.tools?.map((t) => t.name), ['switch_language']);
    assert.ok(result.tools![0]!.result.startsWith('Switched to Spanish.'));
    const second = replay.log.calls[1]!.body as { messages: { role: string; content: string }[] };
    assert.ok(second.messages.some((m) => m.role === 'tool' && m.content.startsWith('Switched to Spanish.')), 'the model saw the switch before writing');
  } finally {
    replay.restore();
  }

  // The turn after the engine stamped the state: the variable prompt keeps it in Spanish, and no second switch is asked for.
  const again = installReplayFetch('openai', 'deepseek-flash', [{ text: 'Perfecto, el martes por la mañana. ¿Le puedo enviar un mensaje de texto a este número?' }]);
  try {
    const result = await runVoiceTurn(h.session, {
      history: [BOOKING_HISTORY[0]!, { role: 'user', text: 'Hola, quisiera agendar una llamada.', ts: 2 }, { role: 'assistant', text: 'Claro, con gusto. ¿Para qué día le gustaría la llamada?', ts: 3 }, { role: 'user', text: 'El martes por la mañana.', ts: 4 }],
      state: { transferAttempts: 0, lang: 'es-US', langHint: 'es' },
      turn: 2,
      budgetMs: 60_000,
      nowMs: Date.now(),
    });
    assert.equal(result.action, null, 'already in Spanish: nothing for the engine to switch');
    assert.equal(result.language, null);
    const body = again.log.calls[0]!.body as { messages: { role: string; content: string }[] };
    assert.ok(body.messages[0]!.content.includes('The call is in Spanish (es-US) now: keep speaking Spanish. What you write into tools stays in English. If the caller goes back to English — you will see "[caller spoke in English]" on their line — call switch_language with en-US and continue in English.'));
  } finally {
    again.restore();
  }
});

test('switch_language and end_call in one turn: the end keeps the action slot and the switch travels as `language`', async () => {
  const h = harness();
  const replay = installReplayFetch('openai', 'deepseek-flash', [
    { text: '¡Gracias por llamar, hasta luego!', toolCalls: [{ name: 'switch_language', input: { code: 'es-US' } }, { name: 'end_call', input: {} }] },
  ]);
  try {
    const result = await runVoiceTurn(h.session, {
      history: [BOOKING_HISTORY[0]!, { role: 'user', text: '[caller spoke in Spanish]\nNo, gracias, adiós.', ts: 2 }],
      state: { transferAttempts: 0, langHint: 'es' },
      turn: 1,
      budgetMs: 60_000,
      nowMs: Date.now(),
    });
    assert.deepEqual(result.action, { kind: 'end' });
    assert.equal(result.language, 'es-US');
    assert.equal(result.reply, '¡Gracias por llamar, hasta luego!');
  } finally {
    replay.restore();
  }
});

test('an English-only workspace: no switch tool, and the prompt says the line is English only', async () => {
  const h = harness({ languages: [], persona: '' });
  const replay = installReplayFetch('openai', 'deepseek-flash', [{ text: "I'm sorry, I can only help in English. Would you like me to take a message for the team?" }]);
  try {
    await runVoiceTurn(h.session, {
      history: [BOOKING_HISTORY[0]!, { role: 'user', text: '[caller spoke in Spanish]\nHola, quisiera agendar una llamada.', ts: 2 }],
      state: { transferAttempts: 0, langHint: 'es' },
      turn: 1,
      budgetMs: 60_000,
      nowMs: Date.now(),
    });
    const body = replay.log.calls[0]!.body as { tools: { function: { name: string } }[]; messages: { role: string; content: string }[] };
    assert.ok(!body.tools.some((t) => t.function.name === 'switch_language'));
    assert.ok(body.messages[0]!.content.startsWith('You are the AI assistant answering the phone for Acme Plumbing.'), 'no persona, no name');
    assert.ok(body.messages[0]!.content.includes('This line takes calls in English only.'));
  } finally {
    replay.restore();
  }
});

test('the output guard: a price nobody gave is retried without tools, and a second refusal fetches a person', async () => {
  const h = harness();
  const replay = installReplayFetch('openai', 'deepseek-flash', [
    { text: 'A deep clean is $250, and we can do Tuesday.' },
    { text: 'I do not have prices here, but I can book you a call with the team on Tuesday.' },
  ]);
  try {
    const result = await runVoiceTurn(h.session, {
      history: [BOOKING_HISTORY[0]!, { role: 'user', text: 'How much is a deep clean?', ts: 2 }],
      state: { transferAttempts: 0 },
      turn: 1,
      budgetMs: 60_000,
      nowMs: Date.now(),
    });
    assert.equal(result.reply, 'I do not have prices here, but I can book you a call with the team on Tuesday.');
    assert.equal(result.action, null);
    const retry = replay.log.calls[1]!.body as { tool_choice: string; messages: { role: string; content: string }[] };
    assert.equal(retry.tool_choice, 'none');
    assert.equal(retry.messages[retry.messages.length - 1]!.content, 'Say that again without any price or link.');
    assert.equal(h.runs[0]!.decision, 'reply');
  } finally {
    replay.restore();
  }

  const twice = installReplayFetch('openai', 'deepseek-flash', [{ text: 'It is $250.' }, { text: 'Two hundred and fifty dollars, $250.' }]);
  try {
    const result = await runVoiceTurn(h.session, {
      history: [BOOKING_HISTORY[0]!, { role: 'user', text: 'How much is a deep clean?', ts: 2 }],
      state: { transferAttempts: 0 },
      turn: 1,
      budgetMs: 60_000,
      nowMs: Date.now(),
    });
    assert.equal(result.reply, 'Let me get someone from the team who can answer that properly.');
    assert.deepEqual(result.action, { kind: 'transfer', to: '+13105550000' });
    assert.equal(h.runs[1]!.decision, 'handoff');
  } finally {
    twice.restore();
  }
});
