"use client";

import { useEffect } from "react";

const activityWindowMs = 60_000;

export function ActivitySignal() {
  useEffect(() => {
    let lastTrustedInteraction = 0;
    const noteActivity = (event: Event) => {
      if (event.isTrusted) lastTrustedInteraction = Date.now();
    };
    const activityEvents = ["pointerdown", "keydown", "input", "touchstart", "wheel"] as const;
    for (const eventName of activityEvents) document.addEventListener(eventName, noteActivity, { capture: true, passive: true });

    const originalFetch = window.fetch;
    const activityFetch: typeof window.fetch = (input, init) => {
      let target: URL | null = null;
      try {
        target = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url, window.location.href);
      } catch {
        target = null;
      }
      if (!target || target.origin !== window.location.origin || !target.pathname.startsWith("/api/")
        || Date.now() - lastTrustedInteraction > activityWindowMs) {
        return originalFetch.call(window, input, init);
      }
      const headers = new Headers(input instanceof Request ? input.headers : undefined);
      new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
      headers.set("x-goldis-user-activity", "1");
      return originalFetch.call(window, input, { ...init, headers });
    };
    window.fetch = activityFetch;

    return () => {
      for (const eventName of activityEvents) document.removeEventListener(eventName, noteActivity, { capture: true });
      if (window.fetch === activityFetch) window.fetch = originalFetch;
    };
  }, []);

  return null;
}
