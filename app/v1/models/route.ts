export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { AVAILABLE_MODELS } from "@/lib/providers/resolver";

/**
 * GET /v1/models
 *
 * Returns the list of available models. No authentication required
 * (compatible with SDK discovery patterns).
 */
export async function GET(): Promise<Response> {
  return Response.json({
    object: "list",
    data: AVAILABLE_MODELS,
  });
}
