import { and, asc, desc, eq } from 'drizzle-orm';
import type { Db } from '../../../db';
import { schema } from '../../../db';
import { cleanPhone } from '../../core';
import { isUsPhone } from '../../twilio/alerts';
import { callMembers, verifiedNumbers, type VoiceSettings } from '../settings';

/**
 * The one phone the assistant may hand a caller to.
 *
 * Decided before the socket opens and handed to the session as a fact, so
 * the model's `transfer_to_human` never dials a number the CRM did not choose.
 * The chain is the one a person would follow: the number the workspace typed
 * for exactly this purpose; failing that, wherever the dialled line already
 * forwards to; failing that, the first colleague who takes calls and has a
 * mobile on file. `callMembers()` lists the disabled and the phoneless too —
 * the Call button greys them out rather than hiding them — so both are
 * filtered here.
 *
 * Two rules the alerts and click-to-call already live by apply unchanged: a
 * number outside the United States is never rung (international rates, and a
 * voice leg abroad is exactly the surprise on the bill the owner ruled out on
 * 2026-09-09), and a trial account can only reach numbers proved in the Twilio
 * console. Null means "nobody", which readiness turns into a hard problem when
 * no other person is reachable either.
 */
export async function transferTarget(
  db: Db,
  workspaceId: string,
  settings: VoiceSettings,
  dialedNumber: string | null,
): Promise<string | null> {
  const line = await lineFor(db, workspaceId, dialedNumber);
  const trialOnly = line?.trial ? await verifiedNumbers(db, workspaceId) : null;
  const usable = (phone: string | null | undefined): string | null => {
    const e164 = cleanPhone(phone);
    if (!e164 || !isUsPhone(e164)) return null;
    if (trialOnly && !trialOnly.has(e164)) return null;
    return e164;
  };

  const chosen = usable(settings.ai.transferTo);
  if (chosen) return chosen;

  const forwarded = usable(line?.forwardTo);
  if (forwarded) return forwarded;

  for (const member of await callMembers(db, workspaceId)) {
    if (!member.calls || !member.phone) continue;
    const phone = usable(member.phone);
    if (phone) return phone;
  }
  return null;
}

/**
 * The dialled line's row, for its forwarding number and its trial flag. With
 * no number in hand — the settings page asks about the workspace, not about a
 * call — the default voice line stands in, which is the one a caller reaches
 * when they dial "the business".
 */
async function lineFor(db: Db, workspaceId: string, dialedNumber: string | null) {
  const scope = eq(schema.phoneNumbers.workspaceId, workspaceId);
  const rows = await db
    .select({ forwardTo: schema.phoneNumbers.forwardTo, trial: schema.phoneNumbers.trial })
    .from(schema.phoneNumbers)
    .where(dialedNumber ? and(scope, eq(schema.phoneNumbers.number, dialedNumber)) : and(scope, eq(schema.phoneNumbers.voice, true)))
    .orderBy(desc(schema.phoneNumbers.isDefault), asc(schema.phoneNumbers.createdAt))
    .limit(1);
  return rows[0] ?? null;
}
