/**
 * OpenAI-compatible adapter for gpt-oss-20b (vLLM / Ollama / etc.).
 *
 * Uses the official openai npm package pointed at GPT_OSS_BASE_URL.
 * Converts the normalised ProviderChatRequest into an OpenAI chat completion
 * request and maps the response back into ProviderEvents / ProviderFinalResult.
 */

import OpenAI from "openai";
import type {
  ProviderAdapter,
  ProviderChatRequest,
  ProviderEvent,
  ProviderFinalResult,
  ProviderMessage,
  ProviderTool,
  ProviderToolChoice,
  ProviderContentPart,
  StopReason,
} from "@/lib/providers/types";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionToolChoiceOption,
  ChatCompletionContentPart,
} from "openai/resources/chat/completions";

// ---------------------------------------------------------------------------
// Client singleton
// ---------------------------------------------------------------------------

function createClient(): OpenAI {
  return new OpenAI({
    baseURL: process.env.GPT_OSS_BASE_URL ?? "http://localhost:8000/v1",
    apiKey: process.env.GPT_OSS_API_KEY ?? "EMPTY",
  });
}

let clientInstance: OpenAI | null = null;

function getClient(): OpenAI {
  if (!clientInstance) {
    clientInstance = createClient();
  }
  return clientInstance;
}

// ---------------------------------------------------------------------------
// Conversion helpers
// ---------------------------------------------------------------------------

function convertContentParts(parts: ProviderContentPart[]): string | ChatCompletionContentPart[] {
  // If only a single text part, return plain string for compatibility
  if (parts.length === 1 && parts[0].type === "text") {
    return parts[0].text;
  }

  const result: ChatCompletionContentPart[] = [];
  for (const part of parts) {
    switch (part.type) {
      case "text":
        result.push({ type: "text", text: part.text });
        break;
      case "image":
        if (part.source.type === "url") {
          result.push({
            type: "image_url",
            image_url: { url: part.source.url },
          });
        } else {
          result.push({
            type: "image_url",
            image_url: {
              url: `data:${part.source.mediaType};base64,${part.source.data}`,
            },
          });
        }
        break;
      // tool_use and tool_result are handled at the message level
    }
  }
  return result;
}

function convertMessages(
  messages: ProviderMessage[],
  system?: string,
): ChatCompletionMessageParam[] {
  const result: ChatCompletionMessageParam[] = [];

  if (system) {
    result.push({ role: "system", content: system });
  }

  for (const msg of messages) {
    if (msg.role === "system") {
      result.push({
        role: "system",
        content: convertContentParts(msg.content) as string,
      });
      continue;
    }

    if (msg.role === "assistant") {
      // Check if this message contains tool_use parts
      const toolUseParts = msg.content.filter((p) => p.type === "tool_use");
      const textParts = msg.content.filter((p) => p.type === "text");

      if (toolUseParts.length > 0) {
        const textContent = textParts.map((p) => (p as { text: string }).text).join("");
        result.push({
          role: "assistant",
          content: textContent || null,
          tool_calls: toolUseParts.map((p) => {
            const tu = p as { callId: string; name: string; input: unknown };
            return {
              id: tu.callId,
              type: "function" as const,
              function: {
                name: tu.name,
                arguments:
                  typeof tu.input === "string" ? tu.input : JSON.stringify(tu.input),
              },
            };
          }),
        });
      } else {
        result.push({
          role: "assistant",
          content: convertContentParts(msg.content) as string,
        });
      }
      continue;
    }

    if (msg.role === "user") {
      // Check for tool_result parts (these become separate "tool" role messages)
      const toolResults = msg.content.filter((p) => p.type === "tool_result");
      const otherParts = msg.content.filter((p) => p.type !== "tool_result");

      // Emit tool results as separate messages
      for (const tr of toolResults) {
        const toolResult = tr as { callId: string; content: string };
        result.push({
          role: "tool",
          tool_call_id: toolResult.callId,
          content: toolResult.content,
        });
      }

      // Emit remaining user content
      if (otherParts.length > 0) {
        result.push({
          role: "user",
          content: convertContentParts(otherParts),
        });
      }
      continue;
    }
  }

  return result;
}

function convertTools(tools?: ProviderTool[]): ChatCompletionTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;

  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description ?? "",
      parameters: (t.parameters ?? {}) as Record<string, unknown>,
      ...(t.strict !== undefined ? { strict: t.strict } : {}),
    },
  }));
}

function convertToolChoice(
  tc?: ProviderToolChoice,
): ChatCompletionToolChoiceOption | undefined {
  if (!tc) return undefined;

  if (tc === "auto") return "auto";
  if (tc === "required") return "required";
  if (tc === "none") return "none";

  return {
    type: "function",
    function: { name: tc.name },
  };
}

function mapStopReason(finishReason: string | null): StopReason {
  switch (finishReason) {
    case "stop":
      return "end_turn";
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    default:
      return "end_turn";
  }
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly models = ["gpt-oss-20b"] as const;

  async chat(req: ProviderChatRequest): Promise<ProviderFinalResult> {
    const client = getClient();

    const response = await client.chat.completions.create(
      {
        model: req.model,
        messages: convertMessages(req.messages, req.system),
        tools: convertTools(req.tools),
        tool_choice: convertToolChoice(req.toolChoice),
        temperature: req.temperature ?? undefined,
        top_p: req.topP ?? undefined,
        max_tokens: req.maxOutputTokens ?? undefined,
        stream: false,
      },
      {
        signal: req.signal,
      },
    );

    const choice = response.choices[0];
    const items: ProviderFinalResult["messages"] = [];

    if (choice.message.content) {
      items.push({ type: "text", text: choice.message.content });
    }

    if (choice.message.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        items.push({
          type: "tool_use",
          callId: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments,
        });
      }
    }

    return {
      messages: items,
      stopReason: mapStopReason(choice.finish_reason),
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
      },
    };
  }

  async *chatStream(req: ProviderChatRequest): AsyncIterable<ProviderEvent> {
    const client = getClient();

    const stream = await client.chat.completions.create(
      {
        model: req.model,
        messages: convertMessages(req.messages, req.system),
        tools: convertTools(req.tools),
        tool_choice: convertToolChoice(req.toolChoice),
        temperature: req.temperature ?? undefined,
        top_p: req.topP ?? undefined,
        max_tokens: req.maxOutputTokens ?? undefined,
        stream: true,
        stream_options: { include_usage: true },
      },
      {
        signal: req.signal,
      },
    );

    // Track tool calls across chunks
    const pendingToolCalls = new Map<
      number,
      { callId: string; name: string; arguments: string; outputIndex: number }
    >();
    let toolCallOutputIndex = 0;
    let usage = { inputTokens: 0, outputTokens: 0 };
    let finishReason: string | null = null;

    for await (const chunk of stream) {
      // Usage comes in the final chunk
      if (chunk.usage) {
        usage = {
          inputTokens: chunk.usage.prompt_tokens ?? 0,
          outputTokens: chunk.usage.completion_tokens ?? 0,
        };
      }

      const choice = chunk.choices?.[0];
      if (!choice) continue;

      if (choice.finish_reason) {
        finishReason = choice.finish_reason;
      }

      const delta = choice.delta;
      if (!delta) continue;

      // Text delta
      if (delta.content) {
        yield { type: "text_delta", delta: delta.content };
      }

      // Tool call deltas
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index;

          if (tc.id) {
            // New tool call starting
            const outputIdx = toolCallOutputIndex++;
            pendingToolCalls.set(idx, {
              callId: tc.id,
              name: tc.function?.name ?? "",
              arguments: tc.function?.arguments ?? "",
              outputIndex: outputIdx,
            });
            yield {
              type: "tool_call_start",
              callId: tc.id,
              name: tc.function?.name ?? "",
              outputIndex: outputIdx,
            };
          } else {
            // Continuation of existing tool call
            const pending = pendingToolCalls.get(idx);
            if (pending && tc.function?.arguments) {
              pending.arguments += tc.function.arguments;
              yield {
                type: "tool_call_delta",
                callId: pending.callId,
                argumentsDelta: tc.function.arguments,
              };
            }
          }
        }
      }
    }

    // Emit tool_call_done for any pending tool calls
    for (const [, pending] of pendingToolCalls) {
      yield {
        type: "tool_call_done",
        callId: pending.callId,
        arguments: pending.arguments,
        outputIndex: pending.outputIndex,
      };
    }

    // Emit message_done
    yield {
      type: "message_done",
      stopReason: mapStopReason(finishReason),
      usage,
    };
  }
}
