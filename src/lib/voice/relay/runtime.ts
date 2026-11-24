import { getDeadline } from '@vercel/functions';
import { FUNCTION_MAX_DURATION_S } from '../../../../function-limits.mjs';

/**
 * The two facts about the Vercel runtime the relay route needs and
 * `@vercel/functions` does not hand out in a usable form.
 *
 * The request context — where `upgradeWebSocket` and the deadline live — is
 * one symbol on `globalThis`, read by `@vercel/functions` through a
 * `getContext()` it does not export (`get-context.js`, four lines; verified
 * against the package's `exports` map, which has no path for it). The
 * one-liner is copied here rather than reached into `node_modules` by path,
 * which the bundler would not follow. Proven on 2026-09-13 on a preview
 * deployment: on an `Upgrade: websocket` request the context carries
 * `upgradeWebSocket`; on a plain GET it does not, so "unavailable" on a
 * plain GET says nothing about whether sockets work.
 */
export { FUNCTION_MAX_DURATION_S };

export interface VercelContext {
  /** Present only on a request that arrived with `Upgrade: websocket`. */
  upgradeWebSocket?: (...args: unknown[]) => unknown;
  deadline?: Date;
}

export function vercelContext(): VercelContext {
  const holder = (globalThis as Record<symbol, unknown>)[Symbol.for('@vercel/request-context')] as
    | { get?: () => VercelContext | undefined }
    | undefined;
  return holder?.get?.() ?? {};
}

/**
 * When this invocation dies, as an absolute time in milliseconds.
 *
 * Vercel reports it on Fluid compute (`getDeadline()`, proven to return a
 * 300 s deadline on the same preview). Anywhere it does not — `astro dev`,
 * a plain `tsx` script, an older runtime — the configured limit counted from
 * `fallbackFrom` stands in, so the session always has a number to rotate
 * against and never learns about the limit by being killed. Read it inside
 * the request handler, not in a socket listener: the request context is
 * bound to the handler's async path and a listener fired later may not see it.
 */
export function deadlineMs(fallbackFrom = Date.now()): number {
  return getDeadline()?.getTime() ?? fallbackFrom + FUNCTION_MAX_DURATION_S * 1000;
}
