import { Line } from "./lines";
import { Quote } from "lucide-react";
export function Evidence({ lines }: { lines: Line[] }) {
  return (
    <div className="evidence">
      {lines.length ? (
        lines.map((l, i) => (
          <details key={i}>
            <summary>
              <small>{l.title}</small>
              <span>{l.text}</span>
              <em>
                <Quote size={12} /> Turn {l.sourceTurn + 1}
              </em>
            </summary>
            <blockquote dir="auto">{l.quote}</blockquote>
            {l.translation && l.translation !== l.quote && (
              <p>{l.translation}</p>
            )}
          </details>
        ))
      ) : (
        <p>No patient statements recorded.</p>
      )}
    </div>
  );
}
