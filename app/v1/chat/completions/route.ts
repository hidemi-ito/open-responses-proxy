export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { requireAuth, isAuthError } from "@/lib/auth";
import { resolveAdapter } from "@/lib/providers/resolver";
import { badRequest, serverError } from "@/lib/openresponses/errors";
import { sseEvent, sseDone, SSE_HEADERS } from "@/lib/openresponses/sse";
import { newId } from "@/lib/openresponses/ids";
import type {
  ProviderMessage,
  ProviderTool,
  ProviderToolChoice,
  ProviderContentPart,
} from "@/lib/providers/types";

/**
 * POST /v1/chat/completions — OpenAI Chat Completions compatible endpoint.
 *
 * Translates OpenAI-format messages to our provider adapter interface and
 * returns a standard chat.completion (or SSE stream) response.
 */
export async function POST(req: Request) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return badRequest("Invalid JSON body.");
  }

  const model = body.model as string | undefined;
  if (!model) return badRequest("Missing required field: model", "model");

  const messages = body.messages as Array<Record<string, unknown>> | undefined;
  if (!messages || !Array.isArray(messages)) {
    return badRequest("Missing required field: messages", "messages");
  }

  // Resolve adapter
  let adapter;
  let underlyingModel: string;
  try {
    const resolved = await resolveAdapter(model);
    adapter = resolved.adapter;
    underlyingModel = resolved.underlyingModel;
  } catch (e) {
    if (e instanceof Response) return e;
    console.error("resolveAdapter error:", e);
    return serverError();
  }

  // Convert OpenAI messages to provider messages
  const system = extractSystemPrompt(messages);
  const providerMessages = convertMessages(messages);

  // Convert tools
  const providerTools = convertTools(body.tools as Array<Record<string, unknown>> | undefined);
  const providerToolChoice = convertToolChoice(body.tool_choice);

  const chatReq = {
    model: underlyingModel,
    messages: providerMessages,
    system: system ?? undefined,
    tools: providerTools.length > 0 ? providerTools : undefined,
    toolChoice: providerToolChoice,
    temperature: body.temperature as number | undefined,
    topP: body.top_p as number | undefined,
    maxOutputTokens: (body.max_tokens ?? body.max_completion_tokens) as number | undefined,
    signal: req.signal,
  };

  const stream = body.stream === true;
  const chatId = `chatcmpl-${newId("msg_")}`;
  const created = Math.floor(Date.now() / 1000);

  if (!stream) {
    // Non-streaming
    try {
      const result = await adapter.chat(chatReq);

      let content: string | null = null;
      let toolCalls: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }> | undefined;

      for (const item of result.messages) {
        if (item.type === "text") {
          content = (content ?? "") + item.text;
        } else if (item.type === "tool_use") {
          toolCalls = toolCalls ?? [];
          toolCalls.push({
            id: item.callId,
            type: "function",
            function: { name: item.name, arguments: item.arguments },
          });
        }
      }

      const finishReason = mapStopReason(result.stopReason);

      return Response.json({
        id: chatId,
        object: "chat.completion",
        created,
        model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content,
              ...(toolCalls ? { tool_calls: toolCalls } : {}),
            },
            finish_reason: finishReason,
          },
        ],
        usage: {
          prompt_tokens: result.usage.inputTokens,
          completion_tokens: result.usage.outputTokens,
          total_tokens: result.usage.inputTokens + result.usage.outputTokens,
        },
      });
    } catch (e) {
      console.error("POST /v1/chat/completions error:", e);
      return serverError();
    }
  }

  // Streaming
  const readable = new ReadableStream({
    async start(controller) {
      try {
        let toolCallIndex = -1;

        for await (const event of adapter.chatStream(chatReq)) {
          switch (event.type) {
            case "text_delta": {
              const chunk = {
                id: chatId,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [
                  {
                    index: 0,
                    delta: { content: event.delta },
                    finish_reason: null,
                  },
                ],
              };
              controller.enqueue(sseEvent("message", chunk));
              break;
            }
            case "tool_call_start": {
              toolCallIndex++;
              const chunk = {
                id: chatId,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        {
                          index: toolCallIndex,
                          id: event.callId,
                          type: "function",
                          function: { name: event.name, arguments: "" },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              };
              controller.enqueue(sseEvent("message", chunk));
              break;
            }
            case "tool_call_delta": {
              const chunk = {
                id: chatId,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        {
                          index: toolCallIndex,
                          function: { arguments: event.argumentsDelta },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              };
              controller.enqueue(sseEvent("message", chunk));
              break;
            }
            case "message_done": {
              const chunk = {
                id: chatId,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [
                  {
                    index: 0,
                    delta: {},
                    finish_reason: mapStopReason(event.stopReason),
                  },
                ],
                usage: {
                  prompt_tokens: event.usage.inputTokens,
                  completion_tokens: event.usage.outputTokens,
                  total_tokens: event.usage.inputTokens + event.usage.outputTokens,
                },
              };
              controller.enqueue(sseEvent("message", chunk));
              break;
            }
            // tool_call_done is handled implicitly via tool_call_start/delta
          }
        }

        controller.enqueue(sseDone());
        controller.close();
      } catch (e) {
        console.error("chat/completions stream error:", e);
        controller.close();
      }
    },
  });

  return new Response(readable, { headers: SSE_HEADERS });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractSystemPrompt(
  messages: Array<Record<string, unknown>>,
): string | null {
  const systemMsgs = messages.filter((m) => m.role === "system");
  if (systemMsgs.length === 0) return null;
  return systemMsgs.map((m) => String(m.content ?? "")).join("\n");
}

function convertMessages(
  messages: Array<Record<string, unknown>>,
): ProviderMessage[] {
  const result: ProviderMessage[] = [];

  for (const msg of messages) {
    const role = msg.role as string;
    if (role === "system") continue; // handled separately

    const providerRole = role === "tool" ? "user" : (role as ProviderMessage["role"]);

    if (role === "tool") {
      // Tool result message
      const parts: ProviderContentPart[] = [
        {
          type: "tool_result",
          callId: String(msg.tool_call_id ?? ""),
          content: String(msg.content ?? ""),
        },
      ];
      result.push({ role: providerRole, content: parts });
      continue;
    }

    if (role === "assistant" && msg.tool_calls) {
      // Assistant message with tool calls
      const parts: ProviderContentPart[] = [];
      if (msg.content) {
        parts.push({ type: "text", text: String(msg.content) });
      }
      const toolCalls = msg.tool_calls as Array<Record<string, unknown>>;
      for (const tc of toolCalls) {
        const fn = tc.function as Record<string, unknown>;
        parts.push({
          type: "tool_use",
          callId: String(tc.id ?? ""),
          name: String(fn?.name ?? ""),
          input: fn?.arguments ? JSON.parse(String(fn.arguments)) : {},
        });
      }
      result.push({ role: "assistant", content: parts });
      continue;
    }

    // Regular user or assistant message
    const content = msg.content;
    const parts: ProviderContentPart[] = [];

    if (typeof content === "string") {
      parts.push({ type: "text", text: content });
    } else if (Array.isArray(content)) {
      for (const part of content) {
        const p = part as Record<string, unknown>;
        if (p.type === "text") {
          parts.push({ type: "text", text: String(p.text ?? "") });
        } else if (p.type === "image_url") {
          const imageUrl = p.image_url as Record<string, unknown>;
          parts.push({
            type: "image",
            source: { type: "url", url: String(imageUrl?.url ?? "") },
          });
        }
      }
    }

    if (parts.length > 0) {
      result.push({ role: providerRole, content: parts });
    }
  }

  return result;
}

function convertTools(
  tools: Array<Record<string, unknown>> | undefined,
): ProviderTool[] {
  if (!tools) return [];
  return tools
    .filter((t) => t.type === "function")
    .map((t) => {
      const fn = t.function as Record<string, unknown>;
      return {
        name: String(fn?.name ?? ""),
        description: fn?.description ? String(fn.description) : undefined,
        parameters: fn?.parameters as Record<string, unknown> | undefined,
        strict: fn?.strict as boolean | undefined,
      };
    });
}

function convertToolChoice(
  toolChoice: unknown,
): ProviderToolChoice | undefined {
  if (!toolChoice) return undefined;
  if (typeof toolChoice === "string") {
    if (toolChoice === "auto" || toolChoice === "required" || toolChoice === "none") {
      return toolChoice;
    }
    return undefined;
  }
  if (typeof toolChoice === "object" && toolChoice !== null) {
    const tc = toolChoice as Record<string, unknown>;
    if (tc.type === "function" && tc.function) {
      const fn = tc.function as Record<string, unknown>;
      return { type: "function", name: String(fn.name ?? "") };
    }
  }
  return undefined;
}

function mapStopReason(
  reason: string,
): "stop" | "tool_calls" | "length" {
  switch (reason) {
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
      return "length";
    default:
      return "stop";
  }
}
