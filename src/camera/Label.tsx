"use client";
import { useEffect, useRef, useState } from "react";
import { Camera, X, ScanLine } from "lucide-react";
import { post } from "../live/client";
export function Label({
  onSave,
  close,
  enabled,
}: {
  onSave: (name: string, readable: boolean) => void;
  close: () => void;
  enabled: boolean;
}) {
  const [name, setName] = useState(""),
    [status, setStatus] = useState(
      "Use a fictional label without personal details.",
    ),
    [ready, setReady] = useState(false),
    [busy, setBusy] = useState(false),
    [tries, setTries] = useState(0);
  const video = useRef<HTMLVideoElement>(null),
    stream = useRef<MediaStream | null>(null),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      stream.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);
  async function camera() {
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
        audio: false,
      });
      if (!alive.current) {
        s.getTracks().forEach((t) => t.stop());
        return;
      }
      stream.current = s;
      if (video.current) {
        video.current.srcObject = s;
        await video.current.play();
      }
      setReady(true);
      setStatus(
        "Frame the label. Only a single still is sent when you tap Read label.",
      );
    } catch {
      setStatus("Camera unavailable. Type the fictional name below.");
    }
  }
  async function capture() {
    if (!video.current) return;
    setBusy(true);
    try {
      const v = video.current,
        c = document.createElement("canvas");
      c.width = Math.min(900, v.videoWidth);
      c.height = Math.round((c.width * v.videoHeight) / v.videoWidth);
      c.getContext("2d")!.drawImage(v, 0, 0, c.width, c.height);
      const r = await post<{ name: string; readable: boolean }>("label", {
        image: {
          data: c.toDataURL("image/jpeg", 0.75).split(",")[1],
          mimeType: "image/jpeg",
        },
      });
      if (!alive.current) return;
      if (r.readable && r.name) {
        setName(r.name);
        setStatus("Check this reading against the bottle before confirming.");
      } else {
        setTries((t) => t + 1);
        setStatus(
          tries === 0
            ? "Unreadable. Try once more in better light."
            : "Still unreadable. Bring the bottle; do not guess.",
        );
      }
    } catch {
      setStatus("Label service unavailable. Type the name or mark unreadable.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      role="dialog"
      aria-label="Fictional label capture"
      className="modal"
    >
      <div className="modalcard">
        <div className="row spread">
          <span className="eyebrow">
            <Camera size={16} /> Single-frame capture
          </span>
          <button aria-label="Close camera" className="iconbtn" onClick={close}>
            <X />
          </button>
        </div>
        <h2>Read a practice label</h2>
        <p>{status}</p>
        <video ref={video} autoPlay playsInline muted hidden={!ready} />
        {enabled && (
          <button
            className="secondary"
            disabled={busy || tries >= 2}
            onClick={ready ? capture : camera}
          >
            <ScanLine size={16} />
            {busy ? "Reading…" : ready ? "Read label" : "Open camera"}
          </button>
        )}
        {!enabled && (
          <p className="hint">
            Camera transcription requires Gemini. Manual confirmation works
            offline.
          </p>
        )}
        <label>
          Fictional product name
          <input
            maxLength={120}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. DemoMint"
          />
        </label>
        <div className="row wrap">
          <button
            className="primary"
            disabled={!name.trim() || busy}
            onClick={() => onSave(name.trim(), true)}
          >
            Confirm name
          </button>
          <button
            className="secondary"
            onClick={() => onSave("Unreadable — bring the bottle", false)}
          >
            Mark unreadable
          </button>
        </div>
      </div>
    </section>
  );
}
