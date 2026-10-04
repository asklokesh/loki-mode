import { Badge, type Tone } from "../../design/primitives";
import { displayOutcome, type OutcomeTone } from "../../display";

const TONE: Record<OutcomeTone, Tone> = { good: "success", warn: "warning", bad: "error", neutral: "neutral" };

/** The one outcome chip. The label always comes from displayOutcome; a raw enum string is never printed. */
export function OutcomeChip({ verdict }: { verdict: string | null | undefined }) {
  const o = displayOutcome(verdict);
  return <Badge tone={TONE[o.tone]} pulse={o.label === "Running"} data-outcome={o.label} style={{ textTransform: "none", letterSpacing: 0, whiteSpace: "nowrap" }}>{o.label}</Badge>;
}
