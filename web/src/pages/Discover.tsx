import { navigate } from "../lib/journey.ts";
import { useLumi } from "../lib/lumi.tsx";
import { LogoMark } from "../ui/Brand.tsx";
import { Icon, type IconName } from "../ui/Icon.tsx";

/** What the live dashboard shows, in the order Lumi works. */
const LAYERS: { label: string; icon: IconName; text: string }[] = [
  { label: "Perceive", icon: "eye", text: "While a task runs, Lumi reads the newest phone frame every few seconds, looking only for what the step needs." },
  { label: "Understand", icon: "spark", text: "Objects, where they sit from the user's body, and anything hot, sharp, or in the way." },
  { label: "Guide", icon: "compass", text: "Short spoken steps that work by touch, plus beeps that pan toward the target." },
  { label: "Map", icon: "map", text: "An explorable 3D model of the surroundings, built only from what the camera has actually seen." },
];

export function Discover() {
  const { health } = useLumi();
  const wake = health?.agent.wakePhrase ?? "Hi Lumi";
  const scrollTo = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });

  return (
    <div className="landing">
      <section className="hero" aria-labelledby="hero-title">
        <div className="hero-copy">
          <div className="page-kicker">Visual assistance, spoken aloud</div>
          <h1 id="hero-title" tabIndex={-1}>
            See the room.
            <br />
            <em>Hear the way.</em>
          </h1>
          <p className="hero-lede">
            Lumi turns a phone camera into calm, spoken guidance for people who are blind or have low vision. It recognizes what is around them, explains where things are, and
            walks them through everyday tasks one confirmed step at a time.
          </p>
          <div className="hero-actions">
            <button type="button" className="primary large" onClick={() => navigate("begin")}>
              Begin a session <Icon name="arrow" />
            </button>
            <button type="button" className="ghost large" onClick={() => scrollTo("how")}>
              How it works
            </button>
          </div>
          <ul className="hero-trust">
            <li>
              <Icon name="phone" /> Works with the phone they already have
            </li>
            <li>
              <Icon name="mic" /> Hands-free: just say “{wake}”
            </li>
            <li>
              <Icon name="shield" /> Nothing is shared without their OK
            </li>
          </ul>
        </div>
        <HeroVisual />
      </section>

      <section className="statement" aria-label="What Lumi is for">
        <p>
          Not a description of a photo. <strong>A conversation about the space you're standing in.</strong>
        </p>
      </section>

      <section id="how" className="section" aria-labelledby="how-title">
        <div className="section-head">
          <div className="page-kicker">How it works</div>
          <h2 id="how-title">One conversation, four layers of understanding.</h2>
          <p>Each layer feeds the next, and the live dashboard shows all four at once, so you can follow exactly what Lumi perceives, understands, and says.</p>
        </div>
        <ol className="how-rail">
          {LAYERS.map((layer, i) => (
            <li key={layer.label}>
              <div className="how-card">
                <span className="how-top">
                  <span className="how-icon">
                    <Icon name={layer.icon} />
                  </span>
                  <span className="how-num" aria-hidden>
                    0{i + 1}
                  </span>
                </span>
                <strong>{layer.label}</strong>
                <span className="how-text">{layer.text}</span>
              </div>
            </li>
          ))}
        </ol>
        <div className="how-cta">
          <button type="button" className="primary" onClick={() => navigate("live")}>
            Open the live dashboard <Icon name="arrow" />
          </button>
        </div>
      </section>

      <section className="section audiences" aria-labelledby="who-title">
        <div className="section-head">
          <div className="page-kicker">Built for two people</div>
          <h2 id="who-title">Set up once by someone who cares. Used every day, independently.</h2>
        </div>
        <div className="audience-grid">
          <article className="audience-card audience-user">
            <span className="audience-icon">
              <Icon name="mic" />
            </span>
            <h3>For the person using Lumi</h3>
            <ul>
              <li>Everything happens by voice. No screen, no buttons after the first tap.</li>
              <li>Directions from their own body: “at your two o'clock, about an arm's length away.”</li>
              <li>They lead. Lumi answers, suggests, and waits.</li>
            </ul>
          </article>
          <article className="audience-card audience-helper">
            <span className="audience-icon">
              <Icon name="heart" />
            </span>
            <h3>For the person setting it up</h3>
            <ul>
              <li>Scan one code on the same Wi-Fi. Nothing to install on the phone.</li>
              <li>API keys stay on the laptop. The phone never sees them.</li>
              <li>When a task is done, they can choose to message you. Nothing is sent without their confirmation.</li>
            </ul>
          </article>
        </div>
      </section>

      <section className="section trust" aria-labelledby="trust-title">
        <div className="trust-card">
          <div>
            <div className="page-kicker">Honest by design</div>
            <h2 id="trust-title">Lumi says what it knows, and what it doesn't.</h2>
            <p>
              Lumi supplements a cane, a guide dog, and orientation skills. It is not an obstacle-avoidance system, and it tells the user when it isn't sure instead of guessing.
            </p>
          </div>
          <ul className="trust-points">
            <li>
              <Icon name="check" />
              <span>
                <strong>Every step is verified.</strong> A separate Vision Agent answers PASS, FAIL, or UNCERTAIN before a step counts.
              </span>
            </li>
            <li>
              <Icon name="alert" />
              <span>
                <strong>Uncertainty is spoken.</strong> Low-confidence readings are qualified out loud, with a request to pan slowly.
              </span>
            </li>
            <li>
              <Icon name="shield" />
              <span>
                <strong>Keys stay on the laptop.</strong> The phone only talks to the laptop, and nothing is shared without the user's confirmation.
              </span>
            </li>
          </ul>
        </div>
      </section>

      <section className="final-cta" aria-labelledby="cta-title">
        <LogoMark />
        <h2 id="cta-title">Ready when they are.</h2>
        <p>Pair a phone in under two minutes, then start with a single sentence.</p>
        <button type="button" className="primary large" onClick={() => navigate("begin")}>
          Begin a session <Icon name="arrow" />
        </button>
      </section>

      <footer className="landing-footer">
        <span>Lumi · HackTX 2026</span>
        <span>Supplements, never replaces, mobility training.</span>
      </footer>
    </div>
  );
}

/** An illustrated camera view that shows Lumi's loop: detect, place, and speak. */
function HeroVisual() {
  return (
    <div className="hero-visual" aria-hidden>
      <div className="hv-camera">
        <svg className="hv-scene" viewBox="0 0 640 440" preserveAspectRatio="xMidYMid slice">
          <rect width="640" height="440" fill="#e3ebe5" />
          <rect x="360" y="40" width="220" height="170" rx="6" fill="#cfe5e8" />
          <path d="M470 40v170M360 125h220" stroke="#f4f1e9" strokeWidth="8" />
          <circle cx="545" cy="78" r="20" fill="#f6d9a0" opacity=".8" />
          <rect x="0" y="292" width="640" height="148" fill="#d8d2c4" />
          <rect x="40" y="262" width="560" height="26" rx="6" fill="#8b6f55" />
          <rect x="70" y="288" width="18" height="120" fill="#72583f" />
          <rect x="552" y="288" width="18" height="120" fill="#72583f" />
          <path d="M92 262c-6-40 8-70 28-86M110 262c4-34 22-58 44-66M100 262c-18-30-34-44-56-48" stroke="#3f6b55" strokeWidth="9" strokeLinecap="round" fill="none" />
          <rect x="84" y="232" width="40" height="32" rx="5" fill="#c86b4f" />
          <rect x="176" y="214" width="46" height="50" rx="6" fill="#f8f1db" />
          <path d="M222 226c18 0 18 26 0 26" stroke="#f8f1db" strokeWidth="7" fill="none" />
          <path d="M184 204c4-10 0-16 6-24M198 204c4-10 0-16 6-24" stroke="#ffffff" strokeWidth="3" strokeLinecap="round" opacity=".7" />
          <rect x="282" y="246" width="128" height="16" rx="3" fill="#ef7258" />
          <rect x="292" y="232" width="104" height="14" rx="3" fill="#f3c274" />
          <path d="M486 262v-92M486 170l-34-34" stroke="#2c4a43" strokeWidth="7" strokeLinecap="round" />
          <path d="M430 118h56l-14 32h-30z" fill="#2c4a43" />
          <ellipse cx="486" cy="264" rx="30" ry="6" fill="#2c4a43" />
        </svg>
        <span className="hv-scan" />
        <div className="hv-box hv-box-1" style={{ left: "25%", top: "44%", width: "13%", height: "18%" }}>
          <span>Mug · 11 o'clock · within reach</span>
        </div>
        <div className="hv-box hv-box-2" style={{ left: "43%", top: "51%", width: "22%", height: "10%" }}>
          <span>Books · straight ahead</span>
        </div>
        <div className="hv-box hv-box-3" style={{ left: "66%", top: "25%", width: "15%", height: "37%" }}>
          <span>Lamp · 1 o'clock</span>
        </div>
        <div className="hv-chip hv-chip-top">
          <i /> Vision Agent · 3 objects · 1 caution
        </div>
      </div>
      <div className="hv-caption">
        <span className="hv-wave">
          <i />
          <i />
          <i />
          <i />
          <i />
        </span>
        <div>
          <small>Lumi</small>
          <p>The mug is at your eleven o'clock, within reach. It's hot. Rest your left hand on the desk edge and slide it forward slowly.</p>
        </div>
      </div>
      <div className="hv-verify">
        <Icon name="check" /> Step verified · 94% confident
      </div>
    </div>
  );
}
