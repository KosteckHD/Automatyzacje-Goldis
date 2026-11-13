from __future__ import annotations

from io import BytesIO
from typing import Any

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill


def _literal(cell: Any, value: Any) -> None:
    if value is None:
        cell.value = None
    elif isinstance(value, (int, float)) and not isinstance(value, bool):
        cell.value = value
    else:
        cell.value = str(value)
        cell.data_type = "s"


def build_report(result: dict[str, Any]) -> bytes:
    if not isinstance(result, dict) or not isinstance(result.get("summary"), dict):
        raise ValueError("INVALID_RESULT_SNAPSHOT")
    workbook = Workbook()
    summary = workbook.active
    summary.title = "Podsumowanie"
    summary.append(["Porównanie prowizji", "Wartość"])
    summary.append(["Okres wystawienia CRM", f"{result.get('start', '')} – {result.get('end', '')}"])
    summary.append(["Wersja słownika", result.get("preset_version", "")])
    for key, value in result["summary"].items():
        summary.append([key, value])

    columns = [
        ("kind", "Rodzaj wyniku"), ("insurer", "Towarzystwo"), ("issued", "Data wystawienia"),
        ("number", "Numer polisy CRM"), ("report_number", "Numer w rozliczeniu"),
        ("agent", "OFWCA"), ("risk", "Ryzyko"), ("profile", "Profil"),
        ("expected_rate", "Oczekiwany %"), ("actual_rate", "Otrzymany %"),
        ("difference_pp", "Różnica p.p."), ("source_type", "Źródło rozliczenia"),
        ("file", "Plik"), ("sheet", "Arkusz"), ("row", "Wiersz"), ("reason", "Powód / wyjaśnienie"),
    ]
    for sheet_name, record_key in [("Problemy", "issues"), ("Do wyjaśnienia", "unresolved"), ("Pozycje", "details")]:
        sheet = workbook.create_sheet(sheet_name)
        sheet.append([label for _, label in columns])
        for record in result.get(record_key, []):
            if not isinstance(record, dict):
                continue
            sheet.append([None] * len(columns))
            for col, (key, _) in enumerate(columns, 1):
                _literal(sheet.cell(sheet.max_row, col), record.get(key))

    for sheet in workbook.worksheets:
        sheet.freeze_panes = "A2"
        sheet.auto_filter.ref = sheet.dimensions
        for cell in sheet[1]:
            cell.font = Font(bold=True, color="FFFFFF")
            cell.fill = PatternFill("solid", fgColor="17324D")
            cell.alignment = Alignment(vertical="center", wrap_text=True)
        sheet.row_dimensions[1].height = 30
        for column in sheet.columns:
            letter = column[0].column_letter
            width = min(max(max((len(str(c.value or "")) for c in column[:100]), default=8) + 2, 12), 46)
            sheet.column_dimensions[letter].width = width

    output = BytesIO()
    workbook.save(output)
    workbook.close()
    return output.getvalue()
