import { eq } from 'drizzle-orm';
import { getDb, schema, type Db } from '../../../db';
import { voiceTurnFor } from '../../ai/voice';
import { workspaceLang } from '../../i18n';
import { recordError } from '../../ops/errors';
import { twilioCreds } from '../../twilio/client';
import { candidateUrls, verifyTwilioSignature } from '../../twilio/signature';
import { callbackOrigin } from '../../twilio/voice';
import { loadVoiceSettings, voiceSettingsForNumber } from '../settings';
import { callById, hasEnded, type Call } from '../store';
import { relayGreeting } from './route';
import { dbSessionStore } from './store';
import { verifyRelayToken } from './token';
import { SESSION_TIMING, type SessionDeps } from './types';

/**
 * Who gets a socket.
 *
 * Every refusal here happens before the upgrade, because once
 * `experimental_upgradeWebSocket` has written its 101 there is no status code
 * left to send. The checks run cheapest and most telling first, and each one
 * is a different question: is this a WebSocket request at all; does the URL
 * name a real inbound call that was routed to the assistant and is still up;
 * does the CRM's own token verify for that call and that Twilio sid; does the
 * workspace still have Twilio credentials; and did Twilio sign the handshake
 * with them. Two proofs, ours and Twilio's, because each covers a case the
 * other does not (`token.ts` explains which).
 *
 * The same function admits connections on the standalone dev server, which
 * hands it a `Request` rebuilt from the raw upgrade request.
 */
export interface Admitted {
  call: Call;
  workspaceId: string;
  deps: Omit<SessionDeps, 'sink' | 'deadlineMs'>;
}

export interface AdmitOptions {
  db?: Db;
  nowMs?: number;
}

export async function admit(request: Request, url: URL, opts: AdmitOptions = {}): Promise<Admitted | Response> {
  if ((request.headers.get('upgrade') ?? '').toLowerCase() !== 'websocket') return refuse(426, 'expected a WebSocket upgrade');

  const db = opts.db ?? getDb();
  const nowMs = opts.nowMs ?? Date.now();
  const callId = url.searchParams.get('call') ?? '';
  const call = await callById(db, callId);
  if (!call) return refuse(403, 'no such call');
  if (call.direction !== 'in') return refuse(403, 'not an inbound call');
  if (hasEnded(call.status)) return refuse(410, 'the call has ended');
  if (call.meta.routed !== 'ai') return refuse(403, 'the call was not routed to the assistant');
  if (!call.providerId) return refuse(403, 'the call has no Twilio sid');

  const exp = Number(url.searchParams.get('exp') ?? '');
  const sig = url.searchParams.get('sig') ?? '';
  const verdict = await verifyRelayToken(call.id, call.providerId, exp, sig, nowMs);
  if (verdict === 'expired') return refuse(410, 'the relay token has expired');
  if (verdict !== 'ok') return refuse(403, 'the relay token did not verify');

  const creds = await twilioCreds(db, call.workspaceId);
  if (!creds) return refuse(403, 'workspace has no Twilio credentials');

  const signature = request.headers.get('x-twilio-signature');
  const candidates = relayCandidateUrls(request, callbackOrigin());
  if (signature) {
    const ok = await verifyTwilioSignature({ signature, urls: candidates, params: {}, authToken: creds.authToken });
    if (!ok) {
      /*
       * The one failure that cannot be reproduced without a real call, and
       * the one the canary is most likely to hit: Twilio signed the URL it
       * dialled and none of our candidates is that URL — an edge host, a
       * query string encoded differently. Everything needed to see which is
       * written down, sig and token redacted, under the call's workspace so
       * the calls card shows it as the last relay error.
       */
      await recordError(db, {
        where: 'relay',
        error: new Error(`Twilio signature did not verify on the WebSocket handshake; ${handshakeDetail(request, url, candidates)}`),
        workspaceId: call.workspaceId,
        path: url.pathname,
      });
      return refuse(403, 'Twilio signature did not verify');
    }
  } else if (!unsignedAllowed()) {
    /*
     * A missing header on Vercel is never a developer's tunnel; it is
     * somebody who has the URL and not the auth token. Logged, because the
     * one legitimate way this happens is Twilio changing what it signs, and
     * that is worth knowing the day it happens rather than the week after.
     * The probe script (`scripts/relay-probe.ts`) is the exception: it
     * announces itself with `?probe=1` and its refusal is the expected
     * answer, not an error for the owner's card.
     */
    if (url.searchParams.get('probe') !== '1') {
      await recordError(db, {
        where: 'relay',
        error: new Error(
          `${
            process.env.VERCEL && process.env.VOICE_RELAY_ALLOW_UNSIGNED === '1'
              ? 'VOICE_RELAY_ALLOW_UNSIGNED is set on Vercel and was ignored; the handshake carried no X-Twilio-Signature'
              : 'WebSocket handshake carried no X-Twilio-Signature'
          }; ${handshakeDetail(request, url, candidates)}`,
        ),
        workspaceId: call.workspaceId,
        path: url.pathname,
      });
    }
    return refuse(403, 'unsigned handshake', handshakeDetail(request, url, candidates));
  }

  const workspaceId = call.workspaceId;
  const [wsRow] = await db.select({ settings: schema.workspaces.settings }).from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)).limit(1);
  const teamLang = workspaceLang(wsRow?.settings);
  const settings = voiceSettingsForNumber(await loadVoiceSettings(db, workspaceId), call.toNumber);
  const store = dbSessionStore(db);

  /*
   * The greeting is whatever the TwiML told Twilio to say, and only on a
   * first connection: a resumed socket (rotate, transfer return) finds the
   * session row already there and must not append a greeting nobody heard.
   * Computed by the same helper `relayOpening` used, so the transcript never
   * claims words other than the ones spoken.
   */
  const existing = await store.byCall(workspaceId, call.id);
  const greeting = existing ? '' : await relayGreeting(db, workspaceId, settings);
  let bundle;
  try {
    bundle = await voiceTurnFor(db, call, settings, { nowMs });
  } catch (error) {
    // No model turn means no conversation; a refused handshake becomes a
    // 64102 on Twilio's side and `relay-done` sends the caller to voicemail.
    await recordError(db, { where: 'relay', error, workspaceId, path: url.pathname });
    return refuse(503, 'the model turn could not be prepared');
  }

  return {
    call,
    workspaceId,
    deps: {
      call,
      creds: { accountSid: creds.accountSid },
      settings,
      teamLang,
      workspaceId,
      turn: bundle.turn,
      store,
      limits: { ...SESSION_TIMING, maxTurns: bundle.maxTurns, maxMinutes: bundle.maxMinutes },
      greeting,
      transferTo: bundle.transferTo,
    },
  };
}

/**
 * Only a developer's machine may skip Twilio's signature, and only when they
 * said so. `VERCEL` is set on every deployment, preview included, so the
 * flag cannot be smuggled into production through the dashboard.
 */
function unsignedAllowed(): boolean {
  return process.env.VOICE_RELAY_ALLOW_UNSIGNED === '1' && !process.env.VERCEL;
}

/**
 * Every URL Twilio might have signed for this handshake.
 *
 * Twilio signs the `wss://` address it dialled; the server sees the request
 * as `https://` (or `http://` behind a tunnel), and `candidateUrls()` from the
 * webhook path never produces a `ws` scheme. So each of its candidates is
 * offered twice more with the scheme swapped, and a `wss://` request URL — as
 * the dev server rebuilds it — is offered unchanged as well.
 */
export function relayCandidateUrls(request: Request, canonicalOrigin: string | null): string[] {
  const base = candidateUrls(request, canonicalOrigin);
  const out: string[] = [];
  for (const candidate of base) {
    if (/^wss?:\/\//.test(candidate)) {
      out.push(candidate, candidate.replace(/^wss/, 'https').replace(/^ws:/, 'http:'));
      continue;
    }
    out.push(candidate.replace(/^https/, 'wss').replace(/^http:/, 'ws:'), candidate);
  }
  return Array.from(new Set(out));
}

/**
 * What the server saw of the handshake, for the log line and the error row:
 * the request URL and the forwarded headers Twilio's signature would have
 * been computed over, and every URL we tried. The token's signature is
 * redacted; the auth token never appears.
 */
export function handshakeDetail(request: Request, url: URL, candidates: string[]): string {
  const redact = (value: string) => value.replace(/([?&]sig=)[^&]*/g, '$1<redacted>');
  const header = (name: string) => request.headers.get(name) ?? '-';
  return [
    `url=${redact(request.url)}`,
    `path=${url.pathname}`,
    `host=${header('host')}`,
    `x-forwarded-host=${header('x-forwarded-host')}`,
    `x-forwarded-proto=${header('x-forwarded-proto')}`,
    `x-vercel-deployment-url=${header('x-vercel-deployment-url')}`,
    `candidates=[${candidates.map(redact).join(', ')}]`,
  ].join(' ');
}

function refuse(status: number, why: string, detail?: string): Response {
  console.warn('[twilio/relay] refused', status, why, ...(detail ? [detail] : []));
  const body = status === 426 ? 'expected a WebSocket upgrade' : status === 410 ? 'gone' : status === 503 ? 'unavailable' : 'forbidden';
  return new Response(body, { status });
}
