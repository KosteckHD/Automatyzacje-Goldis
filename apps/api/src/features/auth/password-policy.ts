const minimumCodePoints = 15;
const maximumCodePoints = 1_024;
const maximumUtf8Bytes = 4_096;
const deniedPasswords = new Set([
  "replace_with_local_password",
  "change_me",
  "change-me",
  "changeme",
  "password",
  "password123",
  "letmein",
  "qwerty",
  "123456789012345",
]);

export type PasswordPolicyFailure = "too_short" | "too_long" | "known_placeholder";

export function passwordPolicyFailure(password: string): PasswordPolicyFailure | null {
  const points = [...password].length;
  if (points < minimumCodePoints) return "too_short";
  if (points > maximumCodePoints || Buffer.byteLength(password, "utf8") > maximumUtf8Bytes) return "too_long";
  if (deniedPasswords.has(password.toLowerCase())) return "known_placeholder";
  return null;
}

export function assertNewPassword(password: string): void {
  if (passwordPolicyFailure(password)) throw new Error("PASSWORD_POLICY_FAILED");
}
