import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { Guidance, ServerEvent, SessionSnapshot, StepObservation, VisionCheck, VisionTiming } from "../../../shared/types.ts";
import { api, sessionIdFromUrl, type CameraInfo, type Health } from "./api.ts";
import { playSfx, unlockAudio } from "./sfx.ts";
import { narrator } from "./speech.ts";
import { useSession } from "./useSession.ts";

export interface Frame {
  image: string;
  observation: StepObservation | null;
  guidance: Guidance;
  timing: VisionTiming | null;
  at: number;
}

export interface ProgressNote {
  id: number;
  label: string;
  quest: boolean;
}

export interface QuestDone {
  title: string;
  recap: string;
  durationMs: number;
  stepsDone: number;
  stepsTotal: number;
}

interface LumiState {
  sessionId: string;
  snapshot: SessionSnapshot | null;
  health: Health | null;
  camera: CameraInfo | null;
  /** The phone page is open (connected to the camera server). */
  phoneOpen: boolean;
  /** Camera frames are arriving now. */
  streaming: boolean;
  frame: Frame | null;
  subtitle: { text: string; source: string; key: number } | null;
  transcript: string;
  lastCheck: VisionCheck | null;
  notes: ProgressNote[];
  questDone: QuestDone | null;
  dismissQuestDone: () => void;
  now: number;
  sound: { on: boolean; voice: boolean };
  enableSound: () => void;
  setVoice: (on: boolean) => void;
}

const POLL_MS = 3000;
const FRESH_FRAME_MS = 4000;

const Ctx = createContext<LumiState | null>(null);

export function useLumi(): LumiState {
  const state = useContext(Ctx);
  if (!state) throw new Error("useLumi needs <LumiProvider>");
  return state;
}

export function LumiProvider({ children }: { children: ReactNode }) {
  const sessionId = sessionIdFromUrl();
  const [health, setHealth] = useState<Health | null>(null);
  const [camera, setCamera] = useState<CameraInfo | null>(null);
  const [frame, setFrame] = useState<Frame | null>(null);
  const [subtitle, setSubtitle] = useState<LumiState["subtitle"]>(null);
  const [transcript, setTranscript] = useState("");
  const [lastCheck, setLastCheck] = useState<VisionCheck | null>(null);
  const [notes, setNotes] = useState<ProgressNote[]>([]);
  const [questDone, setQuestDone] = useState<QuestDone | null>(null);
  const [now, setNow] = useState(Date.now());
  const [sound, setSound] = useState({ on: false, voice: false });
  const soundRef = useRef(sound);
  soundRef.current = sound;
  const nextId = useRef(1);

  useEffect(() => {
    const poll = () => {
      api.health().then(setHealth).catch(() => setHealth(null));
      api.cameraInfo().then(setCamera).catch(() => setCamera(null));
    };
    poll();
    const timers = [window.setInterval(poll, POLL_MS), window.setInterval(() => setNow(Date.now()), 500)];
    return () => timers.forEach((t) => window.clearInterval(t));
  }, []);

  useEffect(() => {
    narrator.setCloudVoice(Boolean(health?.speak && !/on-device/i.test(health.speak)));
  }, [health?.speak]);

  const snapshot = useSession(sessionId, "stage", (e: ServerEvent) => {
    const { on, voice } = soundRef.current;
    switch (e.type) {
      case "snapshot":
        narrator.setCloudVoice(Boolean(e.snapshot.cloudVoice));
        if (e.snapshot.status === "planning" || e.snapshot.status === "active") setQuestDone(null);
        break;
      case "frame":
        setFrame({ ...e, at: Date.now() });
        break;
      case "say":
        setSubtitle({ text: e.text, source: e.source, key: Date.now() });
        if (voice) narrator.say(e.text, e.priority, e.id);
        if (on) playSfx(e.sfx);
        break;
      case "guide":
        if (voice && e.guidance.say) narrator.guide(e.guidance.say, e.speakId, e.guidance.phase, e.guidance.pan);
        break;
      case "transcript":
        setTranscript(e.text);
        break;
      case "vision_check":
        setLastCheck(e.check);
        break;
      case "progress": {
        const id = nextId.current++;
        const quest = e.stepId === "quest";
        setNotes((n) => [...n, { id, label: e.label, quest }]);
        window.setTimeout(() => setNotes((n) => n.filter((x) => x.id !== id)), 4200);
        if (on) playSfx(e.sfx);
        break;
      }
      case "quest_complete":
        setQuestDone({ title: e.title, recap: e.recap, durationMs: e.durationMs, stepsDone: e.stepsDone, stepsTotal: e.stepsTotal });
        break;
    }
  });

  const age = health?.cameraLink?.lastFrameAgeMs;
  const value: LumiState = {
    sessionId,
    snapshot,
    health,
    camera,
    phoneOpen: camera?.peers.includes("sender") ?? false,
    streaming: age !== null && age !== undefined && age < FRESH_FRAME_MS,
    frame,
    subtitle,
    transcript,
    lastCheck,
    notes,
    questDone,
    dismissQuestDone: () => setQuestDone(null),
    now,
    sound,
    enableSound: () => {
      unlockAudio();
      narrator.unlock();
      setSound({ on: true, voice: true });
    },
    setVoice: (voice: boolean) => {
      if (!voice) narrator.stop();
      setSound((s) => ({ ...s, voice }));
    },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function formatDuration(ms: number) {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
