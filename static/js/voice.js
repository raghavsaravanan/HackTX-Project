// Phone side of the game, hands-free: Safari's speech recognition turns each utterance into text
// on the phone (or, where that's unavailable, a small voice detector cuts each utterance and the
// server transcribes it), and the game acts only after the wake phrase ("Hi Lumi"). Narration and directional beeps come back over the event stream.

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

/** Spellings speech recognition produces for agent names (mirrors server/wake.ts). */
const WAKE_SOUND_ALIKES = {
  lumi: ["lumie", "lumy", "lumee", "loomi", "loomie", "loomy", "lummy", "lumia", "lu me", "lou me", "loo me", "lew me"],
  echo: ["eko", "ekko", "ecco", "eco", "hecho"],
};

/** "Hi Lumi" (or a recognized spelling) anywhere in a transcript, greeting included. */
function wakePattern(wakePhrase) {
  const name = wakePhrase.replace(/^(hi|hey)\s+/i, "").trim().toLowerCase();
  const names = [name, ...(WAKE_SOUND_ALIKES[name] ?? [])].map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return new RegExp(`\\b(?:hi|hey|hello|okay|ok)[\\s,.!]*(?:${names})\\b`, "i");
}

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition || null;
// Errors that mean on-phone recognition will never work here; fall back to recording audio.
const FATAL_SPEECH_ERRORS = new Set(["service-not-allowed", "language-not-supported", "audio-capture"]);
// Consecutive network errors before giving up on the phone's recognizer.
const MAX_NETWORK_ERRORS = 3;

/**
 * Hands-free listening transcribed on the phone (Safari speech recognition, on-device on recent
 * iPhones), so only text crosses the network. One utterance per recognition session; it restarts
 * itself, backs off after errors, and stays paused while the phone is talking so it doesn't hear
 * its own narration. If iOS revokes permission (e.g. after the screen locked), it waits for a tap.
 */
class BrowserListener {
  constructor({ onText, onSpeechStart, onSpeechEnd, isMuted, onFatal, onNeedTap, wakeIndex, onBargeIn }) {
    Object.assign(this, { onText, onSpeechStart, onSpeechEnd, isMuted, onFatal, onNeedTap, wakeIndex, onBargeIn });
    /** The player said the wake phrase over Lumi: this utterance counts even though Lumi was talking. */
    this.barged = false;
    this.enabled = true;
    this.rec = null;
    this.active = false;
    this.failed = false;
    this.worked = false;
    this.waitingForTap = false;
    this.interim = "";
    this.retryAt = 0;
    this.networkErrors = 0;
    this.startFailures = 0;
  }

  get running() {
    return Boolean(this.rec) && !this.failed;
  }

  /** Call synchronously inside the Start tap: iOS only grants speech recognition from a gesture. */
  start() {
    if (this.rec) return;
    const rec = new Recognition();
    rec.lang = navigator.language || "en-US";
    rec.continuous = false;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.onstart = () => {
      this.worked = true;
      this.startFailures = 0;
    };
    rec.onresult = (e) => {
      this.networkErrors = 0;
      if (!this.enabled) return;
      let final = "";
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const text = e.results[i][0].transcript;
        if (e.results[i].isFinal) final += text;
        else interim += text;
      }
      // While Lumi is talking the mic mostly hears Lumi, so only the wake phrase counts: it interrupts (barge-in).
      if (this.isMuted() && !this.barged) {
        const heard = `${final} ${interim}`.trim();
        if (!heard || this.wakeIndex(heard) < 0) return;
        this.barged = true;
        this.onBargeIn();
      }
      // After a barge-in, drop whatever of Lumi's own voice came before the wake phrase.
      const cut = (text) => {
        if (!this.barged) return text;
        const at = this.wakeIndex(text);
        return at >= 0 ? text.slice(at) : text;
      };
      if (interim.trim()) {
        this.interim = cut(interim.trim());
        this.onSpeechStart();
      }
      if (final.trim()) this.emit(cut(final.trim()));
    };
    rec.onerror = (e) => {
      if (e.error === "not-allowed") {
        // Worked before, so iOS revoked it (screen locked, app switched): one tap brings it back.
        if (this.worked) this.waitForTap();
        else this.fail(e.error);
        return;
      }
      if (FATAL_SPEECH_ERRORS.has(e.error)) {
        this.fail(e.error);
        return;
      }
      if (e.error === "network" && ++this.networkErrors >= MAX_NETWORK_ERRORS) {
        this.fail(e.error);
        return;
      }
      // no-speech and aborted are routine; anything else waits a little before retrying.
      if (e.error !== "no-speech" && e.error !== "aborted") this.retryAt = Date.now() + Math.min(5000, 1000 * Math.max(1, this.networkErrors));
    };
    rec.onend = () => {
      this.active = false;
      // iOS sometimes ends a session without marking the last result final.
      if (this.interim && this.enabled && (this.barged || !this.isMuted())) this.emit(this.interim);
      this.interim = "";
      this.barged = false;
      this.onSpeechEnd();
    };
    this.rec = rec;
    this.timer = setInterval(() => this.tick(), 250);
    this.begin();
  }

  fail(error) {
    if (this.failed) return;
    this.failed = true;
    clearInterval(this.timer);
    try {
      this.rec.abort();
    } catch {
      /* already stopped */
    }
    this.onFatal(error);
  }

  waitForTap() {
    if (this.waitingForTap) return;
    this.waitingForTap = true;
    this.onNeedTap();
    const resume = () => {
      this.waitingForTap = false;
      this.retryAt = 0;
      this.begin(); // inside the tap, so iOS allows it
    };
    document.addEventListener("pointerup", resume, { once: true });
  }

  emit(text) {
    this.interim = "";
    this.barged = false;
    this.onSpeechEnd();
    this.onText(text);
  }

  begin() {
    try {
      this.rec.start();
      this.active = true;
    } catch (err) {
      // InvalidStateError means it is already running; anything else, give up after a few tries.
      if (err?.name !== "InvalidStateError" && ++this.startFailures >= 3) this.fail(err?.name || "start-failed");
    }
  }

  tick() {
    if (this.failed || this.waitingForTap) return;
    // Keep listening while Lumi talks, so "Hi Lumi" can interrupt; onresult ignores everything else meanwhile.
    const wanted = this.enabled;
    if (!wanted && this.active) {
      this.interim = "";
      this.rec.abort();
    } else if (wanted && !this.active && Date.now() >= this.retryAt) this.begin();
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

/** Minimal silent MP3 — unlocks `<audio>` playback inside a user gesture on iOS. */
const SILENT_MP3 =
  "data:audio/mpeg;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA//tQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAADhAC7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7//////////////////////////////////////////////////////////////////8AAAAATGF2YzU4LjEzAAAAAAAAAAAAAAAAJAAAAAAAAAAAA4SpmwxxAAAA//sQZAAP8AAAaQAAAAgAAA0gAAABAAABpAAAACAAADSAAAAETEFNRTMuMTAwVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//sQZB4P8AAAaQAAAAgAAA0gAAABAAABpAAAACAAADSAAAAEVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV";

function pickDeviceVoice() {
  if (!speech) return null;
  const voices = speech.getVoices();
  const enUs = voices.filter((v) => v.lang === "en-US" || v.lang.startsWith("en-US"));
  const pool = enUs.length ? enUs : voices.filter((v) => v.lang.startsWith("en"));
  const premium = (v) => /Premium|Enhanced|Natural/i.test(v.name);
  return pool.find(premium) ?? pool.find((v) => v.lang.startsWith("en")) ?? null;
}

/** Cloud TTS with on-device fallback; one reused `<audio>` element and a small queue. */
function createNarrator(getCloudEnabled, query) {
  const audio = typeof Audio !== "undefined" ? new Audio() : null;
  if (audio) audio.setAttribute("playsinline", "");
  let queue = [];
  let playing = false;
  let voice = null;
  if (speech) {
    const pick = () => {
      voice = pickDeviceVoice();
    };
    pick();
    speech.addEventListener("voiceschanged", pick);
  }

  const hold = (ms) => {
    output.busyUntil = Math.max(output.busyUntil, Date.now() + ms);
  };

  const speakDevice = (text, priority) => {
    if (!speech || !text) return;
    if (priority) {
      speech.cancel();
      queue = [];
      playing = false;
      if (audio) {
        audio.pause();
        audio.removeAttribute("src");
      }
    }
    const u = new SpeechSynthesisUtterance(text);
    if (voice) u.voice = voice;
    u.rate = 0.95;
    hold(Math.min(12000, 800 + text.length * 70));
    u.onend = u.onerror = () => {
      output.busyUntil = Date.now() + 400;
    };
    speech.speak(u);
  };

  // Bumped whenever playback is interrupted, so a clip that was cut off doesn't come back in the
  // device voice on top of the next one (that was the "two voices" bug).
  let generation = 0;

  const drain = () => {
    if (playing || !queue.length || !audio) return;
    const next = queue.shift();
    const mine = generation;
    playing = true;
    hold(15000);
    audio.src = next.url;
    audio.onended = () => {
      if (mine !== generation) return;
      playing = false;
      output.busyUntil = Date.now() + 350;
      drain();
    };
    // Only a real failure of the cloud voice falls back to the device voice, and only for the current line.
    const fallBack = () => {
      if (mine !== generation) return;
      playing = false;
      speakDevice(next.text, false);
      drain();
    };
    audio.onerror = fallBack;
    void audio.play().catch((err) => {
      if (err?.name === "AbortError") return; // interrupted on purpose by a newer line
      fallBack();
    });
  };

  const enqueue = (speakId, text, priority) => {
    if (!text) return;
    if (priority) {
      generation++;
      queue = [];
      playing = false;
      if (audio) {
        audio.pause();
        audio.removeAttribute("src");
      }
      if (speech) speech.cancel();
    }
    if (getCloudEnabled() && speakId) {
      queue.push({ url: `/api/game/tts/${encodeURIComponent(speakId)}${query}`, text });
      drain();
      return;
    }
    speakDevice(text, priority);
  };

  return {
    unlock() {
      if (!audio) return;
      audio.volume = 0;
      audio.src = SILENT_MP3;
      void audio.play().then(() => {
        audio.pause();
        audio.volume = 1;
        audio.removeAttribute("src");
      });
      if (speech) {
        const u = new SpeechSynthesisUtterance(" ");
        u.volume = 0;
        speech.speak(u);
      }
    },
    speak(speakId, text, priority) {
      output.current = text;
      enqueue(speakId, text, priority);
    },
    /** Stop talking right away (the player interrupted with the wake phrase). */
    stop() {
      generation++;
      queue = [];
      playing = false;
      if (audio) {
        audio.onended = audio.onerror = null;
        audio.pause();
        audio.removeAttribute("src");
      }
      if (speech) speech.cancel();
      output.busyUntil = 0;
      output.current = "";
    },
    cloudPlaying() {
      return Boolean(playing || (audio && !audio.paused && audio.src));
    },
  };
}

/** Tracks when the phone is making sound, so the listener doesn't transcribe its own voice. */
const output = {
  busyUntil: 0,
  narrator: null,
  /** The line Lumi is saying, so its own "Hi Lumi" (e.g. "Say Hi Lumi and try again") can't interrupt it. */
  current: "",
  busy() {
    const n = output.narrator;
    return Boolean(speech?.speaking) || Boolean(n?.cloudPlaying()) || Date.now() < this.busyUntil;
  },
  hold(ms) {
    this.busyUntil = Math.max(this.busyUntil, Date.now() + ms);
  },
};

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
  let wake = "Hi Lumi";
  let awakeUntil = 0;
  let awakeWindow = 20000;
  let hearing = false;
  let pending = 0;
  let sending = false;
  let latestWav = null;
  let latestAt = 0;
  const MAX_WAV_AGE_MS = 8000;
  const FETCH_TIMEOUT_MS = 20000;
  let lastGuideKey = "";
  let lastGuideAt = 0;
  let cloudVoice = false;
  let notice = "";
  let thinking = false;

  const show = (el, text) => {
    el.textContent = text;
    el.hidden = !text;
  };

  const renderState = () => {
    let text;
    let mode = "idle";
    if (notice) text = notice;
    else if (!active().running) text = `Tap Start, then say “${wake}, help me tidy my desk.”`;
    else if (!active().enabled) text = "Listening is off. Turn it on below, or type.";
    else if (hearing) [text, mode] = ["Hearing you…", "hearing"];
    else if (pending || thinking) [text, mode] = ["Thinking…", "busy"];
    else if (Date.now() < awakeUntil) [text, mode] = ["I'm listening. Go ahead.", "awake"];
    else [text, mode] = [`Say “${wake}” to talk to me.`, "asleep"];
    els.state.textContent = text;
    els.state.dataset.mode = mode;
    // Which recognizer is listening, shown small under the status: "on-phone" (Safari) or "server".
    const onPhone = Boolean(browserListener) && !browserListener.failed;
    els.state.dataset.engine = onPhone ? "on-phone" : "server";
    els.state.title = onPhone ? "Speech is recognized on this phone" : "Speech is recorded and transcribed on the laptop";
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
      latestWav = wav;
      latestAt = Date.now();
      void drainUtterances();
    },
  });

  const browserListener = Recognition
    ? new BrowserListener({
        isMuted: () => output.busy(),
        wakeIndex: (text) => {
          const re = wakePattern(wake);
          // Lumi's own line saying the wake phrase must not interrupt Lumi.
          if (output.busy() && re.test(output.current)) return -1;
          return text.search(re);
        },
        onBargeIn: () => {
          output.narrator?.stop();
          cues.chime("wake");
          awakeUntil = Date.now() + awakeWindow;
          hearing = true;
          renderState();
        },
        onSpeechStart: () => {
          hearing = true;
          renderState();
        },
        onSpeechEnd: () => {
          hearing = false;
          renderState();
        },
        onText: (text) => {
          pending++;
          renderState();
          void sendText(text).finally(() => {
            pending--;
            renderState();
          });
        },
        onFatal: (error) => {
          // On-phone recognition is off (e.g. Dictation disabled); record audio for the server instead.
          console.warn("Speech recognition unavailable:", error);
          void startRecorder();
        },
        onNeedTap: () => {
          notice = "Tap the screen once so I can keep listening.";
          renderState();
          output.narrator?.speak(null, "Tap the screen once so I can keep listening.", true);
          const clear = () => {
            notice = "";
            renderState();
          };
          document.addEventListener("pointerup", clear, { once: true });
        },
      })
    : null;
  /** The listener in use: on-phone recognition unless it failed, else the audio recorder. */
  const active = () => (browserListener?.running ? browserListener : listener);

  async function startRecorder() {
    if (!ctx || listener.running) return;
    try {
      await listener.start(ctx);
      notice = "";
    } catch (err) {
      notice = `Microphone blocked (${err.message}). You can still type below.`;
    }
    renderState();
  }

  async function sendText(text) {
    await post(`/api/game/heard${query}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  }

  async function drainUtterances() {
    if (sending) return;
    while (latestWav) {
      if (Date.now() - latestAt > MAX_WAV_AGE_MS) {
        latestWav = null;
        break;
      }
      const wav = latestWav;
      latestWav = null;
      sending = true;
      pending++;
      renderState();
      try {
        await send(wav);
      } finally {
        sending = false;
        pending--;
        renderState();
      }
    }
  }

  async function send(wav) {
    await post(`/api/game/voice${query}`, { method: "POST", headers: { "Content-Type": "audio/wav" }, body: wav });
  }

  /** Sends one utterance (audio or on-phone text) and reacts to what the game heard. */
  async function post(url, init) {
    // Another phone page took over: don't send what this page's mic heard.
    if (!isSpeaker()) return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { ...init, signal: ctrl.signal });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? body.detail ?? `HTTP ${res.status}`);
      notice = "";
      if (body.heard === "woke" || body.heard === "command") awakeWindow = body.awakeMs;
      if (body.awakeMs) awakeUntil = Date.now() + body.awakeMs;
      if (body.heard === "woke") cues.chime("wake");
      else if (body.heard === "command") {
        cues.chime("ok");
        thinking = true;
        show(els.said, `You said: “${body.transcript}”`);
      } else if (body.transcript) {
        if (body.heard === "asleep") {
          els.state.textContent = `Heard “${body.transcript}”. Say “${wake}” first.`;
          els.state.dataset.mode = "asleep";
        } else {
          const tip = body.heard === "ignored" ? `To start a new quest, say “${wake}, …”` : `Start with “${wake}”.`;
          show(els.said, `Heard “${body.transcript}”. ${tip}`);
        }
      }
    } catch (err) {
      const msg = err.name === "AbortError" ? "That took too long. Try again." : err.message;
      notice = `Voice failed: ${msg}`;
      cues.tone(220, 0.25, 0, 0.08);
      setTimeout(() => {
        notice = "";
      }, 5000);
    } finally {
      clearTimeout(timer);
    }
  }

  output.narrator = createNarrator(() => cloudVoice, query);

  const renderQuest = (snap) => {
    wake = snap.wakePhrase || wake;
    cloudVoice = Boolean(snap.cloudVoice);
    const quest = snap.quest;
    const step = quest?.steps[snap.stepIndex];
    els.questTitle.textContent = quest ? quest.title : snap.status === "planning" ? "Planning your quest…" : "No quest yet";
    els.instruction.textContent = step?.instruction ?? (quest ? "Quest complete." : "Your quest and its steps appear here.");
    els.steps.replaceChildren(
      ...(quest?.steps ?? []).map((s, i) => {
        const li = document.createElement("li");
        const mission = snap.missions[i]?.status ?? "locked";
        const mark = STATUS_MARK[mission] ?? String(i + 1);
        li.textContent = `${mark}  ${s.summary || `${s.action} ${s.target}${s.destination ? ` → ${s.destination}` : ""}`}`;
        li.dataset.status = i === snap.stepIndex && snap.status === "active" ? mission : mission === "done" || mission === "skipped" ? mission : "waiting";
        return li;
      }),
    );
    renderShare(snap.share);
    renderState();
  };

  // ---------------------------------------------- sharing a finished quest

  const shareEls = {
    card: document.getElementById("share"),
    title: document.getElementById("share-title"),
    to: document.getElementById("share-to"),
    message: document.getElementById("share-message"),
    send: document.getElementById("share-send"),
    cancel: document.getElementById("share-cancel"),
  };
  const SHARE_TITLES = {
    offer: "Share your accomplishment with a contact?",
    choose_contact: "Who should I send it to? Say their name.",
    pick_option: "Which contact?",
    confirm: "Send this message?",
    sending: "Sending…",
  };

  /** Show the share offer and, before anything is sent, the exact message preview with Send and Cancel. */
  function renderShare(share) {
    if (!shareEls.card) return;
    shareEls.card.hidden = !share;
    if (!share) return;
    shareEls.title.textContent = SHARE_TITLES[share.stage] ?? "Share";
    const service = share.service === "SMS" ? "text message (SMS)" : share.service ? "iMessage" : "";
    const options = share.stage === "pick_option" ? share.options.map((o, i) => `${i + 1}: ${o.name}`).join(" · ") : "";
    show(shareEls.to, share.contactName ? `To ${share.contactName} (${share.handle}) by ${service}` : options);
    show(shareEls.message, share.stage === "confirm" || share.stage === "sending" ? share.message : "");
    shareEls.send.hidden = share.stage !== "confirm";
    shareEls.send.textContent = share.service ? `Send by ${share.service}` : "Send";
    shareEls.cancel.hidden = share.stage === "sending";
  }

  /** The Send and Cancel buttons answer exactly like saying "send it" or "cancel". */
  async function answerShare(text) {
    try {
      const res = await fetch(`/api/game/text${query}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      notice = `Couldn't reach the laptop: ${err.message}`;
      renderState();
    }
  }
  shareEls.send?.addEventListener("click", () => {
    shareEls.send.hidden = true; // one tap, one send
    void answerShare("send it");
  });
  shareEls.cancel?.addEventListener("click", () => void answerShare("cancel"));

  // Only the newest open phone page for this session speaks and listens (the server says which).
  let myClientId = "";
  let speakerId = "";
  const isSpeaker = () => !speakerId || !myClientId || speakerId === myClientId;

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
    else if (e.type === "hello") myClientId = e.clientId;
    else if (e.type === "speaker") {
      speakerId = e.clientId;
      if (!isSpeaker()) {
        output.narrator?.stop();
        cues.update(null);
        notice = "Lumi is talking on another page. Close this tab, or reload it to use it here.";
      } else if (notice.startsWith("Lumi is talking on another page")) notice = "";
      renderState();
    }
    else if (e.type === "say") {
      thinking = false;
      // Mirrors the server: a reply keeps the conversation open.
      if (Date.now() < awakeUntil) awakeUntil = Math.max(awakeUntil, Date.now() + awakeWindow);
      show(els.line, e.text);
      if (els.speakToggle.checked && isSpeaker()) output.narrator.speak(e.id, e.text, e.priority);
    } else if (e.type === "transcript" && e.text) {
      show(els.said, `You said: “${e.text}”`);
    } else if (e.type === "vision_check") {
      const evidence = e.check.evidence?.[0] ? ` — ${e.check.evidence[0]}` : "";
      show(els.verdict, `${e.check.verdict}${evidence}`);
      els.verdict.dataset.verdict = e.check.verdict;
    } else if (e.type === "guide") {
      if (!isSpeaker()) return;
      cues.update(e.guidance);
      const g = e.guidance;
      const text = g.say;
      const now = Date.now();
      if (!text || !els.speakToggle.checked || output.busy()) return;
      const panBucket = g.pan > 0.15 ? "r" : g.pan < -0.15 ? "l" : "c";
      const key = `${g.phase}:${panBucket}`;
      if (key === lastGuideKey && now - lastGuideAt < 5000) return;
      if (now - lastGuideAt < 5000) return;
      lastGuideKey = key;
      lastGuideAt = now;
      output.narrator.speak(e.speakId, text, false);
    }
  };

  els.listenToggle.addEventListener("change", () => {
    listener.enabled = els.listenToggle.checked;
    if (browserListener) browserListener.enabled = els.listenToggle.checked;
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
      output.narrator?.unlock();
      browserListener?.start();
    },
    async listen() {
      if (browserListener?.running) {
        renderState();
        return;
      }
      await startRecorder();
    },
  };
}
