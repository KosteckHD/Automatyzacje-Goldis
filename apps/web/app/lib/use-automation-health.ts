"use client";

import { useEffect, useState } from "react";

export type AutomationHealth = {
  automationReady: boolean;
  servicesReady: boolean;
  worker: string;
  portalMode: string;
  portalConfig: string;
  message: string;
};

export type AutomationHealthState = {
  status: "checking" | "available" | "unknown" | "disabled";
  data: AutomationHealth | null;
  message?: string;
};

const unknownMessage = "Nie można sprawdzić gotowości automatyzacji.";

export function useAutomationHealth(enabled: boolean): AutomationHealthState {
  const [state, setState] = useState<AutomationHealthState>({ status: "checking", data: null });

  useEffect(() => {
    if (!enabled) {
      setState({ status: "disabled", data: null });
      return;
    }

    let active = true;
    let running = false;
    let timer: number | null = null;
    let controller: AbortController | null = null;

    const poll = async () => {
      if (!active || running || document.visibilityState !== "visible") return;
      if (!navigator.onLine) {
        setState({ status: "unknown", data: null, message: "Brak połączenia z internetem. Nie można sprawdzić gotowości." });
        return;
      }

      running = true;
      controller = new AbortController();
      try {
        const response = await fetch("/api/health/automation", {
          credentials: "same-origin",
          signal: controller.signal,
          cache: "no-store",
        });
        const payload = await response.json().catch(() => null) as Partial<AutomationHealth> | null;

        if (payload && typeof payload.message === "string"
          && typeof payload.automationReady === "boolean" && typeof payload.servicesReady === "boolean") {
          setState({ status: "available", data: payload as AutomationHealth });
        } else {
          setState({ status: "unknown", data: null, message: unknownMessage });
        }
      } catch {
        if (active && !controller.signal.aborted) {
          setState({ status: "unknown", data: null, message: unknownMessage });
        }
      } finally {
        running = false;
        controller = null;
        if (active && document.visibilityState === "visible" && navigator.onLine) {
          timer = window.setTimeout(() => void poll(), 15_000);
        }
      }
    };

    const resume = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      if (document.visibilityState === "visible") void poll();
    };
    const goOffline = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      controller?.abort();
      setState({ status: "unknown", data: null, message: "Brak połączenia z internetem. Nie można sprawdzić gotowości." });
    };

    void poll();
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("online", resume);
    window.addEventListener("offline", goOffline);

    return () => {
      active = false;
      if (timer !== null) window.clearTimeout(timer);
      controller?.abort();
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("online", resume);
      window.removeEventListener("offline", goOffline);
    };
  }, [enabled]);

  if (!enabled) return { status: "disabled", data: null };
  if (state.status === "disabled") return { status: "checking", data: null };
  return state;
}
