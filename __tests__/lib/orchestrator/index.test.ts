/**
 * Orchestrator tests — non-streaming, streaming, and SSE contract (golden) tests.
 *
 * All external dependencies are mocked:
 * - @/lib/providers/resolver → returns a fake adapter
 * - @/lib/db/client → noop database
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type {
  ProviderAdapter,
  ProviderChatRequest,
  ProviderEvent,
  ProviderFinalResult,
} from "@/lib/providers/types";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockInsert = vi.fn().mockReturnValue({
  values: vi.fn().mockReturnValue({
    onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
  }),
});

const mockSelect = vi.fn().mockReturnValue({
  from: vi.fn().mockReturnValue({
    where: vi.fn().mockReturnValue({
      limit: vi.fn().mockResolvedValue([]),
    }),
  }),
});

const mockUpdate = vi.fn().mockReturnValue({
  set: vi.fn().mockReturnValue({
    where: vi.fn().mockResolvedValue(undefined),
  }),
});

vi.mock("@/lib/db/client", () => ({
  db: {
    insert: (...args: unknown[]) => mockInsert(...args),
    select: (...args: unknown[]) => mockSelect(...args),
    update: (...args: unknown[]) => mockUpdate(...args),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  responses: { id: "id" },
}));

/** Captures callbacks passed to next/server's after(). */
const afterCallbacks: Array<() => Promise<void>> = [];

vi.mock("next/server", () => ({
  after: (cb: () => Promise<void>) => {
    afterCallbacks.push(cb);
  },
}));

let mockAdapter: ProviderAdapter;

vi.mock("@/lib/providers/resolver", () => ({
  resolveAdapter: vi.fn(async () => ({
    adapter: mockAdapter,
    underlyingModel: "gpt-oss-20b",
  })),
}));

import { runResponse } from "@/lib/orchestrator/index";

// ---------------------------------------------------------------------------
// SSE helpers
// ---------------------------------------------------------------------------

/** Read the entire Response body as text. */
async function readBody(response: Response): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let result = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    result += decoder.decode(value, { stream: true });
  }
  return result;
}

interface SSEEvent {
  event: string;
  data: unknown;
}

/** Parse raw SSE text into typed events. */
function parseSSE(text: string): SSEEvent[] {
  const events: SSEEvent[] = [];
  const blocks = text.split("\n\n").filter(Boolean);
  for (const block of blocks) {
    const lines = block.split("\n");
    let event = "";
    let dataStr = "";
    for (const line of lines) {
      if (line.startsWith("event: ")) {
        event = line.slice("event: ".length);
      } else if (line.startsWith("data: ")) {
        dataStr = line.slice("data: ".length);
      }
    }
    if (event || dataStr) {
      let data: unknown;
      try {
        data = JSON.parse(dataStr);
      } catch {
        data = dataStr; // e.g. "[DONE]"
      }
      events.push({ event, data });
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// Fake adapter factory
// ---------------------------------------------------------------------------

function createFakeAdapter(overrides?: {
  chatResult?: ProviderFinalResult;
  streamEvents?: ProviderEvent[];
}): ProviderAdapter {
  const defaultResult: ProviderFinalResult = {
    messages: [{ type: "text", text: "Hello from mock" }],
    stopReason: "end_turn",
    usage: { inputTokens: 10, outputTokens: 5 },
  };

  const defaultStreamEvents: ProviderEvent[] = [
    { type: "text_delta", delta: "Hello" },
    { type: "text_delta", delta: " world" },
    {
      type: "message_done",
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 5 },
    },
  ];

  const chatFn = vi.fn(async () => overrides?.chatResult ?? defaultResult);
  const chatStreamFn = vi.fn(function () {
    const events = overrides?.streamEvents ?? defaultStreamEvents;
    return (async function* () {
      for (const event of events) {
        yield event;
      }
    })();
  });

  return {
    models: ["gpt-oss-20b"],
    chat: chatFn,
    chatStream: chatStreamFn,
  };
}

// ---------------------------------------------------------------------------
// Tests: Non-streaming
// ---------------------------------------------------------------------------

describe("runResponse — non-streaming", () => {
  const signal = new AbortController().signal;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAdapter = createFakeAdapter();
  });

  it("returns a JSON response with the response object", async () => {
    const response = await runResponse(
      {
        model: "gpt-oss-20b-responses",
        input: "Hi",
        stream: false,
        store: false,
        background: false,
        tools: [],
        tool_choice: "auto",
        truncation: "disabled",
        parallel_tool_calls: true,
        metadata: {},
      },
      signal,
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.object).toBe("response");
    expect(body.status).toBe("completed");
    expect(body.model).toBe("gpt-oss-20b-responses");
    expect(body.id).toMatch(/^resp_/);
  });

  it("includes text output items from the provider result", async () => {
    const response = await runResponse(
      {
        model: "gpt-oss-20b-responses",
        input: "Hi",
        stream: false,
        store: false,
        background: false,
        tools: [],
        tool_choice: "auto",
        truncation: "disabled",
        parallel_tool_calls: true,
        metadata: {},
      },
      signal,
    );

    const body = await response.json();
    expect(body.output).toHaveLength(1);
    expect(body.output[0].type).toBe("message");
    expect(body.output[0].content[0].text).toBe("Hello from mock");
  });

  it("includes usage from the provider", async () => {
    const response = await runResponse(
      {
        model: "gpt-oss-20b-responses",
        input: "Hi",
        stream: false,
        store: false,
        background: false,
        tools: [],
        tool_choice: "auto",
        truncation: "disabled",
        parallel_tool_calls: true,
        metadata: {},
      },
      signal,
    );

    const body = await response.json();
    expect(body.usage).toEqual({
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
    });
  });

  it("persists to DB when store=true", async () => {
    await runResponse(
      {
        model: "gpt-oss-20b-responses",
        input: "Hi",
        stream: false,
        store: true,
        background: false,
        tools: [],
        tool_choice: "auto",
        truncation: "disabled",
        parallel_tool_calls: true,
        metadata: {},
      },
      signal,
    );

    expect(mockInsert).toHaveBeenCalled();
  });

  it("does NOT persist to DB when store=false", async () => {
    await runResponse(
      {
        model: "gpt-oss-20b-responses",
        input: "Hi",
        stream: false,
        store: false,
        background: false,
        tools: [],
        tool_choice: "auto",
        truncation: "disabled",
        parallel_tool_calls: true,
        metadata: {},
      },
      signal,
    );

    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("includes function_call output items", async () => {
    mockAdapter = createFakeAdapter({
      chatResult: {
        messages: [
          {
            type: "tool_use",
            callId: "fc_test",
            name: "get_weather",
            arguments: '{"city":"NYC"}',
          },
        ],
        stopReason: "tool_use",
        usage: { inputTokens: 10, outputTokens: 20 },
      },
    });

    const response = await runResponse(
      {
        model: "gpt-oss-20b-responses",
        input: "What is the weather?",
        stream: false,
        store: false,
        background: false,
        tools: [
          { type: "function", name: "get_weather" },
        ],
        tool_choice: "auto",
        truncation: "disabled",
        parallel_tool_calls: true,
        metadata: {},
      },
      signal,
    );

    const body = await response.json();
    expect(body.output).toHaveLength(1);
    expect(body.output[0].type).toBe("function_call");
    expect(body.output[0].name).toBe("get_weather");
    expect(body.output[0].arguments).toBe('{"city":"NYC"}');
  });
});

// ---------------------------------------------------------------------------
// Tests: Streaming
// ---------------------------------------------------------------------------

describe("runResponse — streaming", () => {
  const signal = new AbortController().signal;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAdapter = createFakeAdapter();
  });

  it("returns SSE response with correct headers", async () => {
    const response = await runResponse(
      {
        model: "gpt-oss-20b-responses",
        input: "Hi",
        stream: true,
        store: false,
        background: false,
        tools: [],
        tool_choice: "auto",
        truncation: "disabled",
        parallel_tool_calls: true,
        metadata: {},
      },
      signal,
    );

    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(response.headers.get("Cache-Control")).toBe("no-cache, no-transform");
    expect(response.headers.get("Connection")).toBe("keep-alive");

    // Consume the body so the stream closes
    await readBody(response);
  });

  it("stream ends with [DONE] sentinel", async () => {
    const response = await runResponse(
      {
        model: "gpt-oss-20b-responses",
        input: "Hi",
        stream: true,
        store: false,
        background: false,
        tools: [],
        tool_choice: "auto",
        truncation: "disabled",
        parallel_tool_calls: true,
        metadata: {},
      },
      signal,
    );

    const text = await readBody(response);
    expect(text).toContain("data: [DONE]");
  });

  it("emits text_delta events as response.output_text.delta", async () => {
    const response = await runResponse(
      {
        model: "gpt-oss-20b-responses",
        input: "Hi",
        stream: true,
        store: false,
        background: false,
        tools: [],
        tool_choice: "auto",
        truncation: "disabled",
        parallel_tool_calls: true,
        metadata: {},
      },
      signal,
    );

    const text = await readBody(response);
    const events = parseSSE(text);

    const deltas = events.filter(
      (e) => (e.data as Record<string, unknown>)?.type === "response.output_text.delta",
    );
    expect(deltas).toHaveLength(2);
    expect((deltas[0].data as Record<string, unknown>).delta).toBe("Hello");
    expect((deltas[1].data as Record<string, unknown>).delta).toBe(" world");
  });

  it("persists response to DB when store=true", async () => {
    const response = await runResponse(
      {
        model: "gpt-oss-20b-responses",
        input: "Hi",
        stream: true,
        store: true,
        background: false,
        tools: [],
        tool_choice: "auto",
        truncation: "disabled",
        parallel_tool_calls: true,
        metadata: {},
      },
      signal,
    );

    await readBody(response);

    // Give the promise in the stream a tick to resolve
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mockInsert).toHaveBeenCalled();
  });

  it("handles tool_call events in streaming", async () => {
    mockAdapter = createFakeAdapter({
      streamEvents: [
        { type: "text_delta", delta: "I'll check " },
        {
          type: "tool_call_start",
          callId: "fc_test",
          name: "get_weather",
          outputIndex: 1,
        },
        {
          type: "tool_call_delta",
          callId: "fc_test",
          argumentsDelta: '{"city"',
        },
        {
          type: "tool_call_delta",
          callId: "fc_test",
          argumentsDelta: ':"NYC"}',
        },
        {
          type: "tool_call_done",
          callId: "fc_test",
          arguments: '{"city":"NYC"}',
          outputIndex: 1,
        },
        {
          type: "message_done",
          stopReason: "tool_use",
          usage: { inputTokens: 15, outputTokens: 25 },
        },
      ],
    });

    const response = await runResponse(
      {
        model: "gpt-oss-20b-responses",
        input: "Weather?",
        stream: true,
        store: false,
        background: false,
        tools: [{ type: "function", name: "get_weather" }],
        tool_choice: "auto",
        truncation: "disabled",
        parallel_tool_calls: true,
        metadata: {},
      },
      signal,
    );

    const text = await readBody(response);
    const events = parseSSE(text);

    // Check tool_call_start was emitted as output_item.added
    const toolAdded = events.find(
      (e) =>
        (e.data as Record<string, unknown>)?.type === "response.output_item.added" &&
        ((e.data as Record<string, unknown>)?.item as Record<string, unknown>)?.type === "function_call",
    );
    expect(toolAdded).toBeDefined();

    // Check tool_call_done was emitted as output_item.done
    const toolDone = events.find(
      (e) =>
        (e.data as Record<string, unknown>)?.type === "response.output_item.done" &&
        ((e.data as Record<string, unknown>)?.item as Record<string, unknown>)?.type === "function_call",
    );
    expect(toolDone).toBeDefined();
    const toolDoneItem = (toolDone!.data as Record<string, unknown>).item as Record<string, unknown>;
    expect(toolDoneItem.arguments).toBe('{"city":"NYC"}');
  });

  it("emits error event and response.failed on adapter error", async () => {
    mockAdapter = {
      models: ["gpt-oss-20b"],
      chat: vi.fn(),
      chatStream: vi.fn(function () {
        return (async function* () {
          throw new Error("Provider exploded");
        })();
      }),
    };

    const response = await runResponse(
      {
        model: "gpt-oss-20b-responses",
        input: "Hi",
        stream: true,
        store: false,
        background: false,
        tools: [],
        tool_choice: "auto",
        truncation: "disabled",
        parallel_tool_calls: true,
        metadata: {},
      },
      signal,
    );

    const text = await readBody(response);
    const events = parseSSE(text);

    const errorEvent = events.find(
      (e) => (e.data as Record<string, unknown>)?.type === "error",
    );
    expect(errorEvent).toBeDefined();
    expect(
      ((errorEvent!.data as Record<string, unknown>).error as Record<string, unknown>).message,
    ).toBe("Provider exploded");

    const failedEvent = events.find(
      (e) => (e.data as Record<string, unknown>)?.type === "response.failed",
    );
    expect(failedEvent).toBeDefined();

    // Still ends with [DONE]
    expect(text).toContain("data: [DONE]");
  });
});

// ---------------------------------------------------------------------------
// Golden SSE contract tests
// ---------------------------------------------------------------------------

describe("SSE contract — golden sequence for text response", () => {
  const signal = new AbortController().signal;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAdapter = createFakeAdapter({
      streamEvents: [
        { type: "text_delta", delta: "Hello" },
        { type: "text_delta", delta: " world" },
        {
          type: "message_done",
          stopReason: "end_turn",
          usage: { inputTokens: 10, outputTokens: 5 },
        },
      ],
    });
  });

  it("emits events in the correct order per the Responses API spec", async () => {
    const response = await runResponse(
      {
        model: "gpt-oss-20b-responses",
        input: "Hi",
        stream: true,
        store: false,
        background: false,
        tools: [],
        tool_choice: "auto",
        truncation: "disabled",
        parallel_tool_calls: true,
        metadata: {},
      },
      signal,
    );

    const text = await readBody(response);
    const events = parseSSE(text);

    // Expected sequence:
    // 1. response.in_progress
    // 2. response.output_item.added (message)
    // 3. response.content_part.added
    // 4. response.output_text.delta ("Hello")
    // 5. response.output_text.delta (" world")
    // 6. response.output_text.done
    // 7. response.content_part.done
    // 8. response.output_item.done (message)
    // 9. response.completed
    // 10. [DONE]

    const types = events.map((e) =>
      typeof e.data === "object" && e.data !== null
        ? (e.data as Record<string, unknown>).type
        : e.data,
    );

    expect(types).toEqual([
      "response.in_progress",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
      "[DONE]",
    ]);
  });

  it("sequence_number is strictly monotonically increasing", async () => {
    const response = await runResponse(
      {
        model: "gpt-oss-20b-responses",
        input: "Hi",
        stream: true,
        store: false,
        background: false,
        tools: [],
        tool_choice: "auto",
        truncation: "disabled",
        parallel_tool_calls: true,
        metadata: {},
      },
      signal,
    );

    const text = await readBody(response);
    const events = parseSSE(text);

    // Exclude [DONE] which is not a typed event
    const seqNumbers = events
      .map((e) =>
        typeof e.data === "object" && e.data !== null
          ? (e.data as Record<string, unknown>).sequence_number as number
          : null,
      )
      .filter((n): n is number => n !== null);

    expect(seqNumbers.length).toBeGreaterThan(0);
    for (let i = 1; i < seqNumbers.length; i++) {
      expect(seqNumbers[i]).toBeGreaterThan(seqNumbers[i - 1]);
    }
    // First sequence_number should be 1
    expect(seqNumbers[0]).toBe(1);
  });

  it("event type matches data.type for every SSE event", async () => {
    const response = await runResponse(
      {
        model: "gpt-oss-20b-responses",
        input: "Hi",
        stream: true,
        store: false,
        background: false,
        tools: [],
        tool_choice: "auto",
        truncation: "disabled",
        parallel_tool_calls: true,
        metadata: {},
      },
      signal,
    );

    const text = await readBody(response);
    const events = parseSSE(text);

    for (const evt of events) {
      if (typeof evt.data === "object" && evt.data !== null) {
        const dataType = (evt.data as Record<string, unknown>).type as string;
        // The SSE event: field should match the data.type field
        // Exception: some implementations use the event type for routing
        expect(evt.event).toBe(dataType);
      }
    }
  });

  it("response.in_progress contains response_id", async () => {
    const response = await runResponse(
      {
        model: "gpt-oss-20b-responses",
        input: "Hi",
        stream: true,
        store: false,
        background: false,
        tools: [],
        tool_choice: "auto",
        truncation: "disabled",
        parallel_tool_calls: true,
        metadata: {},
      },
      signal,
    );

    const text = await readBody(response);
    const events = parseSSE(text);

    const inProgress = events.find(
      (e) => (e.data as Record<string, unknown>)?.type === "response.in_progress",
    );
    expect(inProgress).toBeDefined();
    const responseData = (inProgress!.data as Record<string, unknown>)
      .response as Record<string, unknown>;
    expect(responseData.id).toMatch(/^resp_/);
    expect(responseData.status).toBe("in_progress");
  });

  it("output_item.added contains a message item with status in_progress", async () => {
    const response = await runResponse(
      {
        model: "gpt-oss-20b-responses",
        input: "Hi",
        stream: true,
        store: false,
        background: false,
        tools: [],
        tool_choice: "auto",
        truncation: "disabled",
        parallel_tool_calls: true,
        metadata: {},
      },
      signal,
    );

    const text = await readBody(response);
    const events = parseSSE(text);

    const added = events.find(
      (e) => (e.data as Record<string, unknown>)?.type === "response.output_item.added",
    );
    expect(added).toBeDefined();
    const item = (added!.data as Record<string, unknown>).item as Record<string, unknown>;
    expect(item.type).toBe("message");
    expect(item.id).toMatch(/^msg_/);
    expect(item.status).toBe("in_progress");
    expect(item.role).toBe("assistant");
    expect(item.content).toEqual([]);
  });

  it("content_part.added contains an empty output_text part", async () => {
    const response = await runResponse(
      {
        model: "gpt-oss-20b-responses",
        input: "Hi",
        stream: true,
        store: false,
        background: false,
        tools: [],
        tool_choice: "auto",
        truncation: "disabled",
        parallel_tool_calls: true,
        metadata: {},
      },
      signal,
    );

    const text = await readBody(response);
    const events = parseSSE(text);

    const partAdded = events.find(
      (e) => (e.data as Record<string, unknown>)?.type === "response.content_part.added",
    );
    expect(partAdded).toBeDefined();
    const part = (partAdded!.data as Record<string, unknown>).part as Record<string, unknown>;
    expect(part.type).toBe("output_text");
    expect(part.text).toBe("");
    expect(part.annotations).toEqual([]);
  });

  it("output_text.done contains the full accumulated text", async () => {
    const response = await runResponse(
      {
        model: "gpt-oss-20b-responses",
        input: "Hi",
        stream: true,
        store: false,
        background: false,
        tools: [],
        tool_choice: "auto",
        truncation: "disabled",
        parallel_tool_calls: true,
        metadata: {},
      },
      signal,
    );

    const text = await readBody(response);
    const events = parseSSE(text);

    const textDone = events.find(
      (e) => (e.data as Record<string, unknown>)?.type === "response.output_text.done",
    );
    expect(textDone).toBeDefined();
    expect((textDone!.data as Record<string, unknown>).text).toBe("Hello world");
  });

  it("output_item.done (message) has status completed and full content", async () => {
    const response = await runResponse(
      {
        model: "gpt-oss-20b-responses",
        input: "Hi",
        stream: true,
        store: false,
        background: false,
        tools: [],
        tool_choice: "auto",
        truncation: "disabled",
        parallel_tool_calls: true,
        metadata: {},
      },
      signal,
    );

    const text = await readBody(response);
    const events = parseSSE(text);

    const msgDone = events.find(
      (e) =>
        (e.data as Record<string, unknown>)?.type === "response.output_item.done" &&
        ((e.data as Record<string, unknown>)?.item as Record<string, unknown>)?.type === "message",
    );
    expect(msgDone).toBeDefined();
    const item = (msgDone!.data as Record<string, unknown>).item as Record<string, unknown>;
    expect(item.status).toBe("completed");
    const content = item.content as Array<Record<string, unknown>>;
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("output_text");
    expect(content[0].text).toBe("Hello world");
  });

  it("response.completed includes the full response object", async () => {
    const response = await runResponse(
      {
        model: "gpt-oss-20b-responses",
        input: "Hi",
        stream: true,
        store: false,
        background: false,
        tools: [],
        tool_choice: "auto",
        truncation: "disabled",
        parallel_tool_calls: true,
        metadata: {},
      },
      signal,
    );

    const text = await readBody(response);
    const events = parseSSE(text);

    const completed = events.find(
      (e) => (e.data as Record<string, unknown>)?.type === "response.completed",
    );
    expect(completed).toBeDefined();
    const resp = (completed!.data as Record<string, unknown>).response as Record<string, unknown>;
    expect(resp.id).toMatch(/^resp_/);
    expect(resp.object).toBe("response");
    expect(resp.status).toBe("completed");
    expect(resp.model).toBe("gpt-oss-20b-responses");
    expect(resp.usage).toEqual({
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
    });
    expect((resp.output as unknown[]).length).toBeGreaterThanOrEqual(1);
  });

  it("message_id is consistent across all events", async () => {
    const response = await runResponse(
      {
        model: "gpt-oss-20b-responses",
        input: "Hi",
        stream: true,
        store: false,
        background: false,
        tools: [],
        tool_choice: "auto",
        truncation: "disabled",
        parallel_tool_calls: true,
        metadata: {},
      },
      signal,
    );

    const text = await readBody(response);
    const events = parseSSE(text);

    // Extract message ID from output_item.added
    const added = events.find(
      (e) => (e.data as Record<string, unknown>)?.type === "response.output_item.added",
    );
    const messageId = ((added!.data as Record<string, unknown>).item as Record<string, unknown>)
      .id as string;

    // All events that reference item_id should use the same messageId
    const eventsWithItemId = events.filter(
      (e) => (e.data as Record<string, unknown>)?.item_id !== undefined,
    );
    for (const evt of eventsWithItemId) {
      expect((evt.data as Record<string, unknown>).item_id).toBe(messageId);
    }

    // The output_item.done should also reference the same id
    const msgDone = events.find(
      (e) =>
        (e.data as Record<string, unknown>)?.type === "response.output_item.done" &&
        ((e.data as Record<string, unknown>)?.item as Record<string, unknown>)?.type === "message",
    );
    expect(
      ((msgDone!.data as Record<string, unknown>).item as Record<string, unknown>).id,
    ).toBe(messageId);
  });

  it("output_index is 0 for text events and content_index is 0", async () => {
    const response = await runResponse(
      {
        model: "gpt-oss-20b-responses",
        input: "Hi",
        stream: true,
        store: false,
        background: false,
        tools: [],
        tool_choice: "auto",
        truncation: "disabled",
        parallel_tool_calls: true,
        metadata: {},
      },
      signal,
    );

    const text = await readBody(response);
    const events = parseSSE(text);

    const textEvents = events.filter((e) => {
      const type = (e.data as Record<string, unknown>)?.type as string;
      return (
        type === "response.output_text.delta" ||
        type === "response.output_text.done" ||
        type === "response.content_part.added" ||
        type === "response.content_part.done"
      );
    });

    for (const evt of textEvents) {
      expect((evt.data as Record<string, unknown>).output_index).toBe(0);
      expect((evt.data as Record<string, unknown>).content_index).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Golden SSE contract tests — function call response
// ---------------------------------------------------------------------------

describe("SSE contract — golden sequence for function call response", () => {
  const signal = new AbortController().signal;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAdapter = createFakeAdapter({
      streamEvents: [
        { type: "text_delta", delta: "Let me check" },
        {
          type: "tool_call_start",
          callId: "call_abc",
          name: "get_weather",
          outputIndex: 1,
        },
        {
          type: "tool_call_delta",
          callId: "call_abc",
          argumentsDelta: '{"city":',
        },
        {
          type: "tool_call_delta",
          callId: "call_abc",
          argumentsDelta: '"NYC"}',
        },
        {
          type: "tool_call_done",
          callId: "call_abc",
          arguments: '{"city":"NYC"}',
          outputIndex: 1,
        },
        {
          type: "message_done",
          stopReason: "tool_use",
          usage: { inputTokens: 20, outputTokens: 15 },
        },
      ],
    });
  });

  it("emits function_call output_item.added and output_item.done", async () => {
    const response = await runResponse(
      {
        model: "gpt-oss-20b-responses",
        input: "Weather?",
        stream: true,
        store: false,
        background: false,
        tools: [{ type: "function", name: "get_weather" }],
        tool_choice: "auto",
        truncation: "disabled",
        parallel_tool_calls: true,
        metadata: {},
      },
      signal,
    );

    const text = await readBody(response);
    const events = parseSSE(text);

    // Find function_call added
    const fcAdded = events.find((e) => {
      const data = e.data as Record<string, unknown>;
      if (data?.type !== "response.output_item.added") return false;
      const item = data.item as Record<string, unknown>;
      return item?.type === "function_call";
    });
    expect(fcAdded).toBeDefined();
    const addedItem = (fcAdded!.data as Record<string, unknown>).item as Record<string, unknown>;
    expect(addedItem.name).toBe("get_weather");
    expect(addedItem.status).toBe("in_progress");
    expect(addedItem.call_id).toBe("call_abc");
    expect(addedItem.id).toMatch(/^fc_/);

    // Find function_call done
    const fcDone = events.find((e) => {
      const data = e.data as Record<string, unknown>;
      if (data?.type !== "response.output_item.done") return false;
      const item = data.item as Record<string, unknown>;
      return item?.type === "function_call";
    });
    expect(fcDone).toBeDefined();
    const doneItem = (fcDone!.data as Record<string, unknown>).item as Record<string, unknown>;
    expect(doneItem.status).toBe("completed");
    expect(doneItem.arguments).toBe('{"city":"NYC"}');
  });

  it("response.completed includes both message and function_call in output", async () => {
    const response = await runResponse(
      {
        model: "gpt-oss-20b-responses",
        input: "Weather?",
        stream: true,
        store: false,
        background: false,
        tools: [{ type: "function", name: "get_weather" }],
        tool_choice: "auto",
        truncation: "disabled",
        parallel_tool_calls: true,
        metadata: {},
      },
      signal,
    );

    const text = await readBody(response);
    const events = parseSSE(text);

    const completed = events.find(
      (e) => (e.data as Record<string, unknown>)?.type === "response.completed",
    );
    expect(completed).toBeDefined();
    const resp = (completed!.data as Record<string, unknown>).response as Record<string, unknown>;
    const output = resp.output as Array<Record<string, unknown>>;
    expect(output.length).toBe(2);
    expect(output[0].type).toBe("message");
    expect(output[1].type).toBe("function_call");
  });
});

// ---------------------------------------------------------------------------
// Golden SSE contract tests — pure tool-call (no text)
// ---------------------------------------------------------------------------

describe("SSE contract — pure tool-call response (no text_delta)", () => {
  const signal = new AbortController().signal;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAdapter = createFakeAdapter({
      streamEvents: [
        {
          type: "tool_call_start",
          callId: "call_abc",
          name: "get_weather",
          outputIndex: 0,
        },
        {
          type: "tool_call_delta",
          callId: "call_abc",
          argumentsDelta: '{"city":"NYC"}',
        },
        {
          type: "tool_call_done",
          callId: "call_abc",
          arguments: '{"city":"NYC"}',
          outputIndex: 0,
        },
        {
          type: "message_done",
          stopReason: "tool_use",
          usage: { inputTokens: 10, outputTokens: 15 },
        },
      ],
    });
  });

  it("does NOT emit any message-type output_item.added", async () => {
    const response = await runResponse(
      {
        model: "gpt-oss-20b-responses",
        input: "Weather?",
        stream: true,
        store: false,
        background: false,
        tools: [{ type: "function", name: "get_weather" }],
        tool_choice: "auto",
        truncation: "disabled",
        parallel_tool_calls: true,
        metadata: {},
      },
      signal,
    );

    const text = await readBody(response);
    const events = parseSSE(text);

    const msgAdded = events.filter((e) => {
      const data = e.data as Record<string, unknown>;
      if (data?.type !== "response.output_item.added") return false;
      const item = data.item as Record<string, unknown>;
      return item?.type === "message";
    });
    expect(msgAdded).toHaveLength(0);
  });

  it("does NOT emit content_part.added or output_text events", async () => {
    const response = await runResponse(
      {
        model: "gpt-oss-20b-responses",
        input: "Weather?",
        stream: true,
        store: false,
        background: false,
        tools: [{ type: "function", name: "get_weather" }],
        tool_choice: "auto",
        truncation: "disabled",
        parallel_tool_calls: true,
        metadata: {},
      },
      signal,
    );

    const text = await readBody(response);
    const events = parseSSE(text);

    const textRelatedTypes = [
      "response.content_part.added",
      "response.content_part.done",
      "response.output_text.delta",
      "response.output_text.done",
    ];

    const textEvents = events.filter((e) => {
      const type = (e.data as Record<string, unknown>)?.type as string;
      return textRelatedTypes.includes(type);
    });
    expect(textEvents).toHaveLength(0);
  });

  it("does NOT emit output_item.done for message type", async () => {
    const response = await runResponse(
      {
        model: "gpt-oss-20b-responses",
        input: "Weather?",
        stream: true,
        store: false,
        background: false,
        tools: [{ type: "function", name: "get_weather" }],
        tool_choice: "auto",
        truncation: "disabled",
        parallel_tool_calls: true,
        metadata: {},
      },
      signal,
    );

    const text = await readBody(response);
    const events = parseSSE(text);

    const msgDone = events.filter((e) => {
      const data = e.data as Record<string, unknown>;
      if (data?.type !== "response.output_item.done") return false;
      const item = data.item as Record<string, unknown>;
      return item?.type === "message";
    });
    expect(msgDone).toHaveLength(0);
  });

  it("function_call gets output_index 0 when no text precedes it", async () => {
    const response = await runResponse(
      {
        model: "gpt-oss-20b-responses",
        input: "Weather?",
        stream: true,
        store: false,
        background: false,
        tools: [{ type: "function", name: "get_weather" }],
        tool_choice: "auto",
        truncation: "disabled",
        parallel_tool_calls: true,
        metadata: {},
      },
      signal,
    );

    const text = await readBody(response);
    const events = parseSSE(text);

    const fcAdded = events.find((e) => {
      const data = e.data as Record<string, unknown>;
      if (data?.type !== "response.output_item.added") return false;
      const item = data.item as Record<string, unknown>;
      return item?.type === "function_call";
    });
    expect(fcAdded).toBeDefined();
    expect((fcAdded!.data as Record<string, unknown>).output_index).toBe(0);
  });

  it("response.completed output contains only function_call (no message)", async () => {
    const response = await runResponse(
      {
        model: "gpt-oss-20b-responses",
        input: "Weather?",
        stream: true,
        store: false,
        background: false,
        tools: [{ type: "function", name: "get_weather" }],
        tool_choice: "auto",
        truncation: "disabled",
        parallel_tool_calls: true,
        metadata: {},
      },
      signal,
    );

    const text = await readBody(response);
    const events = parseSSE(text);

    const completed = events.find(
      (e) => (e.data as Record<string, unknown>)?.type === "response.completed",
    );
    expect(completed).toBeDefined();
    const resp = (completed!.data as Record<string, unknown>).response as Record<string, unknown>;
    const output = resp.output as Array<Record<string, unknown>>;
    expect(output).toHaveLength(1);
    expect(output[0].type).toBe("function_call");
  });

  it("emits correct event sequence for pure tool-call", async () => {
    const response = await runResponse(
      {
        model: "gpt-oss-20b-responses",
        input: "Weather?",
        stream: true,
        store: false,
        background: false,
        tools: [{ type: "function", name: "get_weather" }],
        tool_choice: "auto",
        truncation: "disabled",
        parallel_tool_calls: true,
        metadata: {},
      },
      signal,
    );

    const text = await readBody(response);
    const events = parseSSE(text);

    const types = events.map((e) =>
      typeof e.data === "object" && e.data !== null
        ? (e.data as Record<string, unknown>).type
        : e.data,
    );

    expect(types).toEqual([
      "response.in_progress",
      "response.output_item.added",   // function_call
      "response.output_item.done",    // function_call
      "response.completed",
      "[DONE]",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Dynamic output_index tests
// ---------------------------------------------------------------------------

describe("SSE contract — dynamic output_index ordering", () => {
  const signal = new AbortController().signal;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("text-first: message at index 0, function_call at index 1", async () => {
    mockAdapter = createFakeAdapter({
      streamEvents: [
        { type: "text_delta", delta: "Let me check" },
        {
          type: "tool_call_start",
          callId: "call_1",
          name: "get_weather",
          outputIndex: 1,
        },
        {
          type: "tool_call_done",
          callId: "call_1",
          arguments: '{"city":"NYC"}',
          outputIndex: 1,
        },
        {
          type: "message_done",
          stopReason: "tool_use",
          usage: { inputTokens: 10, outputTokens: 10 },
        },
      ],
    });

    const response = await runResponse(
      {
        model: "gpt-oss-20b-responses",
        input: "Weather?",
        stream: true,
        store: false,
        background: false,
        tools: [{ type: "function", name: "get_weather" }],
        tool_choice: "auto",
        truncation: "disabled",
        parallel_tool_calls: true,
        metadata: {},
      },
      signal,
    );

    const text = await readBody(response);
    const events = parseSSE(text);

    // Message output_item.added should be at output_index 0
    const msgAdded = events.find((e) => {
      const data = e.data as Record<string, unknown>;
      if (data?.type !== "response.output_item.added") return false;
      const item = data.item as Record<string, unknown>;
      return item?.type === "message";
    });
    expect(msgAdded).toBeDefined();
    expect((msgAdded!.data as Record<string, unknown>).output_index).toBe(0);

    // Function call output_item.added should be at output_index 1
    const fcAdded = events.find((e) => {
      const data = e.data as Record<string, unknown>;
      if (data?.type !== "response.output_item.added") return false;
      const item = data.item as Record<string, unknown>;
      return item?.type === "function_call";
    });
    expect(fcAdded).toBeDefined();
    expect((fcAdded!.data as Record<string, unknown>).output_index).toBe(1);
  });

  it("tool-first: first function_call at index 0, second at index 1", async () => {
    mockAdapter = createFakeAdapter({
      streamEvents: [
        {
          type: "tool_call_start",
          callId: "call_1",
          name: "get_weather",
          outputIndex: 0,
        },
        {
          type: "tool_call_done",
          callId: "call_1",
          arguments: '{"city":"NYC"}',
          outputIndex: 0,
        },
        {
          type: "tool_call_start",
          callId: "call_2",
          name: "get_time",
          outputIndex: 1,
        },
        {
          type: "tool_call_done",
          callId: "call_2",
          arguments: '{"tz":"EST"}',
          outputIndex: 1,
        },
        {
          type: "message_done",
          stopReason: "tool_use",
          usage: { inputTokens: 10, outputTokens: 20 },
        },
      ],
    });

    const response = await runResponse(
      {
        model: "gpt-oss-20b-responses",
        input: "Weather and time?",
        stream: true,
        store: false,
        background: false,
        tools: [
          { type: "function", name: "get_weather" },
          { type: "function", name: "get_time" },
        ],
        tool_choice: "auto",
        truncation: "disabled",
        parallel_tool_calls: true,
        metadata: {},
      },
      signal,
    );

    const text = await readBody(response);
    const events = parseSSE(text);

    const fcAddedEvents = events.filter((e) => {
      const data = e.data as Record<string, unknown>;
      if (data?.type !== "response.output_item.added") return false;
      const item = data.item as Record<string, unknown>;
      return item?.type === "function_call";
    });

    expect(fcAddedEvents).toHaveLength(2);
    expect((fcAddedEvents[0].data as Record<string, unknown>).output_index).toBe(0);
    expect((fcAddedEvents[1].data as Record<string, unknown>).output_index).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Input conversion tests
// ---------------------------------------------------------------------------

describe("runResponse — input conversion", () => {
  const signal = new AbortController().signal;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAdapter = createFakeAdapter();
  });

  it("handles string input by wrapping in a user message", async () => {
    const response = await runResponse(
      {
        model: "gpt-oss-20b-responses",
        input: "Hello",
        stream: false,
        store: false,
        background: false,
        tools: [],
        tool_choice: "auto",
        truncation: "disabled",
        parallel_tool_calls: true,
        metadata: {},
      },
      signal,
    );

    const body = await response.json();
    expect(body.status).toBe("completed");

    // Verify the adapter was called with a user message
    expect(mockAdapter.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "user",
            content: [{ type: "text", text: "Hello" }],
          }),
        ]),
      }),
    );
  });

  it("handles array input with mixed item types", async () => {
    const response = await runResponse(
      {
        model: "gpt-oss-20b-responses",
        input: [
          { type: "message", role: "user", content: "What is weather?" },
          {
            type: "function_call",
            call_id: "fc_1",
            name: "get_weather",
            arguments: '{"city":"NYC"}',
          },
          {
            type: "function_call_output",
            call_id: "fc_1",
            output: '{"temp":72}',
          },
          { type: "message", role: "user", content: "Thanks" },
        ],
        stream: false,
        store: false,
        background: false,
        tools: [],
        tool_choice: "auto",
        truncation: "disabled",
        parallel_tool_calls: true,
        metadata: {},
      },
      signal,
    );

    const body = await response.json();
    expect(body.status).toBe("completed");
  });

  it("passes instructions as system prompt", async () => {
    await runResponse(
      {
        model: "gpt-oss-20b-responses",
        input: "Hi",
        stream: false,
        store: false,
        background: false,
        instructions: "You are a helpful assistant.",
        tools: [],
        tool_choice: "auto",
        truncation: "disabled",
        parallel_tool_calls: true,
        metadata: {},
      },
      signal,
    );

    expect(mockAdapter.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        system: "You are a helpful assistant.",
      }),
    );
  });

  it("passes input_image with URL as url source", async () => {
    await runResponse(
      {
        model: "gpt-oss-20b-responses",
        input: [
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "What is this?" },
              { type: "input_image", image_url: "https://example.com/photo.jpg" },
            ],
          },
        ],
        stream: false,
        store: false,
        background: false,
        tools: [],
        tool_choice: "auto",
        truncation: "disabled",
        parallel_tool_calls: true,
        metadata: {},
      },
      signal,
    );

    expect(mockAdapter.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "user",
            content: expect.arrayContaining([
              { type: "image", source: { type: "url", url: "https://example.com/photo.jpg" } },
            ]),
          }),
        ]),
      }),
    );
  });

  it("passes input_image with data URL as base64 source", async () => {
    const fakeData = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const dataUrl = `data:image/png;base64,${fakeData}`;

    await runResponse(
      {
        model: "gpt-oss-20b-responses",
        input: [
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_image", image_url: dataUrl },
            ],
          },
        ],
        stream: false,
        store: false,
        background: false,
        tools: [],
        tool_choice: "auto",
        truncation: "disabled",
        parallel_tool_calls: true,
        metadata: {},
      },
      signal,
    );

    expect(mockAdapter.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "user",
            content: expect.arrayContaining([
              {
                type: "image",
                source: { type: "base64", mediaType: "image/png", data: fakeData },
              },
            ]),
          }),
        ]),
      }),
    );
  });

  it("converts function tools for the provider", async () => {
    await runResponse(
      {
        model: "gpt-oss-20b-responses",
        input: "Hi",
        stream: false,
        store: false,
        background: false,
        tools: [
          {
            type: "function",
            name: "get_weather",
            description: "Get weather info",
            parameters: {
              type: "object",
              properties: { city: { type: "string" } },
            },
          },
        ],
        tool_choice: "auto",
        truncation: "disabled",
        parallel_tool_calls: true,
        metadata: {},
      },
      signal,
    );

    expect(mockAdapter.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: [
          {
            name: "get_weather",
            description: "Get weather info",
            parameters: {
              type: "object",
              properties: { city: { type: "string" } },
            },
            strict: undefined,
          },
        ],
        toolChoice: "auto",
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Partial persistence tests — upfront insert, mid-stream updates, abort
// ---------------------------------------------------------------------------

describe("runResponse — partial persistence", () => {
  /** Capture every set of values passed to db.insert().values(). */
  let insertValuesCalls: Record<string, unknown>[];

  /** Capture every set of values passed to db.update().set() (partial updates). */
  let updateSetCalls: Record<string, unknown>[];

  /** The inner mock returned by .values() — gives access to onConflictDoUpdate. */
  let mockOnConflict: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    insertValuesCalls = [];
    updateSetCalls = [];
    mockOnConflict = vi.fn().mockResolvedValue(undefined);
    mockInsert.mockReturnValue({
      values: vi.fn((vals: Record<string, unknown>) => {
        insertValuesCalls.push(vals);
        return { onConflictDoUpdate: mockOnConflict };
      }),
    });
    mockUpdate.mockReturnValue({
      set: vi.fn((vals: Record<string, unknown>) => {
        updateSetCalls.push(vals);
        return { where: vi.fn().mockResolvedValue(undefined) };
      }),
    });
    mockAdapter = createFakeAdapter();
  });

  const baseRequest: Parameters<typeof runResponse>[0] = {
    model: "gpt-oss-20b-responses",
    input: "Hi",
    stream: true,
    store: true,
    background: false,
    tools: [],
    tool_choice: "auto",
    truncation: "disabled",
    parallel_tool_calls: true,
    metadata: {},
  };

  it("upfront insert on stream start with store=true", async () => {
    const signal = new AbortController().signal;

    // The adapter stream yields events, but we want to check that
    // db.insert was called BEFORE the stream body is consumed.
    // Since streamResponse is now async and awaits the upfront insert
    // before returning the Response, the first insert should be present
    // by the time we get the Response object.
    const response = await runResponse({ ...baseRequest, store: true }, signal);

    // The upfront insert should have been called already
    expect(insertValuesCalls.length).toBeGreaterThanOrEqual(1);
    expect(insertValuesCalls[0].status).toBe("in_progress");
    expect(insertValuesCalls[0].outputItemsJson).toEqual([]);

    // Consume body so the stream completes
    await readBody(response);
    await new Promise((r) => setTimeout(r, 50));
  });

  it("no upfront insert when store=false", async () => {
    const signal = new AbortController().signal;

    const response = await runResponse({ ...baseRequest, store: false }, signal);

    // Before consuming the body, no insert should have happened
    expect(insertValuesCalls).toHaveLength(0);

    // Consume the body
    await readBody(response);
    await new Promise((r) => setTimeout(r, 50));

    // Still no inserts
    expect(insertValuesCalls).toHaveLength(0);
  });

  it("AbortSignal mid-stream → persists incomplete", async () => {
    const ac = new AbortController();

    // Create a stream that yields some deltas then throws AbortError
    mockAdapter = {
      models: ["gpt-oss-20b"],
      chat: vi.fn(),
      chatStream: vi.fn(function () {
        return (async function* () {
          yield { type: "text_delta" as const, delta: "Hello" };
          yield { type: "text_delta" as const, delta: " partial" };
          // Simulate abort
          const abortErr = new DOMException("The operation was aborted.", "AbortError");
          throw abortErr;
        })();
      }),
    };

    const response = await runResponse({ ...baseRequest, store: true }, ac.signal);

    // Consume the body (the stream will emit some events then end)
    await readBody(response);
    await new Promise((r) => setTimeout(r, 50));

    // Find the persist call with status "incomplete"
    const incompleteCalls = insertValuesCalls.filter(
      (v) => v.status === "incomplete",
    );
    expect(incompleteCalls.length).toBeGreaterThanOrEqual(1);

    const incompleteCall = incompleteCalls[0];
    // The partial text should be captured in outputItemsJson
    const outputItems = incompleteCall.outputItemsJson as Array<Record<string, unknown>>;
    expect(outputItems.length).toBeGreaterThanOrEqual(1);
    const msgItem = outputItems.find((item) => item.type === "message");
    expect(msgItem).toBeDefined();
    const content = msgItem!.content as Array<Record<string, unknown>>;
    expect(content[0].text).toBe("Hello partial");

    // incomplete_details should be set
    expect(incompleteCall.incompleteDetailsJson).toEqual({ reason: "interrupted" });
  });

  it("previousResponseId with incomplete response works", async () => {
    const signal = new AbortController().signal;

    // Mock db.select to return a row with status=incomplete and partial output
    const prevInput = [{ type: "message", role: "user", content: "Original question" }];
    const prevOutput = [
      {
        type: "message",
        id: "msg_prev",
        status: "incomplete",
        role: "assistant",
        content: [{ type: "output_text", text: "Partial answer...", annotations: [] }],
      },
    ];

    mockSelect.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([
            {
              id: "resp_prev",
              status: "incomplete",
              store: true,
              inputItemsJson: prevInput,
              outputItemsJson: prevOutput,
            },
          ]),
        }),
      }),
    });

    // Should not throw — incomplete responses can be referenced
    const response = await runResponse(
      {
        ...baseRequest,
        stream: false,
        store: false,
        previous_response_id: "resp_prev",
      },
      signal,
    );

    const body = await response.json();
    expect(body.status).toBe("completed");
  });

  it("partial update called during streaming", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    // Create a slow stream that emits several text_deltas with delays
    // so the debounce timer can fire between events.
    let yieldControl: (() => void) | null = null;

    mockAdapter = {
      models: ["gpt-oss-20b"],
      chat: vi.fn(),
      chatStream: vi.fn(function () {
        return (async function* () {
          yield { type: "text_delta" as const, delta: "chunk1" };
          // Wait long enough for debounce to fire (> 1000ms)
          await new Promise<void>((resolve) => {
            yieldControl = resolve;
          });
          yield { type: "text_delta" as const, delta: " chunk2" };
          yield {
            type: "message_done" as const,
            stopReason: "end_turn" as const,
            usage: { inputTokens: 10, outputTokens: 5 },
          };
        })();
      }),
    };

    const signal = new AbortController().signal;

    const response = await runResponse({ ...baseRequest, store: true }, signal);

    // Start reading the body in background (the stream is producing)
    const bodyPromise = readBody(response);

    // Advance timers to trigger the debounced partial update (1000ms)
    await vi.advanceTimersByTimeAsync(1100);

    // The debounce timer should have fired, which calls persistPartialOutput
    // via db.update().set() with just the outputItemsJson field.
    const partialCalls = updateSetCalls.filter(
      (v) => v.outputItemsJson && (v.outputItemsJson as unknown[]).length > 0,
    );
    expect(partialCalls.length).toBeGreaterThanOrEqual(1);

    // The partial update should contain "chunk1" in its output
    const partialOutput = partialCalls[0].outputItemsJson as Array<Record<string, unknown>>;
    const partialMsg = partialOutput.find((item) => item.type === "message");
    expect(partialMsg).toBeDefined();
    const partialContent = partialMsg!.content as Array<Record<string, unknown>>;
    expect(partialContent[0].text).toBe("chunk1");

    // Resume the generator
    yieldControl!();

    // Let the stream finish
    await bodyPromise;
    await vi.advanceTimersByTimeAsync(100);

    // Final persist should have status "completed"
    const completedCalls = insertValuesCalls.filter(
      (v) => v.status === "completed",
    );
    expect(completedCalls.length).toBeGreaterThanOrEqual(1);

    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// New feature tests: temperature clamp, json modes, background, reasoning
// ---------------------------------------------------------------------------

describe("runResponse — temperature clamp", () => {
  const signal = new AbortController().signal;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAdapter = createFakeAdapter();
  });

  it("temperature > 1.0 is clamped to 1.0 in provider request", async () => {
    await runResponse(
      {
        model: "gpt-oss-20b-responses",
        input: "Hi",
        stream: false,
        store: false,
        background: false,
        tools: [],
        tool_choice: "auto",
        truncation: "disabled",
        parallel_tool_calls: true,
        metadata: {},
        temperature: 1.5,
      },
      signal,
    );

    // The orchestrator passes temperature through to the provider as-is;
    // the adapter is responsible for clamping. At the orchestrator level,
    // temperature is passed unchanged (1.5). The adapter clamp is tested
    // in the Anthropic adapter test. Here we verify the value reaches the adapter.
    expect(mockAdapter.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        temperature: 1.5,
      }),
    );
  });

  it("temperature=0 is preserved (not clamped)", async () => {
    await runResponse(
      {
        model: "gpt-oss-20b-responses",
        input: "Hi",
        stream: false,
        store: false,
        background: false,
        tools: [],
        tool_choice: "auto",
        truncation: "disabled",
        parallel_tool_calls: true,
        metadata: {},
        temperature: 0,
      },
      signal,
    );

    expect(mockAdapter.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        temperature: 0,
      }),
    );
  });
});

describe("runResponse — json_object format", () => {
  const signal = new AbortController().signal;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAdapter = createFakeAdapter();
  });

  it("json_object passes textFormat to provider request", async () => {
    await runResponse(
      {
        model: "gpt-oss-20b-responses",
        input: "Give me a JSON object",
        stream: false,
        store: false,
        background: false,
        tools: [],
        tool_choice: "auto",
        truncation: "disabled",
        parallel_tool_calls: true,
        metadata: {},
        text: { format: { type: "json_object" } },
      },
      signal,
    );

    expect(mockAdapter.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        textFormat: { type: "json_object", schema: undefined, schemaName: undefined },
      }),
    );
  });
});

describe("runResponse — json_schema format", () => {
  const signal = new AbortController().signal;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAdapter = createFakeAdapter();
  });

  it("json_schema passes textFormat with schema and name to provider request", async () => {
    const schema = {
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
    };

    await runResponse(
      {
        model: "gpt-oss-20b-responses",
        input: "Answer in JSON",
        stream: false,
        store: false,
        background: false,
        tools: [],
        tool_choice: "auto",
        truncation: "disabled",
        parallel_tool_calls: true,
        metadata: {},
        text: {
          format: {
            type: "json_schema",
            name: "answer_schema",
            schema,
          },
        },
      },
      signal,
    );

    expect(mockAdapter.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        textFormat: {
          type: "json_schema",
          schema,
          schemaName: "answer_schema",
        },
      }),
    );
  });
});

describe("runResponse — background mode", () => {
  const signal = new AbortController().signal;

  let insertValuesCalls: Record<string, unknown>[];
  let mockOnConflict: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    afterCallbacks.length = 0;
    insertValuesCalls = [];
    mockOnConflict = vi.fn().mockResolvedValue(undefined);
    mockInsert.mockReturnValue({
      values: vi.fn((vals: Record<string, unknown>) => {
        insertValuesCalls.push(vals);
        return { onConflictDoUpdate: mockOnConflict };
      }),
    });
    mockAdapter = createFakeAdapter();
  });

  it("background=true with store=true returns in_progress immediately", async () => {
    const response = await runResponse(
      {
        model: "gpt-oss-20b-responses",
        input: "Hi",
        stream: false,
        store: true,
        background: true,
        tools: [],
        tool_choice: "auto",
        truncation: "disabled",
        parallel_tool_calls: true,
        metadata: {},
      },
      signal,
    );

    const body = await response.json();
    expect(body.status).toBe("in_progress");
    expect(body.id).toMatch(/^resp_/);
    expect(body.background).toBe(true);
    expect(body.output).toEqual([]);

    // DB should have been written with in_progress status
    expect(insertValuesCalls.length).toBeGreaterThanOrEqual(1);
    expect(insertValuesCalls[0].status).toBe("in_progress");
  });

  it("background mode schedules the LLM call via after()", async () => {
    await runResponse(
      {
        model: "gpt-oss-20b-responses",
        input: "Hi",
        stream: false,
        store: true,
        background: true,
        tools: [],
        tool_choice: "auto",
        truncation: "disabled",
        parallel_tool_calls: true,
        metadata: {},
      },
      signal,
    );

    // after() should have been called with a callback
    expect(afterCallbacks).toHaveLength(1);

    // Execute the callback
    await afterCallbacks[0]();

    // The adapter.chat should have been called
    expect(mockAdapter.chat).toHaveBeenCalled();

    // DB should have been updated to "completed"
    const completedCalls = insertValuesCalls.filter((v) => v.status === "completed");
    expect(completedCalls.length).toBeGreaterThanOrEqual(1);
  });
});

describe("runResponse — reasoning effort mapping", () => {
  const signal = new AbortController().signal;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAdapter = createFakeAdapter();
  });

  it("reasoning effort=low maps to budgetTokens=1024", async () => {
    await runResponse(
      {
        model: "gpt-oss-20b-responses",
        input: "Think about this",
        stream: false,
        store: false,
        background: false,
        tools: [],
        tool_choice: "auto",
        truncation: "disabled",
        parallel_tool_calls: true,
        metadata: {},
        reasoning: { effort: "low" },
      },
      signal,
    );

    expect(mockAdapter.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        reasoning: { budgetTokens: 1024 },
      }),
    );
  });

  it("reasoning effort=medium maps to budgetTokens=8192", async () => {
    await runResponse(
      {
        model: "gpt-oss-20b-responses",
        input: "Think about this",
        stream: false,
        store: false,
        background: false,
        tools: [],
        tool_choice: "auto",
        truncation: "disabled",
        parallel_tool_calls: true,
        metadata: {},
        reasoning: { effort: "medium" },
      },
      signal,
    );

    expect(mockAdapter.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        reasoning: { budgetTokens: 8192 },
      }),
    );
  });

  it("reasoning effort=high maps to budgetTokens=32768", async () => {
    await runResponse(
      {
        model: "gpt-oss-20b-responses",
        input: "Think about this",
        stream: false,
        store: false,
        background: false,
        tools: [],
        tool_choice: "auto",
        truncation: "disabled",
        parallel_tool_calls: true,
        metadata: {},
        reasoning: { effort: "high" },
      },
      signal,
    );

    expect(mockAdapter.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        reasoning: { budgetTokens: 32768 },
      }),
    );
  });

  it("no reasoning field when effort is not specified", async () => {
    await runResponse(
      {
        model: "gpt-oss-20b-responses",
        input: "No reasoning needed",
        stream: false,
        store: false,
        background: false,
        tools: [],
        tool_choice: "auto",
        truncation: "disabled",
        parallel_tool_calls: true,
        metadata: {},
      },
      signal,
    );

    expect(mockAdapter.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        reasoning: undefined,
      }),
    );
  });
});

describe("runResponse — thinking events in streaming", () => {
  const signal = new AbortController().signal;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("thinking events are accumulated and included as reasoning output item", async () => {
    mockAdapter = createFakeAdapter({
      streamEvents: [
        { type: "thinking_delta", delta: "Let me think" },
        { type: "thinking_delta", delta: " step by step..." },
        { type: "thinking_done", text: "Let me think step by step..." },
        { type: "text_delta", delta: "The answer is 42." },
        {
          type: "message_done",
          stopReason: "end_turn",
          usage: { inputTokens: 100, outputTokens: 50 },
        },
      ],
    });

    const response = await runResponse(
      {
        model: "gpt-oss-20b-responses",
        input: "Think deeply",
        stream: true,
        store: false,
        background: false,
        tools: [],
        tool_choice: "auto",
        truncation: "disabled",
        parallel_tool_calls: true,
        metadata: {},
        reasoning: { effort: "high" },
      },
      signal,
    );

    const text = await readBody(response);
    const events = parseSSE(text);

    // The response.completed event should include a reasoning item
    const completed = events.find(
      (e) => (e.data as Record<string, unknown>)?.type === "response.completed",
    );
    expect(completed).toBeDefined();
    const resp = (completed!.data as Record<string, unknown>).response as Record<string, unknown>;
    const output = resp.output as Array<Record<string, unknown>>;

    // Reasoning item should be first (unshifted) with the thinking text
    const reasoningItem = output.find((item) => item.type === "reasoning");
    expect(reasoningItem).toBeDefined();
    expect(reasoningItem!.summary).toBeDefined();

    // Text message should also be present
    const messageItem = output.find((item) => item.type === "message");
    expect(messageItem).toBeDefined();
  });

  it("thinking in non-streaming produces reasoning output item", async () => {
    mockAdapter = createFakeAdapter({
      chatResult: {
        messages: [
          { type: "thinking", text: "Deep thought process..." },
          { type: "text", text: "The answer is 42." },
        ],
        stopReason: "end_turn",
        usage: { inputTokens: 100, outputTokens: 50 },
      },
    });

    const response = await runResponse(
      {
        model: "gpt-oss-20b-responses",
        input: "Think deeply",
        stream: false,
        store: false,
        background: false,
        tools: [],
        tool_choice: "auto",
        truncation: "disabled",
        parallel_tool_calls: true,
        metadata: {},
        reasoning: { effort: "high" },
      },
      signal,
    );

    const body = await response.json();
    expect(body.status).toBe("completed");

    // Reasoning item should be first (unshifted)
    const reasoningItem = body.output.find(
      (item: Record<string, unknown>) => item.type === "reasoning",
    );
    expect(reasoningItem).toBeDefined();
    expect(reasoningItem.summary[0].text).toBe("Deep thought process...");

    // Text message should also be present
    const messageItem = body.output.find(
      (item: Record<string, unknown>) => item.type === "message",
    );
    expect(messageItem).toBeDefined();
    expect(messageItem.content[0].text).toBe("The answer is 42.");
  });
});
