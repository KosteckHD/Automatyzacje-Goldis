# Goldis MVP — confirmed product brief
<!-- impeccable:product-schema 1 -->

## Platform
web

## Users
Small internal team: employees, managers, administrator. The main persona is the employee. Anyone authorized to execute the automation uploads their own Excel file. Execution and access to results are distinct.

## Product Purpose
Prepare company data, verify OC policies, produce separate Excel files per company, and organize phone follow-up of resulting leads inside the application.

## Operating Context
Dashboard offers recent operations, quick access to tools and results. Results form a shared lead pool, grouped by automation. An employee works only on assigned leads in My Results. Managers assign a requested number of unassigned leads to an employee, themselves or another manager. An assigned lead cannot be transferred or taken back in the MVP. A later run creates a new lead for the same firm; cross-run phone-contact collision control is explicitly out of MVP scope.

## Capabilities and Constraints
- All employees can inspect OC results, source imports and company detail, and download company Excel files.
- Only authorized people can run the automation. The second automation has controlled access; administrator can access it. Its functionality is not specified and is not invented in this prototype.
- After upload, show file inspection. One optional action fills missing REGON from existing NIP as far as external API availability/limits permit.
- Deduplication always runs; identify companies using NIP/REGON and company name. Differences in names with consistent identifiers can be shown for inspection before start. This mockup does not choose new backend identity rules.
- The person launching may correct data before start. Recheck duplicates after edits. Not all records must be valid to start; invalid and duplicate records are explicitly shown as skipped.
- Input for a started run is fixed; later edits require a new run.
- Separate company Excel output retains available phone and email from input.
- Employee lead actions use a status dropdown, without notes or contact history. MVP statuses: Nie kontaktowano, Klient zgadza się na ofertę, Klient niezainteresowany. No extra contact statuses invented.
- Notifications for Wynik gotowy and Wymagane działanie are only for the launching employee, plus operation statuses on dashboard and tasks.
- Manager can run automation, resume tasks, view reports, delete data, grant access and manage employee accounts. They cannot edit administrator or manager accounts or grant elevated roles. Assignment can target employees or managers. No account editing rights follow from assignment eligibility.
- Admin has full organizational management. The new shared-pool, assignment and manager capabilities are desired MVP behavior, not claims that the existing API implements them.

## Brand Commitments
Keep the official Goldis logo, black/gold palette, and the previously supplied Sidebar React component: provider/context, DesktopSidebar, MobileSidebar and SidebarLink; expandable 300px/60px menu. Add keyboard/touch control and reduced-motion support without replacing its structure.

## Evidence on Hand
Existing app code, the original logo in apps/web/public/brand/goldis-logo.jpg, local fonts, the sidebar attachment, user-confirmed answers in this conversation. Prototype datasets are synthetic and labelled.

## Product Principles
Make assigned work immediately visible. Use one lead record for contact status, verified company result and file. Show shared and personal result scopes explicitly. Keep exceptions visible before launching. Keep MVP allocation simple.

## Accessibility & Inclusion
Readable dark-theme contrast, labelled dropdowns, keyboard-accessible sidebar, mobile drawer, visible focus and reduced-motion behavior.
