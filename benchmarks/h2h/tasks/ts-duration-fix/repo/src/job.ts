import { parseDuration } from "./duration";

export interface JobConfig {
  name: string;
  timeout: string;
  retryDelay?: string;
}

export interface Job {
  name: string;
  timeoutMs: number;
  retryDelayMs: number;
}

export function loadJob(cfg: JobConfig): Job {
  return {
    name: cfg.name,
    timeoutMs: parseDuration(cfg.timeout),
    retryDelayMs: cfg.retryDelay ? parseDuration(cfg.retryDelay) : 0,
  };
}
