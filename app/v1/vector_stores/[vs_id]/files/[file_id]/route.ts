export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { requireAuth, isAuthError } from "@/lib/auth";

function stub() {
  return new Response(
    JSON.stringify({
      error: {
        message: "Not yet implemented",
        type: "server_error",
        code: "not_implemented",
      },
    }),
    { status: 501, headers: { "content-type": "application/json" } },
  );
}

/** GET /v1/vector_stores/{vs_id}/files/{file_id} (stub). */
export async function GET(req: Request) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;
  return stub();
}

/** DELETE /v1/vector_stores/{vs_id}/files/{file_id} (stub). */
export async function DELETE(req: Request) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;
  return stub();
}
