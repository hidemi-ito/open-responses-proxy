import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock the OpenAI SDK before importing the adapter
// ---------------------------------------------------------------------------

const mockChatCreate = vi.fn();

vi.mock("openai", () => {
  return {
    default: class OpenAI {
      chat = {
        completions: {
          create: mockChatCreate,
        },
      };
    },
  };
});

import { OpenAICompatibleAdapter } from "@/lib/providers/openai-compatible";
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
    model: "gpt-oss-20b",
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
    ],
    ...overrides,
  };
}

async function collectEvents(
  iterable: AsyncIterable<ProviderEvent>,
): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const e of iterable) {
    events.push(e);
  }
  return events;
}

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

describe("OpenAICompatibleAdapter", () => {
  let adapter: OpenAICompatibleAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new OpenAICompatibleAdapter();
  });

  it("exposes gpt-oss-20b as a supported model", () => {
    expect(adapter.models).toContain("gpt-oss-20b");
  });

  // -----------------------------------------------------------------------
  // Input conversion (verified by inspecting args passed to mock)
  // -----------------------------------------------------------------------

  describe("input conversion", () => {
    it("converts simple user text message", async () => {
      mockChatCreate.mockResolvedValueOnce({
        choices: [
          {
            message: { role: "assistant", content: "Hi" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 1 },
      });

      await adapter.chat(makeRequest());

      const callArgs = mockChatCreate.mock.calls[0][0];
      // Single text part should be flattened to a string
      expect(callArgs.messages).toEqual([
        { role: "user", content: "hello" },
      ]);
    });

    it("converts system messages", async () => {
      mockChatCreate.mockResolvedValueOnce({
        choices: [
          {
            message: { role: "assistant", content: "ok" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 1 },
      });

      const messages: ProviderMessage[] = [
        {
          role: "system",
          content: [{ type: "text", text: "Be helpful." }],
        },
        {
          role: "user",
          content: [{ type: "text", text: "hi" }],
        },
      ];

      await adapter.chat(makeRequest({ messages }));

      const callArgs = mockChatCreate.mock.calls[0][0];
      expect(callArgs.messages[0]).toEqual({
        role: "system",
        content: "Be helpful.",
      });
    });

    it("converts req.system to a leading system message", async () => {
      mockChatCreate.mockResolvedValueOnce({
        choices: [
          {
            message: { role: "assistant", content: "ok" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 1 },
      });

      await adapter.chat(makeRequest({ system: "System prompt here" }));

      const callArgs = mockChatCreate.mock.calls[0][0];
      expect(callArgs.messages[0]).toEqual({
        role: "system",
        content: "System prompt here",
      });
    });

    it("converts tool_result parts to tool role messages", async () => {
      mockChatCreate.mockResolvedValueOnce({
        choices: [
          {
            message: { role: "assistant", content: "Done." },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 2 },
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
              callId: "call_1",
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
              callId: "call_1",
              content: "Sunny, 25C",
            },
          ],
        },
      ];

      await adapter.chat(makeRequest({ messages }));

      const callArgs = mockChatCreate.mock.calls[0][0];
      const toolMsg = callArgs.messages.find(
        (m: { role: string }) => m.role === "tool",
      );
      expect(toolMsg).toEqual({
        role: "tool",
        tool_call_id: "call_1",
        content: "Sunny, 25C",
      });
    });

    it("converts assistant tool_use to tool_calls", async () => {
      mockChatCreate.mockResolvedValueOnce({
        choices: [
          {
            message: { role: "assistant", content: "Done." },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 2 },
      });

      const messages: ProviderMessage[] = [
        {
          role: "user",
          content: [{ type: "text", text: "Call a tool" }],
        },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              callId: "call_1",
              name: "get_weather",
              input: { city: "Tokyo" },
            },
          ],
        },
      ];

      await adapter.chat(makeRequest({ messages }));

      const callArgs = mockChatCreate.mock.calls[0][0];
      const assistantMsg = callArgs.messages.find(
        (m: { role: string }) => m.role === "assistant",
      );
      expect(assistantMsg.tool_calls).toEqual([
        {
          id: "call_1",
          type: "function",
          function: {
            name: "get_weather",
            arguments: JSON.stringify({ city: "Tokyo" }),
          },
        },
      ]);
    });

    it("converts tools and tool_choice", async () => {
      mockChatCreate.mockResolvedValueOnce({
        choices: [
          {
            message: { role: "assistant", content: "ok" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 1 },
      });

      await adapter.chat(
        makeRequest({
          tools: [
            {
              name: "search",
              description: "Search the web",
              parameters: { type: "object", properties: { q: { type: "string" } } },
            },
          ],
          toolChoice: "auto",
        }),
      );

      const callArgs = mockChatCreate.mock.calls[0][0];
      expect(callArgs.tools).toEqual([
        {
          type: "function",
          function: {
            name: "search",
            description: "Search the web",
            parameters: { type: "object", properties: { q: { type: "string" } } },
          },
        },
      ]);
      expect(callArgs.tool_choice).toBe("auto");
    });

    it("maps specific function tool_choice", async () => {
      mockChatCreate.mockResolvedValueOnce({
        choices: [
          {
            message: { role: "assistant", content: "ok" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 1 },
      });

      await adapter.chat(
        makeRequest({
          tools: [{ name: "fn", description: "d" }],
          toolChoice: { type: "function", name: "fn" },
        }),
      );

      const callArgs = mockChatCreate.mock.calls[0][0];
      expect(callArgs.tool_choice).toEqual({
        type: "function",
        function: { name: "fn" },
      });
    });
  });

  // -----------------------------------------------------------------------
  // Non-streaming: chat()
  // -----------------------------------------------------------------------

  describe("chat()", () => {
    it("returns text response with mapped usage", async () => {
      mockChatCreate.mockResolvedValueOnce({
        choices: [
          {
            message: { role: "assistant", content: "Hi there!" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });

      const result = await adapter.chat(makeRequest());

      expect(result.messages).toEqual([{ type: "text", text: "Hi there!" }]);
      expect(result.stopReason).toBe("end_turn"); // "stop" -> "end_turn"
      expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    });

    it("maps tool_calls in response", async () => {
      mockChatCreate.mockResolvedValueOnce({
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_abc",
                  type: "function",
                  function: {
                    name: "get_weather",
                    arguments: '{"city":"NYC"}',
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 15, completion_tokens: 20 },
      });

      const result = await adapter.chat(makeRequest());

      expect(result.messages).toEqual([
        {
          type: "tool_use",
          callId: "call_abc",
          name: "get_weather",
          arguments: '{"city":"NYC"}',
        },
      ]);
      expect(result.stopReason).toBe("tool_use"); // "tool_calls" -> "tool_use"
    });

    it("maps 'length' finish_reason to 'max_tokens'", async () => {
      mockChatCreate.mockResolvedValueOnce({
        choices: [
          {
            message: { role: "assistant", content: "Truncated" },
            finish_reason: "length",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 100 },
      });

      const result = await adapter.chat(makeRequest());
      expect(result.stopReason).toBe("max_tokens");
    });
  });

  // -----------------------------------------------------------------------
  // Streaming: chatStream()
  // -----------------------------------------------------------------------

  describe("chatStream()", () => {
    it("emits text_delta events from streaming chunks", async () => {
      const chunks = [
        {
          choices: [
            {
              delta: { content: "Hi" },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [
            {
              delta: { content: " there" },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [
            {
              delta: {},
              finish_reason: "stop",
            },
          ],
        },
        {
          // Final chunk with usage
          choices: [],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        },
      ];

      mockChatCreate.mockResolvedValueOnce(mockAsyncIterable(chunks));

      const events = await collectEvents(adapter.chatStream(makeRequest()));

      expect(events[0]).toEqual({ type: "text_delta", delta: "Hi" });
      expect(events[1]).toEqual({ type: "text_delta", delta: " there" });

      const messageDone = events.find((e) => e.type === "message_done");
      expect(messageDone).toEqual({
        type: "message_done",
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 5 },
      });
    });

    it("emits tool_call events from streaming chunks", async () => {
      const chunks = [
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_xyz",
                    function: { name: "search", arguments: "" },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: { arguments: '{"q":' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: { arguments: '"test"}' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [
            {
              delta: {},
              finish_reason: "tool_calls",
            },
          ],
        },
        {
          choices: [],
          usage: { prompt_tokens: 15, completion_tokens: 10 },
        },
      ];

      mockChatCreate.mockResolvedValueOnce(mockAsyncIterable(chunks));

      const events = await collectEvents(adapter.chatStream(makeRequest()));

      expect(events[0]).toEqual({
        type: "tool_call_start",
        callId: "call_xyz",
        name: "search",
        outputIndex: 0,
      });
      expect(events[1]).toEqual({
        type: "tool_call_delta",
        callId: "call_xyz",
        argumentsDelta: '{"q":',
      });
      expect(events[2]).toEqual({
        type: "tool_call_delta",
        callId: "call_xyz",
        argumentsDelta: '"test"}',
      });

      const toolDone = events.find((e) => e.type === "tool_call_done");
      expect(toolDone).toEqual({
        type: "tool_call_done",
        callId: "call_xyz",
        arguments: '{"q":"test"}',
        outputIndex: 0,
      });

      const messageDone = events.find((e) => e.type === "message_done");
      expect(messageDone).toBeDefined();
      if (messageDone?.type === "message_done") {
        expect(messageDone.stopReason).toBe("tool_use");
      }
    });

    it("handles multiple parallel tool calls in stream", async () => {
      const chunks = [
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_1",
                    function: { name: "fn_a", arguments: '{"a":1}' },
                  },
                  {
                    index: 1,
                    id: "call_2",
                    function: { name: "fn_b", arguments: '{"b":2}' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [
            {
              delta: {},
              finish_reason: "tool_calls",
            },
          ],
        },
        {
          choices: [],
          usage: { prompt_tokens: 20, completion_tokens: 15 },
        },
      ];

      mockChatCreate.mockResolvedValueOnce(mockAsyncIterable(chunks));

      const events = await collectEvents(adapter.chatStream(makeRequest()));

      const toolStarts = events.filter((e) => e.type === "tool_call_start");
      const toolDones = events.filter((e) => e.type === "tool_call_done");

      expect(toolStarts).toHaveLength(2);
      expect(toolDones).toHaveLength(2);

      if (toolStarts[0].type === "tool_call_start") {
        expect(toolStarts[0].name).toBe("fn_a");
        expect(toolStarts[0].outputIndex).toBe(0);
      }
      if (toolStarts[1].type === "tool_call_start") {
        expect(toolStarts[1].name).toBe("fn_b");
        expect(toolStarts[1].outputIndex).toBe(1);
      }
    });
  });
});
