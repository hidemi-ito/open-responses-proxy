import { NextResponse } from "next/server";

export type ErrorType =
  | "invalid_request_error"
  | "unauthorized"
  | "not_found"
  | "conflict"
  | "rate_limit_error"
  | "server_error"
  | "not_implemented";

export interface ApiError {
  error: {
    message: string;
    type: ErrorType;
    param: string | null;
    code: string | null;
  };
}

export function jsonError(
  status: number,
  type: ErrorType,
  message: string,
  param: string | null = null,
  code: string | null = null,
): NextResponse<ApiError> {
  return NextResponse.json(
    { error: { message, type, param, code } },
    { status },
  );
}

export function badRequest(message: string, param: string | null = null) {
  return jsonError(400, "invalid_request_error", message, param);
}

export function unauthorized(message = "Invalid or missing API key.") {
  return jsonError(401, "unauthorized", message);
}

export function notFound(message = "Resource not found.") {
  return jsonError(404, "not_found", message);
}

export function conflict(message: string) {
  return jsonError(409, "conflict", message);
}

export function rateLimited(message = "Rate limit exceeded.") {
  return jsonError(429, "rate_limit_error", message);
}

export function serverError(message = "Internal server error.") {
  return jsonError(500, "server_error", message);
}

export function notImplemented(message = "This feature is not yet implemented.") {
  return jsonError(501, "not_implemented", message);
}

/**
 * Build an error payload for SSE streaming errors.
 * Returns a plain object (not a NextResponse) suitable for sseEvent().
 */
export function sseErrorPayload(
  type: ErrorType,
  message: string,
  code: string | null = null,
) {
  return {
    type: "error" as const,
    error: { type, message, code },
  };
}
