/** Permission to recheck portal state, never a confirmation that an action succeeded. */
export function canRecheckPortalIntervention(
  input: Readonly<{
    role: string;
    runStatus: string;
    portal: string | null;
    kind: string;
    reasonCode: string | null;
    fieldCode: string | null;
    lastSafeStep: string | null;
    externalCaseRef: string | null;
  }>,
): boolean {
  if (
    !["admin", "manager"].includes(input.role) ||
    input.runStatus !== "waiting_for_manual_data"
  )
    return false;
  // Recheck authentication after an administrator has inspected an uncertain
  // code delivery. This never retries the code or resumes an external case.
  if (input.portal === "pzu") return input.fieldCode === null
    && input.lastSafeStep === null && input.externalCaseRef === null
    && ((input.kind === "sms" && input.reasonCode === "SMS_DELIVERY_UNCERTAIN")
      || (input.kind === "portal_error"
        && ["PORTAL_FAILURE", "PORTAL_SESSION_EXPIRED", "PORTAL_SCHEMA_CHANGED"].includes(input.reasonCode ?? "")));
  // Unhandled worker failures before any external case have no portal marker.
  // A fresh PZU entry is safe here; never infer an existing Compensa checkpoint.
  if (input.portal === null) return input.kind === "portal_error"
    && input.reasonCode === "PORTAL_FAILURE" && input.fieldCode === null
    && input.lastSafeStep === null && input.externalCaseRef === null;
  if (input.portal !== "compensa" || input.kind !== "portal_error") return false;
  if (
    ![
      "MANUAL_DATA_REQUIRED",
      "OFFER_SAVE_UNCONFIRMED",
      "PORTAL_FAILURE",
      "PORTAL_SCHEMA_CHANGED",
      "PORTAL_SESSION_EXPIRED",
    ].includes(input.reasonCode ?? "")
  )
    return false;
  if (
    input.fieldCode !== null &&
    !["PORTAL_ACTION_REVIEW", "OFFER_SAVE_REVIEW", "UFG_ACTION_REVIEW"].includes(input.fieldCode)
  )
    return false;
  if (input.lastSafeStep === "compensa_start_intent")
    return input.fieldCode === "PORTAL_ACTION_REVIEW" && Boolean(input.externalCaseRef?.trim());
  return (
    Boolean(input.externalCaseRef?.trim()) &&
    [
      "compensa_offer_draft_open",
      "compensa_insured_save_intent",
      "compensa_insured_save_confirmed_absent",
      "compensa_insured_data_saved",
      "ufg_verification_intent",
    ].includes(input.lastSafeStep ?? "")
  );
}
