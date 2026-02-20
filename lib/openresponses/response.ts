import { newId } from "./ids";

// ---------------------------------------------------------------------------
// Content parts
// ---------------------------------------------------------------------------

export interface OutputTextPart {
  type: "output_text";
  text: string;
  annotations: unknown[];
}

// ---------------------------------------------------------------------------
// Output items
// ---------------------------------------------------------------------------

export interface MessageItem {
  type: "message";
  id: string;
  status: "in_progress" | "completed" | "incomplete";
  role: "assistant";
  content: OutputTextPart[];
}

export interface FunctionCallItem {
  type: "function_call";
  id: string;
  call_id: string;
  status: "in_progress" | "completed" | "incomplete";
  name: string;
  arguments: string;
}

export type OutputItem = MessageItem | FunctionCallItem;

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  input_tokens_details?: { cached_tokens: number };
  output_tokens_details?: { reasoning_tokens: number };
}

// ---------------------------------------------------------------------------
// Response object
// ---------------------------------------------------------------------------

export interface ResponseObject {
  id: string;
  object: "response";
  created_at: number;
  status: "queued" | "in_progress" | "completed" | "failed" | "cancelled" | "incomplete";
  model: string;
  output: OutputItem[];
  tool_choice: unknown;
  tools: unknown[];
  parallel_tool_calls: boolean;
  instructions: string | null;
  previous_response_id: string | null;
  temperature: number | null;
  top_p: number | null;
  max_output_tokens: number | null;
  truncation: string;
  metadata: Record<string, string>;
  usage: Usage | null;
  error: unknown | null;
  incomplete_details: unknown | null;
  text: { format: { type: string } };
  reasoning: unknown | null;
  store: boolean;
  background: boolean;
}

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

export function createTextMessageItem(text: string): MessageItem {
  return {
    type: "message",
    id: newId("msg_"),
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text, annotations: [] }],
  };
}

export function createFunctionCallItem(
  name: string,
  args: string,
  callId?: string,
): FunctionCallItem {
  return {
    type: "function_call",
    id: newId("fc_"),
    call_id: callId ?? newId("fc_"),
    status: "completed",
    name,
    arguments: args,
  };
}

export interface CreateResponseObjectArgs {
  model: string;
  output?: OutputItem[];
  instructions?: string | null;
  previousResponseId?: string | null;
  toolChoice?: unknown;
  tools?: unknown[];
  parallelToolCalls?: boolean;
  temperature?: number | null;
  topP?: number | null;
  maxOutputTokens?: number | null;
  truncation?: string;
  metadata?: Record<string, string>;
  usage?: Usage | null;
  status?: ResponseObject["status"];
  error?: unknown | null;
  incompleteDetails?: unknown | null;
  text?: { format: { type: string } };
  reasoning?: unknown | null;
  store?: boolean;
  background?: boolean;
}

export function createResponseObject(args: CreateResponseObjectArgs): ResponseObject {
  return {
    id: newId("resp_"),
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: args.status ?? "completed",
    model: args.model,
    output: args.output ?? [],
    tool_choice: args.toolChoice ?? "auto",
    tools: args.tools ?? [],
    parallel_tool_calls: args.parallelToolCalls ?? true,
    instructions: args.instructions ?? null,
    previous_response_id: args.previousResponseId ?? null,
    temperature: args.temperature ?? null,
    top_p: args.topP ?? null,
    max_output_tokens: args.maxOutputTokens ?? null,
    truncation: args.truncation ?? "disabled",
    metadata: args.metadata ?? {},
    usage: args.usage ?? null,
    error: args.error ?? null,
    incomplete_details: args.incompleteDetails ?? null,
    text: args.text ?? { format: { type: "text" } },
    reasoning: args.reasoning ?? null,
    store: args.store ?? true,
    background: args.background ?? false,
  };
}
