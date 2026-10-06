import { sanitizePublicFileName } from "./public-output";

function encodedFilename(value: string): string {
  const safe = value.replace(/[\r\n\"\\;]/g, "_");
  return encodeURIComponent(safe).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function artifactDownloadHeaders(fileName: string, sizeBytes: number): Readonly<Record<string, string>> {
  const safeFileName = sanitizePublicFileName(fileName, "export.xlsx");
  const fallback = safeFileName.replace(/[^\x20-\x7E]/g, "_").replace(/[\r\n\"\\;]/g, "_") || "export.xlsx";
  return {
    "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": `attachment; filename="${fallback}"; filename*=UTF-8''${encodedFilename(safeFileName)}`,
    "Content-Length": String(sizeBytes),
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  };
}
