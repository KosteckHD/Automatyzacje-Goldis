import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveEverestIdentity, type EverestCandidate } from "./identity";

const input = { regon: "012345678", companyName: "Firma Transportowa", decisionMakerName: "Jan Przykładowy" };
const business: EverestCandidate = { kind: "sole_proprietor", regon: "012345678", companyName: "Firma Transportowa", personName: "Jan Przykładowy", pesel: "00210123454" };

test("wybiera działalność po REGON, nazwie i osobie, ignorując wynik osoby fizycznej", () => {
  const person: EverestCandidate = { ...business, kind: "person", regon: null, companyName: null };
  assert.deepEqual(resolveEverestIdentity(input, [person, business]), { ok: true, personName: "Jan Przykładowy", pesel: "00210123454" });
});

test("pusta osoba decyzyjna jest dopuszczalna tylko przy jednym potwierdzonym wyniku", () => {
  assert.equal(resolveEverestIdentity({ ...input, decisionMakerName: null }, [business]).ok, true);
  assert.deepEqual(resolveEverestIdentity({ ...input, decisionMakerName: null }, [business, business]), { ok: false, code: "IDENTITY_AMBIGUOUS" });
});

test("rozbieżna firma lub osoba zatrzymuje przepływ przed Compensą", () => {
  assert.deepEqual(resolveEverestIdentity(input, [{ ...business, companyName: "Inna Firma" }]), { ok: false, code: "IDENTITY_MISMATCH" });
  assert.deepEqual(resolveEverestIdentity(input, [{ ...business, personName: "Inna Osoba" }]), { ok: false, code: "IDENTITY_MISMATCH" });
  assert.deepEqual(resolveEverestIdentity(input, [{ ...business, regon: "999999999" }]), { ok: false, code: "IDENTITY_NOT_FOUND" });
});

test("brak pełnego PESEL nie jest uzupełniany z innego konta", () => {
  assert.deepEqual(resolveEverestIdentity(input, [{ ...business, pesel: null }]), { ok: false, code: "PESEL_INVALID" });
});

test("nieznany typ konta nie jest uznawany za działalność gospodarczą", () => {
  assert.deepEqual(resolveEverestIdentity(input, [{ ...business, kind: "unknown" }]), { ok: false, code: "IDENTITY_MISMATCH" });
});

test("niepełne imię osoby wymaga kontroli zamiast tworzenia kontraktu tożsamości", () => {
  assert.deepEqual(resolveEverestIdentity(input, [{ ...business, personName: "" }]), { ok: false, code: "IDENTITY_MISMATCH" });
});
