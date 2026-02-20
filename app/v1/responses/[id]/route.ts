export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { responses } from "@/lib/db/schema";
import { requireAuth, isAuthError } from "@/lib/auth";
import { notFound, serverError } from "@/lib/openresponses/errors";
import type { ResponseObject, Usage, OutputItem } from "@/lib/openresponses/response";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Reconstruct a full ResponseObject from a database row.
 */
function rowToResponseObject(row: typeof responses.$inferSelect): ResponseObject {
  return {
    id: row.id,
    object: "response",
    created_at: row.createdAt,
    status: row.status as ResponseObject["status"],
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
}

/**
 * GET /v1/responses/{id}
 */
export async function GET(
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

    return Response.json(rowToResponseObject(row));
  } catch (e) {
    console.error("GET /v1/responses/[id] error:", e);
    return serverError();
  }
}

/**
 * DELETE /v1/responses/{id}
 */
export async function DELETE(
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

    await db.delete(responses).where(eq(responses.id, id));

    return Response.json({
      id,
      object: "response",
      deleted: true,
    });
  } catch (e) {
    console.error("DELETE /v1/responses/[id] error:", e);
    return serverError();
  }
}
