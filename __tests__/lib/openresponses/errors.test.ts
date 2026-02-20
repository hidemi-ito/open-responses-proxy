import { describe, it, expect } from "vitest";
import {
  jsonError,
  badRequest,
  unauthorized,
  notFound,
  conflict,
  rateLimited,
  serverError,
  notImplemented,
  sseErrorPayload,
  type ApiError,
} from "@/lib/openresponses/errors";

describe("jsonError", () => {
  it("returns a NextResponse with the correct status and body", async () => {
    const res = jsonError(418, "server_error", "I'm a teapot", "brew", "teapot");
    expect(res.status).toBe(418);
    const body: ApiError = await res.json();
    expect(body).toEqual({
      error: {
        message: "I'm a teapot",
        type: "server_error",
        param: "brew",
        code: "teapot",
      },
    });
  });

  it("defaults param and code to null", async () => {
    const res = jsonError(400, "invalid_request_error", "bad");
    const body: ApiError = await res.json();
    expect(body.error.param).toBeNull();
    expect(body.error.code).toBeNull();
  });
});

describe("convenience error helpers", () => {
  it("badRequest returns 400 with invalid_request_error", async () => {
    const res = badRequest("oops", "field");
    expect(res.status).toBe(400);
    const body: ApiError = await res.json();
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.message).toBe("oops");
    expect(body.error.param).toBe("field");
  });

  it("unauthorized returns 401", async () => {
    const res = unauthorized();
    expect(res.status).toBe(401);
    const body: ApiError = await res.json();
    expect(body.error.type).toBe("unauthorized");
    expect(body.error.message).toBe("Invalid or missing API key.");
  });

  it("unauthorized accepts custom message", async () => {
    const res = unauthorized("custom");
    const body: ApiError = await res.json();
    expect(body.error.message).toBe("custom");
  });

  it("notFound returns 404", async () => {
    const res = notFound();
    expect(res.status).toBe(404);
    const body: ApiError = await res.json();
    expect(body.error.type).toBe("not_found");
  });

  it("conflict returns 409", async () => {
    const res = conflict("conflict!");
    expect(res.status).toBe(409);
    const body: ApiError = await res.json();
    expect(body.error.type).toBe("conflict");
  });

  it("rateLimited returns 429", async () => {
    const res = rateLimited();
    expect(res.status).toBe(429);
    const body: ApiError = await res.json();
    expect(body.error.type).toBe("rate_limit_error");
  });

  it("serverError returns 500", async () => {
    const res = serverError();
    expect(res.status).toBe(500);
    const body: ApiError = await res.json();
    expect(body.error.type).toBe("server_error");
  });

  it("notImplemented returns 501", async () => {
    const res = notImplemented();
    expect(res.status).toBe(501);
    const body: ApiError = await res.json();
    expect(body.error.type).toBe("not_implemented");
  });
});

describe("sseErrorPayload", () => {
  it("returns a plain error object (not a Response)", () => {
    const payload = sseErrorPayload("server_error", "boom", "CODE");
    expect(payload).toEqual({
      type: "error",
      error: { type: "server_error", message: "boom", code: "CODE" },
    });
  });

  it("defaults code to null", () => {
    const payload = sseErrorPayload("not_found", "gone");
    expect(payload.error.code).toBeNull();
  });
});
