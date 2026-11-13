from __future__ import annotations

import argparse
import base64
import contextlib
import hashlib
import json
import os
import re
import sys
import tempfile
from datetime import date
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from goldis_commissions import ENGINE_VERSION
from goldis_commissions.client_dictionary import import_client_workbook
from goldis_commissions.engine import run
from goldis_commissions.exporters.xlsx import build_report
from goldis_commissions.importers.workbook import WorkbookInputError, validate_workbook


def _safe_name(value: str, fallback: str) -> str:
    name = Path(str(value).replace("\\", "/")).name
    name = "".join(ch for ch in name if ch.isprintable() and ch not in "<>:\"|?*").strip(" .")
    if not name:
        name = fallback
    return name[:160]


def _read_payload() -> dict[str, Any]:
    raw = sys.stdin.buffer.read(100 * 1024 * 1024 + 1)
    if len(raw) > 100 * 1024 * 1024:
        raise WorkbookInputError("REQUEST_LIMIT", "Żądanie przekracza dozwolony rozmiar.")
    payload = json.loads(raw)
    if not isinstance(payload, dict):
        raise WorkbookInputError("INVALID_REQUEST", "Nieprawidłowy kontrakt żądania.")
    return payload


def _decode_file(item: dict[str, Any], allowed_extensions: set[str]) -> tuple[bytes, str]:
    name = _safe_name(item.get("fileName", ""), "wejscie.xlsx")
    extension = Path(name).suffix.lower()
    if extension not in allowed_extensions:
        raise WorkbookInputError("UNSUPPORTED_FORMAT", "Nieobsługiwane rozszerzenie pliku.")
    try:
        data = base64.b64decode(item["contentBase64"], validate=True)
    except Exception as exc:
        raise WorkbookInputError("INVALID_BASE64", "Nieprawidłowe kodowanie pliku.") from exc
    expected_hash = str(item.get("sha256", "")).lower()
    if hashlib.sha256(data).hexdigest() != expected_hash:
        raise WorkbookInputError("FILE_HASH_MISMATCH", "Suma kontrolna pliku nie zgadza się z manifestem.")
    validate_workbook(data, extension)
    return data, name


def _replace_local_paths(value: Any, names: dict[str, str]) -> Any:
    if isinstance(value, dict):
        return {key: _replace_local_paths(item, names) for key, item in value.items()}
    if isinstance(value, list):
        return [_replace_local_paths(item, names) for item in value]
    if isinstance(value, str):
        return names.get(value, value)
    return value


def import_dictionary(payload: dict[str, Any]) -> dict[str, Any]:
    item = {"fileName": payload.get("fileName"), "sha256": payload.get("sha256"),
            "contentBase64": payload.get("contentBase64")}
    data, name = _decode_file(item, {".xlsx", ".xlsm"})
    with tempfile.TemporaryDirectory(prefix="goldis-commission-dictionary-") as directory:
        source = Path(directory) / name
        source.write_bytes(data)
        preset = import_client_workbook(
            source,
            str(payload.get("version", "")),
            name,
            payload.get("previousPreset"),
        )
    return {"engineVersion": ENGINE_VERSION, "preset": preset}


def compare(payload: dict[str, Any]) -> dict[str, Any]:
    try:
        begin = date.fromisoformat(str(payload["start"]))
        end = date.fromisoformat(str(payload["end"]))
    except (ValueError, KeyError) as exc:
        raise WorkbookInputError("INVALID_DATE_RANGE", "Podaj prawidłowy zakres dat.") from exc
    if end < begin:
        raise WorkbookInputError("INVALID_DATE_RANGE", "Data końcowa nie może być wcześniejsza od początkowej.")
    files = payload.get("files")
    if not isinstance(files, list) or len(files) > 40:
        raise WorkbookInputError("FILE_COUNT_LIMIT", "Nieprawidłowa liczba plików.")
    total_bytes = 0
    prepared: list[tuple[str, bytes, str]] = []
    for item in files:
        if not isinstance(item, dict) or item.get("sourceType") not in {"CRM", "ASF", "WARTA"}:
            raise WorkbookInputError("INVALID_SOURCE_TYPE", "Nieznany rodzaj pliku wejściowego.")
        data, original_name = _decode_file(item, {".xlsx"})
        total_bytes += len(data)
        if total_bytes > 64 * 1024 * 1024:
            raise WorkbookInputError("TOTAL_UPLOAD_LIMIT", "Łączny rozmiar plików przekracza limit 64 MiB.")
        prepared.append((item["sourceType"], data, original_name))
    if not isinstance(payload.get("preset"), dict) or not payload["preset"].get("client_dictionary"):
        raise WorkbookInputError("DICTIONARY_REQUIRED", "Analiza wymaga opublikowanej wersji słownika.")

    with tempfile.TemporaryDirectory(prefix="goldis-commission-run-") as directory:
        root = Path(directory) / "source"
        output = Path(directory) / "output"
        root.mkdir()
        for folder in ("LISTA WYSTAWIONYCH POLIS", "ASF", "WARTA"):
            (root / folder).mkdir()
        name_map: dict[str, str] = {}
        for index, (source_type, data, original_name) in enumerate(prepared, 1):
            folder = {"CRM": "LISTA WYSTAWIONYCH POLIS", "ASF": "ASF", "WARTA": "WARTA"}[source_type]
            stored_name = f"{index:03d}-{_safe_name(original_name, 'plik.xlsx')}"
            path = root / folder / stored_name
            path.write_bytes(data)
            name_map[str(path)] = original_name
        preset_path = Path(directory) / "preset.json"
        preset_path.write_text(json.dumps(payload["preset"], ensure_ascii=False), encoding="utf-8")
        args = SimpleNamespace(source=str(root), output=str(output), start=begin.isoformat(), end=end.isoformat(),
            preset=str(preset_path), confirm_format=[])
        with contextlib.redirect_stdout(sys.stderr):
            result = run(args)
        result = _replace_local_paths(result, name_map)
        result["schema_version"] = 1
        result["engine_version"] = ENGINE_VERSION
        result["request_id"] = str(payload.get("requestId", ""))
        result["execution_id"] = str(payload.get("executionId", ""))
        result["attempt_token"] = str(payload.get("attemptToken", ""))
        return result


def export(payload: dict[str, Any]) -> dict[str, Any]:
    result = payload.get("result")
    if not isinstance(result, dict):
        raise WorkbookInputError("INVALID_RESULT_SNAPSHOT", "Nieprawidłowy snapshot wyniku.")
    workbook = build_report(result)
    return {"engineVersion": ENGINE_VERSION, "workbookBase64": base64.b64encode(workbook).decode("ascii"),
            "sha256": hashlib.sha256(workbook).hexdigest()}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=["compare", "dictionary-import", "export"])
    args = parser.parse_args()
    try:
        if os.name == "posix":
            import resource
            resource.setrlimit(resource.RLIMIT_CPU, (590, 590))
            resource.setrlimit(resource.RLIMIT_FSIZE, (64 * 1024 * 1024, 64 * 1024 * 1024))
            resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
        payload = _read_payload()
        response = {"compare": compare, "dictionary-import": import_dictionary, "export": export}[args.operation](payload)
        sys.stdout.write(json.dumps(response, ensure_ascii=False, separators=(",", ":"), default=str))
    except WorkbookInputError as exc:
        sys.stdout.write(json.dumps({"errorCode": exc.code, "message": str(exc)}, ensure_ascii=False))
        raise SystemExit(2)
    except ValueError as exc:
        message = str(exc)
        if message.startswith("FORMULA_REQUIRES_VALUE:") or message.startswith("SLOWNIK_INCOMPLETE:"):
            safe_message = message
            code = "FORMULA_REQUIRES_VALUE" if message.startswith("FORMULA_REQUIRES_VALUE:") else "SLOWNIK_INCOMPLETE"
        elif "WORKBOOK_LIMITS_EXCEEDED" in message:
            safe_message, code = "Przekroczono bezpieczne limity skoroszytu.", "WORKBOOK_LIMITS_EXCEEDED"
        else:
            safe_message, code = "Nie można przetworzyć jednego z plików lub reguł.", "ENGINE_INPUT_INVALID"
        sys.stdout.write(json.dumps({"errorCode": code, "message": safe_message}, ensure_ascii=False))
        raise SystemExit(2)
    except Exception:
        sys.stdout.write(json.dumps({"errorCode": "ENGINE_INTERNAL_ERROR", "message": "Wystąpił błąd usługi obliczeniowej."}, ensure_ascii=False))
        raise SystemExit(3)


if __name__ == "__main__":
    main()
