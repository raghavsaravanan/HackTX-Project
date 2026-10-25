// Phone side of the game, hands-free: the mic stays open, a small voice detector cuts each
// utterance, Muse Voice Transcribe turns it into text, and the game acts only after the wake
// phrase ("Hi Echo"). Narration and directional beeps come back over the event stream.

const TARGET_RATE = 16000;
const CHUNK = 2048;
const PREROLL_CHUNKS = 8; // ~350 ms kept from before speech starts, so the first word isn't clipped
const MIN_LEVEL = 0.012;
const END_SILENCE_MS = 700;
const MIN_VOICED_MS = 300;
const MAX_UTTERANCE_MS = 9000;

/**
 * Always-on microphone with voice activity detection. Emits one mono 16-bit PCM WAV at 16 kHz
 * (the format Muse Voice Transcribe accepts) per utterance. Pass an AudioContext that was
 * created inside a tap, or iOS records silence.
 */
class Listener {
  constructor({ onUtterance, onSpeechStart, onSpeechEnd, isMuted }) {
    Object.assign(this, { onUtterance, onSpeechStart, onSpeechEnd, isMuted });
    this.enabled = true;
    this.floor = 0.01;
    this.reset();
  }

  get running() {
    return Boolean(this.stream);
  }

  async start(ctx) {
    if (this.stream) return;
    this.ctx = ctx;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const source = ctx.createMediaStreamSource(this.stream);
    const processor = ctx.createScriptProcessor(CHUNK, 1, 1);
    processor.onaudioprocess = (e) => this.onChunk(new Float32Array(e.inputBuffer.getChannelData(0)));
    // A script processor only runs while connected to the output; the muted gain keeps the mic off the speaker.
    const sink = ctx.createGain();
    sink.gain.value = 0;
    source.connect(processor);
    processor.connect(sink);
    sink.connect(ctx.destination);
  }

  reset() {
    this.speaking = false;
    this.loud = 0;
    this.chunks = [];
    this.preroll = [];
    this.voicedMs = 0;
    this.silentMs = 0;
    this.totalMs = 0;
  }

  onChunk(chunk) {
    if (!this.enabled || this.isMuted()) {
      if (this.speaking) this.onSpeechEnd();
      this.reset();
      return;
    }
    const ms = (chunk.length / this.ctx.sampleRate) * 1000;
    let sum = 0;
    for (let i = 0; i < chunk.length; i++) sum += chunk[i] * chunk[i];
    const rms = Math.sqrt(sum / chunk.length);
    const threshold = Math.max(MIN_LEVEL, this.floor * 3);

    if (!this.speaking) {
      this.preroll.push(chunk);
      if (this.preroll.length > PREROLL_CHUNKS) this.preroll.shift();
      if (rms <= threshold) {
        this.loud = 0;
        this.floor = this.floor * 0.95 + rms * 0.05;
        return;
      }
      if (++this.loud < 2) return;
      this.speaking = true;
      this.chunks = [...this.preroll];
      this.totalMs = this.chunks.length * ms;
      this.voicedMs = 2 * ms;
      this.onSpeechStart();
      return;
    }

    this.chunks.push(chunk);
    this.totalMs += ms;
    if (rms > threshold * 0.6) {
      this.silentMs = 0;
      this.voicedMs += ms;
    } else {
      this.silentMs += ms;
    }
    if (this.silentMs >= END_SILENCE_MS || this.totalMs >= MAX_UTTERANCE_MS) this.finish();
  }

  finish() {
    const { chunks, voicedMs } = this;
    this.reset();
    this.onSpeechEnd();
    if (voicedMs < MIN_VOICED_MS) return;
    this.onUtterance(encodeWav(downsample(concat(chunks), this.ctx.sampleRate, TARGET_RATE), TARGET_RATE));
  }
}

function concat(chunks) {
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function downsample(input, fromRate, toRate) {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    out[i] = sum / Math.max(1, end - start);
  }
  return out;
}

function encodeWav(samples, rate) {
  const view = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const str = (offset, s) => [...s].forEach((ch, i) => view.setUint8(offset + i, ch.charCodeAt(0)));
  str(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  str(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([view.buffer], { type: "audio/wav" });
}

// ------------------------------------------------------------- speech out

const speech = typeof speechSynthesis === "undefined" ? null : speechSynthesis;

/** Tracks when the phone is making sound, so the listener doesn't transcribe its own voice. */
const output = {
  busyUntil: 0,
  busy() {
    return Boolean(speech?.speaking) || Date.now() < this.busyUntil;
  },
  hold(ms) {
    this.busyUntil = Math.max(this.busyUntil, Date.now() + ms);
  },
};

function speak(text, priority) {
  if (!speech || !text) return;
  if (priority) speech.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.02;
  // speaking can flip false between queued lines; cover the gap and a short echo tail.
  output.hold(Math.min(12000, 800 + text.length * 70));
  u.onend = u.onerror = () => {
    output.busyUntil = Date.now() + 400;
  };
  speech.speak(u);
}

// ------------------------------------------------- directional beeps, chimes

class Cues {
  constructor() {
    this.ctx = null;
    this.guidance = null;
    this.timer = null;
  }

  attach(ctx) {
    this.ctx = ctx;
    if (!this.timer) this.timer = setTimeout(() => this.beat(), 300);
  }

  update(g) {
    this.guidance = g;
  }

  beat() {
    const g = this.guidance;
    const quiet = !g || !this.ctx || this.ctx.state !== "running" || g.phase === "idle" || g.phase === "verify";
    if (!quiet) this.tone(g.phase === "reach" ? 500 + g.proximity * 800 : g.phase === "scan" ? 880 : 620, g.phase === "scan" ? 0.2 : 0.08, g.pan);
    const gap = quiet ? 400 : g.phase === "scan" ? 1400 : g.phase === "aim" ? 520 : g.phase === "approach" ? 700 - g.proximity * 520 : 140;
    this.timer = setTimeout(() => this.beat(), gap);
  }

  /** Two rising notes: the agent woke up. One note: a command was understood. */
  chime(kind) {
    if (!this.ctx) return;
    output.hold(400);
    this.tone(660, 0.12, 0, 0.12);
    if (kind === "wake") setTimeout(() => this.tone(990, 0.16, 0, 0.12), 130);
  }

  tone(freq, seconds, pan = 0, volume = 0.06) {
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    const panner = typeof this.ctx.createStereoPanner === "function" ? this.ctx.createStereoPanner() : null;
    osc.frequency.value = freq;
    gain.gain.value = volume;
    osc.connect(panner ?? gain);
    if (panner) {
      panner.pan.value = Math.max(-1, Math.min(1, pan));
      panner.connect(gain);
    }
    gain.connect(this.ctx.destination);
    osc.start();
    osc.stop(this.ctx.currentTime + seconds);
  }
}

// ------------------------------------------------------------------- wiring

const STATUS_MARK = { done: "✓", skipped: "–" };

/**
 * `els`: speakToggle, listenToggle, said, line, state, questTitle, instruction, steps, verdict, typedForm, typedInput.
 * Returns `unlock()` (call synchronously inside the Start tap) and `listen()` (opens the mic).
 */
export function initGameVoice(els, session) {
  const cues = new Cues();
  const query = session ? `?session=${encodeURIComponent(session)}` : "";
  let ctx = null;
  let wake = "Hi Echo";
  let awakeUntil = 0;
  let awakeWindow = 20000;
  let hearing = false;
  let pending = 0;
  let queue = Promise.resolve();
  let lastGuide = "";
  let lastGuideAt = 0;
  let notice = "";

  const show = (el, text) => {
    el.textContent = text;
    el.hidden = !text;
  };

  const renderState = () => {
    let text;
    let mode = "idle";
    if (notice) text = notice;
    else if (!listener.running) text = `Tap Start, then say “${wake}, help me tidy my desk.”`;
    else if (!listener.enabled) text = "Listening is off. Turn it on below, or type.";
    else if (hearing) [text, mode] = ["Hearing you…", "hearing"];
    else if (pending) [text, mode] = ["Understanding…", "busy"];
    else if (Date.now() < awakeUntil) [text, mode] = ["I'm listening. Go ahead.", "awake"];
    else [text, mode] = [`Say “${wake}” to talk to me.`, "asleep"];
    els.state.textContent = text;
    els.state.dataset.mode = mode;
  };
  setInterval(renderState, 500);

  const listener = new Listener({
    isMuted: () => output.busy(),
    onSpeechStart: () => {
      hearing = true;
      renderState();
    },
    onSpeechEnd: () => {
      hearing = false;
      renderState();
    },
    onUtterance: (wav) => {
      pending++;
      queue = queue.then(() => send(wav)).finally(() => {
        pending--;
        renderState();
      });
    },
  });

  async function send(wav) {
    try {
      const res = await fetch(`/api/game/voice${query}`, { method: "POST", headers: { "Content-Type": "audio/wav" }, body: wav });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? body.detail ?? `HTTP ${res.status}`);
      notice = "";
      if (body.heard === "woke" || body.heard === "command") awakeWindow = body.awakeMs;
      if (body.awakeMs) awakeUntil = Date.now() + body.awakeMs;
      if (body.heard === "woke") cues.chime("wake");
      else if (body.heard === "command") {
        cues.chime("ok");
        show(els.said, `You said: “${body.transcript}”`);
      } else if (body.transcript) {
        const tip = body.heard === "ignored" ? `To start a new quest, say “${wake}, …”` : `Start with “${wake}”.`;
        show(els.said, `Heard “${body.transcript}”. ${tip}`);
      }
    } catch (err) {
      notice = `Voice failed: ${err.message}`;
      setTimeout(() => {
        notice = "";
      }, 5000);
    }
  }

  const renderQuest = (snap) => {
    wake = snap.wakePhrase || wake;
    const quest = snap.quest;
    const step = quest?.steps[snap.stepIndex];
    els.questTitle.textContent = quest ? quest.title : snap.status === "planning" ? "Planning your quest…" : "No quest yet";
    els.instruction.textContent = step?.instruction ?? (quest ? "Quest complete." : "Your quest and its steps appear here.");
    els.steps.replaceChildren(
      ...(quest?.steps ?? []).map((s, i) => {
        const li = document.createElement("li");
        const mission = snap.missions[i]?.status ?? "locked";
        const mark = STATUS_MARK[mission] ?? String(i + 1);
        li.textContent = `${mark}  ${s.action} ${s.target}${s.destination ? ` → ${s.destination}` : ""}`;
        li.dataset.status = i === snap.stepIndex && snap.status === "active" ? mission : mission === "done" || mission === "skipped" ? mission : "waiting";
        return li;
      }),
    );
    renderState();
  };

  const events = new EventSource(`/api/game/events${query}`);
  events.onopen = () => {
    notice = "";
    renderState();
  };
  events.onerror = () => {
    notice = "Game server not reachable. Is `npm run dev` running on the laptop?";
    renderState();
  };
  events.onmessage = (msg) => {
    const e = JSON.parse(msg.data);
    if (e.type === "snapshot") renderQuest(e.snapshot);
    else if (e.type === "say") {
      // Mirrors the server: a reply keeps the conversation open.
      if (Date.now() < awakeUntil) awakeUntil = Math.max(awakeUntil, Date.now() + awakeWindow);
      show(els.line, e.text);
      if (els.speakToggle.checked) speak(e.text, e.priority);
    } else if (e.type === "transcript" && e.text) {
      show(els.said, `You said: “${e.text}”`);
    } else if (e.type === "vision_check") {
      const evidence = e.check.evidence?.[0] ? ` — ${e.check.evidence[0]}` : "";
      show(els.verdict, `${e.check.verdict}${evidence}`);
      els.verdict.dataset.verdict = e.check.verdict;
    } else if (e.type === "guide") {
      cues.update(e.guidance);
      const text = e.guidance.say;
      const now = Date.now();
      if (!text || !els.speakToggle.checked || speech?.speaking) return;
      if (now - lastGuideAt < (text === lastGuide ? 6000 : 2500)) return;
      lastGuide = text;
      lastGuideAt = now;
      speak(text, false);
    }
  };

  els.listenToggle.addEventListener("change", () => {
    listener.enabled = els.listenToggle.checked;
    renderState();
  });

  els.typedForm.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const text = els.typedInput.value.trim();
    if (!text) return;
    els.typedInput.value = "";
    try {
      const res = await fetch(`/api/game/text${query}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? body.detail ?? `HTTP ${res.status}`);
      show(els.said, `You typed: “${body.transcript}”`);
    } catch (err) {
      notice = `Send failed: ${err.message}`;
      renderState();
    }
  });

  renderState();

  return {
    /** iOS only plays sound and records audio for contexts started inside a tap. */
    unlock() {
      if (!ctx) {
        ctx = new AudioContext();
        cues.attach(ctx);
      }
      void ctx.resume();
      if (speech) {
        const u = new SpeechSynthesisUtterance(" ");
        u.volume = 0;
        speech.speak(u);
      }
    },
    async listen() {
      if (!ctx || listener.running) return;
      try {
        await listener.start(ctx);
        notice = "";
      } catch (err) {
        notice = `Microphone blocked (${err.message}). You can still type below.`;
      }
      renderState();
    },
  };
}
