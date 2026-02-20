/**
 * SSE utilities for Responses API streaming.
 *
 * Wire format:
 *   event: <type>\n
 *   data: <json>\n\n
 *
 * End sentinel:
 *   data: [DONE]\n\n
 */

const encoder = new TextEncoder();

/** Encode a single SSE event (event: + data:). */
export function sseEvent(eventType: string, data: unknown): Uint8Array {
  const json = JSON.stringify(data);
  return encoder.encode(`event: ${eventType}\ndata: ${json}\n\n`);
}

/** Encode the terminal [DONE] marker. */
export function sseDone(): Uint8Array {
  return encoder.encode("data: [DONE]\n\n");
}

/** Standard SSE response headers. */
export const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
} as const;
