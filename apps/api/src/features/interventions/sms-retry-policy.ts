export function canRetrySms(input: {
  status: string;
  errorCode: string | null;
  reasonCode: string | null;
  portal: string | null;
  retryCount: number;
}): boolean {
  if (!input.portal || !["pzu", "compensa"].includes(input.portal) || input.retryCount >= 2) return false;
  return (
    (input.status === "waiting_for_manual_data" &&
      input.errorCode === "SMS_RETRY_REQUIRED" &&
      input.reasonCode === "SMS_TIMEOUT") ||
    (input.status === "waiting_for_sms" &&
      input.errorCode === "SMS_CODE_REJECTED" &&
      input.reasonCode === "SMS_CODE_REJECTED")
  );
}
