import { CaseState, emergencies, Route } from "../contract";
const pharmacy = new Set([
  "red_eye",
  "eye_discharge",
  "heartburn",
  "cold_sore",
  "mouth_sore",
  "insect_bite",
  "sprain",
  "menstrual_pain",
]);
export function redFlag(s: CaseState) {
  const hits = s.findings.filter((f) => f.present);
  return (
    hits.find(
      (f) =>
        (emergencies as readonly string[]).includes(f.code) &&
        f.happeningNow !== false,
    ) ?? hits.find((f) => f.code === "self_harm_thoughts")
  );
}
function chronic(value: string) {
  const m = /^(\d+)\s*(days?|weeks?|months?|years?)(?:\s+ago)?$/i.exec(value);
  return m
    ? Number(m[1]) *
        ({ d: 1, w: 7, m: 28, y: 365 }[m[2][0].toLowerCase()] ?? 0) >
        14
    : false;
}
export function route(s: CaseState): Route {
  const flag = redFlag(s);
  if (s.route === "911" || (flag && flag.code !== "self_harm_thoughts"))
    return "911";
  if (s.route === "crisis" || flag) return "crisis";
  const f = s.findings.filter((f) => f.present);
  if (
    s.urgencyFloor === "er" ||
    f.some((i) => i.severity === 5) ||
    (s.ageBand === "infant" && f.some((i) => i.code === "fever"))
  )
    return "er";
  if (
    s.urgencyFloor === "walk_in" ||
    s.pregnant ||
    s.ageBand === "infant" ||
    s.ageBand === "child" ||
    f.some((i) => i.severity === 4)
  )
    return "walk_in";
  if (!s.confirmed || !f.length || f.some((i) => i.code === "other"))
    return "health811";
  const mild = f.every((i) => i.severity !== undefined && i.severity <= 3);
  const minor = f.every(
    (i) =>
      pharmacy.has(i.code) ||
      (i.code === "itching" &&
        i.bodyRegion === "eyes" &&
        f.some((v) => v.code === "red_eye" && v.bodyRegion === "eyes")),
  );
  if (
    mild &&
    (s.ageBand === "adult" || s.ageBand === "older_adult") &&
    s.pregnant === false &&
    minor
  )
    return "pharmacist";
  if (mild && f.every((i) => chronic(i.onset ?? ""))) return "family_doctor";
  return "health811";
}
export const cards: Record<
  Route,
  { title: string; reason: string; action: string; zh: string }
> = {
  "911": {
    title: "Call 911 now.",
    zh: "请立即拨打 911。",
    reason:
      "The fictional patient reported an emergency warning sign. The interview has stopped.",
    action: "Emergency services",
  },
  crisis: {
    title: "Call or text 9-8-8.",
    zh: "请拨打或发短信至 9-8-8。",
    reason:
      "Support is available any time. If you are in immediate danger, call 911.",
    action: "Crisis support",
  },
  er: {
    title: "Go to an emergency department today.",
    zh: "请于今天前往急诊科。",
    reason: "The demo recorded severe symptoms or a fever in an infant.",
    action: "Emergency department",
  },
  walk_in: {
    title: "See a walk-in clinic or urgent care today.",
    zh: "请于今天前往诊所或紧急护理中心。",
    reason:
      "The reported severity, age or pregnancy calls for an in-person assessment in this demo.",
    action: "Same-day care",
  },
  pharmacist: {
    title: "Speak to a pharmacist.",
    zh: "请咨询药剂师。",
    reason: "A pharmacist may be able to assess and treat this. Call ahead.",
    action: "Pharmacy assessment",
  },
  family_doctor: {
    title: "Book your family doctor or a walk-in this week.",
    zh: "请于本周预约家庭医生或诊所。",
    reason:
      "The fictional patient confirmed mild symptoms lasting more than two weeks.",
    action: "Primary care",
  },
  health811: {
    title: "Call 811 to talk to a registered nurse.",
    zh: "请拨打 811 咨询注册护士，可要求口译。",
    reason:
      "There is not enough confirmed information for a more specific route. Nurses and interpreters are available any time.",
    action: "Ontario Health811",
  },
};
