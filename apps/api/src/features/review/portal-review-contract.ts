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
    input.runStatus !== "waiting_for_manual_data" ||
    input.portal !== "compensa" ||
    input.kind !== "portal_error"
  )
    return false;
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
