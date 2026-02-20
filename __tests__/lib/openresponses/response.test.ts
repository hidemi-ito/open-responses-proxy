import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createTextMessageItem,
  createFunctionCallItem,
  createResponseObject,
  type MessageItem,
  type FunctionCallItem,
  type ResponseObject,
} from "@/lib/openresponses/response";

describe("createTextMessageItem", () => {
  it("returns a message item with type 'message'", () => {
    const item = createTextMessageItem("Hello");
    expect(item.type).toBe("message");
  });

  it("has a unique msg_ prefixed ID", () => {
    const item = createTextMessageItem("Hello");
    expect(item.id).toMatch(/^msg_[0-9a-f]{32}$/);
  });

  it("sets role to assistant", () => {
    const item = createTextMessageItem("Hi");
    expect(item.role).toBe("assistant");
  });

  it("sets status to completed", () => {
    const item = createTextMessageItem("Hi");
    expect(item.status).toBe("completed");
  });

  it("wraps text in an output_text content part", () => {
    const item = createTextMessageItem("Hello world");
    expect(item.content).toEqual([
      { type: "output_text", text: "Hello world", annotations: [] },
    ]);
  });

  it("generates different IDs on each call", () => {
    const a = createTextMessageItem("a");
    const b = createTextMessageItem("b");
    expect(a.id).not.toBe(b.id);
  });
});

describe("createFunctionCallItem", () => {
  it("returns a function_call item", () => {
    const item = createFunctionCallItem("get_weather", '{"city":"NYC"}');
    expect(item.type).toBe("function_call");
  });

  it("has a unique fc_ prefixed ID", () => {
    const item = createFunctionCallItem("fn", "{}");
    expect(item.id).toMatch(/^fc_[0-9a-f]{32}$/);
  });

  it("generates a call_id when not provided", () => {
    const item = createFunctionCallItem("fn", "{}");
    expect(item.call_id).toMatch(/^fc_[0-9a-f]{32}$/);
  });

  it("uses the provided callId", () => {
    const item = createFunctionCallItem("fn", "{}", "custom_call_id");
    expect(item.call_id).toBe("custom_call_id");
  });

  it("stores name and arguments", () => {
    const item = createFunctionCallItem("search", '{"q":"test"}');
    expect(item.name).toBe("search");
    expect(item.arguments).toBe('{"q":"test"}');
  });

  it("sets status to completed", () => {
    const item = createFunctionCallItem("fn", "{}");
    expect(item.status).toBe("completed");
  });
});

describe("createResponseObject", () => {
  let resp: ResponseObject;

  beforeEach(() => {
    resp = createResponseObject({ model: "gpt-oss-20b-responses" });
  });

  it("generates a resp_ prefixed ID", () => {
    expect(resp.id).toMatch(/^resp_[0-9a-f]{32}$/);
  });

  it("has object = 'response'", () => {
    expect(resp.object).toBe("response");
  });

  it("sets created_at to a recent Unix timestamp", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(resp.created_at).toBeGreaterThanOrEqual(now - 2);
    expect(resp.created_at).toBeLessThanOrEqual(now + 1);
  });

  it("defaults status to completed", () => {
    expect(resp.status).toBe("completed");
  });

  it("uses the provided model", () => {
    expect(resp.model).toBe("gpt-oss-20b-responses");
  });

  it("defaults output to empty array", () => {
    expect(resp.output).toEqual([]);
  });

  it("defaults tool_choice to 'auto'", () => {
    expect(resp.tool_choice).toBe("auto");
  });

  it("defaults tools to empty array", () => {
    expect(resp.tools).toEqual([]);
  });

  it("defaults parallel_tool_calls to true", () => {
    expect(resp.parallel_tool_calls).toBe(true);
  });

  it("defaults instructions to null", () => {
    expect(resp.instructions).toBeNull();
  });

  it("defaults previous_response_id to null", () => {
    expect(resp.previous_response_id).toBeNull();
  });

  it("defaults temperature, top_p, max_output_tokens to null", () => {
    expect(resp.temperature).toBeNull();
    expect(resp.top_p).toBeNull();
    expect(resp.max_output_tokens).toBeNull();
  });

  it("defaults truncation to 'disabled'", () => {
    expect(resp.truncation).toBe("disabled");
  });

  it("defaults metadata to empty object", () => {
    expect(resp.metadata).toEqual({});
  });

  it("defaults usage to null", () => {
    expect(resp.usage).toBeNull();
  });

  it("defaults error and incomplete_details to null", () => {
    expect(resp.error).toBeNull();
    expect(resp.incomplete_details).toBeNull();
  });

  it("defaults text format to { type: 'text' }", () => {
    expect(resp.text).toEqual({ format: { type: "text" } });
  });

  it("defaults store to true and background to false", () => {
    expect(resp.store).toBe(true);
    expect(resp.background).toBe(false);
  });

  it("accepts overrides for all optional fields", () => {
    const msg = createTextMessageItem("hi");
    const resp = createResponseObject({
      model: "claude-opus-4-6-responses",
      output: [msg],
      instructions: "Be helpful.",
      previousResponseId: "resp_prev",
      toolChoice: "required",
      tools: [{ type: "function", name: "test" }],
      parallelToolCalls: false,
      temperature: 0.7,
      topP: 0.9,
      maxOutputTokens: 1024,
      truncation: "auto",
      metadata: { key: "val" },
      usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
      status: "in_progress",
      error: { type: "server_error", message: "fail" },
      incompleteDetails: { reason: "max_output_tokens" },
      text: { format: { type: "json_object" } },
      reasoning: { effort: "high" },
      store: false,
      background: true,
    });

    expect(resp.model).toBe("claude-opus-4-6-responses");
    expect(resp.output).toEqual([msg]);
    expect(resp.instructions).toBe("Be helpful.");
    expect(resp.previous_response_id).toBe("resp_prev");
    expect(resp.tool_choice).toBe("required");
    expect(resp.tools).toEqual([{ type: "function", name: "test" }]);
    expect(resp.parallel_tool_calls).toBe(false);
    expect(resp.temperature).toBe(0.7);
    expect(resp.top_p).toBe(0.9);
    expect(resp.max_output_tokens).toBe(1024);
    expect(resp.truncation).toBe("auto");
    expect(resp.metadata).toEqual({ key: "val" });
    expect(resp.usage).toEqual({
      input_tokens: 10,
      output_tokens: 20,
      total_tokens: 30,
    });
    expect(resp.status).toBe("in_progress");
    expect(resp.error).toEqual({ type: "server_error", message: "fail" });
    expect(resp.incomplete_details).toEqual({ reason: "max_output_tokens" });
    expect(resp.text).toEqual({ format: { type: "json_object" } });
    expect(resp.reasoning).toEqual({ effort: "high" });
    expect(resp.store).toBe(false);
    expect(resp.background).toBe(true);
  });
});
