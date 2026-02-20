export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { requireAuth, isAuthError } from "@/lib/auth";
import { db } from "@/lib/db/client";
import { files } from "@/lib/db/schema";
import { notFound, serverError } from "@/lib/openresponses/errors";
import { deleteFile } from "@/lib/storage/client";
import { eq } from "drizzle-orm";

/** GET /v1/files/{file_id} — retrieve file metadata. */
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

    return Response.json({
      id: row.id,
      object: "file",
      bytes: row.bytes,
      created_at: row.createdAt,
      filename: row.filename,
      purpose: row.purpose,
    });
  } catch (e) {
    console.error("GET /v1/files/:id error:", e);
    return serverError();
  }
}

/** DELETE /v1/files/{file_id} — delete a file. */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ file_id: string }> },
) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;

  try {
    const { file_id } = await params;
    const [row] = await db.select().from(files).where(eq(files.id, file_id));
    if (!row) return notFound("File not found.");

    if (row.blobKey) {
      await deleteFile(row.blobKey);
    }
    await db.delete(files).where(eq(files.id, file_id));

    return Response.json({
      id: file_id,
      object: "file",
      deleted: true,
    });
  } catch (e) {
    console.error("DELETE /v1/files/:id error:", e);
    return serverError();
  }
}
