process.env.APP_SECRET ??= 'test-secret-for-relay-tokens';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Receptionist } from './app.ts';
import { MemoryCrm } from './crm/memory.ts';
import type { OutMessage } from './engine/types.ts';
import { MemoryStore } from './store/memory.ts';
import { FAST, TEST_ACCOUNT, TEST_AUTH_TOKEN, call, say, scriptedProvider, seen, testConfig, until, type Step } from './testing.ts';
import { twilioSignature } from './twilio.ts';

/*
 * A whole call, from the ring to the CRM, with a scripted model, an in-memory
 * CRM and no socket: the three entry points of `Receptionist` are driven the
 * way Twilio drives them.
 */

const PUBLIC = 'https://receptionist.example.com';
const SID = 'CA00000000000000000000000000000001';

function ring(app: Receptionist, from = '+13105550142') {
  const params = { CallSid: SID, From: from, To: '+13105550100', AccountSid: TEST_ACCOUNT };
  const url = `${PUBLIC}/twilio/voice`;
  return app.voice({ url, params, signature: twilioSignature(url, params, TEST_AUTH_TOKEN) });
}

async function connect(app: Receptionist, twimlBody: string) {
  const socket = /<ConversationRelay url="([^"]+)"/.exec(twimlBody)![1]!.replaceAll('&amp;', '&');
  const admission = await app.admit({ url: socket, params: {}, signature: twilioSignature(socket, {}, TEST_AUTH_TOKEN) });
  assert.equal(admission.ok, true, admission.ok ? '' : admission.why);
  if (!admission.ok) throw new Error('not admitted');
  const sent: OutMessage[] = [];
  const session = app.session(admission, { send: (m) => sent.push(m), close: () => {} }, FAST);
  const callId = new URL(socket).searchParams.get('call')!;
  await session.receive({ type: 'setup', sessionId: 'VX1', accountSid: TEST_ACCOUNT, callSid: SID, customParameters: { call: callId } });
  const texts = () => sent.filter((m): m is Extract<OutMessage, { type: 'text' }> => m.type === 'text').map((m) => m.token).join('');
  const hear = async (words: string) => {
    const before = sent.length;
    await session.receive({ type: 'prompt', voicePrompt: words, last: true });
    await until(() => sent.length > before);
  };
  return { session, sent, callId, socket, texts, hear };
}

function hangUp(app: Receptionist, callId: string, handoff: string | undefined) {
  const url = `${PUBLIC}/twilio/done?call=${callId}`;
  const params: Record<string, string> = { CallSid: SID, AccountSid: TEST_ACCOUNT, ...(handoff ? { HandoffData: handoff } : {}) };
  return app.done({ url, params, signature: twilioSignature(url, params, TEST_AUTH_TOKEN) });
}

const firstOffered = (input: Parameters<Step>[0]) => /\[(\d{4}-\d{2}-\d{2}T[^\]]+Z)\]/.exec(seen(input))![1]!;

test('a caller books an appointment: the ring, the conversation, the booking in the CRM, the call on file', async () => {
  const crm = new MemoryCrm({ business: testConfig().business });
  const store = new MemoryStore();
  const model = scriptedProvider([
    () => call('save_caller_details', { name: 'Dana Whitfield' }),
    () => call('list_open_times'),
    () => say('I have a time on the next business day. Does the first one work?'),
    (input) => call('book_appointment', { start: firstOffered(input), notes: 'New website' }),
    () => say('You are booked. Anything else?'),
    () => call('end_call'),
  ]);
  const app = new Receptionist(testConfig(), crm, store, model);

  const rung = await ring(app);
  assert.equal(rung.status, 200);
  assert.match(rung.body, /<Connect action="https:\/\/receptionist\.example\.com\/twilio\/done\?call=/);
  assert.match(rung.body, /welcomeGreeting="Hi, thanks for calling Acme Plumbing\. This is Ava, the AI assistant\./, 'the greeting says it is an AI');
  assert.match(rung.body, /language="multi"/);
  assert.match(rung.body, /<Language code="es-US" ttsProvider="ElevenLabs" voice="[^"]+"\/>/);

  const line = await connect(app, rung.body);
  await line.hear('Hi, this is Dana Whitfield. I would like to book a call.');
  await until(() => line.texts().includes('Does the first one work?'));
  await line.hear('Yes, that works.');
  await until(() => line.texts().includes('You are booked.'));

  const [appointment] = [...crm.appointments.values()];
  assert.ok(appointment, 'the CRM has the appointment');
  const caller = crm.callers.get(appointment.callerId)!;
  assert.equal(caller.name, 'Dana Whitfield');
  assert.equal(caller.phone, '+13105550142');
  assert.equal(appointment.notes, 'New website');
  assert.equal((await crm.openSlots({ fromIso: appointment.startIso, toIso: appointment.startIso, limit: 1 })).length, 0, 'the time is no longer open');

  await line.hear('No, that is all. Bye.');
  await until(() => line.sent.some((m) => m.type === 'end'));
  const end = line.sent.find((m): m is Extract<OutMessage, { type: 'end' }> => m.type === 'end')!;
  assert.equal(JSON.parse(end.handoffData!).reason, 'assistant-ended');
  await line.session.finished;
  await line.session.flush();

  const done = await hangUp(app, line.callId, end.handoffData);
  assert.match(done.body, /<Hangup\/>/);
  assert.equal(crm.calls.length, 1);
  assert.equal(crm.calls[0]!.outcome, 'booked');
  assert.equal(crm.calls[0]!.callerId, caller.id);
  assert.ok(crm.calls[0]!.transcript.some((t) => t.role === 'caller' && t.text.includes('Dana Whitfield')));
  assert.ok(crm.calls[0]!.transcript.some((t) => t.role === 'assistant' && t.text.includes('You are booked.')));
  await hangUp(app, line.callId, end.handoffData);
  assert.equal(crm.calls.length, 1, 'Twilio asking twice files the call once');

  // What the model was told: the business, the rules, and never a caller's history as assistant speech before they spoke.
  assert.match(model.asked[0]!.systemFixed, /answering the phone for Acme Plumbing/);
  assert.match(model.asked[0]!.systemFixed, /Never invent a price/);
  assert.equal(model.asked[0]!.messages[0]!.role, 'user');
});

test('a webhook or a socket without Twilio’s signature, or with a forged token, is refused', async () => {
  const app = new Receptionist(testConfig(), new MemoryCrm(), new MemoryStore(), scriptedProvider([]));
  const url = `${PUBLIC}/twilio/voice`;
  const params = { CallSid: SID, From: '+13105550142', To: '+13105550100', AccountSid: TEST_ACCOUNT };
  assert.equal((await app.voice({ url, params, signature: null })).status, 403);
  assert.equal((await app.voice({ url, params, signature: twilioSignature(url, params, 'another-token') })).status, 403);
  const other = { ...params, AccountSid: 'AC00000000000000000000000000000009' };
  assert.equal((await app.voice({ url, params: other, signature: twilioSignature(url, other, TEST_AUTH_TOKEN) })).status, 403, 'another account is not this line');

  const rung = await ring(app);
  const socket = /<ConversationRelay url="([^"]+)"/.exec(rung.body)![1]!.replaceAll('&amp;', '&');
  const unsigned = await app.admit({ url: socket, params: {}, signature: null });
  assert.deepEqual([unsigned.ok, !unsigned.ok && unsigned.status], [false, 403]);
  const forged = socket.replace(/sig=[0-9a-f]{8}/, 'sig=00000000');
  const bad = await app.admit({ url: forged, params: {}, signature: twilioSignature(forged, {}, TEST_AUTH_TOKEN) });
  assert.deepEqual([bad.ok, !bad.ok && bad.status], [false, 403]);
  const stale = socket.replace(/exp=\d+/, 'exp=1000');
  const old = await app.admit({ url: stale, params: {}, signature: twilioSignature(stale, {}, TEST_AUTH_TOKEN) });
  assert.equal(old.ok, false);
  const nobody = socket.replace(/call=[^&]+/, 'call=00000000-0000-4000-8000-000000000000');
  const missing = await app.admit({ url: nobody, params: {}, signature: twilioSignature(nobody, {}, TEST_AUTH_TOKEN) });
  assert.deepEqual([missing.ok, !missing.ok && missing.status], [false, 404]);
});

test('a transfer is dialled only when somebody can take it; otherwise the assistant takes a message', async () => {
  // Nobody to transfer to: the tool says so and the model takes a message.
  const crm = new MemoryCrm();
  const model = scriptedProvider([
    () => call('transfer_to_human', { reason: 'wants a person' }),
    () => call('leave_message_for_team', { message: 'Wants a call back about a leak.' }),
    () => say('Nobody is free right now, so I left a message for the team.'),
  ]);
  const app = new Receptionist(testConfig(), crm, new MemoryStore(), model);
  const line = await connect(app, (await ring(app)).body);
  await line.hear('Can I talk to a person?');
  await until(() => line.texts().includes('I left a message for the team.'));
  assert.equal(crm.messages.length, 1);
  assert.equal(crm.messages[0]!.phone, '+13105550142');
  assert.equal(line.sent.some((m) => m.type === 'end'), false, 'the call goes on');
  await line.session.flush(); // the caller hangs up

  // Somebody can: the engine says its own sentence, ends the relay, and Twilio is told to dial.
  const withTransfer = testConfig();
  withTransfer.voice.transferTo = '+13105550199';
  const app2 = new Receptionist(withTransfer, new MemoryCrm(), new MemoryStore(), scriptedProvider([() => call('transfer_to_human', { reason: 'urgent' })]));
  const line2 = await connect(app2, (await ring(app2)).body);
  await line2.hear('This is urgent, I need a person.');
  await until(() => line2.sent.some((m) => m.type === 'end'));
  const end = line2.sent.find((m): m is Extract<OutMessage, { type: 'end' }> => m.type === 'end')!;
  assert.deepEqual(JSON.parse(end.handoffData!), { reason: 'transfer', to: '+13105550199' });
  await line2.session.finished;
  await line2.session.flush();
  const done = await hangUp(app2, line2.callId, end.handoffData);
  assert.match(done.body, /<Dial[^>]*>\+13105550199<\/Dial>/);
});

test('a caller who hid their number is never looked up', async () => {
  const crm = new MemoryCrm();
  let lookups = 0;
  const find = crm.findCallerByPhone.bind(crm);
  crm.findCallerByPhone = async (phone) => { lookups += 1; return find(phone); };
  const model = scriptedProvider([() => say('Sure. May I have your name?')]);
  const app = new Receptionist(testConfig(), crm, new MemoryStore(), model);
  const line = await connect(app, (await ring(app, 'anonymous')).body);
  await line.hear('Hello?');
  await until(() => line.texts().includes('May I have your name?'));
  assert.equal(lookups, 0);
  assert.equal(model.asked[0]!.tools.some((t) => t.name === 'look_up_caller'), false);
  assert.match(model.asked[0]!.systemVariable, /caller ID is withheld/);
  await line.session.flush(); // the caller hangs up
});
