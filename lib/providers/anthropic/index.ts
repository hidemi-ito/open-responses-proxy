/**
 * Anthropic Claude adapter.
 *
 * Converts ProviderChatRequest to Anthropic Messages API calls and
 * maps responses / streaming events back to normalised ProviderEvents.
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
  ProviderAdapter,
  ProviderChatRequest,
  ProviderEvent,
  ProviderFinalResult,
  ProviderOutputItem,
  ProviderUsage,
  ProviderMessage,
  ProviderContentPart,
  ProviderTool,
  ProviderToolChoice,
  StopReason,
} from "@/lib/providers/types";

// ---------------------------------------------------------------------------
// Singleton Anthropic client
// ---------------------------------------------------------------------------

let _client: Anthropic | undefined;

function getClient(): Anthropic {
  if (!_client) {
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

// ---------------------------------------------------------------------------
// Input conversion helpers
// ---------------------------------------------------------------------------

type AnthropicMessageParam = Anthropic.MessageCreateParams["messages"][number];
type AnthropicContentBlock =
  | Anthropic.TextBlockParam
  | Anthropic.ImageBlockParam
  | Anthropic.ToolUseBlockParam
  | Anthropic.ToolResultBlockParam;

function convertContentPart(part: ProviderContentPart): AnthropicContentBlock {
  switch (part.type) {
    case "text":
      return { type: "text", text: part.text };

    case "image":
      if (part.source.type === "url") {
        return {
          type: "image",
          source: { type: "url", url: part.source.url },
        } as Anthropic.ImageBlockParam;
      }
      return {
        type: "image",
        source: {
          type: "base64",
          media_type: part.source.mediaType as
            | "image/jpeg"
            | "image/png"
            | "image/gif"
            | "image/webp",
          data: part.source.data,
        },
      };

    case "tool_use":
      return {
        type: "tool_use",
        id: part.callId,
        name: part.name,
        input: part.input as Record<string, unknown>,
      };

    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: part.callId,
        content: part.content,
      };
  }
}

function convertMessages(
  messages: ProviderMessage[],
): { system: string | undefined; messages: AnthropicMessageParam[] } {
  let systemPrompt: string | undefined;
  const anthropicMessages: AnthropicMessageParam[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      // Collect system messages; Anthropic accepts system as a top-level param
      const text = msg.content
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join("\n");
      systemPrompt = systemPrompt ? `${systemPrompt}\n${text}` : text;
      continue;
    }

    anthropicMessages.push({
      role: msg.role as "user" | "assistant",
      content: msg.content.map(convertContentPart),
    });
  }

  return { system: systemPrompt, messages: anthropicMessages };
}

// ---------------------------------------------------------------------------
// Tool conversion helpers
// ---------------------------------------------------------------------------

type AnthropicToolParam = Anthropic.Tool;

function convertTools(tools: ProviderTool[]): AnthropicToolParam[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    input_schema: {
      type: "object" as const,
      ...t.parameters,
    },
  }));
}

function convertToolChoice(
  choice: ProviderToolChoice,
  hasTools: boolean,
): { toolChoice?: Anthropic.MessageCreateParams["tool_choice"]; removeTools: boolean } {
  if (choice === "auto") {
    return { toolChoice: { type: "auto" }, removeTools: false };
  }
  if (choice === "required") {
    return { toolChoice: { type: "any" }, removeTools: false };
  }
  if (choice === "none") {
    // Anthropic has no "none" tool_choice — remove tools entirely
    return { toolChoice: undefined, removeTools: true };
  }
  // Specific function
  return {
    toolChoice: { type: "tool", name: choice.name },
    removeTools: false,
  };
}

// ---------------------------------------------------------------------------
// Stop reason mapping
// ---------------------------------------------------------------------------

function mapStopReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case "end_turn":
      return "end_turn";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    default:
      return "stop";
  }
}

// ---------------------------------------------------------------------------
// AnthropicAdapter
// ---------------------------------------------------------------------------

export class AnthropicAdapter implements ProviderAdapter {
  readonly models = ["claude-opus-4-6"] as const;

  // -----------------------------------------------------------------------
  // Non-streaming
  // -----------------------------------------------------------------------

  async chat(req: ProviderChatRequest): Promise<ProviderFinalResult> {
    const client = getClient();
    const { system, messages } = convertMessages(req.messages);

    const params: Anthropic.MessageCreateParams = {
      model: req.model,
      max_tokens: req.maxOutputTokens ?? 4096,
      messages,
      stream: false,
    };

    if (system || req.system) {
      params.system = [system, req.system].filter(Boolean).join("\n");
    }
    if (req.temperature !== undefined) params.temperature = Math.min(req.temperature, 1.0);
    if (req.topP !== undefined) params.top_p = req.topP;

    // Reasoning (extended thinking)
    if (req.reasoning?.budgetTokens) {
      (params as Anthropic.MessageCreateParams & { thinking?: unknown }).thinking = {
        type: "enabled",
        budget_tokens: req.reasoning.budgetTokens,
      };
      // Anthropic requires temperature=1 when extended thinking is enabled
      params.temperature = 1;
    }

    // text.format handling
    const JSON_TOOL_NAME = "__json_response__";
    if (req.textFormat?.type === "json_object") {
      const jsonInstruction = "\n\nYou must respond with valid JSON only. Output a single JSON object with no additional text, markdown, or explanation.";
      params.system = params.system ? params.system + jsonInstruction : jsonInstruction;
    }
    if (req.textFormat?.type === "json_schema") {
      const jsonSchemaTool: AnthropicToolParam = {
        name: JSON_TOOL_NAME,
        description: `Return your response as a JSON object matching the required schema.${req.textFormat.schemaName ? ` Schema name: ${req.textFormat.schemaName}` : ""}`,
        input_schema: (req.textFormat.schema ?? { type: "object" }) as Anthropic.Tool.InputSchema,
      };
      params.tools = [...(params.tools ?? []), jsonSchemaTool];
      params.tool_choice = { type: "tool", name: JSON_TOOL_NAME };
    }

    // Tools
    if (req.tools && req.tools.length > 0) {
      let removeTools = false;
      if (req.toolChoice) {
        const tc = convertToolChoice(req.toolChoice, true);
        removeTools = tc.removeTools;
        // Don't override tool_choice when json_schema forces __json_response__
        if (tc.toolChoice && req.textFormat?.type !== "json_schema") {
          params.tool_choice = tc.toolChoice;
        }
      }
      if (!removeTools) {
        params.tools = [...(params.tools ?? []), ...convertTools(req.tools)];
      }
    }

    const response = await client.messages.create(params, {
      signal: req.signal ?? undefined,
    });

    // Map content blocks
    const outputItems: ProviderOutputItem[] = [];
    for (const block of response.content) {
      if (block.type === "text") {
        outputItems.push({ type: "text", text: block.text });
      } else if (block.type === "tool_use" && block.name === JSON_TOOL_NAME) {
        outputItems.push({ type: "text", text: JSON.stringify(block.input) });
      } else if (block.type === "tool_use") {
        outputItems.push({
          type: "tool_use",
          callId: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input),
        });
      } else if (block.type === "thinking") {
        outputItems.push({ type: "thinking", text: (block as { type: "thinking"; thinking: string }).thinking });
      } else if ((block as { type: string }).type === "image") {
        const src = (block as unknown as Anthropic.ImageBlockParam).source;
        if (src.type === "base64") {
          outputItems.push({ type: "image", data: src.data, mediaType: src.media_type });
        } else if (src.type === "url") {
          outputItems.push({ type: "image", data: src.url, mediaType: "url" });
        }
      }
    }

    const usage: ProviderUsage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      ...(("cache_read_input_tokens" in response.usage &&
        typeof response.usage.cache_read_input_tokens === "number") && {
        cacheReadTokens: response.usage.cache_read_input_tokens,
      }),
    };

    return {
      messages: outputItems,
      stopReason: mapStopReason(response.stop_reason),
      usage,
    };
  }

  // -----------------------------------------------------------------------
  // Streaming
  // -----------------------------------------------------------------------

  async *chatStream(req: ProviderChatRequest): AsyncIterable<ProviderEvent> {
    const client = getClient();
    const { system, messages } = convertMessages(req.messages);

    const params: Anthropic.MessageCreateParams = {
      model: req.model,
      max_tokens: req.maxOutputTokens ?? 4096,
      messages,
      stream: true,
    };

    if (system || req.system) {
      params.system = [system, req.system].filter(Boolean).join("\n");
    }
    if (req.temperature !== undefined) params.temperature = Math.min(req.temperature, 1.0);
    if (req.topP !== undefined) params.top_p = req.topP;

    // Reasoning (extended thinking)
    if (req.reasoning?.budgetTokens) {
      (params as Anthropic.MessageCreateParams & { thinking?: unknown }).thinking = {
        type: "enabled",
        budget_tokens: req.reasoning.budgetTokens,
      };
      // Anthropic requires temperature=1 when extended thinking is enabled
      params.temperature = 1;
    }

    // text.format handling
    const JSON_TOOL_NAME = "__json_response__";
    if (req.textFormat?.type === "json_object") {
      const jsonInstruction = "\n\nYou must respond with valid JSON only. Output a single JSON object with no additional text, markdown, or explanation.";
      params.system = params.system ? params.system + jsonInstruction : jsonInstruction;
    }
    if (req.textFormat?.type === "json_schema") {
      const jsonSchemaTool: AnthropicToolParam = {
        name: JSON_TOOL_NAME,
        description: `Return your response as a JSON object matching the required schema.${req.textFormat.schemaName ? ` Schema name: ${req.textFormat.schemaName}` : ""}`,
        input_schema: (req.textFormat.schema ?? { type: "object" }) as Anthropic.Tool.InputSchema,
      };
      params.tools = [...(params.tools ?? []), jsonSchemaTool];
      params.tool_choice = { type: "tool", name: JSON_TOOL_NAME };
    }

    // Tools
    if (req.tools && req.tools.length > 0) {
      let removeTools = false;
      if (req.toolChoice) {
        const tc = convertToolChoice(req.toolChoice, true);
        removeTools = tc.removeTools;
        // Don't override tool_choice when json_schema forces __json_response__
        if (tc.toolChoice && req.textFormat?.type !== "json_schema") {
          params.tool_choice = tc.toolChoice;
        }
      }
      if (!removeTools) {
        params.tools = [...(params.tools ?? []), ...convertTools(req.tools)];
      }
    }

    const stream = client.messages.stream(params, {
      signal: req.signal ?? undefined,
    });

    // Track tool_use blocks by content block index
    const toolBlocks = new Map<
      number,
      { callId: string; name: string; accumulatedArgs: string }
    >();
    // Track JSON schema tool block specially
    let jsonSchemaBlock: { index: number; accumulatedArgs: string } | null = null;
    // Track thinking block
    let thinkingBlock: { index: number; accumulatedText: string } | null = null;
    // Track which content block index corresponds to which output index
    // (output index counts text + tool_use blocks emitted so far)
    let outputIndex = 0;
    let finalStopReason: StopReason = "stop";
    let finalUsage: ProviderUsage = { inputTokens: 0, outputTokens: 0 };

    for await (const event of stream) {
      switch (event.type) {
        case "content_block_start": {
          const block = event.content_block;
          if (block.type === "tool_use" && block.name === JSON_TOOL_NAME) {
            // JSON schema tool block — track separately, don't emit tool_call_start
            jsonSchemaBlock = { index: event.index, accumulatedArgs: "" };
          } else if (block.type === "tool_use") {
            const idx = event.index;
            toolBlocks.set(idx, {
              callId: block.id,
              name: block.name,
              accumulatedArgs: "",
            });
            yield {
              type: "tool_call_start",
              callId: block.id,
              name: block.name,
              outputIndex,
            };
            outputIndex++;
          } else if (block.type === "thinking") {
            thinkingBlock = { index: event.index, accumulatedText: "" };
          } else if (block.type === "text") {
            // Text block started; outputIndex is tracked, but we only
            // emit text_delta events as deltas arrive.
            // We increment outputIndex once we know this is a content block.
            // (The orchestrator maps text to one output item.)
            outputIndex++;
          }
          break;
        }

        case "content_block_delta": {
          const delta = event.delta;
          if (delta.type === "text_delta") {
            yield { type: "text_delta", delta: delta.text };
          } else if (delta.type === "thinking_delta") {
            if (thinkingBlock) {
              thinkingBlock.accumulatedText += (delta as unknown as { thinking: string }).thinking;
              yield { type: "thinking_delta", delta: (delta as unknown as { thinking: string }).thinking };
            }
          } else if (delta.type === "input_json_delta") {
            // Check if this is for the JSON schema block
            if (jsonSchemaBlock && event.index === jsonSchemaBlock.index) {
              jsonSchemaBlock.accumulatedArgs += delta.partial_json;
              // Do NOT yield tool_call_delta for JSON schema block
            } else {
              const tb = toolBlocks.get(event.index);
              if (tb) {
                tb.accumulatedArgs += delta.partial_json;
                yield {
                  type: "tool_call_delta",
                  callId: tb.callId,
                  argumentsDelta: delta.partial_json,
                };
              }
            }
          }
          break;
        }

        case "content_block_stop": {
          if (jsonSchemaBlock && event.index === jsonSchemaBlock.index) {
            // Emit accumulated JSON schema response as text_delta
            yield { type: "text_delta", delta: jsonSchemaBlock.accumulatedArgs };
            jsonSchemaBlock = null;
            // Do NOT yield tool_call_done
          } else if (thinkingBlock && event.index === thinkingBlock.index) {
            yield { type: "thinking_done", text: thinkingBlock.accumulatedText };
            thinkingBlock = null;
          } else {
            const tb = toolBlocks.get(event.index);
            if (tb) {
              yield {
                type: "tool_call_done",
                callId: tb.callId,
                arguments: tb.accumulatedArgs,
                outputIndex: outputIndex - 1, // current tool's output index
              };
              toolBlocks.delete(event.index);
            }
          }
          break;
        }

        case "message_delta": {
          finalStopReason = mapStopReason(event.delta.stop_reason);
          if (event.usage) {
            finalUsage = {
              ...finalUsage,
              outputTokens: event.usage.output_tokens,
            };
          }
          break;
        }

        case "message_start": {
          // Capture initial usage from message_start
          if (event.message?.usage) {
            finalUsage = {
              inputTokens: event.message.usage.input_tokens,
              outputTokens: event.message.usage.output_tokens,
              ...(("cache_read_input_tokens" in event.message.usage &&
                typeof event.message.usage.cache_read_input_tokens ===
                  "number") && {
                cacheReadTokens: event.message.usage.cache_read_input_tokens,
              }),
            };
          }
          break;
        }

        case "message_stop": {
          yield {
            type: "message_done",
            stopReason: finalStopReason,
            usage: finalUsage,
          };
          break;
        }
      }
    }
  }
}
