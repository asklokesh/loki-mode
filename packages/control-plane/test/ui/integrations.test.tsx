// CPE-20: the Integrations page shows probe status honestly and Connect goes through the CPE-14 etag/If-Match flow with a NAME only.
import "./dom";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";

const realFetch = globalThis.fetch;
const { cleanup, fireEvent, render, screen, waitFor, within } = await import("@testing-library/react");
const { IntegrationsPage, page } = await import("../../ui/src/pages/integrations/index");

const row = (id: string, label: string, status: string, extra: Record<string, unknown> = {}) =>
  ({ id, label, status, method: "none", env_name: null, env_set: false, config_path: null, detail: `${label} detail`, ...extra });
let puts: Array<{ ifMatch: string | null; body: any }> = [];

beforeAll(() => { (globalThis as { LOKI_CONTROL_BASE?: string }).LOKI_CONTROL_BASE = ""; });
afterEach(cleanup);
afterAll(() => { globalThis.fetch = realFetch; });

function serve(putStatus = 200) {
  puts = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (String(url).endsWith("/v1/integrations")) {
      return new Response(JSON.stringify({ integrations: [
        row("github", "GitHub", "not_connected", { config_path: "git.token_env" }),
        row("jira", "Jira", "not_measured"),
        row("slack", "Slack", "connected", { config_path: "notifications.slack_webhook_env", env_name: "SLACK_HOOK", env_set: true }),
      ] }));
    }
    if (init?.method === "PUT") {
      const h = init.headers as Record<string, string>;
      puts.push({ ifMatch: h["if-match"] ?? null, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify(putStatus === 200 ? { ok: true, etag: "\"e2\"", config: {} } : { error: "loki.yaml changed since it was read" }), { status: putStatus });
    }
    return new Response(JSON.stringify({ exists: true, etag: "\"e1\"", config: { provider: "claude" }, errors: [] }));
  }) as unknown as typeof fetch;
}

test("page export", () => {
  expect(page).toMatchObject({ id: "integrations", path: "/integrations", title: "Integrations", inSettings: true });
});

test("renders status and not measured honestly; no Connect for services without a loki.yaml key", async () => {
  serve();
  render(<IntegrationsPage />);
  await waitFor(() => screen.getByText("GitHub"));
  expect(screen.getByText("not measured")).toBeTruthy();
  expect(screen.getByText("connected")).toBeTruthy();
  expect(within(screen.getByTestId("integration-jira")).queryByText("Connect")).toBeNull();
});

test("Connect sends only the NAME with the config etag", async () => {
  serve();
  render(<IntegrationsPage />);
  await waitFor(() => screen.getByText("GitHub"));
  const card = within(screen.getByTestId("integration-github"));
  fireEvent.input(card.getByLabelText("GitHub variable name"), { target: { value: "MY_GH" } });
  fireEvent.click(card.getByText("Connect"));
  await waitFor(() => expect(puts.length).toBe(1));
  expect(puts[0]!.ifMatch).toBe("\"e1\"");
  expect(puts[0]!.body).toEqual({ config: { provider: "claude", git: { token_env: "MY_GH" } } });
});

test("a secret-looking value is not sendable", async () => {
  serve();
  render(<IntegrationsPage />);
  await waitFor(() => screen.getByText("GitHub"));
  const card = within(screen.getByTestId("integration-github"));
  fireEvent.input(card.getByLabelText("GitHub variable name"), { target: { value: "ghp_abc123secret" } });
  expect((card.getByText("Connect") as HTMLButtonElement).disabled).toBe(true);
  expect(card.getByRole("alert")).toBeTruthy();
  expect(puts.length).toBe(0);
});

test("a 409 conflict is surfaced", async () => {
  serve(409);
  render(<IntegrationsPage />);
  await waitFor(() => screen.getByText("GitHub"));
  const card = within(screen.getByTestId("integration-github"));
  fireEvent.input(card.getByLabelText("GitHub variable name"), { target: { value: "MY_GH" } });
  fireEvent.click(card.getByText("Connect"));
  await waitFor(() => card.getByText(/changed since it was read/));
});
