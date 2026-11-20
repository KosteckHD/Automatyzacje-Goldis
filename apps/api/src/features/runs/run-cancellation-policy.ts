type CancellationState = {
  status: string;
  errorCode: string | null;
  lastSafeStep: string | null;
  externalCaseRef: string | null;
  leaseExpiresAt: Date | null;
};

// An abandoned login can be closed without creating a second portal case.
// Keep all later/uncertain portal actions on their existing reconciliation path.
export function canCancelAbandonedSms(run: CancellationState, now = new Date()): boolean {
  return run.status === "waiting_for_manual_data"
    && ["SMS_RETRY_REQUIRED", "SMS_DELIVERY_UNCERTAIN"].includes(run.errorCode ?? "")
    && !run.lastSafeStep && !run.externalCaseRef
    && (!run.leaseExpiresAt || run.leaseExpiresAt.getTime() <= now.getTime());
}
