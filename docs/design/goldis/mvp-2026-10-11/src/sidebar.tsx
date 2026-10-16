"use client";

// Adaptation of the user's supplied Sidebar. Component API/context and 300/60px
// expansion are preserved. Next Link becomes a normal anchor for this mockup.
import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Menu, X } from 'lucide-react';

const cn = (...values: (string | undefined | false)[]) => values.filter(Boolean).join(' ');
interface Links { label: string; href: string; icon: React.ReactNode }
interface SidebarContextProps { open: boolean; setOpen: React.Dispatch<React.SetStateAction<boolean>>; animate: boolean }
const SidebarContext = createContext<SidebarContextProps | undefined>(undefined);
export function useSidebar() { const c = useContext(SidebarContext); if (!c) throw new Error('useSidebar requires SidebarProvider'); return c; }
export function SidebarProvider({children, open: controlled, setOpen: setter, animate = true}: {children: React.ReactNode; open?: boolean; setOpen?: React.Dispatch<React.SetStateAction<boolean>>; animate?: boolean}) {
  const [state, setState] = useState(false);
  return <SidebarContext.Provider value={{open: controlled ?? state, setOpen: setter ?? setState, animate}}>{children}</SidebarContext.Provider>;
}
export function Sidebar(props: React.ComponentProps<typeof SidebarProvider>) { return <SidebarProvider {...props}/>; }
export function SidebarBody(props: React.ComponentProps<typeof motion.div>) { return <><DesktopSidebar {...props}/><MobileSidebar className={props.className}>{props.children}</MobileSidebar></>; }
export function DesktopSidebar({className, children, ...props}: React.ComponentProps<typeof motion.div>) {
  const {open, setOpen, animate} = useSidebar(); const reduced = useReducedMotion();
  return <motion.aside className={cn('desktop-sidebar', className)} animate={{width: animate ? (open ? 300 : 60) : 300}} transition={{duration: reduced ? 0 : .2}} onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)} {...props}>{children}</motion.aside>;
}
export function MobileSidebar({className, children}: {className?: string; children: React.ReactNode}) {
  const {open, setOpen} = useSidebar(); const reduced = useReducedMotion(); const ref = useRef<HTMLDivElement>(null); const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (open && window.innerWidth < 768) { ref.current?.querySelector<HTMLElement>('button,a')?.focus(); const previous = document.body.style.overflow; document.body.style.overflow='hidden'; return () => {document.body.style.overflow=previous; trigger.current?.focus();}; } }, [open]);
  function trap(e: React.KeyboardEvent) { if (e.key === 'Escape') setOpen(false); if (e.key !== 'Tab') return; const items = ref.current?.querySelectorAll<HTMLElement>('a,button,select,input'); if (!items?.length) return; const first=items[0], last=items[items.length-1]; if(e.shiftKey && document.activeElement===first){e.preventDefault();last.focus();} else if(!e.shiftKey && document.activeElement===last){e.preventDefault();first.focus();} }
  return <><div className="mobile-bar"><span>Goldis</span><button ref={trigger} aria-label="Otwórz menu" aria-expanded={open} onClick={() => setOpen(true)}><Menu size={22}/></button></div><AnimatePresence>{open && <motion.div ref={ref} role="dialog" aria-modal="true" aria-label="Nawigacja" onKeyDown={trap} className={cn('mobile-sidebar',className)} initial={{x:'-100%'}} animate={{x:0}} exit={{x:'-100%'}} transition={{duration:reduced ? 0 : .2}}><button className="mobile-close" aria-label="Zamknij menu" onClick={() => setOpen(false)}><X size={22}/></button>{children}</motion.div>}</AnimatePresence></>;
}
export function SidebarLink({link, className, onClick, ...props}: {link: Links; className?: string} & React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  const {open, animate, setOpen} = useSidebar(); const reduced=useReducedMotion();
  return <a href={link.href} title={link.label} aria-label={link.label} className={cn('sidebar-link',className)} onClick={e=>{onClick?.(e);if(window.innerWidth<768)setOpen(false);}} {...props}>{link.icon}<motion.span animate={{display:animate && !open?'none':'inline-block',opacity:animate && !open?0:1}} transition={{duration:reduced?0:.15}}>{link.label}</motion.span></a>;
}
