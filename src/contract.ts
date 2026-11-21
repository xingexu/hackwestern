import { z } from "zod";
export const emergencies = [
  "chest_pain",
  "trouble_breathing",
  "face_droop",
  "arm_weakness",
  "speech_difficulty",
  "severe_bleeding",
  "fainting",
  "seizure",
  "throat_or_face_swelling",
  "sudden_worst_headache",
  "confusion",
  "vomiting_blood",
  "head_injury",
] as const;
export const codes = [
  ...emergencies,
  "self_harm_thoughts",
  "fever",
  "cough",
  "sore_throat",
  "runny_nose",
  "headache",
  "dizziness",
  "nausea",
  "vomiting",
  "diarrhea",
  "abdominal_pain",
  "heartburn",
  "painful_urination",
  "rash",
  "itching",
  "red_eye",
  "eye_discharge",
  "ear_pain",
  "back_pain",
  "joint_pain",
  "sprain",
  "insect_bite",
  "cold_sore",
  "mouth_sore",
  "menstrual_pain",
  "fatigue",
  "other",
] as const;
export const regions = [
  "head",
  "eyes",
  "ears",
  "mouth_throat",
  "neck",
  "chest",
  "upper_back",
  "lower_back",
  "abdomen_upper",
  "abdomen_lower",
  "pelvis",
  "left_arm",
  "right_arm",
  "left_hand",
  "right_hand",
  "left_leg",
  "right_leg",
  "left_foot",
  "right_foot",
  "skin_general",
] as const;
export const routes = [
  "911",
  "crisis",
  "er",
  "walk_in",
  "pharmacist",
  "family_doctor",
  "health811",
] as const;
export type Route = (typeof routes)[number];
export type SymptomCode = (typeof codes)[number];
export type BodyRegion = (typeof regions)[number];
export const short = z.string().trim().min(1).max(140);
export const findingSchema = z
  .object({
    code: z.enum(codes),
    present: z.boolean(),
    bodyRegion: z.enum(regions).optional(),
    onset: short.optional(),
    happeningNow: z.boolean().optional(),
    severity: z
      .union([
        z.literal(1),
        z.literal(2),
        z.literal(3),
        z.literal(4),
        z.literal(5),
      ])
      .optional(),
    sourceTurn: z.number().int().nonnegative(),
  })
  .strict();
export const turnSchema = z.object({
  speaker: z.enum(["patient", "ai"]),
  original: z.string().trim().min(1).max(2000),
  english: z.string().trim().max(2000),
});
export const caseSchema = z.object({
  language: z.string().max(35),
  subject: z.enum(["self", "other"]),
  ageBand: z.enum(["infant", "child", "adult", "older_adult"]).optional(),
  pregnant: z.boolean().optional(),
  findings: z.array(findingSchema).max(160),
  medications: z
    .array(
      z.object({
        name: short,
        readable: z.boolean(),
        sourceTurn: z.number().int().nonnegative().optional(),
      }),
    )
    .max(30),
  allergies: z.array(short).max(30),
  transcript: z.array(turnSchema).max(160),
  confirmed: z.boolean(),
  redFlag: z.object({ code: z.enum(codes) }).nullable(),
  route: z.enum(routes).nullable(),
  urgencyFloor: z.enum(["er", "walk_in"]).optional(),
  mode: z.enum(["voice", "push_to_talk", "text"]),
  location: z.enum(regions).optional(),
  review: z.boolean(),
  rejections: z.number().int().min(0).max(2),
});
export type Finding = z.infer<typeof findingSchema>;
export type Turn = z.infer<typeof turnSchema>;
export type CaseState = z.infer<typeof caseSchema>;
export const fresh = (language = "en-CA"): CaseState => ({
  language,
  subject: "self",
  findings: [],
  medications: [],
  allergies: [],
  transcript: [],
  confirmed: false,
  redFlag: null,
  route: null,
  mode: "push_to_talk",
  review: false,
  rejections: 0,
});
export type ToolCall = { name: string; args: Record<string, unknown> };
export const patientAt = (s: CaseState, i: number) =>
  s.transcript[i]?.speaker === "patient";
export const words = (s: string) => s.replaceAll("_", " ");
