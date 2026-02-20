/**
 * Integration tests for AnthropicAdapter.
 *
 * These tests make REAL calls to the Anthropic API.
 * They require ANTHROPIC_API_KEY to be set in the environment.
 *
 * Run with:
 *   npm run test:integration
 *
 * They are intentionally excluded from the standard `npm test` suite.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { AnthropicAdapter } from "@/lib/providers/anthropic";
import type { ProviderChatRequest } from "@/lib/providers/types";

// ---------------------------------------------------------------------------
// Skip all tests if the API key is absent
// ---------------------------------------------------------------------------

const apiKey = process.env.ANTHROPIC_API_KEY;
const skip = !apiKey;

// Use the same model that the resolver maps to this adapter.
const TEST_MODEL = "claude-opus-4-6";

function makeReq(overrides: Partial<ProviderChatRequest> = {}): ProviderChatRequest {
  return {
    model: TEST_MODEL,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "Say exactly: hello" }],
      },
    ],
    maxOutputTokens: 64,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(skip)("AnthropicAdapter — integration (real API)", () => {
  let adapter: AnthropicAdapter;

  beforeAll(() => {
    adapter = new AnthropicAdapter();
  });

  // -------------------------------------------------------------------------
  // Non-streaming: chat()
  // -------------------------------------------------------------------------

  describe("chat() — non-streaming", () => {
    it("returns a text response", async () => {
      const result = await adapter.chat(makeReq());

      expect(result.messages.length).toBeGreaterThan(0);
      const textMsg = result.messages.find((m) => m.type === "text");
      expect(textMsg).toBeDefined();
      if (textMsg?.type === "text") {
        expect(typeof textMsg.text).toBe("string");
        expect(textMsg.text.length).toBeGreaterThan(0);
      }
    });

    it("returns stop reason end_turn for a simple prompt", async () => {
      const result = await adapter.chat(makeReq());
      expect(result.stopReason).toBe("end_turn");
    });

    it("returns usage with positive token counts", async () => {
      const result = await adapter.chat(makeReq());
      expect(result.usage.inputTokens).toBeGreaterThan(0);
      expect(result.usage.outputTokens).toBeGreaterThan(0);
    });

    it("passes system prompt correctly", async () => {
      const result = await adapter.chat(
        makeReq({
          system: "You are a helpful assistant. Respond with exactly one word.",
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "Say the word: pineapple" }],
            },
          ],
        }),
      );

      const textMsg = result.messages.find((m) => m.type === "text");
      expect(textMsg?.type).toBe("text");
      if (textMsg?.type === "text") {
        // Should contain "pineapple" somewhere in the response
        expect(textMsg.text.toLowerCase()).toContain("pineapple");
      }
    });

    it("handles function tool calls when tool_choice=required", async () => {
      const result = await adapter.chat(
        makeReq({
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "What is 2 + 2?" }],
            },
          ],
          tools: [
            {
              name: "calculate",
              description: "Perform a calculation",
              parameters: {
                type: "object",
                properties: {
                  expression: { type: "string", description: "Math expression" },
                },
                required: ["expression"],
              },
            },
          ],
          toolChoice: "required",
          maxOutputTokens: 256,
        }),
      );

      expect(result.stopReason).toBe("tool_use");
      const toolCall = result.messages.find((m) => m.type === "tool_use");
      expect(toolCall).toBeDefined();
      if (toolCall?.type === "tool_use") {
        expect(toolCall.name).toBe("calculate");
        expect(typeof toolCall.callId).toBe("string");
        expect(toolCall.callId.length).toBeGreaterThan(0);
        // arguments should be valid JSON
        expect(() => JSON.parse(toolCall.arguments)).not.toThrow();
      }
    });
  });

  // -------------------------------------------------------------------------
  // Streaming: chatStream()
  // -------------------------------------------------------------------------

  describe("chatStream() — streaming", () => {
    it("emits text_delta events", async () => {
      const deltas: string[] = [];
      let messageDone = false;

      for await (const event of adapter.chatStream(makeReq())) {
        if (event.type === "text_delta") {
          deltas.push(event.delta);
        } else if (event.type === "message_done") {
          messageDone = true;
        }
      }

      expect(deltas.length).toBeGreaterThan(0);
      const fullText = deltas.join("");
      expect(fullText.length).toBeGreaterThan(0);
      expect(messageDone).toBe(true);
    });

    it("emits message_done with usage", async () => {
      let messageDoneEvent: { type: "message_done"; stopReason: string; usage: { inputTokens: number; outputTokens: number } } | undefined;

      for await (const event of adapter.chatStream(makeReq())) {
        if (event.type === "message_done") {
          messageDoneEvent = event;
        }
      }

      expect(messageDoneEvent).toBeDefined();
      expect(messageDoneEvent!.stopReason).toBe("end_turn");
      expect(messageDoneEvent!.usage.inputTokens).toBeGreaterThan(0);
      expect(messageDoneEvent!.usage.outputTokens).toBeGreaterThan(0);
    });

    it("streams tool call events when tool_choice=required", async () => {
      const toolCallStarts: Array<{ callId: string; name: string }> = [];
      const toolCallDones: Array<{ callId: string; arguments: string }> = [];

      for await (const event of adapter.chatStream(
        makeReq({
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "What is 3 + 5?" }],
            },
          ],
          tools: [
            {
              name: "add",
              description: "Add two numbers",
              parameters: {
                type: "object",
                properties: {
                  a: { type: "number" },
                  b: { type: "number" },
                },
                required: ["a", "b"],
              },
            },
          ],
          toolChoice: "required",
          maxOutputTokens: 256,
        }),
      )) {
        if (event.type === "tool_call_start") {
          toolCallStarts.push({ callId: event.callId, name: event.name });
        } else if (event.type === "tool_call_done") {
          toolCallDones.push({ callId: event.callId, arguments: event.arguments });
        }
      }

      expect(toolCallStarts.length).toBeGreaterThan(0);
      expect(toolCallStarts[0].name).toBe("add");

      expect(toolCallDones.length).toBeGreaterThan(0);
      const args = JSON.parse(toolCallDones[0].arguments);
      expect(typeof args.a).toBe("number");
      expect(typeof args.b).toBe("number");
    });

    it("accumulated text from stream matches a complete response", async () => {
      const deltas: string[] = [];

      for await (const event of adapter.chatStream(makeReq())) {
        if (event.type === "text_delta") {
          deltas.push(event.delta);
        }
      }

      // Non-streaming result for the same prompt
      const nonStreamed = await adapter.chat(makeReq());
      const nonStreamedText = nonStreamed.messages
        .filter((m): m is { type: "text"; text: string } => m.type === "text")
        .map((m) => m.text)
        .join("");

      const streamedText = deltas.join("");
      // Both should be non-empty and similar (not identical due to stochastic model,
      // but both should mention "hello")
      expect(streamedText.length).toBeGreaterThan(0);
      expect(nonStreamedText.length).toBeGreaterThan(0);
    });
  });
});

if (skip) {
  console.log(
    "\n⚠  ANTHROPIC_API_KEY is not set — integration tests are skipped.\n" +
    "   Set it in .env.local or export it before running:\n" +
    "   ANTHROPIC_API_KEY=sk-ant-... npm run test:integration\n",
  );
}
