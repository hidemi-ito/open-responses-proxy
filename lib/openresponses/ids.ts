import { randomUUID } from "crypto";

export type IdPrefix =
  | "resp_"
  | "msg_"
  | "fc_"
  | "fco_"
  | "rs_"
  | "vs_"
  | "file_"
  | "item_"
  | "batch_";

/**
 * Generate a prefixed unique ID using crypto.randomUUID().
 * Example: newId("resp_") → "resp_a1b2c3d4-..."
 */
export function newId(prefix: IdPrefix): string {
  return `${prefix}${randomUUID().replace(/-/g, "")}`;
}
