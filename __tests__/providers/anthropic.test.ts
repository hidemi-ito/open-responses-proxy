import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock the Anthropic SDK before importing the adapter
// ---------------------------------------------------------------------------

const mockCreate = vi.fn();
const mockStream = vi.fn();

vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: class Anthropic {
      messages = {
        create: mockCreate,
        stream: mockStream,
      };
    },
  };
});

import { AnthropicAdapter } from "@/lib/providers/anthropic";
import type {
  ProviderChatRequest,
  ProviderEvent,
  ProviderMessage,
} from "@/lib/providers/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(
  overrides: Partial<ProviderChatRequest> = {},
): ProviderChatRequest {
  return {
    model: "claude-opus-4-6",
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
    ],
    ...overrides,
  };
}

/** Collect all events from an async iterable. */
async function collectEvents(
  iterable: AsyncIterable<ProviderEvent>,
): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const e of iterable) {
    events.push(e);
  }
  return events;
}

/**
 * Build a mock async iterable of Anthropic streaming events.
 */
function mockAsyncIterable<T>(items: T[]): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          if (i < items.length) {
            return { value: items[i++], done: false };
          }
          return { value: undefined as unknown as T, done: true };
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AnthropicAdapter", () => {
  let adapter: AnthropicAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new AnthropicAdapter();
  });

  it("exposes claude-opus-4-6 as a supported model", () => {
    expect(adapter.models).toContain("claude-opus-4-6");
  });

  // -----------------------------------------------------------------------
  // Non-streaming: chat()
  // -----------------------------------------------------------------------

  describe("chat()", () => {
    it("returns text response with correct usage", async () => {
      mockCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: "Hello!" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5 },
      });

      const result = await adapter.chat(makeRequest());

      expect(result.messages).toEqual([{ type: "text", text: "Hello!" }]);
      expect(result.stopReason).toBe("end_turn");
      expect(result.usage).toEqual({
        inputTokens: 10,
        outputTokens: 5,
      });
    });

    it("maps tool_use content blocks to ProviderOutputItem", async () => {
      mockCreate.mockResolvedValueOnce({
        content: [
          { type: "text", text: "Let me call a tool." },
          {
            type: "tool_use",
            id: "toolu_123",
            name: "get_weather",
            input: { city: "Tokyo" },
          },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 20, output_tokens: 15 },
      });

      const result = await adapter.chat(makeRequest());

      expect(result.messages).toEqual([
        { type: "text", text: "Let me call a tool." },
        {
          type: "tool_use",
          callId: "toolu_123",
          name: "get_weather",
          arguments: JSON.stringify({ city: "Tokyo" }),
        },
      ]);
      expect(result.stopReason).toBe("tool_use");
    });

    it("maps max_tokens stop reason", async () => {
      mockCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: "Truncated..." }],
        stop_reason: "max_tokens",
        usage: { input_tokens: 10, output_tokens: 100 },
      });

      const result = await adapter.chat(makeRequest());
      expect(result.stopReason).toBe("max_tokens");
    });

    it("includes cacheReadTokens when present in usage", async () => {
      mockCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: "Cached response" }],
        stop_reason: "end_turn",
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 80,
        },
      });

      const result = await adapter.chat(makeRequest());
      expect(result.usage.cacheReadTokens).toBe(80);
    });

    it("extracts system messages to top-level system param", async () => {
      mockCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 5, output_tokens: 2 },
      });

      const messages: ProviderMessage[] = [
        {
          role: "system",
          content: [{ type: "text", text: "You are helpful." }],
        },
        {
          role: "user",
          content: [{ type: "text", text: "hi" }],
        },
      ];

      await adapter.chat(makeRequest({ messages }));

      const callArgs = mockCreate.mock.calls[0][0];
      // System should be set at top level, not in messages array
      expect(callArgs.system).toContain("You are helpful.");
      // Messages should not contain a system role
      expect(callArgs.messages.every((m: { role: string }) => m.role !== "system")).toBe(
        true,
      );
    });

    it("merges system from messages with req.system", async () => {
      mockCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 5, output_tokens: 2 },
      });

      const messages: ProviderMessage[] = [
        {
          role: "system",
          content: [{ type: "text", text: "From messages." }],
        },
        {
          role: "user",
          content: [{ type: "text", text: "hi" }],
        },
      ];

      await adapter.chat(makeRequest({ messages, system: "From request." }));

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.system).toContain("From messages.");
      expect(callArgs.system).toContain("From request.");
    });

    it("converts tools and tool_choice correctly", async () => {
      mockCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 5, output_tokens: 2 },
      });

      await adapter.chat(
        makeRequest({
          tools: [
            {
              name: "get_weather",
              description: "Get weather",
              parameters: { properties: { city: { type: "string" } } },
            },
          ],
          toolChoice: "auto",
        }),
      );

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.tools).toEqual([
        {
          name: "get_weather",
          description: "Get weather",
          input_schema: {
            type: "object",
            properties: { city: { type: "string" } },
          },
        },
      ]);
      expect(callArgs.tool_choice).toEqual({ type: "auto" });
    });

    it("maps toolChoice 'required' to { type: 'any' }", async () => {
      mockCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 5, output_tokens: 2 },
      });

      await adapter.chat(
        makeRequest({
          tools: [{ name: "fn", description: "d" }],
          toolChoice: "required",
        }),
      );

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.tool_choice).toEqual({ type: "any" });
    });

    it("removes tools when toolChoice is 'none'", async () => {
      mockCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 5, output_tokens: 2 },
      });

      await adapter.chat(
        makeRequest({
          tools: [{ name: "fn", description: "d" }],
          toolChoice: "none",
        }),
      );

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.tools).toBeUndefined();
    });

    it("converts tool_result and tool_use content parts", async () => {
      mockCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: "The weather is sunny." }],
        stop_reason: "end_turn",
        usage: { input_tokens: 30, output_tokens: 10 },
      });

      const messages: ProviderMessage[] = [
        {
          role: "user",
          content: [{ type: "text", text: "What is the weather?" }],
        },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              callId: "toolu_1",
              name: "get_weather",
              input: { city: "Tokyo" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              callId: "toolu_1",
              content: "Sunny, 25C",
            },
          ],
        },
      ];

      await adapter.chat(makeRequest({ messages }));

      const callArgs = mockCreate.mock.calls[0][0];
      const anthropicMessages = callArgs.messages;

      // Assistant message should have tool_use block
      expect(anthropicMessages[1].role).toBe("assistant");
      expect(anthropicMessages[1].content[0].type).toBe("tool_use");
      expect(anthropicMessages[1].content[0].id).toBe("toolu_1");

      // User message with tool_result
      expect(anthropicMessages[2].role).toBe("user");
      expect(anthropicMessages[2].content[0].type).toBe("tool_result");
      expect(anthropicMessages[2].content[0].tool_use_id).toBe("toolu_1");
    });
  });

  // -----------------------------------------------------------------------
  // Streaming: chatStream()
  // -----------------------------------------------------------------------

  describe("chatStream()", () => {
    it("emits text_delta events from text content blocks", async () => {
      const streamEvents = [
        {
          type: "message_start",
          message: { usage: { input_tokens: 10, output_tokens: 0 } },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Hello" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: " world" },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 5 },
        },
        { type: "message_stop" },
      ];

      mockStream.mockReturnValueOnce(mockAsyncIterable(streamEvents));

      const events = await collectEvents(adapter.chatStream(makeRequest()));

      expect(events).toEqual([
        { type: "text_delta", delta: "Hello" },
        { type: "text_delta", delta: " world" },
        {
          type: "message_done",
          stopReason: "end_turn",
          usage: { inputTokens: 10, outputTokens: 5 },
        },
      ]);
    });

    it("emits tool_call events from tool_use content blocks", async () => {
      const streamEvents = [
        {
          type: "message_start",
          message: { usage: { input_tokens: 20, output_tokens: 0 } },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Calling tool." },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            id: "toolu_abc",
            name: "get_weather",
          },
        },
        {
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: '{"city"' },
        },
        {
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: ':"Tokyo"}' },
        },
        { type: "content_block_stop", index: 1 },
        {
          type: "message_delta",
          delta: { stop_reason: "tool_use" },
          usage: { output_tokens: 30 },
        },
        { type: "message_stop" },
      ];

      mockStream.mockReturnValueOnce(mockAsyncIterable(streamEvents));

      const events = await collectEvents(adapter.chatStream(makeRequest()));

      expect(events).toEqual([
        { type: "text_delta", delta: "Calling tool." },
        {
          type: "tool_call_start",
          callId: "toolu_abc",
          name: "get_weather",
          outputIndex: 1,
        },
        {
          type: "tool_call_delta",
          callId: "toolu_abc",
          argumentsDelta: '{"city"',
        },
        {
          type: "tool_call_delta",
          callId: "toolu_abc",
          argumentsDelta: ':"Tokyo"}',
        },
        {
          type: "tool_call_done",
          callId: "toolu_abc",
          arguments: '{"city":"Tokyo"}',
          outputIndex: 1,
        },
        {
          type: "message_done",
          stopReason: "tool_use",
          usage: { inputTokens: 20, outputTokens: 30 },
        },
      ]);
    });

    it("tracks cache_read_input_tokens in streaming", async () => {
      const streamEvents = [
        {
          type: "message_start",
          message: {
            usage: {
              input_tokens: 100,
              output_tokens: 0,
              cache_read_input_tokens: 80,
            },
          },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Hi" },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 2 },
        },
        { type: "message_stop" },
      ];

      mockStream.mockReturnValueOnce(mockAsyncIterable(streamEvents));

      const events = await collectEvents(adapter.chatStream(makeRequest()));

      const messageDone = events.find((e) => e.type === "message_done");
      expect(messageDone).toBeDefined();
      if (messageDone?.type === "message_done") {
        expect(messageDone.usage.cacheReadTokens).toBe(80);
      }
    });

    it("handles multiple tool_use blocks in a single stream", async () => {
      const streamEvents = [
        {
          type: "message_start",
          message: { usage: { input_tokens: 30, output_tokens: 0 } },
        },
        // First tool
        {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "toolu_1",
            name: "search",
          },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"q":"a"}' },
        },
        { type: "content_block_stop", index: 0 },
        // Second tool
        {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            id: "toolu_2",
            name: "fetch",
          },
        },
        {
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: '{"url":"b"}' },
        },
        { type: "content_block_stop", index: 1 },
        {
          type: "message_delta",
          delta: { stop_reason: "tool_use" },
          usage: { output_tokens: 20 },
        },
        { type: "message_stop" },
      ];

      mockStream.mockReturnValueOnce(mockAsyncIterable(streamEvents));

      const events = await collectEvents(adapter.chatStream(makeRequest()));

      const toolStarts = events.filter((e) => e.type === "tool_call_start");
      const toolDones = events.filter((e) => e.type === "tool_call_done");

      expect(toolStarts).toHaveLength(2);
      expect(toolDones).toHaveLength(2);

      if (toolStarts[0].type === "tool_call_start") {
        expect(toolStarts[0].callId).toBe("toolu_1");
        expect(toolStarts[0].outputIndex).toBe(0);
      }
      if (toolStarts[1].type === "tool_call_start") {
        expect(toolStarts[1].callId).toBe("toolu_2");
        expect(toolStarts[1].outputIndex).toBe(1);
      }
    });
  });
});
