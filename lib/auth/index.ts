import { unauthorized } from "@/lib/openresponses/errors";

/**
 * Validate the Bearer token from the Authorization header.
 *
 * Valid tokens are read from the API_KEYS environment variable (comma-separated).
 * Returns `{ token }` on success, or a 401 NextResponse on failure.
 */
export function requireAuth(
  req: Request,
): { token: string } | Response {
  const authHeader = req.headers.get("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return unauthorized("Missing or malformed Authorization header.");
  }

  const token = authHeader.slice("Bearer ".length).trim();
  if (!token) {
    return unauthorized("Empty Bearer token.");
  }

  const validKeys = (process.env.API_KEYS ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);

  // If API_KEYS is not configured, allow all tokens (development mode).
  if (validKeys.length === 0) {
    return { token };
  }

  if (!validKeys.includes(token)) {
    return unauthorized("Invalid API key.");
  }

  return { token };
}

/** Type guard: check if requireAuth returned an error Response. */
export function isAuthError(
  result: { token: string } | Response,
): result is Response {
  return result instanceof Response;
}
