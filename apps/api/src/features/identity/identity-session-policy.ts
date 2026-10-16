import type { GoldisRole } from "../../contracts/identity";

export const SESSION_IDLE_LIFETIME_MS = 30 * 60 * 1000;
export const SESSION_ACTIVITY_TOUCH_INTERVAL_MS = 60_000;
const userActivityHeader = "x-goldis-user-activity";

export function isSupportedGoldisRole(value: unknown): value is GoldisRole {
  return (
    value === "admin" || value === "manager" || value === "operator" || value === "reviewer" || value === "auditor"
  );
}

export function isIdleSessionExpired(lastActivityAt: Date, now = Date.now()): boolean {
  return now - lastActivityAt.getTime() >= SESSION_IDLE_LIFETIME_MS;
}

export function hasRecentUserActivitySignal(
  request: Readonly<{ headers: Readonly<Record<string, unknown>> }>,
): boolean {
  return request.headers[userActivityHeader] === "1";
}
