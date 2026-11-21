import { z } from "zod";
import { ai, demo, json, read, problem } from "@/live/server";
import { liveConfig } from "@/live/config";
export async function POST(req: Request) {
  try {
    const { language, resume } = await read(
      req,
      z.object({
        demo,
        language: z.string().regex(/^[a-zA-Z-]{2,35}$/),
        resume: z.string().max(4096).optional(),
      }),
    );
    const model = process.env.GEMINI_LIVE_MODEL || "gemini-3.8-live",
      now = Date.now();
    const config = liveConfig(language);
    if (resume) config.sessionResumption = { handle: resume };
    const token = await ai(true).authTokens.create({
      config: {
        uses: 1,
        newSessionExpireTime: new Date(now + 60_000).toISOString(),
        expireTime: new Date(now + 15 * 60_000).toISOString(),
        liveConnectConstraints: { model, config },
      },
    });
    return json({ token: token.name, model });
  } catch (e) {
    return problem(e);
  }
}
