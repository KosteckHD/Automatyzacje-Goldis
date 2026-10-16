import type { GoldisRole } from "../../contracts/identity";
import { recordAuditEvent } from "../audit/public";
import { IdentityRepository } from "./identity.repository";

/** Runtime adapters used by legacy guard construction and non-Nest test harnesses. */
function compatibilityRepository(): IdentityRepository {
  return new IdentityRepository({ record: recordAuditEvent });
}

export function resolveIdentityActiveSessionRole(userId: string, tenantId: string): Promise<GoldisRole | null> {
  return compatibilityRepository().findActiveMembershipRole(userId, tenantId);
}

export function resolveIdentityMustChangePassword(userId: string): Promise<boolean> {
  return compatibilityRepository().findPasswordChangeRequired(userId);
}

export function resolveIdentityCurrentSessionRole(
  userId: string,
  tenantId: string,
  sessionId?: string,
  userActivity = false,
): Promise<GoldisRole | null> {
  return compatibilityRepository().resolveCurrentSessionRole(userId, tenantId, sessionId, userActivity);
}
