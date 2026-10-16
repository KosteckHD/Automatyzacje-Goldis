import { parseTransportWorkbook } from "../../features/imports/workbook";
import { WorkbookArchiveError } from "../../features/imports/workbook-archive";

const maxInputBytes = 16 * 1024 * 1024;
const maxOutputBytes = 64 * 1024 * 1024;

export async function runImportParserChild(): Promise<void> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const value of process.stdin) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    length += chunk.length;
    if (length > maxInputBytes) {
      process.stdout.write(JSON.stringify({ errorCode: "IMPORT_LIMITS_EXCEEDED" }));
      process.exitCode = 2;
      return;
    }
    chunks.push(chunk);
  }

  try {
    const rows = await parseTransportWorkbook(Buffer.concat(chunks, length));
    const output = Buffer.from(JSON.stringify({ rows }), "utf8");
    if (output.length > maxOutputBytes) {
      process.stdout.write(JSON.stringify({ errorCode: "IMPORT_LIMITS_EXCEEDED" }));
      process.exitCode = 2;
      return;
    }
    process.stdout.write(output);
  } catch (error) {
    const errorCode = error instanceof WorkbookArchiveError
      ? error.code
      : "INVALID_WORKBOOK";
    process.stdout.write(JSON.stringify({ errorCode }));
    process.exitCode = 2;
  }
}

