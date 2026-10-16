import { domainToASCII } from "node:url";
import { containsControlCharacters } from "../../shared/control-characters";

export type NormalizedRecoveryEmail = Readonly<{ address: string; normalized: string }>;

export function normalizeRecoveryEmail(input: unknown): NormalizedRecoveryEmail | null {
  if (typeof input !== "string") return null;
  const address = input.trim();
  if (!address || Buffer.byteLength(address, "utf8") > 254 || /\s/.test(address) || containsControlCharacters(address))
    return null;
  const separator = address.lastIndexOf("@");
  if (separator < 1 || separator !== address.indexOf("@")) return null;
  const local = address.slice(0, separator);
  const rawDomain = address.slice(separator + 1);
  if (
    local.length > 64 ||
    local.startsWith(".") ||
    local.endsWith(".") ||
    local.includes("..") ||
    !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)
  )
    return null;
  const domain = domainToASCII(rawDomain).toLowerCase();
  if (!domain || domain.length > 253 || !domain.includes(".")) return null;
  const labels = domain.split(".");
  if (labels.some((label) => !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)))
    return null;
  const normalized = `${local.toLowerCase()}@${domain}`;
  return Buffer.byteLength(normalized, "utf8") <= 254 ? { address, normalized } : null;
}
