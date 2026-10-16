"use client";

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

type Role = "admin" | "manager" | "operator" | "reviewer" | "auditor" | null;
type IconName = "home" | "automation" | "upload" | "results" | "assigned" | "tasks" | "bell" | "people" | "access" | "report" | "audit" | "review" | "settings" | "account" | "collapse" | "expand" | "menu" | "close";
type Link = { label: string; href: string; icon: IconName; section?: "work" | "manage"; badge?: number };

function SidebarIcon({ name, className }: { name: IconName; className?: string }) {
  const paths: Record<IconName, string> = {
    home: "M3 10.5 12 3l9 7.5M5.5 9v11h13V9M9 20v-6h6v6",
    automation: "M12 3v4m0 10v4M3 12h4m10 0h4M5.64 5.64l2.83 2.83m7.06 7.06 2.83 2.83m0-12.72-2.83 2.83m-7.06 7.06-2.83 2.83M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z",
    upload: "M12 16V4m0 0L7 9m5-5 5 5M4 15v5h16v-5",
    results: "M7 4h10l3 3v13H4V4h3Zm10 0v4h4M8 12h8M8 16h8",
    assigned: "M16 20v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 18.5V20m6-9a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm7-6.5a3.5 3.5 0 0 1 0 6.8m1 3.7h1.5a3 3 0 0 1 3 3V20",
    tasks: "M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01",
    bell: "M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9Zm-8 12h4",
    people: "M16 20v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 18.5V20m6-9a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm7-6.5a3.5 3.5 0 0 1 0 6.8m1 3.7h1.5a3 3 0 0 1 3 3V20",
    access: "M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Zm-3-11 2 2 4-4",
    report: "M4 20V10m5 10V4m5 16v-7m6 7V7M2 20h20",
    audit: "M3 12h4l3-8 4 16 3-8h4",
    review: "m5 12 4 4L19 6",
    settings: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0-5v2m0 14v2M3 12h2m14 0h2M5.64 5.64l1.42 1.42m9.88 9.88 1.42 1.42m0-12.72-1.42 1.42m-9.88 9.88-1.42 1.42",
    account: "M20 21a8 8 0 0 0-16 0m8-10a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z",
    collapse: "m14 6-6 6 6 6",
    expand: "m10 6 6 6-6 6",
    menu: "M4 6h16M4 12h16M4 18h16",
    close: "m6 6 12 12M18 6 6 18",
  };
  return <svg className={className} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}

const baseLinks: Link[] = [
  { label: "Przegląd", href: "/dashboard", icon: "home", section: "work" },
  { label: "Automatyzacje", href: "/tools", icon: "automation", section: "work" },
  { label: "Importy", href: "/imports", icon: "upload", section: "work" },
  { label: "Wyniki", href: "/results/oc-policy-verification", icon: "results", section: "work" },
  { label: "Moje wyniki", href: "/my-results", icon: "assigned", section: "work" },
  { label: "Zadania", href: "/runs", icon: "tasks", section: "work" },
  { label: "Powiadomienia", href: "/notifications", icon: "bell", section: "work" },
];

export default function LeadSidebar({ role, pathname, onExpandedChange }: {
  role: Role; pathname: string; onExpandedChange: (expanded: boolean) => void;
}) {
  const [pinned, setPinned] = useState(true);
  const [hovered, setHovered] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const drawerRef = useRef<HTMLElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const expanded = pinned || hovered;
  const roleLabel = role === "admin" ? "Administrator" : role === "manager" ? "Menedżer" : role === "reviewer" ? "Recenzent" : role === "auditor" ? "Audytor" : "Pracownik";
  const links = [...(role === "auditor" ? [] : baseLinks),
    ...(role === "operator" ? [
      { label: "Moje korekty", href: "/review", icon: "review" as const, section: "work" as const },
    ] : []),
    ...(role === "manager" ? [
      { label: "Pracownicy", href: "/team", icon: "people" as const, section: "manage" as const },
      { label: "Dostępy", href: "/access", icon: "access" as const, section: "manage" as const },
      { label: "Raporty", href: "/reports", icon: "report" as const, section: "manage" as const },
    ] : []),
    ...(role && ["manager", "admin", "reviewer"].includes(role)
      ? [{ label: "Weryfikacja danych", href: "/review", icon: "review" as const, section: "manage" as const }] : []),
    ...(role && ["manager", "admin", "reviewer", "auditor"].includes(role)
      ? [{ label: "Dziennik aktywności", href: "/audit", icon: "audit" as const, section: "manage" as const }] : []),
    ...(role === "admin" ? [
      { label: "Raporty", href: "/reports", icon: "report" as const, section: "manage" as const },
      { label: "Administracja", href: "/admin", icon: "settings" as const, section: "manage" as const },
    ] : []),
    { label: "Moje konto", href: "/account", icon: "account" as const, section: "manage" as const },
  ];

  useEffect(() => { onExpandedChange(expanded); }, [expanded, onExpandedChange]);
  useEffect(() => {
    let active = true;
    fetch("/api/notifications?limit=1", { credentials: "same-origin", cache: "no-store" })
      .then(async (response) => response.ok ? response.json() as Promise<{ unreadCount?: number }> : null)
      .then((payload) => { if (active && payload) setUnreadCount(Number(payload.unreadCount) || 0); })
      .catch(() => undefined);
    return () => { active = false; };
  }, []);
  useEffect(() => {
    function updateCount(event: Event) {
      const count = (event as CustomEvent<unknown>).detail;
      if (typeof count === "number" && Number.isFinite(count)) setUnreadCount(Math.max(0, count));
    }
    window.addEventListener("goldis:notifications-count", updateCount);
    return () => window.removeEventListener("goldis:notifications-count", updateCount);
  }, []);
  useEffect(() => {
    if (!mobileOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    drawerRef.current?.querySelector<HTMLElement>("a,button")?.focus();
    function closeOnEscape(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") setMobileOpen(false);
    }
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", closeOnEscape);
      triggerRef.current?.focus();
    };
  }, [mobileOpen]);

  function trapFocus(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key !== "Tab") return;
    const items = drawerRef.current?.querySelectorAll<HTMLElement>("a,button");
    if (!items?.length) return;
    const first = items[0]; const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  const active = (href: string) => href === "/"
    ? pathname === "/"
    : pathname === href || pathname.startsWith(`${href}/`) || (href === "/my-results" && pathname.startsWith("/my-results/"))
      || (href === "/results/oc-policy-verification" && pathname.startsWith("/results"));
  const renderLinks = (mobile = false) => <>
    <p className="lead-nav-label">PRACA</p>
    <nav aria-label="Główna nawigacja" className="lead-nav">
      {links.filter((link) => link.section === "work").map((link) => <a key={link.href} className={active(link.href) ? "active" : ""}
        href={link.href} title={!mobile && !expanded ? link.label : undefined} aria-label={link.label} aria-current={active(link.href) ? "page" : undefined}
        onClick={() => { if (mobile) setMobileOpen(false); }}><span className="lead-nav-icon"><SidebarIcon name={link.icon} /></span><span className="lead-nav-text">{link.label}</span>{link.href === "/notifications" && unreadCount > 0 && <span className="lead-nav-badge" aria-label={`${unreadCount} nieprzeczytanych`}>{unreadCount > 99 ? "99+" : unreadCount}</span>}</a>)}
    </nav>
    {links.some((link) => link.section === "manage") && <>
      <p className="lead-nav-label lead-manage-label">{role === "admin" || role === "manager" ? "ORGANIZACJA" : "KONTO"}</p>
      <nav aria-label="Zarządzanie" className="lead-nav">
        {links.filter((link) => link.section === "manage").map((link) => <a key={link.href} className={active(link.href) ? "active" : ""}
          href={link.href} title={!mobile && !expanded ? link.label : undefined} aria-label={link.label} aria-current={active(link.href) ? "page" : undefined}
          onClick={() => { if (mobile) setMobileOpen(false); }}><span className="lead-nav-icon"><SidebarIcon name={link.icon} /></span><span className="lead-nav-text">{link.label}</span></a>)}
      </nav>
    </>}
  </>;

  return <>
    <aside className={`lead-sidebar${expanded ? " is-expanded" : " is-collapsed"}`} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
      <a className="lead-brand" href="/dashboard" title={expanded ? undefined : "Goldis"}>
        <img className="lead-logo" src="/brand/goldis-logo.jpg" alt="" />
        <span className="lead-brand-copy"><strong>GOLDIS</strong><small>platforma operacyjna</small></span>
      </a>
      {renderLinks()}
      <div className="lead-sidebar-bottom">
        <button type="button" className="lead-pin-control" onClick={() => { setPinned((value) => !value); setHovered(false); }}
          aria-label={pinned ? "Zwiń nawigację" : "Przypnij rozwiniętą nawigację"} title={pinned ? "Zwiń nawigację" : "Przypnij nawigację"}>
          <SidebarIcon name={pinned ? "collapse" : "expand"} /><span className="lead-nav-text">{pinned ? "Zwiń menu" : "Przypnij menu"}</span>
        </button>
        <span className="lead-role-pill">{roleLabel}</span>
      </div>
    </aside>
    <div className="lead-mobile-bar">
      <a className="lead-mobile-brand" href="/dashboard"><img src="/brand/goldis-logo.jpg" alt="Goldis Ubezpieczenia" /><span>Goldis <small>platforma operacyjna</small></span></a>
      <button ref={triggerRef} type="button" className="lead-mobile-menu-button" aria-label="Otwórz menu nawigacji" aria-expanded={mobileOpen}
        onClick={() => setMobileOpen(true)}><SidebarIcon name="menu" /></button>
    </div>
    {mobileOpen && <div className="lead-mobile-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) setMobileOpen(false); }}>
      <aside ref={drawerRef} className="lead-mobile-drawer" role="dialog" aria-modal="true" aria-label="Nawigacja" onKeyDown={trapFocus}>
        <div className="lead-mobile-drawer-head"><span>Nawigacja</span><button type="button" aria-label="Zamknij menu" onClick={() => setMobileOpen(false)}><SidebarIcon name="close" /></button></div>
        {renderLinks(true)}
        <span className="lead-role-pill">{roleLabel}</span>
      </aside>
    </div>}
  </>;
}
