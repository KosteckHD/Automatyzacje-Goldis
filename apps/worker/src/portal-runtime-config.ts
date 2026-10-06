import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { PortalSessionSelectors } from "./portal-session";
import type { EverestResultSelectors } from "./everest-identity-provider";
import type { CompensaFormSelectors } from "./compensa-form";
import type { CompensaOfferSaveSelectors } from "./compensa-offer-saver";

export type PortalRuntimeConfig = Readonly<{
  pzu: Readonly<{
    entryUrl: string;
    allowedOrigins: readonly string[];
    session: PortalSessionSelectors;
    everest: EverestResultSelectors;
    adapterVersion: string;
  }>;
  compensa: Readonly<{
    entryUrl: string;
    allowedOrigins: readonly string[];
    session: PortalSessionSelectors;
    form: CompensaFormSelectors;
    save: CompensaOfferSaveSelectors;
    ufg: Readonly<{ caseReference: string; verifyUfgButton: string; summaryTable: string; openUfgSummary: string }>;
    registrationNumber: string;
    adapterVersion: string;
    parserVersion: string;
  }>;
}>;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("PORTAL_CONFIG_INVALID");
  return value as Record<string, unknown>;
}

function strings(value: unknown, names: readonly string[]): Record<string, string> {
  const record = object(value);
  for (const name of names) {
    if (typeof record[name] !== "string" || !(record[name] as string).trim()) throw new Error("PORTAL_CONFIG_INVALID");
    if (/UNVERIFIED|data-verified-|example\.invalid/i.test(record[name] as string)) throw new Error("PORTAL_CONFIG_UNVERIFIED_SELECTOR");
  }
  return record as Record<string, string>;
}

function origins(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.some((item) => typeof item !== "string")) {
    throw new Error("PORTAL_CONFIG_INVALID");
  }
  for (const origin of value as string[]) {
    let parsed: URL;
    try { parsed = new URL(origin); } catch { throw new Error("PORTAL_CONFIG_INVALID"); }
    if (parsed.protocol !== "https:" || parsed.origin !== origin || parsed.username || parsed.password
      || parsed.hostname.endsWith(".invalid") || parsed.hostname.endsWith(".test")) throw new Error("PORTAL_CONFIG_INVALID");
  }
  return value as string[];
}

function liveHttpsUrl(value: string, origins: readonly string[]): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error("PORTAL_CONFIG_INVALID"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash
    || parsed.hostname.endsWith(".invalid") || parsed.hostname.endsWith(".test") || !origins.includes(parsed.origin)) {
    throw new Error("PORTAL_CONFIG_INVALID");
  }
  return parsed.toString();
}

/** Selectors contain no credentials or customer values and are versioned after live inspection. */
export async function loadPortalRuntimeConfig(path: string): Promise<PortalRuntimeConfig> {
  if (!path || !isAbsolute(path)) throw new Error("PORTAL_CONFIG_PATH_INVALID");
  let parsed: unknown;
  try {
    const bytes = await readFile(path);
    if (bytes.length > 64 * 1024) throw new Error("PORTAL_CONFIG_INVALID");
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("PORTAL_CONFIG_INVALID");
  }
  const root = object(parsed);
  const pzu = object(root.pzu);
  const compensa = object(root.compensa);
  const pzuSession = strings(pzu.session, ["authenticated", "loginForm", "usernameInput", "passwordInput", "loginSubmit", "smsChallenge", "smsCodeInput", "smsCodeSubmit", "accessDenied"]);
  if (/^(button|input|form|a|select|textarea)(:[\w-]+)?$/i.test(pzuSession.smsCodeSubmit.trim())) {
    throw new Error("PORTAL_CONFIG_AMBIGUOUS_SMS_SUBMIT");
  }
  for (const optional of ["smsFrame", "smsRememberDevice", "smsResendCode", "smsCodeRejected", "smsCodeExpired", "postLoginLanding"] as const) {
    const configured = object(pzu.session)[optional];
    if (configured !== undefined) pzuSession[optional] = strings(pzu.session, [optional])[optional];
  }
  const everest = object(pzu.everest);
  const everestFields = strings(everest.fields, ["accountType", "personName", "pesel"]);
  const searchNavigation = everest.searchNavigation === undefined ? undefined : strings(everest, ["searchNavigation"]).searchNavigation;
  const searchLoading = everest.searchLoading === undefined ? undefined : strings(everest, ["searchLoading"]).searchLoading;
  const optionalOverlay = everest.optionalOverlay === undefined ? undefined
    : strings(everest.optionalOverlay, ["container", "dismissButton"]);
  const compensaSession = strings(compensa.session, ["authenticated", "loginForm", "usernameInput", "passwordInput", "loginSubmit", "smsChallenge", "smsCodeInput", "smsCodeSubmit", "accessDenied"]);
  if (/^(button|input|form|a|select|textarea)(:[\w-]+)?$/i.test(compensaSession.smsCodeSubmit.trim())) {
    throw new Error("PORTAL_CONFIG_AMBIGUOUS_SMS_SUBMIT");
  }
  for (const optional of ["smsFrame", "smsCodeRejected", "smsCodeExpired", "postLoginLanding"] as const) {
    const configured = object(compensa.session)[optional];
    if (configured !== undefined) compensaSession[optional] = strings(compensa.session, [optional])[optional];
  }
  const form = strings(compensa.form, ["communicationTile", "startDialog", "identifierInput", "registrationInput", "startCommunication", "insuredDataSection", "roleSelect", "firstNameInput", "lastNameInput", "peselInput", "postalCodeInput", "countyInput", "saveButton"]);
  for (const name of ["addressInput", "cityInput"]) {
    const value = object(compensa.form)[name];
    if (value !== undefined && (typeof value !== "string" || !value.trim())) throw new Error("PORTAL_CONFIG_INVALID");
    if (typeof value === "string") form[name] = value;
  }
  const save = strings(compensa.save, ["insuredDataSection", "caseReference", "saveButton", "savedConfirmation"]);
  const ufg = strings(compensa.ufg, ["caseReference", "verifyUfgButton", "summaryTable", "openUfgSummary"]);
  const pzuOrigins = origins(pzu.allowedOrigins);
  const compensaOrigins = origins(compensa.allowedOrigins);
  const pzuMeta = strings(pzu, ["entryUrl", "adapterVersion"]);
  const compensaMeta = strings(compensa, ["entryUrl", "registrationNumber", "adapterVersion", "parserVersion"]);
  const everestSelectors = strings(everest, ["searchInput", "resultRows", "noResults"]);
  return {
    pzu: {
      entryUrl: liveHttpsUrl(pzuMeta.entryUrl, pzuOrigins),
      allowedOrigins: pzuOrigins,
      session: pzuSession as PortalSessionSelectors,
      everest: { ...everestSelectors, searchNavigation, searchLoading, fields: everestFields, optionalOverlay } as EverestResultSelectors,
      adapterVersion: pzuMeta.adapterVersion,
    },
    compensa: {
      entryUrl: liveHttpsUrl(compensaMeta.entryUrl, compensaOrigins),
      allowedOrigins: compensaOrigins,
      session: compensaSession as PortalSessionSelectors,
      form: form as CompensaFormSelectors,
      save: save as CompensaOfferSaveSelectors,
      ufg: ufg as { caseReference: string; verifyUfgButton: string; summaryTable: string; openUfgSummary: string },
      registrationNumber: compensaMeta.registrationNumber,
      adapterVersion: compensaMeta.adapterVersion,
      parserVersion: compensaMeta.parserVersion,
    },
  };
}
