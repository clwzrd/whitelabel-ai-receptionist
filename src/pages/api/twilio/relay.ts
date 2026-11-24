import type { APIRoute } from 'astro';
import { experimental_upgradeWebSocket, getDeadline } from '@vercel/functions';
import type { WebSocket } from 'ws';
import { admit } from '../../../lib/voice/relay/admit';
import { deadlineMs, vercelContext } from '../../../lib/voice/relay/runtime';
import { runRelaySocket } from '../../../lib/voice/relay/socket';

export const prerender = false;

/**
 * The AI receptionist's WebSocket, inside the app's own Vercel function.
 *
 * Twilio's ConversationRelay opens a socket to this URL for every call the
 * inbound route handed over (`<Connect><ConversationRelay url=…>`), streams
 * the caller's words as text and plays back what we send. Proven on
 * 2026-09-13 on a preview deployment: `experimental_upgradeWebSocket` from
 * `@vercel/functions` upgrades inside the Astro function, the handshake takes
 * under two seconds, and `getDeadline()` reports the 300 s limit the session
 * rotates against.
 *
 * Three answers, in order. A plain GET (no `Upgrade` header) is the probe:
 * one line of text that says whether this runtime can upgrade at all, which
 * is the go/no-go for the whole feature — with the caveat that Vercel attaches
 * `upgradeWebSocket` to the request context only on Upgrade requests, so
 * "unavailable" on a plain GET is expected and proves nothing. An Upgrade
 * request on a runtime that cannot upgrade (`astro dev`) gets a 501 naming the
 * dev server to run instead. Anything else is admitted or refused before the
 * upgrade — the 101 cannot be taken back once written — and then handed to
 * the socket runner, which resolves only when the socket has closed.
 *
 * The deadline is read here, in the handler, and never in a listener: the
 * request context is bound to this async path and a `message` listener fired
 * later is not guaranteed to see it.
 */
export const GET: APIRoute = async ({ request, url }) => {
  const upgrade = (request.headers.get('upgrade') ?? '').toLowerCase();
  if (upgrade !== 'websocket') return probe();

  if (typeof vercelContext().upgradeWebSocket !== 'function') {
    return new Response(
      'This runtime cannot upgrade a WebSocket. Under astro dev, run `npm run relay:dev` and point VOICE_RELAY_URL at its tunnel.',
      { status: 501, headers: { 'content-type': 'text/plain; charset=utf-8' } },
    );
  }

  const gate = await admit(request, url);
  if (gate instanceof Response) return gate;

  const deadline = deadlineMs();
  return experimental_upgradeWebSocket(
    async (ws: WebSocket) => {
      await runRelaySocket(ws, gate, deadline);
    },
    { maxPayload: 64 * 1024 },
  );
};

/** The production canary's first step (plan §8.4.1). Text, not JSON, so a browser tab reads it. */
function probe(): Response {
  const available = typeof vercelContext().upgradeWebSocket === 'function';
  const deadline = getDeadline();
  const body = [
    'relay probe',
    `upgradeWebSocket: ${available ? 'available' : 'unavailable (only attached to Upgrade requests; a plain GET never shows it)'}`,
    'ws: installed',
    `deadline: ${deadline ? deadline.toISOString() : 'none'}`,
    `vercel: ${process.env.VERCEL ? 'yes' : 'no'}`,
    `region: ${process.env.VERCEL_REGION ?? '-'}`,
  ].join(' · ');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}
