import { runImportParserChild } from "./processes/import-parser/child";

if (require.main === module) {
  void runImportParserChild().catch(() => {
    process.stdout.write(JSON.stringify({ errorCode: "INVALID_WORKBOOK" }));
    process.exitCode = 2;
  });
}
