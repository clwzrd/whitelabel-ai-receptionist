process.env.APP_SECRET ??= 'test-secret-for-relay-tokens';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import { Receptionist } from './app.ts';
import { MemoryCrm } from './crm/memory.ts';
import { createReceptionistServer } from './server.ts';
import { MemoryStore } from './store/memory.ts';
import { TEST_ACCOUNT, TEST_AUTH_TOKEN, say, scriptedProvider, testConfig, until } from './testing.ts';
import { twilioSignature } from './twilio.ts';

/*
 * The service over a real port: HTTP for Twilio's webhooks and a real
 * WebSocket for the relay, on localhost. Twilio signs the public URL, so the
 * test signs that URL too and reaches the server on its local port.
 */

const PUBLIC = 'https://receptionist.example.com';
const SID = 'CA00000000000000000000000000000003';

test('the server answers the webhook with TwiML, admits the signed socket and speaks over it', async (t) => {
  const config = testConfig();
  const crm = new MemoryCrm({ business: config.business });
  const store = new MemoryStore();
  const app = new Receptionist(config, crm, store, scriptedProvider([() => say('We are open Monday to Friday, nine to five.')]));
  const server = createReceptionistServer(config, crm, store, app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const local = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  assert.deepEqual(await (await fetch(`${local}/health`)).json(), { ok: true });
  assert.equal((await fetch(`${local}/nothing-here`)).status, 404);

  const params = { CallSid: SID, From: '+13105550142', To: '+13105550100', AccountSid: TEST_ACCOUNT };
  const post = (signature: string | null) => fetch(`${local}/twilio/voice`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...(signature ? { 'x-twilio-signature': signature } : {}) }, body: new URLSearchParams(params) });
  assert.equal((await post(null)).status, 403, 'no signature, no TwiML');
  const answered = await post(twilioSignature(`${PUBLIC}/twilio/voice`, params, TEST_AUTH_TOKEN));
  assert.equal(answered.status, 200);
  assert.match(answered.headers.get('content-type') ?? '', /text\/xml/);
  const body = await answered.text();
  const socketUrl = /<ConversationRelay url="([^"]+)"/.exec(body)![1]!.replaceAll('&amp;', '&');
  assert.match(socketUrl, /^wss:\/\/receptionist\.example\.com\/twilio\/relay\?call=/);

  const path = socketUrl.replace('wss://receptionist.example.com', '');
  const dial = (signature: string | null, target = path) => new WebSocket(`${local.replace('http', 'ws')}${target}`, { headers: signature ? { 'x-twilio-signature': signature } : {} });

  // Unsigned, and signed with a forged token: the handshake itself is refused.
  for (const ws of [dial(null), dial(twilioSignature(socketUrl.replace(/sig=[0-9a-f]{6}/, 'sig=ffffff'), {}, TEST_AUTH_TOKEN), path.replace(/sig=[0-9a-f]{6}/, 'sig=ffffff'))]) {
    const status = await new Promise<number>((resolve) => { ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0)); ws.on('open', () => resolve(101)); ws.on('error', () => {}); });
    assert.equal(status, 403);
  }

  const ws = dial(twilioSignature(socketUrl, {}, TEST_AUTH_TOKEN));
  const heard: { type: string; token?: string }[] = [];
  ws.on('message', (data) => heard.push(JSON.parse(String(data))));
  await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
  const callId = new URL(socketUrl).searchParams.get('call')!;
  ws.send(JSON.stringify({ type: 'setup', sessionId: 'VX1', accountSid: TEST_ACCOUNT, callSid: SID, customParameters: { call: callId } }));
  ws.send(JSON.stringify({ type: 'prompt', voicePrompt: 'Are you open on Saturday?', last: true }));
  await until(() => heard.filter((m) => m.type === 'text').map((m) => m.token).join('').includes('nine to five'), 5000);

  // The caller hangs up: the socket closes, and Twilio's action webhook files the call.
  ws.close();
  await until(() => ws.readyState === WebSocket.CLOSED);
  const doneParams = { CallSid: SID, AccountSid: TEST_ACCOUNT };
  const doneUrl = `/twilio/done?call=${callId}`;
  const done = await fetch(`${local}${doneUrl}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': twilioSignature(`${PUBLIC}${doneUrl}`, doneParams, TEST_AUTH_TOKEN) }, body: new URLSearchParams(doneParams) });
  assert.match(await done.text(), /<Hangup\/>/);
  assert.equal(crm.calls.length, 1);
  assert.ok(crm.calls[0]!.transcript.some((line) => line.role === 'caller' && line.text === 'Are you open on Saturday?'));
  assert.ok(crm.calls[0]!.transcript.some((line) => line.role === 'assistant' && line.text.includes('nine to five')));
});
