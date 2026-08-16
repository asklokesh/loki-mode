// Phase vocabulary mapping.
//
// The engine and the display speak different languages. This module is the ONLY
// place the translation happens, so a wrong bucket is greppable and testable.
//
// Backend values, traced to source:
//   idle       web-app/server.py:2924   default when nothing is on disk
//   starting   web-app/server.py:2996   synthetic: process alive, <15s, no state yet
//   BOOTSTRAP  autonomy/run.sh:6270     seed orchestrator.json record
//   REASON     autonomy/run.sh:3485     get_rarv_phase_name(iteration % 4)
//   ACT        autonomy/run.sh:3486
//   REFLECT    autonomy/run.sh:3487
//   VERIFY     autonomy/run.sh:3488
//   UNKNOWN    autonomy/run.sh:3489
//   BUILDING   autonomy/run.sh:26167    _advance_current_phase
//   COMPLETED  autonomy/run.sh:26286
//   FAILED     autonomy/run.sh:26289, :26294
//
// Both routes persist the RARV name: bash at run.sh:22295, Bun via
// updateCurrentPhase (loki-ts/src/runner/autonomous.ts:670 -> state.ts:632).

export type DisplayPhase =
  | 'not-started'
  | 'understanding'
  | 'planning'
  | 'editing'
  | 'testing'
  | 'review'
  | 'pr-ready'
  | 'failed'
  | 'unknown';

// The calm timeline. RARV cycles rather than marching, so this is rendered as a
// repeating cycle with the current step marked -- not as a progress bar.
export const TIMELINE: DisplayPhase[] = [
  'understanding',
  'planning',
  'editing',
  'testing',
  'review',
  'pr-ready',
];

export const PHASE_LABEL: Record<DisplayPhase, string> = {
  'not-started': 'Not started',
  understanding: 'Understanding',
  planning: 'Planning',
  editing: 'Editing',
  testing: 'Testing',
  review: 'Review',
  'pr-ready': 'PR ready',
  failed: 'Failed',
  unknown: 'Unknown',
};

// What each phase means, in the reviewer's terms. Shown under the active step.
export const PHASE_HINT: Record<DisplayPhase, string> = {
  'not-started': 'No run has been recorded for this session.',
  understanding: 'Reading the spec and the existing code.',
  planning: 'Deciding what to change and in what order.',
  editing: 'Writing code.',
  testing: 'Running checks against what it wrote.',
  review: 'Reflecting on the result and reviewing its own changes.',
  'pr-ready': 'Work finished. Ready for your review.',
  failed: 'The run ended without completing.',
  unknown: 'The engine reported a phase this view does not recognise.',
};

const PHASE_MAP: Record<string, DisplayPhase> = {
  idle: 'not-started',
  starting: 'understanding',
  BOOTSTRAP: 'understanding',
  REASON: 'planning',
  ACT: 'editing',
  VERIFY: 'testing',
  REFLECT: 'review',
  BUILDING: 'editing',
  COMPLETED: 'pr-ready',
  FAILED: 'failed',
  UNKNOWN: 'unknown',
};

export interface MappedPhase {
  display: DisplayPhase;
  /** The backend string, verbatim. Always shown somewhere, never discarded. */
  raw: string;
  /** False when the backend sent something this map does not know. */
  recognised: boolean;
}

/**
 * Map a backend phase string to a display phase.
 *
 * An unrecognised phase maps to 'unknown' and keeps its raw value so the UI can
 * render it verbatim. Silently bucketing an unknown phase into 'editing' would
 * be an invented fact -- the whole reason this map is explicit.
 */
export function mapPhase(raw: string | null | undefined): MappedPhase {
  const value = (raw ?? '').trim();
  if (!value) {
    return { display: 'not-started', raw: '', recognised: true };
  }
  const direct = PHASE_MAP[value];
  if (direct) {
    return { display: direct, raw: value, recognised: true };
  }
  // Case-insensitive retry: the bash and Bun routes agree on casing today, but
  // a future writer disagreeing should degrade to the right bucket, not to
  // 'unknown'.
  const upper = PHASE_MAP[value.toUpperCase()];
  if (upper) {
    return { display: upper, raw: value, recognised: true };
  }
  return { display: 'unknown', raw: value, recognised: false };
}

/**
 * Index of a display phase within TIMELINE, or -1 when it is not a timeline
 * step (not-started, failed, unknown). Used to mark the active step; NOT used
 * to claim the earlier steps are complete, because RARV cycles.
 */
export function timelineIndex(phase: DisplayPhase): number {
  return TIMELINE.indexOf(phase);
}
