"use client";
import { useEffect, useState } from "react";
import {
  Activity,
  CheckCircle2,
  ExternalLink,
  HeartHandshake,
  MapPin,
  Phone,
  QrCode,
  ShieldCheck,
} from "lucide-react";
import QR from "qrcode";
import { CaseState } from "../contract";
import { cards } from "../rules";
import facilities from "../rules/facilities.json";
import { lines } from "../note/lines";
import { Evidence } from "../note/Viewer";
import { post } from "../live/client";
export function Outcome({
  s,
  translating,
}: {
  s: CaseState;
  translating: boolean;
}) {
  const route = s.route!,
    c = cards[route],
    em = route === "911",
    crisis = route === "crisis";
  const [link, setLink] = useState(""),
    [qr, setQr] = useState(""),
    [status, setStatus] = useState(""),
    [pending, setPending] = useState(false);
  const pediatric = s.ageBand === "child" || s.ageBand === "infant";
  const kind = route === "er" && pediatric ? "pediatric_er" : route;
  const places = facilities
    .filter((f) => f.route === kind)
    .sort(
      (a, b) =>
        (a.lat - 43.009) ** 2 +
        ((a.lon + 81.276) * 0.73) ** 2 -
        ((b.lat - 43.009) ** 2 + ((b.lon + 81.276) * 0.73) ** 2),
    );
  useEffect(() => {
    if (link)
      QR.toDataURL(link, { width: 156, margin: 2 })
        .then(setQr)
        .catch(() => setStatus("Use the short link below."));
  }, [link]);
  async function share() {
    if (pending || translating) return;
    setPending(true);
    try {
      const r = await post<{ id: string }>("notes", { state: s });
      setLink(location.origin + "/n/" + r.id);
      setStatus(
        "Anyone with this link can read the fictional note for 30 minutes.",
      );
    } catch {
      setStatus("Sharing unavailable. The cited note is available below.");
    } finally {
      setPending(false);
    }
  }
  return (
    <>
      <section
        role={em || crisis ? "alert" : "status"}
        className={"outcome " + (em ? "emergency" : crisis ? "crisis" : "")}
      >
        <span className="eyebrow">
          {em ? (
            <Phone size={16} />
          ) : crisis ? (
            <HeartHandshake size={16} />
          ) : (
            <CheckCircle2 size={16} />
          )}{" "}
          {c.action} / Demo outcome
        </span>
        <h1>{c.title}</h1>
        {s.language.startsWith("zh") && <h2 lang="zh">{c.zh}</h2>}
        <p>{c.reason}</p>
        <div className="small">
          <ShieldCheck size={14} /> This is not a diagnosis. Fictional rehearsal
          only.
        </div>
      </section>
      {places.length > 0 && (
        <section className="panel">
          <span className="eyebrow">
            <MapPin size={15} /> Nearest listed option · from Western campus
          </span>
          <h3>{places[0].name}</h3>
          <p>
            {places[0].address} · London, ON
            <br />
            {places[0].hours}
          </p>
          <a href={places[0].url} target="_blank" rel="noreferrer">
            Check listing <ExternalLink size={13} />
          </a>
          <span className="hint">
            {" "}
            Call ahead: {places[0].phone}. Availability is not live.
          </span>
        </section>
      )}
      <section className="panel">
        <span className="eyebrow">
          <Activity size={15} /> English handoff
        </span>
        <div className="row spread wrap">
          <h2>Evidence note</h2>
          <span className="tag">
            {s.confirmed ? "Patient-confirmed" : "Unconfirmed"}
          </span>
        </div>
        <p>Open a line to see the patient’s own words.</p>
        <Evidence lines={lines(s)} />
        <button
          className="secondary"
          disabled={pending || translating || !!link}
          onClick={share}
        >
          <QrCode size={17} />
          {translating
            ? "Finishing translation…"
            : pending
              ? "Preparing note…"
              : link
                ? "Link created"
                : "Create handoff QR"}
        </button>
        {status && <p role="status">{status}</p>}
        {link && (
          <div className="sharebox">
            {qr && (
              <img
                width="156"
                height="156"
                src={qr}
                alt="QR code for fictional handoff note"
              />
            )}
            <a target="_blank" rel="noreferrer" href={link}>
              {link}
            </a>
          </div>
        )}
      </section>
    </>
  );
}
