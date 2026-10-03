// CPE-14: Settings forms render the loaded loki.yaml, save one section with If-Match, and surface server refusals.
import "./dom";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";

const realFetch = globalThis.fetch;
const { cleanup, fireEvent, render, screen, waitFor, within } = await import("@testing-library/react");
const { ConfigSettings, SECTIONS, page } = await import("../../ui/src/pages/settings");

type Call = { method: string; ifMatch: string | null; body: unknown };
let calls: Call[] = [];

function serve(opts: { config?: Record<string, unknown>; errors?: string[]; exists?: boolean; put?: { status: number; body: unknown } }) {
  calls = [];
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "PUT") {
      const h = init?.headers as Record<string, string>;
      const body = JSON.parse(String(init?.body));
      calls.push({ method, ifMatch: h["if-match"] ?? null, body });
      const p = opts.put ?? { status: 200, body: { ok: true, etag: "\"e2\"", config: body.config } };
      return new Response(JSON.stringify(p.body), { status: p.status });
    }
    return new Response(JSON.stringify({ exists: opts.exists ?? true, etag: "\"e1\"", config: opts.config ?? {}, errors: opts.errors ?? [] }));
  }) as unknown as typeof fetch;
}

beforeAll(() => { (globalThis as { LOKI_CONTROL_BASE?: string }).LOKI_CONTROL_BASE = ""; });
afterEach(cleanup);
afterAll(() => { globalThis.fetch = realFetch; });

test("exports a settings page with one form card per schema section", async () => {
  expect(page.inSettings).toBe(true);
  expect(page.path).toBe("/settings/config");
  expect(SECTIONS.map((s) => s.id)).toEqual(["provider", "models", "git", "repos", "concurrency", "budgets", "knowledge_sources", "workspaces", "notifications"]);
  serve({ config: {} });
  render(<ConfigSettings />);
  for (const s of SECTIONS) expect(await screen.findByTestId(`settings-${s.id}`)).toBeTruthy();
});

test("loaded values fill the forms and a missing file says saving creates it", async () => {
  serve({ exists: false, config: {} });
  render(<ConfigSettings />);
  expect(await screen.findByText(/No loki.yaml in this repo yet/)).toBeTruthy();
  cleanup();
  serve({ config: { provider: "codex", models: { default: "sonnet" }, repos: ["a/b", "c/d"], budgets: { per_run_usd: 5 } } });
  render(<ConfigSettings />);
  await screen.findByTestId("config-settings");
  expect((document.querySelector('[data-field="provider"]') as HTMLSelectElement).value).toBe("codex");
  expect((document.querySelector('[data-field="models.default"]') as HTMLInputElement).value).toBe("sonnet");
  expect((document.querySelector('[data-field="repos"]') as HTMLTextAreaElement).value).toBe("a/b\nc/d");
  expect((document.querySelector('[data-field="budgets.per_run_usd"]') as HTMLInputElement).value).toBe("5");
  expect((document.querySelector('[data-field="budgets.per_day_usd"]') as HTMLInputElement).value).toBe("");
});

test("saving a section PUTs the whole config with If-Match and leaves other sections alone", async () => {
  serve({ config: { provider: "claude", concurrency: 2 } });
  render(<ConfigSettings />);
  const card = within(await screen.findByTestId("settings-models"));
  const save = card.getByRole("button", { name: "Save" }) as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  fireEvent.input(card.getByLabelText("Default model"), { target: { value: "opus" } });
  expect(save.disabled).toBe(false);
  fireEvent.click(save);
  await waitFor(() => expect(calls.length).toBe(1));
  expect(calls[0]!.ifMatch).toBe("\"e1\"");
  expect(calls[0]!.body).toEqual({ config: { provider: "claude", concurrency: 2, models: { default: "opus" } } });
  expect(await card.findByText("Saved")).toBeTruthy();
});

test("clearing a field unsets it, and bad local input never reaches the server", async () => {
  serve({ config: { budgets: { per_run_usd: 5, per_day_usd: 20 }, workspaces: { a: { repos: [] } } } });
  render(<ConfigSettings />);
  const budgets = within(await screen.findByTestId("settings-budgets"));
  fireEvent.input(budgets.getByLabelText("Per run (USD)"), { target: { value: "" } });
  fireEvent.click(budgets.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(calls.length).toBe(1));
  expect(calls[0]!.body).toEqual({ config: { budgets: { per_day_usd: 20 }, workspaces: { a: { repos: [] } } } });
  const ws = within(screen.getByTestId("settings-workspaces"));
  fireEvent.input(ws.getByLabelText("Workspaces (JSON)"), { target: { value: "{ not json" } });
  fireEvent.click(ws.getByRole("button", { name: "Save" }));
  expect((await ws.findByRole("alert")).textContent).toContain("not valid JSON");
  expect(calls.length).toBe(1);
});

test("a server refusal for a secret-looking value is shown with its path, and a 409 asks for a reload", async () => {
  serve({ config: {}, put: { status: 422, body: { error: "value looks like a secret; loki.yaml stores env var names only", paths: ["git.token_env"] } } });
  render(<ConfigSettings />);
  const git = within(await screen.findByTestId("settings-git"));
  fireEvent.input(git.getByLabelText("Token variable name"), { target: { value: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" } });
  fireEvent.click(git.getByRole("button", { name: "Save" }));
  const alert = await git.findByRole("alert");
  expect(alert.textContent).toContain("looks like a secret");
  expect(alert.textContent).toContain("git.token_env");
  cleanup();
  serve({ config: {}, put: { status: 409, body: { error: "loki.yaml changed since it was read" } } });
  render(<ConfigSettings />);
  const p = within(await screen.findByTestId("settings-models"));
  fireEvent.input(p.getByLabelText("Cheap model"), { target: { value: "haiku" } });
  fireEvent.click(p.getByRole("button", { name: "Save" }));
  expect((await p.findByRole("alert")).textContent).toContain("changed on disk");
});

test("existing file problems are listed, and a load failure offers Retry", async () => {
  serve({ config: { provider: "gemini" }, errors: ["provider: must be one of claude, codex"] });
  render(<ConfigSettings />);
  expect((await screen.findByTestId("config-file-errors")).textContent).toContain("provider: must be one of");
  cleanup();
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: "loki.yaml is a symlink that resolves outside the repo" }), { status: 400 })) as unknown as typeof fetch;
  render(<ConfigSettings />);
  expect(await screen.findByText(/resolves outside the repo/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
});
