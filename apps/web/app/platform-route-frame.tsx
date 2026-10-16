"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import LeadSidebar from "./leads/LeadSidebar";
import "./leads/leads.css";
import "./leads/platform-pages.css";

type Role = "admin" | "manager" | "operator" | "reviewer" | "auditor";
type Session = { role?: Role; username?: string };

const framedPaths = [
  "/account", "/admin", "/audit", "/imports", "/runs", "/review",
  "/submissions", "/tools", "/results/history", "/",
];

const sectionNames: Record<string, string> = {
  "/account": "KONTO I BEZPIECZEŃSTWO", "/admin": "ADMINISTRACJA",
  "/": "PRZEGLĄD",
  "/audit": "DZIENNIK AKTYWNOŚCI", "/imports": "IMPORTY", "/runs": "ZADANIA",
  "/review": "WERYFIKACJA DANYCH", "/submissions": "ZGŁOSZENIA", "/tools": "AUTOMATYZACJE",
  "/results/history": "HISTORIA WYNIKÓW",
};

function sectionFor(pathname: string) {
  return framedPaths.find((path) => pathname === path || pathname.startsWith(`${path}/`)) ?? "";
}

export default function PlatformRouteFrame({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const section = sectionFor(pathname);
  const [session, setSession] = useState<Session | null>(null);
  const [checked, setChecked] = useState(false);
  const [sidebarExpanded, setSidebarExpanded] = useState(true);

  useEffect(() => {
    if (!section) return;
    let active = true;
    fetch("/api/auth/me", { credentials: "same-origin", cache: "no-store" })
      .then(async (response) => response.ok ? response.json() as Promise<Session> : null)
      .then((value) => { if (active) setSession(value); })
      .catch(() => { if (active) setSession(null); })
      .finally(() => { if (active) setChecked(true); });
    return () => { active = false; };
  }, [section]);

  if (!section || !checked || !session?.role) return <>{children}</>;
  const roleLabel = session.role === "admin" ? "Administrator" : session.role === "manager" ? "Menedżer" : session.role === "operator" ? "Pracownik" : session.role === "reviewer" ? "Recenzent" : "Audytor";
  return <div className={`lead-app-shell legacy-platform-frame${sidebarExpanded ? "" : " is-collapsed"}`}>
    <LeadSidebar role={session.role} pathname={pathname} onExpandedChange={setSidebarExpanded} />
    <div className="lead-main legacy-main">
      <header className="lead-topbar legacy-topbar"><div><span className="lead-overline">GOLDIS <i>/</i> {sectionNames[section]}</span><span className="lead-topbar-name">{session.username ? `${session.username} · ${roleLabel}` : roleLabel}</span></div><a className="lead-topbar-account" href="/account">Moje konto <span aria-hidden="true">↗</span></a></header>
      {children}
    </div>
  </div>;
}
