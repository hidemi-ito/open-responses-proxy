export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { ResponsesRequestSchema } from "@/lib/openresponses/schema";
import { requireAuth, isAuthError } from "@/lib/auth";
import { runResponse } from "@/lib/orchestrator";
import { badRequest, serverError } from "@/lib/openresponses/errors";

/**
 * POST /v1/responses/compact
 *
 * Creates a compacted conversation: resolves previous_response_id, merges
 * the history, then runs a new response. For Phase 1 this behaves identically
 * to POST /v1/responses with the constraint that previous_response_id is
 * required.
 */
export async function POST(req: Request): Promise<Response> {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;

  const ct = req.headers.get("content-type") ?? "";
  if (!ct.toLowerCase().includes("application/json")) {
    return badRequest("Content-Type must be application/json", "content-type");
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest("Invalid JSON body");
  }

  // previous_response_id is required for /compact
  if (
    typeof body !== "object" ||
    body === null ||
    !("previous_response_id" in body) ||
    !(body as Record<string, unknown>).previous_response_id
  ) {
    return badRequest(
      "previous_response_id is required for the compact endpoint.",
      "previous_response_id",
    );
  }

  const parsed = ResponsesRequestSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return badRequest(
      issue?.message ?? "Invalid request body",
      issue?.path.join(".") || null,
    );
  }

  try {
    return await runResponse(parsed.data, req.signal);
  } catch (e) {
    if (e instanceof Response) return e;
    console.error("compact runResponse error:", e);
    return serverError();
  }
}
