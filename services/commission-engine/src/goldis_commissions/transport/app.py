from __future__ import annotations

import asyncio
import hmac
import json
import os
from pathlib import Path

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse, Response

from goldis_commissions import ENGINE_VERSION
from goldis_commissions.transport.process_supervisor import EngineProcessError, ProcessSupervisor
from goldis_commissions.transport.schemas import CancelRequest, CompareRequest, DictionaryImportRequest, ExportRequest

MAX_REQUEST_BYTES = int(os.environ.get("COMMISSION_MAX_REQUEST_BYTES", 100 * 1024 * 1024))
EXECUTION_TIMEOUT = int(os.environ.get("COMMISSION_EXECUTION_TIMEOUT_SECONDS", "600"))
supervisor = ProcessSupervisor(EXECUTION_TIMEOUT)


class RequestSizeExceeded(Exception):
    pass
app = FastAPI(title="Goldis commission engine", docs_url=None, redoc_url=None, openapi_url=None)


def _internal_token() -> str:
    secret_path = os.environ.get("COMMISSION_INTERNAL_TOKEN_FILE")
    token = Path(secret_path).read_text(encoding="utf-8").strip() if secret_path else os.environ.get("COMMISSION_INTERNAL_TOKEN", "")
    if len(token) < 32:
        raise HTTPException(status_code=503, detail={"code": "ENGINE_AUTH_NOT_CONFIGURED"})
    return token


async def _authorize(authorization: str | None) -> None:
    expected = _internal_token()
    supplied = authorization.removeprefix("Bearer ") if authorization else ""
    if not hmac.compare_digest(expected.encode(), supplied.encode()):
        raise HTTPException(status_code=401, detail={"code": "ENGINE_AUTH_REQUIRED"})


@app.middleware("http")
async def request_size_limit(request: Request, call_next):
    if request.url.path.startswith("/internal/v1/"):
        raw_length = request.headers.get("content-length")
        if raw_length is None or not raw_length.isdigit():
            return JSONResponse(status_code=411, content={"code": "CONTENT_LENGTH_REQUIRED"})
        if int(raw_length) > MAX_REQUEST_BYTES:
            return JSONResponse(status_code=413, content={"code": "REQUEST_LIMIT"})
        original_receive = request._receive
        received = 0

        async def bounded_receive():
            nonlocal received
            message = await original_receive()
            if message.get("type") == "http.request":
                received += len(message.get("body", b""))
                if received > MAX_REQUEST_BYTES:
                    raise RequestSizeExceeded()
            return message

        request._receive = bounded_receive
        try:
            return await call_next(request)
        except RequestSizeExceeded:
            return JSONResponse(status_code=413, content={"code": "REQUEST_LIMIT"})
    return await call_next(request)


async def _execute(operation: str, execution_id: str, attempt_token: str, body: dict) -> bytes:
    try:
        response = await supervisor.execute(
            operation, execution_id, attempt_token,
            json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
        )
        decoded = json.loads(response)
        if isinstance(decoded, dict) and decoded.get("errorCode"):
            status = 422 if decoded["errorCode"] in {"FORMULA_REQUIRES_VALUE", "SLOWNIK_INCOMPLETE", "ENGINE_INPUT_INVALID", "DICTIONARY_REQUIRED"} else 400
            raise HTTPException(status_code=status, detail={"code": decoded["errorCode"], "message": decoded.get("message", "")})
        return response
    except EngineProcessError as exc:
        status = 408 if exc.code in {"ENGINE_TIMEOUT", "ENGINE_START_TIMEOUT"} else 429 if exc.code == "ENGINE_CAPACITY_EXCEEDED" else 503 if exc.code in {"ENGINE_INPUT_PIPE_UNAVAILABLE", "ENGINE_INTERNAL_ERROR"} else 409 if exc.code in {"EXECUTION_ALREADY_RUNNING", "ENGINE_CANCELLED"} else 502
        raise HTTPException(status_code=status, detail={"code": exc.code}) from exc


@app.get("/health/live")
async def health_live():
    return {"status": "live", "engineVersion": ENGINE_VERSION}


@app.get("/health/ready")
async def health_ready():
    try:
        _internal_token()
    except HTTPException:
        return JSONResponse(status_code=503, content={"status": "waiting"})
    return {"status": "ready", "engineVersion": ENGINE_VERSION, "contractVersion": 1}


@app.post("/internal/v1/dictionary/import")
async def dictionary_import(payload: DictionaryImportRequest, authorization: str | None = Header(default=None)):
    await _authorize(authorization)
    return Response(
        content=await _execute("dictionary-import", payload.executionId, payload.attemptToken, payload.model_dump()),
        media_type="application/json",
    )


@app.post("/internal/v1/compare")
async def compare(payload: CompareRequest, authorization: str | None = Header(default=None)):
    await _authorize(authorization)
    return Response(
        content=await _execute("compare", payload.executionId, payload.attemptToken, payload.model_dump()),
        media_type="application/json",
    )


@app.post("/internal/v1/export")
async def export(payload: ExportRequest, authorization: str | None = Header(default=None)):
    await _authorize(authorization)
    return Response(
        content=await _execute("export", payload.executionId, payload.attemptToken, payload.model_dump()),
        media_type="application/json",
    )


@app.post("/internal/v1/executions/{execution_id}/cancel")
async def cancel(execution_id: str, payload: CancelRequest, authorization: str | None = Header(default=None)):
    await _authorize(authorization)
    return {"cancelled": await supervisor.cancel(execution_id, payload.attemptToken)}
