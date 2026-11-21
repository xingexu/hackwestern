import { useState } from "react";
import { MapPin, ScanLine } from "lucide-react";
import { BodyRegion, CaseState, regions, words } from "../contract";
const points: Record<BodyRegion, [number, number]> = {
  head: [90, 17],
  eyes: [90, 27],
  ears: [73, 29],
  mouth_throat: [90, 37],
  neck: [90, 49],
  chest: [90, 75],
  upper_back: [90, 72],
  lower_back: [90, 102],
  abdomen_upper: [90, 95],
  abdomen_lower: [90, 111],
  pelvis: [90, 129],
  left_arm: [126, 89],
  right_arm: [54, 89],
  left_hand: [141, 132],
  right_hand: [39, 132],
  left_leg: [104, 171],
  right_leg: [76, 171],
  left_foot: [109, 215],
  right_foot: [71, 215],
  skin_general: [112, 63],
};
export function Body({
  s,
  onPick,
}: {
  s: CaseState;
  onPick?: (r: BodyRegion) => void;
}) {
  const [side, setSide] = useState(false);
  const marked = new Set(
    [
      ...s.findings.filter((f) => f.present).map((f) => f.bodyRegion),
      s.location,
    ].filter(Boolean),
  );
  return (
    <div className="bodyPane">
      <div className="row spread">
        <span className="eyebrow">
          <ScanLine size={14} /> Body map
        </span>
        <button className="textbutton" onClick={() => setSide(!side)}>
          {side ? "Back" : "Front"} ↻
        </button>
      </div>
      <svg
        viewBox="0 0 180 234"
        aria-label="Body regions"
        className="bodyFigure"
      >
        <defs>
          <pattern
            id="grid"
            width="15"
            height="15"
            patternUnits="userSpaceOnUse"
          >
            <circle cx="1" cy="1" r=".8" fill="#c4d5cf" />
          </pattern>
        </defs>
        <rect width="180" height="234" fill="url(#grid)" />
        <g fill="#d7e5df" stroke="#a9bfb5" strokeWidth="1.5">
          <ellipse cx="90" cy="26" rx="16" ry="20" />
          <path d="M83 45v6L67 56Q60 58 57 68L39 118l-5 16q0 8 8 6l9-14 14-35 5-12 2 29-6 30 2 35-4 39-5 7q0 6 14 3l7-9 5-41 5-30 5 30 5 41 7 9q14 3 14-3l-5-7-4-39 2-35-6-30 2-29 5 12 14 35 9 14q8 2 8-6l-5-16-18-50q-3-10-10-12l-16-5v-6" />
        </g>
        {regions
          .filter((r) =>
            side
              ? [
                  "head",
                  "neck",
                  "upper_back",
                  "lower_back",
                  "left_arm",
                  "right_arm",
                  "left_leg",
                  "right_leg",
                ].includes(r)
              : !r.includes("back"),
          )
          .map((r) => {
            const [x, y] = points[r];
            return (
              <g
                key={r}
                id={r}
                onClick={() => onPick?.(r)}
                className={onPick ? "hotspot" : ""}
              >
                <title>{words(r)}</title>
                <circle
                  cx={x}
                  cy={y}
                  r="7"
                  fill={marked.has(r) ? "#188466" : "transparent"}
                />
                <circle
                  cx={x}
                  cy={y}
                  r={marked.has(r) ? 3 : 1.5}
                  fill={marked.has(r) ? "white" : "#92ada0"}
                />
              </g>
            );
          })}
      </svg>
      <div className="small">
        <MapPin size={13} />{" "}
        {Array.from(marked)
          .map((r) => words(r!))
          .join(", ") || "No location marked"}
      </div>
      {onPick && (
        <label className="srlabel">
          Choose a region
          <select
            value={s.location ?? ""}
            onChange={(e) =>
              e.target.value && onPick(e.target.value as BodyRegion)
            }
          >
            <option value="">Tap or select a region…</option>
            {regions.map((r) => (
              <option key={r} value={r}>
                {words(r)}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}
