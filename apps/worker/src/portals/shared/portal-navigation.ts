export type PortalNavigationPolicy = Readonly<{ entryUrl: string; allowedOrigins: readonly string[] }>;

/** Application actions stay inside its configured path; login redirects use explicit HTTPS origins. */
export function isAllowedPortalNavigation(policy: PortalNavigationPolicy, target: string, applicationOnly = false): boolean {
  try {
    const url = new URL(target); const entry = new URL(policy.entryUrl);
    if (url.protocol !== "https:" || url.username || url.password || !policy.allowedOrigins.includes(url.origin)) return false;
    if (url.origin !== entry.origin) return !applicationOnly;
    const base = entry.pathname.replace(/\/$/, "") || "/";
    return url.pathname === base || url.pathname === `${base}/`;
  } catch { return false; }
}
