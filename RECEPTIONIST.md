# How the receptionist works

An automated assistant answers a workspace's phone line over Twilio
ConversationRelay (speech in, text to the model, speech out) and acts
through the CRM: books, reschedules and cancels discovery calls, takes
messages, saves a name and an e-mail, texts a link with consent, transfers
to a person, and files everything on the timeline and in the inbox. Switch
and settings: Calls → Call settings → "AI receptionist". It speaks with the
same agent, model and key as Settings → AI; "Voicemail" there is a
different thing (the agent answering a voicemail by text).

**Modes**, per workspace and overridable per number:

- `always` — the assistant picks up every call; the forwarding number is
  only used when the caller asks for a person.
- `after_hours` — inside business hours with a forwarding number, the human
  rings as before; outside hours, or with no forwarding number, the assistant
  answers.
- `overflow` — the human rings for `ringSeconds`; on no answer the assistant
  answers instead of voicemail. Outside hours it behaves like `after_hours`.

**Two clocks, on purpose.** "Ring anyway after hours" (Calls → Call
settings) governs whether the human's phone rings; the assistant's
`after_hours`/`overflow` read the business hours in Settings → Workspace
directly, so a workspace that rings anyway still hands a 3 a.m. call to the
assistant. The spoken-language setting is for voicemail only; the assistant
greets in English and follows the caller from there (see "Voice and
language" below).

**Voice and language.** The assistant speaks through ElevenLabs by default
(since 2026-09-14; Amazon and Google stay selectable) under a persona name
from the card — "Hi, thanks for calling Acme. This is Ava, the AI
assistant. How can I help you today?", or "I'm the AI assistant here" with
no name. The disclosure stays in the greeting whatever the persona; a
custom greeting should keep it. English is the primary language of every
call: the greeting is English, and so is everything the team reads —
notes, activity and task titles, the transcript labels, the summary. When
the caller answers in another language, the TwiML's `language="multi"`
(Deepgram + ElevenLabs, the only pair Twilio allows it with) reports the
language of each prompt; the session notes it for the model once
("[caller spoke in Spanish]"), the model calls `switch_language`, and the
session sends Twilio one `language` message, stamps `lang` on every text
after it, speaks its own fixed sentences (filler, "one second, please",
the transfer line, the idle ask) from the table for that language
(`SENTENCES_BY_LANG` in `session.ts`; Spanish, Portuguese, French,
German, Italian, English for the rest) and persists `state.lang`, so a
rotated or resumed connection opens in the same voice (`ttsLanguage` on
the fresh `<Connect>`). A switch made on the same turn as a hang-up or a
transfer still lands (`VoiceTurnResult.language`): the farewell or the
"connecting you" is read in the new voice, and a switch the model made on
the turn a rotate or a kill cut short is written to the row too, so the
resumed connection opens in that language rather than in English. Once
the call has moved, an English sentence from the caller is noted the same
way ("[caller spoke in English]", once), and the model brings the call
back with `switch_language('en-US')` if it agrees — a note is never a
switch, so one mislabelled "sí" cannot flip the call. The languages a workspace allows are checkboxes on
the card (`settings.ai.languages`, default es-US, pt-BR, fr-FR, de-DE,
it-IT); the voice per language is Twilio's own default id from
`LANGUAGE_VOICES` (overridable in config through
`settings.ai.voicesByLanguage`). On Amazon or Google the list is inert:
`switchableLanguages()` in `settings.ts` is what the model's tool list,
the engine's `language` message and the TwiML all read, and it is empty
unless the provider is ElevenLabs, so such a workspace gets an
English-only prompt and no `switch_language` tool (the readiness card
says why). The summary is written in English and ends
with "Language: Spanish" when the call was not in English. Everything the
assistant writes into the CRM and every text it sends stays English.

**Readiness** (`src/lib/voice/relay/readiness.ts`) is one function asked by
the inbound route before every call and by the settings card on render, so
the card's red sentences are the reasons a call would not be connected: AI
off, agent disabled, model not connected or not proved, no public origin,
the daily AI cost ceiling, the daily minutes cap, nobody reachable (no
transfer number, no hand-off person, no member on e-mail alerts). Amber
ones (no calendar, no transfer number) narrow what the assistant can offer
without stopping it. Every failure of the relay itself falls back to the
voicemail of today; no call is left in silence.

**How it runs.** Twilio dials `wss://<origin>/api/twilio/relay?call=…&exp=…&sig=…`.
The route (`src/pages/api/twilio/relay.ts`) verifies the CRM's own HMAC
token *and* Twilio's `X-Twilio-Signature` over the `wss://` URL, then
upgrades inside the Astro function (`experimental_upgradeWebSocket`, proven
on Vercel Fluid compute 2026-09-13). The function has a fixed lifetime
(`FUNCTION_MAX_DURATION_S` in `function-limits.mjs`, shared with
`astro.config.mjs`), so the session rotates before the deadline: it says
"One second, please", ends the socket with `rotate`, and the `relay-done`
action answers a fresh `<Connect>`; the transcript and state live in
`voice_sessions`, so the conversation continues where it was. A
server-side drop (64105) on a live session is treated as a resume, a second
one as a failure. Everything the team reads is written in the team's
language; everything the caller hears is English, or the caller's own
language once the model switched (the session's own sentences in
`session.ts`, the prompt rules in `prompt.ts`).

**Callers and contacts.** A caller whose number is withheld ("anonymous",
"restricted") gets a contact of their own for that call — no phone, tagged
`withheld` — rather than sharing one "anonymous" row with every other hidden
caller, so nobody's e-mail, consent or booking can leak to the next. The
assistant offers such callers no texts and no look-ups, and books only with
a name and an e-mail given on the call. One change reaches the text agent
too: `book_appointment` now writes a name or e-mail the model learned on
the thread onto the contact before booking (so the confirmation is
addressed to the right person) and reports which channel the confirmation
actually reached instead of promising it went out.

**After the call.** `relay-done` completes the call row, files one timeline
entry ("Assistant answered a call from …", claimed once even if the status
callback arrives first), puts the transcript in the inbox as a `voice`
message with `meta.ai`, and books a `summarize` job. The status callback
(`voice-status`) is the retried webhook and the net under `relay-done`:
if the action never arrived (a deadline kill whose action timed out, a
caller who hung up while the assistant's transfer was ringing), it closes
the session row and files the same things, each behind a claim so nothing
is filed twice. A call the assistant answered is never "missed" and gets
no missed-call text, even when it ends in the voicemail box; only a session
that failed before the caller said anything is filed as a missed call. The job
(`src/lib/voice/relay/summary.ts`) writes three sentences and a next step
onto `calls.summary` and `voice_sessions.summary`, records one `ai_runs`
row `{kind: 'voice', stage: 'summary'}`, and notifies the team
(`notify.ts`) the way the unanswered-message alert does — same recipients,
e-mail, text for members who chose it, Slack `calls` — for a message taken,
a booking made or changed, a transfer nobody picked up, or a failure. A call
that only asked for information gets the inbox entry alone. Note: the
transcript sits in the same `voice` conversation as voicemails, so a later
voicemail from the same contact sees it as thread history when the text
agent answers it; accepted for v1.

**Cost.** Twilio bills ConversationRelay at about $0.07/min on top of the
voice leg, more than the model does; hence the per-workspace daily minutes
cap (Calls → Call settings) next to the daily AI cost ceiling (Settings →
AI). Model turns are stamped `prompt.kind = 'voice'` and shown as "call" on
/app/ai; they do not count as messages.

**Twilio side.** The AI/ML Features Addendum must be accepted in the Twilio
Console for the main account and each subaccount that will use it; until
then every connection fails with error 64110 (visible on the card as "Last
relay error" and in the error log) and the caller goes to voicemail.
ElevenLabs is the default provider and always explicit in the TwiML; check
the account for its per-minute surcharge. An ElevenLabs voice id Twilio
does not know is not a wrong voice but an error that ends every call at
connect, so the card only offers ids from Twilio's own list and asks for
one test call after any change of voice.

**Developing locally.** `astro dev` cannot upgrade a WebSocket, so the
socket runs as its own process behind a second tunnel:

```bash
npm run dev                     # TwiML, behind tunnel A → PUBLIC_CALLBACK_ORIGIN=https://<a>
npm run relay:dev               # the socket, behind tunnel B → VOICE_RELAY_URL=wss://<b>
```

`scripts/relay-dev.ts` rebuilds a `Request` from the upgrade request (host
from `x-forwarded-host`, the URL Twilio dialled) and runs the same `admit()`
as production, so try without `VOICE_RELAY_ALLOW_UNSIGNED` first: Twilio
signs the URL it dialled, which is the tunnel host. The flag is only
honoured when `VERCEL` is unset. `RELAY_DEV_PORT` (default 8787) moves the
port.

**Proofs, in order.**

1. `npx --yes tsx scripts/check-relay.ts` — the integration gate: a signed
   inbound call gets `<Connect><ConversationRelay>`; the socket gate admits
   Twilio's signature and refuses a bad one (403), an expired token (410)
   and another call's sid (403); the session engine with the real model turn
   and a scripted provider proves consent before booking, the refused text
   before consent, the consent merge, the booking with a spelled e-mail, the
   filler, the refused cancel, and stop-messages; `relay-done` completes the
   call with one timeline entry and the summary job; rotate, 64105 and
   64110; transfer, no-answer, return to the assistant, second no-answer to
   voicemail. Throwaway workspace, deleted at the end.
2. `GET /api/twilio/relay` on the deployment (no Upgrade header) prints a
   probe line; `node scripts/relay-probe.ts` opens a real `wss://` client
   with a minted token — see plan §8.4. On Vercel the expected answer is
   **HTTP 403**: the probe carries no `X-Twilio-Signature` and
   `VOICE_RELAY_ALLOW_UNSIGNED` is ignored there, so the refusal is the
   proof that the signature check is live (the probe's `?probe=1` keeps it
   out of `error_log`). The `end{failed: "setup mismatch"}` answer is only
   reachable through the dev server (`npm run relay:dev` with
   `VOICE_RELAY_ALLOW_UNSIGNED=1`). `upgradeWebSocket: unavailable` on a
   plain GET says nothing; the context carries it only on an Upgrade
   request. A signature that does not verify on a real call is filed in
   `error_log` (`where='relay'`) with the request URL, the forwarded headers
   and every candidate URL, and shows on the calls card as the last relay
   error.
3. `npx --yes tsx scripts/voice-timing.ts [--workspace <slug>]` — five
   canned prompts through `runVoiceTurn` against the workspace's real model,
   in a throwaway copy; p50 above 4 s means switch the model before the
   first call.
4. First real call on a throwaway number in a test workspace, mode `always`,
   `maxMinutes` 2, watched with
   `select status, turn_count, rotate_count, state from voice_sessions order by started_at desc limit 1`;
   then one transfer, one forced rotate (preview with `FUNCTION_MAX_DURATION_S=60`),
   two simultaneous calls.
