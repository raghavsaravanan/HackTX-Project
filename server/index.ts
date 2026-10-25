import express, { type NextFunction, type Request, type Response } from "express";
import type { AskRequest, MissionVerifyRequest, StartQuestRequest, VoiceResponse } from "../shared/types.ts";
import { cameraLinkEnabled, cameraLinkStatus } from "./cameraLink.ts";
import { config, hasElevenLabs, hasGemini, hasMuse, questMode, redact, visionMode, type AgentMode } from "./config.ts";
import { speakLineAudio } from "./tts.ts";
import { PRESETS } from "./presets.ts";
import { geminiStatus } from "./providers/gemini.ts";
import { museTranscribe } from "./providers/muse.ts";
import { visionQueueStatus } from "./vision.ts";
import { wakeKeywords, wakePhrase } from "./wake.ts";
import {
  askQuestion,
  getSession,
  hearUtterance,
  holdVision,
  planFromGoal,
  pollCameraLink,
  snapshot,
  startQuest,
  subscribe,
  surveySurroundings,
  trackPipeline,
  verifyMission,
} from "./session.ts";
import { trackApiCall } from "./telemetry.ts";
import { errorDetail, timed, uid } from "./util.ts";

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "64kb" }));

const asyncRoute =
  (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

const modelName = (mode: AgentMode, gemini: string, openai: string) =>
  mode === "openai" ? openai : mode === "gemini" ? gemini : mode === "muse" ? config.muse.model : "mock";

app.get(
  "/api/health",
  asyncRoute(async (_req, res) => {
    res.json({
      agent: { name: config.agent.name, wakePhrase: wakePhrase() },
      muse: hasMuse() ? config.muse.model : "mock",
      transcribe: `Safari on the phone; server backup: ${transcribeModel() ?? "none"}`,
      speak: hasElevenLabs() ? `ElevenLabs (${config.elevenlabs.model})` : "on-device",
      vision: modelName(visionMode(), config.gemini.visionModel, config.openai.visionModel),
      quest: modelName(questMode(), config.gemini.questModel, config.openai.questModel),
      gemini: hasGemini(),
      geminiStatus: geminiStatus(),
      visionNote:
        geminiStatus().quotaExhausted && (visionMode() === "muse" || questMode() === "muse")
          ? "Gemini over quota, using Muse Spark (slower)"
          : null,
      visionQueue: visionQueueStatus(),
      verifySteps: config.game.verifySteps,
      cadence: {
        frameMs: config.cameraLink.intervalMs,
        frameMaxSide: config.cameraLink.maxSide,
        surveyMs: config.surveyIntervalMs,
        hintAfterSec: config.game.hintAfterSec,
      },
      cameraLink: cameraLinkEnabled() ? await cameraLinkStatus() : null,
    });
  }),
);

app.get("/api/presets", (_req, res) => {
  res.json(Object.entries(PRESETS).map(([id, p]) => ({ id, title: p.title, type: p.type, steps: p.steps.length })));
});

app.get("/api/session/:id/events", (req, res) => {
  subscribe(getSession(req.params.id), res, req.query.role === "stage" ? "stage" : "phone");
});

app.post(
  "/api/quest/start",
  asyncRoute(async (req, res) => {
    const body = req.body as StartQuestRequest;
    const s = getSession(body.sessionId);

    if (body.presetId) {
      const preset = PRESETS[body.presetId];
      if (!preset) {
        res.status(404).json({ error: `Unknown preset ${body.presetId}` });
        return;
      }
      startQuest(s, { id: uid("q"), ...structuredClone(preset) }, "system");
      // Presets name their objects up front; place them on the map from what the camera actually sees.
      void surveySurroundings(s);
      res.json(snapshot(s));
      return;
    }

    if (!body.goal) {
      res.status(400).json({ error: "Provide presetId or a goal" });
      return;
    }
    res.json(await planFromGoal(s, body.goal));
  }),
);

/** The Quest Agent answers a question, consulting the Vision Agent when it needs to look. */
app.post(
  "/api/agent/ask",
  asyncRoute(async (req, res) => {
    const body = req.body as AskRequest;
    if (!body.sessionId || !body.text?.trim()) {
      res.status(400).json({ error: "sessionId and text are required" });
      return;
    }
    res.json(await askQuestion(getSession(body.sessionId), body.text.trim().slice(0, 500)));
  }),
);

/** Re-check one mission's success condition (tapped on the quest map). PASS on the current mission completes it. */
app.post(
  "/api/mission/verify",
  asyncRoute(async (req, res) => {
    const body = req.body as MissionVerifyRequest;
    const s = getSession(body.sessionId);
    const check = await verifyMission(s, body.stepId);
    if (!check) {
      res.status(s.quest ? 502 : 404).json({ error: s.quest ? "Vision Agent unavailable" : "No active quest" });
      return;
    }
    res.json({ check, snapshot: snapshot(s) });
  }),
);

const BASE_KEYWORDS = ["quest", "skip", "repeat", "pause", "resume", "done", "check"];
const wavBody = express.raw({ type: ["audio/wav", "audio/x-wav", "application/octet-stream"], limit: "16mb" });

/**
 * Server-side speech to text, used only when the phone can't recognize speech itself
 * (normally Safari does it on the phone and sends text to /api/voice/heard).
 */
function transcribeModel(): string | null {
  return hasMuse() ? config.muse.transcribeModel : null;
}

/** Speech to text, biased toward the words this session is likely to hear: quest objects and recognized landmarks. */
async function transcribe(s: ReturnType<typeof getSession>, wav: Buffer): Promise<string> {
  const questWords = s.quest?.steps.flatMap((step) => [step.target, step.destination]) ?? [];
  const keywords = [...new Set([...wakeKeywords(), ...BASE_KEYWORDS, ...questWords, ...s.map.landmarks.map((l) => l.label)].filter(Boolean))].slice(0, 20);
  trackPipeline(s, "transcribe", "start");
  // Voice gets the uplink first: frame and survey uploads wait until the audio is transcribed.
  const release = holdVision();
  try {
    const { value: transcript, ms } = await timed(() =>
      trackApiCall(
        { provider: "muse", model: config.muse.transcribeModel, operation: "transcribe" },
        () => museTranscribe(wav, keywords),
        (text) => `${text.split(/\s+/).filter(Boolean).length} words`,
      ),
    );
    trackPipeline(s, "transcribe", "done", ms);
    return transcript;
  } catch (err) {
    trackPipeline(s, "transcribe", "error", undefined, redact((err as Error).message).slice(0, 80));
    throw err;
  } finally {
    release();
  }
}

const voiceSession = (req: Request) => getSession(String(req.query.sessionId ?? "demo").slice(0, 64));

/**
 * Hands-free listening, transcribed on the phone (Safari speech recognition). Same wake-phrase
 * rules as /api/voice/listen, but no audio upload or transcription call.
 */
app.post(
  "/api/voice/heard",
  asyncRoute(async (req, res) => {
  const { sessionId, transcript } = req.body as { sessionId?: string; transcript?: string };
  const heard = transcript?.trim().slice(0, 500) ?? "";
  if (!sessionId || !heard) {
    res.status(400).json({ error: "sessionId and transcript are required" });
    return;
  }
  const response = await hearUtterance(getSession(sessionId.slice(0, 64)), heard);
  console.log(`[heard] ${response.heard} on-phone "${heard.slice(0, 80)}"`);
  res.json(response);
  }),
);

/**
 * Hands-free listening. Body: one utterance as raw mono 16-bit PCM WAV, cut by the phone's
 * voice-activity detector, when the phone can't recognize speech itself. Muse transcribes it.
 */
app.post(
  "/api/voice/listen",
  wavBody,
  asyncRoute(async (req, res) => {
    const s = voiceSession(req);
    if (!transcribeModel()) {
      res.status(503).json({ error: "MODEL_API_KEY not set; type commands instead" });
      return;
    }
    const t0 = Date.now();
    const transcript = await transcribe(s, req.body as Buffer);
    const response = await hearUtterance(s, transcript);
    console.log(`[listen] ${response.heard} ${Date.now() - t0}ms "${transcript.slice(0, 80)}"`);
    res.json(response);
  }),
);

app.get(
  "/api/tts/:id",
  asyncRoute(async (req, res) => {
    const id = String(req.params.id).slice(0, 64);
    try {
      const audio = await speakLineAudio(id);
      if (!audio) {
        res.status(404).json({ error: "Unknown line" });
        return;
      }
      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("Cache-Control", "private, max-age=3600");
      res.send(audio);
    } catch (err) {
      res.status(502).json({ error: redact((err as Error).message) });
    }
  }),
);

/** Typed fallback for the phone: acted on directly, no wake phrase needed. */
app.post(
  "/api/say",
  asyncRoute(async (req, res) => {
    const { sessionId, text } = req.body as { sessionId: string; text: string };
    const said = text?.trim().slice(0, 500) ?? "";
    if (!sessionId || !said) {
      res.status(400).json({ error: "sessionId and text are required" });
      return;
    }
    const heard = await hearUtterance(getSession(sessionId), said, true);
    const response: VoiceResponse = { transcript: said, intent: heard.intent ?? { type: "unknown" } };
    res.json(response);
  }),
);

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  const detail = redact(errorDetail(err));
  console.error("[api]", detail);
  let message = detail;
  if (/fetch failed/i.test(err.message)) message = "The AI service could not be reached. Try again in a moment.";
  else if (/Muse Voice Transcribe 429/i.test(detail)) message = "Transcription is busy, try again in a moment.";
  if (!res.headersSent) res.status(500).json({ error: message });
});

if (cameraLinkEnabled() && config.surveyIntervalMs > 0) {
  setInterval(() => void surveySurroundings(), config.surveyIntervalMs);
}

if (cameraLinkEnabled()) {
  let polling = false;
  setInterval(() => {
    if (polling) return;
    polling = true;
    void pollCameraLink().finally(() => {
      polling = false;
    });
  }, config.cameraLink.intervalMs);
}

app.listen(config.port, config.host, (err?: Error) => {
  if (err) {
    console.error(`Could not listen on ${config.host}:${config.port}: ${err.message}`);
    process.exit(1);
  }
  console.log(`Sidequest API on http://${config.host}:${config.port}`);
  console.log(
    `  quest agent: ${modelName(questMode(), config.gemini.questModel, config.openai.questModel)} | vision agent: ${modelName(visionMode(), config.gemini.visionModel, config.openai.visionModel)} | ` +
      `listening: Safari on the phone (server backup: ${transcribeModel() ?? "off"}) | camera link: ${cameraLinkEnabled() ? config.cameraLink.url : "off"}`,
  );
});
