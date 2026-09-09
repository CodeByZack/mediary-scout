/**
 * Cleaned, human-readable interpretation of the acquisition agent's live work,
 * for the activity page's single-line ticker + rough progress bar. Pure: maps a
 * tool call (name + args) to a 中文 phrase + a coarse pipeline phase, and a phase
 * to a phase-weighted, monotonic progress %.
 *
 * Honest by construction: the phrases describe REAL tool actions (never fabricated
 * filler), expose no ids/paths, and the progress bar is phase-weighted (Microsoft
 * Win32 guidance) — starts ~5%, weights transfer widest, never reaches 100% before
 * the finalize step actually completes, and is clamped monotonic so agent retries
 * don't rewind the bar.
 */
export type AgentPhase = "search" | "pick" | "transfer" | "verify" | "organize" | "mark" | "finalize";

export interface AgentActivity {
  activity: string;
  phase: AgentPhase;
}

/** A single tool call surfaced to the progress sink: the interpreted activity +
 *  the raw name/args (the sink reads markObtained codes to accumulate obtained). */
export interface AgentToolEvent extends AgentActivity {
  toolName: string;
  args: Record<string, unknown>;
}

/** Phase → [start%, end%] band. Weighted by typical wall-clock cost (transfer
 *  widest); finalize tops at 99 so the bar only fills to 100 when the run is
 *  actually marked finished by the runner. */
const PHASE_BANDS: Record<AgentPhase, [number, number]> = {
  search: [5, 15],
  pick: [15, 25],
  transfer: [25, 60],
  verify: [60, 72],
  organize: [72, 85],
  mark: [85, 95],
  finalize: [95, 99],
};

/**
 * Rough, honest progress for a phase. `subFraction` (0–1) drives the band when a
 * real fraction is known (the mark phase's obtained/needed); otherwise the band's
 * midpoint is used so the bar advances without pretending precision it lacks.
 */
export function phaseProgress(phase: AgentPhase, subFraction?: number): number {
  const [start, end] = PHASE_BANDS[phase];
  const fraction = subFraction === undefined ? 0.5 : Math.min(1, Math.max(0, subFraction));
  return Math.round(start + (end - start) * fraction);
}


