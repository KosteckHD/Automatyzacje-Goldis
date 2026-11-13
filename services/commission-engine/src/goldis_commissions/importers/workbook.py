from __future__ import annotations

import io
import re
import time
import xml.etree.ElementTree as ET
import zipfile

MAX_FILE_BYTES = 16 * 1024 * 1024
MAX_ARCHIVE_BYTES = 256 * 1024 * 1024
MAX_ARCHIVE_ITEMS = 2_000
MAX_COMPRESSION_RATIO = 120
MAX_XML_BYTES = 32 * 1024 * 1024
MAX_WORKSHEETS = 40
MAX_TOTAL_WORKSHEET_CELLS = 800_000
MAX_MERGE_RANGES = 5_000
MAX_MERGED_CELL_EXPANSION = 10_000
MAX_CELL_TEXT_BYTES = 32 * 1024
MAX_XML_NODES = 2_000_000
MAX_PREFLIGHT_SECONDS = 5.0
MAX_ROW_INDEX = 25_000
MAX_COLUMN_INDEX = 64


def _column_index(value: str) -> int:
    result = 0
    for character in value:
        result = result * 26 + ord(character.upper()) - ord("A") + 1
    return result


def _range_expansion(reference: str) -> tuple[int, int, int, int, int]:
    match = re.fullmatch(r"([A-Z]{1,3})([1-9][0-9]{0,6}):([A-Z]{1,3})([1-9][0-9]{0,6})", reference, re.I)
    if not match:
        raise WorkbookInputError("INVALID_XLSX", "Skoroszyt zawiera nieprawidłowy zakres scalonych komórek.")
    first_column, first_row, last_column, last_row = match.groups()
    min_col, max_col = _column_index(first_column), _column_index(last_column)
    min_row, max_row = int(first_row), int(last_row)
    if min_col > max_col or min_row > max_row:
        raise WorkbookInputError("INVALID_XLSX", "Skoroszyt zawiera odwrócony zakres scalonych komórek.")
    if min_col < 1 or max_col > MAX_COLUMN_INDEX or min_row < 1 or max_row > MAX_ROW_INDEX:
        raise WorkbookInputError("ARCHIVE_LIMIT", "Zakres scalonych komórek przekracza bezpieczny limit.")
    return (max_col - min_col + 1) * (max_row - min_row + 1), min_col, min_row, max_col, max_row


def _preflight_xml_member(
    archive: zipfile.ZipFile,
    name: str,
    remaining_xml: int,
    remaining_cells: int,
    remaining_merges: int,
    remaining_expansion: int,
    remaining_nodes: int,
    deadline: float,
) -> tuple[int, int, int, int, int]:
    info = archive.getinfo(name)
    if info.file_size > remaining_xml:
        raise WorkbookInputError("ARCHIVE_LIMIT", "XML skoroszytu przekracza bezpieczny limit.")
    with archive.open(info) as source:
        xml = source.read(remaining_xml + 1)
    if len(xml) > remaining_xml:
        raise WorkbookInputError("ARCHIVE_LIMIT", "XML skoroszytu przekracza bezpieczny limit.")
    try:
        xml.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise WorkbookInputError("INVALID_XLSX", "XML skoroszytu musi używać UTF-8.") from exc
    declaration = xml[:256].lstrip(b"\xef\xbb\xbf")
    encoding = re.search(rb"<\?xml[^>]*encoding\s*=\s*['\"]([^'\"]+)", declaration, re.I)
    if encoding and encoding.group(1).lower().replace(b"_", b"-") not in {b"utf-8", b"utf8"}:
        raise WorkbookInputError("INVALID_XLSX", "XML skoroszytu musi używać UTF-8.")
    upper_xml = xml.upper()
    if b"<!DOCTYPE" in upper_xml or b"<!ENTITY" in upper_xml:
        raise WorkbookInputError("INVALID_XLSX", "Deklaracje DTD i encje XML nie są obsługiwane.")
    cells = merges = expansion = nodes = 0
    is_worksheet = name.startswith("xl/worksheets/") and name.endswith(".xml")
    try:
        for event, element in ET.iterparse(io.BytesIO(xml), events=("start", "end")):
            if event == "start":
                nodes += 1
                if nodes > remaining_nodes or time.monotonic() > deadline:
                    raise WorkbookInputError("ARCHIVE_LIMIT", "XML skoroszytu zawiera zbyt wiele elementów.")
                if element.tag.rsplit("}", 1)[-1].lower() == "relationship" and element.attrib.get("TargetMode", "").lower() == "external":
                    raise WorkbookInputError("EXTERNAL_LINKS_UNSUPPORTED", "Skoroszyty z zewnętrznymi odwołaniami nie są obsługiwane.")
                continue
            local = element.tag.rsplit("}", 1)[-1].lower()
            if is_worksheet and local == "c":
                cells += 1
                reference = element.attrib.get("r", "")
                match = re.fullmatch(r"([A-Z]{1,3})([1-9][0-9]{0,6})", reference, re.I)
                if not match or int(match.group(2)) > MAX_ROW_INDEX or _column_index(match.group(1)) > MAX_COLUMN_INDEX:
                    raise WorkbookInputError("ARCHIVE_LIMIT", "Skoroszyt przekracza limit wierszy lub kolumn.")
                if cells > remaining_cells:
                    raise WorkbookInputError("ARCHIVE_LIMIT", "Skoroszyt zawiera zbyt wiele komórek.")
            elif is_worksheet and local == "row":
                row_index = element.attrib.get("r", "")
                if not row_index.isdigit() or int(row_index) < 1 or int(row_index) > MAX_ROW_INDEX:
                    raise WorkbookInputError("ARCHIVE_LIMIT", "Skoroszyt przekracza limit wierszy.")
            elif is_worksheet and local == "col":
                first = element.attrib.get("min", "")
                last = element.attrib.get("max", "")
                if not first.isdigit() or not last.isdigit() or int(first) < 1 or int(last) > MAX_COLUMN_INDEX or int(first) > int(last):
                    raise WorkbookInputError("ARCHIVE_LIMIT", "Skoroszyt przekracza limit kolumn.")
            elif is_worksheet and local == "dimension":
                dimension = element.attrib.get("ref", "")
                match = re.fullmatch(r"([A-Z]{1,3})([1-9][0-9]{0,6})(?::([A-Z]{1,3})([1-9][0-9]{0,6}))?", dimension, re.I)
                if not match:
                    raise WorkbookInputError("INVALID_XLSX", "Skoroszyt zawiera nieprawidłowy wymiar arkusza.")
                first_column, first_row, last_column, last_row = match.groups()
                min_col, min_row = _column_index(first_column), int(first_row)
                max_col = _column_index(last_column) if last_column else min_col
                max_row = int(last_row) if last_row else min_row
                if min_col > max_col or min_row > max_row or max_col > MAX_COLUMN_INDEX or max_row > MAX_ROW_INDEX:
                    raise WorkbookInputError("ARCHIVE_LIMIT", "Wymiar arkusza przekracza bezpieczny limit.")
            elif is_worksheet and local == "mergecell":
                merges += 1
                if merges > remaining_merges:
                    raise WorkbookInputError("ARCHIVE_LIMIT", "Skoroszyt zawiera zbyt wiele scaleń.")
                area, _, _, _, _ = _range_expansion(element.attrib.get("ref", ""))
                expansion += area - 1
                if expansion > remaining_expansion:
                    raise WorkbookInputError("ARCHIVE_LIMIT", "Zakres scaleń przekracza bezpieczny limit.")
            elif local in {"v", "t"} and element.text and len(element.text.encode("utf-8")) > MAX_CELL_TEXT_BYTES:
                raise WorkbookInputError("ARCHIVE_LIMIT", "Komórka zawiera zbyt długi tekst.")
            element.clear()
    except ET.ParseError as exc:
        raise WorkbookInputError("INVALID_XLSX", "XML skoroszytu jest nieprawidłowy.") from exc
    return len(xml), cells, merges, expansion, nodes


class WorkbookInputError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def validate_workbook(data: bytes, extension: str) -> None:
    if extension not in {".xlsx", ".xlsm"}:
        raise WorkbookInputError("UNSUPPORTED_FORMAT", "Obsługiwane są wyłącznie skoroszyty .xlsx i .xlsm.")
    if not data or len(data) > MAX_FILE_BYTES:
        raise WorkbookInputError("FILE_SIZE_LIMIT", "Plik jest pusty albo przekracza limit 16 MiB.")
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except (zipfile.BadZipFile, OSError) as exc:
        raise WorkbookInputError("INVALID_XLSX", "Plik nie jest poprawnym skoroszytem Open XML.") from exc
    with archive:
        items = archive.infolist()
        if len(items) > MAX_ARCHIVE_ITEMS:
            raise WorkbookInputError("ARCHIVE_LIMIT", "Skoroszyt zawiera zbyt wiele elementów.")
        member_names = [item.filename for item in items]
        if len(set(member_names)) != len(member_names):
            raise WorkbookInputError("INVALID_XLSX", "Archiwum zawiera powtórzone nazwy elementów.")
        names = set(member_names)
        if "[Content_Types].xml" not in names or "xl/workbook.xml" not in names:
            raise WorkbookInputError("INVALID_XLSX", "Archiwum nie zawiera wymaganej struktury skoroszytu.")
        total = 0
        xml_total = 0
        cell_total = 0
        merge_total = 0
        expansion_total = 0
        node_total = 0
        deadline = time.monotonic() + MAX_PREFLIGHT_SECONDS
        worksheet_names = sorted(
            name for name in names
            if name.startswith("xl/worksheets/") and re.fullmatch(r"xl/worksheets/sheet[0-9]+\.xml", name)
        )
        if not worksheet_names or len(worksheet_names) > MAX_WORKSHEETS:
            raise WorkbookInputError("ARCHIVE_LIMIT", "Skoroszyt zawiera nieprawidłową liczbę arkuszy.")
        for item in items:
            if item.flag_bits & 1:
                raise WorkbookInputError("INVALID_XLSX", "Zaszyfrowane skoroszyty nie są obsługiwane.")
            if ".." in item.filename.replace("\\", "/").split("/"):
                raise WorkbookInputError("INVALID_XLSX", "Nieprawidłowa ścieżka wewnątrz skoroszytu.")
            total += item.file_size
            ratio = item.file_size / max(item.compress_size, 1)
            if total > MAX_ARCHIVE_BYTES or ratio > MAX_COMPRESSION_RATIO:
                raise WorkbookInputError("ARCHIVE_LIMIT", "Rozpakowany skoroszyt przekracza bezpieczny limit.")
            if item.filename.startswith("xl/externalLinks/"):
                raise WorkbookInputError("EXTERNAL_LINKS_UNSUPPORTED", "Skoroszyty z zewnętrznymi łączami wymagają zapisania wartości w pliku.")
        xml_names = sorted(name for name in names if name.lower().endswith((".xml", ".rels")))
        for name in xml_names:
            xml_size, cells, merges, expansion, nodes = _preflight_xml_member(
                archive,
                name,
                MAX_XML_BYTES - xml_total,
                MAX_TOTAL_WORKSHEET_CELLS - cell_total,
                MAX_MERGE_RANGES - merge_total,
                MAX_MERGED_CELL_EXPANSION - expansion_total,
                MAX_XML_NODES - node_total,
                deadline,
            )
            xml_total += xml_size
            cell_total += cells
            merge_total += merges
            expansion_total += expansion
            node_total += nodes
            if xml_total > MAX_XML_BYTES:
                raise WorkbookInputError("ARCHIVE_LIMIT", "XML skoroszytu przekracza bezpieczny limit.")
