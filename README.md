# White-label AI receptionist

A service that answers a business's phone line. It talks to the caller over
Twilio ConversationRelay (speech in, text to the model, speech out), books,
moves and cancels appointments, takes messages, transfers to a person, and
hands the finished call to your CRM. It follows the caller into Spanish,
Portuguese, French, German or Italian, and it works with Claude, OpenAI,
Gemini, DeepSeek or any OpenAI-compatible model.

It runs by itself: one Node process, no framework. The CRM is behind one small
interface, so it works with
[whitelabel-crm](https://github.com/clwzrd/whitelabel-crm) out of the box, with
an in-memory CRM for trying it, and with your own CRM once you implement that
interface.

## Try it in a minute, with no phone

```bash
npm install
AI_PROVIDER=openai AI_MODEL=<a model id> AI_API_KEY=<key> \
  npm run try -- "Hi, I'd like to book a call. I'm Dana Whitfield." "The first one works." "That's all, bye."
```

Each argument is something the caller says. The model you configured answers,
calling its tools against an in-memory CRM, and the script prints what it
said, which tools it used and what ended up booked. It is the quickest way to
see whether a model is good enough for the phone before a number is in front
of it.

## Run it on a real number

```bash
cp .env.example .env    # fill it in
npm start
```

1. Put the service somewhere Twilio can reach over https, and set `PUBLIC_URL`
   to that address. For local work, a tunnel such as ngrok is enough.
2. In the Twilio console, set the phone number's voice webhook to
   `POST <PUBLIC_URL>/twilio/voice`.
3. Accept Twilio's AI/ML Features Addendum for the account. Until then every
   connection fails with error 64110 and the caller hears the fallback line.
4. Call the number.

| Route | What it is |
| --- | --- |
| `POST /twilio/voice` | Twilio's webhook for an inbound call. Answers with TwiML that connects the call to the socket. |
| `GET /twilio/relay` | The WebSocket ConversationRelay connects to. |
| `POST /twilio/done` | Where Twilio asks what to do when the relay ends: dial a person, reconnect, or hang up. The finished call is handed to the CRM here. |
| `GET /health` | Liveness. |

Every webhook must carry Twilio's signature, and the socket needs two proofs:
a short-lived token this service wrote into the TwiML, and Twilio's signature
over the socket's URL. `ALLOW_UNSIGNED=1` switches the signature check off for
local experiments and must never be set in production.

## Configuration

Everything is in the environment; `.env.example` lists every variable.

| Group | Variables |
| --- | --- |
| Service | `PUBLIC_URL`, `PORT`, `APP_SECRET` |
| Twilio | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` |
| Model | `AI_PROVIDER` (`anthropic`, `openai`, `google`, `deepseek`, `xai`, `mistral`, `groq`, `openrouter`, `ollama`) or `AI_BASE_URL` for any OpenAI-compatible endpoint; `AI_MODEL`; `AI_API_KEY` or the vendor's own variable |
| Voice | `PERSONA`, `GREETING`, `TTS_PROVIDER`, `VOICE`, `LANGUAGES`, `TRANSFER_TO`, `MAX_MINUTES`, `MAX_TURNS` |
| Business | `BUSINESS_NAME`, `BUSINESS_TIMEZONE`, `BUSINESS_HOURS`, `BUSINESS_KNOWLEDGE`, `APPOINTMENT_NAME`, `APPOINTMENT_MINUTES` |
| CRM | `CRM=memory` or `CRM=whitelabel` with `CRM_ORIGIN`, `CRM_CONNECTOR_API_KEY`, `CRM_CALENDAR_ID` |
| Storage | `DATABASE_URL` for Postgres; unset keeps live calls in memory |

The greeting always says the caller is talking to an AI assistant. If you write
your own in `GREETING`, keep that: callers expect it and several US states
require it. Language switching needs `TTS_PROVIDER=ElevenLabs`, the one
provider Twilio pairs with automatic language detection; on Amazon or Google
the line is English-only.

## Connecting a CRM

`src/crm/port.ts` is the whole contract: who is calling, which times are open,
book, move, cancel, leave a message, and file the finished call. Three rules
come with it: times are UTC instants, a taken slot throws `SlotTaken`, and a
method that cannot do its job throws so the assistant can say so and take a
message instead.

- **`CRM=memory`** (`src/crm/memory.ts`): a complete CRM held in the process.
  Weekdays, on the hour, 9 to 5. For trying the service and for the tests.
- **`CRM=whitelabel`** (`src/crm/whitelabel.ts`):
  [whitelabel-crm](https://github.com/clwzrd/whitelabel-crm) over its connector
  API, with an owner connector key from the CRM's Settings → API. Open times
  come from `/api/v1/connector/owner/calendar`, so the CRM needs a version that
  has that route.
- **Your own**: implement `CrmPort` and construct it in `src/server.ts`.

Whatever the model decides, `src/tools.ts` enforces the rules: a time is
booked only if the CRM offered it on this call and it is still open, a booking
needs a name on file, a caller who hid their number is never looked up, and a
transfer happens only when `TRANSFER_TO` is set.

## Where the pieces live

| Path | What it is |
| --- | --- |
| `src/engine/session.ts` | One call as a state machine: turns, fillers, interruptions, silence, language switching |
| `src/turn.ts`, `src/tools.ts` | The model turn, and the tools it may call |
| `src/ai/` | The model layer: Anthropic's Messages API and the OpenAI chat-completions shape |
| `src/crm/` | The CRM contract and its two implementations |
| `src/store/` | Live call state, in memory or in Postgres |
| `src/app.ts`, `src/server.ts` | The three entry points Twilio drives, and the HTTP and WebSocket front |
| `src/twilio.ts`, `src/engine/token.ts` | TwiML, Twilio's signature, the socket token |

The session engine came out of whitelabel-crm, where it has answered real
calls, and runs here unchanged with its original tests.

## What has and has not been checked

Checked: `npm test` (80 tests) and `npm run check`. The tests drive a whole
call with a scripted model and the in-memory CRM, from the ring to the booking
and the call on file; run the two stores through the same contract, Postgres
on a real Postgres engine in the process; check the whitelabel-crm adapter
against a fake CRM; and run the HTTP server and a real WebSocket on localhost.
The service starts and answers a signed webhook with valid TwiML.

Not checked: a live phone call through Twilio, the whitelabel-crm adapter
against a running CRM, and a conversation with a real model in this standalone
packaging. Treat the first real call as a trial: use a test number, set
`MAX_MINUTES=2`, and watch the log.

## Licence

GNU Affero General Public License v3.0. See `LICENSE`. Contributions are
welcome: see `CONTRIBUTING.md`.
