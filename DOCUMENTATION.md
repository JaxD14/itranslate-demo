# iTranslate Demo -- How I'd Build This

## What the device needs to do

iTranslate's device is a handheld, battery-powered unit with WiFi/cellular but no GPU. It needs to:

- Capture speech from a built-in mic
- Transcribe it in real time
- Detect which language is being spoken (no manual switching)
- Translate into the other person's language
- Speak the translation out loud

No on-device compute means the entire pipeline runs in the cloud. The device is a thin client -- it streams audio out, gets results back.

---

## Architecture

The device connects over WiFi or cellular to a backend service. The backend orchestrates three API calls in sequence:

```
Device / Client          Backend Service              Cloud APIs
[Mic] ──audio──>  [WebSocket Server]  ──audio──>  [AssemblyAI STT]
[Speaker] <──mp3──  [Orchestrator]  <──text────  [Translation API]
                                      <──mp3────  [TTS API]
```

- **Device** captures audio, streams it to the backend, plays back TTS audio
- **Backend** relays audio to AssemblyAI, waits for a finalized transcript, translates it, generates TTS, and sends the result back
- **API keys live on the backend**, never on the device

### How the demo simulates this

I don't have the physical hardware, so I used a web browser to stand in for the device:

| On the real device | In the demo |
|---|---|
| Built-in mic | `getUserMedia()` (browser asks for mic permission) |
| On-device audio encoder (likely Opus) | AudioWorklet converting to raw PCM16 at 16kHz |
| Built-in speaker | HTML5 `<audio>` element |
| WiFi/cellular to remote backend | localhost WebSocket |

The backend and all cloud API calls are identical in both cases. Swapping in the real device is a client-side change -- the backend stays the same.

---

## The pipeline, step by step

### 1. Audio capture

The browser (standing in for the device mic) captures mono audio at 16kHz. An AudioWorklet processor accumulates samples into ~200ms chunks (3,200 samples), converts from float32 to signed 16-bit PCM, and sends each chunk to the backend as a binary WebSocket message.

I also enabled echo cancellation, noise suppression, and auto gain control on the mic input. The real device would likely have its own DSP for this, but the browser gives us these for free.

### 2. Streaming to AssemblyAI

The backend opens a WebSocket to AssemblyAI's streaming endpoint and forwards the audio chunks as they arrive. The connection uses:

- **Model:** `universal-streaming-multilingual` -- handles multiple languages and detects which one is being spoken
- **`language_detection: true`** -- so we don't have to specify the language upfront
- **`format_turns: true`** -- gives us punctuated, capitalized final transcripts
- **End-of-turn settings** (all configurable):
  - `end_of_turn_confidence_threshold`: 0.4 (how sure the model needs to be that the speaker is done)
  - `min_end_of_turn_silence_when_confident`: 400ms
  - `max_turn_silence`: 1280ms (hard cap on silence before forcing end-of-turn)
- **`keyterms_prompt`** (optional) -- domain-specific words to boost accuracy

### 3. Handling transcripts

AssemblyAI streams back `Turn` messages with partial transcripts as the person speaks. Each message includes:

- The current transcript text
- Whether this is an end-of-turn
- Whether it's been formatted (punctuation/capitalization applied)
- The detected language and a confidence score

I forward every partial transcript to the client immediately so it feels real-time. But I only kick off translation once I get a **formatted end-of-turn** -- because with `format_turns=true`, AssemblyAI sends two end-of-turn messages per turn (one raw, one formatted). If you don't check for `turn_is_formatted`, you'll translate and TTS the same sentence twice.

### 4. Translation

Once I have a final transcript, I figure out the target language:

- If detected language matches Language A, translate to Language B
- Otherwise, translate to Language A

Translation uses OpenAI's `gpt-4o-mini` with a system prompt that says "you are a professional translator, return only the translated text." Temperature is set to 0.3 to keep output consistent.

### 5. Text-to-speech

The translated text goes to OpenAI's `tts-1` model. Each language maps to a different voice (English = "alloy", Spanish = "nova", French = "shimmer", etc.) so the output doesn't all sound the same. The audio comes back as MP3, gets base64-encoded, and is sent to the client for playback.

---

## Edge cases

### WiFi/network disconnection

- **Client to backend:** if the WebSocket drops, the frontend automatically retries every 2 seconds and updates the UI to show "Disconnected"
- **Backend to AssemblyAI:** if AssemblyAI's WebSocket closes, the backend notifies the client with a status message
- **Client goes away (tab closed, device turned off):** the backend sends a `Terminate` message to AssemblyAI to cleanly end the session (so it doesn't keep running and billing), then closes the connection. An `isCleaningUp` flag prevents noisy error cascading during teardown.
- **What I'd add in production:** exponential backoff on reconnects, local audio buffering during outages, and a connection quality indicator

### End-of-turn detection

This is the hardest UX problem for a translation device. Cut off too early, you get half a sentence. Wait too long, it feels sluggish.

I exposed AssemblyAI's three tuning knobs -- confidence threshold, minimum silence, and max silence -- so they can be adjusted per use case. In the demo the confidence threshold is a UI slider. On the real device this would probably be a user setting or auto-tuned based on ambient noise.

### Double end-of-turn messages

With `format_turns=true`, each completed turn produces two end-of-turn messages. The code checks for both `end_of_turn === true` AND `turn_is_formatted === true` before translating. Without this, every utterance would get translated and spoken twice.

### TTS audio overlap

If someone speaks fast or the network is slow, multiple translations can arrive while the previous one is still playing. The client queues TTS audio clips and plays them one at a time. When a clip finishes (`onended`), it triggers the next. If playback fails (e.g., browser autoplay policy), it skips to the next clip instead of getting stuck.

### Session expiration

AssemblyAI returns an `expires_at` timestamp when a session starts. The demo displays this. In production, the backend should monitor this and start a new session before it expires.

### Mic permission (demo-specific)

If the browser denies mic access, the demo catches the error and shows "Mic access denied." This wouldn't apply to the real device (hardware mic is always available), but it matters for the browser simulation.

### Errors at any stage

Translation or TTS failures are caught and sent to the client as error messages. The UI displays them. Nothing crashes silently.

---

## What I'd improve for production

- **Opus encoding** instead of raw PCM16 -- significantly less bandwidth, important on cellular. AssemblyAI supports it.
- **Streaming TTS** -- start playback before the full MP3 is generated. OpenAI's API supports this.
- **Dedicated translation API** (DeepL, Google Translate) instead of GPT-4o-mini for high-volume production. Faster and cheaper at scale.
- **Reconnection with session persistence** -- buffer audio locally during network blips, resume seamlessly.
- **Connection quality monitoring** -- measure latency and packet loss, switch from WiFi to cellular if degrading.

---

## Running the demo

```bash
npm install
cp .env.example .env   # add your AssemblyAI + OpenAI keys
npm run build
npm start              # opens on http://localhost:3000
```
