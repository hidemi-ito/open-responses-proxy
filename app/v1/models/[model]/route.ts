export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest } from "next/server";
import { AVAILABLE_MODELS } from "@/lib/providers/resolver";
import { notFound } from "@/lib/openresponses/errors";

type RouteContext = { params: Promise<{ model: string }> };

/**
 * GET /v1/models/{model}
 *
 * Returns details for a single model. No authentication required.
 */
export async function GET(
  _req: NextRequest,
  ctx: RouteContext,
): Promise<Response> {
  const { model } = await ctx.params;

  const entry = AVAILABLE_MODELS.find((m) => m.id === model);
  if (!entry) {
    return notFound(`Model '${model}' not found.`);
  }

  return Response.json(entry);
}
