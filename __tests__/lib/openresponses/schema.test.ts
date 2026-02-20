import { describe, it, expect } from "vitest";
import {
  ResponsesRequestSchema,
  InputItemSchema,
  type ResponsesRequest,
} from "@/lib/openresponses/schema";

// ---------------------------------------------------------------------------
// ResponsesRequestSchema — happy path
// ---------------------------------------------------------------------------

describe("ResponsesRequestSchema", () => {
  describe("valid requests", () => {
    it("accepts minimal string input", () => {
      const result = ResponsesRequestSchema.parse({
        model: "gpt-oss-20b-responses",
        input: "Hello",
      });
      expect(result.model).toBe("gpt-oss-20b-responses");
      expect(result.input).toBe("Hello");
      // Check defaults
      expect(result.stream).toBe(false);
      expect(result.store).toBe(true);
      expect(result.background).toBe(false);
      expect(result.tools).toEqual([]);
      expect(result.tool_choice).toBe("auto");
      expect(result.truncation).toBe("disabled");
      expect(result.parallel_tool_calls).toBe(true);
      expect(result.metadata).toEqual({});
    });

    it("accepts array of input_text message items", () => {
      const result = ResponsesRequestSchema.parse({
        model: "claude-opus-4-6-responses",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Hi" }],
          },
        ],
      });
      expect(Array.isArray(result.input)).toBe(true);
    });

    it("accepts message items with string content", () => {
      const result = ResponsesRequestSchema.parse({
        model: "gpt-oss-20b-responses",
        input: [
          { type: "message", role: "user", content: "Hello" },
        ],
      });
      expect(result.input).toHaveLength(1);
    });

    it("defaults type to 'message' when omitted from message items", () => {
      const result = ResponsesRequestSchema.parse({
        model: "gpt-oss-20b-responses",
        input: [{ role: "user", content: "Hello" }],
      });
      const items = result.input as Array<{ type: string }>;
      expect(items[0].type).toBe("message");
    });

    it("accepts all message roles", () => {
      for (const role of ["user", "assistant", "system", "developer"]) {
        const result = ResponsesRequestSchema.parse({
          model: "m",
          input: [{ role, content: "test" }],
        });
        expect(result).toBeDefined();
      }
    });

    it("accepts function_call input items", () => {
      const result = ResponsesRequestSchema.parse({
        model: "m",
        input: [
          {
            type: "function_call",
            call_id: "fc_123",
            name: "get_weather",
            arguments: '{"city":"NYC"}',
          },
        ],
      });
      expect(result.input).toHaveLength(1);
    });

    it("accepts function_call_output input items", () => {
      const result = ResponsesRequestSchema.parse({
        model: "m",
        input: [
          {
            type: "function_call_output",
            call_id: "fc_123",
            output: '{"temp":72}',
          },
        ],
      });
      expect(result.input).toHaveLength(1);
    });

    it("accepts item_reference input items", () => {
      const result = ResponsesRequestSchema.parse({
        model: "m",
        input: [
          { type: "item_reference", id: "item_abc" },
        ],
      });
      expect(result.input).toHaveLength(1);
    });

    it("accepts stream: true", () => {
      const result = ResponsesRequestSchema.parse({
        model: "m",
        input: "hi",
        stream: true,
      });
      expect(result.stream).toBe(true);
    });

    it("accepts optional nullable fields", () => {
      const result = ResponsesRequestSchema.parse({
        model: "m",
        input: "hi",
        instructions: "Be concise.",
        previous_response_id: "resp_abc",
        temperature: 0.5,
        top_p: 0.9,
        max_output_tokens: 2048,
      });
      expect(result.instructions).toBe("Be concise.");
      expect(result.previous_response_id).toBe("resp_abc");
      expect(result.temperature).toBe(0.5);
      expect(result.top_p).toBe(0.9);
      expect(result.max_output_tokens).toBe(2048);
    });

    it("accepts null for nullable fields", () => {
      const result = ResponsesRequestSchema.parse({
        model: "m",
        input: "hi",
        instructions: null,
        previous_response_id: null,
        temperature: null,
        top_p: null,
        max_output_tokens: null,
        reasoning: null,
      });
      expect(result.instructions).toBeNull();
    });

    it("accepts function tool definitions", () => {
      const result = ResponsesRequestSchema.parse({
        model: "m",
        input: "hi",
        tools: [
          {
            type: "function",
            name: "get_weather",
            description: "Get weather",
            parameters: {
              type: "object",
              properties: { city: { type: "string" } },
            },
          },
        ],
      });
      expect(result.tools).toHaveLength(1);
    });

    it("accepts tool_choice values", () => {
      for (const choice of ["auto", "required", "none"]) {
        const result = ResponsesRequestSchema.parse({
          model: "m",
          input: "hi",
          tool_choice: choice,
        });
        expect(result.tool_choice).toBe(choice);
      }
    });

    it("accepts object tool_choice with function type", () => {
      const result = ResponsesRequestSchema.parse({
        model: "m",
        input: "hi",
        tool_choice: { type: "function", name: "get_weather" },
      });
      expect(result.tool_choice).toEqual({
        type: "function",
        name: "get_weather",
      });
    });

    it("accepts truncation values", () => {
      for (const t of ["auto", "disabled"]) {
        const result = ResponsesRequestSchema.parse({
          model: "m",
          input: "hi",
          truncation: t,
        });
        expect(result.truncation).toBe(t);
      }
    });

    it("accepts text format option", () => {
      const result = ResponsesRequestSchema.parse({
        model: "m",
        input: "hi",
        text: { format: { type: "json_object" } },
      });
      expect(result.text!.format.type).toBe("json_object");
    });

    it("accepts reasoning option", () => {
      const result = ResponsesRequestSchema.parse({
        model: "m",
        input: "hi",
        reasoning: { effort: "high", summary: "auto" },
      });
      expect(result.reasoning!.effort).toBe("high");
    });
  });

  // ---------------------------------------------------------------------------
  // Validation errors
  // ---------------------------------------------------------------------------

  describe("validation errors", () => {
    it("rejects missing model", () => {
      expect(() =>
        ResponsesRequestSchema.parse({ input: "hi" }),
      ).toThrow();
    });

    it("rejects missing input", () => {
      expect(() =>
        ResponsesRequestSchema.parse({ model: "m" }),
      ).toThrow();
    });

    it("rejects temperature < 0", () => {
      expect(() =>
        ResponsesRequestSchema.parse({
          model: "m",
          input: "hi",
          temperature: -0.1,
        }),
      ).toThrow();
    });

    it("rejects temperature > 2", () => {
      expect(() =>
        ResponsesRequestSchema.parse({
          model: "m",
          input: "hi",
          temperature: 2.1,
        }),
      ).toThrow();
    });

    it("rejects top_p < 0", () => {
      expect(() =>
        ResponsesRequestSchema.parse({
          model: "m",
          input: "hi",
          top_p: -0.1,
        }),
      ).toThrow();
    });

    it("rejects top_p > 1", () => {
      expect(() =>
        ResponsesRequestSchema.parse({
          model: "m",
          input: "hi",
          top_p: 1.1,
        }),
      ).toThrow();
    });

    it("rejects max_output_tokens <= 0", () => {
      expect(() =>
        ResponsesRequestSchema.parse({
          model: "m",
          input: "hi",
          max_output_tokens: 0,
        }),
      ).toThrow();
    });

    it("rejects invalid truncation value", () => {
      expect(() =>
        ResponsesRequestSchema.parse({
          model: "m",
          input: "hi",
          truncation: "invalid",
        }),
      ).toThrow();
    });

    it("rejects invalid message role", () => {
      expect(() =>
        ResponsesRequestSchema.parse({
          model: "m",
          input: [{ type: "message", role: "invalid", content: "hi" }],
        }),
      ).toThrow();
    });

    it("rejects unknown input item type in discriminated union", () => {
      expect(() =>
        ResponsesRequestSchema.parse({
          model: "m",
          input: [{ type: "unknown_type", data: "hi" }],
        }),
      ).toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// InputItemSchema standalone
// ---------------------------------------------------------------------------

describe("InputItemSchema", () => {
  it("parses a valid message item", () => {
    const result = InputItemSchema.parse({
      type: "message",
      role: "user",
      content: "hello",
    });
    expect(result.type).toBe("message");
  });

  it("parses a function_call item", () => {
    const result = InputItemSchema.parse({
      type: "function_call",
      call_id: "fc_1",
      name: "fn",
      arguments: "{}",
    });
    expect(result.type).toBe("function_call");
  });

  it("parses a function_call_output item", () => {
    const result = InputItemSchema.parse({
      type: "function_call_output",
      call_id: "fc_1",
      output: "result",
    });
    expect(result.type).toBe("function_call_output");
  });

  it("parses an item_reference", () => {
    const result = InputItemSchema.parse({
      type: "item_reference",
      id: "item_abc",
    });
    expect(result.type).toBe("item_reference");
  });

  it("accepts image content part in messages", () => {
    const result = InputItemSchema.parse({
      type: "message",
      role: "user",
      content: [
        { type: "input_image", image_url: "https://example.com/img.png", detail: "auto" },
      ],
    });
    expect(result.type).toBe("message");
  });
});
