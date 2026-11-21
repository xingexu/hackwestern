import { randomBytes } from "node:crypto";
import { Note } from "./lines";
export const TTL = 30 * 60_000;
type Entry = { note: Note; timer: ReturnType<typeof setTimeout> };
const memory = globalThis as typeof globalThis & {
  relayNotes?: Map<string, Entry>;
};
const notes = (memory.relayNotes ??= new Map<string, Entry>());
export function saveNote(note: Omit<Note, "expires">, now = Date.now()) {
  for (const [id, v] of notes)
    if (v.note.expires <= now) {
      clearTimeout(v.timer);
      notes.delete(id);
    }
  if (notes.size >= 256) throw new Error("Note store at capacity");
  const id = randomBytes(20).toString("base64url"),
    expires = now + TTL;
  const timer = setTimeout(() => notes.delete(id), TTL);
  timer.unref();
  notes.set(id, { note: { ...note, expires }, timer });
  return { id, expires };
}
export function getNote(id: string, now = Date.now()) {
  const e = notes.get(id);
  if (!e) return null;
  if (e.note.expires <= now) {
    clearTimeout(e.timer);
    notes.delete(id);
    return null;
  }
  return e.note;
}
