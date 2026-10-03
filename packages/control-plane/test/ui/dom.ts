// One happy-dom for the whole bun process. testing-library and React bind to the first document they see,
// so UI files never unregister it. The web-platform classes the server tests rely on are put back after
// registering, so happy-dom's Request, Response, Headers and fetch never leak into non-UI test files.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const KEEP = ["fetch", "Request", "Response", "Headers", "FormData", "Blob", "File", "URL", "URLSearchParams", "AbortController", "AbortSignal", "ReadableStream", "TextEncoder", "TextDecoder", "WebSocket", "EventTarget", "Event"] as const;
if (!GlobalRegistrator.isRegistered) {
  const saved = KEEP.map((k) => [k, (globalThis as Record<string, unknown>)[k]] as const);
  GlobalRegistrator.register();
  for (const [k, v] of saved) (globalThis as Record<string, unknown>)[k] = v;
}
export const realFetch = globalThis.fetch;
