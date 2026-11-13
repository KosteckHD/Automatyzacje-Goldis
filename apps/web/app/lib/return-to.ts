import { sanitizeLeadReturnTo } from "../leads/lead-query";

const SAFE_EXACT_PATHS = new Set([
  "/", "/imports", "/runs", "/results", "/audit", "/tools", "/tools/oc-policy-verification", "/tools/commission-comparison",
  "/dashboard", "/notifications", "/my-results", "/team", "/access", "/reports", "/review", "/account",
]);

function isAllowedPath(pathname: string) {
  if (SAFE_EXACT_PATHS.has(pathname)) return true;
  return /^\/(?:imports|runs)\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/.test(pathname)
    || /^\/submissions\/[0-9a-f-]{36}$/i.test(pathname)
    || /^\/(?:my-results|leads)\/[0-9a-f-]{36}$/i.test(pathname)
    || pathname === "/results/history"
    || pathname === "/results/oc-policy-verification";
}

export function sanitizeAppReturnTo(value: string | null | undefined, origin: string): string | null {
  if (!value || value.length > 4096 || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return null;
  let parsed: URL;
  try { parsed = new URL(value, origin); } catch { return null; }
  if (parsed.origin !== origin || !isAllowedPath(parsed.pathname)) return null;

  const nestedReturnTo = parsed.searchParams.getAll("returnTo");
  if (nestedReturnTo.length > 1) return null;
  if (nestedReturnTo.length === 1) {
    if (!/^\/(?:my-results|leads)\/[0-9a-f-]{36}$/i.test(parsed.pathname)) return null;
    const safeList = sanitizeLeadReturnTo(nestedReturnTo[0]);
    if (!safeList) return null;
    parsed.searchParams.set("returnTo", safeList);
  }
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

export function loginHref(returnTo: string | null | undefined, origin: string): string {
  const safe = sanitizeAppReturnTo(returnTo, origin);
  return safe ? `/?returnTo=${encodeURIComponent(safe)}` : "/";
}
