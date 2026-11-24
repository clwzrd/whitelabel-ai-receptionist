import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Call } from '../support.ts';
import { RelaySession, SENTENCES, SENTENCES_BY_LANG, sentencesFor, ttsLangOf, type SessionTuning } from './session.ts';
import { SESSION_TIMING, type OutMessage, type SessionDeps, type SessionLimits, type SessionRow, type SessionStore, type Turn, type VoiceTurnFn, type VoiceTurnResult } from './types.ts';

/*
 * The engine, driven by hand with a scripted model, a fake socket and a fake
 * store. Every rule in the plan's §2.2 is one case below; the clocks are
 * shrunk to milliseconds through `limits` and the tuning so the whole file
 * runs in well under a second and holds no timer once it is done.
 */

const CALL_ID = '7d3f3b1a-0c5e-4e0a-9a7b-2c3d4e5f6a7b';
const SID = 'CA0123456789abcdef0123456789abcdef';
const ACCOUNT = 'AC00000000000000000000000000000000';
const WS = 'ws-1';

function fakeCall(): Call {
  return {
    id: CALL_ID,
    workspaceId: WS,
    contactId: 'c1',
    direction: 'in',
    fromNumber: '+13105550111',
    toNumber: '+13102000100',
    status: 'ringing',
    providerId: SID,
    durationSec: 0,
    missed: false,
    meta: { routed: 'ai' },
    answeredAt: null,
    startedAt: new Date(),
  } as unknown as Call;
}

interface FakeStore extends SessionStore {
  row: SessionRow;
  appended: Turn[];
  ends: Parameters<SessionStore['end']>[2][];
  truncated: string[];
  errors: unknown[];
  states: object[];
}

function fakeStore(initial: Partial<SessionRow> = {}): FakeStore {
  const row: SessionRow = {
    id: 's1',
    workspaceId: WS,
    callId: CALL_ID,
    status: 'connecting',
    turns: [],
    turnCount: 0,
    rotateCount: 0,
    state: { transferAttempts: 0 },
    endReason: null,
    outcome: null,
    handoff: null,
    summary: null,
    costCents: 0,
    startedAt: new Date(),
    lastTurnAt: null,
    endedAt: null,
    ...initial,
  };
  const store: FakeStore = {
    row,
    appended: [],
    ends: [],
    truncated: [],
    errors: [],
    states: [],
    async open() {
      row.status = 'live';
      return { ...row, turns: [...row.turns] };
    },
    async append(_ws, _call, turns) {
      row.turns.push(...turns);
      row.turnCount += turns.length;
      store.appended.push(...turns);
    },
    async truncateLast(_ws, _call, text) {
      const last = row.turns[row.turns.length - 1];
      if (!last || last.role !== 'assistant') return false;
      last.text = text;
      last.interrupted = true;
      store.truncated.push(text);
      return true;
    },
    async setState(_ws, _call, patch) {
      row.state = { ...row.state, ...patch };
      store.states.push(patch);
    },
    async end(_ws, _call, input) {
      store.ends.push(input);
      if (input.expectedRotateCount !== row.rotateCount) return false;
      row.status = 'ended';
      row.endReason = input.reason;
      return true;
    },
    async byCall() {
      return row;
    },
    async markAnswered(call) {
      return { ...call, status: 'in-progress', answeredAt: new Date() } as Call;
    },
    async recordError(input) {
      store.errors.push(input.error);
    },
  };
  return store;
}

interface Harness {
  session: RelaySession;
  sent: OutMessage[];
  closed: boolean;
  store: FakeStore;
  turns: Parameters<VoiceTurnFn>[0][];
  setup(overrides?: Partial<{ callSid: string; accountSid: string; call: string }>): Promise<void>;
  say(text: string, lang?: string): Promise<void>;
  texts(): string[];
  ends(): { reason: string; to?: string; why?: string }[];
}

const reply = (text: string, extra: Partial<VoiceTurnResult> = {}): VoiceTurnResult => ({
  reply: text,
  action: null,
  state: { transferAttempts: 0 },
  runId: 'run-1',
  booked: null,
  usage: { inputTokens: 1, outputTokens: 1 } as VoiceTurnResult['usage'],
  costUsd: 0.001,
  model: 'test',
  latencyMs: 1,
  ...extra,
});

function harness(opts: {
  turn?: VoiceTurnFn;
  store?: FakeStore;
  greeting?: string;
  deadlineInMs?: number;
  limits?: Partial<SessionLimits>;
  transferTo?: string | null;
  nowMs?: () => number;
  tuning?: Partial<SessionTuning>;
  /** The languages the assistant may switch to; absent means the default five. */
  languages?: string[];
  /** The voice provider the TwiML was written for; absent means ElevenLabs, the one that pairs with language switching. */
  ttsProvider?: 'Amazon' | 'Google' | 'ElevenLabs';
} = {}): Harness {
  const sent: OutMessage[] = [];
  const store = opts.store ?? fakeStore();
  const turns: Parameters<VoiceTurnFn>[0][] = [];
  const turn: VoiceTurnFn = async (input) => {
    turns.push(input);
    return (opts.turn ?? (async () => reply('Sure, we open at nine.')))(input);
  };
  const h = {} as Harness;
  const deps: SessionDeps = {
    call: fakeCall(),
    creds: { accountSid: ACCOUNT },
    settings: { ai: { ttsProvider: opts.ttsProvider ?? 'ElevenLabs', languages: opts.languages ?? ['es-US', 'pt-BR', 'fr-FR', 'de-DE', 'it-IT'] } } as unknown as SessionDeps['settings'],
    teamLang: 'en',
    workspaceId: WS,
    sink: {
      send: (m) => sent.push(m),
      close: () => {
        h.closed = true;
      },
    },
    deadlineMs: Date.now() + (opts.deadlineInMs ?? 600_000),
    nowMs: opts.nowMs,
    turn,
    store,
    limits: { ...SESSION_TIMING, idleAskMs: 40, idleEndMs: 40, rotateListenMs: 40_000, rotateThinkMs: 45_000, maxTurns: 30, maxMinutes: 10, ...opts.limits },
    greeting: opts.greeting ?? 'Thanks for calling Acme. This is Ava, an automated assistant. How can I help?',
    transferTo: opts.transferTo === undefined ? '+13105550100' : opts.transferTo,
  };
  const session = new RelaySession(deps, { fillerMs: 15, dtmfBufferMs: 10, speakMsPerChar: 0, speakMinMs: 4, speakMaxMs: 4, rotateWaitMs: 4, ...opts.tuning });
  Object.assign(h, {
    session,
    sent,
    closed: false,
    store,
    turns,
    setup: (overrides: Partial<{ callSid: string; accountSid: string; call: string }> = {}) =>
      session.receive({
        type: 'setup',
        sessionId: 'VX1',
        accountSid: overrides.accountSid ?? ACCOUNT,
        callSid: overrides.callSid ?? SID,
        customParameters: { call: overrides.call ?? CALL_ID, ws: WS, resume: '0' },
      }),
    say: (text: string, lang?: string) => session.receive({ type: 'prompt', voicePrompt: text, last: true, ...(lang ? { lang } : {}) }),
    texts: () => sent.filter((m): m is Extract<OutMessage, { type: 'text' }> => m.type === 'text').map((m) => m.token),
    ends: () =>
      sent
        .filter((m): m is Extract<OutMessage, { type: 'end' }> => m.type === 'end')
        .map((m) => JSON.parse(m.handoffData ?? '{}') as { reason: string; to?: string; why?: string }),
  });
  return h;
}

async function until(check: () => boolean, ms = 2000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > ms) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 2));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A model that answers only when the test lets it. */
function gated() {
  let release: (v: VoiceTurnResult) => void = () => undefined;
  const turn: VoiceTurnFn = () => new Promise<VoiceTurnResult>((resolve) => (release = resolve));
  return { turn, release: (r: VoiceTurnResult) => release(r) };
}

/* ------------------------------------------------------------------------ */

test('setup that does not match the call is refused: end{failed}, socket closed, error recorded, nothing persisted', async () => {
  const h = harness();
  await h.setup({ callSid: 'CAsomebodyelse' });
  assert.deepEqual(h.ends(), [{ reason: 'failed', why: 'setup mismatch' }]);
  assert.equal(h.closed, true);
  assert.equal(h.store.errors.length, 1);
  assert.equal(h.store.appended.length, 0);
  await h.session.finished;
  // A prompt after the refusal is ignored.
  await h.say('hello?');
  assert.equal(h.turns.length, 0);
  await h.session.flush();
  assert.equal(h.store.ends.length, 0);
});

test('setup with the wrong account or the wrong custom parameter is a mismatch too', async () => {
  const a = harness();
  await a.setup({ accountSid: 'ACother' });
  assert.equal(a.ends()[0]?.reason, 'failed');
  const b = harness();
  await b.setup({ call: 'other-call' });
  assert.equal(b.ends()[0]?.reason, 'failed');
});

test('a first connection appends the greeting as an assistant turn; a prompt persists the user turn before the think and the reply after', async () => {
  let seenAtThink: Turn[] = [];
  const h = harness({
    turn: async (input) => {
      seenAtThink = [...h.store.appended];
      assert.equal(input.turn, 1);
      assert.equal(input.history.at(-1)?.text, 'What time do you open?');
      return reply('We open at nine.');
    },
  });
  await h.setup();
  assert.equal(h.store.appended[0]?.role, 'assistant');
  assert.match(h.store.appended[0]?.text ?? '', /automated assistant/);

  await h.say('What time do you open?');
  await until(() => h.texts().includes('We open at nine.'));
  assert.deepEqual(
    seenAtThink.map((t) => t.role),
    ['assistant', 'user'],
    'the user turn was on disk before the model was asked',
  );
  assert.deepEqual(
    h.store.appended.map((t) => t.role),
    ['assistant', 'user', 'assistant'],
  );
  assert.equal(h.store.appended[2]?.runId, 'run-1');
  assert.deepEqual(h.store.states, [{ transferAttempts: 0 }]);
  await h.session.flush();
});

test('a partial prompt is not a turn; an empty final one is not either', async () => {
  const h = harness();
  await h.setup();
  await h.session.receive({ type: 'prompt', voicePrompt: 'what time', last: false });
  await h.session.receive({ type: 'prompt', voicePrompt: '   ', last: true });
  await sleep(10);
  assert.equal(h.turns.length, 0);
  assert.equal(h.store.appended.length, 1);
  await h.session.flush();
});

test('two prompts during one think coalesce: the in-flight reply is preemptible and the next think sees both', async () => {
  const gate = gated();
  const h = harness({ turn: gate.turn });
  await h.setup();
  await h.say('Do you do websites?');
  await until(() => h.turns.length === 1);
  await h.say('And what about ads?');
  await h.say('Sorry, ads and social.');
  assert.equal(h.turns.length, 1, 'no second think while one is in flight');
  gate.release(reply('Yes, we build websites.'));
  await until(() => h.turns.length === 2);
  const first = h.sent.find((m) => m.type === 'text' && m.token === 'Yes, we build websites.') as Extract<OutMessage, { type: 'text' }>;
  assert.equal(first.preemptible, true);
  const second = h.turns[1]!;
  assert.deepEqual(
    second.history.filter((t) => t.role === 'user').map((t) => t.text),
    ['Do you do websites?', 'And what about ads?', 'Sorry, ads and social.'],
  );
  assert.equal(second.turn, 2);
  gate.release(reply('Ads and social too.'));
  await until(() => h.texts().includes('Ads and social too.'));
  await h.session.flush();
});

test('an interrupt cuts the last assistant turn to what was heard; one during the filler is ignored', async () => {
  const gate = gated();
  const h = harness({ turn: gate.turn });
  await h.setup();
  await h.say('Tell me about pricing.');
  // The model is slow: the filler goes out, and an interrupt now must not touch the transcript.
  await until(() => h.texts().includes(SENTENCES.filler));
  await h.session.receive({ type: 'interrupt', utteranceUntilInterrupt: 'Sure, one' });
  assert.equal(h.store.truncated.length, 0);

  gate.release(reply('Our plans start at four hundred dollars a month and include everything.'));
  await until(() => h.texts().some((t) => t.startsWith('Our plans')));
  await h.session.receive({ type: 'interrupt', utteranceUntilInterrupt: 'Our plans start at four hundred' });
  assert.deepEqual(h.store.truncated, ['Our plans start at four hundred']);
  const last = h.store.row.turns.at(-1)!;
  assert.equal(last.role, 'assistant');
  assert.equal(last.text, 'Our plans start at four hundred');
  assert.equal(last.interrupted, true);
  await h.session.flush();
});

test('keypad: 0 transfers with the fixed sentence, * repeats the last reply, other digits become a user turn', async () => {
  const h = harness();
  await h.setup();
  await h.session.receive({ type: 'dtmf', digit: '*' });
  await until(() => h.texts().length === 1);
  assert.match(h.texts()[0]!, /automated assistant/, 'star repeats the greeting');

  await h.session.receive({ type: 'dtmf', digit: '1' });
  await h.session.receive({ type: 'dtmf', digit: '2' });
  await until(() => h.turns.length === 1);
  const pressed = h.turns[0]!.history.at(-1)!;
  assert.equal(pressed.text, '[pressed 12]');
  assert.equal(pressed.dtmf, '12');
  await until(() => h.texts().includes('Sure, we open at nine.'));

  await h.session.receive({ type: 'dtmf', digit: '0' });
  await until(() => h.ends().length === 1);
  assert.deepEqual(h.ends(), [{ reason: 'transfer', to: '+13105550100' }]);
  assert.equal(h.texts().at(-1), SENTENCES.transfer);
  assert.equal(h.store.ends[0]?.reason, 'transfer');
  assert.equal(h.store.ends[0]?.outcome, 'transferred');
  assert.equal(h.store.row.state.transferAttempts, 1);
  await h.session.finished;
});

test('keypad 0 with nobody to transfer to is just a user turn', async () => {
  const h = harness({ transferTo: null });
  await h.setup();
  await h.session.receive({ type: 'dtmf', digit: '0' });
  await until(() => h.turns.length === 1);
  assert.equal(h.turns[0]!.history.at(-1)!.text, '[pressed 0]');
  await until(() => h.texts().length === 1);
  await h.session.flush();
});

test('keypad 0 after the team already failed to pick up is a user turn, not a second dial', async () => {
  const store = fakeStore({
    rotateCount: 1,
    status: 'rotating',
    turns: [
      { role: 'assistant', text: 'Thanks for calling. How can I help?', ts: 1 },
      { role: 'user', text: 'Get me a person.', ts: 2 },
      { role: 'assistant', text: "One moment, I'm connecting you to a person.", ts: 3 },
      { role: 'system', text: 'The team did not pick up the transfer; offer to take a message.', ts: 4 },
    ],
    turnCount: 4,
    state: { transferAttempts: 1 },
  });
  const h = harness({ store, greeting: '', turn: async () => reply('Nobody could pick up. May I take a message?') });
  await h.setup();
  await h.session.receive({ type: 'dtmf', digit: '0' });
  await until(() => h.turns.length === 1);
  assert.equal(h.turns[0]!.history.at(-1)!.text, '[pressed 0]');
  assert.equal(h.turns[0]!.sessionId, 's1', 'the row id travels with the turn');
  assert.deepEqual(h.ends(), [], 'no transfer was started');
  await until(() => h.texts().length === 1);
  await h.session.flush();
});

test('rotate: with less than rotateListenMs left while listening, "One second, please." and end{rotate}', async () => {
  const h = harness({ deadlineInMs: 40_000 + 30 });
  await h.setup();
  await until(() => h.ends().length === 1);
  assert.deepEqual(h.ends(), [{ reason: 'rotate' }]);
  assert.equal(h.texts().at(-1), SENTENCES.rotate);
  assert.equal(h.store.ends.length, 1);
  assert.equal(h.store.ends[0]?.reason, 'rotate');
  assert.equal(h.store.ends[0]?.outcome, undefined, 'a rotate is not an outcome');
  assert.equal(h.store.ends[0]?.expectedRotateCount, 0);
  // The sentence is not part of the transcript.
  assert.ok(!h.store.appended.some((t) => t.text === SENTENCES.rotate));
  await h.session.finished;
});

test('a prompt with less than rotateThinkMs left persists the user turn and rotates without thinking', async () => {
  const h = harness({ deadlineInMs: 44_000 });
  await h.setup();
  await h.say('Can I book for Tuesday?');
  await until(() => h.ends().length === 1);
  assert.equal(h.turns.length, 0, 'the model was not asked');
  assert.deepEqual(h.ends(), [{ reason: 'rotate' }]);
  assert.equal(h.store.row.turns.at(-1)?.text, 'Can I book for Tuesday?');
  await h.session.finished;
});

test('flush after a rotate is a no-op: the row is ended once, with the rotate', async () => {
  const h = harness({ deadlineInMs: 40_000 + 20 });
  await h.setup();
  await h.session.finished;
  await h.session.flush();
  assert.equal(h.store.ends.length, 1);
  assert.equal(h.store.ends[0]?.reason, 'rotate');
});

test('a resume with a trailing user turn answers it first, without a greeting', async () => {
  const store = fakeStore({
    rotateCount: 1,
    status: 'rotating',
    turns: [
      { role: 'assistant', text: 'Thanks for calling. How can I help?', ts: 1 },
      { role: 'user', text: 'Are you open on Saturdays?', ts: 2 },
    ],
    turnCount: 2,
    state: { transferAttempts: 0, offered: [] },
  });
  const h = harness({ store, greeting: '', turn: async () => reply('Yes, until noon.') });
  await h.setup();
  await until(() => h.texts().includes('Yes, until noon.'));
  assert.equal(h.turns[0]!.turn, 1);
  assert.equal(h.turns[0]!.history.at(-1)!.text, 'Are you open on Saturdays?');
  assert.deepEqual(
    h.store.appended.map((t) => t.role),
    ['assistant'],
    'no greeting appended on a resume',
  );
  await h.session.flush();
  assert.equal(h.store.ends[0]?.expectedRotateCount, 1);
});

test('a resume whose last turn was answered just listens', async () => {
  const store = fakeStore({
    rotateCount: 1,
    turns: [
      { role: 'assistant', text: 'Hi.', ts: 1 },
      { role: 'user', text: 'Hi there.', ts: 2 },
      { role: 'assistant', text: 'How can I help?', ts: 3 },
    ],
    turnCount: 3,
  });
  const h = harness({ store, greeting: '' });
  await h.setup();
  await sleep(10);
  assert.equal(h.turns.length, 0);
  assert.equal(h.store.appended.length, 0);
  await h.session.flush();
});

test('idle: "Are you still there?" after idleAskMs of silence, then end{idle} after idleEndMs more', async () => {
  const h = harness({ limits: { idleAskMs: 30, idleEndMs: 30 } });
  await h.setup();
  await until(() => h.texts().includes(SENTENCES.idleAsk));
  assert.equal(h.ends().length, 0);
  await until(() => h.ends().length === 1);
  assert.deepEqual(h.ends(), [{ reason: 'idle' }]);
  assert.equal(h.texts().at(-1), SENTENCES.idleEnd);
  assert.equal(h.store.ends[0]?.outcome, 'nothing');
  await h.session.finished;
});

test('idle: a prompt resets the silence clock', async () => {
  const h = harness({ limits: { idleAskMs: 40, idleEndMs: 40 } });
  await h.setup();
  await sleep(25);
  await h.say('Hello?');
  await until(() => h.texts().includes('Sure, we open at nine.'));
  await sleep(25);
  assert.ok(!h.texts().includes(SENTENCES.idleAsk));
  await h.session.flush();
});

test('maxTurns: after the last allowed reply the wrap-up sentence is spoken and the session ends', async () => {
  const h = harness({ limits: { maxTurns: 1 } });
  await h.setup();
  await h.say('Hi.');
  await until(() => h.ends().length === 1);
  assert.deepEqual(h.ends(), [{ reason: 'max-turns' }]);
  assert.deepEqual(h.texts().slice(-2), ['Sure, we open at nine.', SENTENCES.wrapUp]);
  await h.session.finished;
});

test('maxMinutes counts from the answer and ends the call with the out-of-time sentence', async () => {
  const h = harness({ limits: { maxMinutes: 0.0005 } });
  await h.setup();
  await until(() => h.ends().length === 1);
  assert.deepEqual(h.ends(), [{ reason: 'max-minutes' }]);
  assert.equal(h.texts().at(-1), SENTENCES.outOfTime);
  await h.session.finished;
});

test('the caller hangs up: flush marks caller-hung-up with the outcome so far', async () => {
  const h = harness();
  await h.setup();
  await h.say('Just checking your hours.');
  await until(() => h.texts().includes('Sure, we open at nine.'));
  await h.session.flush();
  assert.equal(h.store.ends.length, 1);
  assert.equal(h.store.ends[0]?.reason, 'caller-hung-up');
  assert.equal(h.store.ends[0]?.outcome, 'info');
  assert.equal(h.store.ends[0]?.costCents, 0);
  assert.equal(h.ends().length, 0, 'no end was sent; the socket was already gone');
  await h.session.finished;
});

test('a booking makes the outcome booked; a message tool makes it message', async () => {
  const a = harness({ turn: async () => reply('Booked.', { booked: { appointmentId: 'a1', startAt: new Date() } }) });
  await a.setup();
  await a.say('Book me.');
  await until(() => a.texts().includes('Booked.'));
  await a.session.flush();
  assert.equal(a.store.ends[0]?.outcome, 'booked');

  const b = harness({
    turn: async () => ({ ...reply('I have passed that on.'), tools: [{ name: 'leave_message_for_team', result: 'ok' }] }) as VoiceTurnResult,
  });
  await b.setup();
  await b.say('Tell them I called.');
  await until(() => b.texts().includes('I have passed that on.'));
  assert.deepEqual(b.store.appended.at(-1)?.tools, [{ name: 'leave_message_for_team', result: 'ok' }]);
  await b.session.flush();
  assert.equal(b.store.ends[0]?.outcome, 'message');
});

test('a throwing model speaks the apology and the conversation goes on', async () => {
  let calls = 0;
  const h = harness({
    turn: async () => {
      calls += 1;
      if (calls === 1) throw new Error('provider timeout');
      return reply('Nine to five.');
    },
  });
  await h.setup();
  await h.say('Hours?');
  await until(() => h.texts().includes(SENTENCES.apology));
  assert.equal(h.store.errors.length, 1);
  assert.equal(h.store.appended.at(-1)?.text, SENTENCES.apology);
  await h.say('Your hours?');
  await until(() => h.texts().includes('Nine to five.'));
  assert.equal(h.ends().length, 0);
  await h.session.flush();
});

test('an empty reply is turned into "say that again", never silence', async () => {
  const h = harness({ turn: async () => reply('   ') });
  await h.setup();
  await h.say('Mumble.');
  await until(() => h.texts().includes(SENTENCES.empty));
  await h.session.flush();
});

test('actions: transfer, voicemail and end each speak their fixed sentence, then end with the reason', async () => {
  const t = harness({ turn: async () => reply('Let me connect you.', { action: { kind: 'transfer', to: '+13105550100' } }) });
  await t.setup();
  await t.say('I want a person.');
  await until(() => t.ends().length === 1);
  assert.deepEqual(t.ends(), [{ reason: 'transfer', to: '+13105550100' }]);
  assert.equal(t.texts().at(-1), SENTENCES.transfer);
  assert.ok(!t.texts().includes('Let me connect you.'), 'the model does not get the last line');
  assert.equal(t.store.row.state.transferAttempts, 1);
  await t.session.finished;

  const v = harness({ turn: async () => reply('Leaving you to voicemail.', { action: { kind: 'voicemail' } }) });
  await v.setup();
  await v.say('Just let me leave a message.');
  await until(() => v.ends().length === 1);
  assert.deepEqual(v.ends(), [{ reason: 'voicemail' }]);
  assert.equal(v.texts().at(-1), SENTENCES.voicemail);
  assert.equal(v.store.ends[0]?.outcome, 'voicemail');
  await v.session.finished;

  const e = harness({ turn: async () => reply('', { action: { kind: 'end' } }) });
  await e.setup();
  await e.say('Bye.');
  await until(() => e.ends().length === 1);
  assert.deepEqual(e.ends(), [{ reason: 'assistant-ended' }]);
  assert.equal(e.texts().at(-1), SENTENCES.farewell);
  await e.session.finished;

  const g = harness({ turn: async () => reply('Have a great day, goodbye.', { action: { kind: 'end' } }) });
  await g.setup();
  await g.say('Bye.');
  await until(() => g.ends().length === 1);
  assert.equal(g.texts().at(-1), 'Have a great day, goodbye.');
  assert.equal(g.store.appended.at(-1)?.text, 'Have a great day, goodbye.');
  await g.session.finished;
});

test('a Twilio error of the connect class ends the session as failed; any other is only recorded', async () => {
  const h = harness();
  await h.setup();
  await h.session.receive({ type: 'error', description: 'TTS hiccup', code: 64111 });
  assert.equal(h.store.errors.length, 1);
  assert.equal(h.store.ends.length, 0);
  await h.session.receive({ type: 'error', description: 'Account opted out', code: 64110 });
  assert.equal(h.store.ends[0]?.reason, 'failed');
  await h.session.finished;
  await h.session.flush();
  assert.equal(h.store.ends.length, 1);
});

test('a socket error fails the session and writes the row once', async () => {
  const h = harness();
  await h.setup();
  h.session.fail(new Error('ECONNRESET'));
  await h.session.finished;
  await h.session.flush();
  assert.equal(h.store.ends.length, 1);
  assert.equal(h.store.ends[0]?.reason, 'failed');
});

/* ---- the review's cases ---------------------------------------------------- */

test('an interrupt over the idle ask leaves the last real reply untouched', async () => {
  const h = harness({ limits: { idleAskMs: 30, idleEndMs: 500 } });
  await h.setup();
  await h.say('What are your hours?');
  await until(() => h.texts().includes('Sure, we open at nine.'));
  await until(() => h.texts().includes(SENTENCES.idleAsk));
  await h.session.receive({ type: 'interrupt', utteranceUntilInterrupt: 'Are you still' });
  assert.equal(h.store.truncated.length, 0);
  assert.equal(h.store.row.turns.at(-1)?.text, 'Sure, we open at nine.');
  await h.session.flush();
});

test('an interrupt over the * repeat leaves the transcript alone too', async () => {
  const h = harness();
  await h.setup();
  await h.say('What are your hours?');
  await until(() => h.texts().includes('Sure, we open at nine.'));
  await h.session.receive({ type: 'dtmf', digit: '*' });
  await until(() => h.texts().filter((t) => t === 'Sure, we open at nine.').length === 2);
  await h.session.receive({ type: 'interrupt', utteranceUntilInterrupt: 'Sure, we' });
  assert.equal(h.store.truncated.length, 0);
  await h.session.flush();
});

test('a model answer that lands after the session ended is kept as an unspoken turn with its tools, and a resume answers it first', async () => {
  const gate = gated();
  // The minutes cap fires while the model is still thinking: the same race as a rotate or a hang-up mid-turn.
  const h = harness({ turn: gate.turn, limits: { maxMinutes: 0.001 } });
  await h.setup();
  await h.say('Book me Tuesday at nine.');
  await until(() => h.ends().length === 1);
  assert.deepEqual(h.ends(), [{ reason: 'max-minutes' }]);
  gate.release(reply('Booked for Tuesday at nine.', { tools: [{ name: 'book_appointment', result: 'Booked. Discovery call at 2026-09-15T16:00:00.000Z.' }], booked: { appointmentId: 'a1', startAt: new Date() } }));
  await until(() => h.store.row.turns.at(-1)?.unspoken === true);
  const kept = h.store.row.turns.at(-1)!;
  assert.equal(kept.unspoken, true);
  assert.equal(kept.text, '');
  assert.equal(kept.tools?.[0]?.name, 'book_appointment');
  assert.ok(!h.texts().includes('Booked for Tuesday at nine.'), 'nothing is spoken after the end');

  // The next invocation opens the same row: it must answer the waiting caller from the results, not re-run the tool.
  const store = fakeStore({ turns: [...h.store.row.turns], rotateCount: 1 });
  const g = harness({ store, greeting: '' });
  await g.setup();
  await until(() => g.turns.length === 1);
  assert.equal(g.turns[0]?.history.at(-1)?.unspoken, true);
  await until(() => g.texts().length === 1);
  await g.session.flush();
});

test('a socket that closes inside the rotate window is not written as a hang-up, so relay-done can resume it', async () => {
  let offset = 0;
  const h = harness({ deadlineInMs: 600_000, nowMs: () => Date.now() + offset });
  await h.setup();
  // The clock jumps to 30 s before the deadline; the real rotate timer is still minutes away.
  offset = 570_000;
  await h.session.flush();
  assert.equal(h.store.ends.length, 0);
  assert.equal(h.store.row.status, 'live');
});

test('a store that cannot open the row ends the session with end{failed} instead of leaving the caller in silence', async () => {
  const store = fakeStore();
  store.open = async () => {
    throw new Error('relation "voice_sessions" does not exist');
  };
  const h = harness({ store });
  await h.setup();
  assert.deepEqual(h.ends(), [{ reason: 'failed', why: 'session store unavailable' }]);
  assert.equal(h.closed, true);
  assert.equal(h.store.errors.length, 1);
  await h.session.finished;
  await h.say('hello?');
  assert.equal(h.turns.length, 0);
});

test('a Twilio error whose code is only in the description still ends the session when it is of the connect class', async () => {
  const h = harness();
  await h.setup();
  await h.session.receive({ type: 'error', description: 'Error 64107: invalid message received' });
  assert.equal(h.store.ends.length, 0);
  await h.session.receive({ type: 'error', description: '64110: AI/ML addendum not accepted for this account' });
  assert.equal(h.store.ends[0]?.reason, 'failed');
  assert.equal(h.store.ends[0]?.handoff?.why, 'twilio 64110');
  await h.session.finished;
});

test('a tokens-played report ends the speaking phase at once; a report for another sentence is ignored', async () => {
  const h = harness({ limits: { idleAskMs: 30, idleEndMs: 500 }, tuning: { speakMinMs: 400, speakMaxMs: 400 } });
  await h.setup();
  await h.session.receive({ type: 'info', name: 'tokensPlayed', value: h.store.row.turns[0]!.text });
  await h.say('What are your hours?');
  await until(() => h.texts().includes('Sure, we open at nine.'));
  // Without the report the guess would keep the phase at "speaking" for 400 ms and no idle ask would come this soon.
  await h.session.receive({ type: 'info', name: 'tokensPlayed', value: 'Hello there.' });
  await sleep(60);
  assert.ok(!h.texts().includes(SENTENCES.idleAsk), 'a report for other words is not the end of this sentence');
  await h.session.receive({ type: 'info', name: 'tokensPlayed', value: 'Sure, we open at nine.' });
  await until(() => h.texts().includes(SENTENCES.idleAsk));
  await h.session.flush();
});

test('a canceled or moved appointment names the outcome', async () => {
  const h = harness({
    turn: async () => reply('Done, that is canceled.', { tools: [{ name: 'cancel_appointment', result: 'Canceled: Discovery call at 2026-09-15T16:00:00.000Z. The reminders are off.' }] }),
  });
  await h.setup();
  await h.say('Please cancel my appointment.');
  await until(() => h.texts().includes('Done, that is canceled.'));
  await h.session.flush();
  assert.equal(h.store.ends[0]?.outcome, 'canceled');

  const g = harness({
    turn: async () => reply('It is refused.', { tools: [{ name: 'cancel_appointment', result: 'The name they gave does not match the booking.' }] }),
  });
  await g.setup();
  await g.say('Cancel it.');
  await until(() => g.texts().includes('It is refused.'));
  await g.session.flush();
  assert.equal(g.store.ends[0]?.outcome, 'info');
});

/* ---- language: the caller does not speak English --------------------------- */

const textMessages = (h: Harness) => h.sent.filter((m): m is Extract<OutMessage, { type: 'text' }> => m.type === 'text');
const languageMessages = (h: Harness) => h.sent.filter((m): m is Extract<OutMessage, { type: 'language' }> => m.type === 'language');

test('a prompt in another language is noted for the model once, the hint is persisted, and English prompts are never noted', async () => {
  const h = harness();
  await h.setup();
  await h.say('Hola, quiero una cita.', 'es');
  await until(() => h.turns.length === 1);
  assert.equal(h.turns[0]?.history.at(-1)?.text, '[caller spoke in Spanish] Hola, quiero una cita.');
  assert.equal(h.turns[0]?.state.langHint, 'es');
  assert.ok(h.store.states.some((s) => (s as { langHint?: string }).langHint === 'es'));
  await until(() => h.texts().length === 1);

  // The model did not switch; the caller goes on in Spanish. The note is not repeated.
  await h.say('¿Tienen algo el lunes?', 'es');
  await until(() => h.turns.length === 2);
  assert.equal(h.turns[1]?.history.at(-1)?.text, '¿Tienen algo el lunes?');
  await until(() => h.texts().length === 2);

  // English is the primary language: never announced, even after a Spanish sentence.
  await h.say('Monday works.', 'en');
  await until(() => h.turns.length === 3);
  assert.equal(h.turns[2]?.history.at(-1)?.text, 'Monday works.');
  assert.equal(h.turns[2]?.state.langHint, 'en');
  // Every text so far carried the primary language explicitly.
  for (const m of textMessages(h)) assert.equal(m.lang, 'en-US');
  await h.session.flush();
});

test('a language action sends one language message, stamps lang on every later text, persists it, and switches the fixed sentences', async () => {
  let calls = 0;
  const h = harness({
    turn: async () => {
      calls += 1;
      if (calls === 1) return reply('¡Claro! ¿Para qué día le gustaría?', { action: { kind: 'language', code: 'es-US' } });
      // The model repeats the tool call; it must not make Twilio reload the voice.
      if (calls === 2) return reply('Tenemos el lunes a las nueve.', { action: { kind: 'language', code: 'es-US' } });
      return reply('Perfecto.');
    },
    limits: { idleAskMs: 30, idleEndMs: 30 },
  });
  await h.setup();
  await h.say('Hola, quiero una cita.', 'es');
  await until(() => h.texts().includes('¡Claro! ¿Para qué día le gustaría?'));
  assert.deepEqual(languageMessages(h), [{ type: 'language', ttsLanguage: 'es-US' }]);
  const first = textMessages(h).find((m) => m.token === '¡Claro! ¿Para qué día le gustaría?');
  assert.equal(first?.lang, 'es-US');
  assert.ok(h.store.states.some((s) => (s as { lang?: string }).lang === 'es-US'));
  assert.equal(h.store.row.state.lang, 'es-US');

  await h.say('El lunes.', 'es');
  await until(() => h.texts().includes('Tenemos el lunes a las nueve.'));
  // Still one language message, and no second note for the model: the assistant already speaks Spanish.
  assert.equal(languageMessages(h).length, 1);
  assert.equal(h.turns[1]?.history.at(-1)?.text, 'El lunes.');

  // The silence clock now speaks Spanish too.
  await until(() => h.texts().includes(SENTENCES_BY_LANG.es!.idleAsk), 2000);
  const ask = textMessages(h).find((m) => m.token === SENTENCES_BY_LANG.es!.idleAsk);
  assert.equal(ask?.lang, 'es-US');
  await until(() => h.ends().length === 1, 2000);
  assert.equal(h.ends()[0]?.reason, 'idle');
  assert.equal(h.texts().at(-1), SENTENCES_BY_LANG.es!.idleEnd);
  await h.session.finished;
});

test('the filler, a transfer and a keypad 0 speak the fixed sentences in the caller\'s language; switching back to English is a language message for en-US and the state goes null', async () => {
  const gate = gated();
  let calls = 0;
  const h = harness({
    turn: async (input) => {
      calls += 1;
      if (calls === 1) return reply('Certo, como posso ajudar?', { action: { kind: 'language', code: 'pt-BR' } });
      if (calls === 2) return gate.turn(input);
      if (calls === 3) return reply('Sure, back to English.', { action: { kind: 'language', code: 'en-US' } });
      return reply('Ok.');
    },
    tuning: { fillerMs: 5 },
  });
  await h.setup();
  await h.say('Olá, bom dia.', 'pt');
  await until(() => h.texts().includes('Certo, como posso ajudar?'));
  assert.equal(languageMessages(h).at(-1)?.ttsLanguage, 'pt-BR');

  await h.say('Quero marcar um horário.', 'pt');
  await until(() => h.texts().includes(SENTENCES_BY_LANG.pt!.filler));
  const filler = textMessages(h).find((m) => m.token === SENTENCES_BY_LANG.pt!.filler);
  assert.equal(filler?.lang, 'pt-BR');
  assert.equal(filler?.preemptible, true);
  gate.release(reply('Temos segunda às nove.'));
  await until(() => h.texts().includes('Temos segunda às nove.'));

  await h.say('Can we do this in English?', 'en');
  await until(() => h.texts().includes('Sure, back to English.'));
  assert.deepEqual(languageMessages(h).map((m) => m.ttsLanguage), ['pt-BR', 'en-US']);
  assert.equal(h.store.row.state.lang, null);
  assert.equal(textMessages(h).at(-1)?.lang, 'en-US');

  // Keypad 0 after that transfers with the English sentence again.
  await h.session.receive({ type: 'dtmf', digit: '0' });
  await until(() => h.ends().length === 1);
  assert.equal(h.texts().at(-1), SENTENCES.transfer);
  await h.session.finished;
});

test('a switch on the same turn as an end or a transfer is honoured first: the farewell is spoken in the new language and the row remembers it', async () => {
  // The model switched and hung up in one breath: `action` is the end, the switch rides on `language`.
  const e = harness({ turn: async () => reply('¡Gracias por llamar, hasta luego!', { action: { kind: 'end' }, language: 'es-US' }) });
  await e.setup();
  await e.say('Adiós.', 'es');
  await until(() => e.ends().length === 1);
  assert.deepEqual(languageMessages(e), [{ type: 'language', ttsLanguage: 'es-US' }]);
  const farewell = textMessages(e).find((m) => m.token === '¡Gracias por llamar, hasta luego!');
  assert.equal(farewell?.lang, 'es-US');
  assert.equal(e.store.row.state.lang, 'es-US');
  assert.deepEqual(e.ends(), [{ reason: 'assistant-ended' }]);
  await e.session.finished;

  // Same with a transfer: the fixed "connecting you" sentence comes out in Spanish.
  const t = harness({ turn: async () => reply('', { action: { kind: 'transfer', to: '+13105550100' }, language: 'es-US' }) });
  await t.setup();
  await t.say('Con una persona, por favor.', 'es');
  await until(() => t.ends().length === 1);
  assert.deepEqual(languageMessages(t), [{ type: 'language', ttsLanguage: 'es-US' }]);
  const connecting = textMessages(t).find((m) => m.token === SENTENCES_BY_LANG.es!.transfer);
  assert.equal(connecting?.lang, 'es-US');
  assert.equal(t.store.row.state.lang, 'es-US');
  await t.session.finished;

  // No switch: `language` null is the everyday case and sends nothing.
  const n = harness({ turn: async () => reply('Bye now.', { action: { kind: 'end' }, language: null }) });
  await n.setup();
  await n.say('Bye.');
  await until(() => n.ends().length === 1);
  assert.equal(languageMessages(n).length, 0);
  await n.session.finished;
});

test('a language the workspace did not allow is refused: no language message, the reply is still spoken, the error is recorded', async () => {
  const h = harness({
    languages: ['es-US'],
    turn: async () => reply('Bonjour !', { action: { kind: 'language', code: 'fr-FR' } }),
  });
  await h.setup();
  await h.say('Bonjour, je voudrais un rendez-vous.', 'fr');
  await until(() => h.texts().includes('Bonjour !'));
  assert.equal(languageMessages(h).length, 0);
  assert.equal(h.store.row.state.lang ?? null, null);
  assert.equal(textMessages(h).at(-1)?.lang, 'en-US');
  assert.ok(h.store.errors.some((e) => /switch_language refused: fr-FR/.test(String((e as Error).message))));
  await h.session.flush();
});

test('a workspace on Amazon keeps its language list but the engine refuses the switch: the TwiML declared no other voice', async () => {
  const h = harness({
    ttsProvider: 'Amazon',
    turn: async () => reply('¡Claro!', { action: { kind: 'language', code: 'es-US' } }),
  });
  await h.setup();
  await h.say('Hola, quiero una cita.', 'es');
  await until(() => h.texts().includes('¡Claro!'));
  assert.equal(languageMessages(h).length, 0, 'no language message to a Polly session');
  assert.equal(h.store.row.state.lang ?? null, null);
  assert.equal(textMessages(h).at(-1)?.lang, 'en-US');
  assert.ok(h.store.errors.some((e) => /switch_language refused: es-US/.test(String((e as Error).message))));
  await h.session.flush();
});

test('once the call is in Spanish, an English sentence is noted once so the model can bring the call back; a Spanish one is not', async () => {
  let calls = 0;
  const h = harness({
    turn: async () => {
      calls += 1;
      if (calls === 1) return reply('¡Claro! ¿Para qué día?', { action: { kind: 'language', code: 'es-US' } });
      return reply('Perfecto.');
    },
  });
  await h.setup();
  await h.say('Hola, quiero una cita.', 'es');
  await until(() => h.texts().length === 1);
  assert.equal(h.store.row.state.lang, 'es-US');

  // The caller switches back to English: one note, and the model decides — a mislabelled "sí" reads the same and does nothing by itself.
  await h.say('Actually, English is fine.', 'en');
  await until(() => h.turns.length === 2);
  assert.equal(h.turns[1]?.history.at(-1)?.text, '[caller spoke in English] Actually, English is fine.');
  assert.equal(languageMessages(h).length, 1, 'a note is not a switch');
  assert.equal(h.store.row.state.lang, 'es-US');
  await until(() => h.texts().length === 2);

  // Still English, the model has not acted: not noted again. Back to Spanish: the language the call is in, never noted.
  await h.say('Monday works.', 'en');
  await until(() => h.turns.length === 3);
  assert.equal(h.turns[2]?.history.at(-1)?.text, 'Monday works.');
  await until(() => h.texts().length === 3);
  await h.say('El lunes.', 'es');
  await until(() => h.turns.length === 4);
  assert.equal(h.turns[3]?.history.at(-1)?.text, 'El lunes.');
  await h.session.flush();
});

test("a switch that lands after the session ended still moves the row, so the resumed connection opens in the caller's language", async () => {
  const gate = gated();
  // The minutes cap fires while the model is still answering the turn in which it called switch_language: the same race as a rotate mid-turn.
  const h = harness({ turn: gate.turn, limits: { maxMinutes: 0.001 } });
  await h.setup();
  await h.say('Hola, quiero una cita.', 'es');
  await until(() => h.ends().length === 1);
  gate.release(reply('¡Claro! ¿Para qué día?', { action: { kind: 'language', code: 'es-US' }, language: 'es-US', tools: [{ name: 'switch_language', result: 'Switched to Spanish. Continue in Spanish.' }] }));
  await until(() => h.store.row.turns.at(-1)?.unspoken === true);
  assert.equal(languageMessages(h).length, 0, 'the socket is closing; nobody to tell');
  assert.equal(h.store.row.state.lang, 'es-US', 'the row remembers the language the model believes it switched to');
  assert.ok(h.store.states.some((s) => (s as { lang?: string }).lang === 'es-US'));

  // The next invocation opens the row: it answers the waiting turn in Spanish and does not note Spanish again.
  const store = fakeStore({ turns: [...h.store.row.turns], state: { ...h.store.row.state }, rotateCount: 1 });
  const g = harness({ store, greeting: '', turn: async () => reply('¿Para qué día?') });
  await g.setup();
  await until(() => g.texts().length === 1);
  assert.equal(textMessages(g)[0]?.lang, 'es-US');
  await g.say('El lunes.', 'es');
  await until(() => g.turns.length === 2);
  assert.equal(g.turns[1]?.history.at(-1)?.text, 'El lunes.');
  await g.session.flush();
});

test('a switch with no words from the model speaks the table\'s sentence in the new language rather than "say that again"', async () => {
  const h = harness({ turn: async () => reply('', { action: { kind: 'language', code: 'it-IT' } }) });
  await h.setup();
  await h.say('Buongiorno.', 'it');
  await until(() => h.texts().length === 1);
  assert.equal(h.texts()[0], SENTENCES_BY_LANG.it!.switched);
  assert.equal(textMessages(h)[0]?.lang, 'it-IT');
  await h.session.flush();
});

test('a resume opens in the language the row remembers: the answer to the waiting turn and the rotate sentence carry it', async () => {
  const store = fakeStore({
    rotateCount: 1,
    state: { transferAttempts: 0, lang: 'de-DE', langHint: 'de' },
    turns: [
      { role: 'assistant', text: 'Hi, thanks for calling Acme. I am the AI assistant here. How can I help you today?', ts: 1 },
      { role: 'user', text: '[caller spoke in German] Guten Tag, ich möchte einen Termin.', ts: 2 },
      { role: 'assistant', text: 'Gern. Wann passt es Ihnen?', ts: 3 },
      { role: 'user', text: 'Am Montag.', ts: 4 },
    ],
  });
  // Enough room to think once (rotateThinkMs), then the deadline: the rotate fires while listening.
  const h = harness({
    store,
    greeting: '',
    turn: async () => reply('Montag um neun passt.'),
    deadlineInMs: 400,
    limits: { rotateListenMs: 100, rotateThinkMs: 150, roundFloorMs: 10, idleAskMs: 5000, idleEndMs: 5000 },
  });
  await h.setup();
  await until(() => h.texts().includes('Montag um neun passt.'));
  assert.equal(textMessages(h)[0]?.lang, 'de-DE');
  assert.equal(languageMessages(h).length, 0);
  // German prompts are not noted again: the assistant is already speaking German.
  await h.say('Danke.', 'de');
  await until(() => h.turns.length === 2);
  assert.equal(h.turns[1]?.history.at(-1)?.text, 'Danke.');
  // The deadline arrives: the rotate courtesy is German too.
  await until(() => h.ends().length === 1, 3000);
  assert.equal(h.ends()[0]?.reason, 'rotate');
  assert.equal(h.texts().at(-1), SENTENCES_BY_LANG.de!.rotate);
  assert.equal(textMessages(h).at(-1)?.lang, 'de-DE');
  await h.session.finished;
});

test('the sentence table covers every language the settings ship, falls back to English for the rest, and English is spelled en-US', () => {
  for (const tag of ['es', 'pt', 'fr', 'de', 'it']) {
    const table = SENTENCES_BY_LANG[tag]!;
    for (const key of Object.keys(SENTENCES) as (keyof typeof SENTENCES)[]) assert.ok(table[key]?.trim(), `${tag}.${key}`);
  }
  assert.equal(sentencesFor('es-US'), SENTENCES_BY_LANG.es);
  assert.equal(sentencesFor('pt-BR'), SENTENCES_BY_LANG.pt);
  assert.equal(sentencesFor('ja-JP'), SENTENCES);
  assert.equal(sentencesFor(null), SENTENCES);
  assert.equal(ttsLangOf(null), 'en-US');
  assert.equal(ttsLangOf('en-GB'), 'en-US');
  assert.equal(ttsLangOf('fr-CA'), 'fr-CA');
});
