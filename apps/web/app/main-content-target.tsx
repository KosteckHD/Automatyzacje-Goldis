"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

const contentSelectors = ".content, .lead-content, .platform-content, .history-content, .admin-content, .review-content, .account-content";

export default function MainContentTarget() {
  const pathname = usePathname();

  useEffect(() => {
    const syncTarget = () => {
      const main = document.querySelector("main");
      const target = main?.querySelector<HTMLElement>(contentSelectors) ?? main;
      document.querySelectorAll<HTMLElement>("#main-content").forEach((element) => {
        if (element !== target) element.removeAttribute("id");
      });
      if (!target) return;
      target.id = "main-content";
      target.tabIndex = -1;
    };
    syncTarget();
    const observer = new MutationObserver(syncTarget);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [pathname]);

  return null;
}
