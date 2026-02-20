export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { responses } from "@/lib/db/schema";
import { requireAuth, isAuthError } from "@/lib/auth";
import { notFound, conflict, serverError } from "@/lib/openresponses/errors";
import type { ResponseObject, Usage, OutputItem } from "@/lib/openresponses/response";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /v1/responses/{id}/cancel
 *
 * Cancels an in-progress response. Returns 409 if the response is already
 * completed/cancelled/failed, or if it was not stored.
 */
export async function POST(
  req: NextRequest,
  ctx: RouteContext,
): Promise<Response> {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;

  const { id } = await ctx.params;

  try {
    const rows = await db
      .select()
      .from(responses)
      .where(eq(responses.id, id))
      .limit(1);

    const row = rows[0];
    if (!row) return notFound(`Response '${id}' not found.`);

    if (!row.store) {
      return conflict("Cannot cancel a response that was not stored.");
    }

    const cancellableStatuses = new Set(["queued", "in_progress"]);
    if (!cancellableStatuses.has(row.status)) {
      return conflict(
        `Response '${id}' has status '${row.status}' and cannot be cancelled.`,
      );
    }

    const now = Math.floor(Date.now() / 1000);
    await db
      .update(responses)
      .set({
        status: "cancelled",
        cancelledAt: now,
      })
      .where(eq(responses.id, id));

    // Return the updated response object
    const responseObj: ResponseObject = {
      id: row.id,
      object: "response",
      created_at: row.createdAt,
      status: "cancelled",
      model: row.model,
      output: (row.outputItemsJson as OutputItem[]) ?? [],
      tool_choice: row.toolChoiceJson ?? "auto",
      tools: (row.toolsJson as unknown[]) ?? [],
      parallel_tool_calls: row.parallelToolCalls ?? true,
      instructions: row.instructions ?? null,
      previous_response_id: row.previousResponseId ?? null,
      temperature: row.temperature ?? null,
      top_p: row.topP ?? null,
      max_output_tokens: row.maxOutputTokens ?? null,
      truncation: row.truncation ?? "disabled",
      metadata: (row.metadata as Record<string, string>) ?? {},
      usage: (row.usageJson as Usage) ?? null,
      error: row.errorJson ?? null,
      incomplete_details: row.incompleteDetailsJson ?? null,
      text: { format: { type: "text" } },
      reasoning: null,
      store: row.store ?? true,
      background: row.background ?? false,
    };

    return Response.json(responseObj);
  } catch (e) {
    console.error("POST /v1/responses/[id]/cancel error:", e);
    return serverError();
  }
}
