"""Bounded evidence: large merge reaches eager allocation before app limits.

No large range is materialized: an instrumented guard stops the parser first.
Only the 10,000-cell control range is actually loaded.
"""
from __future__ import annotations

import base64
from contextlib import nullcontext
import hashlib
import gc
import io
import json
from pathlib import Path
import sys
import zipfile
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "services" / "commission-engine" / "src"))

import openpyxl
from openpyxl.worksheet.worksheet import Worksheet
from goldis_commissions.cli import import_dictionary
from goldis_commissions.importers.workbook import validate_workbook


def workbook_with_merge(reference: str) -> bytes:
    book = openpyxl.Workbook()
    book.active.cell(7, 1, "Towarzystwo")
    book.active.cell(7, 2, "Rodzaj ryzyka")
    book.active.cell(7, 3, "Wariant")
    original = io.BytesIO()
    book.save(original)
    book.close()
    output = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(original.getvalue())) as source:
        with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as target:
            for member in source.infolist():
                content = source.read(member.filename)
                if member.filename == "xl/worksheets/sheet1.xml":
                    content = content.replace(
                        b"</worksheet>",
                        f'<mergeCells count="1"><mergeCell ref="{reference}"/></mergeCells></worksheet>'.encode(),
                    )
                target.writestr(member.filename, content)
    return output.getvalue()


class StoppedBeforeAllocation(Exception):
    pass


def main() -> None:
    huge = workbook_with_merge("A1:XFD1048576")
    validate_workbook(huge, ".xlsx")
    observed = {}

    def stop_before_allocation(self, merged):
        observed.update(reference=str(merged), rows=merged.max_row - merged.min_row + 1,
                        columns=merged.max_col - merged.min_col + 1)
        observed["expandedCells"] = observed["rows"] * observed["columns"]
        raise StoppedBeforeAllocation()

    stopped = False
    workspace_directory = Path(__file__).resolve().parent
    fixture_path = workspace_directory / "synthetic-merge.xlsx"
    if fixture_path.exists():
        raise RuntimeError("Refusing to overwrite existing fixture")
    try:
        with patch.object(Worksheet, "_clean_merge_range", stop_before_allocation), patch(
            "goldis_commissions.cli.tempfile.TemporaryDirectory",
            return_value=nullcontext(str(workspace_directory)),
        ):
            try:
                import_dictionary({
                    "fileName": fixture_path.name,
                    "sha256": hashlib.sha256(huge).hexdigest(),
                    "contentBase64": base64.b64encode(huge).decode(),
                    "version": "synthetic-audit",
                })
            except StoppedBeforeAllocation:
                stopped = True
    finally:
        gc.collect()  # The deliberately interrupted openpyxl reader may retain its ZIP handle.
        fixture_path.unlink(missing_ok=True)
    assert stopped, "Did not reach eager merge materialization"
    small = workbook_with_merge("A100:CV199")
    validate_workbook(small, ".xlsx")
    book = openpyxl.load_workbook(io.BytesIO(small), read_only=False, data_only=False, keep_vba=False)
    control_cells = len(book.active._cells)
    book.close()
    assert control_cells >= 10000
    print(json.dumps({
        "code": "PYTHON_DICTIONARY_MERGE_BEFORE_LIMITS",
        "openpyxl": openpyxl.__version__,
        "fixtureBytes": len(huge),
        "zipValidationAccepted": True,
        "applicationImportReachedEagerMerge": stopped,
        "largeAllocationPreventedByTestGuard": True,
        "observedMerge": observed,
        "boundedControlMaterializedCells": control_cells,
        "limits": "No OOM or service outage attempted; runtime HTTP and container effect not tested.",
    }, indent=2))


if __name__ == "__main__":
    main()
