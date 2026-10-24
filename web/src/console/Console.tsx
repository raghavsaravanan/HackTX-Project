import { useEffect, useRef, useState } from "react";
import type { CommandType, FrameResponse, ServerEvent, VoiceIntent } from "../../../shared/types.ts";
import { api, sessionIdFromUrl, type Health, type PresetSummary } from "../lib/api.ts";
import { FrameLoop, captureFrame, startCamera } from "../lib/camera.ts";
import { GuidanceCues } from "../lib/cues.ts";
import { playSfx, unlockAudio } from "../lib/sfx.ts";
import { narrator } from "../lib/speech.ts";
import { useSession } from "../lib/useSession.ts";
import { WavRecorder } from "../lib/wavRecorder.ts";

const COMMANDS: CommandType[] = ["repeat", "describe", "skip", "pause", "resume", "stop", "reset"];

export function Console() {
  const sessionId = sessionIdFromUrl();
  const videoRef = useRef<HTMLVideoElement>(null);
  const loopRef = useRef<FrameLoop | null>(null);
  const cuesRef = useRef(new GuidanceCues());
  const recorderRef = useRef(new WavRecorder());

  const [ready, setReady] = useState(false);
  const [looping, setLooping] = useState(false);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [goal, setGoal] = useState("help me clean my desk");
  const [last, setLast] = useState<FrameResponse | null>(null);
  const [presets, setPresets] = useState<PresetSummary[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [audio, setAudio] = useState({ cues: true, voice: true });

  useEffect(() => {
    api.presets().then(setPresets).catch(() => {});
    api.health().then(setHealth).catch(() => {});
    return () => {
      loopRef.current?.stop();
      cuesRef.current.stop();
    };
  }, []);

  useEffect(() => {
    cuesRef.current.enabled = audio.cues;
    narrator.enabled = audio.voice;
  }, [audio]);

  const snapshot = useSession(sessionId, "phone", (e: ServerEvent) => {
    if (e.type === "say") {
      playSfx(e.sfx);
      narrator.say(e.text, e.priority);
      setLines((l) => [e.text, ...l].slice(0, 6));
    } else if (e.type === "reward") {
      playSfx(e.reward.sfx);
    }
  });

  const onFrame = (res: FrameResponse) => {
    setLast(res);
    cuesRef.current.update(res.guidance);
    if (res.guidance.say && !res.stepCompleted) narrator.guide(res.guidance.say);
  };

  const begin = async () => {
    unlockAudio();
    narrator.unlock();
    try {
      await startCamera(videoRef.current!);
      loopRef.current = new FrameLoop({
        sessionId,
        video: videoRef.current!,
        intervalMs: 600,
        maxInFlight: 2,
        onResponse: onFrame,
        onError: (err) => setError(err.message),
      });
      setReady(true);
    } catch (err) {
      setError(`Camera unavailable: ${(err as Error).message}`);
    }
  };

  const toggleLoop = () => {
    const loop = loopRef.current;
    if (!loop) return;
    if (loop.running) {
      loop.stop();
      cuesRef.current.stop();
    } else loop.start();
    setLooping(loop.running);
  };

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setError("");
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy("");
    }
  };

  const frame = () => (videoRef.current ? captureFrame(videoRef.current, 768, 0.7) : null) ?? undefined;

  const ensureLooping = () => {
    if (loopRef.current && !loopRef.current.running) {
      loopRef.current.start();
      setLooping(true);
    }
  };

  const startPreset = (presetId: string) =>
    run("Starting quest", async () => {
      await api.startQuest({ sessionId, presetId });
      ensureLooping();
    });

  const planGoal = (text: string) =>
    run("Planning quest", async () => {
      const image = frame();
      if (!image) throw new Error("Start the camera first");
      await api.startQuest({ sessionId, goal: text, image });
      ensureLooping();
    });

  const command = (type: CommandType) => run(type, () => api.command(sessionId, type, type === "describe" ? frame() : undefined));

  const dispatch = async (intent: VoiceIntent) => {
    if (intent.type === "start_quest") await planGoal(intent.goal);
    else if (intent.type !== "unknown") await command(intent.type);
    else narrator.say("I did not catch that.", true);
  };

  const talkStart = async () => {
    unlockAudio();
    narrator.stop();
    try {
      await recorderRef.current.start();
      setRecording(true);
    } catch (err) {
      setError(`Mic unavailable: ${(err as Error).message}`);
    }
  };

  const talkEnd = () => {
    if (!recording) return;
    setRecording(false);
    const wav = recorderRef.current.stop();
    if (!wav) return;
    void run("Transcribing", async () => {
      const res = await api.voice(sessionId, wav);
      await dispatch(res.intent);
    });
  };

  const typed = (text: string) => run("Thinking", async () => dispatch((await api.intent(sessionId, text)).intent));

  const o = last?.observation;
  const step = snapshot?.quest?.steps[snapshot.stepIndex];

  return (
    <div className="console">
      <header className="console-header">
        <strong>Sidequest console</strong>
        <span className="muted">
          session {sessionId} · vision {health?.vision ?? "?"} · brain {health?.muse ?? "?"}
        </span>
      </header>

      <div className="console-video">
        <video ref={videoRef} />
        {!ready && (
          <button className="primary big" onClick={begin}>
            Start camera and sound
          </button>
        )}
        {last && <div className={`phase phase-${last.guidance.phase}`}>{last.guidance.phase}</div>}
      </div>

      <section className="console-row">
        <button
          className={`talk ${recording ? "talk-on" : ""}`}
          onPointerDown={talkStart}
          onPointerUp={talkEnd}
          onPointerLeave={talkEnd}
          disabled={!ready}
        >
          {recording ? "Listening… release to send" : "Hold to talk"}
        </button>
        <button onClick={toggleLoop} disabled={!ready}>
          {looping ? "Stop vision loop" : "Start vision loop"}
        </button>
      </section>

      <section className="console-row">
        <form
          className="goal-form"
          onSubmit={(e) => {
            e.preventDefault();
            void typed(goal);
          }}
        >
          <input value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="Type a goal or command" />
          <button type="submit" disabled={!ready}>
            Send
          </button>
        </form>
      </section>

      <section className="console-row wrap">
        {presets.map((p) => (
          <button key={p.id} onClick={() => startPreset(p.id)}>
            {p.title} <span className="muted">({p.steps})</span>
          </button>
        ))}
      </section>

      <section className="console-row wrap">
        {COMMANDS.map((c) => (
          <button key={c} className="small" onClick={() => command(c)}>
            {c}
          </button>
        ))}
        <label className="toggle">
          <input type="checkbox" checked={audio.cues} onChange={(e) => setAudio({ ...audio, cues: e.target.checked })} /> cues
        </label>
        <label className="toggle">
          <input type="checkbox" checked={audio.voice} onChange={(e) => setAudio({ ...audio, voice: e.target.checked })} /> voice
        </label>
      </section>

      {(busy || error) && <div className={error ? "error" : "busy"}>{error || `${busy}…`}</div>}

      <section className="console-grid">
        <div className="card">
          <div className="panel-title">Quest</div>
          {snapshot?.quest ? (
            <>
              <div>{snapshot.quest.title}</div>
              <div className="muted">
                {snapshot.status} · step {Math.min(snapshot.stepIndex + 1, snapshot.quest.steps.length)}/{snapshot.quest.steps.length}
                {step && ` · ${step.action} ${step.target}${step.destination ? ` → ${step.destination}` : ""}`}
              </div>
            </>
          ) : (
            <div className="muted">{snapshot?.status ?? "connecting"}</div>
          )}
          {snapshot && (
            <div className="muted">
              LVL {snapshot.stats.level} · {snapshot.stats.xp} XP · combo x{snapshot.stats.combo}
            </div>
          )}
        </div>
        <div className="card">
          <div className="panel-title">Last frame {last?.timing && <span className="latency">{last.timing.ms} ms</span>}</div>
          {o ? (
            <div className="mono">
              target {o.targetVisible ? "yes" : "no"} · hand {o.handVisible ? "yes" : "no"} · holding {o.holdingTarget ? "yes" : "no"}
              <br />
              {o.distance} · done {String(o.stepDone)} ({o.confidence.toFixed(2)})
              <br />“{last?.guidance.say}”
            </div>
          ) : (
            <div className="muted">No observation yet</div>
          )}
        </div>
        <div className="card span-2">
          <div className="panel-title">Narrator</div>
          {lines.length ? lines.map((l, i) => <div key={i} className={i ? "muted" : ""}>{l}</div>) : <div className="muted">—</div>}
        </div>
      </section>
    </div>
  );
}
