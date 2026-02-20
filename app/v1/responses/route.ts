export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { ResponsesRequestSchema } from "@/lib/openresponses/schema";
import { requireAuth, isAuthError } from "@/lib/auth";
import { runResponse } from "@/lib/orchestrator";
import { badRequest, serverError, notImplemented } from "@/lib/openresponses/errors";

export async function POST(req: Request): Promise<Response> {
  // 1. Auth check
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;

  // 2. Content-type check
  const ct = req.headers.get("content-type") ?? "";
  if (!ct.toLowerCase().includes("application/json")) {
    return badRequest("Content-Type must be application/json", "content-type");
  }

  // 3. Parse body
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest("Invalid JSON body");
  }

  // 4. Validate with Zod
  const parsed = ResponsesRequestSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return badRequest(
      issue?.message ?? "Invalid request body",
      issue?.path.join(".") || null,
    );
  }

  // 5. Check for unimplemented built-in tools
  const builtinTypes = new Set([
    "web_search_preview",
    "file_search",
    "code_interpreter",
    "image_generation",
    "computer_use_preview",
  ]);
  const hasBuiltin = parsed.data.tools.some((t) => builtinTypes.has(t.type));
  if (hasBuiltin) {
    return notImplemented("Built-in tools are not yet implemented.");
  }

  // 6. Run the response
  try {
    return await runResponse(parsed.data, req.signal);
  } catch (e) {
    if (e instanceof Response) return e;
    console.error("runResponse error:", e);
    return serverError();
  }
}
