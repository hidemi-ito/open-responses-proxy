export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { requireAuth, isAuthError } from "@/lib/auth";
import { db } from "@/lib/db/client";
import { files } from "@/lib/db/schema";
import { notFound, serverError } from "@/lib/openresponses/errors";
import { getSignedUrl } from "@/lib/storage/client";
import { eq } from "drizzle-orm";

/** GET /v1/files/{file_id}/content — redirect to file content. */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ file_id: string }> },
) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;

  try {
    const { file_id } = await params;
    const [row] = await db.select().from(files).where(eq(files.id, file_id));
    if (!row) return notFound("File not found.");
    if (!row.blobKey) return notFound("File content not available.");

    const url = await getSignedUrl(row.blobKey);
    return Response.redirect(url, 302);
  } catch (e) {
    console.error("GET /v1/files/:id/content error:", e);
    return serverError();
  }
}
