"use client";
import { useEffect, useRef, useState } from "react";
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  Camera,
  Check,
  CheckCheck,
  ChevronDown,
  ClipboardList,
  Clock3,
  Globe2,
  Headphones,
  Mic,
  MicOff,
  Radio,
  RotateCcw,
  Send,
  ShieldCheck,
  Square,
  Volume2,
  VolumeX,
} from "lucide-react";
import {
  BodyRegion,
  CaseState,
  ToolCall,
  caseSchema,
  fresh,
  words,
} from "../contract";
import {
  append,
  applyBatch,
  applyTool,
  applyExtraction,
  review,
} from "../state/engine";
import { opening, Scenario, scenarios, playStep } from "../state/scenarios";
import { openLive, LiveController, post } from "../live/client";
import { readback } from "../note/lines";
import { cards } from "../rules";
import { Body } from "./Body";
import { Label } from "../camera/Label";
import { Outcome } from "./Outcome";
import { Home, Nav, Top } from "./Shell";
type Run = {
  s: CaseState;
  id: string;
  step: number;
  started: number;
  expires: number;
};
type Reply = {
  original: string;
  english: string;
  language: string;
  question: string;
  calls: ToolCall[];
};
const cache = "relay-fictional-v1";
function say(line: string, lang: string) {
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const msg = new SpeechSynthesisUtterance(line);
  msg.lang = lang;
  window.speechSynthesis.speak(msg);
}
function silence() {
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
}
const deniedLine =
  "I can't tell you what it is. I can tell you who should look at it, and how soon.";
const condition =
  /\b(diagnosed with|you have (?:a cold|asthma|diabetes|conjunctivitis|pneumonia)|take \d+\s*(?:mg|tablets))\b/i;
export default function Studio({ hasKey }: { hasKey: boolean }) {
  const [page, setPage] = useState("Studio"),
    [run, setRun] = useState<Run | null>(null),
    [saved, setSaved] = useState<Run | null>(null),
    [status, setStatus] = useState(""),
    [busy, setBusy] = useState(false),
    [pendingTranslations, setPendingTranslations] = useState(0),
    [text, setText] = useState(""),
    [camera, setCamera] = useState(false),
    [setup, setSetup] = useState(false),
    [consent, setConsent] = useState(false),
    [lang, setLang] = useState("en-CA"),
    [speak, setSpeak] = useState(false),
    [partial, setPartial] = useState(""),
    [connected, setConnected] = useState(false),
    [talk, setTalk] = useState(false),
    [recording, setRecording] = useState(false),
    [choices, setChoices] = useState(false),
    [region, setRegion] = useState<BodyRegion | null>(null);
  const ref = useRef<Run | null>(null),
    generation = useRef(0),
    ctrl = useRef<LiveController | null>(null),
    handle = useRef(""),
    reconnects = useRef(0),
    rec = useRef<MediaRecorder | null>(null),
    recTimer = useRef<ReturnType<typeof setTimeout> | null>(null),
    release = useRef<(() => void) | null>(null),
    starting = useRef(false),
    inFlight = useRef(false),
    candidate = useRef({ language: "", count: 0 }),
    noTools = useRef(0),
    lastSource = useRef(-1),
    liveBase = useRef<CaseState | null>(null),
    speaker = useRef(false);
  const update = (n: Run | null) => {
    ref.current = n;
    setRun(n);
  };
  function patch(fn: (s: CaseState) => CaseState) {
    const r = ref.current;
    if (r) update({ ...r, s: fn(r.s) });
  }
  function stopMedia() {
    ctrl.current?.stop();
    ctrl.current = null;
    setConnected(false);
    setTalk(false);
    const m = rec.current;
    if (m && m.state !== "inactive") m.stop();
    m?.stream.getTracks().forEach((t) => t.stop());
    rec.current = null;
    setRecording(false);
    if (recTimer.current) clearTimeout(recTimer.current);
    silence();
    setPartial("");
  }
  function clear() {
    generation.current++;
    stopMedia();
    setPendingTranslations(0);
    release.current?.();
    release.current = null;
    inFlight.current = false;
    setBusy(false);
    update(null);
    setSaved(null);
    setSetup(false);
    setConsent(false);
    setCamera(false);
    setRegion(null);
    setText("");
    setStatus("");
    setChoices(false);
    handle.current = "";
    reconnects.current = 0;
    lastSource.current = -1;
    noTools.current = 0;
    liveBase.current = null;
    candidate.current = { language: "", count: 0 };
    try {
      sessionStorage.removeItem(cache);
    } catch {}
  }
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(cache);
      if (raw) {
        const v = JSON.parse(raw);
        if (
          v.expires > Date.now() &&
          caseSchema.safeParse(v.s).success &&
          (v.id === "live" || scenarios.some((s) => s.id === v.id)) &&
          Number.isInteger(v.step)
        )
          setSaved(v);
        else sessionStorage.removeItem(cache);
      }
    } catch {}
    return () => {
      generation.current++;
      ctrl.current?.stop();
      rec.current?.stream.getTracks().forEach((t) => t.stop());
      release.current?.();
      silence();
    };
  }, []);
  useEffect(() => {
    if (run)
      try {
        sessionStorage.setItem(cache, JSON.stringify(run));
      } catch {}
  }, [run]);
  useEffect(() => {
    if (!run && !saved) return;
    const t = setTimeout(
      clear,
      Math.max(0, (run ?? saved)!.expires - Date.now()),
    );
    return () => clearTimeout(t);
  }, [run?.expires, saved?.expires]);
  const ended = run?.s.route,
    reviewing = run?.s.review;
  useEffect(() => {
    if (ended || reviewing) {
      stopMedia();
      setCamera(false);
      setRegion(null);
      if (speaker.current && ref.current) {
        const s = ref.current.s;
        say(
          ended
            ? s.language.startsWith("zh")
              ? cards[ended].zh
              : cards[ended].title
            : readback(s),
          s.language,
        );
      }
    }
  }, [ended, reviewing]);
  useEffect(() => {
    if (!run || run.s.route || run.s.review) return;
    const t = setTimeout(
      () => patch((s) => applyTool(s, { name: "finish_intake", args: {} })),
      Math.max(0, run.started + 480_000 - Date.now()),
    );
    return () => clearTimeout(t);
  }, [run?.started, ended, reviewing]);
  useEffect(() => {
    if (!run || run.id !== "live" || run.s.route || run.s.review || busy)
      return;
    const a = setTimeout(
        () =>
          setStatus(
            "Take your time. You can speak, type, or use the body map.",
          ),
        8000,
      ),
      b = setTimeout(() => setChoices(true), 16000);
    return () => {
      clearTimeout(a);
      clearTimeout(b);
    };
  }, [run, busy]);
  async function own() {
    if (!navigator.locks) return true;
    return new Promise<boolean>((resolve) => {
      void navigator.locks
        .request("relay-active-intake", { ifAvailable: true }, async (lock) => {
          if (!lock) {
            resolve(false);
            return;
          }
          await new Promise<void>((done) => {
            release.current = done;
            resolve(true);
          });
        })
        .catch(() => resolve(false));
    });
  }
  async function start(sc?: Scenario, restore?: Run) {
    if (starting.current || ref.current) return;
    starting.current = true;
    try {
      if (!(await own())) {
        setStatus("A rehearsal is active in another tab. End it there first.");
        return;
      }
      let s = fresh(sc?.lang ?? lang);
      s = append(s, {
        speaker: "ai",
        original: opening(s.language),
        english: opening("en-CA"),
      });
      update(
        restore ?? {
          s,
          id: sc?.id ?? "live",
          step: 0,
          started: Date.now(),
          expires: Date.now() + 1800000,
        },
      );
      setSaved(null);
      setSetup(false);
      setStatus("");
      setPage("Studio");
      setChoices(false);
      if (speaker.current) say(opening(s.language), s.language);
    } finally {
      starting.current = false;
    }
  }
  function next() {
    const r = ref.current;
    if (!r || r.s.route || r.s.review) return;
    const st = scenarios.find((sc) => sc.id === r.id)?.steps[r.step];
    if (!st) return;
    const n = playStep(r.s, st);
    update({ ...r, s: n, step: r.step + 1 });
    setStatus("");
    if (speaker.current && !n.route && !n.review) say(st.next, n.language);
  }
  function pinLanguage(s: CaseState, detected: string, index: number) {
    if (!s.transcript.slice(0, index).some((t) => t.speaker === "patient"))
      s = { ...s, language: detected };
    else if (detected.split("-")[0] !== s.language.split("-")[0]) {
      candidate.current =
        candidate.current.language === detected
          ? { language: detected, count: candidate.current.count + 1 }
          : { language: detected, count: 1 };
      if (candidate.current.count >= 2) s = { ...s, language: detected };
    } else candidate.current = { language: "", count: 0 };
    return s;
  }
  function elicited(s: CaseState, reply: Reply, index: number) {
    s = pinLanguage(s, reply.language, index);
    let q = reply.question;
    const unsafe = condition.test(q);
    if (unsafe) {
      q = deniedLine;
      setStatus("A model response was replaced. No diagnosis is provided.");
    }
    const calls = reply.calls.filter(
      (c) => !("sourceTurn" in c.args) || c.args.sourceTurn === index,
    );
    let n = applyBatch(s, calls);
    if (
      !n.route &&
      calls.some(
        (c) => c.name === "request_camera" && c.args.purpose === "label",
      )
    )
      setCamera(true);
    if (!n.route && !n.review && q)
      n = append(n, {
        speaker: "ai",
        original: q,
        english: n.language.startsWith("en") ? q : "",
      });
    return n;
  }
  async function send(audio?: { mimeType: string; data: string }) {
    const r = ref.current;
    if (
      !r ||
      r.s.route ||
      r.s.review ||
      inFlight.current ||
      (!text.trim() && !audio)
    )
      return;
    const message = text.trim(),
      g = generation.current;
    inFlight.current = true;
    setBusy(true);
    setStatus("");
    try {
      if (!hasKey) {
        if (audio) throw Error("Use text without Gemini.");
        let s = append(r.s, {
          speaker: "patient",
          original: message,
          english: r.s.language.startsWith("en") ? message : "",
        });
        s = append(s, {
          speaker: "ai",
          original:
            "Saved verbatim. No automated extraction without Gemini. Select a safety check or review.",
          english: "",
        });
        patch(() => s);
        setChoices(true);
        setText("");
        return;
      }
      const response = await post<Reply>("intake", {
        state: r.s,
        ...(audio ? { audio } : { text: message }),
      });
      if (
        g !== generation.current ||
        ref.current?.s.route ||
        ref.current?.s.review
      )
        return;
      const base = ref.current!.s,
        i = base.transcript.length;
      const n = elicited(
        append(base, {
          speaker: "patient",
          original: response.original,
          english: response.english,
        }),
        response,
        i,
      );
      patch(() => n);
      setText("");
      if (speaker.current && !n.route && !n.review)
        say(n.transcript.at(-1)?.original || "", n.language);
    } catch (e) {
      if (g === generation.current)
        setStatus(
          e instanceof Error
            ? e.message
            : "Gemini unavailable. Use the rehearsal cases.",
        );
    } finally {
      if (g === generation.current) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  }
  async function connect() {
    const r = ref.current;
    if (!r || inFlight.current || ctrl.current) return;
    const g = generation.current;
    inFlight.current = true;
    setBusy(true);
    setStatus("Connecting to Gemini Live…");
    try {
      const c = await openLive(
        r.s,
        {
          caption: (who, line, final) => {
            if (
              g !== generation.current ||
              ref.current?.s.route ||
              ref.current?.s.review
            )
              return;
            setPartial(final ? "" : line);
            if (!final) return;
            const s = ref.current!.s;
            if (who === "ai" && condition.test(line))
              setStatus(
                "A model response was corrected. Relay cannot diagnose or advise treatment.",
              );
            if (who === "patient") {
              lastSource.current = s.transcript.length;
              liveBase.current = s;
              noTools.current++;
            }
            patch((s) =>
              append(s, {
                speaker: who,
                original:
                  who === "ai" && condition.test(line) ? deniedLine : line,
                english:
                  who === "ai" && s.language.startsWith("en") ? line : "",
              }),
            );
            if (who === "patient") {
              const idx = lastSource.current,
                base = liveBase.current!;
              setPendingTranslations((n) => n + 1);
              void post<Reply>("intake", { state: base, text: line })
                .then((reply) => {
                  if (g !== generation.current || !ref.current) return;
                  patch((current) => {
                    const transcript = current.transcript.map((t, i) =>
                      i === idx ? { ...t, english: reply.english } : t,
                    );
                    const next =
                      idx === lastSource.current
                        ? pinLanguage(
                            { ...current, transcript },
                            reply.language,
                            idx,
                          )
                        : { ...current, transcript };
                    const watchdog =
                      noTools.current >= 2 && idx === lastSource.current;
                    if (watchdog) noTools.current = 0;
                    return applyExtraction(next, reply.calls, idx, watchdog);
                  });
                })
                .catch(() => {
                  if (g === generation.current)
                    setStatus(
                      "Translation unavailable. Keep the original words in the handoff.",
                    );
                })
                .finally(() => {
                  if (g === generation.current)
                    setPendingTranslations((n) => Math.max(0, n - 1));
                });
            }
          },
          tools: (calls) => {
            if (g !== generation.current || !ref.current || ref.current.s.route)
              return;
            noTools.current = 0;
            const n = applyBatch(
              ref.current.s,
              calls.map((c) => ({
                ...c,
                args:
                  "sourceTurn" in c.args
                    ? { ...c.args, sourceTurn: lastSource.current }
                    : c.args,
              })),
            );
            patch(() => n);
            if (
              !n.route &&
              calls.some(
                (c) =>
                  c.name === "request_camera" && c.args.purpose === "label",
              )
            )
              setCamera(true);
            if (n.route) ctrl.current?.stop();
          },
          lost: (msg) => {
            if (g !== generation.current) return;
            ctrl.current = null;
            setConnected(false);
            setTalk(false);
            setStatus(msg + " Reconnect voice, record a turn, or type.");
            patch((s) => ({ ...s, mode: "text" }));
            if (handle.current && reconnects.current < 1) {
              reconnects.current++;
              setStatus("Reconnecting voice. Your case is preserved.");
              setTimeout(() => {
                if (
                  g === generation.current &&
                  !ref.current?.s.route &&
                  !ref.current?.s.review
                )
                  void connect();
              }, 800);
            }
          },
          resume: (h) => {
            handle.current = h;
          },
        },
        handle.current || undefined,
      );
      if (
        g !== generation.current ||
        ref.current?.s.route ||
        ref.current?.s.review
      ) {
        c.stop();
        return;
      }
      ctrl.current = c;
      setConnected(true);
      setStatus("Voice ready. Tap the microphone to start and stop each turn.");
      patch((s) => ({ ...s, mode: "push_to_talk" }));
    } catch {
      if (g === generation.current) {
        setStatus(
          "Voice unavailable or microphone blocked. Record a turn or type instead.",
        );
        patch((s) => ({ ...s, mode: "text" }));
      }
    } finally {
      if (g === generation.current) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  }
  async function record() {
    if (recording) {
      rec.current?.stop();
      return;
    }
    if (inFlight.current) return;
    const g = generation.current;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true },
      });
      if (
        g !== generation.current ||
        ref.current?.s.review ||
        ref.current?.s.route
      ) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      const recorder = new MediaRecorder(stream);
      rec.current = recorder;
      const chunks: BlobPart[] = [];
      recorder.ondataavailable = (e) => chunks.push(e.data);
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        if (recTimer.current) clearTimeout(recTimer.current);
        setRecording(false);
        if (
          g !== generation.current ||
          ref.current?.s.route ||
          ref.current?.s.review
        )
          return;
        const reader = new FileReader();
        reader.onload = () => {
          if (g === generation.current)
            void send({
              data: String(reader.result).split(",")[1],
              mimeType: recorder.mimeType.split(";")[0],
            });
        };
        reader.readAsDataURL(new Blob(chunks, { type: recorder.mimeType }));
      };
      recorder.start();
      setRecording(true);
      recTimer.current = setTimeout(() => {
        if (recorder.state === "recording") recorder.stop();
      }, 25000);
    } catch {
      setStatus(
        "Microphone unavailable. Type your fictional response instead.",
      );
    }
  }
  function manual(code: "chest_pain" | "self_harm_thoughts" | "other") {
    const original =
      code === "chest_pain"
        ? "I have chest pressure now."
        : code === "self_harm_thoughts"
          ? "I have had thoughts of hurting myself."
          : "I don't know.";
    patch((s) => {
      const i = s.transcript.length;
      let n = append(s, { speaker: "patient", original, english: original });
      return applyTool(n, {
        name: "record_finding",
        args: { code, present: true, sourceTurn: i },
      });
    });
  }
  const s = run?.s,
    sc = scenarios.find((v) => v.id === run?.id),
    step = sc?.steps[run?.step ?? 0];
  function speakToggle() {
    const on = !speak;
    setSpeak(on);
    speaker.current = on;
    if (!on) silence();
    else if (s)
      say(
        s.route
          ? cards[s.route].title
          : s.review
            ? readback(s)
            : (s.transcript.at(-1)?.original ?? ""),
        s.language,
      );
  }
  return (
    <div className="frame">
      <Nav
        page={run ? "Studio" : page}
        go={(p) => {
          if (run) {
            setStatus("Use Start over to leave this rehearsal.");
            return;
          }
          setPage(p);
        }}
      />
      <main>
        <Top page={run ? "Interview" : page} />
        <div className="content">
          {status && !run && (
            <div className="notice" role="status">
              {status}
            </div>
          )}
          {!run || !s ? (
            <Home
              page={page}
              go={setPage}
              start={start}
              live={() => setSetup(true)}
              resume={saved ? () => start(undefined, saved) : undefined}
              reset={clear}
              hasKey={hasKey}
            />
          ) : (
            <>
              <div className="row spread sessionBar">
                <button className="textbutton" onClick={clear}>
                  <ArrowLeft size={16} /> Start over
                </button>
                <button className="secondary compact" onClick={speakToggle}>
                  {speak ? <Volume2 size={15} /> : <VolumeX size={15} />}{" "}
                  {speak ? "Speech on" : "Speech off"}
                </button>
              </div>
              {s.route ? (
                <Outcome s={s} translating={pendingTranslations > 0} />
              ) : (
                <>
                  <div className="eyebrow">
                    <span className="dot" />{" "}
                    {sc ? "Scripted rehearsal" : "Fictional patient interview"}
                  </div>
                  <h1>{sc?.title ?? "Live intake"}</h1>
                  <p className="subtitle">
                    {sc?.person ?? "Sandbox session"} · {s.language} · This is
                    not a diagnosis.
                  </p>
                  <div className="interviewGrid">
                    <div>
                      <section className="panel chat">
                        <div className="row spread">
                          <span className="eyebrow">
                            <Radio size={15} /> Conversation
                          </span>
                          <span className="tag">
                            {sc
                              ? "Rehearsal"
                              : connected
                                ? "Gemini Live"
                                : hasKey
                                  ? "Gemini text"
                                  : "Manual"}
                          </span>
                        </div>
                        <div role="log" className="transcript">
                          {s.transcript.map((t, i) => (
                            <div className={"turn " + t.speaker} key={i}>
                              <small>
                                {t.speaker === "ai" ? "Relay" : "Patient"} ·{" "}
                                {String(i + 1).padStart(2, "0")}
                              </small>
                              <div dir="auto">{t.original}</div>
                              {t.english && t.original !== t.english && (
                                <em>{t.english}</em>
                              )}
                            </div>
                          ))}
                          {partial && (
                            <div className="hint" dir="auto">
                              {partial}
                            </div>
                          )}
                        </div>
                        {s.review ? (
                          <div className="review">
                            <span className="eyebrow">
                              <CheckCheck size={15} /> Read-back
                            </span>
                            <p dir="auto">{readback(s)}</p>
                            {pendingTranslations > 0 && (
                              <p role="status">
                                Finishing the English translation…
                              </p>
                            )}
                            <div className="row wrap">
                              <button
                                className="primary"
                                onClick={() => patch((s) => review(s, true))}
                                disabled={pendingTranslations > 0}
                              >
                                <Check size={16} />
                                {s.language.startsWith("zh")
                                  ? "确认 · Confirm"
                                  : "Yes, that’s right"}
                              </button>
                              <button
                                className="secondary"
                                onClick={() => {
                                  patch((s) => review(s, false));
                                  setStatus(
                                    "Tell us what to correct. After two rejected summaries, use the nurse line.",
                                  );
                                }}
                              >
                                Correct something
                              </button>
                            </div>
                          </div>
                        ) : (
                          <>
                            {sc && step ? (
                              <div className="script">
                                <div className="eyebrow">
                                  <ClipboardList size={14} /> Scripted patient
                                  line
                                </div>
                                <p dir="auto">{step.line}</p>
                                <button className="primary" onClick={next}>
                                  Use this line <ArrowRight size={16} />
                                </button>
                              </div>
                            ) : (
                              <>
                                <label className="inputlabel" htmlFor="reply">
                                  Fictional patient’s reply
                                </label>
                                <form
                                  className="composer"
                                  onSubmit={(e) => {
                                    e.preventDefault();
                                    void send();
                                  }}
                                >
                                  <input
                                    id="reply"
                                    maxLength={1800}
                                    value={text}
                                    onChange={(e) => setText(e.target.value)}
                                    placeholder="Type a response…"
                                    disabled={busy || connected || recording}
                                  />
                                  <button
                                    aria-label="Send response"
                                    disabled={
                                      !text.trim() ||
                                      busy ||
                                      connected ||
                                      recording
                                    }
                                  >
                                    <Send size={17} />
                                  </button>
                                </form>
                                {hasKey && (
                                  <div className="row wrap">
                                    <button
                                      className="secondary"
                                      disabled={busy || recording}
                                      onClick={
                                        connected
                                          ? () => {
                                              if (talk) ctrl.current?.pause();
                                              else ctrl.current?.talk();
                                              setTalk(!talk);
                                            }
                                          : connect
                                      }
                                    >
                                      {talk ? (
                                        <Square size={14} />
                                      ) : (
                                        <Mic size={15} />
                                      )}{" "}
                                      {busy
                                        ? "Working…"
                                        : connected
                                          ? talk
                                            ? "End turn"
                                            : "Speak a turn"
                                          : "Connect live voice"}
                                    </button>
                                    {!connected && (
                                      <button
                                        className="textbutton"
                                        disabled={busy}
                                        onClick={record}
                                      >
                                        {recording
                                          ? "Stop & send"
                                          : "Record one turn"}
                                      </button>
                                    )}
                                    {connected && (
                                      <button
                                        className="textbutton"
                                        onClick={stopMedia}
                                      >
                                        <MicOff size={14} /> Type instead
                                      </button>
                                    )}
                                  </div>
                                )}
                              </>
                            )}
                            <div className="toolrow">
                              <button onClick={() => setCamera(true)}>
                                <Camera size={15} /> Add label
                              </button>
                              <button
                                disabled={busy || recording}
                                onClick={() =>
                                  patch((s) =>
                                    applyTool(s, {
                                      name: "finish_intake",
                                      args: {},
                                    }),
                                  )
                                }
                              >
                                <CheckCheck size={15} /> Review case
                              </button>
                            </div>
                            {!sc && (
                              <details
                                open={choices}
                                onToggle={(e) =>
                                  setChoices(e.currentTarget.open)
                                }
                              >
                                <summary>Tap an answer instead</summary>
                                <div className="row wrap">
                                  {(
                                    [
                                      "chest_pain",
                                      "self_harm_thoughts",
                                      "other",
                                    ] as const
                                  ).map((code, i) => (
                                    <button
                                      className="secondary compact"
                                      key={code}
                                      onClick={() => manual(code)}
                                    >
                                      {
                                        [
                                          "Chest pressure now",
                                          "Need crisis support",
                                          "I’m not sure",
                                        ][i]
                                      }
                                    </button>
                                  ))}
                                </div>
                              </details>
                            )}
                          </>
                        )}
                      </section>
                      {status && (
                        <p className="notice" role="status">
                          {status}
                        </p>
                      )}
                    </div>
                    <div>
                      <section className="panel casePanel">
                        <span className="eyebrow">
                          <Activity size={15} /> Live case panel
                        </span>
                        <h3>
                          {s.subject === "other"
                            ? "Speaking for someone else"
                            : "Patient account"}
                        </h3>
                        <p>
                          {s.ageBand ? words(s.ageBand) : "Age not recorded"} ·{" "}
                          {s.pregnant === true
                            ? "Pregnancy reported"
                            : "Fictional patient"}
                        </p>
                        <Body s={s} onPick={s.review ? undefined : setRegion} />
                        {s.rejections > 0 &&
                          !s.review &&
                          s.findings.length > 0 && (
                            <div className="notice">
                              <b>Correct a finding</b>
                              <p>
                                Tap an incorrect entry to reverse it before
                                reviewing again.
                              </p>
                              {s.findings.map((f) => (
                                <button
                                  key={f.code + (f.bodyRegion ?? "")}
                                  className="secondary compact"
                                  onClick={() =>
                                    patch((current) => {
                                      const original =
                                        (f.present
                                          ? "I did not report "
                                          : "I did report ") +
                                        words(f.code) +
                                        (f.bodyRegion
                                          ? " at " + words(f.bodyRegion)
                                          : "") +
                                        ".";
                                      const i = current.transcript.length;
                                      return applyTool(
                                        append(current, {
                                          speaker: "patient",
                                          original,
                                          english: original,
                                        }),
                                        {
                                          name: "record_finding",
                                          args: {
                                            ...f,
                                            present: !f.present,
                                            sourceTurn: i,
                                          },
                                        },
                                      );
                                    })
                                  }
                                >
                                  {f.present ? "Remove" : "Affirm"}{" "}
                                  {words(f.code)}
                                </button>
                              ))}
                            </div>
                          )}
                        {region && (
                          <div className="notice">
                            Confirm location: {words(region)}?{" "}
                            <button
                              onClick={() => {
                                patch((s) =>
                                  applyTool(
                                    append(s, {
                                      speaker: "patient",
                                      original:
                                        "I confirm the location: " +
                                        words(region),
                                      english:
                                        "I confirm the location: " +
                                        words(region),
                                    }),
                                    {
                                      name: "mark_body_location",
                                      args: { bodyRegion: region },
                                    },
                                  ),
                                );
                                setRegion(null);
                              }}
                            >
                              Confirm
                            </button>{" "}
                            <button onClick={() => setRegion(null)}>
                              Cancel
                            </button>
                          </div>
                        )}
                        <h4>
                          <Clock3 size={14} /> Findings timeline
                        </h4>
                        {s.findings
                          .filter((f) => f.present)
                          .map((f) => (
                            <div
                              className="fact"
                              key={f.code + (f.bodyRegion || "")}
                            >
                              <b>{words(f.code)}</b>
                              <small>
                                {[
                                  f.onset,
                                  f.severity && f.severity + "/5",
                                  "Turn " + (f.sourceTurn + 1),
                                ]
                                  .filter(Boolean)
                                  .join(" · ")}
                              </small>
                            </div>
                          ))}
                        {!s.findings.some((f) => f.present) && (
                          <p className="hint">
                            Waiting for a reported finding.
                          </p>
                        )}
                        <h4>
                          <ShieldCheck size={14} /> Explicitly denied
                        </h4>
                        <div className="row wrap">
                          {s.findings
                            .filter((f) => !f.present)
                            .map((f) => (
                              <span
                                className="tag"
                                key={f.code + (f.bodyRegion || "")}
                              >
                                ✓ {words(f.code)}
                              </span>
                            ))}
                        </div>
                        {!s.findings.some((f) => !f.present) && (
                          <p className="hint">No denials recorded.</p>
                        )}
                        <h4>
                          <ClipboardList size={14} /> Medicines & allergies
                        </h4>
                        <p>
                          {[
                            ...s.medications.map((m) => m.name),
                            ...s.allergies,
                          ].join(" · ") || "None recorded."}
                        </p>
                      </section>
                    </div>
                  </div>
                </>
              )}
            </>
          )}
          {setup && (
            <div role="dialog" aria-label="Enter the sandbox" className="modal">
              <div className="modalcard">
                <span className="eyebrow">
                  <Globe2 size={15} /> Gemini workspace
                </span>
                <h2>Enter the sandbox</h2>
                <p>
                  Use an invented story only. If configured, audio, text and
                  requested stills go to Google Gemini. No diagnosis or
                  treatment advice.
                </p>
                <label>
                  Starting language
                  <select
                    value={lang}
                    onChange={(e) => setLang(e.target.value)}
                  >
                    <option value="en-CA">English</option>
                    <option value="zh-CN">中文 · Mandarin</option>
                    <option value="fr-CA">Français</option>
                    <option value="es">Español</option>
                  </select>
                </label>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={consent}
                    onChange={(e) => setConsent(e.target.checked)}
                  />{" "}
                  I will use fictional patient data only.
                </label>
                <div className="row">
                  <button
                    className="primary"
                    disabled={!consent}
                    onClick={() => start()}
                  >
                    Start interview <ArrowRight size={15} />
                  </button>
                  <button className="secondary" onClick={() => setSetup(false)}>
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          )}
          {camera && s && !s.route && (
            <Label
              enabled={hasKey}
              close={() => setCamera(false)}
              onSave={(name, readable) => {
                patch((s) => {
                  const i = s.transcript.length;
                  const original = "I confirm this practice label: " + name;
                  return applyTool(
                    append(s, {
                      speaker: "patient",
                      original,
                      english: original,
                    }),
                    {
                      name: "add_medication",
                      args: { name, readable, sourceTurn: i },
                    },
                  );
                });
                setCamera(false);
              }}
            />
          )}
        </div>
      </main>
    </div>
  );
}
