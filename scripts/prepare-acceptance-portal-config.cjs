"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");

async function buildAcceptancePortalConfig() {
  const root = path.resolve(__dirname, "..");
  const read = async file => JSON.parse(await fs.readFile(path.join(root, file), "utf8"));
  const pzuLogin = await read("config/pzu-login.observed.json");
  const pzuSms = await read("config/pzu-sms.observed.json");
  const everest = await read("config/pzu-everest.observed.json");
  const compensaLogin = await read("config/compensa-login.observed.json");
  const compensaActions = await read("config/compensa-actions.observed.json");
  // The form/save/UFG selectors below are candidates for a supervised pilot.
  // They are not certified production selectors. No unattended rollout is implied.
  const section = "insured-section:visible";
  const field = label => `insured-section div.row:has(> label:text-is("${label}")) input`;
  const config = {
    pzu: { entryUrl: pzuLogin.entryUrl, allowedOrigins: ["https://everest.pzu.pl", "https://zaloguj.pzu.pl", "https://strefa.agentpzu.pl"],
      adapterVersion: "pilot-20261009", session: { ...pzuLogin.session, ...pzuSms.session,
        authenticated: everest.selectors.searchInput, accessDenied: 'text="Access denied"' }, everest: everest.selectors },
    compensa: { entryUrl: "https://cportal.compensa.pl/Portal", allowedOrigins: compensaLogin.allowedOrigins,
      adapterVersion: "pilot-20261009", parserVersion: "pilot-20261009", registrationNumber: "RST22339",
      session: { ...compensaLogin.session, smsCodeInput: 'input[autocomplete="one-time-code"]', smsCodeSubmit: 'button:has-text("Potwierdź"):visible' },
      form: { communicationTile: 'a:has-text("Compensa Komunikacja"):visible',
        startDialog: 'div.row:has(> label:has-text("Podaj REGON lub PESEL")):visible',
        identifierInput: 'div.row:has(> label:has-text("Podaj REGON lub PESEL")) input',
        registrationInput: 'div.row:has(> label:has-text("Numer rejestracyjny")) input',
        roleSelect: 'radio-btn-in:has(label:has-text("Ubezpieczający")):visible',
        startCommunication: 'button:has-text("Compensa Komunikacja"):visible', insuredDataSection: section,
        firstNameInput: field("Imię"), lastNameInput: field("Nazwisko"),
        // Both exact labels were observed: person PESEL and business-person Pesel.
        peselInput: `${field("PESEL")}, ${field("Pesel")}`,
        postalCodeInput: field("Kod pocztowy"), countyInput: 'insured-section div.row:has(> label:text-is("Powiat")) select',
        saveButton: compensaActions.saveButton,
        customerMatches: compensaActions.customerMatches,
        customerMatchSelect: compensaActions.customerMatchSelect,
        editInsuredData: 'button:has(> span.i-edit_underlined):visible' },
      save: { insuredDataSection: section, caseReference: 'span:text-is("Oferta Nr") ~ span.tm-textGray14B',
        saveButton: compensaActions.saveButton, savedConfirmation: 'insured-section table:has-text("Rola"):has-text("Akcje"):visible' },
      ufg: { caseReference: 'span:text-is("Oferta Nr") ~ span.tm-textGray14B', verifyUfgButton: compensaActions.verifyUfgButton,
        summaryTable: 'table.table-borderless:has-text("Liczba polis"):has-text("Liczba zdarzeń"):visible', verificationCompleted: compensaActions.openUfgSummary + ':enabled',
        openUfgSummary: compensaActions.openUfgSummary } },
  };
  return config;
}

async function main() {
  const config = await buildAcceptancePortalConfig();
  const directory = path.resolve(__dirname, "../exports/live-acceptance");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "candidate-portals.json"), JSON.stringify(config, null, 2));
  console.log("SUPERVISED_PILOT_CONFIG_PREPARED_NOT_PRODUCTION_ACCEPTANCE");
}
module.exports = { buildAcceptancePortalConfig };
if (require.main === module) main().catch(() => { console.error("ACCEPTANCE_CONFIG_PREPARATION_FAILED"); process.exitCode = 1; });
