/**
 * O atendente de fora do horário, do "alô" à reunião marcada.
 *
 *     npx --yes tsx scripts/check-reception.ts
 *
 * Chama os próprios manipuladores de webhook da Twilio, com assinatura de
 * verdade, numa workspace descartável — nenhuma ligação é feita, nenhum
 * telefone toca, nenhuma linha real é tocada, e a workspace é apagada no fim.
 *
 * O que ele prova, na ordem em que a pessoa vive:
 *   1. Fora do horário, o CRM oferece o menu em vez da secretária eletrônica.
 *   2. Apertar 1 lê horários que existem de verdade na agenda.
 *   3. Apertar o número de um horário marca a reunião e diz isso em voz alta.
 *   4. Um dígito que ninguém ofereceu não marca nada.
 *   5. Com o atendente desligado, tudo volta a ser a secretária eletrônica.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';

function loadEnv(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]!] = m[2]!.replace(/^"|"$/g, '');
  }
  return out;
}
const here = resolve(import.meta.dirname ?? '.', '..');
for (const [k, v] of Object.entries(loadEnv(resolve(here, '.env')))) if (!process.env[k]) process.env[k] = v;
/* O endereço público que a Twilio teria chamado. A assinatura cobre essa
 * string exata, então o teste e o servidor têm de concordar sobre ela. */
process.env.PUBLIC_CALLBACK_ORIGIN = process.env.PUBLIC_CALLBACK_ORIGIN ?? 'https://crm.example.com';

const { getDb, schema } = await import('../src/db/index.ts');
const { createWorkspace } = await import('../src/lib/core.ts');
const { saveIntegration } = await import('../src/lib/integrations/index.ts');
const { saveVoiceSettings, loadVoiceSettings } = await import('../src/lib/voice/settings.ts');
const { POST } = await import('../src/pages/api/twilio/voice.ts');

const db = getDb();
let failures = 0;
const check = (label: string, ok: boolean, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const AUTH_TOKEN = 'zz-token-de-teste-1234567890';
const ORIGIN = process.env.PUBLIC_CALLBACK_ORIGIN!;
const FROM = '+15551230001';
const TO = '+15551239999';

/** Assina como a Twilio assina: HMAC-SHA1 sobre a URL mais os parâmetros ordenados. */
async function sign(url: string, params: Record<string, string>): Promise<string> {
  let data = url;
  for (const key of Object.keys(params).sort()) data += key + params[key];
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(AUTH_TOKEN), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  let binary = '';
  for (const byte of new Uint8Array(mac)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Um pedido igual ao que a Twilio faria, com a mesma assinatura. */
async function webhook(path: string, params: Record<string, string>): Promise<string> {
  const url = `${ORIGIN}${path}`;
  const body = new URLSearchParams(params);
  const request = new Request(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-twilio-signature': await sign(url, params),
    },
    body,
  });
  const response = await POST({ request, url: new URL(url) } as never);
  return await response.text();
}

const [owner] = await db.select().from(schema.user).limit(1);
if (!owner) throw new Error('sem usuário para ser dono da workspace descartável');
const ws = await createWorkspace(db, { name: 'zz atendente noturno', ownerId: owner.id });
console.log(`workspace ${ws.slug}`);

try {
  /* Fechado sempre: dias vazios é "nunca aberto", então o teste roda a qualquer
   * hora do dia sem depender do relógio de quem o roda. */
  await db.update(schema.workspaces).set({ settings: { ...ws.settings, businessHours: { days: [], start: 9, end: 17 } } }).where(eq(schema.workspaces.id, ws.id));

  const [calendar] = await db
    .insert(schema.calendars)
    .values({
      workspaceId: ws.id,
      name: 'Conversa inicial',
      slug: 'conversa-inicial',
      ownerId: owner.id,
      timezone: 'America/Los_Angeles',
      durationMin: 20,
      minNoticeMin: 60,
      maxDaysAhead: 14,
      slotIntervalMin: 30,
      /* A agenda abre todos os dias, para haver horário livre seja qual for o
       * dia em que este teste rodar. */
      /* Minutos desde a meia-noite, como a agenda guarda: 540 é nove horas.
       * Escrever 9 e 17 aqui dá uma janela de oito minutos e nenhum horário —
       * foi exatamente o que este teste mostrou na primeira vez que rodou. */
      availability: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 9 * 60, end: 17 * 60 })),
    })
    .returning();

  await saveIntegration(db, ws.id, 'twilio', { enabled: true, secrets: { authToken: AUTH_TOKEN, accountSid: 'ACzz' } });
  const base = await loadVoiceSettings(db, ws.id);
  await saveVoiceSettings(db, ws.id, {
    ...base,
    spokenLang: 'en',
    afterHours: 'voicemail',
    reception: { enabled: true, calendarId: calendar!.id, slots: 2, daysAhead: 7, greeting: '' },
  });
  /*
   * Sem número para encaminhar — que é exatamente como a linha da agência
   * está configurada, e o que a primeira versão deste teste escondeu ao
   * preencher um. Uma ligação de verdade caiu na secretária eletrônica por
   * causa dessa diferença.
   */
  await db.insert(schema.phoneNumbers).values({
    workspaceId: ws.id,
    number: TO,
    voice: true,
    sms: false,
    isDefault: true,
    forwardTo: null,
  });

  /* 1. A ligação chega fora do horário. */
  const first = await webhook('/api/twilio/voice', { From: FROM, To: TO, CallSid: 'CAzz0000000000000000000000000001' });
  check('fora do horário, oferece o menu em vez do recado', first.includes('<Gather') && first.includes('press 1'), first.slice(0, 120));
  check('e o recado continua sendo o caminho de quem não aperta nada', first.includes('<Record'));

  const [call] = await db.select().from(schema.calls).where(eq(schema.calls.workspaceId, ws.id));
  check('a ligação virou linha no CRM', Boolean(call), call?.id ?? '(nenhuma)');

  /* 2. Apertou 1: primeiro os DIAS. */
  const menu = await webhook(`/api/twilio/voice?step=menu&call=${call!.id}`, {
    From: FROM,
    To: TO,
    CallSid: call!.providerId ?? '',
    Digits: '1',
  });
  check('apertar 1 pergunta o dia, não o horário', menu.includes('Which day works best?'), menu.slice(0, 200));

  const [withDays] = await db.select().from(schema.calls).where(eq(schema.calls.id, call!.id));
  const days = (withDays!.meta.offeredDays ?? []) as string[];
  check('os dias oferecidos ficaram guardados na ligação', days.length > 0 && days.length <= 4, JSON.stringify(days));
  const horizon = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
  check('nenhum dia oferecido passa de uma semana', days.every((d) => d <= horizon), `${days.at(-1)} vs ${horizon}`);

  /* 3. Escolheu um dia: os horários daquele dia. */
  const times = await webhook(`/api/twilio/voice?step=day&call=${call!.id}&skip=0`, {
    From: FROM,
    To: TO,
    CallSid: call!.providerId ?? '',
    Digits: '1',
  });
  check('escolher o dia lê os horários daquele dia', times.includes('I have') && times.includes('press 1'), times.slice(0, 200));
  check('e oferece voltar para os dias', times.includes('press 8'));

  const [withOffer] = await db.select().from(schema.calls).where(eq(schema.calls.id, call!.id));
  const offered = (withOffer!.meta.offered ?? []) as number[];
  check('os horários oferecidos ficaram guardados na ligação', offered.length === 2, JSON.stringify(offered));
  check('os dois horários são do dia escolhido', new Set(offered.map((ms) => new Date(ms).toISOString().slice(0, 10))).size === 1);
  check('e não são dois horários colados', offered.length < 2 || offered[1]! - offered[0]! > 30 * 60_000, String((offered[1]! - offered[0]!) / 60000) + ' min de distância');

  /* 3b. O 8 volta para a escolha do dia. */
  const back = await webhook(`/api/twilio/voice?step=slot&call=${call!.id}&skip=0`, {
    From: FROM,
    To: TO,
    CallSid: call!.providerId ?? '',
    Digits: '8',
  });
  check('apertar 8 volta para a escolha do dia', back.includes('Which day works best?'));

  /* 4. Um dígito que ninguém ofereceu não marca nada. */
  const bogus = await webhook(`/api/twilio/voice?step=slot&call=${call!.id}`, {
    From: FROM,
    To: TO,
    CallSid: call!.providerId ?? '',
    Digits: '7',
  });
  check('dígito que ninguém ofereceu cai no recado, sem marcar', bogus.includes('<Record') && !bogus.includes('Your meeting is set'));

  /* 4. Apertou o primeiro horário: marca e diz. */
  const booked = await webhook(`/api/twilio/voice?step=slot&call=${call!.id}`, {
    From: FROM,
    To: TO,
    CallSid: call!.providerId ?? '',
    Digits: '1',
  });
  check('apertar o horário marca e a voz confirma', booked.includes('Your meeting is set'), booked.slice(0, 160));

  const appointments = await db.select().from(schema.appointments).where(eq(schema.appointments.workspaceId, ws.id));
  check('a reunião existe na agenda', appointments.length === 1, `${appointments.length} compromisso(s)`);
  check('marcada no horário que foi oferecido', appointments[0]?.startAt.getTime() === offered[0], String(appointments[0]?.startAt));

  const [caller] = await db.select().from(schema.contacts).where(eq(schema.contacts.workspaceId, ws.id));
  check(
    'marcar por telefone não marca a pessoa como quem recusou SMS',
    caller?.consent?.sms !== false,
    JSON.stringify(caller?.consent),
  );

  const tasks = await db.select().from(schema.activities).where(eq(schema.activities.workspaceId, ws.id));
  check(
    'a equipe recebeu a tarefa de confirmar por escrito',
    tasks.some((t) => t.type === 'task' && (t.title ?? '').includes('Confirm')),
    tasks.map((t) => t.title).join(' | '),
  );

  /* 5. Dentro do horário, mas sem ninguém para tocar: também atende. */
  const [wsRow] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, ws.id));
  await db
    .update(schema.workspaces)
    .set({ settings: { ...wsRow!.settings, businessHours: { days: [0, 1, 2, 3, 4, 5, 6], start: 0, end: 24 } } })
    .where(eq(schema.workspaces.id, ws.id));
  const always = await webhook('/api/twilio/voice', { From: FROM, To: TO, CallSid: 'CAzz0000000000000000000000000003' });
  check('linha sem encaminhamento atende mesmo dentro do horário', always.includes('<Gather') && always.includes('press 1'), always.slice(0, 100));
  await db
    .update(schema.workspaces)
    .set({ settings: { ...wsRow!.settings, businessHours: { days: [], start: 9, end: 17 } } })
    .where(eq(schema.workspaces.id, ws.id));

  /* 6. Desligado, tudo volta a ser o que era. */
  const off = await loadVoiceSettings(db, ws.id);
  await saveVoiceSettings(db, ws.id, { ...off, reception: { ...off.reception, enabled: false } });
  const plain = await webhook('/api/twilio/voice', { From: FROM, To: TO, CallSid: 'CAzz0000000000000000000000000002' });
  check('com o atendente desligado, é a secretária eletrônica de sempre', plain.includes('<Record') && !plain.includes('<Gather'));
} finally {
  await db.delete(schema.workspaces).where(eq(schema.workspaces.id, ws.id));
  console.log('workspace descartável apagada');
}

console.log(failures ? `\n${failures} verificação(ões) falharam` : '\ntudo certo');
process.exit(failures ? 1 : 0);
