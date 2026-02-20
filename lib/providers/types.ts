/**
 * Provider Adapter interface and internal event types.
 *
 * Every backend (Anthropic, OpenAI-compatible, etc.) implements ProviderAdapter,
 * emitting normalised ProviderEvents so the orchestrator stays backend-agnostic.
 */

// ---------------------------------------------------------------------------
// Normalised message format passed to providers
// ---------------------------------------------------------------------------

export type ProviderRole = "user" | "assistant" | "system";

export interface ProviderTextPart {
  type: "text";
  text: string;
}

export interface ProviderImagePart {
  type: "image";
  source:
    | { type: "url"; url: string }
    | { type: "base64"; mediaType: string; data: string };
}

export interface ProviderToolUsePart {
  type: "tool_use";
  callId: string;
  name: string;
  input: unknown; // parsed JSON object
}

export interface ProviderToolResultPart {
  type: "tool_result";
  callId: string;
  content: string;
}

export type ProviderContentPart =
  | ProviderTextPart
  | ProviderImagePart
  | ProviderToolUsePart
  | ProviderToolResultPart;

export interface ProviderMessage {
  role: ProviderRole;
  content: ProviderContentPart[];
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export interface ProviderTool {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>; // JSON Schema
  strict?: boolean;
}

export type ProviderToolChoice =
  | "auto"
  | "required"
  | "none"
  | { type: "function"; name: string };

// ---------------------------------------------------------------------------
// Chat request (sent to adapters)
// ---------------------------------------------------------------------------

export interface ProviderChatRequest {
  /** Underlying model name (e.g. "claude-opus-4-6", "gpt-oss-20b") */
  model: string;
  messages: ProviderMessage[];
  system?: string;
  tools?: ProviderTool[];
  toolChoice?: ProviderToolChoice;
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
  /** Structured output format requested by the client. */
  textFormat?: {
    type: "text" | "json_object" | "json_schema";
    schema?: unknown;      // JSON Schema for json_schema type
    schemaName?: string;   // Optional name for json_schema type
  };
  /** Extended thinking / reasoning configuration. */
  reasoning?: {
    budgetTokens: number;
  };
  /**
   * Whether to allow parallel tool calls. Stored and returned but Anthropic
   * handles tool parallelism internally — this field has no effect on the
   * provider call.
   */
  parallelToolCalls?: boolean;
}

// ---------------------------------------------------------------------------
// Streaming events emitted by provider adapters
// ---------------------------------------------------------------------------

export type ProviderEvent =
  | { type: "text_delta"; delta: string }
  | { type: "tool_call_start"; callId: string; name: string; outputIndex: number }
  | { type: "tool_call_delta"; callId: string; argumentsDelta: string }
  | { type: "tool_call_done"; callId: string; arguments: string; outputIndex: number }
  | {
      type: "message_done";
      stopReason: StopReason;
      usage: ProviderUsage;
    }
  | { type: "thinking_delta"; delta: string }
  | { type: "thinking_done"; text: string };

// ---------------------------------------------------------------------------
// Usage & results
// ---------------------------------------------------------------------------

export type StopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "stop"
  | "cancelled";

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
}

export interface ProviderFinalResult {
  messages: ProviderOutputItem[];
  stopReason: StopReason;
  usage: ProviderUsage;
}

export type ProviderOutputItem =
  | { type: "text"; text: string }
  | { type: "tool_use"; callId: string; name: string; arguments: string }
  | { type: "image"; data: string; mediaType: string }
  | { type: "thinking"; text: string };

// ---------------------------------------------------------------------------
// Adapter interface
// ---------------------------------------------------------------------------

export interface ProviderAdapter {
  /** Underlying model names this adapter can handle */
  readonly models: readonly string[];

  /** Non-streaming: single request -> final result */
  chat(req: ProviderChatRequest): Promise<ProviderFinalResult>;

  /** Streaming: yields normalised events as they arrive */
  chatStream(req: ProviderChatRequest): AsyncIterable<ProviderEvent>;
}
