import { z } from "zod";

// ---------------------------------------------------------------------------
// Input item schemas
// ---------------------------------------------------------------------------

/** A single content part inside an input message (text or image_url). */
const InputTextContentSchema = z.object({
  type: z.literal("input_text"),
  text: z.string(),
});

const InputImageContentSchema = z.object({
  type: z.literal("input_image"),
  image_url: z.string().optional(),
  detail: z.enum(["auto", "low", "high"]).optional(),
});

const InputContentPartSchema = z.discriminatedUnion("type", [
  InputTextContentSchema,
  InputImageContentSchema,
]);

/** An input message item (user / assistant / system / developer). */
const InputMessageItemSchema = z.object({
  type: z.literal("message").optional().default("message"),
  role: z.enum(["user", "assistant", "system", "developer"]),
  content: z.union([z.string(), z.array(InputContentPartSchema)]),
});

/** function_call item (from a prior assistant turn). */
const FunctionCallItemSchema = z.object({
  type: z.literal("function_call"),
  id: z.string().optional(),
  call_id: z.string(),
  name: z.string(),
  arguments: z.string(),
});

/** function_call_output item (client providing tool results). */
const FunctionCallOutputItemSchema = z.object({
  type: z.literal("function_call_output"),
  call_id: z.string(),
  output: z.string(),
});

/** Item reference for conversation continuation. */
const ItemReferenceSchema = z.object({
  type: z.literal("item_reference"),
  id: z.string(),
});

export const InputItemSchema = z.discriminatedUnion("type", [
  InputMessageItemSchema,
  FunctionCallItemSchema,
  FunctionCallOutputItemSchema,
  ItemReferenceSchema,
]);

export type InputItem = z.infer<typeof InputItemSchema>;

// ---------------------------------------------------------------------------
// Tool schemas
// ---------------------------------------------------------------------------

/** A user-defined function tool. */
const FunctionToolSchema = z.object({
  type: z.literal("function"),
  name: z.string(),
  description: z.string().optional(),
  parameters: z.record(z.unknown()).optional(),
  strict: z.boolean().optional(),
});

/** Built-in tool: web_search. */
const WebSearchToolSchema = z.object({
  type: z.literal("web_search_preview"),
  search_context_size: z.enum(["low", "medium", "high"]).optional(),
  user_location: z
    .object({
      type: z.literal("approximate"),
      city: z.string().optional(),
      country: z.string().optional(),
      region: z.string().optional(),
      timezone: z.string().optional(),
    })
    .optional(),
});

/** Built-in tool: file_search. */
const FileSearchToolSchema = z.object({
  type: z.literal("file_search"),
  vector_store_ids: z.array(z.string()),
  max_num_results: z.number().int().optional(),
  ranking_options: z
    .object({
      ranker: z.string().optional(),
      score_threshold: z.number().optional(),
    })
    .optional(),
  filters: z.unknown().optional(),
});

/** Built-in tool: code_interpreter. */
const CodeInterpreterToolSchema = z.object({
  type: z.literal("code_interpreter"),
  container: z
    .object({
      type: z.literal("auto"),
      file_ids: z.array(z.string()).optional(),
    })
    .optional(),
});

/** Built-in tool: image_generation. */
const ImageGenerationToolSchema = z.object({
  type: z.literal("image_generation"),
  background: z.enum(["transparent", "opaque", "auto"]).optional(),
  input_image_mask: z
    .object({
      image_url: z.string(),
      type: z.literal("mask"),
    })
    .optional(),
  output_compression: z.number().int().optional(),
  output_format: z.enum(["png", "jpeg", "webp"]).optional(),
  partial_images: z.number().int().optional(),
  quality: z.enum(["auto", "low", "medium", "high"]).optional(),
  size: z.enum(["auto", "1024x1024", "1024x1536", "1536x1024"]).optional(),
});

/** Built-in tool: computer_use. */
const ComputerUseToolSchema = z.object({
  type: z.literal("computer_use_preview"),
  display_width: z.number().int(),
  display_height: z.number().int(),
  environment: z.enum(["browser", "mac", "windows", "linux", "ubuntu"]).optional(),
});

/** MCP tool. */
const McpToolSchema = z.object({
  type: z.literal("mcp"),
  server_label: z.string(),
  server_url: z.string(),
  allowed_tools: z.array(z.string()).optional(),
  headers: z.record(z.string()).optional(),
  require_approval: z
    .union([
      z.literal("always"),
      z.literal("never"),
      z.object({
        never: z.object({ tool_names: z.array(z.string()) }),
      }),
    ])
    .optional(),
});

const ToolSchema = z.discriminatedUnion("type", [
  FunctionToolSchema,
  WebSearchToolSchema,
  FileSearchToolSchema,
  CodeInterpreterToolSchema,
  ImageGenerationToolSchema,
  ComputerUseToolSchema,
  McpToolSchema,
]);

export type Tool = z.infer<typeof ToolSchema>;

// ---------------------------------------------------------------------------
// Tool choice
// ---------------------------------------------------------------------------

const ToolChoiceObjectSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("function"), name: z.string() }),
  z.object({
    type: z.literal("allowed_tools"),
    allowed_tools: z.array(z.string()),
  }),
]);

const ToolChoiceSchema = z.union([
  z.enum(["auto", "required", "none"]),
  ToolChoiceObjectSchema,
]);

export type ToolChoice = z.infer<typeof ToolChoiceSchema>;

// ---------------------------------------------------------------------------
// Text format
// ---------------------------------------------------------------------------

const TextFormatSchema = z.object({
  format: z.discriminatedUnion("type", [
    z.object({ type: z.literal("text") }),
    z.object({
      type: z.literal("json_schema"),
      name: z.string(),
      schema: z.record(z.unknown()),
      description: z.string().optional(),
      strict: z.boolean().optional(),
    }),
    z.object({ type: z.literal("json_object") }),
  ]),
});

// ---------------------------------------------------------------------------
// Reasoning
// ---------------------------------------------------------------------------

const ReasoningSchema = z.object({
  effort: z.enum(["low", "medium", "high"]).optional(),
  summary: z.enum(["auto", "concise", "detailed"]).optional(),
});

// ---------------------------------------------------------------------------
// Top-level request schema
// ---------------------------------------------------------------------------

export const ResponsesRequestSchema = z.object({
  model: z.string(),
  input: z.union([z.string(), z.array(InputItemSchema)]),
  stream: z.boolean().optional().default(false),
  instructions: z.string().nullable().optional(),
  previous_response_id: z.string().nullable().optional(),
  tools: z.array(ToolSchema).optional().default([]),
  tool_choice: ToolChoiceSchema.optional().default("auto"),
  temperature: z.number().min(0).max(2).nullable().optional(),
  top_p: z.number().min(0).max(1).nullable().optional(),
  max_output_tokens: z.number().int().positive().nullable().optional(),
  store: z.boolean().optional().default(true),
  background: z.boolean().optional().default(false),
  metadata: z.record(z.string()).optional().default({}),
  truncation: z.enum(["auto", "disabled"]).optional().default("disabled"),
  parallel_tool_calls: z.boolean().optional().default(true),
  text: TextFormatSchema.optional(),
  reasoning: ReasoningSchema.nullable().optional(),
});

export type ResponsesRequest = z.infer<typeof ResponsesRequestSchema>;
