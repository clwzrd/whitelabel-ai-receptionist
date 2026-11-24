import { and, eq } from 'drizzle-orm';
import type { Db } from '../../../db';
import { schema } from '../../../db';
import { loadAgent } from '../../ai/config';
import { handoffToHuman, type Ctx } from '../../core';
import { scopedTranslator } from '../../i18n/scope';
import { postSlackOrQueue as postSlack } from '../../notify/slack';
import { appOrigin, loadAlertSettings } from '../../twilio/alerts';
import { callerLabel, type Call } from '../store';
import type { SessionRow } from './types';

/**
 * Somebody on the team hears about the call the assistant took.
 *
 * The whole point of an automated receptionist is that a person finds out
 * afterwards — a message nobody reads is a call nobody answered, with extra
 * steps. So once the summary exists (or the model could not write one), the
 * team is told the way the inbox already tells them about a text nobody has
 * answered: the same people, chosen by the same rule (`pickAlertMembers`),
 * on the same channels, with the same trial-account guard on the text. A
 * second rule for "who gets the call notice" would drift from the first
 * within a month.
 *
 * Not every call is worth a buzz. A message taken, a booking made or
 * changed, a transfer nobody picked up, a session that broke: those need a
 * person. A caller who asked the opening hours and hung up (`info`) gets
 * the inbox entry and nothing else — a phone that buzzes for every call is
 * a phone that gets muted. The hand-off person from Settings → AI is always
 * e-mailed when a message was taken, because that is what the field means.
 *
 * Everything here is read by the team, so every sentence goes through `t`
 * in the language the caller put in scope. The transcript itself is in the
 * caller's English, quoted as it was said.
 */

export interface CallNotice {
  call: Call;
  session: SessionRow;
  /** The model's summary, or null when it could not be written (the transcript stands in). */
  summary: string | null;
}

export interface NotifyOutcome {
  /** The task opened for the person when the caller asked for one and the transfer rang out. */
  handoffTaskId?: string | null;
  /** Every address, number and channel that took the notice. */
  sent: string[];
  /** Members who wanted a text and got an e-mail instead, with the reason. */
  fellBack?: string[];
  skipped?: string;
}

const t = scopedTranslator();

/** What the notice is about, or null when the call needs nobody's attention. */
export function noticeReason(call: Call, session: SessionRow): 'booked' | 'rescheduled' | 'canceled' | 'message' | 'transfer-unanswered' | 'failed' | null {
  if (session.endReason === 'failed' || session.handoff?.reason === 'failed') return 'failed';
  switch (session.outcome) {
    case 'booked':
    case 'rescheduled':
    case 'canceled':
    case 'message':
      return session.outcome;
    case 'transferred':
      // An answered transfer is `afterTransfer`'s `leg: 'forward'`; the person who picked up already knows.
      return call.meta.leg === 'forward' ? null : 'transfer-unanswered';
    default:
      return null;
  }
}

export async function notifyTeamAboutCall(db: Db, workspaceId: string, notice: CallNotice): Promise<NotifyOutcome> {
  const { call, session } = notice;
  if (call.workspaceId !== workspaceId) return { sent: [], skipped: 'call is not in this workspace' };
  const reason = noticeReason(call, session);
  if (!reason) return { sent: [], skipped: `inbox only (${session.outcome ?? 'no outcome'})` };

  /*
   * A caller who asked for a person and got no answer on the transfer has
   * been promised a person. The notice below tells the team it happened; this
   * makes it somebody's job: the same hand-off the text agent does — a "Talk
   * to" task due in 4 h, the deal on the Sales-ready column, an owner.
   * Idempotent per contact per day inside handoffToHuman, so a caller who
   * tries twice is one task. Never lets a failure stop the notice.
   */
  let handoffTaskId: string | null = null;
  if (reason === 'transfer-unanswered' && call.contactId) {
    try {
      const agent = await loadAgent(db, workspaceId);
      const ctx: Ctx = { db, workspaceId, actorId: null };
      const result = await handoffToHuman(ctx, {
        contactId: call.contactId,
        reason: t('Asked for a person on the phone; nobody picked up the transfer'),
        source: 'ai',
        assigneeId: agent?.handoffUserId ?? null,
      });
      handoffTaskId = result.taskId ?? null;
    } catch (error) {
      console.error('[voice/notify] hand-off after unanswered transfer failed', call.id, error);
    }
  }

  const who = callerLabel(call);
  const link = call.conversationId ? `${appOrigin()}/app/inbox?c=${call.conversationId}` : `${appOrigin()}/app/calls?call=${call.id}`;
  const headline = headlineFor(reason, who, session.handoff?.why ?? session.endReason ?? '');
  const gist = (notice.summary ?? firstLines(session)).trim();
  const [workspace] = await db.select({ name: schema.workspaces.name, brand: schema.workspaces.brand }).from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)).limit(1);
  const signature = workspace?.brand?.name ?? workspace?.name ?? 'CRM';

  const sent: string[] = [];
  const alerts = await loadAlertSettings(db, workspaceId);
  if (alerts.enabled || reason === 'message' || handoffTaskId) {
    const posted = await postSlack(db, workspaceId, {
      text: `${headline}\n${gist}`,
      link: { url: link, label: t('Open in the inbox') },
    }, 'calls');
    if (posted) sent.push('slack');
    else return { handoffTaskId, sent, fellBack: ['Slack notification failed; no email or SMS fallback.'] };
  }
  return { handoffTaskId, sent };
}

function headlineFor(reason: NonNullable<ReturnType<typeof noticeReason>>, who: string, why: string): string {
  switch (reason) {
    case 'booked':
      return t('The assistant booked an appointment for {who}', { who });
    case 'rescheduled':
      return t('The assistant rescheduled an appointment for {who}', { who });
    case 'canceled':
      return t('The assistant canceled an appointment for {who}', { who });
    case 'message':
      return t('Message taken by the assistant') + ` · ${who}`;
    case 'transfer-unanswered':
      return t('The assistant tried to transfer {who} and nobody picked up', { who });
    case 'failed':
      return t('The assistant could not answer: {why}', { why: why || t('the call dropped') }) + ` · ${who}`;
  }
}

/** When there is no summary, the caller's own first words stand in for it. */
function firstLines(session: SessionRow): string {
  const said = session.turns.filter((turn) => turn.role === 'user' && turn.text.trim()).map((turn) => `"${turn.text.trim()}"`);
  if (!said.length) return t('The assistant answered; nothing was said.');
  return said.slice(0, 3).join(' ').slice(0, 400);
}

/** The one-line version, for a screen the size of a hand. */
function smsBody(headline: string, gist: string, link: string): string {
  const head = `${headline}: `;
  const room = Math.max(20, 300 - head.length - link.length - 2);
  const quoted = gist.length > room ? `${gist.slice(0, room - 1)}…` : gist;
  return `${head}${quoted} ${link}`;
}
