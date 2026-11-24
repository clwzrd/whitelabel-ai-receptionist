import { WebSocket } from 'ws';
import type { Admitted } from './admit';
import { RelaySession } from './session';
import type { InMessage, OutMessage } from './types';

/**
 * The one file that knows what a WebSocket is.
 *
 * The engine (`session.ts`) speaks through a `RelaySink` and is fed
 * `InMessage`s; this is the adapter between that and a `ws` socket, used by
 * the Vercel route and by the standalone dev server alike. `WebSocket` is a
 * value import on purpose, not a type import: `@vercel/functions` loads `ws`
 * with a dynamic `import("ws")` inside a try/catch, which the bundler's file
 * tracer cannot follow, so this static import is what guarantees the package
 * ships in the function bundle. `readyState` is compared against the class
 * constant so the import is also genuinely used.
 *
 * The handler resolves when the socket has closed, or two seconds after the
 * session sent its `end` if Twilio has not closed by then — either way the
 * row is flushed afterwards, and only then does the function return.
 */
export async function runRelaySocket(ws: WebSocket, gate: Admitted, deadlineMs: number): Promise<void> {
  const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()));
  const session = new RelaySession({
    ...gate.deps,
    deadlineMs,
    sink: {
      send: (m: OutMessage) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
      },
      close: () => {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(1000);
      },
    },
  });

  ws.on('message', (data) => {
    void session.receive(parseIncoming(data));
  });
  ws.on('error', (error) => session.fail(error));

  await Promise.race([closed, session.finished.then(() => wait(2000))]);
  await session.flush();
}

/**
 * Anything that is not one of Twilio's five messages is reported to the
 * engine as an error rather than dropped, so a malformed frame shows up in
 * the error log instead of vanishing.
 */
export function parseIncoming(data: unknown): InMessage {
  const text =
    typeof data === 'string'
      ? data
      : Buffer.isBuffer(data)
        ? data.toString('utf8')
        : Array.isArray(data)
          ? Buffer.concat(data as Buffer[]).toString('utf8')
          : data instanceof ArrayBuffer
            ? Buffer.from(data).toString('utf8')
            : String(data);
  try {
    const parsed = JSON.parse(text) as { type?: unknown };
    if (parsed && typeof parsed === 'object' && typeof parsed.type === 'string') return parsed as InMessage;
    return { type: 'error', description: `unrecognised message: ${text.slice(0, 200)}` };
  } catch {
    return { type: 'error', description: `unparseable message: ${text.slice(0, 200)}` };
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
