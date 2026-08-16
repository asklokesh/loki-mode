import { test, expect, type Page } from '@playwright/test';
import { mapPhase, timelineIndex } from '../../src/cockpit/phases';
// From derive.ts, not useCockpitState.ts: these must be importable without
// pulling in the API client, which reads import.meta.env and is undefined
// outside a Vite build.
import { dedupeChangedFiles, isLiveBinding, parseSpec } from '../../src/cockpit/derive';

// ---------------------------------------------------------------------------
// Pure-function checks. These need no browser and no server: they guard the two
// places where a silent bug would be invisible in a screenshot -- the phase map
// and the changed-file dedupe.
// ---------------------------------------------------------------------------

test.describe('phase map', () => {
  // Every row of the table in docs/EXECUTION-COCKPIT-PLAN.md section 4.
  const TABLE: [string, string][] = [
    ['idle', 'not-started'],
    ['starting', 'understanding'],
    ['BOOTSTRAP', 'understanding'],
    ['REASON', 'planning'],
    ['ACT', 'editing'],
    ['VERIFY', 'testing'],
    ['REFLECT', 'review'],
    ['BUILDING', 'editing'],
    ['COMPLETED', 'pr-ready'],
    ['FAILED', 'failed'],
    ['UNKNOWN', 'unknown'],
  ];

  for (const [raw, expected] of TABLE) {
    test(`maps ${raw} to ${expected}`, () => {
      const m = mapPhase(raw);
      expect(m.display).toBe(expected);
      expect(m.recognised).toBe(true);
      expect(m.raw).toBe(raw);
    });
  }

  test('an unmapped phase is kept verbatim, never bucketed', () => {
    const m = mapPhase('SOME_FUTURE_PHASE');
    expect(m.display).toBe('unknown');
    expect(m.recognised).toBe(false);
    // The raw value must survive so the UI can show it instead of guessing.
    expect(m.raw).toBe('SOME_FUTURE_PHASE');
  });

  test('empty and null map to not-started', () => {
    expect(mapPhase('').display).toBe('not-started');
    expect(mapPhase(null).display).toBe('not-started');
    expect(mapPhase(undefined).display).toBe('not-started');
  });

  test('non-timeline phases have no timeline index', () => {
    expect(timelineIndex('failed')).toBe(-1);
    expect(timelineIndex('unknown')).toBe(-1);
    expect(timelineIndex('not-started')).toBe(-1);
    expect(timelineIndex('editing')).toBeGreaterThanOrEqual(0);
  });
});

test.describe('changed-file dedupe', () => {
  test('folds a staged + unstaged entry for one path into one row', () => {
    // git status --porcelain emits both when a file is staged AND modified in
    // the worktree (web-app/server.py:5405-5411). Two rows would overstate the
    // change count.
    const out = dedupeChangedFiles([
      { path: 'src/a.ts', status: 'modified', staged: true },
      { path: 'src/a.ts', status: 'modified', staged: false },
      { path: 'src/b.ts', status: 'added', staged: true },
    ]);
    expect(out).toHaveLength(2);
    const a = out.find((f) => f.path === 'src/a.ts')!;
    expect(a.partiallyStaged).toBe(true);
    expect(a.staged).toBe(true);
    const b = out.find((f) => f.path === 'src/b.ts')!;
    expect(b.partiallyStaged).toBe(false);
  });

  test('an empty or absent list yields no rows', () => {
    expect(dedupeChangedFiles([])).toHaveLength(0);
    expect(dedupeChangedFiles(undefined)).toHaveLength(0);
  });

  test('a more specific status beats modified when folding', () => {
    const out = dedupeChangedFiles([
      { path: 'x', status: 'modified', staged: false },
      { path: 'x', status: 'deleted', staged: true },
    ]);
    expect(out[0].status).toBe('deleted');
  });
});

test.describe('live binding', () => {
  const detail = { path: '/home/u/projects/demo' } as never;

  test('is live only when the running dir is this session dir', () => {
    expect(
      isLiveBinding(
        { running: true, projectDir: '/home/u/projects/demo' } as never,
        detail,
      ),
    ).toBe(true);
  });

  test('a trailing slash does not break the match', () => {
    expect(
      isLiveBinding(
        { running: true, projectDir: '/home/u/projects/demo/' } as never,
        detail,
      ),
    ).toBe(true);
  });

  test('a different running project is NOT live for this session', () => {
    // The whole point: live telemetry is global on this backend, so a running
    // build elsewhere must not paint this session's screen.
    expect(
      isLiveBinding(
        { running: true, projectDir: '/home/u/projects/other' } as never,
        detail,
      ),
    ).toBe(false);
  });

  test('not running means not live', () => {
    expect(
      isLiveBinding(
        { running: false, projectDir: '/home/u/projects/demo' } as never,
        detail,
      ),
    ).toBe(false);
  });

  test('an empty projectDir never matches', () => {
    expect(isLiveBinding({ running: true, projectDir: '' } as never, detail)).toBe(false);
  });
});

test.describe('spec parsing', () => {
  test('takes the first heading as the goal', () => {
    expect(parseSpec('# Build a todo app\n\nSome prose').goal).toBe('Build a todo app');
  });

  test('reads acceptance criteria only from a section that names them', () => {
    const prd = [
      '# Goal',
      '## Notes',
      '- not a criterion',
      '## Acceptance Criteria',
      '- [ ] users can log in',
      '- [x] data persists',
    ].join('\n');
    const { criteria } = parseSpec(prd);
    expect(criteria).toEqual(['users can log in', 'data persists']);
  });

  test('reports no criteria rather than promoting arbitrary bullets', () => {
    expect(parseSpec('# Goal\n\n- some bullet\n- another').criteria).toEqual([]);
  });

  test('an empty PRD yields no goal', () => {
    expect(parseSpec('').goal).toBeNull();
    expect(parseSpec(undefined).goal).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Route-mocked UI states. Every response is a fixture, so these are
// deterministic and need no running build.
// ---------------------------------------------------------------------------

const SESSION_ID = 'demo-session';
const SESSION_PATH = '/home/u/purple-lab-projects/demo-session';

const PRD = [
  '# Add rate limiting to the public API',
  '',
  '## Acceptance Criteria',
  '- [ ] Requests over the limit return 429',
  '- [ ] The limit is configurable per key',
].join('\n');

interface Fixtures {
  running?: boolean;
  paused?: boolean;
  phase?: string;
  projectDir?: string;
  exitCode?: number | null;
  detailStatus?: string;
  prd?: string;
  gitFiles?: { path: string; status: string; staged: boolean }[];
  checklist?: unknown;
  checkpoints?: unknown[];
  files?: unknown[];
}

async function mockCockpit(page: Page, f: Fixtures = {}) {
  await page.addInitScript(() => {
    localStorage.setItem('pl_onboarding_complete', '1');
    localStorage.setItem('pl_auth_token', 'test-token');
  });

  await page.route('**/api/auth/me', (r) =>
    r.fulfill({ json: { authenticated: true, local_mode: true, email: 'q@example.com' } }),
  );

  await page.route(`**/api/sessions/${SESSION_ID}`, (r) =>
    r.fulfill({
      json: {
        id: SESSION_ID,
        path: SESSION_PATH,
        status: f.detailStatus ?? 'completed',
        prd: f.prd ?? PRD,
        files: f.files ?? [{ name: 'app.ts', path: 'app.ts', type: 'file' }],
        logs: ['[runner] iteration 1', '[runner] wrote app.ts'],
      },
    }),
  );

  await page.route('**/api/session/status', (r) =>
    r.fulfill({
      json: {
        running: f.running ?? false,
        paused: f.paused ?? false,
        phase: f.phase ?? 'idle',
        iteration: f.running ? 3 : 0,
        complexity: 'standard',
        mode: 'autonomous',
        provider: 'claude',
        current_task: '',
        pending_tasks: 0,
        running_agents: 0,
        uptime: f.running ? 184 : 0,
        version: '',
        pid: f.running ? '4242' : '',
        projectDir: f.projectDir ?? (f.running ? SESSION_PATH : ''),
        max_iterations: 10,
        cost: f.running ? 0.42 : 0,
        start_time: 0,
        exit_code: f.exitCode ?? null,
        last_output: f.exitCode ? ['fatal: provider returned no output'] : [],
      },
    }),
  );

  await page.route('**/api/session/checklist', (r) =>
    r.fulfill({
      json:
        f.checklist ?? { total: 0, passed: 0, failed: 0, skipped: 0, pending: 0, items: [] },
    }),
  );

  await page.route(`**/api/sessions/${SESSION_ID}/git/status`, (r) =>
    r.fulfill({
      json: {
        branch: 'loki/rate-limit',
        clean: (f.gitFiles ?? []).length === 0,
        ahead: 0,
        behind: 0,
        files: f.gitFiles ?? [],
      },
    }),
  );

  await page.route(`**/api/sessions/${SESSION_ID}/checkpoints`, (r) =>
    r.fulfill({ json: f.checkpoints ?? [] }),
  );

  // Stub WebSocket entirely: aborting the route would leave the socket in a
  // CLOSED state, which is a real (and separately tested) "disconnected"
  // condition -- not what these fixtures are exercising. A stub that opens and
  // stays silent isolates the state under test to the mocked REST payloads.
  await page.addInitScript(() => {
    class SilentSocket extends EventTarget {
      static readonly OPEN = 1;
      readyState = 1;
      onopen: ((e: Event) => void) | null = null;
      onmessage: ((e: MessageEvent) => void) | null = null;
      onclose: ((e: Event) => void) | null = null;
      onerror: ((e: Event) => void) | null = null;
      constructor() {
        super();
        setTimeout(() => this.onopen?.(new Event('open')), 0);
        // Expose the live instance so a test can simulate a drop.
        (window as unknown as { __lokiSocket?: SilentSocket }).__lokiSocket = this;
      }
      send() {}
      close() {}
    }
    (window as unknown as { WebSocket: unknown }).WebSocket = SilentSocket;
    (window as unknown as { __lokiCloseSocket?: () => void }).__lokiCloseSocket = () => {
      const s = (window as unknown as { __lokiSocket?: SilentSocket }).__lokiSocket;
      if (s) {
        s.readyState = 3;
        s.onclose?.(new Event('close'));
      }
    };
  });
}

async function openCockpit(page: Page) {
  // Absolute: the app is served under the /lab/ base, and a relative goto
  // would drop it.
  await page.goto(`http://127.0.0.1:57380/lab/project/${SESSION_ID}/cockpit`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}

test.describe('cockpit states', () => {
  test('completed: shows the goal and the acceptance criteria as written', async ({ page }) => {
    await mockCockpit(page);
    await openCockpit(page);

    await expect(
      page.getByRole('heading', { name: 'Add rate limiting to the public API' }),
    ).toBeVisible();
    await expect(page.getByText('Requests over the limit return 429')).toBeVisible();
    await expect(page.getByText('The limit is configurable per key')).toBeVisible();
  });

  test('a session that is not the running one paints NO live facts', async ({ page }) => {
    // A build is running, but in a DIFFERENT directory. The cockpit must not
    // borrow its phase, its clock or its running badge.
    await mockCockpit(page, {
      running: true,
      phase: 'ACT',
      projectDir: '/home/u/purple-lab-projects/some-other-project',
    });
    await openCockpit(page);

    await expect(page.getByLabel('Phase timeline').getByText('Historical')).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'Running' })).toHaveCount(0);
    // Elapsed must read as unmeasured, not as a number borrowed from the other run.
    await expect(page.getByText('Only measured while a run is live')).toBeVisible();
  });

  test('running: live phase, elapsed and iteration', async ({ page }) => {
    await mockCockpit(page, { running: true, phase: 'ACT' });
    await openCockpit(page);

    await expect(page.getByRole('status').filter({ hasText: 'Running' })).toBeVisible();
    await expect(page.getByLabel('Phase timeline').getByText('Historical')).toHaveCount(0);
    await expect(page.getByText('3m 4s')).toBeVisible();
    // Phases cycle; the UI must say so rather than imply a countdown.
    await expect(page.getByText(/this is a cycle, not a countdown/)).toBeVisible();
  });

  test('paused: says so and offers resume', async ({ page }) => {
    await mockCockpit(page, { running: true, paused: true, phase: 'ACT' });
    await openCockpit(page);

    await expect(page.getByRole('status').filter({ hasText: 'Paused' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Resume' })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Pause' })).toBeDisabled();
  });

  test('a dropped socket annotates the run state, it does not replace it', async ({ page }) => {
    await mockCockpit(page, { running: true, paused: true, phase: 'ACT' });
    await openCockpit(page);
    await expect(page.getByRole('status').filter({ hasText: 'Paused' })).toBeVisible();

    // Kill the socket after the page has settled.
    await page.evaluate(() => {
      const w = window as unknown as { __lokiCloseSocket?: () => void };
      w.__lokiCloseSocket?.();
    });

    // The run is still paused; staleness is reported alongside, not instead.
    await expect(page.getByRole('status').filter({ hasText: 'Paused' })).toBeVisible();
  });

  test('recovering: starting up is labelled, not counted as progress', async ({ page }) => {
    await mockCockpit(page, { running: true, phase: 'starting' });
    await openCockpit(page);

    await expect(page.getByRole('status').filter({ hasText: 'Starting up' })).toBeVisible();
    await expect(
      page.getByText('The process is alive but has not written any state yet.'),
    ).toBeVisible();
  });

  test('failed: shows the exit code and the last output', async ({ page }) => {
    await mockCockpit(page, { running: true, phase: 'FAILED', exitCode: 1 });
    await openCockpit(page);

    await expect(page.getByRole('status').filter({ hasText: 'Run failed' })).toBeVisible();
    await expect(page.getByText('Process exited with code 1.')).toBeVisible();
    await page.getByText('Last output before exit').click();
    await expect(page.getByText('fatal: provider returned no output')).toBeVisible();
  });

  test('empty: an unused session says so instead of showing blank panels', async ({ page }) => {
    await mockCockpit(page, { prd: '', files: [], detailStatus: 'empty' });
    await openCockpit(page);

    await expect(page.getByText('Nothing recorded yet')).toBeVisible();
  });

  test('an absent checklist reads as "not recorded", never as a green pass', async ({ page }) => {
    await mockCockpit(page);
    await openCockpit(page);

    await expect(page.getByText('No gate results recorded.')).toBeVisible();
    // The endpoint returns zeros for an absent file; that must never render as 0 passed / all good.
    await expect(page.getByText('0 passed, 0 failed')).toHaveCount(0);
  });

  test('gate results render with their status when recorded', async ({ page }) => {
    await mockCockpit(page, {
      checklist: {
        total: 2,
        passed: 1,
        failed: 1,
        skipped: 0,
        pending: 0,
        items: [
          { id: 'g1', label: 'Static analysis', status: 'pass' },
          { id: 'g2', label: 'Test suite', status: 'fail', details: '2 failing' },
        ],
      },
    });
    await openCockpit(page);

    await expect(page.getByText('1 passed, 1 failed, 0 skipped, 0 pending')).toBeVisible();
    await expect(page.getByText('Static analysis')).toBeVisible();
    await expect(page.getByText('2 failing')).toBeVisible();
    // A failing gate must surface as risk, not just as a row.
    await expect(page.getByLabel('Risk and rollback').getByText(/Test suite/)).toBeVisible();
  });

  test('changed-file count is distinct paths, not porcelain rows', async ({ page }) => {
    await mockCockpit(page, {
      gitFiles: [
        { path: 'src/limit.ts', status: 'modified', staged: true },
        { path: 'src/limit.ts', status: 'modified', staged: false },
        { path: 'src/config.ts', status: 'added', staged: true },
      ],
    });
    await openCockpit(page);

    await expect(page.getByLabel('Changed files').getByText('2 files')).toBeVisible();
    await expect(page.getByText('partly staged')).toBeVisible();
  });

  test('every disabled action states a reason in visible text', async ({ page }) => {
    await mockCockpit(page);
    await openCockpit(page);

    const actions = page.getByLabel('Actions');
    await expect(actions.getByText('Stop run: No run in progress for this session.')).toBeVisible();
    await expect(actions.getByText('Commit: The working tree is clean.')).toBeVisible();
    await expect(
      actions.getByText('Push: Nothing to push: no commits ahead of the remote.'),
    ).toBeVisible();
    // Approve has no endpoint at all; it must say so rather than render a button.
    await expect(actions.getByText(/no endpoint that approves a local run/)).toBeVisible();
    await expect(actions.getByRole('button', { name: 'Approve' })).toHaveCount(0);
  });

  test('rollback is unavailable and explains why when no checkpoints exist', async ({ page }) => {
    await mockCockpit(page);
    await openCockpit(page);

    await expect(
      page.getByText('No checkpoints recorded for this session, so there is nothing to roll back to.'),
    ).toBeVisible();
  });

  test('rollback asks for confirmation naming the checkpoint', async ({ page }) => {
    await mockCockpit(page, {
      checkpoints: [
        {
          id: 'cp-1',
          timestamp: '2026-08-16T10:00:00Z',
          description: 'before rate limit edits',
          iteration: 2,
          files_changed: 4,
          is_current: false,
        },
      ],
    });
    await openCockpit(page);

    await page.getByRole('button', { name: 'Roll back' }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/before rate limit edits/)).toBeVisible();
    await expect(dialog.getByText(/Changes made since then/)).toBeVisible();
  });

  test('agent chatter is secondary: collapsed until asked for', async ({ page }) => {
    await mockCockpit(page);
    await openCockpit(page);

    const toggle = page.getByRole('button', { name: /Agent activity/ });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByText('[runner] wrote app.ts')).toHaveCount(0);
    await toggle.click();
    await expect(page.getByText('[runner] wrote app.ts')).toBeVisible();
  });

  test('an unrecognised phase is shown verbatim', async ({ page }) => {
    await mockCockpit(page, { running: true, phase: 'QUANTUM_REFACTOR' });
    await openCockpit(page);

    await expect(page.getByText(/does not recognise/)).toBeVisible();
    await expect(page.getByText('QUANTUM_REFACTOR')).toBeVisible();
  });

  test('keyboard: the shortcut sheet opens with ? and closes with Escape', async ({ page }) => {
    await mockCockpit(page);
    await openCockpit(page);

    await page.keyboard.press('?');
    await expect(page.getByText('Go to changes')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByText('Go to changes')).toHaveCount(0);
  });

  test('keyboard: the changed-file list is one tab stop with arrow navigation', async ({ page }) => {
    await mockCockpit(page, {
      gitFiles: [
        { path: 'src/a.ts', status: 'modified', staged: false },
        { path: 'src/b.ts', status: 'modified', staged: false },
      ],
    });
    await openCockpit(page);

    const list = page.getByRole('listbox', { name: 'Changed files' });
    await list.focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('li[role="option"] > button:focus')).toContainText('src/b.ts');
  });

  test('mobile: renders single column with no horizontal page scroll', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockCockpit(page, {
      gitFiles: [{ path: 'src/a-very-long-path/that/keeps/going/limit.ts', status: 'modified', staged: false }],
    });
    await openCockpit(page);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
