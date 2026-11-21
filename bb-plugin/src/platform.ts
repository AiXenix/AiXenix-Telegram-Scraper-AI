// What the engine needs from the place it runs in. Two implementations exist:
// the bb plugin (server.ts) and the standalone script (standalone-src/main.ts).
import type { Config } from "./config.ts";

export type Runtime = "bb" | "standalone";

export interface Platform {
  readonly runtime: Runtime;
  /** All outgoing HTTP goes through this, so the standalone script can route it via a proxy. */
  fetch: typeof fetch;
  log(level: "info" | "warn" | "error", message: string): void;
  /** Something the admin page shows has changed. */
  changed(): void;
}

export interface ConfigStore {
  load(): Promise<Config>;
  save(next: Config): Promise<void>;
}

export interface LlmRequest {
  /** Short label for logs, e.g. "отбор" or "черновик". */
  task: string;
  model: string;
  reasoning: string;
  prompt: string;
  signal: AbortSignal;
  timeoutMs?: number;
}

export interface LlmRunner {
  run(request: LlmRequest): Promise<string>;
}

/** Sleeps until the time passes or the signal aborts, whichever comes first. Never rejects. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
