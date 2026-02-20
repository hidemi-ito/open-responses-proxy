# Open Responses API — 詳細設計書

## 1. 概要

OpenAI Responses API と完全互換のエンドポイントを Next.js App Router で提供する。
バックエンド推論として以下の2モデルを提供する。

| 公開モデル ID               | バックエンド           | アダプター               |
|-----------------------------|------------------------|--------------------------|
| `gpt-oss-20b-responses`     | vLLM/OpenAI-compatible | `OpenAICompatibleAdapter` |
| `claude-opus-4-6-responses` | Anthropic Messages API | `AnthropicAdapter`        |

OpenAI Agents SDK の `baseURL` を差し替えるだけで同一コードが動くことを受け入れ条件とする。

---

## 2. ディレクトリ構成

```
responses/
├── app/
│   └── v1/
│       ├── responses/
│       │   ├── route.ts                          # POST /v1/responses
│       │   ├── compact/route.ts                  # POST /v1/responses/compact
│       │   └── [id]/
│       │       ├── route.ts                      # GET, DELETE /v1/responses/{id}
│       │       └── cancel/route.ts               # POST /v1/responses/{id}/cancel
│       ├── models/
│       │   ├── route.ts                          # GET /v1/models
│       │   └── [model]/route.ts                  # GET /v1/models/{model}
│       ├── files/
│       │   ├── route.ts                          # GET, POST /v1/files
│       │   └── [file_id]/
│       │       ├── route.ts                      # GET, DELETE /v1/files/{id}
│       │       └── content/route.ts              # GET /v1/files/{id}/content
│       ├── vector_stores/
│       │   ├── route.ts                          # GET, POST /v1/vector_stores
│       │   └── [vs_id]/
│       │       ├── route.ts                      # GET, POST, DELETE
│       │       ├── search/route.ts               # POST /v1/vector_stores/{id}/search
│       │       ├── files/
│       │       │   ├── route.ts                  # GET, POST
│       │       │   └── [file_id]/route.ts        # GET, DELETE
│       │       └── file_batches/
│       │           ├── route.ts                  # POST
│       │           └── [batch_id]/
│       │               ├── route.ts              # GET
│       │               ├── cancel/route.ts       # POST
│       │               └── files/route.ts        # GET
│       ├── images/
│       │   ├── generations/route.ts
│       │   ├── edits/route.ts
│       │   └── variations/route.ts
│       └── chat/completions/route.ts             # POST /v1/chat/completions (互換)
├── lib/
│   ├── openresponses/
│   │   ├── ids.ts          # ID 生成 (resp_, msg_, fc_, fco_, vs_, file_)
│   │   ├── errors.ts       # HTTP エラーレスポンス構築
│   │   ├── sse.ts          # SSE フォーマット (event: + data: + [DONE])
│   │   ├── response.ts     # ResponseObject / MessageItem 型と生成関数
│   │   └── schema.ts       # Zod バリデーションスキーマ
│   ├── db/
│   │   ├── client.ts       # Drizzle ORM + postgres ドライバ
│   │   └── schema.ts       # テーブル定義
│   ├── storage/
│   │   └── client.ts       # S3-compatible blob (ファイルアップロード用)
│   ├── auth/
│   │   └── index.ts        # Bearer token 検証
│   ├── providers/
│   │   ├── types.ts        # ProviderAdapter インターフェース・内部イベント型
│   │   ├── resolver.ts     # モデル名 → アダプター解決
│   │   ├── anthropic/index.ts        # Claude アダプター
│   │   └── openai-compatible/index.ts # gpt-oss / vLLM アダプター
│   └── orchestrator/
│       └── index.ts        # ResponsesRequest → SSE events / ResponseObject
└── docs/
    ├── DESIGN.md
    └── API_REFERENCE.md
```

---

## 3. モデルルーティング

```
POST /v1/responses
  body.model = "gpt-oss-20b-responses"
    → OpenAICompatibleAdapter
       OPENAI_COMPAT_BASE_URL (e.g. http://vllm:8000/v1)
       underlying model: "gpt-oss-20b"

  body.model = "claude-opus-4-6-responses"
    → AnthropicAdapter
       ANTHROPIC_API_KEY
       underlying model: "claude-opus-4-6"
```

モデル名から `-responses` サフィックスを除去し、残った文字列でプロバイダーを判定する。
新しいモデルの追加は `lib/providers/resolver.ts` の `PROVIDER_MAP` だけ更新すればよい。

---

## 4. Provider Adapter インターフェース

```typescript
// lib/providers/types.ts

export interface ProviderEvent {
  type:
    | "text_delta"          // テキストチャンク
    | "tool_call_start"     // function_call 開始
    | "tool_call_delta"     // arguments の差分
    | "tool_call_done"      // function_call 完了
    | "message_done";       // 推論終了
  // type ごとのフィールドは各型定義参照
}

export interface ProviderAdapter {
  /** このアダプターが扱う underlying model 名の配列 */
  readonly models: readonly string[];

  /** ストリーミングなし (Promise<ProviderFinalResult>) */
  chat(req: ProviderChatRequest): Promise<ProviderFinalResult>;

  /** ストリーミングあり (AsyncGenerator<ProviderEvent>) */
  chatStream(req: ProviderChatRequest): AsyncIterable<ProviderEvent>;
}
```

---

## 5. Orchestrator の処理フロー

### 5.1 非ストリーミング

```
parse & validate request
  → resolve adapter
  → build messages (input items + previous_response_id 解決)
  → adapter.chat()
  → map ProviderFinalResult → ResponseObject
  → if store: db.insertResponse()
  → return JSON
```

### 5.2 ストリーミング (SSE)

```
parse & validate request
  → resolve adapter
  → build messages
  → open SSE stream (ReadableStream)
  → emit response.in_progress
  → for await event of adapter.chatStream():
      "text_delta"       → response.output_text.delta
      "tool_call_start"  → response.output_item.added (function_call)
      "tool_call_delta"  → (accumulate arguments)
      "tool_call_done"   → response.output_item.done (function_call)
      "message_done"     → response.output_item.done (message) + response.completed
  → emit [DONE]
  → if store: db.upsertResponse()
  → request.signal aborted → close stream, cleanup
```

### 5.3 previous_response_id の解決

```
if request.previous_response_id:
  prev = db.getResponse(request.previous_response_id)
  if !prev.store: 404
  messages = prev.input_items + prev.output_items + request.input_items
else:
  messages = request.input_items
```

### 5.4 Function tools (client-driven)

サーバーはモデルが返した `function_call` をそのまま output items に含めて返す。
クライアントが tool を実行し、`function_call_output` items を次のリクエストの `input` に含める。
サーバー側にオーケストレーションループは不要（1リクエスト = 1モデル呼び出し）。

---

## 6. SSE イベントシーケンス（テキスト応答の例）

```
event: response.in_progress
data: {"type":"response.in_progress","sequence_number":1,"response_id":"resp_xxx"}

event: response.output_item.added
data: {"type":"response.output_item.added","sequence_number":2,"output_index":0,
       "item":{"type":"message","id":"msg_xxx","status":"in_progress","role":"assistant","content":[]}}

event: response.content_part.added
data: {"type":"response.content_part.added","sequence_number":3,"item_id":"msg_xxx",
       "output_index":0,"content_index":0,"part":{"type":"output_text","annotations":[],"text":""}}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":4,"item_id":"msg_xxx",
       "output_index":0,"content_index":0,"delta":"Hello","logprobs":[],"obfuscation":""}

  ... (複数 delta) ...

event: response.output_text.done
data: {"type":"response.output_text.done","sequence_number":N,"item_id":"msg_xxx",
       "output_index":0,"content_index":0,"text":"<full text>","logprobs":[],"obfuscation":""}

event: response.content_part.done
data: {"type":"response.content_part.done","sequence_number":N+1,...}

event: response.output_item.done
data: {"type":"response.output_item.done","sequence_number":N+2,"output_index":0,
       "item":{"type":"message","id":"msg_xxx","status":"completed",...}}

event: response.completed
data: {"type":"response.completed","sequence_number":N+3,"response_id":"resp_xxx"}

data: [DONE]
```

function_call が発生した場合は `response.output_item.added/done` が追加で発火する。

---

## 7. データベーススキーマ

### 7.1 `responses` テーブル

| カラム              | 型        | 説明                                          |
|---------------------|-----------|-----------------------------------------------|
| id                  | text PK   | "resp_" + UUID                                |
| status              | text      | queued / in_progress / completed / failed / cancelled / incomplete |
| model               | text      | リクエストのモデル名 (e.g. "gpt-oss-20b-responses") |
| instructions        | text?     | system prompt                                 |
| input_items_json    | jsonb     | 入力 items (正規化済み)                       |
| output_items_json   | jsonb     | 出力 items                                    |
| tools_json          | jsonb     | tool 定義                                     |
| tool_choice_json    | jsonb     | tool_choice 値                                |
| usage_json          | jsonb     | トークン使用量                                |
| metadata_json       | jsonb     | ユーザー指定メタデータ                        |
| store               | boolean   | 永続化フラグ                                  |
| background          | boolean   | バックグラウンド実行フラグ                    |
| previous_response_id| text?     | 前ターン response ID                          |
| truncation          | text      | "auto" / "disabled"                           |
| temperature         | float4?   |                                               |
| top_p               | float4?   |                                               |
| max_output_tokens   | int4?     |                                               |
| error_json          | jsonb?    | エラー情報                                    |
| created_at          | int4      | Unix timestamp                                |
| completed_at        | int4?     |                                               |
| cancelled_at        | int4?     |                                               |

### 7.2 `files` テーブル

| カラム     | 型       |
|------------|----------|
| id         | text PK  |
| purpose    | text     |
| filename   | text     |
| bytes      | int8     |
| mime_type  | text     |
| sha256     | text     |
| blob_key   | text     | S3 キー
| created_at | int4     |

### 7.3 `vector_stores` テーブル

| カラム      | 型       |
|-------------|----------|
| id          | text PK  |
| name        | text?    |
| status      | text     | in_progress / completed / expired
| file_counts | jsonb    |
| expires_at  | int4?    |
| metadata    | jsonb    |
| created_at  | int4     |

---

## 8. 環境変数

```bash
# 認証
API_KEYS="key1,key2"          # カンマ区切りの有効 Bearer token リスト

# Anthropic
ANTHROPIC_API_KEY=sk-ant-xxx

# gpt-oss (OpenAI-compatible endpoint)
GPT_OSS_BASE_URL=http://localhost:8000/v1   # vLLM/Ollama 等
GPT_OSS_API_KEY=token                       # 任意 (vLLM は空でも可)

# PostgreSQL
DATABASE_URL=postgres://user:pass@host:5432/dbname

# S3-compatible blob storage
S3_ENDPOINT=https://s3.amazonaws.com
S3_BUCKET=responses-files
S3_ACCESS_KEY_ID=xxx
S3_SECRET_ACCESS_KEY=xxx
S3_REGION=us-east-1
```

---

## 9. エラー形式

OpenAI 互換のエラー形式を返す。

```json
{
  "error": {
    "message": "Human-readable description",
    "type": "invalid_request_error",
    "param": "field_name",
    "code": "optional_code"
  }
}
```

| HTTP  | type                  | 用途                             |
|-------|-----------------------|----------------------------------|
| 400   | invalid_request_error | バリデーション失敗               |
| 401   | unauthorized          | 認証失敗                         |
| 404   | not_found             | リソース未存在                   |
| 409   | conflict              | 状態競合 (cancel 済みを再 cancel 等) |
| 429   | rate_limit_error      | レートリミット超過               |
| 500   | server_error          | 内部エラー                       |
| 501   | not_implemented       | 未実装機能 (built-in tools 等)   |

ストリーミング中のエラーは `response.error` イベントを emit してから `[DONE]` で終端する。

---

## 10. 実装フェーズ

### Phase 1 (本ファイルで実装)
- [x] POST /v1/responses (sync + SSE + function tools client-driven)
- [x] GET, DELETE /v1/responses/{id}
- [x] POST /v1/responses/{id}/cancel
- [x] POST /v1/responses/compact
- [x] GET /v1/models, GET /v1/models/{model}
- [x] AnthropicAdapter (Claude claude-opus-4-6)
- [x] OpenAICompatibleAdapter (gpt-oss-20b)
- [x] DB 永続化 (store / previous_response_id)

### Phase 2 (stub 実装済み、拡張予定)
- [ ] POST /v1/files, /v1/files/{id}/content 等
- [ ] Vector Stores API + file_batches
- [ ] built-in tools: web_search (検索 API 統合)
- [ ] built-in tools: file_search (pgvector RAG)
- [ ] built-in tools: code_interpreter (Docker sandbox)
- [ ] built-in tools: image_generation (Stable Diffusion / 外部 API)
- [ ] built-in tools: computer_use (Playwright)
- [ ] POST /v1/chat/completions 互換
- [ ] Images API
- [ ] レートリミット (Redis/Upstash)
- [ ] 監査ログ・コスト追跡
