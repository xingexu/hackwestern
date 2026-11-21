import { z } from "zod";
import {
  CaseState,
  findingSchema,
  regions,
  short,
  patientAt,
  ToolCall,
  Turn,
  turnSchema,
} from "../contract";
import { redFlag, route } from "../rules";
export const toolSchemas = {
  record_finding: findingSchema,
  mark_body_location: z.object({ bodyRegion: z.enum(regions) }).strict(),
  set_subject: z
    .object({
      subject: z.enum(["self", "other"]),
      ageBand: z.enum(["infant", "child", "adult", "older_adult"]).optional(),
      pregnant: z.boolean().optional(),
    })
    .strict(),
  add_medication: z
    .object({
      name: short,
      readable: z.boolean().optional(),
      sourceTurn: z.number().int().nonnegative(),
    })
    .strict(),
  add_allergy: z
    .object({ name: short, sourceTurn: z.number().int().nonnegative() })
    .strict(),
  request_camera: z.object({ purpose: z.enum(["label", "point"]) }).strict(),
  finish_intake: z.object({}).strict(),
};
export function append(s: CaseState, t: Turn): CaseState {
  if (s.route || s.transcript.length >= 160 || !turnSchema.safeParse(t).success)
    return s;
  return { ...s, transcript: [...s.transcript, t] };
}
export function applyTool(s: CaseState, c: ToolCall): CaseState {
  if (s.route) return s;
  const schema = Object.hasOwn(toolSchemas, c.name)
    ? toolSchemas[c.name as keyof typeof toolSchemas]
    : null;
  if (!schema?.safeParse(c.args).success) {
    console.warn("Rejected intake tool");
    return s;
  }
  const a = c.args;
  let n = s;
  if (c.name === "record_finding") {
    const f = findingSchema.parse(a);
    if (!patientAt(s, f.sourceTurn)) return s;
    n = {
      ...s,
      findings: [
        ...s.findings.filter(
          (v) => v.code !== f.code || v.bodyRegion !== f.bodyRegion,
        ),
        f,
      ],
    };
  } else if (c.name === "set_subject") {
    n = { ...s, ...toolSchemas.set_subject.parse(a) };
  } else if (c.name === "mark_body_location")
    n = { ...s, location: toolSchemas.mark_body_location.parse(a).bodyRegion };
  else if (c.name === "add_medication" && patientAt(s, Number(a.sourceTurn)))
    n = {
      ...s,
      medications: [
        ...s.medications.filter((m) => m.name !== a.name),
        {
          name: String(a.name),
          readable: a.readable !== false,
          sourceTurn: Number(a.sourceTurn),
        },
      ],
    };
  else if (c.name === "add_allergy" && patientAt(s, Number(a.sourceTurn)))
    n = { ...s, allergies: [...new Set([...s.allergies, String(a.name)])] };
  else if (c.name === "finish_intake") n = { ...s, review: true };
  const observed = route(n);
  if (observed === "er" || observed === "walk_in")
    n = { ...n, urgencyFloor: observed };
  const flag = redFlag(n);
  return flag
    ? {
        ...n,
        redFlag: { code: flag.code },
        route: flag.code === "self_harm_thoughts" ? "crisis" : "911",
        review: false,
      }
    : n;
}
export function review(s: CaseState, yes: boolean): CaseState {
  if (s.route || !s.review) return s;
  const n = {
    ...s,
    confirmed: yes,
    review: false,
    rejections: yes ? s.rejections : Math.min(2, s.rejections + 1),
  };
  return yes || n.rejections === 2 ? { ...n, route: route(n) } : n;
}
export function applyBatch(s: CaseState, calls: ToolCall[]) {
  // Give immediate physical danger precedence over a crisis disclosure in the same turn.
  return [...calls]
    .sort(
      (a, b) =>
        Number(a.args.code === "self_harm_thoughts") -
        Number(b.args.code === "self_harm_thoughts"),
    )
    .reduce(applyTool, s);
}
