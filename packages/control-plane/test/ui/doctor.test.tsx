// A5: the Getting started checklist shows each doctor check with its real status.
import "./dom";
import { afterEach, expect, test } from "bun:test";

const { cleanup, render, screen, within } = await import("@testing-library/react");
const { HomeView } = await import("../../ui/src/pages/home/Home");
afterEach(cleanup);

const checks = [
  { name: "git", status: "pass", detail: "2.45.0" },
  { name: "jq", status: "fail", detail: "not found (required)" },
] as const;

test("a failing check renders failing and a passing check renders passing", () => {
  render(<HomeView runs={[]} doctor={{ checks: [...checks] }} />);
  const list = screen.getByTestId("getting-started");
  const rows = within(list).getAllByTestId("doctor-check");
  expect(rows.length).toBe(2);
  expect(rows[0]!.getAttribute("data-status")).toBe("pass");
  expect(rows[1]!.getAttribute("data-status")).toBe("fail");
  expect(rows[1]!.textContent).toContain("jq");
  expect(rows[1]!.textContent).toContain("not found");
});

test("hidden when every check passes and runs exist", () => {
  const run = { source_id: "s", run_id: "r", verdict: "VERIFIED", started_at: "2026-10-03T10:00:00Z", status: "completed" } as never;
  render(<HomeView runs={[run]} doctor={{ checks: [checks[0]] }} />);
  expect(screen.queryByTestId("getting-started")).toBeNull();
});

test("a failed doctor route shows a real error state, no placeholder rows", () => {
  render(<HomeView runs={[]} doctor={{ error: "/v1/doctor: HTTP 502" }} />);
  expect(screen.getByTestId("getting-started-error").textContent).toContain("HTTP 502");
  expect(screen.queryAllByTestId("doctor-check").length).toBe(0);
});
