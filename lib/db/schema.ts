import {
  pgTable,
  text,
  boolean,
  real,
  integer,
  bigint,
  jsonb,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// responses
// ---------------------------------------------------------------------------
export const responses = pgTable("responses", {
  id: text("id").primaryKey(),
  status: text("status").notNull(), // queued | in_progress | completed | failed | cancelled | incomplete
  model: text("model").notNull(),
  instructions: text("instructions"),
  inputItemsJson: jsonb("input_items_json"),
  outputItemsJson: jsonb("output_items_json"),
  toolsJson: jsonb("tools_json"),
  toolChoiceJson: jsonb("tool_choice_json"),
  usageJson: jsonb("usage_json"),
  metadata: jsonb("metadata"),
  store: boolean("store").default(false),
  background: boolean("background").default(false),
  previousResponseId: text("previous_response_id"),
  truncation: text("truncation").default("auto"),
  parallelToolCalls: boolean("parallel_tool_calls").default(true),
  temperature: real("temperature"),
  topP: real("top_p"),
  maxOutputTokens: integer("max_output_tokens"),
  errorJson: jsonb("error_json"),
  incompleteDetailsJson: jsonb("incomplete_details_json"),
  createdAt: integer("created_at").notNull(),
  completedAt: integer("completed_at"),
  cancelledAt: integer("cancelled_at"),
});

// ---------------------------------------------------------------------------
// files
// ---------------------------------------------------------------------------
export const files = pgTable("files", {
  id: text("id").primaryKey(),
  purpose: text("purpose").notNull(),
  filename: text("filename").notNull(),
  bytes: bigint("bytes", { mode: "number" }),
  mimeType: text("mime_type"),
  sha256: text("sha256"),
  blobKey: text("blob_key"),
  createdAt: integer("created_at").notNull(),
});

// ---------------------------------------------------------------------------
// vector_stores
// ---------------------------------------------------------------------------
export const vectorStores = pgTable("vector_stores", {
  id: text("id").primaryKey(),
  name: text("name"),
  status: text("status").notNull(), // in_progress | completed | expired | cancelled
  fileCountsJson: jsonb("file_counts_json"),
  expiresAt: integer("expires_at"),
  metadata: jsonb("metadata"),
  createdAt: integer("created_at").notNull(),
});

// ---------------------------------------------------------------------------
// vector_store_files
// ---------------------------------------------------------------------------
export const vectorStoreFiles = pgTable("vector_store_files", {
  id: text("id").primaryKey(),
  vectorStoreId: text("vector_store_id").notNull(),
  fileId: text("file_id").notNull(),
  status: text("status").notNull(), // in_progress | completed | failed | cancelled
  errorJson: jsonb("error_json"),
  createdAt: integer("created_at").notNull(),
});

// ---------------------------------------------------------------------------
// file_batches
// ---------------------------------------------------------------------------
export const fileBatches = pgTable("file_batches", {
  id: text("id").primaryKey(),
  vectorStoreId: text("vector_store_id").notNull(),
  status: text("status").notNull(),
  fileCountsJson: jsonb("file_counts_json"),
  createdAt: integer("created_at").notNull(),
});
