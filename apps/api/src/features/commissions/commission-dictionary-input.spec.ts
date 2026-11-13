import assert from "node:assert/strict";
import { test } from "node:test";
import { BadRequestException } from "@nestjs/common";
import { parseEditDictionaryEntryInput } from "./commission-dictionary-input";

test("parser akceptuje dwie role, graniczne stawki i jawne statusy", () => {
  for (const agent of ["Ola", "Maciek"] as const) {
    assert.deepEqual(parseEditDictionaryEntryInput({ revision: 1, agent, status: "RATE", rate: 0 }), {
      revision: 1,
      agent,
      status: "RATE",
      rate: 0,
    });
    assert.equal(parseEditDictionaryEntryInput({ revision: 2, agent, status: "RATE", rate: 100 }).rate, 100);
    assert.equal(parseEditDictionaryEntryInput({ revision: 3, agent, status: "NO_COMMISSION" }).status, "NO_COMMISSION");
    assert.equal(parseEditDictionaryEntryInput({ revision: 4, agent, status: "MISSING", rate: null }).rate, null);
  }
});

test("parser odrzuca prototypy, odziedziczone wymagane pola i nieznane klucze", () => {
  const inherited = Object.create({ agent: "Ola" }) as Record<string, unknown>;
  inherited.revision = 1;
  inherited.status = "RATE";
  inherited.rate = 15;
  assert.throws(() => parseEditDictionaryEntryInput(inherited), BadRequestException);
  assert.throws(() => parseEditDictionaryEntryInput(Object.assign(Object.create(null), {
    revision: 1, agent: "Ola", status: "RATE", rate: 15, extra: true,
  })), BadRequestException);
  assert.throws(() => parseEditDictionaryEntryInput({ revision: 1, agent: "constructor", status: "RATE", rate: 15 }), BadRequestException);
  assert.throws(() => parseEditDictionaryEntryInput({ revision: 1, agent: "Ola", status: "RATE", rate: 15, __proto__: { polluted: true } }), BadRequestException);
});

test("parser odrzuca niejawne konwersje, brak rewizji i stawki poza zakresem", () => {
  const invalid: unknown[] = [
    null,
    [],
    "{revision:1}",
    { agent: "Ola", status: "RATE", rate: 1 },
    { revision: "1", agent: "Ola", status: "RATE", rate: 1 },
    { revision: 1, agent: { name: "Ola" }, status: "RATE", rate: 1 },
    { revision: 1, agent: "Ola", status: "RATE", rate: "15" },
    { revision: 1, agent: "Ola", status: "RATE", rate: Number.NaN },
    { revision: 1, agent: "Ola", status: "RATE", rate: 100.1 },
    { revision: Number.MAX_SAFE_INTEGER + 1, agent: "Ola", status: "RATE", rate: 15 },
    { revision: 1, agent: "Ola", status: "UNRECOGNIZED" },
    { revision: 1, agent: "Ola", status: "MISSING", rate: 15 },
  ];
  for (const value of invalid) assert.throws(() => parseEditDictionaryEntryInput(value), BadRequestException);
});
