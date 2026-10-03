// CPE-08: the new run composer. Request bodies per chip, Cmd+Enter, error wording, and no invented fields.
import "./dom";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";

const realFetch = globalThis.fetch;
const { cleanup, fireEvent, render, screen, waitFor } = await import("@testing-library/react");
const { Composer, buildBody, normalizeTarget, page } = await import("../../ui/src/pages/compose");

type Call = { url: string; method: string; body: Record<string, unknown> | null };
let calls: Call[] = [];
let post: () => Promise<Response> = async () => new Response(JSON.stringify({ ok: true, pid: 1, command: "start x" }));
let repos: string[] = ["alpha", "beta"];

beforeAll(() => { (globalThis as { LOKI_CONTROL_BASE?: string }).LOKI_CONTROL_BASE = ""; });
beforeEach(() => {
  calls = []; location.hash = ""; repos = ["alpha", "beta"];
  post = async () => new Response(JSON.stringify({ ok: true, pid: 1, command: "start x" }));
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "POST") { calls.push({ url: String(url), method, body: JSON.parse(String(init?.body)) }); return post(); }
    if (String(url).startsWith("/v1/repos")) return new Response(JSON.stringify({ repos }));
    return new Response("nope", { status: 404 });
  }) as unknown as typeof fetch;
});
afterEach(cleanup);
afterAll(() => { globalThis.fetch = realFetch; location.hash = ""; });

const type = (v: string) => fireEvent.input(screen.getByTestId("composer-input"), { target: { value: v } });
const pick = async (chip: string, label: string) => {
  fireEvent.click(screen.getByTestId(chip).querySelector("button")!);
  fireEvent.click(await screen.findByRole("menuitem", { name: label }));
};

test("page export targets the New run route", () => {
  expect(page.path).toBe("/new");
  expect(page.component).toBe(Composer);
});

test("empty state shows before any input, and the repo chip lists GET /v1/repos", async () => {
  render(<Composer />);
  expect(screen.getByText("What should Loki build?")).toBeTruthy();
  await screen.findByTestId("chip-repo");
  await waitFor(() => {
    fireEvent.click(screen.getByTestId("chip-repo").querySelector("button")!);
    expect(screen.getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["server directory", "alpha", "beta"]);
  });
  type("fix the bug");
  expect(screen.queryByText("What should Loki build?")).toBeNull();
});

test("no repos discovered reads as such", async () => {
  repos = [];
  render(<Composer />);
  expect(await screen.findByTestId("no-repos")).toBeTruthy();
});

test("a bare task sends only target", async () => {
  render(<Composer />);
  type("add a health endpoint");
  fireEvent.click(screen.getByTestId("composer-submit"));
  await waitFor(() => expect(calls.length).toBe(1));
  expect(calls[0]!.url).toBe("/v1/runs");
  expect(calls[0]!.body).toEqual({ target: "add a health endpoint" });
});

test("each chip adds exactly its own field", async () => {
  const cases: Array<[string, string, Record<string, string>]> = [
    ["chip-repo", "beta", { repo: "beta" }],
    ["chip-model", "sonnet", { model: "sonnet" }],
    ["chip-provider", "codex", { provider: "codex" }],
    ["chip-budget", "$10", { budget: "10" }],
  ];
  for (const [chip, label, extra] of cases) {
    calls = []; cleanup(); location.hash = "";
    render(<Composer />);
    type("o/r#5");
    if (chip === "chip-repo") await waitFor(() => { fireEvent.click(screen.getByTestId(chip).querySelector("button")!); expect(screen.getAllByRole("menuitem").length).toBe(3); fireEvent.click(screen.getByTestId(chip).querySelector("button")!); });
    await pick(chip, label);
    fireEvent.click(screen.getByTestId("composer-submit"));
    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]!.body).toEqual({ target: "o/r#5", ...extra });
  }
});

test("workspace chip sends workspace and drops provider and budget", async () => {
  render(<Composer />);
  type("o/r#5");
  await pick("chip-provider", "claude");
  await pick("chip-budget", "$5");
  fireEvent.click(screen.getByTestId("chip-workspace"));
  fireEvent.input(await screen.findByTestId("workspace-input"), { target: { value: "platform" } });
  fireEvent.click(screen.getByTestId("composer-submit"));
  await waitFor(() => expect(calls.length).toBe(1));
  expect(calls[0]!.body).toEqual({ target: "o/r#5", workspace: "platform" });
});

test("a GitHub issue URL is sent as owner/repo#N; a PRD path is sent as typed", () => {
  expect(normalizeTarget("https://github.com/acme/web/issues/42")).toBe("acme/web#42");
  expect(normalizeTarget("  docs/prd.md ")).toBe("docs/prd.md");
  expect(buildBody("docs/prd.md", {})).toEqual({ target: "docs/prd.md" });
});

test("Cmd+Enter submits, navigates to the run list, and shows an optimistic row meanwhile", async () => {
  let release!: () => void;
  post = () => new Promise<Response>((res) => { release = () => res(new Response(JSON.stringify({ ok: true, pid: 9, command: "x" }))); });
  render(<Composer />);
  const input = screen.getByTestId("composer-input");
  type("ship it");
  fireEvent.keyDown(input, { key: "Enter", metaKey: true });
  expect((await screen.findByTestId("optimistic-row")).textContent).toContain("ship it");
  expect(location.hash).toBe("");
  release();
  await waitFor(() => expect(location.hash).toBe("#/runs"));
  expect(calls.length).toBe(1);
});

test("plain Enter does not submit, and an empty input does not submit", () => {
  render(<Composer />);
  type("hello");
  fireEvent.keyDown(screen.getByTestId("composer-input"), { key: "Enter" });
  type("");
  fireEvent.keyDown(screen.getByTestId("composer-input"), { key: "Enter", metaKey: true });
  expect(calls.length).toBe(0);
});

test("409 shows the server message, clears the optimistic row, and stays on the page", async () => {
  post = async () => new Response(JSON.stringify({ error: "a run is already starting or running in this repo" }), { status: 409 });
  render(<Composer />);
  type("again");
  fireEvent.keyDown(screen.getByTestId("composer-input"), { key: "Enter", metaKey: true });
  const err = await screen.findByTestId("composer-error");
  expect(err.textContent).toContain("a run is already starting or running in this repo");
  expect(err.textContent).toContain("Wait for it to finish");
  expect(screen.queryByTestId("optimistic-row")).toBeNull();
  expect(location.hash).toBe("");
});

test("400 and 403 show their own wording", async () => {
  post = async () => new Response(JSON.stringify({ error: "repo is not a known project" }), { status: 400 });
  render(<Composer />);
  type("x");
  fireEvent.click(screen.getByTestId("composer-submit"));
  expect((await screen.findByTestId("composer-error")).textContent).toContain("The server refused this run: repo is not a known project");
  post = async () => new Response(JSON.stringify({ error: "loopback JSON requests only" }), { status: 403 });
  fireEvent.click(screen.getByTestId("composer-submit"));
  await waitFor(() => expect(screen.getByTestId("composer-error").textContent).toContain("Not allowed: loopback JSON requests only"));
});

test("no fields are invented: a fully chipped body has only the server's known keys", async () => {
  render(<Composer />);
  type("o/r#1");
  await waitFor(() => { fireEvent.click(screen.getByTestId("chip-repo").querySelector("button")!); expect(screen.getAllByRole("menuitem").length).toBe(3); fireEvent.click(screen.getByTestId("chip-repo").querySelector("button")!); });
  await pick("chip-repo", "alpha");
  await pick("chip-model", "opus");
  await pick("chip-provider", "claude");
  await pick("chip-budget", "$25");
  fireEvent.click(screen.getByTestId("composer-submit"));
  await waitFor(() => expect(calls.length).toBe(1));
  expect(Object.keys(calls[0]!.body!).sort()).toEqual(["budget", "model", "provider", "repo", "target"]);
  expect(calls[0]!.body).toEqual({ target: "o/r#1", repo: "alpha", model: "opus", provider: "claude", budget: "25" });
});
