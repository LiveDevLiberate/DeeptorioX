# Bilibili live danmaku + persona interaction host (Phase A)

The live host is a **second, separate agent** next to the gameplay agent. It is
read-only towards Bilibili: it reads public danmaku, never sends messages back.
When the TTS voice is idle it answers one recent viewer message with a short
spoken reply, using the gameplay agent's current state as context.

## Data flow

```
Bilibili live WebSocket
   │  DANMU_MSG / SUPER_CHAT_MESSAGE
   ▼
manager LiveChatService (ring buffer, seq)
   ├─ GET /api/agent/live-chat?after_seq=…     (read-only observation)
   ├─ GET /api/live/status                     (operator status)
   └─ LiveHost (separate agent, persona)
        │  reads: new danmaku + gameplay run context + voice.json
        │  writes: replies.jsonl (one short line)
        ▼
scripts/narrate.ps1 -Live
   ├─ narrates gameplay thoughts while narration is flowing
   └─ speaks queued persona replies only when narration is idle
```

The gameplay agent never sees danmaku by default; if you want it to, read
`GET /api/agent/live-chat` from the agent prompt in a future phase. Keeping the
two agents separate protects benchmark timing and avoids prompt-injection from
viewers steering gameplay.

## Setup

1. **Node WebSocket**: the manager needs the WHATWG `WebSocket` global.
   Node 22+ has it; on Node 20 start the manager with
   `NODE_OPTIONS=--experimental-websocket`.
2. **Connect a room** (short room id from `live.bilibili.com/<id>` works):
   ```bash
   python3 factorio.py live-connect --room 21452505
   python3 factorio.py live-status
   ```
   or set `BILIBILI_ROOM_ID` in `.env` to auto-connect at manager start. A
   `BILIBILI_COOKIE` with `buvid3`/`SESSDATA` improves reliability when Bilibili
   risk-control rejects anonymous requests.
3. **Write the AI-streamer persona** (required for a good stream): copy
   [`live-persona.example.md`](live-persona.example.md) to
   `.autorio/live/persona.md` and adjust it. The manager falls back to a generic
   AI-streamer persona when the file is missing. The host speaks *as* the AI
   game streamer defined by this file, so the persona is a hard cap: it cannot
   claim a human identity, invent history/opinions/promises/private data, or
   exceed an AI game streamer. The example ships the DeepSeek 小鲸鱼 Factorio
   AI-streamer persona.
4. **Start the interaction host**:
   ```bash
   python3 factorio.py live-host --action start
   ```
   or set `AUTORIO_LIVE_HOST=1` so it starts with the danmaku bridge.
5. **Start narration with live replies** (Windows):
   ```powershell
   .\scripts\narrate.ps1 -Live
   ```
   `-Live` writes `.autorio\live\voice.json` (idle/speaking heartbeat) and tails
   `.autorio\live\replies.jsonl`. Replies are spoken only when no gameplay
   narration has been spoken for `-IdleMs` (default 1200 ms). Use
   `-LiveDataDir` when `AUTORIO_DATA_DIR` differs from the repo `.autorio`.

## Reply backend

By default the host calls the DeepSeek Harness headless profile
(`dsh --profile headless --json`) with `AUTORIO_LIVE_MODEL` or the normal DSH
model settings, reusing `DEEPSEEK_API_KEY`/`$DSH_HOME/.credentials.yaml`.

Set `AUTORIO_LIVE_AGENT_CMD` to pipe the prompt into any command instead; the
last non-empty stdout line is used as the reply:

```bash
AUTORIO_LIVE_AGENT_CMD="my-llm --short"
```

Each reply spawns one short-lived child process; host ticks are coalesced while
a reply is in flight. `AUTORIO_LIVE_MIN_INTERVAL_SECONDS` (default 15 s) and
`AUTORIO_LIVE_REPLY_MAX_CHARS` (default 60) bound the chatter.

## Safety

- **Identity**: the host speaks as the AI game streamer defined by the persona
  file — an AI character, never a human. The prompt places identity/injection
  rules *before* the persona; replies that fake a human identity or leak the
  hidden instructions are replaced by a safe fallback line.
- **Prompt injection**: danmaku is untrusted text. The host ignores requests to
  change identity/rules, execute game actions or reveal prompts. It never calls
  gameplay tools and never posts to Bilibili.
- **Length/TTS**: replies are stripped of markdown/URLs/emoji/control chars and
  capped before they reach the narrator.
- **Privacy**: only the message text, display name and uid are kept in a
  500-message in-memory ring buffer; replies are written to
  `<data-dir>/live/replies.jsonl` for the narrator.
- **Evaluation**: benches keep the gameplay agent isolated from chat. The live
  host runs only when you enable it.

## API / CLI

| Purpose | HTTP | CLI |
| --- | --- | --- |
| Connect a room | `POST /api/live/connect {room_id}` | `live-connect --room <id>` |
| Disconnect | `POST /api/live/disconnect` | — |
| Status | `GET /api/live/status` | `live-status` |
| Read danmaku | `GET /api/agent/live-chat?after_seq=…` | `live-chat --after-seq N` |
| Read replies | `GET /api/live/replies?after_seq=…` | `live-replies` |
| Start/stop host | `POST /api/live/host/start|stop` | `live-host --action start|stop` |
| Queue a manual reply | `POST /api/agent/live-reply {text}` | — |

Python client methods: `live_status()`, `live_chat(after_seq=…)`,
`live_replies(after_seq=…)`, `live_connect(room)`, `live_disconnect()`,
`live_host(action)`.
