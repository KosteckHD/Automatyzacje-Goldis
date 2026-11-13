import assert from "node:assert/strict";
import { test } from "node:test";

declare const require: (name: string) => any;

test("ExcelJS and Sequelize load CommonJS UUID 11 and retain their v1/v4 call sites", async () => {
  const uuid = require("uuid") as { v1: () => string; v4: () => string; validate: (value: string) => boolean };
  const uuidPackage = require("uuid/package.json") as { version: string };
  const ExcelJS = require("exceljs") as { Workbook: new () => { addWorksheet: (name: string) => { name: string } } };
  const sequelizeModule = require("sequelize") as {
    Sequelize: new (url: string, options: { logging: boolean }) => unknown;
    Transaction: new (sequelize: unknown, options: Record<string, never>) => { id: string };
    DataTypes: { UUIDV1: new () => unknown; UUIDV4: new () => unknown };
    Utils: { toDefaultValue: (value: unknown) => string };
  };
  const CfRuleExt = require("exceljs/lib/xlsx/xform/sheet/cf-ext/cf-rule-ext-xform") as new () => {
    prepare: (model: { type: string; custom: boolean; x14Id?: string }) => void;
  };

  assert.equal(uuidPackage.version, "11.1.1");
  assert.equal(uuid.validate(uuid.v1()), true);
  assert.equal(uuid.validate(uuid.v4()), true);
  assert.equal(new ExcelJS.Workbook().addWorksheet("Compatibility").name, "Compatibility");
  const extensionRule: { type: string; custom: boolean; x14Id?: string } = { type: "iconSet", custom: true };
  new CfRuleExt().prepare(extensionRule);
  assert.equal(uuid.validate(extensionRule.x14Id!.slice(1, -1).toLowerCase()), true);
  assert.equal(uuid.validate(sequelizeModule.Utils.toDefaultValue(new sequelizeModule.DataTypes.UUIDV1())), true);
  assert.equal(uuid.validate(sequelizeModule.Utils.toDefaultValue(new sequelizeModule.DataTypes.UUIDV4())), true);

  const sequelize = new sequelizeModule.Sequelize("postgres://user:password@localhost:5432/goldis_test", { logging: false });
  const transaction = new sequelizeModule.Transaction(sequelize, {});
  assert.equal(uuid.validate(transaction.id), true);
});
