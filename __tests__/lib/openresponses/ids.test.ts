import { describe, it, expect } from "vitest";
import { newId, type IdPrefix } from "@/lib/openresponses/ids";

describe("newId", () => {
  const prefixes: IdPrefix[] = [
    "resp_",
    "msg_",
    "fc_",
    "fco_",
    "vs_",
    "file_",
    "item_",
    "batch_",
  ];

  it.each(prefixes)("generates an ID starting with prefix '%s'", (prefix) => {
    const id = newId(prefix);
    expect(id).toMatch(new RegExp(`^${prefix}[0-9a-f]{32}$`));
  });

  it("generates unique IDs on every call", () => {
    const ids = new Set(Array.from({ length: 100 }, () => newId("resp_")));
    expect(ids.size).toBe(100);
  });

  it("strips hyphens from the UUID portion", () => {
    const id = newId("msg_");
    const uuidPart = id.slice("msg_".length);
    expect(uuidPart).not.toContain("-");
    expect(uuidPart).toHaveLength(32);
  });
});
