"use client";

import type { AutomationHealth, AutomationHealthState } from "../../app/lib/use-automation-health";
import { automationStatusMessage, automationTechnicalStatus } from "../../app/lib/automation-status-copy";

export default function AutomationHealthPanel({
  health, status, message, onRefresh, variant = "oc-health",
}: {
  health: AutomationHealth | null;
  status: AutomationHealthState["status"];
  message?: string;
  onRefresh?: () => void;
  variant?: "oc-health" | "automation-health";
}) {
  const summary = automationStatusMessage(status, health, message);
  const unavailable = status === "unknown";
  const detailsClass = variant === "oc-health" ? "oc-health-details" : "automation-health-details";
  const retryClass = variant === "oc-health" ? "oc-health-retry" : "automation-health-retry";
  return <section className={`${variant}${health?.automationReady ? " is-ready" : " health-warn"}`} aria-live="polite" aria-label="Gotowość sprawdzania OC">
    <span className={`status-dot${health?.automationReady ? "" : " health-warn"}`} aria-hidden="true" />
    <div>
      <strong>{summary}</strong>
      <details className={detailsClass}>
        <summary>Szczegóły techniczne</summary>
        <span>{automationTechnicalStatus(health)}</span>
      </details>
      {unavailable && onRefresh && <button className={retryClass} type="button" onClick={onRefresh}>Sprawdź ponownie</button>}
    </div>
  </section>;
}
