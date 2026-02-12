import express from "express";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import path from "path";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const ASSEMBLYAI_API_KEY = process.env.ASSEMBLYAI_API_KEY || "";
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "" });

// Serve static files from public/
app.use(express.static(path.join(__dirname, "../public")));

// Health check endpoint
app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    assemblyai: ASSEMBLYAI_API_KEY ? "configured" : "missing",
    openai: process.env.OPENAI_API_KEY ? "configured" : "missing",
  });
});

// Language display names
const LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  es: "Spanish",
  fr: "French",
  de: "German",
  it: "Italian",
  pt: "Portuguese",
};

// Map languages to OpenAI TTS voices
const VOICE_MAP: Record<string, string> = {
  en: "alloy",
  es: "nova",
  fr: "shimmer",
  de: "echo",
  it: "fable",
  pt: "onyx",
};

interface SessionConfig {
  languageA: string;
  languageB: string;
  sampleRate: number;
  endOfTurnConfidence: number;
  minEndOfTurnSilence: number;
  maxTurnSilence: number;
  keytermsPrompt: string[];
}

const DEFAULT_CONFIG: SessionConfig = {
  languageA: "en",
  languageB: "es",
  sampleRate: 16000,
  endOfTurnConfidence: 0.4,
  minEndOfTurnSilence: 400,
  maxTurnSilence: 1280,
  keytermsPrompt: [],
};

// Handle browser WebSocket connections
wss.on("connection", (browserWs: WebSocket) => {
  console.log("[Browser] Client connected");

  let assemblyWs: WebSocket | null = null;
  let sessionConfig: SessionConfig = { ...DEFAULT_CONFIG };
  let isCleaningUp = false;

  // Connect to AssemblyAI streaming API
  function connectToAssemblyAI(config: SessionConfig) {
    // Close existing connection if any
    if (assemblyWs && assemblyWs.readyState === WebSocket.OPEN) {
      assemblyWs.close();
    }

    const params = new URLSearchParams({
      sample_rate: config.sampleRate.toString(),
      speech_model: "universal-streaming-multilingual",
      language_detection: "true",
      format_turns: "true",
      end_of_turn_confidence_threshold: config.endOfTurnConfidence.toString(),
      min_end_of_turn_silence_when_confident:
        config.minEndOfTurnSilence.toString(),
      max_turn_silence: config.maxTurnSilence.toString(),
    });

    if (config.keytermsPrompt.length > 0) {
      config.keytermsPrompt.forEach((term) => {
        params.append("keyterms_prompt", term);
      });
    }

    const url = `wss://streaming.assemblyai.com/v3/ws?${params.toString()}`;
    console.log("[AssemblyAI] Connecting...");

    assemblyWs = new WebSocket(url, {
      headers: { Authorization: ASSEMBLYAI_API_KEY },
    });

    assemblyWs.on("open", () => {
      console.log("[AssemblyAI] Connected");
      sendToBrowser({ type: "status", status: "connected" });
    });

    assemblyWs.on("message", async (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString());
        await handleAssemblyAIMessage(message, config);
      } catch (err) {
        console.error("[AssemblyAI] Failed to parse message:", err);
      }
    });

    assemblyWs.on("error", (error: Error) => {
      console.error("[AssemblyAI] WebSocket error:", error.message);
      sendToBrowser({
        type: "error",
        message: `AssemblyAI connection error: ${error.message}`,
      });
    });

    assemblyWs.on("close", (code: number, reason: Buffer) => {
      console.log(
        `[AssemblyAI] Disconnected: ${code} ${reason.toString()}`
      );
      if (!isCleaningUp) {
        sendToBrowser({ type: "status", status: "disconnected" });
      }
    });
  }

  // Handle messages from AssemblyAI
  async function handleAssemblyAIMessage(
    message: any,
    config: SessionConfig
  ) {
    if (message.type === "Begin") {
      console.log(`[AssemblyAI] Session started: ${message.id}`);
      sendToBrowser({
        type: "session_begin",
        sessionId: message.id,
        expiresAt: message.expires_at,
      });
    } else if (message.type === "Turn") {
      const transcript: string = message.transcript || "";
      const endOfTurn: boolean = message.end_of_turn || false;
      const turnIsFormatted: boolean = message.turn_is_formatted || false;
      const languageCode: string | null = message.language_code || null;
      const languageConfidence: number = message.language_confidence || 0;
      const turnOrder: number = message.turn_order || 0;

      // Send transcript update to browser immediately
      sendToBrowser({
        type: "transcript",
        transcript,
        endOfTurn,
        turnIsFormatted,
        languageCode,
        languageConfidence,
        turnOrder,
      });

      // Only translate + TTS on the FORMATTED end-of-turn to avoid
      // double-processing (AssemblyAI sends two end_of_turn messages
      // when format_turns=true: one raw, then one formatted).
      if (endOfTurn && turnIsFormatted && transcript.trim()) {
        const detectedLang = languageCode || config.languageA;
        const targetLang =
          detectedLang === config.languageA
            ? config.languageB
            : config.languageA;

        try {
          // Translate
          const translateStart = Date.now();
          const translation = await translateText(
            transcript,
            detectedLang,
            targetLang
          );
          const translateLatency = Date.now() - translateStart;

          sendToBrowser({
            type: "translation",
            original: transcript,
            translated: translation,
            sourceLang: detectedLang,
            targetLang,
            translateLatency,
          });

          // Generate TTS
          const ttsStart = Date.now();
          const audioBuffer = await generateTTS(translation, targetLang);
          const ttsLatency = Date.now() - ttsStart;

          sendToBrowser({
            type: "tts_audio",
            audio: audioBuffer.toString("base64"),
            ttsLatency,
          });
        } catch (error: any) {
          console.error("[Pipeline] Translation/TTS error:", error.message);
          sendToBrowser({
            type: "error",
            message: `Pipeline error: ${error.message}`,
          });
        }
      }
    } else if (message.type === "Termination") {
      console.log("[AssemblyAI] Session terminated");
      sendToBrowser({
        type: "session_end",
        audioDuration: message.audio_duration_seconds,
        sessionDuration: message.session_duration_seconds,
      });
    }
  }

  // Send JSON message to browser
  function sendToBrowser(data: object) {
    if (browserWs.readyState === WebSocket.OPEN) {
      browserWs.send(JSON.stringify(data));
    }
  }

  // Handle messages from browser
  browserWs.on("message", (data: Buffer, isBinary: boolean) => {
    if (isBinary) {
      // Binary audio data -- forward to AssemblyAI
      if (assemblyWs && assemblyWs.readyState === WebSocket.OPEN) {
        assemblyWs.send(data);
      }
    } else {
      // Text control message
      try {
        const message = JSON.parse(data.toString());

        if (message.type === "start") {
          sessionConfig = {
            ...DEFAULT_CONFIG,
            ...(message.config || {}),
          };
          connectToAssemblyAI(sessionConfig);
        } else if (message.type === "stop") {
          if (assemblyWs && assemblyWs.readyState === WebSocket.OPEN) {
            assemblyWs.send(JSON.stringify({ type: "Terminate" }));
          }
        } else if (message.type === "force_endpoint") {
          if (assemblyWs && assemblyWs.readyState === WebSocket.OPEN) {
            assemblyWs.send(
              JSON.stringify({
                type: "ForceEndpoint",
                end_of_turn_confidence: 1.0,
              })
            );
          }
        }
      } catch (e) {
        // Not JSON, ignore
      }
    }
  });

  // Cleanup on browser disconnect
  browserWs.on("close", () => {
    console.log("[Browser] Client disconnected");
    isCleaningUp = true;
    if (assemblyWs) {
      if (assemblyWs.readyState === WebSocket.OPEN) {
        assemblyWs.send(JSON.stringify({ type: "Terminate" }));
      }
      assemblyWs.close();
      assemblyWs = null;
    }
  });
});

// OpenAI translation
async function translateText(
  text: string,
  sourceLang: string,
  targetLang: string
): Promise<string> {
  const sourceName = LANGUAGE_NAMES[sourceLang] || sourceLang;
  const targetName = LANGUAGE_NAMES[targetLang] || targetLang;

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `You are a professional translator. Translate the following text from ${sourceName} to ${targetName}. Return ONLY the translated text. Preserve the original tone, meaning, and punctuation.`,
      },
      {
        role: "user",
        content: text,
      },
    ],
    temperature: 0.3,
    max_tokens: 1000,
  });

  return response.choices[0]?.message?.content?.trim() || "";
}

// OpenAI TTS
async function generateTTS(
  text: string,
  language: string
): Promise<Buffer> {
  const voice = VOICE_MAP[language] || "alloy";

  const response = await openai.audio.speech.create({
    model: "tts-1",
    voice: voice as any,
    input: text,
    response_format: "mp3",
    speed: 1.0,
  });

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// Start server
const PORT = parseInt(process.env.PORT || "3000", 10);
server.listen(PORT, () => {
  console.log(`\n  iTranslate Demo Server`);
  console.log(`  ----------------------`);
  console.log(`  URL:        http://localhost:${PORT}`);
  console.log(`  AssemblyAI: ${ASSEMBLYAI_API_KEY ? "configured" : "MISSING"}`);
  console.log(
    `  OpenAI:     ${process.env.OPENAI_API_KEY ? "configured" : "MISSING"}`
  );
  console.log();
});
