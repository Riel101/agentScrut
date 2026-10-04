# AgentScrut — AI Voice Interviewer

An AI agent that **interviews candidates for any job role over a phone call** and scores their
knowledge and experience. A second **Hiring Assistant** agent then sends the owner a short
performance summary on **WhatsApp after every interview**, and answers the owner's questions
about any candidate (e.g. "who are my top 3?", "how did Ada do on the technical questions?").

Built on the **BimpeAI Agent Console SDK** (`@bimpeai/sdk`), with a **React + Tailwind** frontend
and a **Node.js + TypeScript** backend.

---

## How it works

```
┌────────────┐   REST + SSE   ┌──────────────────────────────┐   @bimpeai/sdk   ┌──────────────────────┐
│  React UI  │ ◄────────────► │  Node/Express API (this repo)│ ◄──────────────► │  BimpeAI Agent Console│
│ Tailwind   │                │  interview orchestrator      │                  │  · Interviewer agent  │
└────────────┘                │  evaluator · summaries       │                  │  · Evaluator agent    │
                              └──────────────────────────────┘                  │  · Hiring Assistant   │
                                                                                 │  · Telephony channel  │
                                                                                │  · WhatsApp channel   │
                                                                                └──────────────────────┘
```

1. **Provision** — the backend creates three BimpeAI agents via the SDK:
   - **Interviewer** (`Interview Copilot`) — telephony voice agent that runs the screening call.
   - **Evaluator** (`Interview Evaluator`) — scores the transcript against the role and returns strict JSON.
   - **Hiring Assistant** (`Hiring Assistant`) — a WhatsApp agent that reports each result and answers
     the owner's questions from a *Candidate Dossiers* knowledge base.
2. **Create an interview** — the company supplies a job title, job description, key requirements and
   the candidate's phone number.
3. **Specialise & call** — immediately before dialing, the interviewer workflow's `system_prompt`
   is rewritten for that specific role (time-boxed to the 5-minute cap, voice-first rules).
   `bimpe.calls.make(...)` places the outbound call.
4. **Monitor** — the backend polls `calls.retrieve(...)`, streams new transcript turns to the UI over
   SSE, and enforces the maximum call duration.
5. **Score & summarise** — when the call ends, the transcript is sent to the **evaluator agent** for a
   structured scorecard (overall score, dimensions, strengths, concerns, next step). The backend then
   composes a short summary, sends it to the owner on WhatsApp from the **Hiring Assistant**, and
   refreshes that agent's knowledge base so the owner can ask follow-up questions in the same chat.

---

## Requirements

- **Node.js 24+** — the BimpeAI SDK declares `engines: node >= 24`. This repo ships an `.nvmrc`.
  ```bash
  nvm install 24 && nvm use 24
  ```
- A **BimpeAI account + API key** (`sk_...`). Keys and the base URL go in `.env`.

---

## Setup

```bash
# 1. Node 24
nvm install 24 && nvm use 24

# 2. Install workspace dependencies
npm install

# 3. Configure secrets — .env already contains BIMPE_API_KEY / KROS_API_KEY
cp .env.example .env      # only if you need a fresh file; then fill in BIMPE_API_KEY

# 4. Provision the BimpeAI agents and telephony number
npm run dev               # terminal A: API on :8787
npm run dev:web           # terminal B: UI on :5173
```

Then open <http://localhost:5173>, click **Provision agents** (or `POST /api/setup`).
For a single-origin production run:

```bash
npm run build     # builds server (tsc) and web (vite -> web/dist)
npm start         # Express serves the API and the built UI on :8787
```

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `BIMPE_API_KEY` | — | **Required.** BimpeAI team key (`sk_...`). |
| `BIMPE_BASE_URL` | `https://api.bimpe.ai` | API host. |
| `KROS_API_KEY` | — | Optional KrosAI fallback key. |
| `VOICE_PROVIDER` | `bimpe` | `bimpe` (default) or `kros`. |
| `INTERVIEW_MAX_SECONDS` | `300` | Hard cap on call length (5 minutes). |
| `INTERVIEW_PASS_THRESHOLD` | `70` | Score at/above which a candidate is considered qualified. |
| `INTERVIEWER_AGENT_NAME` / `EVALUATOR_AGENT_NAME` / `ASSISTANT_AGENT_NAME` | see `.env.example` | Stable agent names used for idempotent provisioning. |
| `OWNER_WHATSAPP` | — | Owner's WhatsApp number (E.164) that receives post-interview summaries and can message the Hiring Assistant. |
| `WHATSAPP_TEST_CHANNEL` | `true` | Use the BimpeAI test WhatsApp channel (owner must text first with `start <CODE>`). Set `false` for a production channel. |
| `PHONE_*` | see `.env.example` | Telephony number provisioning request details. |

---

## Platform prerequisites you must complete in BimpeAI

The SDK can only drive what the platform exposes. A few things need attention on the
BimpeAI side (the backend promotes all agents to `live` automatically at setup):

1. **Telephony number** — if no number is linked, the backend files a provisioning request
   (`phoneNumbers.requests.create`), but **BimpeAI fulfils it asynchronously**. Until a number is
   linked to the interviewer agent, `calls.make` cannot place real calls.
2. **Voice channel must be enabled** — the interviewer agent has a `voice` channel and a `telephony`
   channel. If `voice` is `paused`, outbound calls are accepted but **stay queued** and the candidate's
   phone never rings. This is a dashboard setting; the SDK only exposes `channels.list` (read-only).
   The app surfaces the warning on the status panel and `GET /api/status`.
3. **Assistant WhatsApp channel** — the Hiring Assistant sends the post-interview summary and
   answers the owner's questions over WhatsApp, using BimpeAI's **test** channel by default
   (`WHATSAPP_TEST_CHANNEL=true`). The test channel only responds once the owner has texted
   first: send `start <CODE>` to the test number shown in the status panel (this both opts the
   number in and opens WhatsApp's session window for the reply). Set `OWNER_WHATSAPP` to the
   owner's E.164 number. For a persistent connection with no opt-in step, connect a **production**
   WhatsApp Business channel to the assistant agent in the BimpeAI dashboard and set
   `WHATSAPP_TEST_CHANNEL=false`.
4. **Call transcription** — in the current API build, live **telephony** calls do **not** surface
   turns through `calls.retrieve().conversation_logs` *or* the matching telephony conversation
   (verified live: transcript endpoints return 404, and the telephony conversations hold zero
   messages even after answered, multi-minute calls). The backend already merges **every**
   transcript source the platform exposes — call logs plus all matching telephony/test-telephony
   conversations, with tolerant parsing of alternate message shapes — and will pick transcription
   up automatically once it is available. Until then, a completed call with no transcript can still
   be scored by pasting it into the **Live transcript** panel or calling
   `POST /api/interviews/:id/transcript`. During each call the backend additionally holds the
   conversation's live message stream open, so if the platform ever publishes (but doesn't persist)
   call turns, they still appear on screen.

Every interview also has a **Simulate** button that injects a realistic transcript so the scoring +
summary pipeline is fully demoable without a live call.

---

## Troubleshooting

**"I started a call but nothing rang."**

Run the diagnostics against your account:

```bash
cd server
npx tsx src/scripts/diagnose.ts          # agents, channels, numbers, recent calls
npx tsx src/scripts/probe-call.ts        # full detail + transcript for the latest call
npx tsx src/scripts/probe-call.ts <callId>
```

Check, in order:

1. **Agent status is `live`** — re-run `POST /api/setup`; it promotes both agents to `live`.
2. **`voice` channel is `enabled`** (not `paused`) — enable it in the BimpeAI dashboard. While paused,
   call status stays `queued`.
3. **A number is linked to the interviewer agent** — `diagnose.ts` prints the `agent_id`.
4. **The destination number is correct and reachable** (E.164, e.g. `+234…`) and the phone is on.
5. Review `status`, `error_reason`, and `end_reason` from `probe-call.ts`; `queued` for more than a
   few seconds means the platform is not dispatching (usually item 2).

**"The call connected, but the transcript is empty and no scorecard appeared."**

This is the telephony-transcription gap: both `calls.retrieve().conversation_logs` and the telephony
conversation return no turns for live calls. After the call ends the backend waits
`INTERVIEW_TRANSCRIPT_GRACE_SECONDS` (default **45s**) for either source to populate, then shows
*BimpeAI returned no transcript* and skips scoring. Workarounds:

1. Paste the transcript into the detail view and click **Import & score** (it understands
   `Interviewer:` / `Candidate:` lines, `[timestamp]` prefixes, and bare text).
2. `POST /api/interviews/:id/transcript` with `{ "transcript": "Interviewer: …\nCandidate: …" }`.
3. Ask BimpeAI to enable telephony call transcription. Draft:

> Hi BimpeAI team — we're building an interview product on `@bimpeai/sdk` (agent + telephony channel).
> Outbound calls complete and connect, but `GET /agents/{id}/calls/{callId}` returns
> `conversation_logs: []` and the matching `telephony` conversation has `messages: []`, while `voice`
> and `whatsapp` conversations store messages normally. We checked every agent, every channel
> (`telephony`, `test_telephony`, `voice`), all sort/limit variants of `messages.list`, and the live
> conversation stream during a call — no call turns are exposed anywhere. How do we **enable call
> transcription** for telephony, and is it delivered via `conversation_logs`, the telephony
> conversation, or a webhook? If there is a transcript webhook, please share the payload shape and
> how to configure it.
>
> Separately, one answered 40s call ended with `end_reason: "tts_hard_failure"` — please advise what
> causes this and whether it indicates a problem with the voice pipeline on our agent.

---

## API

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/health` | Liveness. |
| `GET` | `/api/status` | Provisioning snapshot (agents, numbers, config). |
| `POST` | `/api/setup` | Create/repair agents + phone number (idempotent). |
| `GET` | `/api/agents/:role/channels` | List channels on the `interviewer`/`evaluator`/`assistant` agent. |
| `GET` | `/api/interviews` | List interviews. |
| `POST` | `/api/interviews` | Create an interview. |
| `GET` | `/api/interviews/:id` | Interview detail (transcript, scorecard, summary). |
| `GET` | `/api/interviews/:id/events` | **SSE** stream of progress (replays history). |
| `POST` | `/api/interviews/:id/start` | Place the outbound call. |
| `POST` | `/api/interviews/:id/redial` | Clear a finished attempt and call the candidate again. |
| `POST` | `/api/interviews/:id/simulate` | Inject a synthetic transcript, then score + summarise. |
| `POST` | `/api/interviews/:id/evaluate` | Re-run the evaluator agent + summary. |
| `POST` | `/api/interviews/:id/transcript` | Import a transcript (`transcript` text or `turns[]`), then score + summarise. |
| `POST` | `/api/interviews/:id/summary` | (Re)send the Hiring Assistant's summary to the owner. |
| `POST` | `/api/interviews/:id/cancel` | Force-end monitoring and mark the interview expired. |

---

## Latency notes

Voice latency is dominated by the platform's real-time pipeline; the code keeps its own overhead low:

- The timeout/poll interval for call state is **1.5 s**, and new transcript turns stream to the UI over
  **SSE** rather than full-page refreshes.
- Agent provisioning happens **once**; per interview we only rewrite the workflow prompt (one small
  request) immediately before dialing.
- The evaluator runs **after** the call, so it never adds latency to the conversation.
- The interviewer prompt is deliberately terse and instructs short spoken turns.

---

## Deliberate demo-scope limitations

- **One live call at a time.** A single BimpeAI agent owns one workflow, and the workflow prompt is
  specialised per role. Concurrent interviews for different roles would clash, so `start` returns
  `409` while another call is `calling`/`in_progress`. To parallelise, provision one interviewer
  agent per role.
- **5-minute cap.** There is no `max_duration` field on `calls.make` in the SDK. The cap is enforced
  in two layers: the prompt budgets the call to ~4 minutes, and the backend flags/finalises at
  `INTERVIEW_MAX_SECONDS`. The orchestrator cannot force-hang-up a live carrier call through the
  typed SDK.
- **Scoring fallback.** If the evaluator agent is unreachable or returns non-JSON, a transparent
  heuristic scorecard is used and labelled `heuristic-fallback`, so the pipeline never dead-ends.
- **No-answer handling.** A call that is never answered fails after
  `INTERVIEW_RING_TIMEOUT_SECONDS` (default **75s**) so the single-call guard is released. The
  operator can also press **Cancel call** on an active interview. BimpeAI exposes no hangup endpoint,
  so the carrier leg may remain `ringing` on the platform after the app has moved on.
- **Storage** is a JSON file (`data/db.json`, gitignored) — fine for a demo; swap for a real database
  for production.

---

## Tech stack

- **BimpeAI TypeScript SDK** — agents, workflows, telephony calls, conversations, knowledge bases.
- **KrosAI** — optional telephony fallback adapter (`VOICE_PROVIDER=kros`).
- **Node.js 24 + TypeScript + Express + Zod** — API, validation, orchestration.
- **Server-Sent Events** — live transcript and status.
- **React 18 + Vite + Tailwind CSS** — operator dashboard.
- **npm workspaces** — `server` and `web` in one repo.

## Project layout

```
server/src
  index.ts                 Express app (also serves the built UI)
  env.ts / db.ts / logger.ts / types.ts / prompts.ts / events.ts / util.ts
  routes/system.ts         health, status, setup, channels
  routes/interviews.ts     CRUD, start/simulate/evaluate/summary, SSE
  services/provisioning.ts create + wire BimpeAI agents and phone number
  services/interviews.ts   orchestration: call, poll, finalise, score, summarise
  services/voice.ts        VoiceProvider (Bimpe default, KrosAI fallback)
  services/evaluator.ts    evaluator agent call + JSON parsing + heuristic fallback
  services/assistant.ts    Hiring Assistant summaries + candidate knowledge base
web/src
  App.tsx                  dashboard shell
  api.ts                   typed API + SSE subscription
  components/               form, detail, transcript, scorecard, status, ui
```
