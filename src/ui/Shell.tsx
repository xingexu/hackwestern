"use client";
import { useState } from "react";
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  AudioLines,
  BookOpen,
  ChevronRight,
  FlaskConical,
  Globe2,
  Headphones,
  Layers3,
  LayoutDashboard,
  LockKeyhole,
  MapPin,
  Mic,
  Radio,
  ShieldCheck,
  Sparkles,
  Workflow,
} from "lucide-react";
import { scenarios, Scenario } from "../state/scenarios";
export function Brand() {
  return (
    <span className="brand">
      <span className="brandmark">
        <AudioLines size={25} strokeWidth={2.4} />
      </span>{" "}
      Relay<span className="brandlight">Intake</span>
    </span>
  );
}
export function Nav({ page, go }: { page: string; go: (p: string) => void }) {
  return (
    <aside className="sidebar">
      <div>
        <Brand />
        <div className="navlabel">Workspace</div>
        <nav>
          {[
            ["Studio", LayoutDashboard],
            ["Case library", Layers3],
            ["Field guide", BookOpen],
          ].map(([name, Icon]) => {
            const I = Icon as typeof Activity;
            return (
              <button
                key={String(name)}
                className={page === name ? "navactive" : ""}
                onClick={() => go(String(name))}
              >
                <I size={17} />
                {String(name)}
              </button>
            );
          })}
        </nav>
      </div>
      <div className="sidebarFoot">
        <span className="labmark">
          <FlaskConical size={17} />
        </span>
        <div>
          Sandbox environment<small>Fictional patients only</small>
        </div>
      </div>
    </aside>
  );
}
export function Top({ page }: { page: string }) {
  return (
    <header className="top">
      <div className="crumb">
        Workspace <ChevronRight size={14} /> <b>{page}</b>
      </div>
      <span className="event">
        <span className="dot" /> Hack Western 13
      </span>
    </header>
  );
}
function SignalArt() {
  return (
    <div className="signalart" aria-hidden="true">
      <svg viewBox="0 0 300 170">
        <defs>
          <linearGradient id="wavegrad">
            <stop stopColor="#608a7e" />
            <stop offset=".5" stopColor="#62e0b0" />
            <stop offset="1" stopColor="#417668" />
          </linearGradient>
        </defs>
        <g fill="none" stroke="#68af96" strokeOpacity=".18">
          {[32, 51, 72, 94, 120].map((r) => (
            <ellipse key={r} cx="155" cy="85" rx={r * 1.17} ry={r} />
          ))}
        </g>
        <path d="M0 85H300" stroke="#79c6a5" strokeOpacity=".25" />
        <g stroke="url(#wavegrad)" strokeLinecap="round" strokeWidth="3">
          {Array.from({ length: 63 }, (_, i) => {
            const h =
              2 +
              Math.abs(Math.sin(i * 0.83) * Math.cos(i * 0.19)) *
                Math.sin((Math.PI * i) / 62) ** 2 *
                92;
            return <path key={i} d={`M${13 + i * 4.4} ${85 - h / 2}v${h}`} />;
          })}
        </g>
        <circle cx="89" cy="33" r="3" fill="#c6f2ae" />
        <circle cx="237" cy="105" r="2" fill="#99d9bc" />
      </svg>
      <span>VOICE SIGNAL &nbsp; / &nbsp; 01</span>
    </div>
  );
}
export function Home({
  page,
  go,
  start,
  live,
  resume,
  reset,
  hasKey,
}: {
  page: string;
  go: (p: string) => void;
  start: (s: Scenario) => void;
  live: () => void;
  resume?: () => void;
  reset: () => void;
  hasKey: boolean;
}) {
  const [privateCase, setPrivate] = useState(false);
  return (
    <>
      <div className="pageHeading">
        <span className="eyebrow">
          <span className="miniline" /> Ontario · Care navigation
        </span>
        <h1>{page === "Studio" ? "Intake studio" : page}</h1>
        <p>
          {page === "Studio"
            ? "A multilingual intake workspace for fictional patient stories."
            : page === "Case library"
              ? "Choose a fictional patient to rehearse the interview from start to handoff."
              : "How Relay listens, checks and hands off a fictional case."}
        </p>
      </div>
      {resume && (
        <div className="resume row spread">
          <span>A rehearsal is saved in this tab.</span>
          <div className="row">
            <button onClick={resume}>Resume</button>
            <button onClick={reset}>Discard</button>
          </div>
        </div>
      )}
      {page === "Studio" && (
        <>
          <section className="hero">
            <div>
              <div className="eyebrow">
                <Radio size={14} /> Guided rehearsal
              </div>
              <h2>
                From first words
                <br />
                to the next step.
              </h2>
              <p>
                Listen in the patient’s language. Follow the evidence into a
                care handoff.
              </p>
              <button className="heroBtn" onClick={() => start(scenarios[0])}>
                Start a rehearsal <ArrowRight size={16} />
              </button>
            </div>
            <SignalArt />
          </section>
          <div className="stats">
            {[
              [Globe2, "Language", "Multilingual"],
              [Workflow, "Care pathways", "7 routes"],
              [LockKeyhole, "Note expiry", "30 minutes"],
            ].map(([icon, label, value]) => {
              const I = icon as typeof Activity;
              return (
                <div key={String(label)}>
                  <span className="statIcon">
                    <I size={18} />
                  </span>
                  <span>
                    <small>{String(label)}</small>
                    <b>{String(value)}</b>
                  </span>
                </div>
              );
            })}
          </div>
        </>
      )}
      {page !== "Field guide" ? (
        <>
          <div className="sectionheading">
            <div>
              <div className="eyebrow">Practice workspace</div>
              <h2>
                {page === "Studio" ? "Featured cases" : "Rehearsal cases"}
              </h2>
            </div>
            {page === "Studio" && (
              <button className="textbutton" onClick={() => go("Case library")}>
                View case library <ArrowRight size={15} />
              </button>
            )}
          </div>
          <div className="casegrid">
            {scenarios
              .slice(0, page === "Studio" ? 3 : privateCase ? 7 : 6)
              .map((s, i) => (
                <button
                  className="casecard"
                  key={s.id}
                  onClick={() => start(s)}
                >
                  <div className="row spread">
                    <span className={"caseicon tone" + i}>
                      {i === 0 ? (
                        <Globe2 />
                      ) : i === 1 ? (
                        <Activity />
                      ) : (
                        <Headphones />
                      )}
                    </span>
                    <span className="mono">
                      CASE {String(i + 1).padStart(2, "0")}
                    </span>
                  </div>
                  <h3>{s.title}</h3>
                  <p>{s.blurb}</p>
                  <div className="cardbottom">
                    <span>
                      {s.lang === "zh-CN" ? "中文 · Mandarin" : "EN · English"}
                    </span>
                    <ArrowUpRight size={15} />
                  </div>
                </button>
              ))}
          </div>
          {page === "Case library" && (
            <button
              className="textbutton"
              onClick={() => setPrivate(!privateCase)}
            >
              {privateCase ? "Hide" : "Show"} private support rehearsal
            </button>
          )}
          <section className="liveBanner">
            <span className="statIcon">
              <Mic size={22} />
            </span>
            <div>
              <h3>Gemini interview</h3>
              <p>
                {hasKey
                  ? "Speak or type as an invented patient."
                  : "Explore the intake controls. Configure Gemini to use real voice and text."}
              </p>
            </div>
            <button className="secondary" onClick={live}>
              Open studio <ArrowRight size={15} />
            </button>
          </section>
        </>
      ) : (
        <div className="guide">
          {[
            [
              Mic,
              "01 / Listen",
              "Interview one invented patient at a time. Hold-to-talk limits background noise. No real names or health details.",
            ],
            [
              Activity,
              "02 / Check",
              "The model extracts information. Validated rules—not the model—choose a demo route. Emergency warnings interrupt the interview.",
            ],
            [
              ShieldCheck,
              "03 / Confirm",
              "Read back the story. Corrections stay in the transcript. Unclear cases default to the nurse line unless a more urgent rule applies.",
            ],
            [
              Sparkles,
              "04 / Handoff",
              "Review the English note beside the original words. Share the temporary link only with your demo team.",
            ],
          ].map(([icon, title, txt]) => {
            const I = icon as typeof Activity;
            return (
              <section key={String(title)}>
                <I />
                <h3>{String(title)}</h3>
                <p>{String(txt)}</p>
              </section>
            );
          })}
        </div>
      )}
      <footer>
        <ShieldCheck size={14} /> Research prototype · Not a diagnosis{" "}
        <span>
          <MapPin size={13} /> London, Ontario
        </span>
      </footer>
    </>
  );
}
