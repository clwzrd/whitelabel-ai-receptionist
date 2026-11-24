/**
 * The production canary's second step: a real `wss://` client against the
 * deployed relay route.
 *
 *     npx --yes tsx scripts/relay-probe.ts [https://crm.example.com]
 *
 * Creates a throwaway call row in the first workspace that has Twilio
 * connected (or `RELAY_PROBE_WORKSPACE`), routed to the assistant, mints a
 * token for it exactly as `relayOpening` would, opens the socket and sends a
 * bogus `setup`. The expected answer is `end` with
 * `{"reason":"failed","why":"setup mismatch"}` — which proves, in one go,
 * that the runtime upgrades, that `admit()` let a valid token through, that
 * the session engine runs inside the function and that a wrong setup is
 * refused rather than talked to. The handshake carries no Twilio signature,
 * so on Vercel the probe is refused with 403 unless it is pointed at a dev
 * server started with `VOICE_RELAY_ALLOW_UNSIGNED=1`; a 403 on Vercel is
 * itself the proof that the signature check is live, and the server logs the
 * URL and forwarded headers it saw so the signature candidates can be read
 * off the first real connect. The `probe=1` marker keeps that refusal out of
 * `error_log`, where it would otherwise show on the calls card as the
 * workspace's last relay error.
 *
 * `admit()` prepares the model turn before it upgrades, and that needs a
 * contact on the call (the withheld-number contact is made by the inbound
 * webhook, which the probe skips), so the probe inserts a throwaway contact
 * too. When the workspace has no enabled agent with a proved connection the
 * answer is HTTP 503 and a row in `error_log` with `where='relay'`; the probe
 * prints what that means rather than calling it a failure of the socket.
 *
 * The call row and the contact are deleted in `finally`.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { WebSocket } from 'ws';

function loadEnv(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]!] = m[2]!.replace(/^"|"$/g, '');
  }
  return out;
}
const root = resolve(import.meta.dirname ?? '.', '..');
for (const [k, v] of Object.entries(loadEnv(resolve(root, '.env')))) if (!process.env[k]) process.env[k] = v;

const { getDb, schema } = await import('../src/db/index.ts');
const { mintRelayToken } = await import('../src/lib/voice/relay/token.ts');

const origin = (process.argv[2] ?? process.env.PUBLIC_CALLBACK_ORIGIN ?? 'https://crm.example.com').replace(/\/$/, '');
const wsOrigin = (process.env.VOICE_RELAY_URL ?? origin.replace(/^http/, 'ws')).replace(/\/$/, '');
const db = getDb();

const [integration] = await db
  .select({ workspaceId: schema.integrations.workspaceId })
  .from(schema.integrations)
  .where(
    process.env.RELAY_PROBE_WORKSPACE
      ? and(eq(schema.integrations.provider, 'twilio'), eq(schema.integrations.workspaceId, process.env.RELAY_PROBE_WORKSPACE))
      : eq(schema.integrations.provider, 'twilio'),
  )
  .limit(1);
if (!integration) throw new Error('no workspace with Twilio connected');
const workspaceId = integration.workspaceId;

const fakeSid = `CA${'0'.repeat(30)}probe`.slice(0, 34);
const [contact] = await db
  .insert(schema.contacts)
  .values({ workspaceId, firstName: 'Relay', lastName: 'Probe', phone: '+15005550006', source: 'relay-probe' })
  .returning();
if (!contact) throw new Error('could not create the probe contact');
const [call] = await db
  .insert(schema.calls)
  .values({
    workspaceId,
    contactId: contact.id,
    direction: 'in',
    fromNumber: '+15005550006',
    toNumber: '+15005550006',
    status: 'ringing',
    providerId: fakeSid,
    startedAt: new Date(),
    meta: { routed: 'ai', probe: true },
  })
  .returning();
if (!call) {
  await db.delete(schema.contacts).where(eq(schema.contacts.id, contact.id));
  throw new Error('could not create the probe call');
}

try {
  console.log('probe: GET', `${origin}/api/twilio/relay`);
  const plain = await fetch(`${origin}/api/twilio/relay`);
  console.log('probe:', plain.status, await plain.text());

  const token = await mintRelayToken(call.id, fakeSid);
  // `probe=1` tells `admit()` this unsigned handshake is the canary, not an attacker: refused all the same, but not filed as the workspace's last relay error.
  const url = `${wsOrigin}/api/twilio/relay?call=${call.id}&exp=${token.exp}&sig=${token.sig}&probe=1`;
  console.log('probe: connecting', url.replace(token.sig, '<sig>'));

  await new Promise<void>((resolveDone, reject) => {
    const started = Date.now();
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('no answer in 30 s'));
    }, 30_000);
    ws.on('open', () => {
      console.log(`probe: handshake in ${Date.now() - started} ms`);
      ws.send(JSON.stringify({ type: 'setup', sessionId: 'VXprobe', accountSid: 'ACprobe', callSid: 'CAprobe', customParameters: { call: 'nope' } }));
    });
    ws.on('message', (data) => {
      const text = data.toString();
      console.log('probe: <-', text);
      try {
        const parsed = JSON.parse(text) as { type?: string; handoffData?: string };
        if (parsed.type === 'end') {
          const handoff = parsed.handoffData ? (JSON.parse(parsed.handoffData) as { reason?: string; why?: string }) : {};
          if (handoff.reason === 'failed' && handoff.why === 'setup mismatch') {
            console.log('probe: OK — the engine refused a bogus setup, as expected');
          } else {
            console.log('probe: unexpected end payload', handoff);
          }
        }
      } catch {
        /* not JSON; already printed */
      }
    });
    ws.on('unexpected-response', (_req, res) => {
      clearTimeout(timer);
      const why =
        res.statusCode === 503
          ? 'the model turn could not be prepared — no enabled agent with a proved connection in this workspace; see error_log where=relay'
          : res.statusCode === 403
            ? '403 on Vercel means the Twilio signature check is live'
            : 'see the server log for the reason';
      console.log(`probe: refused with HTTP ${res.statusCode} (${why})`);
      resolveDone();
    });
    ws.on('close', (code, reason) => {
      clearTimeout(timer);
      console.log(`probe: closed ${code} ${reason.toString()} after ${Date.now() - started} ms`);
      resolveDone();
    });
    ws.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
} finally {
  await db.delete(schema.calls).where(eq(schema.calls.id, call.id));
  await db.delete(schema.contacts).where(eq(schema.contacts.id, contact.id));
  console.log('probe: call row and contact deleted');
}
