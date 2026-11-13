from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class InputFile(StrictModel):
    sourceType: Literal["CRM", "ASF", "WARTA"]
    fileName: str = Field(min_length=1, max_length=255)
    sha256: str = Field(pattern=r"^[a-fA-F0-9]{64}$")
    contentBase64: str = Field(min_length=1)


class CompareRequest(StrictModel):
    schemaVersion: Literal[1]
    requestId: str = Field(min_length=1, max_length=80)
    executionId: str = Field(min_length=1, max_length=80)
    attemptToken: str = Field(min_length=1, max_length=80)
    engineVersion: str = Field(min_length=1, max_length=80)
    start: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    end: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    preset: dict[str, Any]
    files: list[InputFile] = Field(min_length=1, max_length=40)


class DictionaryImportRequest(StrictModel):
    schemaVersion: Literal[1]
    requestId: str = Field(min_length=1, max_length=80)
    executionId: str = Field(min_length=1, max_length=80)
    attemptToken: str = Field(min_length=1, max_length=80)
    version: str = Field(min_length=1, max_length=80)
    fileName: str = Field(min_length=1, max_length=255)
    sha256: str = Field(pattern=r"^[a-fA-F0-9]{64}$")
    contentBase64: str = Field(min_length=1)
    previousPreset: dict[str, Any] | None = None


class ExportRequest(StrictModel):
    schemaVersion: Literal[1]
    requestId: str = Field(min_length=1, max_length=80)
    executionId: str = Field(min_length=1, max_length=80)
    attemptToken: str = Field(min_length=1, max_length=80)
    result: dict[str, Any]


class CancelRequest(StrictModel):
    attemptToken: str = Field(min_length=1, max_length=80)
