// Composer-first home: the hero input, pickers wired only to real API options, and the start call.
import "./dom";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";

const realFetch = globalThis.fetch;
const { cleanup, fireEvent, render, screen, waitFor } = await import("@testing-library/react");
const { Hero } = await import("../../ui/src/pages/home/Hero");

let posted: { url: string; body: Record<string, unknown> }[] = [];
beforeAll(() => {
  (globalThis as { LOKI_CONTROL_BASE?: string }).LOKI_CONTROL_BASE = "";
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith("/v1/repos")) return new Response(JSON.stringify({ repos: ["alpha", "beta"] }));
    if (init?.method === "POST") { posted.push({ url: u, body: JSON.parse(String(init.body)) }); return new Response(JSON.stringify({ ok: true, pid: 1, command: "loki start" })); }
    return new Response("nope", { status: 404 });
  }) as unknown as typeof fetch;
});
afterEach(() => { cleanup(); posted = []; });
afterAll(() => { globalThis.fetch = realFetch; });

test("hero asks What should Loki build and offers no Plan/Build toggle or branch picker", () => {
  render(<Hero />);
  expect(screen.getByText("What should Loki build?")).toBeTruthy();
  expect(screen.queryByText(/^plan$/i)).toBeNull();
  expect(screen.queryByText(/branch/i)).toBeNull();
  expect((screen.getByTestId("hero-start") as HTMLButtonElement).disabled).toBe(true);
});

test("an issue URL is normalized and posted with the picked repo and harness", async () => {
  render(<Hero />);
  fireEvent.input(screen.getByTestId("hero-input"), { target: { value: "https://github.com/o/r/issues/7" } });
  await waitFor(() => expect(screen.getByTestId("pick-repo")).toBeTruthy());
  fireEvent.click(screen.getByTestId("pick-repo").querySelector("button")!);
  fireEvent.click(await screen.findByText("beta"));
  fireEvent.click(screen.getByTestId("pick-provider").querySelector("button")!);
  fireEvent.click(await screen.findByText("codex"));
  fireEvent.click(screen.getByTestId("pick-model").querySelector("button")!);
  fireEvent.click(await screen.findByText("haiku"));
  fireEvent.click(screen.getByTestId("hero-start"));
  await waitFor(() => expect(posted.length).toBe(1));
  expect(posted[0]!.url).toBe("/v1/runs");
  expect(posted[0]!.body).toEqual({ target: "o/r#7", repo: "beta", provider: "codex", model: "haiku" });
  expect((await screen.findByTestId("hero-note")).textContent).toContain("o/r#7");
  expect((screen.getByTestId("hero-input") as HTMLTextAreaElement).value).toBe("");
});

test("Enter starts a plain task", async () => {
  render(<Hero />);
  fireEvent.input(screen.getByTestId("hero-input"), { target: { value: "add a health endpoint" } });
  fireEvent.keyDown(screen.getByTestId("hero-input"), { key: "Enter" });
  await waitFor(() => expect(posted.length).toBe(1));
  expect(posted[0]!.body).toEqual({ target: "add a health endpoint" });
});
