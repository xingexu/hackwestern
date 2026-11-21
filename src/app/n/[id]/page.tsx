import { getNote } from "@/note/store";
import { Evidence } from "@/note/Viewer";
import { cards } from "@/rules";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export default async function Handoff({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const n = getNote(id);
  return (
    <main className="notePage">
      <div className="eyebrow">Relay Intake / Fictional patient</div>
      {n ? (
        <>
          <h1>Handoff note</h1>
          <p>
            {n.confirmed ? "Patient confirmed" : "Not patient-confirmed"} ·{" "}
            {n.language}
          </p>
          <div className="notice">
            {n.route && cards[n.route].title} This is not a diagnosis.
          </div>
          <h2>English case notes</h2>
          <p>Select any line to see the original patient statement.</p>
          <Evidence lines={n.lines} />
          <footer>
            Temporary note · expires{" "}
            {new Date(n.expires).toLocaleTimeString("en-CA", {
              timeZone: "America/Toronto",
            })}{" "}
            Toronto time.
          </footer>
        </>
      ) : (
        <>
          <h1>This note has expired or is unavailable.</h1>
          <p>
            Demo notes last 30 minutes and disappear if the server restarts.
          </p>
        </>
      )}
    </main>
  );
}
