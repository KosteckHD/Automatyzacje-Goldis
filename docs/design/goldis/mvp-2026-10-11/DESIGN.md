---
name: Goldis MVP mockup
description: Matte charcoal, warm gold and readable operational rows for the isolated Goldis prototype.
colors:
  canvas: "#111213"
  sidebar: "#0b0c0d"
  surface: "#191b1e"
  surface-raised: "#202226"
  border: "#35373c"
  text: "#f1f0ec"
  muted: "#a8a9ae"
  gold: "#d9b66f"
  gold-hover: "#e6c987"
  success: "#a4d7b9"
  warning: "#ecc18a"
  information: "#a9c9ea"
  primary-ink: "#17140e"
  navigation-text: "#b6b7bc"
  navigation-hover: "#1b1d20"
  navigation-active: "#26221a"
  badge-background: "#2a2c31"
  badge-text: "#c6c7cd"
  badge-border: "#3c3e44"
  success-background: "#1e3027"
  success-border: "#365541"
  warning-background: "#362a1d"
  warning-border: "#5e4930"
  information-background: "#202d3d"
  information-border: "#3f5064"
  allocation-background: "#1e1c18"
  allocation-border: "#6d5938"
  contact-background: "#222429"
  danger-text: "#eab5b3"
  danger-border: "#754342"
  danger-background: "#302020"
typography:
  display:
    fontFamily: "Hanken, Arial, sans-serif"
    fontSize: "47px"
    fontWeight: 650
    lineHeight: 1.1
    letterSpacing: "-0.6px"
  headline:
    fontFamily: "Hanken, Arial, sans-serif"
    fontSize: "30px"
    fontWeight: 650
    lineHeight: 1.2
    letterSpacing: "-0.6px"
  headline-mobile:
    fontFamily: "Hanken, Arial, sans-serif"
    fontSize: "26px"
    fontWeight: 650
    lineHeight: 1.2
    letterSpacing: "-0.4px"
  title:
    fontFamily: "Hanken, Arial, sans-serif"
    fontSize: "18px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.2px"
  body:
    fontFamily: "Hanken, Arial, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Hanken, Arial, sans-serif"
    fontSize: "13px"
    fontWeight: 550
    lineHeight: 1.5
  small:
    fontFamily: "Hanken, Arial, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  badge: "4px"
  control: "6px"
  surface: "8px"
  avatar: "50%"
spacing:
  field-gap: "8px"
  control-gap: "12px"
  compact-inset: "16px"
  panel-inset: "20px"
  section-inset: "22px"
  layout-gap: "24px"
  heading-gap: "28px"
  page-inset: "32px"
  form-gap: "36px"
  wide-page-inset: "40px"
components:
  button-primary:
    backgroundColor: "{colors.gold}"
    textColor: "{colors.primary-ink}"
    rounded: "{rounded.control}"
    padding: "10px 15px"
  button-primary-hover:
    backgroundColor: "{colors.gold-hover}"
  button-secondary:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    padding: "10px 15px"
  button-danger:
    backgroundColor: "{colors.danger-background}"
    textColor: "{colors.danger-text}"
    rounded: "{rounded.control}"
    padding: "10px 15px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    padding: "8px 12px"
  navigation:
    textColor: "{colors.navigation-text}"
    rounded: "{rounded.control}"
    padding: "12px 10px"
  navigation-active:
    backgroundColor: "{colors.navigation-active}"
    textColor: "{colors.gold}"
  badge:
    backgroundColor: "{colors.badge-background}"
    textColor: "{colors.badge-text}"
    rounded: "{rounded.badge}"
    padding: "4px 7px"
  badge-success:
    backgroundColor: "{colors.success-background}"
    textColor: "{colors.success}"
    rounded: "{rounded.badge}"
    padding: "4px 7px"
  container:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.surface}"
  allocation-panel:
    backgroundColor: "{colors.allocation-background}"
    rounded: "{rounded.surface}"
    padding: "{spacing.panel-inset}"
  contact-status:
    backgroundColor: "{colors.contact-background}"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    padding: "7px 8px"
---

# Design System: Goldis MVP mockup

## Overview

The confirmed direction is matte near-black, layered charcoal, warm champagne gold, quiet hairlines and local Hanken Grotesk. This is an operational interface with dense, readable rows. The official Goldis wordmark and the supplied Sidebar structure remain the identity anchors.

This document applies only to `docs/design/goldis/mvp-2026-10-11`. It captures the standalone prototype's current CSS and React behavior. It does not establish production API capabilities or a shipping verdict. `PRODUCT.md` owns product truth; `SURFACE_BRIEF.md` owns this surface's composition. The frontmatter records extracted values; the sidecar records extensions and representative static component snippets.

**Key Characteristics:**

- Matte near-black canvas and layered charcoal containers.
- Warm champagne gold for primary actions and active navigation.
- Dense but readable rows with explicit personal and shared scopes.
- Original logo, local type and the authored Sidebar architecture.
- Labelled controls, visible focus and reduced-motion support.

## Colors

The palette combines a warm gold accent with quiet neutral layers. The frontmatter is the normative color inventory.

### Primary

- **Warm champagne gold:** `gold` marks primary buttons, selected navigation, selected tabs, key counts and focus outlines. `gold-hover` supplies the primary button hover state.
- **Warm ink:** `primary-ink` supplies dark text on filled gold controls and the browser selection foreground.

### Neutral

- **Matte near-black:** `canvas` is the workspace background; `sidebar` creates a deeper navigation plane.
- **Layered charcoal:** `surface` contains rows, fields and sections; `surface-raised` supports secondary actions. `border` defines quiet hairlines.
- **Warm readable text:** `text` carries primary content; `muted` carries secondary metadata. Navigation has its own default, hover and selected tones.
- **Quiet badge neutrals:** the `badge-*` tokens support unassigned and non-semantic labels.
- **Warm allocation plane:** `allocation-background` and `allocation-border` distinguish the manager's assignment context without competing with the table.

### Semantic feedback

Success, warning and information each have a text tone, subdued background and border. They accompany written status labels and icons. Contact outcomes use success for agreement and warning for lack of interest. Gold remains the action/selection accent.

**The Written Status Rule.** Color accompanies a written state; it never replaces the state label.

## Typography

**Display and body font:** local Hanken Grotesk, registered as `Hanken`, with Arial and sans-serif fallbacks. The variable font covers weights (100–900), with `font-display: swap`.

Type is compact and calm. Hanken supplies headings, controls and metadata; there is no second display family or monospaced identity. Table values and headline counts use tabular numerals.

### Hierarchy

- **Display:** the login illustration's text uses the `display` role; this copy is hidden on mobile.
- **Headline:** page headings use `headline`, switching to `headline-mobile` at the mobile breakpoint.
- **Title:** ordinary section headings use `title`; section headers specifically reduce the size to (16px), while tool and results headings have local larger sizes.
- **Body:** default text uses `body`; tables and operational metadata commonly use (13px).
- **Label:** field captions use `label`. Button text uses inherited (14px) and weight (550).
- **Small:** subordinate identifiers, hints and badges use `small`; badges tighten line height to (1.2).

**The Numeric Rhythm Rule.** Keep tabular numerals in data cells and operational counts so scanning is stable as values change.

## Layout

The shell places navigation beside a flexible workspace with `min-width: 0`. Desktop navigation is sticky and viewport height. Content is capped at (1800px), with the standard page inset from `page-inset`; at widths of (1600px) and above it uses `wide-page-inset`.

The supplied Sidebar preserves provider/context, `DesktopSidebar`, `MobileSidebar` and `SidebarLink`. Desktop starts pinned and expanded at (300px). Unpinning enables the authored (300px)/(60px) hover expansion. A labelled button toggles pinned expansion for keyboard and touch interaction. The profile remains in the sidebar footer. Hash anchors substitute for Next Link in this isolated prototype.

The shared lead layout adds an allocation column of (290px), growing to (320px) at (1600px). At (1250px) and below it becomes one column, with allocation first as a compact three-column panel. Dashboard and form grids also reduce their columns. These are implementation breakpoints, not device classifications.

At (767px) and below, desktop navigation is hidden. A (58px) mobile bar opens a full-viewport drawer. Main content uses (24px 18px) padding. Headings/actions stack; metrics form two columns; personal/shared lead tables become stacked cards. Other wide tables retain horizontal scrolling with an explicit Polish scrolling hint. The allocation panel stacks and restores its recipient hint, preview and fixed-assignment footnote.

Desktop lead rows use (17px 14px) cell padding and headers (13px 14px). Opening allocation hides the desktop contact and OC-result columns to fit the working context; mobile restores them. Filters wrap, while tables retain overflow containment. The fixed prototype toolbar is review infrastructure, with footer clearance (96px desktop, 150px mobile).

## Elevation & Depth

Tonal layers and one-pixel strokes provide the normal hierarchy. Content sections, tables, fields and the allocation pane have no resting shadow. Shadows are limited to the fixed prototype toolbar (`0 -6px 24px #0005`) and feedback toast (`0 8px 30px #0005`). The mobile drawer establishes its plane by covering the viewport.

**The Tonal Layer Rule.** Use charcoal surface differences and hairlines for ordinary containers; reserve the existing shadows for fixed review controls and transient feedback.

## Shapes

Containers use the `surface` radius, controls/navigation use `control`, and badges use `badge`. Avatars are circular. Borders are usually (1px); the upload zone uses a dashed stroke. Compact icon buttons use a local radius (5px), and tool symbols use (10px). These local values do not replace the recurring radius scale.

Fields retain native select arrows and familiar checkbox/switch form behavior. Browser selection uses the primary gold and warm ink. Scrollbars use a thin charcoal track and subdued warm thumb.

## Components

### Buttons

Filled gold marks the main action; secondary buttons use raised charcoal and a border. Both have a minimum height (42px), a (9px) internal gap and the frontmatter padding/radius. Primary hover uses `gold-hover`; secondary hover uses `#2d3035`. Destructive actions use muted red text (`#eab5b3`), stroke (`#754342`) and background (`#302020`). Disabled buttons use opacity (.5) and a not-allowed cursor.

### Inputs / Fields

Fields use a visible label, an (8px) gap and a native input/select with a minimum height (40px). The search field wraps its icon and input in one stroke, using `:focus-within`. Global focus is a gold (2px) outline with (4px) offset; the search wrapper uses (3px). Validation text is adjacent and allocation errors have `role="alert"`.

### Navigation

Links use an icon, a (13px) gap and a minimum height (46px). Active links have a warm dark fill and gold text/icon. Hover uses a lighter charcoal fill and primary text. Reduced motion sets desktop/drawer transition durations to zero; ordinary Sidebar expansion uses (.2s) and label reveal (.15s).

The mobile drawer declares `role="dialog"`, `aria-modal="true"` and a navigation label. Opening focuses the first button/link and locks body scrolling. Tab/Shift+Tab wrap between its first and last focusable controls; Escape closes it. Close/navigation restores focus to the trigger. Its menu/close buttons are (44px) square. These describe implemented behavior; this document does not claim an independent accessibility certification.

### Chips / Status badges

Compact badges carry written labels and semantic icons, with a one-pixel border, `badge` radius and frontmatter padding. Default badges indicate unassigned/neutral states; success/warning/information variants express written operation states. Long badge labels can wrap in the allocation context and mobile results entries.

### Cards / Containers

Normal sections use `surface`, a border and `surface` radius. Section headers use (20px 22px) padding. Mobile lead cards use (16px) inset and (12px) separation. They preserve identifiers, contact details, verification information, status and file/detail actions from the desktop rows.

### Contact status

Only a lead's assigned person receives an editable native status dropdown, including in the shared pool, My Results and detail view. Other leads show read-only badges or fields. The dropdown has exactly three outcomes: `Nie kontaktowano`, `Klient zgadza się na ofertę`, `Klient niezainteresowany`. Agreement and lack of interest use success/warning text and border treatments. There are no notes or contact-history controls.

### Allocation pane

Managers and administrators can open the warm allocation plane from shared results. A native recipient select offers an employee, the current manager or another manager. Quantity is validated as an integer from one through the free lead count. Successful allocation updates only unassigned records and closes the panel. The preview names the recipient and describes My Results; the footnote states that assignment stays fixed in this MVP. The prototype offers no reassign/reclaim action.

### Import and source state

Editable pre-start preparation and read-only source inspection are visibly distinct. Source links open preparation with the read-only state and run context. Started input is fixed; later edits require a new run. The prototype demonstrates inspection, optional REGON enrichment, mandatory deduplication and an explicit launch summary; backend/API identity rules are outside this document.

### Role-distinct administration

Employees see operational navigation and personal work. Managers additionally see employees, access and reports; account editing is limited to employees and the role select is disabled. Administrators additionally see automation settings, monitoring and audit, and can manage elevated account roles. Recipient eligibility does not grant account-editing rights. Launcher-only notifications are filtered by the current person's task ownership. Role selection and settings feedback remain prototype demonstrations.

### Feedback and switches

Toasts use `role="status"`, appear above the fixed toolbar and clear after (3500ms). Native checkbox switches use a (38px × 22px) track and (16px) thumb, gold checked state and a focus outline. A skip link focuses the main content. CSS removes transitions/animations under `prefers-reduced-motion`; Framer Motion also follows the user's preference.

## Do's and Don'ts

### Do:

- **Do** preserve the official Goldis logo, local Hanken and the pinned matte charcoal/gold direction.
- **Do** retain the supplied Sidebar provider/context and desktop/mobile/link structure.
- **Do** show personal/shared scope explicitly and preserve a written label for every status.
- **Do** keep focus visible, labels specific and mobile table content reachable.
- **Do** preserve the own-assignee status rule and employee-only manager account editing.
- **Do** keep this documentation and all prototype behavior confined to the mockup artifact.

### Don't:

- **Don't** introduce a replacement visual identity or a new font pairing.
- **Don't** invent additional contact outcomes, notes or contact-history controls.
- **Don't** conflate shared-result visibility with permission to run an automation.
- **Don't** expose source editing for a started run or offer reassignment in this MVP.
- **Don't** treat the mockup, static component snippets or documentation as proof of production API support or a shipping verdict.
