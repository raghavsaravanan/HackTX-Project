import type { VisionCheck } from "../../../shared/types.ts";
import { qualifier } from "../lib/spatial.ts";

export function CheckDetail({ check }: { check: VisionCheck }) {
  const q = qualifier(check.confidence);
  return (
    <div className="check-detail">
      <VerdictChip check={check} />
      <span className={`qualifier-word qualifier-${q.level}`}>
        {q.word} · {Math.round(check.confidence * 100)}%
      </span>
      <span className="muted">
        {check.model} · {check.ms} ms
      </span>
      {check.evidence.length > 0 && (
        <ul className="evidence">
          {check.evidence.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function VerdictChip({ check, label }: { check: VisionCheck; label?: string }) {
  return (
    <span className={`verdict verdict-${check.verdict.toLowerCase()}`} title={check.question}>
      {label ? `${label}: ` : ""}
      {check.verdict}
    </span>
  );
}
