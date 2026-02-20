# Open Responses API Reference

This document describes the OpenAI Responses API-compatible endpoints provided by this server.

---

## Authentication

All endpoints require a Bearer token in the `Authorization` header:

```
Authorization: Bearer <your-api-key>
```

Valid tokens are configured via the `API_KEYS` environment variable (comma-separated list). If `API_KEYS` is not set, all tokens are accepted (development mode).

---

## Models

### GET /v1/models

List all available models.

**Response:**

```json
{
  "object": "list",
  "data": [
    {
      "id": "gpt-oss-20b-responses",
      "object": "model",
      "created": 1700000000,
      "owned_by": "openai"
    },
    {
      "id": "claude-opus-4-6-responses",
      "object": "model",
      "created": 1700000000,
      "owned_by": "anthropic"
    }
  ]
}
```

### GET /v1/models/{model}

Retrieve a specific model.

**Path parameters:**
- `model` (string, required): The model ID.

**Response:** A single model object, or 404 if not found.

**Available models:**

| Model ID | Backend | Underlying Model |
|---|---|---|
| `gpt-oss-20b-responses` | vLLM / OpenAI-compatible | `gpt-oss-20b` |
| `claude-opus-4-6-responses` | Anthropic Messages API | `claude-opus-4-6` |

---

## Responses

### POST /v1/responses

Create a model response. Supports both synchronous and streaming modes.

**Request body:**

| Field | Type | Default | Description |
|---|---|---|---|
| `model` | string | (required) | Model ID (e.g. `gpt-oss-20b-responses`) |
| `input` | string \| InputItem[] | (required) | User input: a string or array of input items |
| `stream` | boolean | `false` | Enable SSE streaming |
| `instructions` | string \| null | `null` | System prompt / instructions |
| `previous_response_id` | string \| null | `null` | ID of a stored response to continue from |
| `tools` | Tool[] | `[]` | Tool definitions (function, web_search_preview, etc.) |
| `tool_choice` | string \| object | `"auto"` | `"auto"`, `"required"`, `"none"`, or `{ type: "function", name: "..." }` |
| `temperature` | number \| null | `null` | Sampling temperature (0-2) |
| `top_p` | number \| null | `null` | Nucleus sampling (0-1) |
| `max_output_tokens` | integer \| null | `null` | Maximum tokens in response |
| `store` | boolean | `true` | Persist response for later retrieval |
| `background` | boolean | `false` | Run in background |
| `metadata` | object | `{}` | User-defined key-value metadata |
| `truncation` | string | `"disabled"` | `"auto"` or `"disabled"` |
| `parallel_tool_calls` | boolean | `true` | Allow parallel tool calls |
| `text` | object | `{ format: { type: "text" } }` | Output text format settings |
| `reasoning` | object \| null | `null` | Reasoning effort settings |

**Input item types:**

```json
// Message item
{ "type": "message", "role": "user", "content": "Hello" }

// Message with structured content
{ "type": "message", "role": "user", "content": [
  { "type": "input_text", "text": "Describe this image" },
  { "type": "input_image", "image_url": "https://..." }
]}

// Function call (from a prior assistant turn)
{ "type": "function_call", "call_id": "fc_xxx", "name": "get_weather", "arguments": "{\"location\":\"Tokyo\"}" }

// Function call output (client providing tool result)
{ "type": "function_call_output", "call_id": "fc_xxx", "output": "{\"temp\":20}" }
```

**Non-streaming response:**

```json
{
  "id": "resp_abc123",
  "object": "response",
  "created_at": 1700000000,
  "status": "completed",
  "model": "gpt-oss-20b-responses",
  "output": [
    {
      "type": "message",
      "id": "msg_abc123",
      "status": "completed",
      "role": "assistant",
      "content": [
        { "type": "output_text", "text": "Hello! How can I help?", "annotations": [] }
      ]
    }
  ],
  "usage": {
    "input_tokens": 10,
    "output_tokens": 8,
    "total_tokens": 18
  },
  "tool_choice": "auto",
  "tools": [],
  "parallel_tool_calls": true,
  "instructions": null,
  "previous_response_id": null,
  "temperature": null,
  "top_p": null,
  "max_output_tokens": null,
  "truncation": "disabled",
  "metadata": {},
  "error": null,
  "incomplete_details": null,
  "text": { "format": { "type": "text" } },
  "reasoning": null,
  "store": true,
  "background": false
}
```

**Streaming response (SSE):** See [SSE Streaming Events](#sse-streaming-events) below.

### GET /v1/responses/{id}

Retrieve a stored response by ID.

**Path parameters:**
- `id` (string, required): The response ID (e.g. `resp_abc123`).

**Response:** The full response object, or 404 if not found.

### DELETE /v1/responses/{id}

Delete a stored response.

**Path parameters:**
- `id` (string, required): The response ID.

**Response:**

```json
{
  "id": "resp_abc123",
  "object": "response",
  "deleted": true
}
```

### POST /v1/responses/{id}/cancel

Cancel an in-progress response.

**Path parameters:**
- `id` (string, required): The response ID.

**Response:** The response object with `status: "cancelled"`.

Only responses with status `in_progress` or `queued` can be cancelled. Returns 409 for responses in other states.

### POST /v1/responses/compact

Create a compacted (summarized) response from a previous response. Returns 501 if the compact feature is not yet implemented.

---

## Files

### POST /v1/files

Upload a file.

**Request:** `multipart/form-data` with fields:
- `file` (file, required): The file to upload.
- `purpose` (string, required): The intended purpose (e.g. `"assistants"`, `"fine-tune"`).

**Response:**

```json
{
  "id": "file_abc123",
  "object": "file",
  "bytes": 12345,
  "created_at": 1700000000,
  "filename": "data.jsonl",
  "purpose": "assistants"
}
```

### GET /v1/files

List uploaded files.

**Response:**

```json
{
  "object": "list",
  "data": [{ "id": "file_abc123", "object": "file", ... }]
}
```

### GET /v1/files/{file_id}

Retrieve file metadata.

**Path parameters:**
- `file_id` (string, required): The file ID.

### DELETE /v1/files/{file_id}

Delete a file (metadata and blob storage).

**Response:**

```json
{
  "id": "file_abc123",
  "object": "file",
  "deleted": true
}
```

### GET /v1/files/{file_id}/content

Download file content. Returns a 302 redirect to a presigned S3 URL.

---

## Chat Completions

### POST /v1/chat/completions

OpenAI Chat Completions-compatible endpoint. Translates requests to the underlying provider adapters.

**Request body:**

| Field | Type | Description |
|---|---|---|
| `model` | string | Model ID |
| `messages` | Message[] | Array of chat messages |
| `stream` | boolean | Enable SSE streaming |
| `tools` | Tool[] | Function tool definitions |
| `tool_choice` | string \| object | Tool selection strategy |
| `temperature` | number | Sampling temperature |
| `max_tokens` | integer | Max tokens |
| `top_p` | number | Nucleus sampling |

**Non-streaming response:**

```json
{
  "id": "chatcmpl-msg_abc123",
  "object": "chat.completion",
  "created": 1700000000,
  "model": "gpt-oss-20b-responses",
  "choices": [
    {
      "index": 0,
      "message": { "role": "assistant", "content": "Hello!" },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 10,
    "completion_tokens": 5,
    "total_tokens": 15
  }
}
```

**Streaming response:** SSE chunks with `object: "chat.completion.chunk"`.

---

## Vector Stores (Phase 2)

All Vector Stores endpoints return `501 Not Implemented`.

| Method | Endpoint |
|---|---|
| GET, POST | /v1/vector_stores |
| GET, POST, DELETE | /v1/vector_stores/{vs_id} |
| POST | /v1/vector_stores/{vs_id}/search |
| GET, POST | /v1/vector_stores/{vs_id}/files |
| GET, DELETE | /v1/vector_stores/{vs_id}/files/{file_id} |
| POST | /v1/vector_stores/{vs_id}/file_batches |
| GET | /v1/vector_stores/{vs_id}/file_batches/{batch_id} |
| POST | /v1/vector_stores/{vs_id}/file_batches/{batch_id}/cancel |
| GET | /v1/vector_stores/{vs_id}/file_batches/{batch_id}/files |

---

## Images (Phase 2)

All Images endpoints return `501 Not Implemented`.

| Method | Endpoint |
|---|---|
| POST | /v1/images/generations |
| POST | /v1/images/edits |
| POST | /v1/images/variations |

---

## SSE Streaming Events

When `stream: true` is set on `POST /v1/responses`, the server returns a `text/event-stream` response with the following events:

### response.in_progress

Emitted when the response starts processing.

```
event: response.in_progress
data: {"type":"response.in_progress","sequence_number":1,"response":{"id":"resp_xxx","status":"in_progress"}}
```

### response.output_item.added

Emitted when a new output item (message or function_call) begins.

```
event: response.output_item.added
data: {"type":"response.output_item.added","sequence_number":2,"output_index":0,"item":{"type":"message","id":"msg_xxx","status":"in_progress","role":"assistant","content":[]}}
```

### response.content_part.added

Emitted when a content part is added to a message.

```
event: response.content_part.added
data: {"type":"response.content_part.added","sequence_number":3,"item_id":"msg_xxx","output_index":0,"content_index":0,"part":{"type":"output_text","annotations":[],"text":""}}
```

### response.output_text.delta

Emitted for each text chunk.

```
event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":4,"item_id":"msg_xxx","output_index":0,"content_index":0,"delta":"Hello"}
```

### response.output_text.done

Emitted when text generation is complete.

```
event: response.output_text.done
data: {"type":"response.output_text.done","sequence_number":N,"item_id":"msg_xxx","output_index":0,"content_index":0,"text":"<full text>"}
```

### response.content_part.done

Emitted when a content part is finalized.

### response.output_item.done

Emitted when an output item is finalized.

### response.completed

Emitted when the entire response is complete. Contains the full response object.

```
event: response.completed
data: {"type":"response.completed","sequence_number":N,"response":{...full response object...}}
```

### response.failed

Emitted if the response fails. Contains the response object with error details.

### End sentinel

```
data: [DONE]
```

---

## Error Codes

All errors follow this format:

```json
{
  "error": {
    "message": "Human-readable description",
    "type": "error_type",
    "param": "field_name",
    "code": "optional_code"
  }
}
```

| HTTP Status | Type | Description |
|---|---|---|
| 400 | `invalid_request_error` | Validation failure |
| 401 | `unauthorized` | Authentication failure |
| 404 | `not_found` | Resource does not exist |
| 409 | `conflict` | State conflict (e.g. cancelling a completed response) |
| 429 | `rate_limit_error` | Rate limit exceeded |
| 500 | `server_error` | Internal server error |
| 501 | `not_implemented` | Feature not yet implemented |

---

## Quick Start

### Basic request (non-streaming)

```bash
curl -X POST http://localhost:3000/v1/responses \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-oss-20b-responses",
    "input": "What is the capital of France?"
  }'
```

### Streaming request

```bash
curl -X POST http://localhost:3000/v1/responses \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-opus-4-6-responses",
    "input": "Write a haiku about programming",
    "stream": true
  }'
```

### Function tools

```bash
curl -X POST http://localhost:3000/v1/responses \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-oss-20b-responses",
    "input": "What is the weather in Tokyo?",
    "tools": [
      {
        "type": "function",
        "name": "get_weather",
        "description": "Get current weather for a location",
        "parameters": {
          "type": "object",
          "properties": {
            "location": { "type": "string" }
          },
          "required": ["location"]
        }
      }
    ]
  }'
```

### Conversation continuation (previous_response_id)

```bash
# First request (store=true by default)
RESP_ID=$(curl -s -X POST http://localhost:3000/v1/responses \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{"model": "gpt-oss-20b-responses", "input": "My name is Alice."}' \
  | jq -r '.id')

# Follow-up using previous_response_id
curl -X POST http://localhost:3000/v1/responses \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"gpt-oss-20b-responses\",
    \"input\": \"What is my name?\",
    \"previous_response_id\": \"$RESP_ID\"
  }"
```

### Chat Completions (OpenAI SDK compatible)

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-oss-20b-responses",
    "messages": [
      { "role": "user", "content": "Hello!" }
    ]
  }'
```

### List models

```bash
curl http://localhost:3000/v1/models \
  -H "Authorization: Bearer your-api-key"
```

### Upload a file

```bash
curl -X POST http://localhost:3000/v1/files \
  -H "Authorization: Bearer your-api-key" \
  -F "file=@data.jsonl" \
  -F "purpose=assistants"
```
