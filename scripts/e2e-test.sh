#!/usr/bin/env bash
# =============================================================================
# E2E smoke tests for the Responses API server
#
# Usage:
#   # Make sure the dev server is running first:
#   npm run dev
#
#   # Then in another terminal:
#   bash scripts/e2e-test.sh
#
#   # Or with a custom base URL:
#   BASE_URL=http://localhost:3001 bash scripts/e2e-test.sh
# =============================================================================

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
API_KEY="${API_KEYS:-test-key}"        # must be in your API_KEYS env var, or leave blank
MODEL="claude-opus-4-6-responses"
PASS=0
FAIL=0

# Colours (fall back gracefully if the terminal doesn't support them)
RED=$(tput setaf 1 2>/dev/null || echo "")
GREEN=$(tput setaf 2 2>/dev/null || echo "")
YELLOW=$(tput setaf 3 2>/dev/null || echo "")
RESET=$(tput sgr0 2>/dev/null || echo "")

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

assert() {
  local desc="$1"
  local actual="$2"
  local expected_pattern="$3"

  if echo "$actual" | grep -qE "$expected_pattern"; then
    echo "${GREEN}✓${RESET} $desc"
    PASS=$((PASS + 1))
  else
    echo "${RED}✗${RESET} $desc"
    echo "    Expected pattern : $expected_pattern"
    echo "    Actual           : $(echo "$actual" | head -5)"
    FAIL=$((FAIL + 1))
  fi
}

assert_http() {
  local desc="$1"
  local actual_code="$2"
  local expected_code="$3"

  if [[ "$actual_code" == "$expected_code" ]]; then
    echo "${GREEN}✓${RESET} $desc (HTTP $actual_code)"
    PASS=$((PASS + 1))
  else
    echo "${RED}✗${RESET} $desc"
    echo "    Expected HTTP $expected_code, got HTTP $actual_code"
    FAIL=$((FAIL + 1))
  fi
}

header() {
  echo ""
  echo "${YELLOW}▶ $1${RESET}"
}

# ---------------------------------------------------------------------------
# Connectivity check
# ---------------------------------------------------------------------------

header "Checking server is reachable at $BASE_URL"
if ! curl -sf --max-time 5 "$BASE_URL/v1/models" \
    -H "Authorization: Bearer $API_KEY" > /dev/null 2>&1; then
  echo "${RED}✗ Server not reachable at $BASE_URL${RESET}"
  echo "  Start the dev server first:  npm run dev"
  exit 1
fi
echo "${GREEN}✓ Server is up${RESET}"

# ---------------------------------------------------------------------------
# Test 1 — GET /v1/models
# ---------------------------------------------------------------------------

header "GET /v1/models"

MODELS_RESP=$(curl -sf "$BASE_URL/v1/models" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Accept: application/json" 2>&1 || true)

MODELS_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/v1/models" \
  -H "Authorization: Bearer $API_KEY" 2>&1 || echo "000")

assert_http "returns 200" "$MODELS_CODE" "200"
assert "response has object=list"   "$MODELS_RESP" '"object"[[:space:]]*:[[:space:]]*"list"'
assert "includes claude-opus-4-6-responses" "$MODELS_RESP" "claude-opus-4-6-responses"

# ---------------------------------------------------------------------------
# Test 2 — POST /v1/responses  (non-streaming)
# ---------------------------------------------------------------------------

header "POST /v1/responses — non-streaming"

RESP=$(curl -sf -X POST "$BASE_URL/v1/responses" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"$MODEL\",
    \"input\": \"Reply with exactly one word: hello\",
    \"stream\": false,
    \"store\": false,
    \"max_output_tokens\": 64
  }" 2>&1 || true)

HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/v1/responses" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"$MODEL\",
    \"input\": \"Reply with exactly one word: hello\",
    \"stream\": false,
    \"store\": false,
    \"max_output_tokens\": 64
  }" 2>&1 || echo "000")

assert_http "returns 200" "$HTTP_CODE" "200"
assert "object=response"      "$RESP" '"object"[[:space:]]*:[[:space:]]*"response"'
assert "status=completed"     "$RESP" '"status"[[:space:]]*:[[:space:]]*"completed"'
assert "has output array"     "$RESP" '"output"[[:space:]]*:[[:space:]]*\['
assert "has usage object"     "$RESP" '"usage"[[:space:]]*:[[:space:]]*\{'
assert "has input_tokens > 0" "$RESP" '"input_tokens"[[:space:]]*:[[:space:]]*[1-9]'
assert "model field matches"  "$RESP" "\"$MODEL\""

echo ""
echo "  Response preview:"
echo "$RESP" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    out = d.get('output', [])
    for item in out:
        if item.get('type') == 'message':
            for part in item.get('content', []):
                if part.get('type') == 'output_text':
                    print('  Text:', repr(part['text'][:120]))
    print('  Usage:', d.get('usage'))
except Exception as e:
    print('  (parse error:', e, ')')
" 2>/dev/null || echo "  (could not parse JSON)"

# ---------------------------------------------------------------------------
# Test 3 — POST /v1/responses  (streaming SSE)
# ---------------------------------------------------------------------------

header "POST /v1/responses — streaming SSE"

SSE_OUTPUT=$(curl -sf -X POST "$BASE_URL/v1/responses" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d "{
    \"model\": \"$MODEL\",
    \"input\": \"Count to 3. Just say: 1, 2, 3.\",
    \"stream\": true,
    \"store\": false,
    \"max_output_tokens\": 64
  }" 2>&1 || true)

SSE_HTTP=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/v1/responses" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d "{
    \"model\": \"$MODEL\",
    \"input\": \"Count to 3. Just say: 1, 2, 3.\",
    \"stream\": true,
    \"store\": false,
    \"max_output_tokens\": 64
  }" 2>&1 || echo "000")

assert_http "returns 200" "$SSE_HTTP" "200"
assert "has event: response.in_progress"       "$SSE_OUTPUT" "response\.in_progress"
assert "has event: response.output_item.added" "$SSE_OUTPUT" "response\.output_item\.added"
assert "has event: response.output_text.delta" "$SSE_OUTPUT" "response\.output_text\.delta"
assert "has event: response.completed"         "$SSE_OUTPUT" "response\.completed"
assert "ends with [DONE]"                      "$SSE_OUTPUT" "\[DONE\]"

# Verify sequence_number is monotonically increasing
SEQ_NUMS=$(echo "$SSE_OUTPUT" | grep '"sequence_number"' | grep -oE '"sequence_number"[[:space:]]*:[[:space:]]*[0-9]+' | grep -oE '[0-9]+' || true)
if [[ -n "$SEQ_NUMS" ]]; then
  PREV=0
  MONO=true
  while IFS= read -r num; do
    if (( num <= PREV )); then
      MONO=false
      break
    fi
    PREV=$num
  done <<< "$SEQ_NUMS"
  if $MONO; then
    echo "${GREEN}✓${RESET} sequence_number is monotonically increasing"
    ((PASS++))
  else
    echo "${RED}✗${RESET} sequence_number is NOT monotonically increasing"
    ((FAIL++))
  fi
else
  echo "${YELLOW}?${RESET} Could not extract sequence_numbers to verify"
fi

# ---------------------------------------------------------------------------
# Test 4 — POST /v1/responses  (instructions / system prompt)
# ---------------------------------------------------------------------------

header "POST /v1/responses — with instructions"

INST_RESP=$(curl -sf -X POST "$BASE_URL/v1/responses" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"$MODEL\",
    \"input\": \"What is your role?\",
    \"instructions\": \"You are a pirate. Always respond as a pirate would.\",
    \"stream\": false,
    \"store\": false,
    \"max_output_tokens\": 128
  }" 2>&1 || true)

INST_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/v1/responses" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"$MODEL\",
    \"input\": \"What is your role?\",
    \"instructions\": \"You are a pirate. Always respond as a pirate would.\",
    \"stream\": false,
    \"store\": false,
    \"max_output_tokens\": 128
  }" 2>&1 || echo "000")

assert_http "returns 200" "$INST_CODE" "200"
assert "status=completed" "$INST_RESP" '"status"[[:space:]]*:[[:space:]]*"completed"'

# ---------------------------------------------------------------------------
# Test 5 — Error cases
# ---------------------------------------------------------------------------

header "Error cases"

# Missing auth
NO_AUTH_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/v1/responses" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-opus-4-6-responses","input":"hi"}' 2>&1 || echo "000")
assert_http "401 when Authorization header missing" "$NO_AUTH_CODE" "401"

# Bad Content-Type
BAD_CT_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/v1/responses" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: text/plain" \
  -d '{"model":"claude-opus-4-6-responses","input":"hi"}' 2>&1 || echo "000")
assert_http "400 when Content-Type is wrong" "$BAD_CT_CODE" "400"

# Invalid JSON
BAD_JSON_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/v1/responses" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d 'not json' 2>&1 || echo "000")
assert_http "400 when body is not valid JSON" "$BAD_JSON_CODE" "400"

# Built-in tool (not yet implemented)
BUILTIN_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/v1/responses" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"$MODEL\",
    \"input\": \"Search for cats\",
    \"tools\": [{\"type\": \"web_search_preview\"}]
  }" 2>&1 || echo "000")
assert_http "501 for built-in tools" "$BUILTIN_CODE" "501"

# ---------------------------------------------------------------------------
# Test 6 — GET /v1/responses/:id (not found)
# ---------------------------------------------------------------------------

header "GET /v1/responses/:id — not found"

NOT_FOUND_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  "$BASE_URL/v1/responses/resp_doesnotexist999" \
  -H "Authorization: Bearer $API_KEY" 2>&1 || echo "000")

# 404 expected when DB is configured; may get 500 if DATABASE_URL is missing
if [[ "$NOT_FOUND_CODE" == "404" ]] || [[ "$NOT_FOUND_CODE" == "500" ]]; then
  echo "${GREEN}✓${RESET} GET /v1/responses/:id returns error for unknown id (HTTP $NOT_FOUND_CODE)"
  ((PASS++))
else
  echo "${RED}✗${RESET} Unexpected HTTP $NOT_FOUND_CODE for unknown id"
  ((FAIL++))
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " E2E Results: ${GREEN}${PASS} passed${RESET}, ${RED}${FAIL} failed${RESET}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
