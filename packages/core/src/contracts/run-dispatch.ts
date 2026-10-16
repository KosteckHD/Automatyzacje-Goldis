/** Stable dispatch intents shared by the API producer and portal worker consumer. */
export const RUN_DISPATCH_INTENTS_V1 = ["create", "resume_auth", "resume_review", "recovery", "result_delivery"] as const;

export type RunDispatchIntentV1 = (typeof RUN_DISPATCH_INTENTS_V1)[number];

export function isRunDispatchIntentV1(value: unknown): value is RunDispatchIntentV1 {
  return typeof value === "string" && (RUN_DISPATCH_INTENTS_V1 as readonly string[]).includes(value);
}
