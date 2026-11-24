import { and, eq } from 'drizzle-orm';
import type { Db } from '../../db';
import { schema } from '../../db';
import { book, BookingRefused, SlotTaken } from '../calendar/booking';
import { calendarById, openSlots, type Calendar } from '../calendar/store';
import { dayAt } from '../calendar/tz';
import { createSystemTask, type Ctx } from '../core';
import type { Lang } from '../i18n';
import type { VoiceSettings } from './settings';

/**
 * O atendente de fora do horário, versão teclado.
 *
 * Duas escolhas, nesta ordem: **o dia**, e então **o horário naquele dia**.
 * Foi assim que virou depois da primeira ligação de verdade: ler horários
 * seguidos ("segunda 9:00, segunda 9:30, aperte 9 para os próximos") obriga
 * quem quer quinta à tarde a apertar 9 uma dúzia de vezes. Perguntar o dia
 * primeiro corta a agenda inteira em uma escolha, e os horários oferecidos
 * depois são espalhados pelo dia — manhã, meio, fim — em vez de três seguidos
 * da primeira hora.
 *
 * A janela é de uma semana, no máximo: uma pessoa que liga hoje à noite não
 * quer ouvir uma vaga de daqui a três semanas, e uma agenda que enxerga longe
 * demais lê horários que a vida vai mudar antes de chegar.
 *
 * Nada do que a pessoa aperta carrega significado: o dígito diz "o primeiro"
 * ou "o segundo", e qual era o primeiro é coisa que o CRM guardou na própria
 * ligação. Um dígito não pode carregar um instante, e confiar nele seria
 * deixar marcar um horário que ninguém ofereceu.
 */

/** Uma semana. O teto existe no código, não só na tela de configuração. */
export const MAX_DAYS_AHEAD = 7;

export interface OfferedSlot {
  startMs: number;
  /** Como o horário é lido em voz alta: "9:30 AM". */
  spoken: string;
}

export interface OfferedDay {
  /** AAAA-MM-DD no fuso da agenda. */
  day: string;
  /** Como o dia é lido: "Monday", "segunda-feira". */
  spoken: string;
  /** Quantos horários livres ele tem, para não oferecer um dia vazio. */
  free: number;
}

function horizonMs(settings: VoiceSettings): number {
  return Math.min(settings.reception.daysAhead, MAX_DAYS_AHEAD) * 86_400_000;
}

/** Todos os horários livres dentro da janela de uma semana. */
async function slotsWithin(db: Db, calendar: Calendar, settings: VoiceSettings) {
  const nowMs = Date.now();
  const limit = nowMs + horizonMs(settings);
  return (await openSlots(db, calendar)).filter((slot) => slot.startMs <= limit);
}

/**
 * Os dias que têm vaga, na ordem em que chegam.
 *
 * `skip` avança a lista quando a pessoa aperta "outros dias", porque quatro
 * opções é o que alguém guarda de cabeça ouvindo — a quinta já é anotar num
 * papel que ninguém tem por perto.
 */
export async function offerDays(
  db: Db,
  calendar: Calendar,
  settings: VoiceSettings,
  opts: { skip?: number; lang: Lang; max?: number },
): Promise<OfferedDay[]> {
  const slots = await slotsWithin(db, calendar, settings);
  const counts = new Map<string, number>();
  for (const slot of slots) {
    const day = dayAt(calendar.timezone, slot.startMs);
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  const locale = opts.lang === 'pt' ? 'pt-BR' : 'en-US';
  const weekday = new Intl.DateTimeFormat(locale, { timeZone: calendar.timezone, weekday: 'long' });
  const dayAndMonth = new Intl.DateTimeFormat(locale, { timeZone: calendar.timezone, day: 'numeric', month: 'long' });
  const today = dayAt(calendar.timezone, Date.now());
  const tomorrow = dayAt(calendar.timezone, Date.now() + 86_400_000);

  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(opts.skip ?? 0, (opts.skip ?? 0) + (opts.max ?? 4))
    .map(([day, free]) => {
      /* Meio-dia local para nomear o dia: qualquer hora serve para descobrir o
       * nome do dia, e o meio-dia não muda de dia em fuso nenhum. */
      const at = new Date(day + 'T12:00:00Z').getTime();
      const name =
        day === today
          ? opts.lang === 'pt'
            ? 'hoje'
            : 'today'
          : day === tomorrow
            ? opts.lang === 'pt'
              ? 'amanhã'
              : 'tomorrow'
            : `${weekday.format(at)}, ${dayAndMonth.format(at)}`;
      return { day, spoken: name, free };
    });
}

/**
 * Os horários de um dia, espalhados.
 *
 * Três horários seguidos da primeira hora não são uma escolha — são a primeira
 * hora. Espalhar pega o começo, o meio e o fim do que está livre, que é como
 * uma pessoa pensa o próprio dia: cedo, depois do almoço, fim da tarde.
 */
export async function offerTimes(
  db: Db,
  calendar: Calendar,
  settings: VoiceSettings,
  opts: { day: string; skip?: number; lang: Lang },
): Promise<OfferedSlot[]> {
  const all = (await slotsWithin(db, calendar, settings)).filter(
    (slot) => dayAt(calendar.timezone, slot.startMs) === opts.day,
  );
  const wanted = Math.max(1, settings.reception.slots);
  const skip = opts.skip ?? 0;
  const rest = all.slice(skip);
  const chosen =
    rest.length <= wanted
      ? rest
      : Array.from({ length: wanted }, (_, i) => rest[Math.round((i * (rest.length - 1)) / (wanted - 1 || 1))]!);

  const format = new Intl.DateTimeFormat(opts.lang === 'pt' ? 'pt-BR' : 'en-US', {
    timeZone: calendar.timezone,
    hour: 'numeric',
    minute: '2-digit',
  });
  const seen = new Set<number>();
  return chosen
    .filter((slot) => slot && !seen.has(slot.startMs) && seen.add(slot.startMs))
    .map((slot) => ({ startMs: slot.startMs, spoken: format.format(new Date(slot.startMs)) }));
}

/** A agenda que este atendente usa, quando ela existe e está aberta. */
export async function receptionCalendar(db: Db, workspaceId: string, settings: VoiceSettings): Promise<Calendar | null> {
  if (!settings.reception.enabled || !settings.reception.calendarId) return null;
  const calendar = await calendarById(db, workspaceId, settings.reception.calendarId);
  return calendar && calendar.active ? calendar : null;
}

/** Guarda na ligação os dias que foram lidos, para o próximo passo conferir. */
export async function rememberDays(db: Db, callId: string, days: OfferedDay[], skip: number): Promise<void> {
  await patchCall(db, callId, { offeredDays: days.map((d) => d.day), daySkip: skip });
}

/** E os horários, junto com o dia a que pertencem. */
export async function rememberTimes(db: Db, callId: string, day: string, times: OfferedSlot[], skip: number): Promise<void> {
  await patchCall(db, callId, { offered: times.map((t) => t.startMs), offerDay: day, offerSkip: skip });
}

async function patchCall(db: Db, callId: string, patch: Record<string, unknown>): Promise<void> {
  const [call] = await db.select().from(schema.calls).where(eq(schema.calls.id, callId));
  if (!call) return;
  await db
    .update(schema.calls)
    .set({ meta: { ...call.meta, ...patch } })
    .where(eq(schema.calls.id, callId));
}

export interface BookOutcome {
  ok: boolean;
  /** Frase pronta para ser lida ao telefone. */
  spoken?: string;
  reason?: 'taken' | 'refused' | 'gone';
}

/**
 * Marca o horário que a pessoa escolheu, no nome do contato que ligou.
 *
 * Sem e-mail: quem ligou deu um telefone e nada mais. `book()` aceita isso — o
 * contato já existe, criado pela própria ligação — e a confirmação por escrito
 * fica devendo até a campanha A2P liberar SMS. Enquanto isso, quem confirma é a
 * voz, e a equipe recebe a tarefa: é meia entrega, e é melhor dizer isso do que
 * fingir que um e-mail saiu.
 */
export async function bookFromCall(args: {
  db: Db;
  workspaceId: string;
  calendar: Calendar;
  call: typeof schema.calls.$inferSelect;
  startMs: number;
  lang: Lang;
}): Promise<BookOutcome> {
  const { db, workspaceId, calendar, call, startMs, lang } = args;
  const offered = Array.isArray(call.meta.offered) ? (call.meta.offered as number[]) : [];
  if (!offered.includes(startMs)) return { ok: false, reason: 'gone' };

  const [workspace] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
  if (!workspace) return { ok: false, reason: 'gone' };
  const [contact] = call.contactId
    ? await db
        .select()
        .from(schema.contacts)
        .where(and(eq(schema.contacts.id, call.contactId), eq(schema.contacts.workspaceId, workspaceId)))
    : [];

  try {
    const result = await book({
      db,
      workspaceId,
      actorId: null,
      calendar,
      workspace,
      startMs,
      timezone: calendar.timezone,
      name: [contact?.firstName, contact?.lastName].filter(Boolean).join(' ') || 'Quem ligou',
      email: contact?.email ?? null,
      phone: call.fromNumber,
      contactId: contact?.id ?? null,
      /*
       * Silêncio, não um "não".
       *
       * Marcar uma reunião pelo telefone não é concordar em receber marketing
       * por SMS — nos Estados Unidos essa distinção é o processo. Mas gravar
       * `sms: false` diria que a pessoa **recusou**, e quem recusou não recebe
       * nem a confirmação da própria reunião: o `sendSms` recusa o envio antes
       * de qualquer outra coisa. Então não se afirma nada: o campo fica como
       * estava, a confirmação (que é transacional) sai, e o marketing continua
       * dependendo de um sim explícito em outro lugar.
       */
      notes: 'Marcado pelo atendimento automático fora do horário.',
      source: 'phone',
      lang,
      /*
       * A confirmação sai por onde der.
       *
       * Quem marcou pelo telefone deu um número, e a agenda está em "e-mail e
       * SMS": o próprio `notifyGuest` resolve o que é possível agora e registra
       * o que não foi. Enquanto a campanha A2P estiver em análise o SMS falha
       * com 30034 e isso **fica escrito** — que é melhor do que o silêncio que
       * havia aqui, e faz a confirmação passar a sair sozinha no dia em que a
       * A2P for aprovada, sem ninguém precisar lembrar deste arquivo.
       */
      silent: false,
    });

    const ctx: Ctx = { db, workspaceId, actorId: null };
    await createSystemTask(ctx, {
      contactId: result.contact.id,
      title: lang === 'pt' ? 'Confirmar reunião marcada por telefone' : 'Confirm the meeting booked by phone',
      reason:
        lang === 'pt'
          ? 'Marcada pelo atendimento automático fora do horário. Quem ligou deixou só o telefone; confirme por escrito antes do horário.'
          : 'Booked by the after-hours attendant. The caller left only a phone number; confirm in writing before the time.',
      nextAction: lang === 'pt' ? 'Confirmar por escrito' : 'Confirm in writing',
      dueAt: new Date(Math.max(Date.now() + 3_600_000, startMs - 24 * 3_600_000)),
      assigneeId: calendar.ownerId,
      via: 'reception',
      purpose: 'confirm_meeting',
      notify: true,
      meta: { callId: call.id, appointmentId: result.appointment.id },
    });

    const spoken = new Intl.DateTimeFormat(lang === 'pt' ? 'pt-BR' : 'en-US', {
      timeZone: calendar.timezone,
      weekday: 'long',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(startMs));
    return { ok: true, spoken };
  } catch (error) {
    if (error instanceof SlotTaken) return { ok: false, reason: 'taken' };
    if (error instanceof BookingRefused) return { ok: false, reason: 'refused' };
    console.error('[voice/reception] booking failed', error);
    return { ok: false, reason: 'refused' };
  }
}
