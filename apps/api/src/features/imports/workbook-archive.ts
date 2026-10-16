import { Readable } from "node:stream";
import { createInflateRaw } from "node:zlib";
import { SaxesParser } from "saxes";

export type WorkbookArchiveErrorCode =
  | "IMPORT_LIMITS_EXCEEDED"
  | "INVALID_WORKBOOK"
  | "IMPORT_PARSE_TIMEOUT"
  | "IMPORT_CAPACITY_EXCEEDED";
export class WorkbookArchiveError extends Error {
  constructor(readonly code: WorkbookArchiveErrorCode) {
    super(code);
  }
}

export type WorkbookArchiveLimits = Readonly<{
  maxEntries: number;
  maxCompressedBytes: number;
  maxUncompressedBytes: number;
  maxXmlBytes: number;
  maxExpansionRatio: number;
  maxSheets: number;
  maxRows: number;
  maxCells: number;
  maxXmlNodes: number;
  maxCellText: number;
  maxDurationMs: number;
  maxMergedRanges: number;
  maxMergedCells: number;
  maxColumnDefinitions: number;
  maxExpandedColumns: number;
  maxExpandedColumnsPerSheet: number;
  maxRowIndex: number;
}>;

export const defaultWorkbookArchiveLimits: WorkbookArchiveLimits = {
  maxEntries: 512,
  maxCompressedBytes: 16 * 1024 * 1024,
  maxUncompressedBytes: 64 * 1024 * 1024,
  maxXmlBytes: 32 * 1024 * 1024,
  maxExpansionRatio: 100,
  maxSheets: 10,
  maxRows: 40_000,
  maxCells: 800_000,
  maxXmlNodes: 2_000_000,
  maxCellText: 32 * 1024,
  maxDurationMs: 10_000,
  maxMergedRanges: 5_000,
  maxMergedCells: 10_000,
  maxColumnDefinitions: 256,
  maxExpandedColumns: 64_000,
  maxExpandedColumnsPerSheet: 16_384,
  maxRowIndex: 40_000,
};

type CentralEntry = Readonly<{
  name: string;
  flags: number;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
}>;

let activeParsers = 0;
const maxConcurrentValidations = 2;

function fail(code: WorkbookArchiveErrorCode): never {
  throw new WorkbookArchiveError(code);
}

function cellAddress(value: string): { column: number; row: number } | null {
  const match = /^([A-Z]{1,3})([1-9]\d{0,6})$/i.exec(value);
  if (!match) return null;
  let column = 0;
  for (const character of match[1].toUpperCase()) column = column * 26 + character.charCodeAt(0) - 64;
  const row = Number(match[2]);
  return column <= 16_384 && row <= 1_048_576 ? { column, row } : null;
}

function positiveInteger(value: unknown): number | null {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function rangeBounds(
  value: string,
): { start: { column: number; row: number }; end: { column: number; row: number } } | null {
  const parts = value.split(":");
  if (parts.length === 1) {
    const address = cellAddress(parts[0]);
    return address ? { start: address, end: address } : null;
  }
  if (parts.length !== 2) return null;
  const start = cellAddress(parts[0]);
  const end = cellAddress(parts[1]);
  if (!start || !end || start.column > end.column || start.row > end.row) return null;
  return { start, end };
}

function mergedRangeSize(value: string): number | null {
  const parts = value.split(":");
  if (parts.length !== 2) return null;
  const start = cellAddress(parts[0]);
  const end = cellAddress(parts[1]);
  if (!start || !end || start.column > end.column || start.row > end.row) return null;
  const cells = (end.column - start.column + 1) * (end.row - start.row + 1);
  return Number.isSafeInteger(cells) ? cells : null;
}

function readEntries(buffer: Buffer, limits: WorkbookArchiveLimits): CentralEntry[] {
  if (buffer.length < 22 || buffer.length > limits.maxCompressedBytes || buffer.readUInt32LE(0) !== 0x04034b50) {
    return fail(buffer.length > limits.maxCompressedBytes ? "IMPORT_LIMITS_EXCEEDED" : "INVALID_WORKBOOK");
  }
  const searchStart = Math.max(0, buffer.length - 22 - 0xffff);
  let eocd = -1;
  for (let index = buffer.length - 22; index >= searchStart; index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) {
      eocd = index;
      break;
    }
  }
  if (eocd < 0) return fail("INVALID_WORKBOOK");
  const commentLength = buffer.readUInt16LE(eocd + 20);
  if (
    eocd + 22 + commentLength !== buffer.length ||
    buffer.readUInt16LE(eocd + 4) !== 0 ||
    buffer.readUInt16LE(eocd + 6) !== 0 ||
    buffer.readUInt16LE(eocd + 8) !== buffer.readUInt16LE(eocd + 10)
  ) {
    return fail("INVALID_WORKBOOK");
  }
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff)
    return fail("INVALID_WORKBOOK");
  if (entryCount > limits.maxEntries) return fail("IMPORT_LIMITS_EXCEEDED");
  if (centralOffset + centralSize !== eocd) return fail("INVALID_WORKBOOK");
  const entries: CentralEntry[] = [];
  const names = new Set<string>();
  let offset = centralOffset;
  let totalUncompressed = 0;
  let sheets = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > eocd || buffer.readUInt32LE(offset) !== 0x02014b50) return fail("INVALID_WORKBOOK");
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const entryCommentLength = buffer.readUInt16LE(offset + 32);
    const diskStart = buffer.readUInt16LE(offset + 34);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const entryEnd = offset + 46 + nameLength + extraLength + entryCommentLength;
    if (
      entryEnd > eocd ||
      diskStart !== 0 ||
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localOffset === 0xffffffff
    ) {
      return fail("INVALID_WORKBOOK");
    }
    let name: string;
    try {
      name = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(offset + 46, offset + 46 + nameLength));
    } catch {
      return fail("INVALID_WORKBOOK");
    }
    const normalizedName = name.replace(/\\/g, "/");
    if (
      !name ||
      name.includes("\u0000") ||
      normalizedName.startsWith("/") ||
      /^[A-Za-z]:/.test(normalizedName) ||
      normalizedName.split("/").some((part) => part === "..") ||
      names.has(normalizedName.toLowerCase()) ||
      /\.(?:zip|7z|rar|tar|gz)$/i.test(normalizedName)
    )
      return fail("INVALID_WORKBOOK");
    names.add(normalizedName.toLowerCase());
    if ((flags & 0x0001) !== 0 || (method !== 0 && method !== 8)) return fail("INVALID_WORKBOOK");
    if (method === 0 && compressedSize !== uncompressedSize) return fail("INVALID_WORKBOOK");
    if (uncompressedSize > limits.maxUncompressedBytes) return fail("IMPORT_LIMITS_EXCEEDED");
    if (
      uncompressedSize > 256 * 1024 &&
      (compressedSize === 0 || uncompressedSize / compressedSize > limits.maxExpansionRatio)
    ) {
      return fail("IMPORT_LIMITS_EXCEEDED");
    }
    if (/\.(?:xml|rels)$/i.test(normalizedName) && uncompressedSize > limits.maxXmlBytes)
      return fail("IMPORT_LIMITS_EXCEEDED");
    if (/^xl\/worksheets\/[^/]+\.xml$/i.test(normalizedName)) sheets += 1;
    else if (
      /^xl\/worksheets\//i.test(normalizedName) &&
      normalizedName.toLowerCase() !== "xl/worksheets/" &&
      !/^xl\/worksheets\/_rels\/[^/]+\.xml\.rels$/i.test(normalizedName)
    )
      return fail("INVALID_WORKBOOK");
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > limits.maxUncompressedBytes) return fail("IMPORT_LIMITS_EXCEEDED");
    if (localOffset + 30 > centralOffset || buffer.readUInt32LE(localOffset) !== 0x04034b50)
      return fail("INVALID_WORKBOOK");
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    if (dataStart + compressedSize > centralOffset) return fail("INVALID_WORKBOOK");
    const localName = buffer.subarray(localOffset + 30, localOffset + 30 + localNameLength).toString("utf8");
    if (
      localName !== name ||
      buffer.readUInt16LE(localOffset + 6) !== flags ||
      buffer.readUInt16LE(localOffset + 8) !== method
    ) {
      return fail("INVALID_WORKBOOK");
    }
    entries.push({ name: normalizedName, flags, method, compressedSize, uncompressedSize, localOffset });
    offset = entryEnd;
  }
  if (offset !== eocd || sheets > limits.maxSheets)
    return fail(sheets > limits.maxSheets ? "IMPORT_LIMITS_EXCEEDED" : "INVALID_WORKBOOK");
  return entries;
}

export async function validateWorkbookArchive(
  buffer: Buffer,
  overrides: Partial<WorkbookArchiveLimits> = {},
): Promise<void> {
  const limits = { ...defaultWorkbookArchiveLimits, ...overrides };
  const deadline = Date.now() + limits.maxDurationMs;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
  }, limits.maxDurationMs);
  timer.unref();
  try {
    const entries = readEntries(buffer, limits);
    let totalUncompressed = 0;
    let rowCount = 0;
    let cellCount = 0;
    let stringCount = 0;
    let nodeCount = 0;
    let mergedRangeCount = 0;
    let mergedCellExpansionCount = 0;
    let columnDefinitionCount = 0;
    let expandedColumnCount = 0;
    for (const entry of entries) {
      if (timedOut || Date.now() > deadline) return fail("IMPORT_PARSE_TIMEOUT");
      const dataOffset =
        entry.localOffset +
        30 +
        buffer.readUInt16LE(entry.localOffset + 26) +
        buffer.readUInt16LE(entry.localOffset + 28);
      const compressed = buffer.subarray(dataOffset, dataOffset + entry.compressedSize);
      const source = Readable.from([compressed]);
      const stream = entry.method === 8 ? source.pipe(createInflateRaw()) : source;
      const isXml = /\.(?:xml|rels)$/i.test(entry.name);
      const parser = isXml ? new SaxesParser({ xmlns: false, position: false }) : null;
      let xmlInvalid = false;
      let depth = 0;
      let cellDepth = 0;
      let sharedStringDepth = 0;
      let cellTextLength = 0;
      let sharedStringLength = 0;
      let currentRowIndex: number | null = null;
      let expandedColumnsForSheet = 0;
      const isWorksheet = /^xl\/worksheets\/[^/]+\.xml$/i.test(entry.name);
      if (parser) {
        parser.on("error", () => {
          xmlInvalid = true;
        });
        parser.on("doctype", () => {
          xmlInvalid = true;
        });
        parser.on("opentag", (tag) => {
          depth += 1;
          nodeCount += 1;
          if (depth > 64) xmlInvalid = true;
          if (nodeCount > limits.maxXmlNodes) return fail("IMPORT_LIMITS_EXCEEDED");
          const local = tag.name.split(":").at(-1)?.toLowerCase();
          if (local === "row" && isWorksheet) {
            rowCount += 1;
            const rowIndex = positiveInteger(tag.attributes.r);
            if (!rowIndex) xmlInvalid = true;
            else if (rowIndex > limits.maxRowIndex) return fail("IMPORT_LIMITS_EXCEEDED");
            currentRowIndex = rowIndex;
          }
          if (local === "c" && isWorksheet) {
            cellCount += 1;
            cellDepth += 1;
            cellTextLength = 0;
            const address = typeof tag.attributes.r === "string" ? cellAddress(tag.attributes.r) : null;
            if (!address || currentRowIndex === null || address.row !== currentRowIndex) xmlInvalid = true;
            else if (address.row > limits.maxRowIndex) return fail("IMPORT_LIMITS_EXCEEDED");
          }
          if (local === "col" && isWorksheet) {
            columnDefinitionCount += 1;
            const min = positiveInteger(tag.attributes.min);
            const max = positiveInteger(tag.attributes.max);
            if (!min || !max || min > max || max > 16_384) xmlInvalid = true;
            else {
              const expanded = max - min + 1;
              expandedColumnsForSheet += expanded;
              expandedColumnCount += expanded;
            }
            if (
              columnDefinitionCount > limits.maxColumnDefinitions ||
              expandedColumnsForSheet > limits.maxExpandedColumnsPerSheet ||
              expandedColumnCount > limits.maxExpandedColumns
            )
              return fail("IMPORT_LIMITS_EXCEEDED");
          }
          if (local === "dimension" && isWorksheet) {
            const ref = typeof tag.attributes.ref === "string" ? tag.attributes.ref : "";
            const bounds = rangeBounds(ref);
            if (!bounds || bounds.end.column > 16_384) xmlInvalid = true;
            else if (bounds.end.row > limits.maxRowIndex) return fail("IMPORT_LIMITS_EXCEEDED");
          }
          if (local === "mergecell" && isWorksheet) {
            mergedRangeCount += 1;
            const ref = typeof tag.attributes.ref === "string" ? tag.attributes.ref : "";
            const rangeSize = mergedRangeSize(ref);
            if (!rangeSize) xmlInvalid = true;
            else mergedCellExpansionCount += rangeSize - 1;
            if (mergedRangeCount > limits.maxMergedRanges || mergedCellExpansionCount > limits.maxMergedCells) {
              return fail("IMPORT_LIMITS_EXCEEDED");
            }
          }
          if (local === "si" && entry.name.toLowerCase() === "xl/sharedstrings.xml") {
            stringCount += 1;
            sharedStringDepth += 1;
            sharedStringLength = 0;
          }
          if (local === "f") xmlInvalid = true;
          if (local === "relationship" && String(tag.attributes.TargetMode ?? "").toLowerCase() === "external")
            xmlInvalid = true;
          if (rowCount > limits.maxRows || cellCount > limits.maxCells || stringCount > limits.maxCells) {
            return fail("IMPORT_LIMITS_EXCEEDED");
          }
        });
        parser.on("closetag", (tag) => {
          const local = tag.name.split(":").at(-1)?.toLowerCase();
          if (local === "c" && cellDepth > 0) cellDepth -= 1;
          if (local === "si" && sharedStringDepth > 0) sharedStringDepth -= 1;
          if (local === "row" && isWorksheet) currentRowIndex = null;
          depth = Math.max(0, depth - 1);
        });
        const onText = (value: string) => {
          if (cellDepth > 0) {
            cellTextLength += value.length;
            if (cellTextLength > limits.maxCellText) xmlInvalid = true;
          }
          if (sharedStringDepth > 0) {
            sharedStringLength += value.length;
            if (sharedStringLength > limits.maxCellText) xmlInvalid = true;
          }
        };
        parser.on("text", onText);
        parser.on("cdata", onText);
      }
      const decoder = parser ? new TextDecoder("utf-8", { fatal: true }) : null;
      try {
        for await (const value of stream) {
          if (timedOut || Date.now() > deadline) {
            stream.destroy();
            return fail("IMPORT_PARSE_TIMEOUT");
          }
          const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
          totalUncompressed += chunk.length;
          if (totalUncompressed > limits.maxUncompressedBytes) {
            stream.destroy();
            return fail("IMPORT_LIMITS_EXCEEDED");
          }
          if (parser && decoder) parser.write(decoder.decode(chunk, { stream: true }));
        }
        if (parser && decoder) parser.write(decoder.decode()).close();
      } catch (error) {
        if (error instanceof WorkbookArchiveError) throw error;
        if (timedOut) return fail("IMPORT_PARSE_TIMEOUT");
        return fail("INVALID_WORKBOOK");
      }
      if (xmlInvalid || totalUncompressed > limits.maxUncompressedBytes) return fail("INVALID_WORKBOOK");
    }
    if (timedOut || Date.now() > deadline) return fail("IMPORT_PARSE_TIMEOUT");
  } finally {
    clearTimeout(timer);
  }
}

export async function withWorkbookParserCapacity<T>(operation: () => Promise<T>): Promise<T> {
  if (activeParsers >= maxConcurrentValidations) return fail("IMPORT_CAPACITY_EXCEEDED");
  activeParsers += 1;
  try {
    return await operation();
  } finally {
    activeParsers = Math.max(0, activeParsers - 1);
  }
}
