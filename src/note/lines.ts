import { CaseState, patientAt, words } from "../contract";
export type Line = {
  title: string;
  text: string;
  sourceTurn: number;
  quote: string;
  translation: string;
};
export type Note = {
  lines: Line[];
  route: CaseState["route"];
  confirmed: boolean;
  language: string;
  expires: number;
};
export function lines(s: CaseState): Line[] {
  const result: Line[] = [];
  function line(title: string, text: string, i: number) {
    if (!patientAt(s, i)) return;
    const t = s.transcript[i];
    result.push({
      title,
      text,
      sourceTurn: i,
      quote: t.original,
      translation: t.english,
    });
  }
  for (const f of s.findings)
    line(
      f.present ? "Reported" : "Denied",
      [
        words(f.code),
        f.bodyRegion && words(f.bodyRegion),
        f.onset,
        f.severity && "intensity " + f.severity + "/5",
        f.happeningNow === false ? "not happening now" : "",
      ]
        .filter(Boolean)
        .join(" · "),
      f.sourceTurn,
    );
  for (const allergy of s.allergyEvidence ?? [])
    line("Reported allergy", allergy.name, allergy.sourceTurn);
  for (const m of s.medications)
    if (m.sourceTurn !== undefined)
      line(
        "Label",
        m.readable ? m.name : "Unreadable — bring the bottle",
        m.sourceTurn,
      );
  for (const [i, t] of s.transcript.entries())
    if (t.speaker === "patient" && !result.some((l) => l.sourceTurn === i))
      line(
        "Patient account",
        t.english || "Original statement; translation not available",
        i,
      );
  return result;
}
export function readback(s: CaseState) {
  const zh = s.language.startsWith("zh");
  const zhWords: Record<string, string> = {
    red_eye: "眼睛发红",
    eye_discharge: "眼睛有分泌物",
    itching: "发痒",
    chest_pain: "胸痛或胸闷",
    trouble_breathing: "呼吸困难",
    severe_bleeding: "大量出血",
    fainting: "昏厥",
    fever: "发热",
    ear_pain: "耳痛",
    sprain: "扭伤",
    other: "其他不适",
  };
  const interpreted = s.findings.map((f) =>
    [
      (f.present ? "" : zh ? "否认：" : "Denied: ") +
        (zh ? (zhWords[f.code] ?? words(f.code)) : words(f.code)),
      f.happeningNow === false ? (zh ? "目前没有" : "not happening now") : "",
      f.severity ? (zh ? "程度 " : "intensity ") + f.severity + "/5" : "",
      f.onset && (zh ? f.onset.replace(/(\d+) days? ago/, "$1天前") : f.onset),
    ]
      .filter(Boolean)
      .join(" / "),
  );
  if (s.medications.length)
    interpreted.push(
      (zh ? "药品：" : "Labels: ") +
        s.medications.map((m) => m.name).join(", "),
    );
  if (s.allergies.length)
    interpreted.push(
      (zh ? "过敏：" : "Reported allergies: ") + s.allergies.join(", "),
    );
  const account = s.transcript
    .filter((t) => t.speaker === "patient")
    .slice(-12)
    .map((t) => t.original)
    .join(zh ? "；" : " · ");
  return (
    (zh ? "我理解的是：" : "I understood: ") +
    (interpreted.join(zh ? "；" : "; ") ||
      account ||
      (zh ? "尚无确认的信息。" : "no information has been confirmed.")) +
    (zh ? "。这样对吗？" : " Is that right?")
  );
}
