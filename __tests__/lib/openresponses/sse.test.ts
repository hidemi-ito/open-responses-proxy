import { describe, it, expect } from "vitest";
import { sseEvent, sseDone, SSE_HEADERS } from "@/lib/openresponses/sse";

const decoder = new TextDecoder();

/** Parse raw SSE text into an array of { event, data } objects. */
function parseSSE(text: string): Array<{ event: string; data: string }> {
  const events: Array<{ event: string; data: string }> = [];
  const blocks = text.split("\n\n").filter(Boolean);
  for (const block of blocks) {
    const lines = block.split("\n");
    let event = "";
    let data = "";
    for (const line of lines) {
      if (line.startsWith("event: ")) {
        event = line.slice("event: ".length);
      } else if (line.startsWith("data: ")) {
        data = line.slice("data: ".length);
      }
    }
    if (event || data) {
      events.push({ event, data });
    }
  }
  return events;
}

describe("sseEvent", () => {
  it("encodes event type and JSON data with correct wire format", () => {
    const payload = { type: "response.in_progress", sequence_number: 1 };
    const bytes = sseEvent("response.in_progress", payload);
    const text = decoder.decode(bytes);

    expect(text).toBe(
      `event: response.in_progress\ndata: ${JSON.stringify(payload)}\n\n`,
    );
  });

  it("returns Uint8Array", () => {
    const bytes = sseEvent("test", { foo: 1 });
    expect(bytes).toBeInstanceOf(Uint8Array);
  });

  it("can be parsed back into structured events", () => {
    const payload = { type: "response.output_text.delta", delta: "Hello" };
    const text = decoder.decode(sseEvent("response.output_text.delta", payload));
    const events = parseSSE(text);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("response.output_text.delta");
    expect(JSON.parse(events[0].data)).toEqual(payload);
  });

  it("handles payloads with special characters", () => {
    const payload = { text: 'line1\nline2\ttab "quoted"' };
    const text = decoder.decode(sseEvent("test", payload));
    const events = parseSSE(text);
    // JSON.stringify escapes newlines, so the data line is a single line
    expect(JSON.parse(events[0].data)).toEqual(payload);
  });
});

describe("sseDone", () => {
  it("encodes the [DONE] sentinel", () => {
    const bytes = sseDone();
    const text = decoder.decode(bytes);
    expect(text).toBe("data: [DONE]\n\n");
  });

  it("returns Uint8Array", () => {
    expect(sseDone()).toBeInstanceOf(Uint8Array);
  });
});

describe("SSE_HEADERS", () => {
  it("has Content-Type text/event-stream", () => {
    expect(SSE_HEADERS["Content-Type"]).toBe("text/event-stream");
  });

  it("has no-cache Cache-Control", () => {
    expect(SSE_HEADERS["Cache-Control"]).toBe("no-cache, no-transform");
  });

  it("has keep-alive connection", () => {
    expect(SSE_HEADERS.Connection).toBe("keep-alive");
  });

  it("disables Nginx buffering", () => {
    expect(SSE_HEADERS["X-Accel-Buffering"]).toBe("no");
  });
});
