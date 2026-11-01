import { expect, test } from "bun:test";
import { JobList } from "../src/jobs";

test("adds and lists jobs sorted by name", () => {
  const jobs = new JobList();
  jobs.add("report", "0 9 * * MON");
  jobs.add(" backup ", " 0 2 * * * ");
  expect(jobs.list()).toEqual([
    { name: "backup", schedule: "0 2 * * *" },
    { name: "report", schedule: "0 9 * * MON" },
  ]);
});

test("rejects duplicate and empty names", () => {
  const jobs = new JobList();
  jobs.add("a", "* * * * *");
  expect(() => jobs.add("a", "* * * * *")).toThrow("job a already exists");
  expect(() => jobs.add("  ", "* * * * *")).toThrow("job name is required");
});

test("removes jobs", () => {
  const jobs = new JobList();
  jobs.add("a", "* * * * *");
  expect(jobs.remove("a")).toBe(true);
  expect(jobs.remove("a")).toBe(false);
  expect(jobs.list()).toEqual([]);
});
