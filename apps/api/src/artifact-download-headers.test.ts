import { test } from "node:test";
import assert from "node:assert/strict";
import { artifactDownloadHeaders } from "./artifact-download-headers";

test("nagłówki pobierania oznaczają XLSX jako prywatny plik i podają rozmiar", () => {
  const headers = artifactDownloadHeaders("012345678_Firma_Jan Kowalski.xlsx", 4096);
  assert.equal(headers["Content-Type"], "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.equal(headers["Content-Length"], "4096");
  assert.equal(headers["Cache-Control"], "private, no-store");
  assert.equal(headers["X-Content-Type-Options"], "nosniff");
  assert.match(headers["Content-Disposition"], /^attachment; filename=/);
  assert.match(headers["Content-Disposition"], /filename\*=UTF-8''/);
});

test("nazwa pliku nie może wstrzyknąć nowej linii do nagłówka", () => {
  const headers = artifactDownloadHeaders('raport; "test"\r\nX-Evil: yes.xlsx', 1);
  assert.equal(headers["Content-Disposition"].includes("\r"), false);
  assert.equal(headers["Content-Disposition"].includes("\n"), false);
  assert.equal(headers["Content-Disposition"].includes('filename="raport_ _test___X-Evil: yes.xlsx"'), true);
});

test("nagłówek pobierania nie zawiera ścieżki ani PESEL-u w nazwie pliku", () => {
  const headers = artifactDownloadHeaders("C:\\private\\12345678901_Firma.xlsx", 1);
  assert.equal(headers["Content-Disposition"].includes("C:\\private"), false);
  assert.equal(headers["Content-Disposition"].includes("12345678901"), false);
  assert.match(headers["Content-Disposition"], /filename="\[ukryto\]_Firma\.xlsx"/);
});
