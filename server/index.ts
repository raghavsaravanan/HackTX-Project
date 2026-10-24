import express, { type NextFunction, type Request, type Response } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CommandRequest, FrameRequest, StartQuestRequest, VoiceResponse } from "../shared/types.ts";
import { parseIntent, planQuest } from "./brain.ts";
import { config, hasGemini, hasMuse, visionMode } from "./config.ts";
import { PRESETS } from "./presets.ts";
import { museTranscribe } from "./providers/muse.ts";
import {
  getSession,
  handleFrame,
  planningFailed,
  recordTranscript,
  runCommand,
  setPlanning,
  snapshot,
  startQuest,
  subscribe,
  trackPipeline,
} from "./session.ts";
import { scanScene } from "./vision.ts";
import { timed, uid } from "./util.ts";

const app = express();
app.use(express.json({ limit: "8mb" }));

const asyncRoute =
  (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

app.get("/api/health", (_req, res) => {
  res.json({
    muse: hasMuse() ? config.muse.model : "mock",
    transcribe: hasMuse() ? config.muse.transcribeModel : "unavailable",
    vision: visionMode() === "gemini" ? config.gemini.model : visionMode() === "muse" ? config.muse.model : "mock",
    gemini: hasGemini(),
  });
});

app.get("/api/presets", (_req, res) => {
  res.json(Object.entries(PRESETS).map(([id, p]) => ({ id, title: p.title, type: p.type, steps: p.steps.length })));
});

app.get("/api/session/:id", (req, res) => {
  res.json(snapshot(getSession(req.params.id)));
});

app.get("/api/session/:id/events", (req, res) => {
  subscribe(getSession(req.params.id), res, req.query.role === "stage" ? "stage" : "phone");
});

app.post(
  "/api/frame",
  asyncRoute(async (req, res) => {
    const body = req.body as FrameRequest;
    if (!body.sessionId || !body.image) {
      res.status(400).json({ error: "sessionId and image are required" });
      return;
    }
    res.json(await handleFrame(getSession(body.sessionId), body));
  }),
);

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
      res.json(snapshot(s));
      return;
    }

    if (!body.goal || !body.image) {
      res.status(400).json({ error: "Provide presetId, or goal plus image" });
      return;
    }

    setPlanning(s, body.goal);
    try {
      trackPipeline(s, "vision", "start");
      const { scene, timing } = await scanScene(body.image);
      trackPipeline(s, "vision", "done", timing.ms, `${scene.objects.length} objects`);

      trackPipeline(s, "plan", "start");
      const { value: quest, ms } = await timed(() => planQuest(body.goal!, scene));
      trackPipeline(s, "plan", "done", ms, `${quest.steps.length} steps`);

      startQuest(s, quest, hasMuse() ? "muse" : "system");
      res.json(snapshot(s));
    } catch (err) {
      planningFailed(s, (err as Error).message);
      throw err;
    }
  }),
);

app.post(
  "/api/command",
  asyncRoute(async (req, res) => {
    const body = req.body as CommandRequest;
    const s = getSession(body.sessionId);
    await runCommand(s, body.type, body.image);
    res.json(snapshot(s));
  }),
);

/** Body: raw mono 16-bit PCM WAV. Returns the transcript plus a parsed intent; the client dispatches it. */
app.post(
  "/api/voice",
  express.raw({ type: ["audio/wav", "audio/x-wav", "application/octet-stream"], limit: "16mb" }),
  asyncRoute(async (req, res) => {
    const s = getSession(String(req.query.sessionId ?? "demo"));
    if (!hasMuse()) {
      res.status(503).json({ error: "MODEL_API_KEY not set; use typed commands" });
      return;
    }
    trackPipeline(s, "transcribe", "start");
    const { value: transcript, ms } = await timed(() =>
      museTranscribe(req.body as Buffer, ["quest", "skip", "repeat", "backpack", "trash can"]),
    );
    trackPipeline(s, "transcribe", "done", ms);
    recordTranscript(s, transcript);
    const response: VoiceResponse = { transcript, intent: parseIntent(transcript) };
    res.json(response);
  }),
);

/** Typed fallback for voice: same intent parsing, no transcription. */
app.post("/api/intent", (req, res) => {
  const { sessionId, text } = req.body as { sessionId: string; text: string };
  recordTranscript(getSession(sessionId), text);
  const response: VoiceResponse = { transcript: text, intent: parseIntent(text) };
  res.json(response);
});

if (process.env.NODE_ENV === "production") {
  const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist");
  app.use(express.static(dist));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(dist, "index.html")));
}

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error("[api]", err.message);
  if (!res.headersSent) res.status(500).json({ error: err.message });
});

app.listen(config.port, (err?: Error) => {
  if (err) {
    console.error(`Could not listen on port ${config.port}: ${err.message}`);
    process.exit(1);
  }
  console.log(`Sidequest API on http://localhost:${config.port}`);
  console.log(`  muse: ${hasMuse() ? config.muse.model : "MOCK"} | vision: ${visionMode()}`);
});
