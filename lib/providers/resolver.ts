/**
 * Model name -> ProviderAdapter resolver.
 *
 * Maps public model IDs (e.g. "gpt-oss-20b-responses") to the correct adapter
 * and underlying model name. Adapters are lazily instantiated as singletons.
 */

import type { ProviderAdapter } from "@/lib/providers/types";
import { badRequest } from "@/lib/openresponses/errors";

// ---------------------------------------------------------------------------
// Model registry
// ---------------------------------------------------------------------------

interface ModelEntry {
  /** Public model ID exposed by the API (e.g. "gpt-oss-20b-responses") */
  id: string;
  /** Underlying model passed to the provider (e.g. "gpt-oss-20b") */
  underlyingModel: string;
  /** Key used to look up / instantiate the adapter */
  adapterKey: "anthropic" | "openai-compatible";
  /** Owner shown in GET /v1/models */
  ownedBy: string;
  /** Unix timestamp shown in GET /v1/models */
  created: number;
}

export const MODEL_MAP: Record<string, ModelEntry> = {
  "gpt-oss-20b-responses": {
    id: "gpt-oss-20b-responses",
    underlyingModel: "gpt-oss-20b",
    adapterKey: "openai-compatible",
    ownedBy: "openai",
    created: 1700000000,
  },
  "claude-opus-4-6-responses": {
    id: "claude-opus-4-6-responses",
    underlyingModel: "claude-opus-4-6",
    adapterKey: "anthropic",
    ownedBy: "anthropic",
    created: 1700000000,
  },
  "claude-sonnet-4-6-responses": {
    id: "claude-sonnet-4-6-responses",
    underlyingModel: "claude-sonnet-4-6",
    adapterKey: "anthropic",
    ownedBy: "anthropic",
    created: 1700000000,
  },
};

// ---------------------------------------------------------------------------
// Model list for GET /v1/models
// ---------------------------------------------------------------------------

export const AVAILABLE_MODELS = Object.values(MODEL_MAP).map((entry) => ({
  id: entry.id,
  object: "model" as const,
  created: entry.created,
  owned_by: entry.ownedBy,
}));

// ---------------------------------------------------------------------------
// Adapter singletons (lazy)
// ---------------------------------------------------------------------------

const adapterCache = new Map<string, ProviderAdapter>();

async function getAdapter(key: "anthropic" | "openai-compatible"): Promise<ProviderAdapter> {
  const cached = adapterCache.get(key);
  if (cached) return cached;

  let adapter: ProviderAdapter;

  switch (key) {
    case "anthropic": {
      const { AnthropicAdapter } = await import("@/lib/providers/anthropic");
      adapter = new AnthropicAdapter();
      break;
    }
    case "openai-compatible": {
      const { OpenAICompatibleAdapter } = await import(
        "@/lib/providers/openai-compatible"
      );
      adapter = new OpenAICompatibleAdapter();
      break;
    }
    default: {
      const _exhaustive: never = key;
      throw new Error(`Unknown adapter key: ${_exhaustive}`);
    }
  }

  adapterCache.set(key, adapter);
  return adapter;
}

// ---------------------------------------------------------------------------
// Public resolver
// ---------------------------------------------------------------------------

export async function resolveAdapter(
  modelId: string,
): Promise<{ adapter: ProviderAdapter; underlyingModel: string }> {
  const entry = MODEL_MAP[modelId];

  if (!entry) {
    throw badRequest(
      `Model '${modelId}' is not a supported model. Supported models: ${Object.keys(MODEL_MAP).join(", ")}`,
      "model",
    );
  }

  const adapter = await getAdapter(entry.adapterKey);
  return { adapter, underlyingModel: entry.underlyingModel };
}
