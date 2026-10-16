import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import ExcelJS from "exceljs";
import { createImportParserServer } from "../../processes/import-parser/main";
import { ImportParserClientError, parseImportWorkbookRemotely } from "./import-parser-client";

const secret = "synthetic-import-parser-secret-32-bytes-min";

async function listen(server: ReturnType<typeof createImportParserServer>): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: ReturnType<typeof createImportParserServer>): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

test("parser HTTP isolates ExcelJS in a child and validates its bounded response", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Realizacja");
  sheet.addRow(["Nazwa", "REGON", "Osoba Decyzyjna"]);
  sheet.addRow(["Firma Testowa", "012345678", "Jan Testowy"]);
  const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
  const server = createImportParserServer({ secret });
  const baseUrl = await listen(server);
  try {
    const rows = await parseImportWorkbookRemotely(bytes, {
      IMPORT_PARSER_URL: baseUrl,
      IMPORT_PARSER_SHARED_SECRET: secret,
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].rowNumber, 2);
    assert.equal(rows[0].companyName, "Firma Testowa");
    const unauthorized = await fetch(`${baseUrl}/internal/parse-xlsx`, {
      method: "POST",
      body: Uint8Array.from(bytes),
    });
    assert.equal(unauthorized.status, 401);
    await assert.rejects(
      parseImportWorkbookRemotely(Buffer.from("not an XLSX"), {
        IMPORT_PARSER_URL: baseUrl,
        IMPORT_PARSER_SHARED_SECRET: secret,
      }),
      (error: unknown) => error instanceof ImportParserClientError && error.code === "INVALID_WORKBOOK",
    );
  } finally {
    await close(server);
  }
});

test("parser admits one child, times it out, rejects overlap, and recovers its slot", async () => {
  let childNumber = 0;
  let firstInputFinished: (() => void) | undefined;
  const firstFinished = new Promise<void>((resolve) => {
    firstInputFinished = resolve;
  });
  const server = createImportParserServer({
    secret,
    timeoutMs: 40,
    spawnChild: (() => {
      childNumber += 1;
      const events = new EventEmitter();
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      let isKilled = false;
      const child = Object.assign(events, {
        stdin,
        stdout,
        stderr,
        get killed() {
          return isKilled;
        },
        kill() {
          isKilled = true;
          process.nextTick(() => {
            stdout.end();
            child.emit("close", null, "SIGKILL");
          });
          return true;
        },
      }) as unknown as ChildProcessWithoutNullStreams;
      stdin.once("finish", () => {
        if (childNumber === 1) firstInputFinished?.();
        else {
          stdout.end(JSON.stringify({ rows: [] }));
          process.nextTick(() => child.emit("close", 0, null));
        }
      });
      return child;
    }) as unknown as typeof import("node:child_process").spawn,
  });
  const baseUrl = await listen(server);
  try {
    const first = fetch(`${baseUrl}/internal/parse-xlsx`, {
      method: "POST",
      headers: { "x-goldis-import-parser-key": secret },
      body: Uint8Array.from(Buffer.from("synthetic")),
    });
    await firstFinished;
    const overlap = await fetch(`${baseUrl}/internal/parse-xlsx`, {
      method: "POST",
      headers: { "x-goldis-import-parser-key": secret },
      body: Uint8Array.from(Buffer.from("synthetic")),
    });
    assert.equal(overlap.status, 503);
    assert.equal(overlap.headers.get("retry-after"), "2");
    assert.equal((await overlap.json()).errorCode, "IMPORT_CAPACITY_EXCEEDED");

    const timedOut = await first;
    assert.equal(timedOut.status, 503);
    assert.equal((await timedOut.json()).errorCode, "IMPORT_PARSE_TIMEOUT");

    const recovered = await parseImportWorkbookRemotely(Buffer.from("synthetic"), {
      IMPORT_PARSER_URL: baseUrl,
      IMPORT_PARSER_SHARED_SECRET: secret,
    });
    assert.deepEqual(recovered, []);
    assert.equal(childNumber, 2);
  } finally {
    await close(server);
  }
});
