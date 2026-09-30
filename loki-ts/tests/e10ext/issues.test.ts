// E-127 Wall check: argument shape, limit cap, malformed rejection, empty list, no shell injection.
import { describe, expect, it } from "bun:test";
import { fetchIssues, MAX_ISSUES } from "../../src/e10ext/issues.ts";

const row = { number: 7, title: "t", body: "b", url: "u", labels: [{ name: "bug" }, { name: "p1" }] };

function stub(out: string) {
  const calls: { cmd: string; args: string[] }[] = [];
  return { calls, execer: (cmd: string, args: string[]) => (calls.push({ cmd, args }), out) };
}

describe("fetchIssues", () => {
  it("passes label, milestone and state as array args and parses rows", () => {
    const s = stub(JSON.stringify([row]));
    const r = fetchIssues({ repo: "o/r", label: "bug", milestone: "M1", limit: 5 }, s.execer);
    expect(s.calls[0]).toEqual({
      cmd: "gh",
      args: ["issue", "list", "--repo", "o/r", "--label", "bug", "--milestone", "M1", "--state", "open",
        "--limit", "5", "--json", "number,title,body,labels,url"],
    });
    expect(r).toEqual([{ ref: "o/r#7", number: 7, title: "t", body: "b", labels: ["bug", "p1"], url: "u" }]);
  });

  it("omits label and milestone when absent", () => {
    const s = stub("[]");
    fetchIssues({ repo: "o/r", limit: 1 }, s.execer);
    expect(s.calls[0]!.args).not.toContain("--label");
    expect(s.calls[0]!.args).not.toContain("--milestone");
  });

  it("caps the limit", () => {
    const s = stub("[]");
    fetchIssues({ repo: "o/r", limit: 1000 }, s.execer);
    const a = s.calls[0]!.args;
    expect(a[a.indexOf("--limit") + 1]).toBe(String(MAX_ISSUES));
  });

  it("rejects bad limits and repos before running anything", () => {
    const s = stub("[]");
    expect(() => fetchIssues({ repo: "o/r", limit: 0 }, s.execer)).toThrow();
    expect(() => fetchIssues({ repo: "o/r", limit: 1.5 }, s.execer)).toThrow();
    expect(() => fetchIssues({ repo: "o r; echo hi", limit: 1 }, s.execer)).toThrow();
    expect(s.calls.length).toBe(0);
  });

  it("rejects malformed output", () => {
    const bad = ["not json", "{}", "[1]", "[null]", JSON.stringify([{ ...row, number: "7" }]),
      JSON.stringify([{ ...row, labels: ["bug"] }]), JSON.stringify([row, { ...row, title: 3 }])];
    for (const out of bad) {
      expect(() => fetchIssues({ repo: "o/r", limit: 5 }, stub(out).execer)).toThrow(/fetchIssues/);
    }
  });

  it("treats a null body as empty and an empty result as an empty list", () => {
    expect(fetchIssues({ repo: "o/r", limit: 5 }, stub("[]").execer)).toEqual([]);
    const r = fetchIssues({ repo: "o/r", limit: 5 }, stub(JSON.stringify([{ ...row, body: null }])).execer);
    expect(r[0]!.body).toBe("");
  });

  it("keeps hostile label text as one literal argv element", () => {
    const s = stub("[]");
    const evil = 'x"; touch /tmp/pwned #$(id)`';
    fetchIssues({ repo: "o/r", label: evil, limit: 1 }, s.execer);
    expect(s.calls[0]!.cmd).toBe("gh");
    expect(s.calls[0]!.args).toContain(evil);
  });
});
