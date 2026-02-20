# Open Responses Proxy

**A self-hosted OpenAI Responses API server with pluggable LLM backends — Anthropic Claude, vLLM, Ollama, and more through the exact same API surface.**

If you're using the [OpenAI Agents SDK](https://github.com/openai/openai-agents-js), changing one `baseURL` is all it takes to run it against any backend.

```typescript
import { OpenAIProvider, setOpenAIAPI } from "@openai/agents";

setOpenAIAPI("responses");

const provider = new OpenAIProvider({
  baseURL: "https://your-open-responses-proxy.example.com/v1",
  apiKey: "your-api-key",
});
```

---

## What it is

OpenAI's [Responses API](https://platform.openai.com/docs/api-reference/responses) is a stateful, conversation-oriented API designed for agent workloads — it stores responses server-side, supports `previous_response_id` for conversation threading, and emits structured SSE events. This project is a self-hosted implementation of that API surface that proxies the actual LLM calls to:

- **Anthropic Claude** (Opus, Sonnet) via the Anthropic Messages API
- **Any OpenAI-compatible endpoint** (vLLM, Ollama, etc.)

Think of it as an adapter layer: clients speak the Responses API protocol, this server translates to the appropriate backend, and results flow back in the Responses API format.

---

## Features

### What works

| Feature | Status | Notes |
|---|---|---|
| Text generation (streaming + non-streaming) | ✅ | Full SSE event sequence |
| Tool / function calling | ✅ | Definitions, `tool_choice`, multi-turn results |
| Vision / image input | ✅ | Base64 and URL sources |
| Structured output — `json_object` | ✅ | System prompt injection |
| Structured output — `json_schema` | ✅ | Synthetic tool injection pattern |
| Extended thinking / reasoning | ✅ | Maps `effort` levels to `budget_tokens` |
| Multi-turn via `previous_response_id` | ✅ | Including incomplete/cancelled responses |
| Background mode | ✅ | Returns `in_progress` immediately, polls via GET |
| Mid-stream injection | ✅ | Abort + `previous_response_id` pattern |
| Store & retrieve responses | ✅ | PostgreSQL-backed |
| Cancel in-flight responses | ✅ (best-effort) | See limitations below |
| Temperature range normalisation | ✅ | Clamps 0–2 → 0–1 for Anthropic |
| Cached token reporting | ✅ | Maps `cache_read_input_tokens` |
| Files API | ✅ | Upload, retrieve, delete |
| Vector Stores API | ✅ | Create, search, manage |
| Models API | ✅ | List and retrieve available models |

### Limitations

| Feature | Status | Reason |
|---|---|---|
| Built-in tools (`web_search`, `file_search`, `code_interpreter`, `image_generation`) | ❌ Not supported | These are OpenAI-hosted services with no direct Anthropic equivalent. Returns `501`. |
| Audio input / output | ❌ Not supported | Anthropic does not support audio modality. |
| True server-side cancellation | ⚠️ Best-effort | The cancel endpoint marks the DB row as `cancelled` immediately, but cannot abort an already-in-flight HTTP request to Anthropic. Token consumption continues until the upstream response completes. |
| `reasoning_tokens` in usage | ❌ Not available | Anthropic does not report thinking token counts separately in usage. |
| `service_tier` | ❌ Not mapped | No equivalent concept in the Anthropic API. |
| `include`, `modalities` request parameters | ❌ Ignored | Not yet implemented. |
| `item_reference` in input | ⚠️ Partial | Items already present in the resolved conversation context are deduplicated; references to items outside the current chain are silently skipped. |
| Image content in streaming output | ⚠️ Stub | Image blocks in streaming responses are not yet emitted as SSE events. Non-streaming image output works. |
| `parallel_tool_calls` enforcement | ⚠️ Stored only | Accepted and returned in the response object, but Anthropic manages tool parallelism internally. |

### In progress / planned

- [ ] Proper `ReasoningItem` TypeScript type in the `OutputItem` union (currently cast via `unknown`)
- [ ] Image content in streaming SSE events
- [ ] `item_reference` full DB-backed resolution (look up items outside the current chain)
- [ ] Gemini adapter
- [ ] Rate-limit header pass-through from upstream providers
- [ ] `include` parameter support (e.g. `file_search_results`, `message.input_image.image_url`)

---

## Mid-stream user injection

One of the more powerful patterns enabled by the Responses API's stateful design is injecting additional instructions into an ongoing generation:

```typescript
// 1. Start generation, capture the response ID
const controller = new AbortController();
const responseId = /* from response.in_progress SSE event */;

// 2. Abort mid-generation
controller.abort();

// 3. Continue with additional instructions — the model sees its partial output + your new message
await fetch("/v1/responses", {
  method: "POST",
  body: JSON.stringify({
    previous_response_id: responseId,   // partial output is preserved
    input: "Please be more concise.",
    store: true,
  }),
});
```

This works because incomplete responses are persisted to the database at abort time with `status: "incomplete"`.

---

## Getting started

### Prerequisites

- Node.js 20+
- PostgreSQL 14+
- An Anthropic API key and/or an OpenAI-compatible endpoint

### Environment variables

```env
# Database
DATABASE_URL=postgresql://user:password@localhost:5432/responses

# Anthropic
ANTHROPIC_API_KEY=sk-ant-...

# OpenAI-compatible (e.g. vLLM)
GPT_OSS_BASE_URL=http://localhost:8000/v1
GPT_OSS_API_KEY=...

# Auth — comma-separated list of accepted Bearer tokens
# If unset, all tokens are accepted (development mode only)
API_KEYS=your-secret-key

# File storage (S3-compatible)
S3_ENDPOINT=...
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_BUCKET=...
```

### Setup

```bash
npm install

# Push schema to database
npm run db:push

# Start development server
npm run dev
```

### Running tests

```bash
npm test                   # Unit tests
npm run test:integration   # Integration tests (requires ANTHROPIC_API_KEY)
```

---

## Adding a model

1. Create or reuse an adapter in `lib/providers/`
2. Register the model in `lib/providers/resolver.ts`:

```typescript
"my-model-responses": {
  id: "my-model-responses",
  underlyingModel: "my-model",
  adapterKey: "openai-compatible",
  ownedBy: "my-org",
  created: 1700000000,
},
```

---

## Architecture

```
Client (OpenAI Agents SDK / any HTTP client)
    │
    │  POST /v1/responses  (Responses API protocol)
    ▼
app/v1/responses/route.ts   ← request validation (Zod)
    │
    ▼
lib/orchestrator/index.ts   ← conversation assembly, SSE streaming, persistence
    │
    ├─► lib/providers/anthropic/        ← Anthropic Messages API adapter
    └─► lib/providers/openai-compatible/ ← vLLM / Ollama adapter
    │
    ▼
lib/db/  (PostgreSQL via Drizzle ORM)   ← response storage
```

**Key design decisions:**

- **Stateful by default** — responses are stored in PostgreSQL with their full input/output item history, enabling `previous_response_id` threading without the client needing to replay history.
- **Partial persistence** — streaming responses are checkpointed to the database every ~1 second, so an aborted response retains its partial output and can be referenced in subsequent requests.
- **Adapter pattern** — each backend implements a narrow `ProviderAdapter` interface (`chat` + `chatStream`), keeping the orchestrator backend-agnostic.

---

## API endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/v1/responses` | Create a response (streaming or non-streaming) |
| `GET` | `/v1/responses/:id` | Retrieve a stored response |
| `DELETE` | `/v1/responses/:id` | Delete a stored response |
| `POST` | `/v1/responses/:id/cancel` | Cancel an in-progress response |
| `POST` | `/v1/responses/compact` | Compact a conversation (requires `previous_response_id`) |
| `GET` | `/v1/models` | List available models |
| `GET` | `/v1/models/:id` | Retrieve a model |
| `POST` | `/v1/files` | Upload a file |
| `GET` | `/v1/files/:id` | Retrieve file metadata |
| `GET` | `/v1/files/:id/content` | Download file content |
| `DELETE` | `/v1/files/:id` | Delete a file |
| `POST` | `/v1/vector_stores` | Create a vector store |
| `GET` | `/v1/vector_stores/:id` | Retrieve a vector store |
| `POST` | `/v1/vector_stores/:id/search` | Search a vector store |

See [`docs/API_REFERENCE.md`](docs/API_REFERENCE.md) for full request/response schemas.

---

## Contributing

Contributions of all kinds are welcome — bug reports, feature requests, documentation improvements, new provider adapters, or code fixes. If you're unsure whether an idea fits the project, open an issue first and let's talk it through.

### How to contribute

- **Bug reports & feature requests** — [Open an issue](https://github.com/hidemi-ito/open-responses-proxy/issues). Please include steps to reproduce for bugs, and a clear use case for feature requests.
- **Questions & discussion** — Issues are fine for questions too. There are no dumb questions.
- **Pull requests** — Fork the repo, create a branch, and send a PR. For larger changes, opening an issue to discuss the approach beforehand saves everyone time.
- **New provider adapters** — Implementing a new backend (Gemini, Mistral, Cohere, etc.) is one of the most impactful contributions. See [Adding a model](#adding-a-model) and the existing adapters in `lib/providers/` for guidance.

### Good first issues

The [In progress / planned](#in-progress--planned) section lists known gaps that are well-scoped and ready to pick up. Items marked with `[ ]` don't have an owner yet.

### Development setup

```bash
npm install
npm run db:push   # requires DATABASE_URL in .env.local
npm run dev
npm test
```

This project is built together by everyone who uses it. All contributions — no matter how small — are appreciated.

---

## License

MIT
