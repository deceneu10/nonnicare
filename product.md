# Nonnicare — AI Calling System: Product Documentation

> **Single point of truth.** Keep this file updated whenever any part of the system changes.

---

## What It Is

Nonnicare is an outbound AI phone-calling system that calls elderly people daily to check on them. The AI poses as **Silvia** — a friendly neighbour, not a doctor or assistant — and holds a warm, natural conversation in Romanian. If something concerning is mentioned (a fall, chest pain, confusion) Silvia acknowledges it and promises to notify a family member. The conversation transcript is logged after each call.

---

## High-Level Architecture

```
Trigger (n8n / manual HTTP call)
        │
        ▼
  [Node.js Server]  ──── REST ────▶  Twilio REST API
  (Express + WS)                        │
        │                               │  dials target phone
        │                               ▼
        │                         Phone rings / answered
        │                               │
        │                    Twilio fetches TwiML
        │◀────── POST /twilio/twiml ────┘
        │
        │  returns TwiML <Connect><Stream> pointing to wss://…/twilio/stream
        │
        ▼
  WebSocket /twilio/stream  ◀══════▶  Twilio Media Stream (g711 µ-law audio)
        │
        ▼
  [audio-bridge.js]  ◀══════▶  [OpenAI Realtime WebSocket]
                               wss://api.openai.com/v1/realtime
                               model: gpt-realtime-mini
                               voice: shimmer
```

Audio travels as **raw g711 µ-law (8 kHz) encoded as base64**, which is the native format for both Twilio Media Streams and the OpenAI Realtime API — no transcoding needed.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20 (Alpine Docker image) |
| HTTP server | Express 4 |
| WebSocket server | `ws` library (raw upgrade handling) |
| Telephony | Twilio (outbound calls + Media Streams) |
| AI model | OpenAI `gpt-realtime-mini` via Realtime API |
| Voice | `shimmer` (warm female voice) |
| Speech transcription | Whisper-1 (via OpenAI Realtime `input_audio_transcription`) |
| Logging | Console (structured, Docker/Dozzle-compatible) |
| Deployment | Docker container, exposed on port 3000 |
| Public URL | `https://old2call.myai-things.com` (Cloudflare tunnel) |

---

## Environment Variables (`.env`)

| Variable | Purpose |
|---|---|
| `TWILIO_ACCOUNT_SID` | Twilio account identifier |
| `TWILIO_AUTH_TOKEN` | Twilio auth token |
| `TWILIO_PHONE_NUMBER` | The caller ID shown to the elderly person (E.164) |
| `TARGET_PHONE_NUMBER` | Default number to call if not overridden in API body |
| `OPENAI_API_KEY` | OpenAI API key |
| `PUBLIC_URL` | Full public HTTPS URL of the server (used to build the TwiML WebSocket URL) |
| `PORT` | HTTP port (default `3000`) |
| `NODE_ENV` | `production` / `development` |

> **Note:** `PUBLIC_URL` must be reachable by Twilio without auth. The Cloudflare tunnel handles this.

---

## File Structure

```
elderly-calling/
├── server.js          — Express app + WebSocket server entry point
├── twilio-handler.js  — Twilio REST call initiation + TwiML generation
├── audio-bridge.js    — Bridges Twilio Media Stream ↔ OpenAI Realtime session
├── openai-realtime.js — OpenAI Realtime WebSocket session factory + system prompt
├── call-logger.js     — Logs call metadata + transcript to console (DB stub included)
├── package.json       — Dependencies
├── Dockerfile         — node:20-alpine, EXPOSE 3000
└── .env               — Secrets and config (not committed)
```

---

## API Endpoints

### `GET /`
Health check — returns system status, model, and telephony info.

### `GET /health`
Detailed health: uptime, memory, env variable presence check for Twilio and OpenAI.

### `POST /api/calls/initiate`
Triggers an outbound call.

**Request body (JSON):**
```json
{ "phone_number": "+40723456789" }
```
`phone_number` is optional — falls back to `TARGET_PHONE_NUMBER` env var.

**Response:**
```json
{
  "success": true,
  "callSid": "CA...",
  "to": "+40...",
  "from": "+1...",
  "status": "queued"
}
```

### `POST /twilio/twiml`
Called by Twilio when the recipient answers. Returns TwiML XML that opens the Media Stream WebSocket back to `wss://…/twilio/stream`.

### `WS /twilio/stream`
WebSocket endpoint. Twilio connects here and streams bidirectional g711 µ-law audio. The audio bridge relays it to/from the OpenAI Realtime session.

---

## Call Flow — Step by Step

1. **Trigger** — `POST /api/calls/initiate` is called (manually or by n8n automation).
2. **Twilio dials** — `twilio-handler.js` calls `client.calls.create(...)` via Twilio REST. Twilio dials the target phone number.
3. **Answer** — The target person answers. Twilio sends a `POST /twilio/twiml` request to our server.
4. **TwiML returned** — Server responds with:
   ```xml
   <Response>
     <Connect>
       <Stream url="wss://old2call.myai-things.com/twilio/stream" />
     </Connect>
   </Response>
   ```
5. **Media Stream opens** — Twilio upgrades to a WebSocket at `/twilio/stream` and starts sending audio frames (`event: media`) plus control events (`event: start`, `event: stop`).
6. **OpenAI session created** — `audio-bridge.js` receives the `start` event and calls `createOpenAIRealtimeSession()`, which opens a WebSocket to `wss://api.openai.com/v1/realtime?model=gpt-realtime-mini`.
7. **Session configured** — On `session.created`, the server sends the full `SESSION_CONFIG` (system prompt, voice, VAD settings, audio format). OpenAI responds with `session.updated`.
8. **Audio relay** — Every `media` frame from Twilio is forwarded to OpenAI via `input_audio_buffer.append`. Every `response.audio.delta` from OpenAI is forwarded back to Twilio as a `media` event.
9. **VAD (Voice Activity Detection)** — OpenAI handles turn detection server-side (`server_vad`). When the caller stops speaking, OpenAI generates a response automatically.
10. **Transcript** — `response.audio_transcript.delta` events build up `accumulatedTranscript` (Silvia's words). `conversation.item.input_audio_transcription.completed` events log what the caller said (via Whisper-1).
11. **Call ends** — Twilio sends `event: stop`, triggering `teardown()`. The OpenAI WebSocket is closed and `logCall()` is called with the full transcript and duration.

---

## System Instruction (AI Persona)

The system instruction is set in `openai-realtime.js` inside `SESSION_CONFIG.session.instructions`. It is sent to OpenAI immediately after the session is created.

### Persona
Silvia — a friendly neighbour who calls every day. **Not a doctor, not an assistant, not a robot.** Warm and human.

### Core Behavioural Rules

| Rule | Detail |
|---|---|
| **Short replies** | Max 1–2 sentences per turn. Never longer. |
| **No repetition** | Never ask the same question or use the same phrase twice in a call. |
| **No interrogation** | Max 2–3 questions per topic per call. |
| **Natural language** | Uses "mda", "aoleu", "păi", "hai că", "ia spune" — not formal speech. |
| **No medical advice** | Never suggest treatments, pills, or diagnoses. |
| **2-question rule for illness** | Ask once (interest), ask again (severity check), then stop and promise to notify family. Jump straight to "notifying family" if fall/chest pain/confusion/breathing issues are mentioned. |
| **Natural opener** | Opens with a concrete question (food, weather, TV, going outside) — never "how do you feel?" as the opener. |
| **Language** | Romanian only. |

### Forbidden Phrases
- "sunt aici să te ascult / să te ajut"
- "poate ar fi bine să vorbești cu un membru al familiei"
- "ce ai mai încercat" (after already asking about the problem)
- "ai vreo idee ce ai putea face"
- Any repeated question in a different form

### VAD Tuning (for elderly voices)
```js
turn_detection: {
  type: 'server_vad',
  threshold: 0.45,           // Lowered — elderly voices are softer
  prefix_padding_ms: 400,    // Extra padding to catch soft onsets
  silence_duration_ms: 900,  // Enough pause time; 700 too fast, 1200 too slow
}
```

### Audio Format
- Input: `g711_ulaw` (from Twilio, no re-encoding)
- Output: `g711_ulaw` (back to Twilio, no re-encoding)
- Voice: `shimmer`
- Transcription: `whisper-1`

---

## Logging

Each call logs to stdout (captured by Docker / Dozzle):

- Call start with target number
- Each caller utterance (Whisper-1 transcription)
- Each AI response transcript (accumulated from deltas)
- Call summary at end: SID, to/from numbers, duration, full transcript, timestamp

**No database write is currently implemented.** `call-logger.js` contains the PostgreSQL schema and a commented-out insert stub ready to be activated:

```sql
CREATE TABLE call_logs (
  id               SERIAL PRIMARY KEY,
  call_sid         TEXT,
  to_number        TEXT,
  from_number      TEXT,
  duration_seconds INTEGER,
  transcript       TEXT,
  status           TEXT,
  created_at       TIMESTAMPTZ DEFAULT now()
);
```

---

## Deployment

### Docker
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 3000
CMD ["npm", "start"]
```

Run directly or via the root `docker-compose.yml` in `ai-server-setup`. The container must have the `.env` file mounted or env vars injected.

### Public Access
The server is exposed at `https://old2call.myai-things.com` via a Cloudflare tunnel (no port forwarding needed). This URL is what Twilio calls back to fetch TwiML and open the Media Stream WebSocket.

---

## Known Limitations / Future Work

- **No DB logging yet** — transcripts are console-only. PostgreSQL insert stub is in `call-logger.js`.
- **No scheduling** — calls are triggered manually or via n8n. No built-in cron.
- **Single target** — `TARGET_PHONE_NUMBER` env var is the default; `POST /api/calls/initiate` accepts an override but there's no contact list management.
- **No family alert action** — Silvia says she'll notify family, but no actual notification is sent yet (email, SMS, or n8n webhook pending).
- **Trial Twilio account** — target numbers must be verified in the Twilio console if on a trial account.
