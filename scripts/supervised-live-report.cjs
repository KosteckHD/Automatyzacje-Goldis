"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");

const ROW_NUMBERS = Object.freeze(Array.from({ length: 101 }, (_, i) => 18000 + i));
const TERMINAL = new Set(["completed", "failed", "no_matching_policies", "cancelled", "identity_review", "waiting_for_manual_data"]);
const REASONS = {
  IDENTITY_NOT_FOUND: "Nie znaleziono wymaganej osoby w Everest; wynik wymaga kontroli braku dopasowania.",
  IDENTITY_EXPECTED_PERSON_MISSING: "W wynikach Everest brakuje rekordu osoby fizycznej wymaganego do odczytu PESEL; bez przejścia do Compensy.",
  IDENTITY_PESEL_MISSING: "Znaleziono osobę, ale portal nie udostępnił PESEL; bez przejścia do Compensy.",
  IDENTITY_PESEL_INVALID: "PESEL odczytany z portalu nie przeszedł walidacji; bez przejścia do Compensy.",
  IDENTITY_UNSUPPORTED_TYPE: "Wyniki Everest dotyczą typu podmiotu nieobsługiwanego przez bieżący automat.",
  IDENTITY_AMBIGUOUS: "Dopasowanie osoby nie jest jednoznaczne; potrzebna decyzja operatora.",
  IDENTITY_MISMATCH: "Dane osoby nie zgadzają się ze źródłem.",
  PESEL_INVALID: "Portal zwrócił nieprawidłowy PESEL.",
  INPUT_INVALID: "Dane wejściowe nie spełniają wymagań uruchomienia.",
  MANUAL_DATA_REQUIRED: "Formularz Compensy wymaga danych albo kontroli dostępnej akcji.",
  PORTAL_FAILURE: "Błąd odczytu lub działania portalu; potrzebna diagnostyka techniczna.",
  PORTAL_SCHEMA_CHANGED: "Automat nie rozpoznał oczekiwanego ekranu lub elementu portalu.",
  PORTAL_SESSION_EXPIRED: "Sesja portalu wygasła albo dostęp został odrzucony.",
  OFFER_SAVE_UNCONFIRMED: "Nie potwierdzono wyniku zapisu oferty; nie ponawiać zapisu bez uzgodnienia.",
  UFG_INCOMPLETE: "Liczba odczytanych polis nie zgadza się z licznikiem UFG.",
  COVERAGE_DATE_INVALID: "Nie można prawidłowo odczytać daty ochrony polisy.",
  NO_NIP_OR_REGON: "Brak NIP i REGON w źródle.",
  REGON_LOOKUP_REQUIRED: "Potrzebne uzupełnienie REGON z rejestru; dostawca rejestru w tym teście jest wyłączony.",
  PORTAL_ACTION_REVIEW: "Nie potwierdzono oczekiwanego stanu formularza lub dostępnej akcji.",
  POSTAL_CODE: "Brakuje wymaganego kodu pocztowego.",
  COUNTY: "Brakuje poprawnego powiatu lub nie ma go na liście portalu.",
  ADDRESS: "Brakuje wymaganego adresu.",
  CITY: "Brakuje wymaganej miejscowości.",
};
function explain(code) { return REASONS[code] || (code ? `Kod wymagający sprawdzenia: ${code}.` : "Brak szczegółowego kodu przyczyny."); }
function classify(row) {
  if (row.status === "completed") return row.artifactVerified ? "EKSPORT_ZWERYFIKOWANY" : "WERYFIKACJA_EKSPORTU";
  if (row.status === "no_matching_policies") return "BRAK_POLIS_SPELNIAJACYCH_FILTR";
  if (row.status === "not_started") return "NIEURUCHOMIONY";
  if (row.status === "input_review") return "DANE_DO_SPRAWDZENIA";
  if (row.status === "duplicate") return "DUPLIKAT";
  if (row.errorCode === "IDENTITY_NOT_FOUND") return "BRAK_DOPASOWANIA_DO_KONTROLI";
  if (["IDENTITY_EXPECTED_PERSON_MISSING", "IDENTITY_PESEL_MISSING", "IDENTITY_PESEL_INVALID", "IDENTITY_UNSUPPORTED_TYPE"].includes(row.errorCode)) return "BRAK_WYMAGANEJ_TOZSAMOSCI";
  if (row.status === "identity_review" || row.errorCode === "IDENTITY_AMBIGUOUS") return "DECYZJA_OPERATORA";
  if (row.status === "waiting_for_sms") return "OCZEKUJE_NA_SMS";
  if (row.status === "cancelled") return "ANULOWANY";
  if (row.status === "failed" || row.status === "waiting_for_manual_data") return "ZATRZYMANY";
  return "W_TRAKCIE";
}
function shouldStop(row) {
  // The next record must never be used as a retry of a failed portal operation.
  return row.status === "waiting_for_manual_data" || row.status === "identity_review"
    || (row.status === "failed" && row.errorCode !== "IDENTITY_NOT_FOUND" && row.errorCode !== "INPUT_INVALID")
    || row.status === "verification_failed";
}
function summary(rows) {
  const counts = {};
  for (const row of rows) { const key = classify(row); counts[key] = (counts[key] || 0) + 1; }
  return counts;
}
const escapeMd = v => String(v ?? "").replace(/[|\r\n]/g, " ");
async function writeReport(directory, report) {
  report.updatedAt = new Date().toISOString();
  report.summary = summary(report.rows);
  report.allRowsAccountedFor = report.rows.length === ROW_NUMBERS.length && ROW_NUMBERS.every(n => report.rows.some(r => r.rowNumber === n));
  const json = path.join(directory, "report.json");
  await fs.writeFile(json + ".tmp", JSON.stringify(report, null, 2));
  await fs.rename(json + ".tmp", json);
  const lines = ["# Nadzorowany test wierszy 18000–18100", "", `Stan: ${report.state}. Aktualizacja: ${report.updatedAt}.`, "",
    "Tryb: rzeczywiste API → kolejka → główny worker → portale → wynik → pobrany XLSX. Wiersze są uruchamiane pojedynczo. Ręczne dokończenie nie jest zaliczane jako pełny przebieg automatu.", "",
    "| Wiersz | Wynik | Etap | Przyczyna | Polisy UFG / eksport | Excel |", "| --- | --- | --- | --- | --- | --- |"];
  for (const row of report.rows) {
    const artifact = row.artifactFile ? `[Pobierz](${encodeURI(row.artifactFile)})` : "—";
    lines.push(`| ${row.rowNumber} | ${classify(row)} | ${escapeMd(row.lastPortalStage || row.currentStep || "—")} | ${escapeMd(row.reason || "Jeszcze nie wykonano próby.")} | ${row.totalOcCount ?? "—"} / ${row.exportedPolicyCount ?? "—"} | ${artifact} |`);
  }
  lines.push("", "## Podsumowanie", "", ...Object.entries(report.summary).map(([k,v])=>`- ${k}: ${v}`), "", "Nieuruchomione wiersze nie są wynikami negatywnymi. Brak dopasowania wymaga kontroli; nie jest automatycznie zaliczonym przypadkiem biznesowym.");
  if (report.stopReason) lines.push("", `Zatrzymanie: ${escapeMd(report.stopReason)}`);
  await fs.writeFile(path.join(directory, "RAPORT.md"), lines.join("\n") + "\n");
}
module.exports = { ROW_NUMBERS, TERMINAL, explain, classify, shouldStop, summary, writeReport };
