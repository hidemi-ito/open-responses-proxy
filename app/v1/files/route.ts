export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { requireAuth, isAuthError } from "@/lib/auth";
import { db } from "@/lib/db/client";
import { files } from "@/lib/db/schema";
import { newId } from "@/lib/openresponses/ids";
import { badRequest, serverError } from "@/lib/openresponses/errors";
import { uploadFile } from "@/lib/storage/client";

/** GET /v1/files — list uploaded files. */
export async function GET(req: Request) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;

  try {
    const rows = await db.select().from(files);
    return Response.json({
      object: "list",
      data: rows.map((r) => ({
        id: r.id,
        object: "file",
        bytes: r.bytes,
        created_at: r.createdAt,
        filename: r.filename,
        purpose: r.purpose,
      })),
    });
  } catch (e) {
    console.error("GET /v1/files error:", e);
    return serverError();
  }
}

/** POST /v1/files — upload a file. */
export async function POST(req: Request) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;

  try {
    const form = await req.formData();
    const file = form.get("file") as File | null;
    const purpose = form.get("purpose") as string | null;

    if (!file) return badRequest("Missing required field: file", "file");
    if (!purpose) return badRequest("Missing required field: purpose", "purpose");

    const fileId = newId("file_");
    const blobKey = `files/${fileId}/${file.name}`;
    const bytes = file.size;
    const createdAt = Math.floor(Date.now() / 1000);

    await uploadFile(blobKey, Buffer.from(await file.arrayBuffer()), file.type);

    await db.insert(files).values({
      id: fileId,
      purpose,
      filename: file.name,
      bytes,
      mimeType: file.type || "application/octet-stream",
      blobKey,
      createdAt,
    });

    return Response.json({
      id: fileId,
      object: "file",
      bytes,
      created_at: createdAt,
      filename: file.name,
      purpose,
    });
  } catch (e) {
    console.error("POST /v1/files error:", e);
    return serverError();
  }
}
