// CPE-15: the Models and providers page shows detected CLIs and never an env var value.
import "./dom";
import { afterAll, afterEach, expect, test } from "bun:test";

const realFetch = globalThis.fetch;
const { cleanup, render, screen, waitFor } = await import("@testing-library/react");
const { ModelsPage, page } = await import("../../ui/src/pages/models/index");

afterEach(cleanup);
afterAll(() => { globalThis.fetch = realFetch; });

test("page export is a settings page", () => {
  expect(page).toMatchObject({ id: "models", path: "/models", inSettings: true });
});

test("renders installed, missing and deprecated providers honestly", async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({
    catalog_updated: "2026-09-26", probe_timeout_ms: 3000,
    providers: [
      { id: "claude", deprecated: false, installed: true, version: "2.1.7", probe: "ok", auth_env_names: ["ANTHROPIC_API_KEY"], auth_env_set: ["ANTHROPIC_API_KEY"], auth_present: true, tiers: { planning: "opus-x", development: "sonnet-x", fast: null }, models: [] },
      { id: "gemini", deprecated: true, installed: false, version: null, probe: "not_found", auth_env_names: [], auth_env_set: [], auth_present: false, tiers: {}, models: [] },
    ],
  }))) as unknown as typeof fetch;
  render(<ModelsPage />);
  await waitFor(() => screen.getByText("claude"));
  expect(screen.getByText("installed, 2.1.7")).toBeTruthy();
  expect(screen.getByText("deprecated")).toBeTruthy();
  expect(screen.getByText("not installed")).toBeTruthy();
  expect(screen.getByText("auth present")).toBeTruthy();
  expect(screen.getAllByText("not measured").length).toBeGreaterThan(0);
});
