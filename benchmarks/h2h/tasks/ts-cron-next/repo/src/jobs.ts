export interface Job {
  name: string;
  schedule: string;
}

/** An in-memory registry of named jobs and their cron schedules. */
export class JobList {
  private jobs = new Map<string, Job>();

  add(name: string, schedule: string): Job {
    const key = name.trim();
    if (!key) throw new Error("job name is required");
    if (this.jobs.has(key)) throw new Error(`job ${key} already exists`);
    const job = { name: key, schedule: schedule.trim() };
    this.jobs.set(key, job);
    return job;
  }

  remove(name: string): boolean {
    return this.jobs.delete(name.trim());
  }

  list(): Job[] {
    return [...this.jobs.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
}
