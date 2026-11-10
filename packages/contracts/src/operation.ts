// The one response shape of every operation-bearing route (Doc 06 §9).
// `replayExpiresAt` is null until the operation reaches a final state.
import { z } from "zod";
import { operationIdSchema } from "./ids.ts";

export const OPERATION_STATES = [
  "accepted",
  "executing",
  "awaiting_input",
  "uncertain",
  "succeeded",
  "partial",
  "rejected",
] as const;

export type OperationState = (typeof OPERATION_STATES)[number];

export const operationResponseSchema = z.strictObject({
  operationId: operationIdSchema,
  state: z.enum(OPERATION_STATES),
  statusUrl: z.string().min(1),
  replayExpiresAt: z.iso.datetime().nullable(),
  result: z.record(z.string(), z.unknown()).optional(),
});

export type OperationResponse = z.infer<typeof operationResponseSchema>;
