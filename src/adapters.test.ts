import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { SlotTaken } from './crm/port.ts';
import { WhitelabelCrm } from './crm/whitelabel.ts';
import { MemoryStore } from './store/memory.ts';
import { PostgresStore } from './store/postgres.ts';
import type { ServiceStore } from './store/store.ts';
import { connectRelay, isWithheld, twilioSignature, verifyTwilioSignature } from './twilio.ts';

/* The edges of the service: the two stores, the whitelabel-crm adapter, and what is said to Twilio. */

async function storeContract(store: ServiceStore) {
  const call = await store.createCall({ callSid: 'CA00000000000000000000000000000002', from: '+13105550142', to: '+13105550100' });
  assert.equal((await store.createCall({ callSid: 'CA00000000000000000000000000000002', from: '+13105550142', to: '+13105550100' })).id, call.id, 'a webhook retried is the same call');
  assert.equal((await store.callById(call.id))?.providerId, 'CA00000000000000000000000000000002');
  assert.equal(await store.callById('00000000-0000-4000-8000-000000000000'), null);

  const opened = await store.open('default', call.id);
  assert.deepEqual([opened.status, opened.rotateCount, opened.turnCount], ['live', 0, 0]);
  await store.append('default', call.id, [{ role: 'user', text: 'Hi', ts: 1 }, { role: 'assistant', text: 'Hello, how can I help you today?', ts: 2 }]);
  assert.equal(await store.truncateLast('default', call.id, 'Hello, how'), true);
  await store.setState('default', call.id, { lang: 'es-US', lookedUp: 'c1' });
  let row = (await store.byCall('default', call.id))!;
  assert.equal(row.turnCount, 2);
  assert.deepEqual([row.turns[1]!.text, row.turns[1]!.interrupted], ['Hello, how', true]);
  assert.deepEqual([row.state.lang, row.state.lookedUp, row.state.transferAttempts], ['es-US', 'c1', 0]);

  // A reconnection: same conversation, one rotation further; the connection it replaced can no longer close it.
  assert.equal((await store.open('default', call.id)).rotateCount, 1);
  assert.equal(await store.end('default', call.id, { reason: 'assistant-ended', outcome: 'booked', expectedRotateCount: 0 }), false);
  assert.equal(await store.end('default', call.id, { reason: 'assistant-ended', outcome: 'booked', costCents: 3, expectedRotateCount: 1 }), true);
  row = (await store.byCall('default', call.id))!;
  assert.deepEqual([row.status, row.endReason, row.outcome, row.costCents], ['ended', 'assistant-ended', 'booked', 3]);
  assert.ok((await store.markAnswered(call)).answeredAt);
}

test('the in-memory store keeps the session contract', () => storeContract(new MemoryStore()));

test('the Postgres store keeps the same contract, on a real Postgres engine', async () => {
  const pg = new PGlite();
  const store = new PostgresStore(async (sql, params) => ({ rows: (await pg.query(sql, params)).rows as Record<string, unknown>[] }));
  await store.ensureSchema();
  await store.ensureSchema(); // running it again changes nothing
  await storeContract(store);
  await pg.close();
});

test('the whitelabel-crm adapter speaks the connector API and sends the key nowhere else', async () => {
  const seen: { method: string; path: string; auth: string | null; body: any }[] = [];
  const answers: Record<string, (body: any) => { status?: number; json: unknown }> = {
    'GET /api/v1/connector/owner/calendar': () => ({ json: { ok: true, calendar: { timezone: 'America/Chicago', duration_min: 20 }, slots: [{ start: '2026-06-01T15:00:00.000Z' }], appointments: [{ id: 'a1', start: '2026-06-02T15:00:00.000Z', title: 'Discovery call' }] } }),
    'GET /api/v1/connector/contacts': () => ({ json: { ok: true, contacts: [{ id: 'c9', first_name: 'Other', last_name: null, email: null, phone: '+13105550199', company: null, updated_at: 'u0' }, { id: 'c1', first_name: 'Dana', last_name: 'Whitfield', email: null, phone: '(310) 555-0142', company: 'Acme', updated_at: 'u1' }] } }),
    'GET /api/v1/connector/contacts/c1': () => ({ json: { ok: true, contact: { id: 'c1', first_name: 'Dana', last_name: 'Whitfield', email: null, phone: '+13105550142', company: 'Acme', updated_at: 'u1' } } }),
    'PATCH /api/v1/connector/contacts/c1': (body) => ({ json: { ok: true, contact: { id: 'c1', first_name: 'Dana', last_name: 'Whitfield', email: body.fields.email, phone: '+13105550142', company: 'Acme', updated_at: 'u2' } } }),
    'POST /api/v1/connector/owner/actions': (body) => (body.key === 'calendar.move' ? { status: 409, json: { ok: false, error: 'That time is taken.' } } : { json: { ok: true, result: { id: 'a2' } } }),
  };
  const fetchImpl = (async (url: URL, init: RequestInit) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    assert.equal(url.origin, 'https://crm.example.com', 'the key leaves only for the configured origin');
    assert.equal(init.redirect, 'error');
    seen.push({ method: init.method!, path: url.pathname + url.search, auth: (init.headers as Record<string, string>).authorization ?? null, body });
    const answer = answers[`${init.method} ${url.pathname}`]!(body);
    return new Response(JSON.stringify(answer.json), { status: answer.status ?? 200 });
  }) as unknown as typeof fetch;
  const crm = new WhitelabelCrm({ origin: 'https://crm.example.com/', apiKey: 'crm_live_test', calendarId: '11111111-1111-4111-8111-111111111111', business: { name: 'Acme', hours: '', knowledge: '', appointmentName: 'a discovery call', appointmentMinutes: 30 }, fetchImpl });

  const facts = await crm.business();
  assert.deepEqual([facts.timezone, facts.appointmentMinutes], ['America/Chicago', 20], 'the calendar’s own zone and length win');
  assert.equal((await crm.findCallerByPhone('+13105550142'))?.id, 'c1', 'only the exact number is this caller');
  assert.equal((await crm.saveCaller({ id: 'c1', email: 'dana@example.com' })).email, 'dana@example.com');
  assert.deepEqual(seen.at(-1)!.body, { expected_updated_at: 'u1', fields: { email: 'dana@example.com' } }, 'an edit names the version it read');
  assert.deepEqual(await crm.openSlots({ fromIso: '2026-06-01T00:00:00.000Z', toIso: '2026-06-08T00:00:00.000Z', limit: 6 }), [{ startIso: '2026-06-01T15:00:00.000Z' }]);
  assert.equal((await crm.appointmentsFor('c1'))[0]!.id, 'a1');
  assert.equal((await crm.book({ callerId: 'c1', startIso: '2026-06-01T15:00:00.000Z', notes: 'New site' })).id, 'a2');
  assert.deepEqual(seen.at(-1)!.body, { key: 'calendar.book', input: { calendarId: '11111111-1111-4111-8111-111111111111', contactId: 'c1', start: Date.parse('2026-06-01T15:00:00.000Z'), notes: 'New site', notify: 'on' }, files: [] });
  await assert.rejects(crm.reschedule({ appointmentId: 'a1', startIso: '2026-06-01T15:00:00.000Z' }), SlotTaken);
  await crm.leaveMessage({ callerId: 'c1', phone: '+13105550142', text: 'Call me back.' });
  assert.deepEqual(seen.slice(-2).map((s) => s.body.key), ['contacts.task', 'contacts.note']);
  await crm.recordCall({ callSid: 'CA1', from: '+13105550142', to: '+13105550100', callerId: 'c1', startedAt: new Date(0), endedAt: new Date(120_000), outcome: 'booked', endReason: 'assistant-ended', language: null, transcript: [{ role: 'caller', text: 'Hi', at: new Date(0) }] });
  assert.deepEqual([seen.at(-1)!.body.key, seen.at(-1)!.body.input.minutes, seen.at(-1)!.body.input.outcome], ['contacts.logCall', '2', 'connected']);
  assert.ok(seen.every((s) => s.auth === 'Bearer crm_live_test'));
  assert.throws(() => new WhitelabelCrm({ origin: 'http://crm.example.com', apiKey: 'k', calendarId: 'x', business: { name: 'A', hours: '', knowledge: '', appointmentName: 'a call', appointmentMinutes: 30 } }), /https/);
});

test('Twilio: the signature is checked, the TwiML is escaped, and language switching needs ElevenLabs', () => {
  const url = 'https://receptionist.example.com/twilio/voice';
  const params = { CallSid: 'CA1', From: '+13105550142' };
  const signature = twilioSignature(url, params, 'token');
  assert.equal(verifyTwilioSignature(signature, [url], params, 'token'), true);
  assert.equal(verifyTwilioSignature(signature, [url], { ...params, From: '+13105550143' }, 'token'), false);
  assert.equal(verifyTwilioSignature(signature, [`${url}?x=1`], params, 'token'), false);
  assert.equal(verifyTwilioSignature(null, [url], params, 'token'), false);
  assert.equal(verifyTwilioSignature(signature, [url], params, ''), false);

  const base = { url: 'wss://r.example.com/twilio/relay?call=1&exp=2&sig=3', action: 'https://r.example.com/twilio/done?call=1', welcomeGreeting: 'Hi, thanks for calling "Smith & Sons".', voice: 'v1', languages: [{ code: 'es-US', voice: 'v2' }], parameters: { call: '1' } };
  const eleven = connectRelay({ ...base, ttsProvider: 'ElevenLabs' });
  assert.match(eleven, /welcomeGreeting="Hi, thanks for calling &quot;Smith &amp; Sons&quot;\."/);
  assert.match(eleven, /url="wss:\/\/r\.example\.com\/twilio\/relay\?call=1&amp;exp=2&amp;sig=3"/);
  assert.match(eleven, /language="multi"/);
  assert.match(eleven, /<Language code="es-US" ttsProvider="ElevenLabs" voice="v2"\/>/);
  assert.match(eleven, /<Parameter name="call" value="1"\/>/);
  const amazon = connectRelay({ ...base, ttsProvider: 'Amazon', voice: '' });
  assert.match(amazon, /language="en-US"/);
  assert.doesNotMatch(amazon, /<Language /);
  assert.match(amazon, /voice="Joanna-Neural"/);
  assert.doesNotMatch(connectRelay({ ...base, ttsProvider: 'ElevenLabs', welcomeGreeting: undefined }), /welcomeGreeting/, 'a reconnection does not greet again');

  assert.deepEqual(['anonymous', 'Restricted', '', null, '+13105550142'].map(isWithheld), [true, true, true, true, false]);
});
