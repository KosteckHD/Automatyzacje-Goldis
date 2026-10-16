"use client";

import { useEffect, useState } from "react";

type Tool = {
  toolId: string; displayName: string; description: string; status: "available" | "maintenance" | "disabled";
  access: { canExecute: boolean; canViewResults: boolean; canDownloadResults: boolean };
};

const statusLabels: Record<Tool["status"], string> = { available: "Dostępne", maintenance: "Przerwa techniczna", disabled: "Wyłączone" };

export default function ToolCatalog() {
  const [items, setItems] = useState<Tool[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    fetch("/api/tools", { credentials: "same-origin", cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({})) as { items?: Tool[]; message?: string };
        if (!response.ok) throw new Error(payload.message || "Nie udało się pobrać katalogu narzędzi.");
        if (active) setItems(Array.isArray(payload.items) ? payload.items : []);
      })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : "Nie udało się pobrać katalogu narzędzi."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  return <div className="lead-content platform-content">
    <div className="lead-page-heading"><div><p className="lead-overline">CENTRUM OPERACYJNE <span>·</span> NARZĘDZIA</p><h1>Automatyzacje</h1><p>Uruchamiaj moduły dostępne dla Twojego konta lub przechodź do wyników, które możesz przeglądać.</p></div></div>
    {error && <p className="lead-feedback" role="alert">{error}</p>}
    {loading ? <p className="lead-loading" role="status">Wczytuję dostępne narzędzia…</p>
      : items.length ? <section className="tool-catalog-grid" aria-label="Dostępne narzędzia">{items.map((tool) => {
        const isOc = tool.toolId === "oc-policy-verification";
        const href = isOc ? tool.access.canExecute ? "/tools/oc-policy-verification" : tool.access.canViewResults || tool.access.canDownloadResults ? "/results/oc-policy-verification" : null : null;
        const action = tool.access.canExecute ? "Otwórz narzędzie" : tool.access.canViewResults || tool.access.canDownloadResults ? "Przeglądaj wyniki" : "Dostęp ograniczony";
        return <article className="lead-panel tool-catalog-card" key={tool.toolId}>
          <div className="tool-catalog-card-head"><span className="tool-catalog-mark" aria-hidden="true">{isOc ? "OC" : "AU"}</span><span className={`tool-catalog-status status-${tool.status}`}>{statusLabels[tool.status] ?? tool.status}</span></div>
          <p className="lead-overline">{tool.toolId}</p><h2>{tool.displayName}</h2><p>{tool.description}</p>
          <div className="tool-catalog-capabilities"><span>{tool.access.canExecute ? "Uruchamianie dostępne" : "Bez prawa uruchamiania"}</span><span>{tool.access.canViewResults ? "Podgląd wyników" : "Bez podglądu wyników"}</span></div>
          {href ? <a className="lead-primary" href={href}>{action}<span aria-hidden="true">↗</span></a>
            : <span className="tool-catalog-disabled" aria-label={`${action}; interfejs tego narzędzia nie jest częścią MVP`}>{action}</span>}
        </article>;
      })}</section> : <section className="lead-panel tool-catalog-empty"><h2>Brak dostępnych narzędzi</h2><p>Gdy administrator przyzna dostęp do modułu, pojawi się on w tym miejscu.</p></section>}
  </div>;
}
