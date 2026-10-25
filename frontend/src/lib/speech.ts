/** Narrator: ElevenLabs via `/api/tts/:id` when enabled, else browser speechSynthesis. */

const SILENT_MP3 =
  "data:audio/mpeg;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA//tQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAADhAC7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7//////////////////////////////////////////////////////////////////8AAAAATGF2YzU4LjEzAAAAAAAAAAAAAAAAJAAAAAAAAAAAA4SpmwxxAAAA//sQZAAP8AAAaQAAAAgAAA0gAAABAAABpAAAACAAADSAAAAETEFNRTMuMTAwVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//sQZB4P8AAAaQAAAAgAAA0gAAABAAABpAAAACAAADSAAAAEVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV";

function pickDeviceVoice(): SpeechSynthesisVoice | null {
  if (typeof speechSynthesis === "undefined") return null;
  const voices = speechSynthesis.getVoices();
  const enUs = voices.filter((v) => v.lang === "en-US" || v.lang.startsWith("en-US"));
  const pool = enUs.length ? enUs : voices.filter((v) => v.lang.startsWith("en"));
  const premium = (v: SpeechSynthesisVoice) => /Premium|Enhanced|Natural/i.test(v.name);
  return pool.find(premium) ?? pool.find((v) => v.lang.startsWith("en")) ?? null;
}

class Narrator {
  private voice: SpeechSynthesisVoice | null = null;
  private lastGuideKey = "";
  private lastGuideAt = 0;
  private speakingNarration = false;
  private audio: HTMLAudioElement | null = null;
  private queue: { url: string; text: string }[] = [];
  private cloudPlaying = false;
  private useCloud = false;
  enabled = true;

  constructor() {
    if (typeof speechSynthesis === "undefined") return;
    const pick = () => {
      this.voice = pickDeviceVoice();
    };
    pick();
    speechSynthesis.addEventListener("voiceschanged", pick);
    if (typeof Audio !== "undefined") {
      this.audio = new Audio();
      this.audio.setAttribute("playsinline", "");
    }
  }

  setCloudVoice(on: boolean) {
    this.useCloud = on;
  }

  /** Call inside a tap/click handler once so later speech works on iOS Safari. */
  unlock() {
    if (this.audio) {
      this.audio.volume = 0;
      this.audio.src = SILENT_MP3;
      void this.audio.play().then(() => {
        this.audio!.pause();
        this.audio!.volume = 1;
        this.audio!.removeAttribute("src");
      });
    }
    if (typeof speechSynthesis === "undefined") return;
    const u = new SpeechSynthesisUtterance(" ");
    u.volume = 0;
    speechSynthesis.speak(u);
  }

  /** Narrator lines. `priority` interrupts whatever is playing. */
  say(text: string, priority = false, speakId?: string) {
    if (!this.enabled || !text) return;
    if (this.useCloud && speakId) {
      this.enqueueCloud(speakId, text, priority);
      return;
    }
    this.sayDevice(text, priority);
  }

  /** Short guidance prompts when phase or direction changes (throttled). */
  guide(text: string, speakId: string | undefined, phase: string, pan: number) {
    if (!this.enabled || !text || typeof speechSynthesis === "undefined") return;
    if (this.speakingNarration || speechSynthesis.speaking || this.cloudPlaying) return;
    const now = Date.now();
    const panBucket = pan > 0.15 ? "r" : pan < -0.15 ? "l" : "c";
    const key = `${phase}:${panBucket}`;
    if (key === this.lastGuideKey && now - this.lastGuideAt < 5000) return;
    if (now - this.lastGuideAt < 5000) return;
    this.lastGuideKey = key;
    this.lastGuideAt = now;
    this.say(text, false, speakId);
  }

  stop() {
    this.queue = [];
    this.cloudPlaying = false;
    if (this.audio) {
      this.audio.pause();
      this.audio.removeAttribute("src");
    }
    if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
    this.speakingNarration = false;
  }

  private sayDevice(text: string, priority: boolean) {
    if (typeof speechSynthesis === "undefined") return;
    if (priority) this.stop();
    const u = this.utterance(text, 0.95);
    this.speakingNarration = true;
    u.onend = u.onerror = () => {
      this.speakingNarration = speechSynthesis.pending;
    };
    speechSynthesis.speak(u);
  }

  private enqueueCloud(speakId: string, text: string, priority: boolean) {
    if (!this.audio) {
      this.sayDevice(text, priority);
      return;
    }
    if (priority) this.stop();
    this.queue.push({ url: `/api/tts/${encodeURIComponent(speakId)}`, text });
    this.drainCloud();
  }

  private drainCloud() {
    if (this.cloudPlaying || !this.queue.length || !this.audio) return;
    const next = this.queue.shift()!;
    this.cloudPlaying = true;
    this.speakingNarration = true;
    this.audio.src = next.url;
    this.audio.onended = () => {
      this.cloudPlaying = false;
      this.speakingNarration = false;
      this.drainCloud();
    };
    this.audio.onerror = () => {
      this.cloudPlaying = false;
      this.sayDevice(next.text, false);
      this.drainCloud();
    };
    void this.audio.play().catch(() => {
      this.cloudPlaying = false;
      this.sayDevice(next.text, false);
      this.drainCloud();
    });
  }

  private utterance(text: string, rate: number) {
    const u = new SpeechSynthesisUtterance(text);
    if (this.voice) u.voice = this.voice;
    u.rate = rate;
    u.pitch = 0.98;
    return u;
  }
}

export const narrator = new Narrator();
