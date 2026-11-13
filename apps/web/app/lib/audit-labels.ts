const actionLabels: Record<string, string> = {
  "login.succeeded": "Zalogowano",
  "login.failed": "Nieudana próba logowania",
  "logout.succeeded": "Wylogowano",
  "session.revoked": "Cofnięto sesję",
  "password.changed": "Zmieniono hasło",
  "import.created": "Dodano import",
  "import.preparation.started": "Rozpoczęto przygotowanie importu",
  "import.preparation.completed": "Zakończono przygotowanie importu",
  "regon.correction.proposed": "Zaproponowano korektę REGON",
  "regon.correction.reviewed": "Rozpatrzono korektę REGON",
  "entity.conflict.reviewed": "Rozpatrzono konflikt grupowania",
  "lead.allocated": "Przydzielono firmę",
  "lead.assignment.released": "Zwolniono przydział firmy",
  "lead.status.updated": "Zmieniono status firmy",
  "run.created": "Utworzono zadanie",
  "run.cancelled": "Anulowano zadanie",
  "run.pause_requested": "Wstrzymano zadania",
  "run.resumed_from_pause": "Wznowiono zadania",
  "run.submission.created": "Utworzono zgłoszenie zadań",
  "artifact.downloaded": "Pobrano plik wynikowy",
  "intervention.assigned": "Przydzielono interwencję",
  "intervention.unassigned": "Usunięto przydział interwencji",
  "intervention.priority_changed": "Zmieniono priorytet interwencji",
  "intervention.resolved": "Rozwiązano interwencję",
  "user.created": "Utworzono konto",
  "user.updated": "Zmieniono konto",
  "tool.grant.created": "Przyznano dostęp do narzędzia",
  "tool.grant.updated": "Zmieniono dostęp do narzędzia",
  "tool.grant.revoked": "Odebrano dostęp do narzędzia",
  "settings.updated": "Zmieniono ustawienia",
};

const resourceLabels: Record<string, string> = {
  import: "Import",
  run: "Zadanie",
  artifact: "Plik wynikowy",
  user: "Konto użytkownika",
  session: "Sesja",
  tool: "Narzędzie",
  intervention: "Interwencja",
  correction: "Korekta REGON",
  entity_conflict: "Konflikt grupowania",
  enrichment_job: "Wzbogacenie REGON",
  settings: "Ustawienia",
  preparation_workflow: "Przygotowanie importu",
  submission: "Zgłoszenie",
  challenge: "Weryfikacja logowania",
};

function humanize(code: string): string {
  return code.replace(/[._-]+/g, " ").trim().replace(/\b\p{L}/gu, (letter) => letter.toLocaleUpperCase("pl-PL"));
}

export function auditActionLabel(action: string): string {
  return actionLabels[action] ?? `Zdarzenie: ${humanize(action)}`;
}

export function auditResourceLabel(resourceType: string): string {
  return resourceLabels[resourceType] ?? `Zasób: ${humanize(resourceType)}`;
}

export function compactAuditId(resourceId: string | null): string {
  return resourceId ? `${resourceId.slice(0, 8)}…` : "—";
}
