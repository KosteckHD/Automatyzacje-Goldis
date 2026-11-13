import json
import re
from io import BytesIO
import tempfile
import unittest
from unittest.mock import patch
import zipfile
from pathlib import Path

from openpyxl import Workbook, load_workbook

from goldis_commissions.client_dictionary import import_client_workbook
from goldis_commissions.exporters.xlsx import build_report
from goldis_commissions.importers.workbook import WorkbookInputError, validate_workbook

MAPPING = Path(__file__).parents[2] / "src" / "goldis_commissions" / "dictionary-v7-mapping.json"
TEST_TMP = Path(__file__).parents[2] / ".test-tmp"
TEST_TMP.mkdir(exist_ok=True)


def write_dictionary(path: Path, *, omit_last: bool = False, formula: bool = False) -> int:
    entries = json.loads(MAPPING.read_text(encoding="utf-8"))["entries"]
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "Towarzystwo"
    for column, value in enumerate(("Towarzystwo", "Rodzaj ryzyka", "Wariant", "Prowizja Oli %", "Prowizja Maćka %", "Uwagi"), 1):
        sheet.cell(7, column, value)
    selected = entries[:-1] if omit_last else entries
    for row, entry in enumerate(selected, 8):
        sheet.cell(row, 1, entry["tu"])
        sheet.cell(row, 2, entry["risk"])
        sheet.cell(row, 3, entry["variant"])
        sheet.cell(row, 4, "=1+2" if formula and row == 8 else 0.15)
        sheet.cell(row, 4).number_format = "0%"
        sheet.cell(row, 5, 15)
        sheet.cell(row, 5).number_format = '0.00"%"'
        sheet.cell(row, 6, "")
    workbook.save(path)
    workbook.close()
    return len(selected)


class DictionaryImportTests(unittest.TestCase):
    def test_imports_mapping_without_committing_any_client_rates(self):
        with tempfile.TemporaryDirectory(dir=TEST_TMP) as directory:
            source = Path(directory) / "dictionary.xlsx"
            count = write_dictionary(source)
            preset = import_client_workbook(source, "draft-1", "dictionary.xlsx")
        entries = preset["client_dictionary"]["entries"]
        self.assertEqual(count, 653)
        self.assertEqual(len(entries), 653)
        self.assertEqual(entries[0]["agents"]["Ola"]["rate"], 15)
        self.assertEqual(entries[0]["agents"]["Maciek"]["rate"], 15)
        self.assertEqual(preset["client_dictionary"]["stats"]["entries"], 653)

    def test_missing_existing_rows_are_not_silently_dropped(self):
        with tempfile.TemporaryDirectory(dir=TEST_TMP) as directory:
            source = Path(directory) / "dictionary.xlsx"
            write_dictionary(source, omit_last=True)
            with self.assertRaisesRegex(ValueError, "SLOWNIK_INCOMPLETE"):
                import_client_workbook(source, "draft-1")

    def test_formula_value_is_not_calculated(self):
        with tempfile.TemporaryDirectory(dir=TEST_TMP) as directory:
            source = Path(directory) / "dictionary.xlsx"
            write_dictionary(source, formula=True)
            with self.assertRaisesRegex(ValueError, "FORMULA_REQUIRES_VALUE"):
                import_client_workbook(source, "draft-1")

    def test_workbook_structure_and_excel_formula_injection(self):
        with tempfile.TemporaryDirectory(dir=TEST_TMP) as directory:
            source = Path(directory) / "dictionary.xlsx"
            write_dictionary(source)
            validate_workbook(source.read_bytes(), ".xlsx")
        report = build_report({
            "start": "2026-06-01", "end": "2026-09-30", "preset_version": "v7",
            "summary": {"policies": 1}, "issues": [{"kind": "=HYPERLINK(\"https://invalid\")"}],
            "unresolved": [], "details": [],
        })
        from io import BytesIO
        book = load_workbook(BytesIO(report), data_only=False)
        self.assertEqual(book["Problemy"]["A2"].data_type, "s")
        book.close()

    def test_invalid_zip_is_rejected(self):
        with self.assertRaises(WorkbookInputError):
            validate_workbook(b"not an Excel file", ".xlsx")

    def test_oversized_merge_is_rejected_by_direct_import_before_openpyxl(self):
        with tempfile.TemporaryDirectory(dir=TEST_TMP) as directory:
            source = Path(directory) / "dictionary.xlsx"
            write_dictionary(source)
            malicious = add_worksheet_xml(source.read_bytes(), lambda xml: xml.replace(
                b"</worksheet>", b'<mergeCells count="1"><mergeCell ref="A1:XFD1048576"/></mergeCells></worksheet>'
            ))
            source.write_bytes(malicious)
            with patch("goldis_commissions.client_dictionary.openpyxl.load_workbook") as loader:
                with self.assertRaises(WorkbookInputError) as raised:
                    import_client_workbook(source, "draft-1")
                loader.assert_not_called()
            self.assertEqual(raised.exception.code, "ARCHIVE_LIMIT")

    def test_inflated_dimension_is_rejected_before_eager_workbook_load(self):
        with tempfile.TemporaryDirectory(dir=TEST_TMP) as directory:
            source = Path(directory) / "dictionary.xlsx"
            write_dictionary(source)
            malicious = add_worksheet_xml(source.read_bytes(), lambda xml: re.sub(
                rb'<dimension\b[^>]*\bref="[^"]+"[^>]*/?>',
                b'<dimension ref="A1:XFD1048576"/>',
                xml,
                count=1,
            ))
            with self.assertRaises(WorkbookInputError) as raised:
                validate_workbook(malicious, ".xlsx")
            self.assertEqual(raised.exception.code, "ARCHIVE_LIMIT")

    def test_dtd_is_rejected_before_openpyxl(self):
        with tempfile.TemporaryDirectory(dir=TEST_TMP) as directory:
            source = Path(directory) / "dictionary.xlsx"
            write_dictionary(source)
            dtd = add_worksheet_xml(source.read_bytes(), lambda xml: xml.replace(
                b"<worksheet", b'<!DOCTYPE worksheet [<!ENTITY x "x">]><worksheet', 1
            ))
            with self.assertRaises(WorkbookInputError):
                validate_workbook(dtd, ".xlsx")

    def test_external_relationship_is_rejected(self):
        with tempfile.TemporaryDirectory(dir=TEST_TMP) as directory:
            source = Path(directory) / "dictionary.xlsx"
            write_dictionary(source)
            malicious = add_archive_member(source.read_bytes(), "xl/_rels/workbook.xml.rels", lambda xml: xml.replace(
                b"</Relationships>",
                b'<Relationship Id="rIdExternal" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://invalid/" TargetMode="External"/></Relationships>',
            ))
            with self.assertRaises(WorkbookInputError) as raised:
                validate_workbook(malicious, ".xlsx")
            self.assertEqual(raised.exception.code, "EXTERNAL_LINKS_UNSUPPORTED")


def add_worksheet_xml(data: bytes, transform) -> bytes:
    return add_archive_member(data, "xl/worksheets/sheet1.xml", transform)


def add_archive_member(data: bytes, member: str, transform) -> bytes:
    source = zipfile.ZipFile(BytesIO(data))
    destination_bytes = BytesIO()
    with source, zipfile.ZipFile(destination_bytes, "w", zipfile.ZIP_DEFLATED) as destination:
        for info in source.infolist():
            contents = source.read(info.filename)
            if info.filename == member:
                contents = transform(contents)
            destination.writestr(info, contents)
    return destination_bytes.getvalue()


if __name__ == "__main__":
    unittest.main()
