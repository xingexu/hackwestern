import type { CaseState, ToolCall } from "../contract";
import { liveConfig } from "./config";
export async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch("/api/" + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ demo: true, ...(body as object) }),
    signal: AbortSignal.timeout(path === "notes" ? 55000 : 28000),
  });
  const v = await r.json();
  if (!r.ok) throw new Error(v.error || "Service unavailable.");
  return v;
}
type Handlers = {
  caption: (speaker: "patient" | "ai", line: string, final: boolean) => void;
  tools: (calls: ToolCall[]) => void;
  lost: (message: string) => void;
  resume: (handle: string) => void;
};
export async function openLive(
  s: CaseState,
  handlers: Handlers,
  resume?: string,
) {
  const { GoogleGenAI } = await import("@google/genai");
  const { token, model } = await post<{ token: string; model: string }>(
    "live",
    { language: s.language, resume },
  );
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true },
    video: false,
  });
  const ctx = new AudioContext();
  let stopped = false,
    active = false,
    time = 0;
  const playing = new Set<AudioBufferSourceNode>();
  let session:
    | Awaited<ReturnType<InstanceType<typeof GoogleGenAI>["live"]["connect"]>>
    | undefined;
  const cut = () => {
    for (const n of playing) {
      try {
        n.stop();
      } catch {}
    }
    playing.clear();
    time = 0;
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    active = false;
    cut();
    stream.getTracks().forEach((t) => t.stop());
    session?.close();
    void ctx.close();
  };
  try {
    await ctx.resume();
    await ctx.audioWorklet.addModule("/pcm-worklet.js");
    const input = ctx.createMediaStreamSource(stream),
      node = new AudioWorkletNode(ctx, "relay-pcm");
    input.connect(node);
    const mute = ctx.createGain();
    mute.gain.value = 0;
    node.connect(mute).connect(ctx.destination);
    const config = liveConfig(s.language);
    if (resume) config.sessionResumption = { handle: resume };
    const api = new GoogleGenAI({
      apiKey: token,
      httpOptions: { apiVersion: "v1alpha" },
    });
    let patient = "",
      assistant = "";
    const flush = (who: "patient" | "ai") => {
      const line = who === "patient" ? patient : assistant;
      if (line.trim()) handlers.caption(who, line, true);
      if (who === "patient") patient = "";
      else assistant = "";
    };
    session = await api.live.connect({
      model,
      config,
      callbacks: {
        onmessage: (m) => {
          if (stopped) return;
          const c = m.serverContent;
          if (m.sessionResumptionUpdate?.newHandle)
            handlers.resume(m.sessionResumptionUpdate.newHandle);
          if (m.goAway) {
            stop();
            handlers.lost("Reconnecting before the voice session expires.");
            return;
          }
          if (c?.interrupted) {
            cut();
            assistant = "";
          }
          if (c?.inputTranscription?.text) {
            patient += c.inputTranscription.text;
            handlers.caption("patient", patient, false);
            if (c.inputTranscription.finished) flush("patient");
          }
          if (c?.outputTranscription?.text) {
            flush("patient");
            assistant += c.outputTranscription.text;
            handlers.caption("ai", assistant, false);
            if (c.outputTranscription.finished) flush("ai");
          }
          for (const part of c?.modelTurn?.parts ?? []) {
            const data = part.inlineData?.data;
            if (!data || !part.inlineData?.mimeType?.includes("audio"))
              continue;
            const raw = Uint8Array.from(atob(data), (x) => x.charCodeAt(0));
            const pcm = new Int16Array(
              raw.buffer,
              0,
              Math.floor(raw.length / 2),
            );
            const buf = ctx.createBuffer(1, pcm.length, 24000);
            const chan = buf.getChannelData(0);
            pcm.forEach((v, i) => (chan[i] = v / 32768));
            const src = ctx.createBufferSource();
            src.buffer = buf;
            src.connect(ctx.destination);
            time = Math.max(ctx.currentTime, time);
            src.start(time);
            time += buf.duration;
            playing.add(src);
            src.onended = () => playing.delete(src);
          }
          const calls = m.toolCall?.functionCalls?.filter(
            (x) => !m.toolCallCancellation?.ids?.includes(x.id || ""),
          );
          if (calls?.length) {
            flush("patient");
            handlers.tools(
              calls.map((c) => ({ name: c.name || "", args: c.args || {} })),
            );
            if (!stopped)
              session?.sendToolResponse({
                functionResponses: calls.map((c) => ({
                  id: c.id,
                  name: c.name,
                  response: { received: true },
                })),
              });
          }
          if (c?.turnComplete) {
            flush("patient");
            flush("ai");
          }
        },
        onerror: () => {
          if (!stopped) {
            stop();
            handlers.lost(
              "Voice interrupted. Reconnect or send a recorded turn.",
            );
          }
        },
        onclose: () => {
          if (!stopped) {
            stop();
            handlers.lost("Voice disconnected. Your case is still here.");
          }
        },
      },
    });
    node.port.onmessage = (e) => {
      if (active && !stopped)
        session?.sendRealtimeInput({
          audio: {
            data: btoa(String.fromCharCode(...new Uint8Array(e.data))),
            mimeType: "audio/pcm;rate=16000",
          },
        });
    };
    return {
      stop,
      talk: () => {
        if (!active && !stopped) {
          cut();
          session?.sendRealtimeInput({ activityStart: {} });
          active = true;
        }
      },
      pause: () => {
        if (active && !stopped) {
          active = false;
          session?.sendRealtimeInput({ activityEnd: {} });
        }
      },
    };
  } catch (e) {
    stop();
    throw e;
  }
}
export type LiveController = Awaited<ReturnType<typeof openLive>>;
