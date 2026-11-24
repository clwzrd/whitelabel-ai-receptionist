/**
 * A recepcionista de IA, do "alô" ao resumo na caixa de entrada.
 *
 *     npx --yes tsx scripts/check-relay.ts
 *
 * Chama os próprios manipuladores do CRM — o webhook de voz assinado como a
 * Twilio assina, o portão do WebSocket (`admit`), o motor da sessão com a
 * volta de modelo de verdade (`runVoiceTurn`) e o passo `relay-done` — numa
 * workspace descartável, apagada no fim. O modelo é um roteiro: o `fetch` que
 * responde na linha é trocado por um que devolve o que o roteiro manda, no
 * JSON do próprio provedor, então o prompt, as ferramentas, a gravação em
 * `ai_runs` e as escritas no banco são todas as de produção. Nenhum telefone
 * toca, nenhum SMS sai, nenhum e-mail sai (o `replay.ts` responde por eles).
 *
 * O que ele prova, na ordem em que a ligação vive:
 *   1. Com a recepcionista ligada, a ligação recebe <Connect><ConversationRelay>
 *      e a linha fica marcada como roteada para a IA.
 *   2. O portão do socket aceita a assinatura da Twilio sobre a URL wss e
 *      recusa assinatura errada (403), token vencido (410) e sid trocado (403).
 *   3. A conversa: a regra do consentimento está no prompt; "manda o link" antes
 *      do sim é recusado; o sim é gravado sem apagar o consentimento de e-mail
 *      que já existia; a marcação atualiza o e-mail antes de marcar e cria o
 *      compromisso; o filler é falado enquanto o modelo pensa; cancelar com nome
 *      errado é recusado; quem fala espanhol recebe a nota "[caller spoke in
 *      Spanish]", o modelo chama `switch_language`, a sessão manda uma só
 *      mensagem `language` e carimba `lang` em cada fala seguinte; "não me
 *      mande mais nada" marca não-contatar e encerra.
 *   4. `relay-done`: a ligação fica completa, uma só entrada na linha do tempo
 *      (mesmo com o status callback chegando antes), a transcrição na caixa de
 *      entrada com `meta.ai`, o resumo agendado — e depois escrito, em inglês,
 *      com a linha "Language: Spanish" no fim.
 *   5. Reconexão: `rotate` devolve um <Connect> com resume="1" e o idioma que
 *      a pessoa estava falando; um 64105 com a sessão viva também; um segundo
 *      tombo cai no recado e fica no error_log.
 *   6. Transferência: <Dial> com o passo after-transfer; ninguém atende → volta
 *      para a assistente com a nota; segunda vez → recado; `missed` nunca vira
 *      verdadeiro.
 *   7. Recado depois da assistente: `leave_voicemail` grava o recado sem marcar
 *      a ligação como perdida nem agendar o texto de perdida; o status callback
 *      fecha a sessão sem arquivar duas vezes; uma sessão que caiu antes de a
 *      pessoa falar é perdida como qualquer outra; número oculto vira um
 *      contato por ligação.
 *
 * Roda contra o banco do `.env` (produção), como os outros `check-*.ts`; para
 * o branch dev: `DATABASE_URL="<url do .env.development>" npx --yes tsx …`.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { and, eq, gte } from 'drizzle-orm';

function loadEnv(path: string): Record<string, string> {
  try {
    const out: Record<string, string> = {};
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) out[m[1]!] = m[2]!.replace(/^"|"$/g, '');
    }
    return out;
  } catch {
    return {};
  }
}
const here = resolve(import.meta.dirname ?? '.', '..');
for (const [k, v] of Object.entries(loadEnv(resolve(here, '.env')))) if (!process.env[k]) process.env[k] = v;
/* O endereço público que a Twilio teria chamado. A assinatura cobre essa
 * string exata, então o teste e o servidor têm de concordar sobre ela. O
 * socket é o mesmo endereço com o esquema trocado, como em produção. */
process.env.PUBLIC_CALLBACK_ORIGIN = process.env.PUBLIC_CALLBACK_ORIGIN ?? 'https://crm.example.com';
delete process.env.VOICE_RELAY_URL;
delete process.env.VOICE_RELAY_ALLOW_UNSIGNED;

const { getDb, schema } = await import('../src/db/index.ts');
const { createWorkspace } = await import('../src/lib/core.ts');
const { saveIntegration } = await import('../src/lib/integrations/index.ts');
const { saveVoiceSettings, loadVoiceSettings } = await import('../src/lib/voice/settings.ts');
const { POST } = await import('../src/pages/api/twilio/voice.ts');
const { POST: STATUS } = await import('../src/pages/api/twilio/voice-status.ts');
const { admit } = await import('../src/lib/voice/relay/admit.ts');
const { mintRelayToken } = await import('../src/lib/voice/relay/token.ts');
const { RelaySession, SENTENCES } = await import('../src/lib/voice/relay/session.ts');
const { dbSessionStore } = await import('../src/lib/voice/relay/store.ts');
const { summarizeAiCall } = await import('../src/lib/voice/relay/summary.ts');
const { installReplayFetch } = await import('../src/lib/ai/replay.ts');
type ScriptedTurn = import('../src/lib/ai/replay.ts').ScriptedTurn;
type OutMessage = import('../src/lib/voice/relay/types.ts').OutMessage;
type Admitted = import('../src/lib/voice/relay/admit.ts').Admitted;

const db = getDb();
let failures = 0;
const check = (label: string, ok: boolean, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const AUTH_TOKEN = 'zz-token-de-teste-1234567890';
const ACCOUNT_SID = 'ACzz00000000000000000000000000000';
const ORIGIN = process.env.PUBLIC_CALLBACK_ORIGIN!;
/* Números que passam em `fictitiousReason`: um 555 é recusado pelo envio de
 * SMS antes do consentimento, e a recusa que este teste quer ver é a do
 * consentimento. */
const FROM = '+13102000001';
const TO = '+13102009999';
const TRANSFER_TO = '+13102001234';
const MODEL = 'deepseek-flash';

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

/** Um pedido igual ao que a Twilio faria ao webhook de voz, com a mesma assinatura. */
async function webhook(path: string, params: Record<string, string>, handler: typeof POST = POST): Promise<string> {
  const url = `${ORIGIN}${path}`;
  const request = new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': await sign(url, params) },
    body: new URLSearchParams(params),
  });
  const response = await handler({ request, url: new URL(url) } as never);
  return await response.text();
}

/** O handshake do socket, como a Twilio o faz: `Upgrade: websocket` e a assinatura sobre a URL wss que ela discou. */
async function handshake(wssUrl: string, opts: { signature?: string | null; nowMs?: number } = {}): Promise<Admitted | Response> {
  const https = wssUrl.replace(/^wss:/, 'https:');
  const headers: Record<string, string> = { upgrade: 'websocket', connection: 'Upgrade' };
  const signature = opts.signature === undefined ? await sign(wssUrl, {}) : opts.signature;
  if (signature) headers['x-twilio-signature'] = signature;
  const request = new Request(https, { headers });
  return admit(request, new URL(https), { db, nowMs: opts.nowMs });
}

/** A URL wss do <ConversationRelay> no TwiML, com o &amp; desfeito. */
function relayUrlOf(twiml: string): string | null {
  const m = /<ConversationRelay[^>]*\surl="([^"]+)"/.exec(twiml);
  return m ? m[1]!.replace(/&amp;/g, '&') : null;
}

/** Um socket de mentira: guarda tudo que a sessão mandaria à Twilio e avisa quando chega uma fala ou um `end`. */
function fakeSink() {
  const sent: OutMessage[] = [];
  let waiters: ((m: OutMessage) => void)[] = [];
  const sink = {
    send: (m: OutMessage) => {
      sent.push(m);
      const current = waiters;
      waiters = [];
      for (const w of current) w(m);
    },
    close: () => undefined,
  };
  /** A próxima fala que não é o filler (o filler é `preemptible`, em qualquer idioma), ou o `end`. */
  const nextReply = () =>
    new Promise<OutMessage>((resolveReply) => {
      const listen = (m: OutMessage) => {
        if (m.type === 'end' || (m.type === 'text' && !m.preemptible && m.token !== SENTENCES.filler)) resolveReply(m);
        else waiters.push(listen);
      };
      waiters.push(listen);
    });
  return { sink, sent, nextReply };
}

const [owner] = await db.select().from(schema.user).limit(1);
if (!owner) throw new Error('sem usuário para ser dono da workspace descartável');
const ws = await createWorkspace(db, { name: `zz recepcionista ia ${Math.random().toString(36).slice(2, 6)}`, ownerId: owner.id, timezone: 'America/Los_Angeles' });
console.log(`workspace ${ws.slug}`);

/* O modelo de mentira fica instalado o teste inteiro: a lista `pending` é
 * viva, então cada volta empurra o que o "modelo" vai dizer logo antes de
 * falar com ele, e as chamadas à Twilio e ao Resend são respondidas sem sair
 * de casa. O `fetch` de verdade continua servindo o banco. */
const replay = installReplayFetch('openai', MODEL, []);
const say = (...turns: ScriptedTurn[]) => replay.pending.push(...turns);

let callSeq = 0;
const nextCallSid = () => `CAzz${String(++callSeq).padStart(28, '0')}`;

try {
  /* Aberto sempre, para o modo `always` não depender do relógio de quem roda. */
  await db.update(schema.workspaces).set({ settings: { ...ws.settings, businessHours: { days: [0, 1, 2, 3, 4, 5, 6], start: 0, end: 24 } } }).where(eq(schema.workspaces.id, ws.id));

  const [calendar] = await db
    .insert(schema.calendars)
    .values({
      workspaceId: ws.id,
      name: 'Discovery call',
      slug: 'discovery-call',
      ownerId: owner.id,
      timezone: 'America/Los_Angeles',
      durationMin: 20,
      minNoticeMin: 60,
      maxDaysAhead: 14,
      slotIntervalMin: 30,
      /* Minutos desde a meia-noite, todos os dias: sempre há horário livre. */
      availability: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 9 * 60, end: 17 * 60 })),
    })
    .returning();

  await saveIntegration(db, ws.id, 'twilio', { enabled: true, secrets: { authToken: AUTH_TOKEN, accountSid: ACCOUNT_SID } });
  await saveIntegration(db, ws.id, 'anthropic', {
    secrets: { apiKey: 'zz-key' },
    enabled: true,
    config: {
      provider: 'openai_compatible',
      baseUrl: 'https://api.deepseek.com',
      model: MODEL,
      priceIn: 0.3,
      priceOut: 1.2,
      priceCacheRead: 0.006,
      dailyCostCapCents: 500,
      check: { at: new Date().toISOString(), ok: true, model: MODEL, answered: true, toolCallOk: true, toolCallDetail: 'ok', latencyMs: 900 },
    },
  });
  await db.insert(schema.aiAgents).values({
    workspaceId: ws.id,
    name: 'Ana',
    enabled: true,
    channels: ['sms'],
    persona: 'Brief and warm.',
    goal: 'Book a discovery call.',
    knowledge: 'The discovery call takes 20 minutes and is free.',
    whenever: 'always',
    delaySeconds: 0,
    maxTurns: 10,
    handoffKeywords: [],
    canBook: true,
    bookingCalendarId: calendar!.id,
    handoffUserId: owner.id,
    dailyMessageCap: 200,
  });
  await db.insert(schema.phoneNumbers).values({ workspaceId: ws.id, number: TO, voice: true, sms: true, isDefault: true, forwardTo: null, trial: false });
  const base = await loadVoiceSettings(db, ws.id);
  await saveVoiceSettings(db, ws.id, {
    ...base,
    spokenLang: 'en',
    afterHours: 'voicemail',
    ai: { ...base.ai, enabled: true, mode: 'always', transferTo: TRANSFER_TO, maxMinutes: 10, maxTurns: 30, dailyMinutesCap: 120 },
    // Ligado para provar, no passo 7, que uma ligação atendida pela assistente nunca agenda o texto de "perdemos sua ligação".
    missedCallText: { ...base.missedCallText, enabled: true },
  });

  /* ------------------------------------------------------------------ 1 */
  console.log('\n1. a ligação chega');
  const sidA = nextCallSid();
  const openingA = await webhook('/api/twilio/voice', { From: FROM, To: TO, CallSid: sidA, Direction: 'inbound' });
  check('a ligação recebe <Connect><ConversationRelay>', openingA.includes('<Connect') && openingA.includes('<ConversationRelay'), openingA.slice(0, 160));
  const wssA = relayUrlOf(openingA);
  check('o socket é wss:// no endereço público', Boolean(wssA?.startsWith('wss://')), wssA ?? '(sem url)');
  check('o TwiML é explícito sobre o provedor de voz (ElevenLabs, o padrão)', /ttsProvider="ElevenLabs"/.test(openingA));
  check('detecta o idioma de quem liga, com inglês como idioma da saudação', /language="multi"/.test(openingA) && /ttsLanguage="en-US"/.test(openingA) && /transcriptionProvider="Deepgram"/.test(openingA));
  check('declara uma voz por idioma extra e a normalização de números', /<Language code="es-US" ttsProvider="ElevenLabs" voice="[A-Za-z0-9]+"\/>/.test(openingA) && /<Language code="pt-BR"/.test(openingA) && /elevenlabsTextNormalization="on"/.test(openingA));
  const [callA] = await db.select().from(schema.calls).where(and(eq(schema.calls.workspaceId, ws.id), eq(schema.calls.providerId, sidA)));
  check('a ligação virou linha no CRM, roteada para a IA', callA?.meta.routed === 'ai', JSON.stringify(callA?.meta));
  if (!callA || !wssA) throw new Error('sem ligação ou sem url: nada mais a provar');
  /* Um consentimento de e-mail que já existia antes da ligação, para provar
   * que o sim falado é somado a ele e não escrito por cima. Gravado AQUI, antes
   * do handshake: a volta de modelo tira uma foto do contato quando o socket é
   * admitido (`voiceTurnFor`) e é essa foto que `record_text_consent` funde —
   * uma escrita no contato no meio da ligação não é vista (ver o relatório). */
  const [caller] = await db.select().from(schema.contacts).where(and(eq(schema.contacts.workspaceId, ws.id), eq(schema.contacts.phone, FROM)));
  check('o contato de quem ligou existe', Boolean(caller), caller?.id);
  await db.update(schema.contacts).set({ consent: { ...(caller?.consent ?? {}), email: true } }).where(eq(schema.contacts.id, caller!.id));

  /* ------------------------------------------------------------------ 2 */
  console.log('\n2. o portão do socket');
  const admitted = await handshake(wssA);
  check('assinatura da Twilio sobre a URL wss admite a conexão', !(admitted instanceof Response), admitted instanceof Response ? `${admitted.status} ${await admitted.text()}` : 'admitida');
  const badSig = await handshake(wssA, { signature: 'AAAA' });
  check('assinatura errada é recusada com 403', badSig instanceof Response && badSig.status === 403, badSig instanceof Response ? String(badSig.status) : 'admitida');
  const unsigned = await handshake(wssA, { signature: null });
  check('sem assinatura, sem VOICE_RELAY_ALLOW_UNSIGNED, é recusada', unsigned instanceof Response && unsigned.status === 403, unsigned instanceof Response ? String(unsigned.status) : 'admitida');
  const stale = await mintRelayToken(callA.id, sidA, Date.now() - 3_600_000);
  const staleUrl = wssA.replace(/exp=\d+/, `exp=${stale.exp}`).replace(/sig=[0-9a-f]+/, `sig=${stale.sig}`);
  const expired = await handshake(staleUrl);
  check('token vencido é recusado com 410', expired instanceof Response && expired.status === 410, expired instanceof Response ? String(expired.status) : 'admitida');
  const other = await mintRelayToken(callA.id, 'CAoutra0000000000000000000000000', Date.now());
  const otherUrl = wssA.replace(/exp=\d+/, `exp=${other.exp}`).replace(/sig=[0-9a-f]+/, `sig=${other.sig}`);
  const wrongSid = await handshake(otherUrl);
  check('token de outro CallSid é recusado com 403', wrongSid instanceof Response && wrongSid.status === 403, wrongSid instanceof Response ? String(wrongSid.status) : 'admitida');
  if (admitted instanceof Response) throw new Error('portão fechado: nada mais a provar');

  /* ------------------------------------------------------------------ 3 */
  console.log('\n3. a conversa');
  const { sink, sent, nextReply } = fakeSink();
  const session = new RelaySession(
    { ...admitted.deps, sink, deadlineMs: Date.now() + 8 * 3_600_000 },
    /* Física em miniatura: o filler dispara logo, as falas "tocam" em um
     * milissegundo, para o teste não esperar o tempo de uma frase. */
    { fillerMs: 1, speakMsPerChar: 0, speakMinMs: 1, speakMaxMs: 1, rotateWaitMs: 1 },
  );
  const store = dbSessionStore(db);

  await session.receive({ type: 'setup', sessionId: 'VXzz', accountSid: ACCOUNT_SID, callSid: sidA, from: FROM, to: TO, customParameters: { call: callA.id } });
  let row = await store.byCall(ws.id, callA.id);
  check('o setup abre a sessão e a saudação é o primeiro turno, em inglês, dizendo que é IA', row?.status === 'live' && row.turns[0]?.role === 'assistant' && /AI assistant/.test(row.turns[0]?.text ?? ''), row?.turns[0]?.text);
  const [answered] = await db.select().from(schema.calls).where(eq(schema.calls.id, callA.id));
  check('a ligação foi marcada como atendida (answeredAt)', Boolean(answered?.answeredAt) && answered?.meta.answeredBy === 'ai');

  /* 3a. Pede para marcar: o modelo olha a agenda e oferece, pedindo o sim para textos. */
  say({ toolCalls: [{ name: 'list_free_slots', input: { days: 7 } }] }, { text: 'I have a couple of openings this week. Which works for you? And may I text you at this number?' });
  const reply1 = nextReply();
  await session.receive({ type: 'prompt', voicePrompt: "Hi, I'd like to book a discovery call.", last: true });
  const r1 = await reply1;
  await sleep(500);
  check('a resposta é falada em um só token com last=true', r1.type === 'text' && r1.last === true, JSON.stringify(r1).slice(0, 120));
  check('o filler foi falado enquanto o modelo pensava', sent.some((m) => m.type === 'text' && m.token === SENTENCES.filler && m.preemptible === true));
  const firstRequest = JSON.stringify(replay.log.calls[0]?.body ?? {});
  check('a regra do consentimento antes de marcar está no prompt', /record_text_consent/.test(firstRequest) && /BEFORE booking/i.test(firstRequest));
  row = await store.byCall(ws.id, callA.id);
  const offered = row?.state.offered ?? [];
  check('os horários oferecidos ficaram no estado da sessão', offered.length > 0, JSON.stringify(offered.slice(0, 2)));
  check('o turno do usuário foi gravado antes do do assistente', row?.turns[1]?.role === 'user' && row?.turns[2]?.role === 'assistant', row?.turns.map((t) => t.role).join(','));
  check('o turno do assistente carrega o rastro da ferramenta', Boolean(row?.turns[2]?.tools?.some((t) => t.name === 'list_free_slots')));

  /* 3b. "Manda o link" antes do sim: recusado, e a recusa diz o que fazer. */
  const callsBefore = replay.log.calls.length;
  say({ toolCalls: [{ name: 'send_text_with_link', input: { kind: 'booking' } }] }, { text: 'I need your okay first. May I text you at this number?' });
  const reply2 = nextReply();
  await session.receive({ type: 'prompt', voicePrompt: 'Can you just text me the link?', last: true });
  await reply2;
  await sleep(300);
  const afterRefusal = JSON.stringify(replay.log.calls.slice(callsBefore).map((c) => c.body));
  check('texto antes do consentimento é recusado com instrução ao modelo', /have not agreed to texts/.test(afterRefusal), afterRefusal.match(/Not sent[^"]{0,120}/)?.[0] ?? '(sem recusa)');
  check('e nenhum SMS saiu', !replay.log.calls.some((c) => c.url.includes('twilio.com') && /Messages/.test(c.url)));

  /* 3c. O sim, o e-mail soletrado, a marcação. O consentimento de e-mail que
   * já existia tem de sobreviver: `updateContact` troca o `consent` inteiro. */
  const firstOffered = offered[0]?.startIso ?? '';
  say(
    { toolCalls: [{ name: 'record_text_consent', input: { agreed: true } }] },
    { toolCalls: [{ name: 'normalize_spoken_email', input: { spoken: 'john dot smith at example dot com' } }] },
    { toolCalls: [{ name: 'book_appointment', input: { start: firstOffered, name: 'John Smith', email: 'john.smith@example.com', notes: 'Wants to talk about ads.' } }] },
    { text: 'You are booked. The confirmation is on its way.' },
  );
  const reply3 = nextReply();
  await session.receive({ type: 'prompt', voicePrompt: 'Yes, you can text me. The first one works. My email is john dot smith at example dot com.', last: true });
  await reply3;
  await sleep(600);
  const [consented] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, caller!.id));
  check('o sim virou consent.sms=true', consented?.consent?.sms === true, JSON.stringify(consented?.consent));
  check('e o consentimento de e-mail anterior sobreviveu', consented?.consent?.email === true);
  check('o e-mail soletrado foi gravado no contato antes de marcar', consented?.email === 'john.smith@example.com', consented?.email ?? '(vazio)');
  const appointments = await db.select().from(schema.appointments).where(eq(schema.appointments.workspaceId, ws.id));
  check('o compromisso existe', appointments.length === 1, `${appointments.length} compromisso(s)`);
  check('no horário que foi oferecido', appointments[0]?.startAt.toISOString() === new Date(firstOffered).toISOString(), `${appointments[0]?.startAt.toISOString()} vs ${firstOffered}`);
  const runs = await db.select().from(schema.aiRuns).where(eq(schema.aiRuns.workspaceId, ws.id));
  check('cada volta virou uma linha em ai_runs com prompt.kind=voice', runs.length >= 3 && runs.every((r) => (r.prompt as { kind?: string } | null)?.kind === 'voice'), `${runs.length} linha(s)`);
  check('a volta que marcou está registrada como booked', runs.some((r) => r.decision === 'booked'));

  /* 3d. Cancelar com o nome errado: recusado sem dizer o nome de verdade. */
  const before4 = replay.log.calls.length;
  say({ toolCalls: [{ name: 'cancel_appointment', input: { confirmedName: 'Bob', confirmedDay: 'Monday' } }] }, { text: "I couldn't find a booking under that name. Would you like me to take a message?" });
  const reply4 = nextReply();
  await session.receive({ type: 'prompt', voicePrompt: 'Actually, cancel it.', last: true });
  await reply4;
  await sleep(300);
  const afterCancel = JSON.stringify(replay.log.calls.slice(before4).map((c) => c.body));
  check('cancelar com nome errado é recusado', /does not match the booking/.test(afterCancel), afterCancel.match(/The name they gave[^"]{0,80}/)?.[0] ?? '(sem recusa)');
  const stillThere = await db.select().from(schema.appointments).where(eq(schema.appointments.workspaceId, ws.id));
  check('e o compromisso continua de pé', stillThere.length === 1 && stillThere[0]?.status !== 'canceled', stillThere.map((a) => a.status).join(','));

  /* 3e. A pessoa passa a falar espanhol: a sessão avisa o modelo uma vez, o
   * modelo chama `switch_language`, e a partir daí a Twilio recebe uma só
   * mensagem `language` e cada fala carrega `lang="es-US"`. */
  const before5 = replay.log.calls.length;
  const sentBefore5 = sent.length;
  say({ toolCalls: [{ name: 'switch_language', input: { code: 'es-US' } }] }, { text: '¡Claro! ¿En qué más puedo ayudarle?' });
  const replyEs = nextReply();
  await session.receive({ type: 'prompt', voicePrompt: 'Perdón, ¿podemos seguir en español?', lang: 'es', last: true });
  const rEs = await replyEs;
  await sleep(300);
  const spanishRequest = JSON.stringify(replay.log.calls.slice(before5).map((c) => c.body));
  check('o modelo recebe a nota "[caller spoke in Spanish]"', /\[caller spoke in Spanish\]/.test(spanishRequest));
  const languageMessages = sent.slice(sentBefore5).filter((m) => m.type === 'language');
  check('a sessão manda uma só mensagem language com ttsLanguage=es-US', languageMessages.length === 1 && languageMessages[0]?.type === 'language' && languageMessages[0].ttsLanguage === 'es-US', JSON.stringify(languageMessages));
  check('a resposta é falada em espanhol com lang=es-US', rEs.type === 'text' && rEs.lang === 'es-US' && /Claro/.test(rEs.token), JSON.stringify(rEs).slice(0, 120));
  row = await store.byCall(ws.id, callA.id);
  check('o idioma ficou no estado da sessão', row?.state.lang === 'es-US' && row?.state.langHint === 'es', JSON.stringify({ lang: row?.state.lang, hint: row?.state.langHint }));

  /* 3f. "Não me mande mais nada": não-contatar, confirmação falada, fim. */
  say({ toolCalls: [{ name: 'stop_messages', input: {} }] });
  const reply5 = nextReply();
  await session.receive({ type: 'prompt', voicePrompt: "Don't message me again. Goodbye.", last: true });
  const r5 = await reply5;
  await session.finished;
  await sleep(300);
  const [stopped] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, caller!.id));
  check('stop_messages marca não-contatar', stopped?.dnc === true, `dnc=${stopped?.dnc}`);
  const endMessage = sent.find((m) => m.type === 'end');
  const handoff = endMessage?.type === 'end' ? (JSON.parse(endMessage.handoffData ?? '{}') as { reason?: string }) : null;
  check('a confirmação é falada e a sessão termina com end{assistant-ended}', r5.type === 'text' && handoff?.reason === 'assistant-ended', JSON.stringify({ said: r5.type === 'text' ? r5.token : r5.type, handoff }));
  check('a despedida ainda carrega o idioma da pessoa', r5.type === 'text' && r5.lang === 'es-US', r5.type === 'text' ? String(r5.lang) : r5.type);
  check('nenhum SMS de confirmação de opt-out saiu', !replay.log.calls.some((c) => c.url.includes('twilio.com') && /Messages/.test(c.url) && /STOP|opt/i.test(JSON.stringify(c.body))));
  row = await store.byCall(ws.id, callA.id);
  check('a linha da sessão está encerrada com o desfecho booked', row?.status === 'ended' && row.outcome === 'booked', `${row?.status}/${row?.outcome}`);
  await session.flush();

  /* ------------------------------------------------------------------ 4 */
  console.log('\n4. relay-done');
  /* O status callback chega primeiro, como acontece quando a Twilio derruba a
   * perna antes de postar a action: não pode registrar a ligação na linha do
   * tempo nem marcá-la como perdida. */
  const statusFirst = await webhook('/api/twilio/voice-status', { CallSid: sidA, CallStatus: 'completed', CallDuration: '95', From: FROM, To: TO, Direction: 'inbound' }, STATUS as never);
  check('o status callback responde sem erro', statusFirst.length < 400, statusFirst.slice(0, 80));
  const doneA = await webhook(`/api/twilio/voice?step=relay-done&call=${callA.id}`, {
    CallSid: sidA,
    SessionStatus: 'ended',
    HandoffData: JSON.stringify({ reason: 'assistant-ended' }),
  });
  check('assistant-ended responde <Hangup/>', /<Hangup/.test(doneA), doneA.slice(0, 120));
  const [closedA] = await db.select().from(schema.calls).where(eq(schema.calls.id, callA.id));
  check('a ligação está completa e não é perdida', closedA?.status === 'completed' && closedA.missed === false, `${closedA?.status} missed=${closedA?.missed}`);
  const activitiesA = await db.select().from(schema.activities).where(and(eq(schema.activities.workspaceId, ws.id), eq(schema.activities.type, 'call')));
  check('uma só entrada na linha do tempo, mesmo com o status callback antes', activitiesA.length === 1, `${activitiesA.length} entrada(s)`);
  check('com o título da assistente', (activitiesA[0]?.meta as { titleKey?: string })?.titleKey === 'Assistant answered a call from {who} · {time}', (activitiesA[0]?.meta as { titleKey?: string })?.titleKey);
  const inboxA = await db
    .select({ body: schema.messages.body, meta: schema.messages.meta })
    .from(schema.messages)
    .innerJoin(schema.conversations, eq(schema.conversations.id, schema.messages.conversationId))
    .where(and(eq(schema.messages.workspaceId, ws.id), eq(schema.conversations.channel, 'voice')));
  check('a transcrição está na caixa de entrada com meta.ai', inboxA.length === 1 && (inboxA[0]?.meta as { ai?: boolean })?.ai === true && /Caller:|Quem ligou:/.test(inboxA[0]?.body ?? ''), inboxA[0]?.body.slice(0, 80));
  check('a ligação aponta para a conversa e tem a transcrição', Boolean(closedA?.conversationId) && Boolean(closedA?.transcript));
  const [summaryJob] = await db.select().from(schema.jobs).where(and(eq(schema.jobs.workspaceId, ws.id), eq(schema.jobs.dedupeKey, `voice:summary:${callA.id}`)));
  check('o resumo foi agendado', summaryJob?.status === 'pending' && (summaryJob.payload as { op?: string }).op === 'summarize', summaryJob?.status);

  say({ text: 'John Smith called to book a discovery call. He agreed to texts and gave his e-mail. A 20-minute call was booked and confirmed. Next step: nothing.' });
  const summarized = await summarizeAiCall(db, ws.id, callA.id);
  check('o resumo foi escrito', summarized.done, summarized.done ? summarized.summary.slice(0, 80) : `${summarized.reason} ${summarized.detail ?? ''}`);
  check('em inglês, com a linha "Language: Spanish" no fim', summarized.done && /\nLanguage: Spanish$/.test(summarized.summary), summarized.done ? summarized.summary.slice(-40) : '');
  // O pedido ao modelo é o que leva a transcrição; o que vem depois dele no log é o e-mail para a equipe.
  const summaryRequest = JSON.stringify(replay.log.calls.filter((c) => /Transcript:/.test(JSON.stringify(c.body ?? {}))).at(-1)?.body ?? {});
  check('o pedido do resumo diz que a ligação foi em espanhol e pede inglês mesmo assim', /conducted in Spanish/.test(summaryRequest) && /US English anyway/.test(summaryRequest));
  const [withSummary] = await db.select().from(schema.calls).where(eq(schema.calls.id, callA.id));
  const rowSummary = await store.byCall(ws.id, callA.id);
  check('nas duas linhas: calls.summary e voice_sessions.summary', Boolean(withSummary?.summary) && withSummary?.summary === rowSummary?.summary);
  const summaryRuns = await db.select().from(schema.aiRuns).where(eq(schema.aiRuns.workspaceId, ws.id));
  check('com uma linha em ai_runs {kind: voice, stage: summary}', summaryRuns.some((r) => (r.prompt as { stage?: string } | null)?.stage === 'summary'));
  const [entryA] = await db.select().from(schema.activities).where(eq(schema.activities.id, activitiesA[0]!.id));
  check('a entrada da linha do tempo começa pelo resumo', Boolean(withSummary?.summary && entryA?.body?.startsWith(withSummary.summary)), entryA?.body?.slice(0, 60));
  check('a equipe foi avisada (booked) por e-mail', summarized.done && summarized.notified.sent.some((s) => s.includes('@')), summarized.done ? JSON.stringify(summarized.notified) : '');
  const again = await summarizeAiCall(db, ws.id, callA.id);
  check('rodar o resumo de novo não escreve nem avisa duas vezes', !again.done && again.reason === 'already summarized', again.done ? 'escreveu de novo' : again.reason);

  /* ------------------------------------------------------------------ 5 */
  console.log('\n5. reconexão');
  const sidB = nextCallSid();
  const openingB = await webhook('/api/twilio/voice', { From: '+13102000002', To: TO, CallSid: sidB, Direction: 'inbound' });
  check('segunda ligação também vai para a assistente', openingB.includes('<ConversationRelay'), openingB.slice(0, 80));
  const [callB] = await db.select().from(schema.calls).where(and(eq(schema.calls.workspaceId, ws.id), eq(schema.calls.providerId, sidB)));
  // O setup do socket, sem o socket: abre a linha da sessão como `store.open` faria.
  await store.open(ws.id, callB!.id);
  await store.append(ws.id, callB!.id, [{ role: 'assistant', text: 'Hello.', ts: Date.now() }, { role: 'user', text: 'What are your hours?', ts: Date.now() }]);
  // A pessoa tinha passado para o português: a reconexão tem de abrir nele.
  await store.setState(ws.id, callB!.id, { lang: 'pt-BR' });
  const rotated = await webhook(`/api/twilio/voice?step=relay-done&call=${callB!.id}`, { CallSid: sidB, SessionStatus: 'ended', HandoffData: JSON.stringify({ reason: 'rotate' }) });
  check('rotate devolve um novo <Connect> com resume="1"', /<ConversationRelay/.test(rotated) && /name="resume" value="1"/.test(rotated) && !/welcomeGreeting/.test(rotated), rotated.slice(0, 200));
  check('e abre no idioma em que a pessoa estava falando', /ttsLanguage="pt-BR"/.test(rotated) && /language="multi"/.test(rotated), rotated.match(/ttsLanguage="[^"]*"/)?.[0] ?? '(sem ttsLanguage)');
  const dropped = await webhook(`/api/twilio/voice?step=relay-done&call=${callB!.id}`, { CallSid: sidB, SessionStatus: 'failed', ErrorCode: '64105', ErrorMessage: 'WebSocket closed' });
  check('64105 com a sessão viva é retomado, não encerrado', /<ConversationRelay/.test(dropped), dropped.slice(0, 120));
  const rowB = await store.byCall(ws.id, callB!.id);
  check('o tombo ficou anotado no estado da sessão', rowB?.state.lastFailure === 64105, JSON.stringify(rowB?.state));
  const fatal = await webhook(`/api/twilio/voice?step=relay-done&call=${callB!.id}`, { CallSid: sidB, SessionStatus: 'failed', ErrorCode: '64110', ErrorMessage: 'AI/ML addendum not accepted' });
  check('64110 cai no recado', /<Record/.test(fatal), fatal.slice(0, 120));
  /* Sem filtrar pela workspace: `recordError` junta a mesma falha numa só
   * linha por uma hora, seja de que workspace for, então uma segunda rodada
   * deste teste dentro da hora só soma 1 ao contador da linha da rodada
   * anterior — cuja workspace já foi apagada. O que se prova é que a linha
   * existe e foi tocada agora. */
  const relayErrors = await db
    .select()
    .from(schema.errorLog)
    .where(and(eq(schema.errorLog.where, 'relay'), gte(schema.errorLog.lastAt, new Date(Date.now() - 60_000))));
  check('e fica no error_log com where=relay', relayErrors.some((e) => /64110/.test(e.message)), relayErrors.map((e) => e.message.slice(0, 60)).join(' | '));
  const [afterB] = await db.select().from(schema.calls).where(eq(schema.calls.id, callB!.id));
  check('uma ligação em que a pessoa falou não vira perdida', afterB?.missed === false);

  /* ------------------------------------------------------------------ 6 */
  console.log('\n6. transferência');
  const sidC = nextCallSid();
  const openingC = await webhook('/api/twilio/voice', { From: '+13102000003', To: TO, CallSid: sidC, Direction: 'inbound' });
  check('terceira ligação vai para a assistente', openingC.includes('<ConversationRelay'));
  const [callC] = await db.select().from(schema.calls).where(and(eq(schema.calls.workspaceId, ws.id), eq(schema.calls.providerId, sidC)));
  await store.open(ws.id, callC!.id);
  await store.append(ws.id, callC!.id, [{ role: 'assistant', text: 'Hello.', ts: Date.now() }, { role: 'user', text: 'I want to talk to a person.', ts: Date.now() }]);
  await store.setState(ws.id, callC!.id, { transferAttempts: 1, lang: 'es-US' });
  const dial = await webhook(`/api/twilio/voice?step=relay-done&call=${callC!.id}`, { CallSid: sidC, SessionStatus: 'ended', HandoffData: JSON.stringify({ reason: 'transfer', to: TRANSFER_TO }) });
  check('transfer devolve <Dial> para o número escolhido', /<Dial/.test(dial) && dial.includes(TRANSFER_TO), dial.slice(0, 160));
  check('sem o "Connecting you now." em inglês para quem estava falando espanhol', !/Connecting you now/.test(dial));
  check('com a action no passo after-transfer e o sussurro via=ai', /step=after-transfer/.test(dial) && /via=ai/.test(dial));
  const back = await webhook(`/api/twilio/voice?step=after-transfer&call=${callC!.id}`, { CallSid: sidC, DialCallStatus: 'no-answer', DialCallDuration: '0' });
  check('ninguém atendeu: volta para a assistente', /<ConversationRelay/.test(back), back.slice(0, 120));
  const rowC = await store.byCall(ws.id, callC!.id);
  check('com a nota de sistema "the team did not pick up"', Boolean(rowC?.turns.some((t) => t.role === 'system' && /did not pick up/.test(t.text))), rowC?.turns.map((t) => t.role).join(','));
  // A segunda tentativa só existe pelo teclado (0), que a sessão conta como mais uma.
  await store.setState(ws.id, callC!.id, { transferAttempts: 2 });
  const dial2 = await webhook(`/api/twilio/voice?step=relay-done&call=${callC!.id}`, { CallSid: sidC, SessionStatus: 'ended', HandoffData: JSON.stringify({ reason: 'transfer', to: TRANSFER_TO }) });
  check('a segunda transferência ainda disca', /<Dial/.test(dial2));
  const back2 = await webhook(`/api/twilio/voice?step=after-transfer&call=${callC!.id}`, { CallSid: sidC, DialCallStatus: 'no-answer', DialCallDuration: '0' });
  check('segunda vez sem resposta: recado', /<Record/.test(back2) && !/<ConversationRelay/.test(back2), back2.slice(0, 120));
  const [afterC] = await db.select().from(schema.calls).where(eq(schema.calls.id, callC!.id));
  check('missed continua falso do começo ao fim', afterC?.missed === false, `missed=${afterC?.missed}`);
  const rowC2 = await store.byCall(ws.id, callC!.id);
  check('a sessão terminou como transferred', rowC2?.status === 'ended' && rowC2.outcome === 'transferred', `${rowC2?.status}/${rowC2?.outcome}`);

  /* ------------------------------------------------------------------ 7 */
  console.log('\n7. correio de voz depois da assistente, e número oculto');
  /* A assistente falou com a pessoa e ela escolheu deixar recado
   * (`leave_voicemail`). O passo `voicemail` grava o recado como sempre, mas
   * a ligação foi atendida: não é perdida e não recebe o texto de perdida. */
  const sidD = nextCallSid();
  const openingD = await webhook('/api/twilio/voice', { From: '+13102000004', To: TO, CallSid: sidD, Direction: 'inbound' });
  check('quarta ligação vai para a assistente', openingD.includes('<ConversationRelay'));
  const [callD] = await db.select().from(schema.calls).where(and(eq(schema.calls.workspaceId, ws.id), eq(schema.calls.providerId, sidD)));
  await store.open(ws.id, callD!.id);
  await store.markAnswered(callD!);
  await store.append(ws.id, callD!.id, [{ role: 'assistant', text: 'Hello.', ts: Date.now() }, { role: 'user', text: 'Just let me leave a message.', ts: Date.now() }]);
  const toVoicemail = await webhook(`/api/twilio/voice?step=relay-done&call=${callD!.id}`, { CallSid: sidD, SessionStatus: 'ended', HandoffData: JSON.stringify({ reason: 'voicemail' }) });
  check('leave_voicemail devolve <Record>', /<Record/.test(toVoicemail), toVoicemail.slice(0, 120));
  const recorded = await webhook(`/api/twilio/voice?step=voicemail&call=${callD!.id}`, { CallSid: sidD, RecordingSid: 'REzz0000000000000000000000000000d', RecordingDuration: '12', RecordingUrl: 'https://api.twilio.com/rec' });
  check('o recado é aceito', recorded.length > 0 && !/<Reject/.test(recorded), recorded.slice(0, 80));
  const [afterD] = await db.select().from(schema.calls).where(eq(schema.calls.id, callD!.id));
  check('a ligação guarda o recado e não é perdida', afterD?.recordingSid === 'REzz0000000000000000000000000000d' && afterD.missed === false, `missed=${afterD?.missed} rec=${afterD?.recordingSid}`);
  const [missedJobD] = await db.select().from(schema.jobs).where(and(eq(schema.jobs.workspaceId, ws.id), eq(schema.jobs.dedupeKey, `voice:missed:${callD!.id}`)));
  check('nenhum texto de ligação perdida foi agendado', !missedJobD, missedJobD ? `job ${missedJobD.status}` : '');
  /* O status callback chega por último e é o que a Twilio repete: a linha da
   * sessão fecha por ele, e nada é arquivado duas vezes. */
  await webhook('/api/twilio/voice-status', { CallSid: sidD, CallStatus: 'completed', CallDuration: '40', From: '+13102000004', To: TO, Direction: 'inbound' }, STATUS as never);
  const rowD = await store.byCall(ws.id, callD!.id);
  check('a sessão está encerrada como voicemail', rowD?.status === 'ended' && rowD.endReason === 'voicemail', `${rowD?.status}/${rowD?.endReason}`);
  const inboxD = await db
    .select({ id: schema.messages.id, meta: schema.messages.meta })
    .from(schema.messages)
    .where(and(eq(schema.messages.workspaceId, ws.id), eq(schema.messages.providerId, `relay:${rowD?.id ?? ''}`)));
  check('a transcrição foi arquivada uma só vez', inboxD.length === 1, `${inboxD.length} mensagem(ns)`);

  /* Sessão que caiu antes de a pessoa falar: aí sim é ligação perdida, com
   * entrada na linha do tempo e o texto de perdida como qualquer outra. */
  const sidE = nextCallSid();
  await webhook('/api/twilio/voice', { From: '+13102000005', To: TO, CallSid: sidE, Direction: 'inbound' });
  const [callE] = await db.select().from(schema.calls).where(and(eq(schema.calls.workspaceId, ws.id), eq(schema.calls.providerId, sidE)));
  await store.open(ws.id, callE!.id);
  await store.markAnswered(callE!);
  await store.append(ws.id, callE!.id, [{ role: 'assistant', text: 'Hello.', ts: Date.now() }]);
  const failedE = await webhook(`/api/twilio/voice?step=relay-done&call=${callE!.id}`, { CallSid: sidE, SessionStatus: 'failed', ErrorCode: '64110', ErrorMessage: 'AI/ML addendum not accepted' });
  check('falha antes de a pessoa falar cai no recado', /<Record/.test(failedE));
  const [afterE] = await db.select().from(schema.calls).where(eq(schema.calls.id, callE!.id));
  const entriesE = await db.select().from(schema.activities).where(and(eq(schema.activities.workspaceId, ws.id), eq(schema.activities.contactId, afterE!.contactId!), eq(schema.activities.type, 'call')));
  const [missedJobE] = await db.select().from(schema.jobs).where(and(eq(schema.jobs.workspaceId, ws.id), eq(schema.jobs.dedupeKey, `voice:missed:${callE!.id}`)));
  check('e é ligação perdida, com entrada na linha do tempo e texto agendado', afterE?.missed === true && entriesE.length === 1 && Boolean(missedJobE), `missed=${afterE?.missed} entradas=${entriesE.length} job=${missedJobE?.status ?? '-'}`);
  await webhook('/api/twilio/voice-status', { CallSid: sidE, CallStatus: 'completed', CallDuration: '8', From: '+13102000005', To: TO, Direction: 'inbound' }, STATUS as never);
  const entriesE2 = await db.select().from(schema.activities).where(and(eq(schema.activities.workspaceId, ws.id), eq(schema.activities.contactId, afterE!.contactId!), eq(schema.activities.type, 'call')));
  check('o status callback não arquiva de novo nem muda o título', entriesE2.length === 1 && (entriesE2[0]?.meta as { ai?: boolean })?.ai !== true, `${entriesE2.length} entrada(s), ai=${(entriesE2[0]?.meta as { ai?: boolean })?.ai}`);

  /* Duas ligações de número oculto viram dois contatos, não um só "anonymous". */
  const sidF = nextCallSid();
  const sidG = nextCallSid();
  await webhook('/api/twilio/voice', { From: 'anonymous', To: TO, CallSid: sidF, Direction: 'inbound' });
  await webhook('/api/twilio/voice', { From: '+266696687', To: TO, CallSid: sidG, Direction: 'inbound' });
  const [callF] = await db.select().from(schema.calls).where(and(eq(schema.calls.workspaceId, ws.id), eq(schema.calls.providerId, sidF)));
  const [callG] = await db.select().from(schema.calls).where(and(eq(schema.calls.workspaceId, ws.id), eq(schema.calls.providerId, sidG)));
  const [contactF] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, callF!.contactId!));
  const [contactG] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, callG!.contactId!));
  check('cada ligação de número oculto tem contato próprio, sem telefone e com a etiqueta', Boolean(contactF && contactG) && contactF!.id !== contactG!.id && contactF!.phone === null && contactG!.phone === null && (contactF!.tags ?? []).includes('withheld'), `${contactF?.id} / ${contactG?.id} phone=${contactF?.phone} tags=${JSON.stringify(contactF?.tags)}`);

  check('o roteiro do modelo foi consumido inteiro', replay.pending.length === 0, `${replay.pending.length} fala(s) sobrando`);
} finally {
  replay.restore();
  // error_log has no foreign key to workspaces (an error must survive the
  // workspace it happened in), so the rows this script provoked on purpose —
  // bad signature, 64105, 64110 — would outlive the throwaway workspace and
  // pile up in the ops screen, one set per run. Sweep them by hand.
  await db.delete(schema.errorLog).where(eq(schema.errorLog.workspaceId, ws.id));
  await db.delete(schema.workspaces).where(eq(schema.workspaces.id, ws.id));
  console.log('\nworkspace descartável apagada');
}

console.log(failures ? `\n${failures} verificação(ões) falharam` : '\ntudo certo');
process.exit(failures ? 1 : 0);
