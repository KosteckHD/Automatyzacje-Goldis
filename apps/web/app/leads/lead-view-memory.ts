export type LeadViewMemory = Readonly<{ scrollY: number; leadId: string | null }>;

function storageKey(tenantId: string, userId: string, listUrl: string) {
  return `goldis:lead-view:v1:${tenantId}:${userId}:${encodeURIComponent(listUrl)}`;
}

export function readLeadViewMemory(tenantId: string, userId: string, listUrl: string): LeadViewMemory | null {
  try {
    const value = window.sessionStorage.getItem(storageKey(tenantId, userId, listUrl));
    if (!value) return null;
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (!Number.isFinite(parsed.scrollY) || (parsed.leadId !== null && typeof parsed.leadId !== "string")) return null;
    return { scrollY: Math.max(0, Number(parsed.scrollY)), leadId: parsed.leadId as string | null };
  } catch { return null; }
}

export function writeLeadViewMemory(tenantId: string, userId: string, listUrl: string, value: LeadViewMemory): void {
  try { window.sessionStorage.setItem(storageKey(tenantId, userId, listUrl), JSON.stringify(value)); } catch { /* Storage can be unavailable or full. */ }
}
