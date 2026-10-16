"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "../../..");
const CONTRACT = path.join(ROOT, "docs/backend-refactor/schema-catalog-2026-10-16.json");
const TEMP_NAME = "schema-catalog-contract.json";

async function queryRows(connection, sql) {
  const [rows] = await connection.query(sql);
  return rows;
}

async function collectSchemaCatalog(connection) {
  const sequelizeAssociations = Object.entries(connection.models).flatMap(([modelName, model]) =>
    Object.values(model.associations).map((association) => ({
      model: modelName,
      name: association.as,
      type: association.associationType,
      target: association.target.name,
      foreignKey: association.foreignKey,
      sourceKey: association.sourceKey ?? null,
      targetKey: association.targetKey ?? null,
      onDelete: association.options?.onDelete ?? null,
      onUpdate: association.options?.onUpdate ?? null,
    })))
    .sort((left, right) => left.model < right.model ? -1 : left.model > right.model ? 1
      : left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  const [versionRows, tables, columns, constraints, indexes, sequences, views, triggers, policies, functions, enums, extensions] = await Promise.all([
    queryRows(connection, "SELECT current_setting('server_version_num')::int / 10000 AS major"),
    queryRows(connection, `SELECT table_name AS name, table_type AS type
      FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`),
    queryRows(connection, `SELECT table_name AS table, column_name AS column, ordinal_position AS position,
        data_type AS type, udt_name AS udt, character_maximum_length AS char_length,
        numeric_precision AS numeric_precision, numeric_scale AS numeric_scale,
        datetime_precision AS datetime_precision, is_nullable AS nullable, column_default AS default_value,
        is_identity AS is_identity, identity_generation AS identity_generation,
        is_generated AS is_generated, generation_expression AS generation_expression
      FROM information_schema.columns WHERE table_schema = 'public'
      ORDER BY table_name, ordinal_position`),
    queryRows(connection, `SELECT table_row.relname AS table_name, constraint_row.conname AS name,
        constraint_row.contype AS type, pg_get_constraintdef(constraint_row.oid, true) AS definition,
        constraint_row.convalidated AS validated, constraint_row.condeferrable AS deferrable,
        constraint_row.condeferred AS initially_deferred
      FROM pg_constraint AS constraint_row
      JOIN pg_class AS table_row ON table_row.oid = constraint_row.conrelid
      JOIN pg_namespace AS namespace ON namespace.oid = table_row.relnamespace
      WHERE namespace.nspname = 'public' ORDER BY table_row.relname, constraint_row.conname`),
    queryRows(connection, "SELECT tablename AS table_name, indexname AS name, indexdef AS definition FROM pg_indexes WHERE schemaname = 'public' ORDER BY tablename, indexname"),
    queryRows(connection, `SELECT sequence_name AS name, data_type AS type, numeric_precision AS numeric_precision,
        numeric_precision_radix AS numeric_precision_radix, numeric_scale AS numeric_scale,
        start_value AS start_value, minimum_value AS minimum_value, maximum_value AS maximum_value,
        increment AS increment, cycle_option AS cycle
      FROM information_schema.sequences WHERE sequence_schema = 'public' ORDER BY sequence_name`),
    queryRows(connection, `SELECT table_name AS name, view_definition AS definition, check_option AS check_option,
        is_updatable AS is_updatable, is_insertable_into AS is_insertable_into
      FROM information_schema.views WHERE table_schema = 'public' ORDER BY table_name`),
    queryRows(connection, `SELECT relation.relname AS table_name, trigger_row.tgname AS name,
        pg_get_triggerdef(trigger_row.oid, true) AS definition
      FROM pg_trigger AS trigger_row
      JOIN pg_class AS relation ON relation.oid = trigger_row.tgrelid
      JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public' AND NOT trigger_row.tgisinternal
      ORDER BY relation.relname, trigger_row.tgname`),
    queryRows(connection, `SELECT tablename AS table_name, policyname AS name, permissive, roles,
        cmd AS command, qual AS using_expression, with_check AS check_expression
      FROM pg_policies WHERE schemaname = 'public' ORDER BY tablename, policyname`),
    queryRows(connection, `SELECT procedure.proname AS name,
        pg_get_function_identity_arguments(procedure.oid) AS arguments,
        pg_get_function_result(procedure.oid) AS result, pg_get_functiondef(procedure.oid) AS definition
      FROM pg_proc AS procedure
      JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
      WHERE namespace.nspname = 'public' AND procedure.prokind IN ('f', 'p')
      ORDER BY procedure.proname, pg_get_function_identity_arguments(procedure.oid)`),
    queryRows(connection, `SELECT type.typname AS name, enum.enumlabel AS label, enum.enumsortorder AS position
      FROM pg_type AS type JOIN pg_namespace AS namespace ON namespace.oid = type.typnamespace
      JOIN pg_enum AS enum ON enum.enumtypid = type.oid WHERE namespace.nspname = 'public'
      ORDER BY type.typname, enum.enumsortorder`),
    queryRows(connection, `SELECT extension.extname AS name, extension.extversion AS version
      FROM pg_extension AS extension ORDER BY extension.extname`),
  ]);
  return {
    contractVersion: 1,
    postgresMajor: Number(versionRows[0]?.major),
    sequelizeAssociations,
    tables,
    columns: columns.map((row) => ({
      ...row,
      position: Number(row.position),
      char_length: row.char_length === null ? null : Number(row.char_length),
      numeric_precision: row.numeric_precision === null ? null : Number(row.numeric_precision),
      numeric_scale: row.numeric_scale === null ? null : Number(row.numeric_scale),
      datetime_precision: row.datetime_precision === null ? null : Number(row.datetime_precision),
    })),
    constraints,
    indexes,
    sequences,
    views,
    triggers,
    policies,
    functions,
    enums: enums.map((row) => ({ ...row, position: Number(row.position) })),
    extensions,
  };
}

function tempOutputPath(exportRoot) {
  const resolvedRoot = path.resolve(exportRoot || "");
  const destination = path.join(resolvedRoot, TEMP_NAME);
  if (!exportRoot || path.dirname(destination) !== resolvedRoot
    || path.basename(resolvedRoot).startsWith("goldis-app-module-smoke-") !== true) {
    throw new Error("SCHEMA_CATALOG_TEMP_PATH_INVALID");
  }
  return destination;
}

async function verifySchemaCatalog(connection, exportRoot) {
  const actual = await collectSchemaCatalog(connection);
  if (process.env.GOLDIS_TEST_SCHEMA_CATALOG_CAPTURE === "1") {
    fs.writeFileSync(tempOutputPath(exportRoot), `${JSON.stringify(actual, null, 2)}\n`, {
      encoding: "utf8", flag: "wx", mode: 0o600,
    });
    console.log(`PERSISTENCE_SCHEMA_CATALOG_CAPTURED tables=${actual.tables.length} columns=${actual.columns.length} indexes=${actual.indexes.length} constraints=${actual.constraints.length}`);
    return;
  }
  let expected;
  try { expected = JSON.parse(fs.readFileSync(CONTRACT, "utf8")); }
  catch { throw new Error("PERSISTENCE_SCHEMA_CATALOG_CONTRACT_MISSING"); }
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    const sections = ["tables", "columns", "constraints", "indexes", "sequences", "views", "triggers", "policies", "functions", "enums", "extensions", "sequelizeAssociations"];
    const changed = sections.filter((section) => JSON.stringify(actual[section]) !== JSON.stringify(expected[section]));
    throw new Error(`PERSISTENCE_SCHEMA_CATALOG_MISMATCH_${changed.join("_") || "metadata"}`);
  }
  console.log(`PERSISTENCE_SCHEMA_CATALOG_PASS postgres=${actual.postgresMajor} tables=${actual.tables.length} columns=${actual.columns.length} indexes=${actual.indexes.length} constraints=${actual.constraints.length} functions=${actual.functions.length}`);
}

module.exports = { verifySchemaCatalog };
