// Pure derivations for the cockpit.
//
// Kept free of any import that touches `import.meta.env` (the API client does)
// so these can be imported by a plain test runner as well as by the app.

import type { GitStatus, StatusResponse } from '../types/api';

/** One row per distinct path. See dedupeChangedFiles. */
export interface ChangedFile {
  path: string;
  status: string;
  staged: boolean;
  /** True when git reported the path as both staged and unstaged-modified. */
  partiallyStaged: boolean;
}

/**
 * git status --porcelain emits TWO entries for one path when it is both staged
 * and modified in the worktree (web-app/server.py:5405-5411). Counting those
 * rows would overstate how many files changed, so fold them into one row and
 * record that the path is split across the index and the worktree.
 */
export function dedupeChangedFiles(
  files: GitStatus['files'] | undefined,
): ChangedFile[] {
  const byPath = new Map<string, ChangedFile>();
  for (const f of files ?? []) {
    const existing = byPath.get(f.path);
    if (!existing) {
      byPath.set(f.path, {
        path: f.path,
        status: f.status,
        staged: f.staged,
        partiallyStaged: false,
      });
      continue;
    }
    byPath.set(f.path, {
      path: f.path,
      // "added" and "deleted" say more than "modified" about what happened.
      status: existing.status === 'modified' ? f.status : existing.status,
      staged: existing.staged || f.staged,
      partiallyStaged: existing.staged !== f.staged,
    });
  }
  return Array.from(byPath.values()).sort((a, b) => a.path.localeCompare(b.path));
}

/** Trailing slash only. A looser comparison could match two different dirs. */
function normalizeDir(value: string | null | undefined): string {
  return (value ?? '').replace(/\/+$/, '');
}

/**
 * The load-bearing predicate.
 *
 * Live run telemetry on this backend is GLOBAL -- /api/session/status and /ws
 * read one module-level session singleton (web-app/server.py:140), so there is
 * exactly one running build per server. Review state is per-session. The
 * cockpit may therefore only paint live facts when the running process is
 * actually working in THIS session's directory.
 *
 * Both sides are absolute: SessionDetail.path is str(target) (server.py:3831)
 * and StatusResponse.projectDir is session.project_dir (server.py:2704).
 */
export function isLiveBinding(
  status: Pick<StatusResponse, 'running' | 'projectDir'> | null,
  detail: { path: string } | null,
): boolean {
  if (!status?.running || !detail) return false;
  const running = normalizeDir(status.projectDir);
  const session = normalizeDir(detail.path);
  return running.length > 0 && running === session;
}

/**
 * Pull the goal and acceptance criteria out of a PRD.
 *
 * This reads what is written, it does not summarise. The goal is the first
 * meaningful line (a heading, or the first prose line). Acceptance criteria are
 * checklist items under a heading that names them. When the PRD has no such
 * heading we report none rather than promoting arbitrary bullets -- calling
 * some random list "acceptance criteria" would be inventing the contract the
 * run is judged against.
 */
export function parseSpec(prd: string | undefined | null): {
  goal: string | null;
  criteria: string[];
} {
  const text = (prd ?? '').trim();
  if (!text) return { goal: null, criteria: [] };

  const lines = text.split('\n');

  let goal: string | null = null;
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    const heading = t.match(/^#{1,3}\s+(.*)$/);
    if (heading) {
      goal = heading[1].trim();
      break;
    }
    if (!t.startsWith('---')) {
      goal = t.length > 200 ? `${t.slice(0, 200)}...` : t;
      break;
    }
  }

  const criteria: string[] = [];
  let inSection = false;
  for (const line of lines) {
    const t = line.trim();
    const heading = t.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      inSection = /acceptance|success criteria|definition of done|requirements/i.test(
        heading[1],
      );
      continue;
    }
    if (!inSection) continue;
    const item = t.match(/^[-*]\s+(?:\[[ xX]\]\s*)?(.+)$/);
    if (item) criteria.push(item[1].trim());
  }

  return { goal, criteria: criteria.slice(0, 12) };
}
