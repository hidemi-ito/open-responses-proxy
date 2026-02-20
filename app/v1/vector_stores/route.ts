export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { requireAuth, isAuthError } from "@/lib/auth";

const STUB = new Response(
  JSON.stringify({
    error: {
      message: "Not yet implemented",
      type: "server_error",
      code: "not_implemented",
    },
  }),
  { status: 501, headers: { "content-type": "application/json" } },
);

function stub() {
  return STUB.clone();
}

/** GET /v1/vector_stores — list vector stores (stub). */
export async function GET(req: Request) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;
  return stub();
}

/** POST /v1/vector_stores — create a vector store (stub). */
export async function POST(req: Request) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;
  return stub();
}
