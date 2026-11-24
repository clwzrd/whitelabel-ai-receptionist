import { existsSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { Receptionist, parseIncoming, type TwilioRequest } from './app';
import { loadConfig, type Config } from './config';
import { MemoryCrm } from './crm/memory';
import type { CrmPort } from './crm/port';
import { WhitelabelCrm } from './crm/whitelabel';
import { MemoryStore } from './store/memory';
import { PostgresStore } from './store/postgres';
import type { ServiceStore } from './store/store';

/**
 * The HTTP and WebSocket front of the receptionist.
 *
 *   POST /twilio/voice   Twilio's webhook for an inbound call
 *   GET  /twilio/relay   the WebSocket ConversationRelay connects to
 *   POST /twilio/done    the <Connect> action, when the relay ends
 *   GET  /health         liveness
 */

async function readForm(req: IncomingMessage): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 64 * 1024) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
}

export function createReceptionistServer(config: Config, crm: CrmPort, store: ServiceStore, app = new Receptionist(config, crm, store)): Server {
  // Twilio signs the public URL, whatever proxy sits in front of this process.
  const publicUrl = (req: IncomingMessage, scheme: 'http' | 'ws') => `${config.publicUrl.replace(/^http/, scheme)}${req.url ?? '/'}`;
  const signature = (req: IncomingMessage) => (typeof req.headers['x-twilio-signature'] === 'string' ? req.headers['x-twilio-signature'] : null);

  const server = createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? '/').split('?')[0];
      const send = (status: number, body: string, type = 'text/xml; charset=utf-8') => {
        res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
        res.end(body);
      };
      try {
        if (req.method === 'GET' && path === '/health') return send(200, JSON.stringify({ ok: true }), 'application/json');
        if (req.method === 'POST' && (path === '/twilio/voice' || path === '/twilio/done')) {
          const request: TwilioRequest = { url: publicUrl(req, 'http'), params: await readForm(req), signature: signature(req) };
          if (path === '/twilio/voice') {
            const out = await app.voice(request);
            return send(out.status, out.body, out.status === 200 ? undefined : 'text/plain; charset=utf-8');
          }
          const out = await app.done(request);
          return send(out.status, out.body, out.status === 200 ? undefined : 'text/plain; charset=utf-8');
        }
        send(404, 'Not found', 'text/plain; charset=utf-8');
      } catch (error) {
        await store.recordError({ where: `http ${path}`, error });
        // Twilio reads TwiML even on an error path: the caller hears a sentence instead of dead air.
        send(200, '<?xml version="1.0" encoding="UTF-8"?><Response><Say>Sorry, we could not take your call right now. Please try again in a few minutes.</Say><Hangup/></Response>');
      }
    })();
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    void (async () => {
      const refuse = (status: number, reason: string) => {
        socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
        socket.destroy();
      };
      if ((req.url ?? '').split('?')[0] !== '/twilio/relay') return refuse(404, 'Not Found');
      let admission;
      try {
        admission = await app.admit({ url: publicUrl(req, 'ws'), params: {}, signature: signature(req) });
      } catch (error) {
        await store.recordError({ where: 'admit', error });
        return refuse(500, 'Internal Server Error');
      }
      if (!admission.ok) return refuse(admission.status, admission.why);
      wss.handleUpgrade(req, socket, head, (ws) => {
        const session = app.session(admission, {
          send: (m) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); },
          close: () => { if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(1000); },
        });
        ws.on('message', (data) => void session.receive(parseIncoming(data)));
        ws.on('error', (error) => session.fail(error));
        const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()));
        void Promise.race([closed, session.finished.then(() => new Promise((r) => setTimeout(r, 2000)))])
          .then(() => session.flush())
          .catch((error) => store.recordError({ where: 'session', error }));
      });
    })();
  });
  return server;
}

/** Copies .env into the environment for local runs; a variable that is already set wins. */
function loadDotEnv(): void {
  if (!existsSync('.env')) return;
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.replace(/^"|"$/g, '');
  }
}

export async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();
  const crm: CrmPort = config.crm.kind === 'whitelabel'
    ? new WhitelabelCrm({ origin: config.crm.origin, apiKey: config.crm.apiKey, calendarId: config.crm.calendarId, business: config.business })
    : new MemoryCrm({ business: config.business });
  let store: ServiceStore;
  if (config.databaseUrl) {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: config.databaseUrl });
    const postgres = new PostgresStore((sql, params) => pool.query(sql, params) as Promise<{ rows: Record<string, unknown>[] }>);
    await postgres.ensureSchema();
    store = postgres;
  } else {
    store = new MemoryStore();
  }
  createReceptionistServer(config, crm, store).listen(config.port, () => {
    console.log(`[receptionist] listening on :${config.port} · public ${config.publicUrl} · crm ${config.crm.kind} · store ${config.databaseUrl ? 'postgres' : 'memory'} · model ${config.ai.creds.model}`);
    if (config.allowUnsigned) console.warn('[receptionist] ALLOW_UNSIGNED=1: requests are accepted without Twilio\'s signature. Development only.');
  });
}

if (process.argv[1] && /server\.(ts|js|mjs)$/.test(process.argv[1])) {
  main().catch((error) => {
    console.error('[receptionist] could not start:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
