/**
 * Orchestrator: converts a Responses API request into either a JSON response
 * (non-streaming) or an SSE stream.
 *
 * Flow:
 *   parse request → resolve adapter → build conversation → call provider → emit SSE / JSON
 */

import { eq, and } from "drizzle-orm";
import OpenAI from "openai";
import { db } from "@/lib/db/client";
import { responses } from "@/lib/db/schema";
import { newId } from "@/lib/openresponses/ids";
import { sseEvent, sseDone, SSE_HEADERS } from "@/lib/openresponses/sse";
import {
  createResponseObject,
  createTextMessageItem,
  createFunctionCallItem,
  type ResponseObject,
  type OutputItem,
  type Usage,
} from "@/lib/openresponses/response";
import { sseErrorPayload } from "@/lib/openresponses/errors";
import type { ResponsesRequest } from "@/lib/openresponses/schema";
import type { InputItem } from "@/lib/openresponses/schema";
import { resolveAdapter } from "@/lib/providers/resolver";
import { after } from "next/server";
import type {
  ProviderAdapter,
  ProviderChatRequest,
  ProviderEvent,
  ProviderMessage,
  ProviderContentPart,
  ProviderTool,
  ProviderToolChoice,
} from "@/lib/providers/types";

// ---------------------------------------------------------------------------
// Input item conversion → ProviderMessage[]
// ---------------------------------------------------------------------------

function convertToProviderMessages(
  inputItems: unknown[],
  instructions?: string | null,
): { messages: ProviderMessage[]; system?: string } {
  const messages: ProviderMessage[] = [];
  let system: string | undefined;

  if (instructions) {
    system = instructions;
  }

  for (let i = 0; i < inputItems.length; i++) {
    const item = inputItems[i] as Record<string, unknown>;
    const itemType = item.type as string | undefined;

    if (!itemType || itemType === "message") {
      const role = item.role as string;
      const content = item.content;

      if (role === "system" || role === "developer") {
        const text = extractTextFromContent(content);
        system = system ? `${system}\n${text}` : text;
        continue;
      }

      const parts = convertContentToParts(content);
      if (parts.length > 0) {
        messages.push({
          role: role === "assistant" ? "assistant" : "user",
          content: parts,
        });
      }
      continue;
    }

    if (itemType === "function_call") {
      // function_call belongs in an assistant message with a tool_use part
      const callId = item.call_id as string;
      const name = item.name as string;
      const args = item.arguments as string;

      let parsedInput: unknown;
      try {
        parsedInput = JSON.parse(args);
      } catch {
        parsedInput = args;
      }

      // Check if the previous message is an assistant message we can append to
      const last = messages[messages.length - 1];
      if (last && last.role === "assistant") {
        last.content.push({
          type: "tool_use",
          callId,
          name,
          input: parsedInput,
        });
      } else {
        messages.push({
          role: "assistant",
          content: [
            {
              type: "tool_use",
              callId,
              name,
              input: parsedInput,
            },
          ],
        });
      }
      continue;
    }

    if (itemType === "function_call_output") {
      const callId = item.call_id as string;
      const output = item.output as string;

      // tool_result parts go in a user message
      const last = messages[messages.length - 1];
      if (last && last.role === "user" && last.content.some((p) => p.type === "tool_result")) {
        last.content.push({
          type: "tool_result",
          callId,
          content: output,
        });
      } else {
        messages.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              callId,
              content: output,
            },
          ],
        });
      }
      continue;
    }

    // item_reference — skip for now
  }

  return { messages, system };
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part: Record<string, unknown>) => {
        if (part.type === "input_text" || part.type === "output_text" || part.type === "text") {
          return part.text as string;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function convertContentToParts(content: unknown): ProviderContentPart[] {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }

  if (!Array.isArray(content)) return [];

  const parts: ProviderContentPart[] = [];
  for (const part of content as Record<string, unknown>[]) {
    const partType = part.type as string;

    if (partType === "input_text" || partType === "output_text" || partType === "text") {
      parts.push({ type: "text", text: part.text as string });
    } else if (partType === "input_image") {
      const imageUrl = part.image_url as string | undefined;
      if (imageUrl) {
        if (imageUrl.startsWith("data:")) {
          const match = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
          if (match) {
            parts.push({
              type: "image",
              source: { type: "base64", mediaType: match[1], data: match[2] },
            });
          }
        } else {
          parts.push({
            type: "image",
            source: { type: "url", url: imageUrl },
          });
        }
      }
    }
  }
  return parts;
}

// ---------------------------------------------------------------------------
// Tool conversion
// ---------------------------------------------------------------------------

function convertTools(tools?: unknown[]): ProviderTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;

  const result: ProviderTool[] = [];
  for (const t of tools as Record<string, unknown>[]) {
    if (t.type === "function") {
      result.push({
        name: t.name as string,
        description: t.description as string | undefined,
        parameters: t.parameters as Record<string, unknown> | undefined,
        strict: t.strict as boolean | undefined,
      });
    }
    // Built-in tools (web_search, file_search, etc.) are not yet supported
  }

  return result.length > 0 ? result : undefined;
}

function convertToolChoice(tc?: unknown): ProviderToolChoice | undefined {
  if (!tc) return undefined;
  if (typeof tc === "string") {
    if (tc === "auto" || tc === "required" || tc === "none") return tc;
    return "auto";
  }
  const obj = tc as Record<string, unknown>;
  if (obj.type === "function" && typeof obj.name === "string") {
    return { type: "function", name: obj.name };
  }
  return "auto";
}

// ---------------------------------------------------------------------------
// Build input items (resolve previous_response_id)
// ---------------------------------------------------------------------------

async function buildInputItems(request: ResponsesRequest): Promise<unknown[]> {
  let inputItems: unknown[] = [];

  if (request.previous_response_id) {
    const prev = await db
      .select()
      .from(responses)
      .where(eq(responses.id, request.previous_response_id))
      .limit(1);

    if (!prev[0]) {
      throw new Response(
        JSON.stringify({
          error: {
            message: `Response '${request.previous_response_id}' not found.`,
            type: "not_found",
            param: "previous_response_id",
            code: null,
          },
        }),
        { status: 404, headers: { "content-type": "application/json" } },
      );
    }

    if (!prev[0].store) {
      throw new Response(
        JSON.stringify({
          error: {
            message: "Cannot reference a response that was not stored.",
            type: "invalid_request_error",
            param: "previous_response_id",
            code: null,
          },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }

    // Allow referencing incomplete or cancelled responses — merge their
    // conversation history so the caller can continue from where it left off.
    const prevInput = (prev[0].inputItemsJson as unknown[]) ?? [];
    const prevOutput = (prev[0].outputItemsJson as unknown[]) ?? [];
    inputItems = [...prevInput, ...prevOutput];
  }

  // Normalize current input
  const currentInput = request.input;
  if (typeof currentInput === "string") {
    if (currentInput) {
      inputItems.push({
        type: "message",
        role: "user",
        content: currentInput,
      });
    }
  } else if (Array.isArray(currentInput)) {
    for (const rawItem of currentInput) {
      const item = rawItem as Record<string, unknown>;
      if (item.type === "item_reference") {
        // Find the referenced item by id in already-loaded context
        const refId = item.id as string | undefined;
        if (refId) {
          const found = inputItems.find(
            (i) => (i as Record<string, unknown>).id === refId,
          );
          if (!found) {
            // Not found in current context — silently skip
            // (item may be from a response not in the current chain)
          }
          // Either way, don't push the item_reference itself into messages
        }
      } else {
        inputItems.push(rawItem);
      }
    }
  }

  return inputItems;
}

// ---------------------------------------------------------------------------
// DB persistence helpers
// ---------------------------------------------------------------------------

async function persistResponse(
  responseId: string,
  request: ResponsesRequest,
  inputItems: unknown[],
  status: ResponseObject["status"],
  outputItems: OutputItem[],
  usage: Usage | null,
  createdAt: number,
  errorJson?: unknown,
  incompleteDetailsJson?: unknown,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await db
    .insert(responses)
    .values({
      id: responseId,
      status,
      model: request.model,
      instructions: request.instructions ?? null,
      inputItemsJson: inputItems,
      outputItemsJson: outputItems,
      toolsJson: request.tools ?? [],
      toolChoiceJson: request.tool_choice ?? "auto",
      usageJson: usage,
      metadata: request.metadata ?? {},
      store: true,
      background: request.background ?? false,
      previousResponseId: request.previous_response_id ?? null,
      truncation: request.truncation ?? "disabled",
      parallelToolCalls: request.parallel_tool_calls ?? true,
      temperature: request.temperature ?? null,
      topP: request.top_p ?? null,
      maxOutputTokens: request.max_output_tokens ?? null,
      errorJson: errorJson ?? null,
      incompleteDetailsJson: incompleteDetailsJson ?? null,
      createdAt,
      completedAt: status === "completed" ? now : null,
      cancelledAt: null,
    })
    .onConflictDoUpdate({
      target: responses.id,
      set: {
        status,
        outputItemsJson: outputItems,
        usageJson: usage,
        errorJson: errorJson ?? null,
        incompleteDetailsJson: incompleteDetailsJson ?? null,
        completedAt: status === "completed" ? now : null,
      },
    });
}

/**
 * Partial-output update guarded by status = 'in_progress'.
 * If the row has already been cancelled/completed/failed by another endpoint,
 * this is a no-op — it will not overwrite the terminal status.
 */
async function persistPartialOutput(
  responseId: string,
  outputItems: OutputItem[],
): Promise<void> {
  await db
    .update(responses)
    .set({ outputItemsJson: outputItems })
    .where(and(eq(responses.id, responseId), eq(responses.status, "in_progress")));
}

// ---------------------------------------------------------------------------
// Non-streaming response
// ---------------------------------------------------------------------------

async function nonStreamResponse(
  adapter: ProviderAdapter,
  providerReq: ProviderChatRequest,
  request: ResponsesRequest,
  inputItems: unknown[],
  createdAt: number,
): Promise<Response> {
  const result = await adapter.chat(providerReq);

  // Build output items
  const outputItems: OutputItem[] = [];
  for (const msg of result.messages) {
    if (msg.type === "text") {
      outputItems.push(createTextMessageItem(msg.text));
    } else if (msg.type === "tool_use") {
      outputItems.push(createFunctionCallItem(msg.name, msg.arguments, msg.callId));
    } else if (msg.type === "thinking") {
      outputItems.unshift({
        type: "reasoning",
        id: newId("rs_"),
        summary: [{ type: "summary_text", text: msg.text }],
        status: "completed",
        encrypted_content: null,
      } as unknown as OutputItem);
    }
  }

  const usage: Usage = {
    input_tokens: result.usage.inputTokens,
    output_tokens: result.usage.outputTokens,
    total_tokens: result.usage.inputTokens + result.usage.outputTokens,
    ...(result.usage.cacheReadTokens !== undefined && {
      input_tokens_details: { cached_tokens: result.usage.cacheReadTokens },
    }),
  };

  const responseObj = createResponseObject({
    model: request.model,
    output: outputItems,
    instructions: request.instructions,
    previousResponseId: request.previous_response_id,
    toolChoice: request.tool_choice,
    tools: request.tools,
    parallelToolCalls: request.parallel_tool_calls,
    temperature: request.temperature,
    topP: request.top_p,
    maxOutputTokens: request.max_output_tokens,
    truncation: request.truncation,
    metadata: request.metadata,
    usage,
    status: "completed",
    store: request.store,
    background: request.background,
    text: request.text as { format: { type: string } } | undefined,
    reasoning: request.reasoning,
  });

  // Persist if store=true
  if (request.store) {
    await persistResponse(
      responseObj.id,
      request,
      inputItems,
      "completed",
      outputItems,
      usage,
      createdAt,
    );
  }

  return Response.json(responseObj);
}

// ---------------------------------------------------------------------------
// Streaming response
// ---------------------------------------------------------------------------

async function streamResponse(
  adapter: ProviderAdapter,
  providerReq: ProviderChatRequest,
  request: ResponsesRequest,
  inputItems: unknown[],
  createdAt: number,
): Promise<Response> {
  const responseId = newId("resp_");
  const messageId = newId("msg_");

  // 0. If store=true, persist an initial in_progress row so the cancel
  //    endpoint can find this response before the stream completes.
  if (request.store) {
    await persistResponse(
      responseId,
      request,
      inputItems,
      "in_progress",
      [],
      null,
      createdAt,
    );
  }

  const stream = new ReadableStream({
    async start(controller) {
      let sequence = 0;
      const nextSeq = () => ++sequence;

      // Accumulators
      let accumulatedText = "";
      let accumulatedThinking = "";
      const functionCalls: Array<{
        id: string;
        callId: string;
        name: string;
        arguments: string;
        outputIndex: number;
        done: boolean;
      }> = [];
      // nextOutputIndex is shared across all output items (message + function_calls).
      // Items are assigned an index in the order they first appear in the stream.
      let nextOutputIndex = 0;
      let responseUsage: Usage | null = null;
      // Lazy: only open a message/text item when the first text_delta arrives.
      // This avoids emitting an empty message item for pure tool-call responses.
      let textItemOpened = false;
      let messageOutputIndex = -1;

      // Debounced partial-update timer (only used when store=true)
      let partialUpdateTimer: ReturnType<typeof setTimeout> | null = null;

      const write = (data: Uint8Array) => {
        try {
          controller.enqueue(data);
        } catch {
          // Controller already closed (client disconnected)
        }
      };

      /** Collect current output items from accumulators. */
      const collectOutputItems = (): OutputItem[] => {
        const items: OutputItem[] = [];
        if (textItemOpened) {
          const msgItem = createTextMessageItem(accumulatedText);
          items.push({ ...msgItem, id: messageId });
        }
        for (const fc of functionCalls) {
          items.push({
            type: "function_call",
            id: fc.id,
            call_id: fc.callId,
            status: fc.done ? "completed" : "incomplete",
            name: fc.name,
            arguments: fc.arguments,
          });
        }
        if (accumulatedThinking) {
          items.unshift({
            type: "reasoning",
            id: newId("rs_"),
            summary: [{ type: "summary_text", text: accumulatedThinking }],
            status: "completed",
            encrypted_content: null,
          } as unknown as OutputItem);
        }
        return items;
      };

      /** Fire-and-forget partial DB update (debounced).
       *  Uses persistPartialOutput which guards against overwriting terminal statuses. */
      const schedulePartialUpdate = () => {
        if (!request.store) return;
        if (partialUpdateTimer !== null) clearTimeout(partialUpdateTimer);
        partialUpdateTimer = setTimeout(() => {
          partialUpdateTimer = null;
          persistPartialOutput(
            responseId,
            collectOutputItems(),
          ).catch(console.error);
        }, 1000);
      };

      /** Cancel any pending partial-update timer. */
      const cancelPartialUpdate = () => {
        if (partialUpdateTimer !== null) {
          clearTimeout(partialUpdateTimer);
          partialUpdateTimer = null;
        }
      };

      /** Open the message + text content items on first text_delta. */
      const ensureTextItemOpened = () => {
        if (textItemOpened) return;
        textItemOpened = true;
        messageOutputIndex = nextOutputIndex++;

        write(
          sseEvent("response.output_item.added", {
            type: "response.output_item.added",
            sequence_number: nextSeq(),
            output_index: messageOutputIndex,
            item: {
              type: "message",
              id: messageId,
              status: "in_progress",
              role: "assistant",
              content: [],
            },
          }),
        );

        write(
          sseEvent("response.content_part.added", {
            type: "response.content_part.added",
            sequence_number: nextSeq(),
            item_id: messageId,
            output_index: messageOutputIndex,
            content_index: 0,
            part: { type: "output_text", annotations: [], text: "" },
          }),
        );
      };

      const buildResponseObject = (status: ResponseObject["status"]): ResponseObject => {
        return createResponseObject({
          model: request.model,
          output: collectOutputItems(),
          instructions: request.instructions,
          previousResponseId: request.previous_response_id,
          toolChoice: request.tool_choice,
          tools: request.tools,
          parallelToolCalls: request.parallel_tool_calls,
          temperature: request.temperature,
          topP: request.top_p,
          maxOutputTokens: request.max_output_tokens,
          truncation: request.truncation,
          metadata: request.metadata,
          usage: responseUsage,
          status,
          store: request.store,
          background: request.background,
          text: request.text as { format: { type: string } } | undefined,
          reasoning: request.reasoning,
        });
      };

      try {
        // 1. Emit response.in_progress
        write(
          sseEvent("response.in_progress", {
            type: "response.in_progress",
            sequence_number: nextSeq(),
            response: { id: responseId, status: "in_progress" },
          }),
        );

        // NOTE: message item is opened lazily on first text_delta (ensureTextItemOpened).
        // Function call items use currentOutputIndex which starts at 0 and shifts to 1
        // once the message item is opened.

        // 2. Stream provider events
        for await (const event of adapter.chatStream(providerReq)) {
          switch (event.type) {
            case "text_delta": {
              ensureTextItemOpened();
              accumulatedText += event.delta;
              write(
                sseEvent("response.output_text.delta", {
                  type: "response.output_text.delta",
                  sequence_number: nextSeq(),
                  item_id: messageId,
                  output_index: messageOutputIndex,
                  content_index: 0,
                  delta: event.delta,
                }),
              );
              schedulePartialUpdate();
              break;
            }

            case "tool_call_start": {
              const fcId = newId("fc_");
              const fcOutputIndex = nextOutputIndex++;
              functionCalls.push({
                id: fcId,
                callId: event.callId,
                name: event.name,
                arguments: "",
                outputIndex: fcOutputIndex,
                done: false,
              });

              write(
                sseEvent("response.output_item.added", {
                  type: "response.output_item.added",
                  sequence_number: nextSeq(),
                  output_index: fcOutputIndex,
                  item: {
                    type: "function_call",
                    id: fcId,
                    call_id: event.callId,
                    status: "in_progress",
                    name: event.name,
                    arguments: "",
                  },
                }),
              );
              break;
            }

            case "tool_call_delta": {
              const fc = functionCalls.find((f) => f.callId === event.callId);
              if (fc) {
                fc.arguments += event.argumentsDelta;
              }
              break;
            }

            case "tool_call_done": {
              const fc = functionCalls.find((f) => f.callId === event.callId);
              if (fc) {
                fc.arguments = event.arguments;
                fc.done = true;
                write(
                  sseEvent("response.output_item.done", {
                    type: "response.output_item.done",
                    sequence_number: nextSeq(),
                    output_index: fc.outputIndex,
                    item: {
                      type: "function_call",
                      id: fc.id,
                      call_id: fc.callId,
                      status: "completed",
                      name: fc.name,
                      arguments: fc.arguments,
                    },
                  }),
                );
              }
              break;
            }

            case "thinking_delta": {
              accumulatedThinking += event.delta;
              break;
            }

            case "thinking_done": {
              accumulatedThinking = event.text;
              break;
            }

            case "message_done": {
              responseUsage = {
                input_tokens: event.usage.inputTokens,
                output_tokens: event.usage.outputTokens,
                total_tokens: event.usage.inputTokens + event.usage.outputTokens,
                ...(event.usage.cacheReadTokens !== undefined && {
                  input_tokens_details: { cached_tokens: event.usage.cacheReadTokens },
                }),
              };

              // Close the text part (only if text item was opened)
              if (textItemOpened) {
                write(
                  sseEvent("response.output_text.done", {
                    type: "response.output_text.done",
                    sequence_number: nextSeq(),
                    item_id: messageId,
                    output_index: messageOutputIndex,
                    content_index: 0,
                    text: accumulatedText,
                  }),
                );

                write(
                  sseEvent("response.content_part.done", {
                    type: "response.content_part.done",
                    sequence_number: nextSeq(),
                    item_id: messageId,
                    output_index: messageOutputIndex,
                    content_index: 0,
                    part: {
                      type: "output_text",
                      annotations: [],
                      text: accumulatedText,
                    },
                  }),
                );

                // Close the message item
                write(
                  sseEvent("response.output_item.done", {
                    type: "response.output_item.done",
                    sequence_number: nextSeq(),
                    output_index: messageOutputIndex,
                    item: {
                      type: "message",
                      id: messageId,
                      status: "completed",
                      role: "assistant",
                      content: [
                        {
                          type: "output_text",
                          annotations: [],
                          text: accumulatedText,
                        },
                      ],
                    },
                  }),
                );
              }

              // Emit response.completed
              const completedResponse = buildResponseObject("completed");
              // Override the id to our tracked responseId
              completedResponse.id = responseId;
              completedResponse.created_at = createdAt;

              write(
                sseEvent("response.completed", {
                  type: "response.completed",
                  sequence_number: nextSeq(),
                  response: completedResponse,
                }),
              );
              break;
            }
          }
        }

        // Cancel any pending partial-update timer before final persist
        cancelPartialUpdate();

        // 5. Emit [DONE]
        write(sseDone());

        // 6. Persist if store=true
        if (request.store) {
          const finalResponse = buildResponseObject("completed");
          finalResponse.id = responseId;
          finalResponse.created_at = createdAt;

          await persistResponse(
            responseId,
            request,
            inputItems,
            "completed",
            finalResponse.output,
            responseUsage,
            createdAt,
          ).catch(() => {
            // Best-effort persistence for streaming responses
          });
        }
      } catch (err) {
        // Cancel any pending partial-update timer
        cancelPartialUpdate();

        // Detect abort (cancellation) vs. server error.
        // Covers: native fetch AbortError (DOMException), Node.js Error with name "AbortError",
        // and OpenAI SDK's APIUserAbortError (name property stays "Error" so needs instanceof check).
        const isAbort =
          err instanceof DOMException && err.name === "AbortError" ||
          (err instanceof Error && err.name === "AbortError") ||
          err instanceof OpenAI.APIUserAbortError;

        if (isAbort) {
          // Persist incomplete state with partial output
          if (request.store) {
            await persistResponse(
              responseId,
              request,
              inputItems,
              "incomplete",
              collectOutputItems(),
              responseUsage,
              createdAt,
              undefined,
              { reason: "interrupted" },
            ).catch(console.error);
          }

          // Emit [DONE] so the client knows the stream ended
          write(sseDone());
        } else {
          // Emit error event
          const errorMessage =
            err instanceof Error ? err.message : "Internal server error";

          write(
            sseEvent("error", sseErrorPayload("server_error", errorMessage)),
          );

          // Emit response.failed
          const failedResponse = buildResponseObject("failed");
          failedResponse.id = responseId;
          failedResponse.created_at = createdAt;
          failedResponse.error = {
            type: "server_error",
            message: errorMessage,
            code: null,
          };

          write(
            sseEvent("response.failed", {
              type: "response.failed",
              sequence_number: nextSeq(),
              response: failedResponse,
            }),
          );

          write(sseDone());

          // Persist error if store=true
          if (request.store) {
            await persistResponse(
              responseId,
              request,
              inputItems,
              "failed",
              [],
              null,
              createdAt,
              { type: "server_error", message: errorMessage, code: null },
            ).catch(() => {});
          }
        }
      } finally {
        try {
          controller.close();
        } catch {
          // Already closed
        }
      }
    },
  });

  return new Response(stream, {
    headers: SSE_HEADERS,
  });
}

// ---------------------------------------------------------------------------
// Background response
// ---------------------------------------------------------------------------

async function backgroundResponse(
  adapter: ProviderAdapter,
  providerReq: ProviderChatRequest,
  request: ResponsesRequest,
  inputItems: unknown[],
  createdAt: number,
): Promise<Response> {
  const responseId = newId("resp_");

  // Persist initial in_progress row immediately
  await persistResponse(
    responseId,
    request,
    inputItems,
    "in_progress",
    [],
    null,
    createdAt,
  );

  const inProgressObj = createResponseObject({
    model: request.model,
    output: [],
    instructions: request.instructions,
    previousResponseId: request.previous_response_id,
    toolChoice: request.tool_choice,
    tools: request.tools,
    parallelToolCalls: request.parallel_tool_calls,
    temperature: request.temperature,
    topP: request.top_p,
    maxOutputTokens: request.max_output_tokens,
    truncation: request.truncation,
    metadata: request.metadata,
    usage: null,
    status: "in_progress",
    store: request.store,
    background: true,
    text: request.text as { format: { type: string } } | undefined,
    reasoning: request.reasoning,
  });
  inProgressObj.id = responseId;
  inProgressObj.created_at = createdAt;

  // Run LLM call in background after response is sent
  after(async () => {
    try {
      const result = await adapter.chat(providerReq);
      const outputItems: OutputItem[] = [];
      for (const msg of result.messages) {
        if (msg.type === "text") {
          outputItems.push(createTextMessageItem(msg.text));
        } else if (msg.type === "tool_use") {
          outputItems.push(createFunctionCallItem(msg.name, msg.arguments, msg.callId));
        }
      }
      const usage: Usage = {
        input_tokens: result.usage.inputTokens,
        output_tokens: result.usage.outputTokens,
        total_tokens: result.usage.inputTokens + result.usage.outputTokens,
        ...(result.usage.cacheReadTokens !== undefined && {
          input_tokens_details: { cached_tokens: result.usage.cacheReadTokens },
        }),
      };
      await persistResponse(responseId, request, inputItems, "completed", outputItems, usage, createdAt);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Background task failed";
      await persistResponse(
        responseId, request, inputItems, "failed", [], null, createdAt,
        { type: "server_error", message: errMsg, code: null },
      ).catch(console.error);
    }
  });

  return Response.json(inProgressObj);
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function runResponse(
  request: ResponsesRequest,
  signal: AbortSignal,
): Promise<Response> {
  // 1. Resolve adapter
  const { adapter, underlyingModel } = await resolveAdapter(request.model);

  // 2. Build conversation history
  const inputItems = await buildInputItems(request);

  // 3. Convert to provider messages
  const { messages, system } = convertToProviderMessages(
    inputItems,
    request.instructions,
  );

  // 4. Convert tools
  const tools = convertTools(request.tools);
  const toolChoice = convertToolChoice(request.tool_choice);

  const createdAt = Math.floor(Date.now() / 1000);

  // 5. Build provider request
  const providerReq: ProviderChatRequest = {
    model: underlyingModel,
    messages,
    system,
    tools,
    toolChoice,
    temperature: request.temperature ?? undefined,
    topP: request.top_p ?? undefined,
    maxOutputTokens: request.max_output_tokens ?? undefined,
    signal,
    textFormat: request.text?.format
      ? (() => {
          const fmt = request.text!.format as Record<string, unknown>;
          return {
            type: fmt.type as "text" | "json_object" | "json_schema",
            schema: fmt.type === "json_schema" ? fmt.schema : undefined,
            schemaName: fmt.type === "json_schema" ? (fmt.name as string | undefined) : undefined,
          };
        })()
      : undefined,
    reasoning: request.reasoning?.effort
      ? {
          budgetTokens:
            request.reasoning.effort === "low"    ? 1024  :
            request.reasoning.effort === "medium" ? 8192  :
            /* high */                              32768,
        }
      : undefined,
  };

  // 6. Background mode: return in_progress immediately, run LLM asynchronously
  if (request.background && request.store) {
    return backgroundResponse(adapter, providerReq, request, inputItems, createdAt);
  }

  // 7. Dispatch to streaming or non-streaming handler
  if (request.stream) {
    return streamResponse(adapter, providerReq, request, inputItems, createdAt);
  } else {
    return nonStreamResponse(
      adapter,
      providerReq,
      request,
      inputItems,
      createdAt,
    );
  }
}
