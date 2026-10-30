import { randomUUID } from "node:crypto";

/** A fresh idempotency key for a charge request. */
export const newKey = () => `ik_${randomUUID()}`;
