/**
 * The AI receptionist's WebSocket, as a standalone server for local calls.
 *
 *     npm run relay:dev
 *
 * `astro dev` cannot upgrade a connection, so on a developer's machine the
 * socket lives here and the TwiML keeps coming from the Astro dev server.
 * Two tunnels: one in front of `astro dev` (its address goes in
 * `PUBLIC_CALLBACK_ORIGIN`), one in front of this port (its `wss://` address
 * goes in `VOICE_RELAY_URL`). Twilio signs the URL it dialled — the second
 * tunnel's host — so try without `VOICE_RELAY_ALLOW_UNSIGNED` first; the flag
 * exists for a tunnel that rewrites headers, and is ignored on Vercel.
 *
 * Every connection goes through the same `admit()` as production, handed a
 * Fetch `Request` rebuilt from the raw upgrade request (the forwarded host is
 * what Twilio signed). The deadline is eight hours away: there is no
 * function to be killed here, and a rotate every five minutes would only get
 * in the way of listening to the conversation.
 */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { WebSocketServer } from 'ws';

function loadEnv(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  let text = '';
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return out;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]!] = m[2]!.replace(/^"|"$/g, '');
  }
  return out;
}
const root = resolve(import.meta.dirname ?? '.', '..');
for (const file of ['.env.development', '.env']) {
  for (const [k, v] of Object.entries(loadEnv(resolve(root, file)))) if (!process.env[k]) process.env[k] = v;
}

const { admit } = await import('../src/lib/voice/relay/admit.ts');
const { runRelaySocket } = await import('../src/lib/voice/relay/socket.ts');

const port = Number(process.env.RELAY_DEV_PORT ?? '8787') || 8787;
const EIGHT_HOURS = 8 * 60 * 60 * 1000;

const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(`relay dev server · upgradeWebSocket: available · deadline: none (8h) · port: ${port}\n`);
});
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

server.on('upgrade', (req, socket, head) => {
  void (async () => {
    const proto = String(req.headers['x-forwarded-proto'] ?? 'ws').replace(/^http/, 'ws');
    const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? `localhost:${port}`);
    const url = new URL(req.url ?? '/', `${proto}://${host}`);
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') headers.set(name, value);
      else if (Array.isArray(value)) headers.set(name, value.join(', '));
    }
    const request = new Request(url.toString(), { headers });
    console.log('[relay-dev] upgrade', url.toString(), 'signature:', headers.get('x-twilio-signature') ? 'present' : 'absent');

    let gate: Awaited<ReturnType<typeof admit>>;
    try {
      gate = await admit(request, url);
    } catch (error) {
      console.error('[relay-dev] admit threw', error);
      socket.write('HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    if (gate instanceof Response) {
      console.warn('[relay-dev] refused', gate.status);
      socket.write(`HTTP/1.1 ${gate.status} ${gate.statusText || 'Refused'}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      console.log('[relay-dev] admitted call', gate.call.id);
      runRelaySocket(ws, gate, Date.now() + EIGHT_HOURS)
        .then(() => console.log('[relay-dev] session over', gate.call.id))
        .catch((error) => console.error('[relay-dev] session failed', gate.call.id, error));
    });
  })();
});

server.listen(port, () => {
  console.log(`[relay-dev] listening on ws://localhost:${port}/api/twilio/relay`);
  console.log('[relay-dev] VOICE_RELAY_URL =', process.env.VOICE_RELAY_URL ?? '(unset — set it to the wss:// tunnel in front of this port)');
});
