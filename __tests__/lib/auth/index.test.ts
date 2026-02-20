import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock next/server before importing the module under test
vi.mock("next/server", () => {
  class MockNextResponse extends Response {
    static json(body: unknown, init?: ResponseInit) {
      const res = new Response(JSON.stringify(body), {
        ...init,
        headers: {
          "Content-Type": "application/json",
          ...init?.headers,
        },
      });
      return res;
    }
  }
  return { NextResponse: MockNextResponse };
});

import { requireAuth, isAuthError } from "@/lib/auth/index";

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/v1/responses", {
    headers,
  });
}

describe("requireAuth", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns 401 when Authorization header is missing", () => {
    const result = requireAuth(makeRequest());
    expect(isAuthError(result)).toBe(true);
    expect((result as Response).status).toBe(401);
  });

  it("returns 401 when Authorization header does not start with Bearer", () => {
    const result = requireAuth(makeRequest({ Authorization: "Basic abc123" }));
    expect(isAuthError(result)).toBe(true);
  });

  it("returns 401 when Bearer token is empty", () => {
    const result = requireAuth(makeRequest({ Authorization: "Bearer " }));
    expect(isAuthError(result)).toBe(true);
  });

  it("returns token when API_KEYS is not set (dev mode)", () => {
    delete process.env.API_KEYS;
    const result = requireAuth(
      makeRequest({ Authorization: "Bearer any-token" }),
    );
    expect(isAuthError(result)).toBe(false);
    expect((result as { token: string }).token).toBe("any-token");
  });

  it("returns token when API_KEYS is empty string (dev mode)", () => {
    process.env.API_KEYS = "";
    const result = requireAuth(
      makeRequest({ Authorization: "Bearer anything" }),
    );
    expect(isAuthError(result)).toBe(false);
    expect((result as { token: string }).token).toBe("anything");
  });

  it("returns 401 when token is not in API_KEYS list", () => {
    process.env.API_KEYS = "key1,key2";
    const result = requireAuth(
      makeRequest({ Authorization: "Bearer wrong-key" }),
    );
    expect(isAuthError(result)).toBe(true);
  });

  it("returns token when token matches one of API_KEYS", () => {
    process.env.API_KEYS = "key1,key2,key3";
    const result = requireAuth(
      makeRequest({ Authorization: "Bearer key2" }),
    );
    expect(isAuthError(result)).toBe(false);
    expect((result as { token: string }).token).toBe("key2");
  });

  it("trims whitespace from API_KEYS entries", () => {
    process.env.API_KEYS = " key1 , key2 ";
    const result = requireAuth(
      makeRequest({ Authorization: "Bearer key1" }),
    );
    expect(isAuthError(result)).toBe(false);
  });

  it("ignores empty entries in API_KEYS", () => {
    process.env.API_KEYS = "key1,,key2,";
    const result = requireAuth(
      makeRequest({ Authorization: "Bearer key2" }),
    );
    expect(isAuthError(result)).toBe(false);
  });
});

describe("isAuthError", () => {
  it("returns true for a Response object", () => {
    const res = new Response("", { status: 401 });
    expect(isAuthError(res)).toBe(true);
  });

  it("returns false for a token object", () => {
    expect(isAuthError({ token: "abc" })).toBe(false);
  });
});
