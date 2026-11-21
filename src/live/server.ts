import "server-only";
import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
const quota = new Map<string, { count: number; until: number }>();
export function json(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}
export class Problem extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export function problem(e: unknown) {
  if (e instanceof Problem) return json({ error: e.message }, e.status);
  if (e instanceof z.ZodError || e instanceof SyntaxError)
    return json({ error: "Invalid rehearsal input." }, 400);
  return json(
    { error: "Service unavailable. Use the rehearsal or manual entry." },
    503,
  );
}
export async function read<T>(
  req: Request,
  schema: z.ZodType<T>,
  limit = 200_000,
): Promise<T> {
  const origin = req.headers.get("origin");
  if (
    origin &&
    new URL(origin).hostname !==
      (req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "")
        .split(",")[0]
        .trim()
        .split(":")[0] &&
    origin !== new URL(req.url).origin
  )
    throw new Problem(403, "Origin not allowed.");
  if (!req.headers.get("content-type")?.startsWith("application/json"))
    throw new Problem(415, "Expected JSON.");
  const path = new URL(req.url).pathname,
    now = Date.now(),
    bucket = quota.get(path);
  if (!bucket || bucket.until < now)
    quota.set(path, { count: 1, until: now + 60_000 });
  else if (++bucket.count > (path.endsWith("/live") ? 10 : 80))
    throw new Problem(429, "Demo busy. Please try again later.");
  const reader = req.body?.getReader();
  if (!reader) throw new Problem(400, "Missing input.");
  let bytes = 0,
    raw = "";
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.length;
    if (bytes > limit) {
      await reader.cancel();
      throw new Problem(413, "Input too large.");
    }
    raw += decoder.decode(value, { stream: true });
  }
  return schema.parse(JSON.parse(raw + decoder.decode()));
}
export const demo = z.literal(true);
export function ai(alpha = false) {
  if (!process.env.GEMINI_API_KEY)
    throw new Problem(503, "Gemini is not configured. Use a rehearsal case.");
  return new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
    httpOptions: { apiVersion: alpha ? "v1alpha" : "v1beta", timeout: 22000 },
  });
}
export const textModel = () =>
  process.env.GEMINI_TEXT_MODEL || "gemini-3.5-flash";
export const imageSchema = z.object({
  mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  data: z
    .string()
    .min(4)
    .max(1_500_000)
    .regex(/^[A-Za-z0-9+/=]+$/),
});
