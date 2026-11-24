# White-label AI receptionist

An AI assistant that answers a business's phone line. It talks to the caller
over Twilio ConversationRelay (speech in, text to the model, speech out),
books, reschedules and cancels calls on the calendar, takes messages, saves a
name and an e-mail, texts a link with consent, transfers to a person, and
files everything on the contact's timeline. It follows the caller into
Spanish, Portuguese, French, German or Italian, and it works with Claude,
OpenAI, Gemini, DeepSeek or any OpenAI-compatible model.

## Read this first: it does not run alone

This repository is the receptionist's source, published on its own so it can
be read, reviewed and discussed without the rest of the CRM around it. It is
**not a standalone service**. The receptionist books on the CRM's calendar,
looks callers up in the CRM's contacts and writes to the CRM's database, so
the files here import modules that live in
[whitelabel-crm](https://github.com/clwzrd/whitelabel-crm).

To use the receptionist, deploy `whitelabel-crm`: it ships with it, switched
on per workspace in Calls → Call settings → "AI receptionist". The paths in
this repository are the same as in the CRM, and this copy follows that one.

Making it a service of its own, talking to any CRM over HTTP, is a possible
next step and has not been done.

## What is here

| Path | What it is |
| --- | --- |
| `src/lib/voice/relay/session.ts` | The session engine: turns, fillers, language switching, rotation before the function's time limit |
| `src/lib/voice/relay/admit.ts`, `token.ts`, `socket.ts`, `route.ts` | The WebSocket gate: the CRM's own HMAC token and Twilio's signature |
| `src/lib/voice/relay/readiness.ts` | One function that decides whether a call may be connected, and says why not |
| `src/lib/voice/relay/transfer.ts`, `close.ts`, `summary.ts`, `notify.ts` | Transfer to a person, closing the call, the summary and the team notice |
| `src/lib/voice/relay/brief.ts`, `spoken.ts` | What the model is told about the caller; spoken e-mail addresses and numbers |
| `src/lib/ai/voice.ts`, `voice-tools.ts` | The voice turn and the tools the model may call |
| `src/lib/ai/provider.ts`, `providers/`, `presets.ts` | The model layer: Anthropic's Messages API and the OpenAI chat-completions shape, and the vendor list |
| `src/lib/voice/twiml.ts`, `settings.ts`, `store.ts`, `reception.ts` | TwiML, per-workspace settings and call storage |
| `src/pages/api/twilio/relay.ts` | The route Twilio's socket connects to |
| `scripts/` | Its proofs and its local socket server (`check-relay.ts`, `relay-dev.ts`, `relay-probe.ts`, `voice-timing.ts`) |

[RECEPTIONIST.md](RECEPTIONIST.md) explains the modes, voice and language
handling, readiness, how a call runs and is filed, cost, and the Twilio side.

## What has and has not been checked

The receptionist's unit tests run in `whitelabel-crm`, where they pass. In the
white-label copy, the model layer was exercised against a real model and the
hand-off to a person was tested end to end. A live phone call through Twilio
was not placed against the white-label copy.

## Contributing

Issues and questions are welcome here. Code changes go to
[whitelabel-crm](https://github.com/clwzrd/whitelabel-crm), where the code runs
and is tested: see `CONTRIBUTING.md`.

## Licence

GNU Affero General Public License v3.0. See `LICENSE`.
