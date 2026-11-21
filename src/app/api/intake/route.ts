import { z } from "zod";
import { ai, demo, json, read, problem, textModel } from "@/live/server";
import { caseSchema } from "@/contract";
import { instruction } from "@/live/config";
import { toolSchemas } from "@/state/engine";
const clip = z.object({
  mimeType: z.enum(["audio/webm", "audio/mp4", "audio/wav", "audio/ogg"]),
  data: z
    .string()
    .min(4)
    .max(1_500_000)
    .regex(/^[A-Za-z0-9+/=]+$/),
});
const input = z
  .object({
    demo,
    state: caseSchema,
    text: z.string().trim().min(1).max(2000).optional(),
    audio: clip.optional(),
  })
  .refine((x) => !!x.text !== !!x.audio);
const out = z.object({
  original: z.string().trim().min(1).max(2000),
  english: z.string().trim().min(1).max(2000),
  language: z.string().regex(/^[a-zA-Z-]{2,35}$/),
  question: z.string().trim().max(500),
  calls: z
    .array(
      z.object({ name: z.string(), args: z.record(z.string(), z.unknown()) }),
    )
    .max(32),
});
export async function POST(req: Request) {
  try {
    const { state, text, audio } = await read(req, input, 1_800_000);
    const specs = Object.fromEntries(
      Object.entries(toolSchemas).map(([k, s]) => [k, z.toJSONSchema(s)]),
    );
    const prompt =
      instruction +
      " Return only JSON {original,english,language,question,calls:[{name,args}]}. Transcribe the latest patient utterance verbatim, translate to English, identify language using BCP47, and ask one safe next question. For uncertainty or a finished interview call finish_intake. Latest sourceTurn index = " +
      state.transcript.length +
      ". These are the tools: " +
      JSON.stringify(specs);
    const parts: [
      { text: string },
      ...{ inlineData: { mimeType: string; data: string } }[],
    ] = [
      {
        text: JSON.stringify({
          previous: state.transcript,
          currentLanguage: state.language,
          patient: text || "See audio clip",
        }),
      },
    ];
    if (audio) parts.push({ inlineData: audio });
    const r = await ai().models.generateContent({
      model: textModel(),
      contents: [{ role: "user", parts }],
      config: {
        systemInstruction: prompt,
        responseMimeType: "application/json",
        temperature: 0,
      },
    });
    const v = out.parse(JSON.parse(r.text || "null"));
    return json({
      ...v,
      original: text ?? v.original,
      calls: v.calls.filter(
        (c) =>
          Object.hasOwn(toolSchemas, c.name) &&
          toolSchemas[c.name as keyof typeof toolSchemas].safeParse(c.args)
            .success,
      ),
    });
  } catch (e) {
    return problem(e);
  }
}
