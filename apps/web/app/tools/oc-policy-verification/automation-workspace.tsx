"use client";

import { useEffect, useRef, type MouseEvent, type ReactNode } from "react";
import type { AutomationStepState } from "./automation-flow";

export const automationStepKeys = [
  "upload",
  "validation",
  "regon",
  "deduplication",
  "selection",
  "launch",
  "progress",
  "results",
] as const;

export type AutomationStep = typeof automationStepKeys[number];

type StepDefinition = {
  key: AutomationStep;
  label: string;
  completeLabel: string;
  emptyLabel: string;
};

const steps: StepDefinition[] = [
  { key: "upload", label: "Plik Excel", completeLabel: "Gotowe", emptyLabel: "Wybierz plik" },
  { key: "validation", label: "Kontrola danych", completeLabel: "Podgląd dostępny", emptyLabel: "Oczekuje na import" },
  { key: "regon", label: "Uzupełnianie REGON", completeLabel: "Dane rejestru dostępne", emptyLabel: "Oczekuje na import" },
  { key: "deduplication", label: "Deduplikacja", completeLabel: "Zestaw przygotowany", emptyLabel: "Oczekuje na dane" },
  { key: "selection", label: "Wybór wierszy", completeLabel: "Wybór zapisany", emptyLabel: "Oczekuje na zestaw" },
  { key: "launch", label: "Podsumowanie i start", completeLabel: "Gotowe do sprawdzenia", emptyLabel: "Oczekuje na wybór" },
  { key: "progress", label: "Postęp zadań", completeLabel: "Zadania dostępne", emptyLabel: "Brak uruchomienia" },
  { key: "results", label: "Wyniki i eksport", completeLabel: "Wyniki dostępne", emptyLabel: "Brak wyników" },
];

export function readAutomationStep(search: string): AutomationStep {
  const query = new URLSearchParams(search);
  const step = query.get("step");
  if (automationStepKeys.includes(step as AutomationStep)) return step as AutomationStep;
  if (query.has("submission") || query.has("execution") || query.has("run")) return "progress";
  if (query.has("resultSetId")) return "results";
  if (query.has("import")) return "validation";
  return "upload";
}

export function automationStepUrl(step: AutomationStep): string {
  const params = new URLSearchParams(window.location.search);
  params.set("step", step);
  const query = params.toString();
  return `${window.location.pathname}${query ? `?${query}` : ""}`;
}

export function OcAutomationWorkspace({
  step,
  onNavigate,
  fileName,
  contextLabel,
  rowCount,
  statuses,
  stepStates,
  children,
}: {
  step: AutomationStep;
  onNavigate: (step: AutomationStep) => void;
  fileName?: string;
  contextLabel?: string;
  rowCount?: number;
  statuses: Partial<Record<AutomationStep, string>>;
  stepStates?: Partial<Record<AutomationStep, AutomationStepState>>;
  children: ReactNode;
}) {
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const activeIndex = steps.findIndex((item) => item.key === step);
  const active = steps[activeIndex] ?? steps[0];

  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, [step]);

  function navigate(event: MouseEvent<HTMLAnchorElement>, next: AutomationStep) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onNavigate(next);
  }

  const previous = steps[activeIndex - 1];
  const next = steps[activeIndex + 1];

  return <main className="oc-automation">
    <div className="oc-automation-heading">
      <div>
        <p className="oc-automation-breadcrumb">Automatyzacje <span aria-hidden="true">/</span> Sprawdzanie OC</p>
        <h1>Sprawdzanie OC</h1>
        <p>Pracuj na jednym etapie. Do pozostałych wrócisz w każdej chwili.</p>
      </div>
      <a className="oc-history-link" href="/imports">Historia importów <span aria-hidden="true">↗</span></a>
    </div>

    <section className="oc-import-context" aria-label="Bieżący import">
      <span className="oc-context-file" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6zM14 3v5h5M9 12h6M9 16h6" /></svg></span>
      {fileName ? <><strong className="oc-context-name" title={fileName}>{fileName}</strong><span className="oc-context-divider oc-context-desktop-meta" aria-hidden="true" /><span className="oc-context-desktop-meta">Arkusz „Realizacja”</span>
        {typeof rowCount === "number" && <><span className="oc-context-divider oc-context-desktop-meta" aria-hidden="true" /><span className="oc-context-desktop-meta">{rowCount.toLocaleString("pl-PL")} wierszy</span></>}
        <details className="oc-context-details"><summary>Szczegóły pliku</summary><p>{fileName} · arkusz „Realizacja”{typeof rowCount === "number" ? ` · ${rowCount.toLocaleString("pl-PL")} wierszy` : ""}</p></details>
      </> : contextLabel ? <strong className="oc-context-name">{contextLabel}</strong> : <span className="oc-context-empty">Nie wybrano jeszcze pliku</span>}
      {fileName && <a className="oc-context-change" href={automationStepUrl("upload")} onClick={(event) => navigate(event, "upload")}>Zmień plik</a>}
    </section>

    <div className="oc-automation-layout">
      <details className="oc-step-picker">
        <summary>Krok {activeIndex + 1} z 8 <strong>{active.label}</strong></summary>
        <StepList step={step} onNavigate={onNavigate} navigate={navigate} statuses={statuses} stepStates={stepStates} />
      </details>
      <aside className="oc-step-rail" aria-label="Kroki automatyzacji">
        <h2>Kroki automatyzacji</h2>
        <StepList step={step} onNavigate={onNavigate} navigate={navigate} statuses={statuses} stepStates={stepStates} />
        <p className="oc-step-rail-note">Wybierz dowolny krok, aby zobaczyć szczegóły.</p>
      </aside>

      <section className="oc-step-panel" aria-labelledby="oc-active-step-heading">
        <div className="oc-step-panel-heading">
          <div>
            <p className="oc-step-counter">Krok {activeIndex + 1} z 8</p>
            <h2 id="oc-active-step-heading" ref={headingRef} tabIndex={-1}>{active.label === "Plik Excel" ? "Dodaj bazę transportową" : active.label}</h2>
          </div>
        </div>
        <div className="oc-step-panel-content">{children}</div>
      </section>
    </div>

    <footer className="oc-step-footer">
      {previous
        ? <a className="oc-step-footer-back" href={automationStepUrl(previous.key)} onClick={(event) => navigate(event, previous.key)}><span aria-hidden="true">←</span> Wstecz: {previous.label.toLocaleLowerCase("pl-PL")}</a>
        : <a className="oc-step-footer-back" href="/tools"><span aria-hidden="true">←</span> Wróć do automatyzacji</a>}
      <p className="oc-step-footer-note">Przejście do kolejnego kroku nie uruchamia portali.</p>
      {step === "selection" ? <span aria-hidden="true" /> : next
        ? <a className="oc-step-footer-next" href={automationStepUrl(next.key)} onClick={(event) => navigate(event, next.key)}>Otwórz etap: {next.label.toLocaleLowerCase("pl-PL")} <span aria-hidden="true">→</span></a>
        : <a className="oc-step-footer-back oc-step-footer-return" href={automationStepUrl("upload")} onClick={(event) => navigate(event, "upload")}>Wróć do automatyzacji <span aria-hidden="true">→</span></a>}
    </footer>
  </main>;
}

function StepList({
  step,
  statuses,
  stepStates,
  onNavigate,
  navigate,
}: {
  step: AutomationStep;
  statuses: Partial<Record<AutomationStep, string>>;
  stepStates?: Partial<Record<AutomationStep, AutomationStepState>>;
  onNavigate: (step: AutomationStep) => void;
  navigate: (event: MouseEvent<HTMLAnchorElement>, step: AutomationStep) => void;
}) {
  return <nav className="oc-step-list" aria-label="Przejdź do kroku">
    {steps.map((item, index) => {
      const current = item.key === step;
      const status = statuses[item.key] ?? "Stan nieznany";
      const state = current ? "current" : stepStates?.[item.key] ?? "upcoming";
      return <a
        className="oc-step-link"
        data-current={current ? "true" : undefined}
        data-state={state}
        href={automationStepUrl(item.key)}
        key={item.key}
        aria-current={current ? "step" : undefined}
        onClick={(event) => navigate(event, item.key)}
      >
        <span className="oc-step-number" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
        <span className="oc-step-link-copy"><strong>{item.label}</strong><small>{status}</small></span>
        <span className="oc-step-chevron" aria-hidden="true" />
      </a>;
    })}
  </nav>;
}
