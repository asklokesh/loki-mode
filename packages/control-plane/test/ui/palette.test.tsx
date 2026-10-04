// CPE-22: Cmd+K palette, search, shortcuts, ARIA.
import "./dom";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";

const realFetch = globalThis.fetch;
const { act, cleanup, fireEvent, render, screen } = await import("@testing-library/react");
const { CommandPalette } = await import("../../ui/src/palette");
const { closeNewRun, getNewRun } = await import("../../ui/src/pages/compose/store");
const { openCommandPalette } =await import("../../ui/src/shell/hooks");
const { setTheme } = await import("../../ui/src/shell/theme");
const { registerPage, unregisterPage } = await import("../../ui/src/pages/registry");
const { search, runItems, pageItems, actionItems } = await import("../../ui/src/palette/items");

const run = (id: string, at: string) => ({ source_id: "s1", run_id: id, origin_repo: "o/r", title: id, issue_ref: null, verdict: "VERIFIED", status: "done", started_at: at, last_event_at: null });
const Page = () => null;

beforeAll(() => {
  (globalThis as { LOKI_CONTROL_BASE?: string }).LOKI_CONTROL_BASE = "";
  globalThis.fetch = (async () => new Response(JSON.stringify({ runs: [run("old-run", "2026-10-01T00:00:00Z"), run("new-run", "2026-10-03T00:00:00Z")], total: 2, next_cursor: null }))) as unknown as typeof fetch;
  registerPage({ id: "t-cost", path: "/cost", title: "Cost", component: Page });
  registerPage({ id: "t-run", path: "/runs/:s/:r", title: "Run", component: Page });
});
afterEach(() => { cleanup(); location.hash = ""; document.documentElement.setAttribute("data-theme", "dark"); });
afterAll(() => { globalThis.fetch = realFetch; unregisterPage("t-cost"); unregisterPage("t-run"); });

const key = (init: KeyboardEventInit) => act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init })); });
const openIt = async () => { render(<CommandPalette />); act(() => { openCommandPalette(); }); return screen.findByRole("combobox"); };

test("Cmd+K hook opens the palette with ARIA combobox and listbox, then Esc closes", async () => {
  const box = await openIt();
  const list = screen.getByRole("listbox");
  expect(box.getAttribute("aria-controls")).toBe(list.id);
  expect(await screen.findByText("new-run")).toBeTruthy();
  key({ key: "Escape" });
  expect(screen.queryByRole("combobox")).toBeNull();
});

test("lists actions, registered pages (no parameterised ones) and runs newest first", async () => {
  await openIt();
  await screen.findByText("new-run");
  const labels = screen.getAllByRole("option").map((o) => o.textContent ?? "");
  expect(labels[0]).toContain("New run");
  expect(labels.some((l) => l.startsWith("Cost"))).toBe(true);
  expect(labels.some((l) => l.startsWith("Run/"))).toBe(false);
  expect(labels.findIndex((l) => l.startsWith("new-run"))).toBeLessThan(labels.findIndex((l) => l.startsWith("old-run")));
});

test("typing filters, active descendant tracks the option, Enter navigates", async () => {
  const box = await openIt();
  await screen.findByText("new-run");
  fireEvent.input(box, { target: { value: "old" } });
  const opts = screen.getAllByRole("option");
  expect(opts.length).toBe(1);
  expect(box.getAttribute("aria-activedescendant")).toBe(opts[0]!.id);
  fireEvent.keyDown(box, { key: "Enter" });
  expect(location.hash).toBe("#/runs/s1/old-run");
  expect(screen.queryByRole("combobox")).toBeNull();
});

test("arrow keys wrap and mark the highlighted option selected", async () => {
  const box = await openIt();
  await screen.findByText("new-run");
  fireEvent.keyDown(box, { key: "ArrowUp" });
  const opts = screen.getAllByRole("option");
  expect(opts[opts.length - 1]!.getAttribute("aria-selected")).toBe("true");
  expect(opts[0]!.getAttribute("aria-selected")).toBe("false");
});

test("Cmd+N opens the New run picker (not a route), Cmd+Shift+D toggles the theme", () => {
  render(<CommandPalette />);
  closeNewRun();
  key({ key: "n", metaKey: true });
  expect(getNewRun().open).toBe(true);
  expect(getNewRun().preset).toBeNull();
  expect(location.hash).toBe("");
  closeNewRun();
  setTheme("dark"); // pin the store so the toggle result does not depend on the system preference
  const before = document.documentElement.getAttribute("data-theme");
  key({ key: "D", metaKey: true, shiftKey: true });
  expect(document.documentElement.getAttribute("data-theme")).not.toBe(before);
});

test("a run without a title is labelled by its issue ref or Untitled task, never its run id", () => {
  const items = runItems([{ ...run("hidden-id", "2026-10-03T00:00:00Z"), title: null, issue_ref: "o/r#9" }, { ...run("hidden-2", "2026-10-02T00:00:00Z"), title: null, issue_ref: null }] as never);
  expect(items.map((i) => i.label)).toEqual(["o/r#9", "Untitled task"]);
});

test("search: empty query lists all, no match is empty, runs capped", () => {
  const many = runItems(Array.from({ length: 20 }, (_, i) => run(`r${i}`, "2026-10-03T00:00:00Z")) as never);
  expect(search("", [], many, actionItems()).filter((i) => i.kind === "Runs").length).toBe(8);
  expect(search("zzzz", pageItems([]), many, actionItems())).toEqual([]);
});
