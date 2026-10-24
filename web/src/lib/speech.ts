/** Narrator voice via the browser's speechSynthesis. Must be unlocked by a user gesture on iOS. */
class Narrator {
  private voice: SpeechSynthesisVoice | null = null;
  private lastGuidance = "";
  private lastGuidanceAt = 0;
  private speakingNarration = false;
  enabled = true;

  constructor() {
    if (typeof speechSynthesis === "undefined") return;
    const pick = () => {
      const voices = speechSynthesis.getVoices();
      this.voice =
        voices.find((v) => /Daniel|Arthur|Google UK English Male/i.test(v.name)) ??
        voices.find((v) => v.lang === "en-GB") ??
        voices.find((v) => v.lang.startsWith("en")) ??
        null;
    };
    pick();
    speechSynthesis.addEventListener("voiceschanged", pick);
  }

  /** Call inside a tap/click handler once so later speech works on iOS Safari. */
  unlock() {
    if (typeof speechSynthesis === "undefined") return;
    const u = new SpeechSynthesisUtterance(" ");
    u.volume = 0;
    speechSynthesis.speak(u);
  }

  /** Narrator lines. `priority` interrupts whatever is playing. */
  say(text: string, priority = false) {
    if (!this.enabled || !text || typeof speechSynthesis === "undefined") return;
    if (priority) speechSynthesis.cancel();
    const u = this.utterance(text, 1.02);
    this.speakingNarration = true;
    u.onend = u.onerror = () => {
      this.speakingNarration = speechSynthesis.pending;
    };
    speechSynthesis.speak(u);
  }

  /** Short guidance prompts. Dropped while the narrator is talking, and throttled when repeated. */
  guide(text: string, minGapMs = 2500) {
    if (!this.enabled || !text || typeof speechSynthesis === "undefined") return;
    if (this.speakingNarration || speechSynthesis.speaking) return;
    const now = Date.now();
    const repeatGap = text === this.lastGuidance ? minGapMs * 2 : minGapMs;
    if (now - this.lastGuidanceAt < repeatGap) return;
    this.lastGuidance = text;
    this.lastGuidanceAt = now;
    speechSynthesis.speak(this.utterance(text, 1.12));
  }

  stop() {
    if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
    this.speakingNarration = false;
  }

  private utterance(text: string, rate: number) {
    const u = new SpeechSynthesisUtterance(text);
    if (this.voice) u.voice = this.voice;
    u.rate = rate;
    u.pitch = 0.95;
    return u;
  }
}

export const narrator = new Narrator();
