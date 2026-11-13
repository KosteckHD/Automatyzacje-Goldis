from __future__ import annotations

import asyncio
import os
import sys
from collections.abc import Mapping
from dataclasses import dataclass

MAX_OUTPUT_BYTES = 64 * 1024 * 1024
MAX_STDERR_BYTES = 64 * 1024
DEFAULT_MAX_ACTIVE_EXECUTIONS = 1
MAX_ALLOWED_ACTIVE_EXECUTIONS = 8
PROCESS_START_TIMEOUT_SECONDS = 5
SLOT_WAIT_TIMEOUT_SECONDS = 1


class EngineProcessError(RuntimeError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


@dataclass
class RunningExecution:
    process: asyncio.subprocess.Process
    attempt_token: str
    cancelled: bool = False


class ProcessSupervisor:
    def __init__(self, timeout_seconds: int = 600, max_active_executions: int | None = None):
        self.timeout_seconds = timeout_seconds
        if max_active_executions is None:
            configured = os.environ.get("COMMISSION_ENGINE_MAX_ACTIVE_EXECUTIONS", str(DEFAULT_MAX_ACTIVE_EXECUTIONS))
            try:
                max_active_executions = int(configured)
            except ValueError as exc:
                raise ValueError("COMMISSION_ENGINE_MAX_ACTIVE_EXECUTIONS_INVALID") from exc
        if not 1 <= max_active_executions <= MAX_ALLOWED_ACTIVE_EXECUTIONS:
            raise ValueError("COMMISSION_ENGINE_MAX_ACTIVE_EXECUTIONS_INVALID")
        self._active: dict[str, RunningExecution] = {}
        self._lock = asyncio.Lock()
        self._slots = asyncio.Semaphore(max_active_executions)

    async def execute(self, operation: str, execution_id: str, attempt_token: str, payload: bytes) -> bytes:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + self.timeout_seconds
        try:
            await asyncio.wait_for(
                self._slots.acquire(),
                timeout=min(SLOT_WAIT_TIMEOUT_SECONDS, max(0.001, deadline - loop.time())),
            )
        except TimeoutError as exc:
            raise EngineProcessError("ENGINE_CAPACITY_EXCEEDED") from exc
        process: asyncio.subprocess.Process | None = None
        registered = False
        try:
            async with self._lock:
                if execution_id in self._active:
                    raise EngineProcessError("EXECUTION_ALREADY_RUNNING")
                try:
                    process = await asyncio.wait_for(
                        asyncio.create_subprocess_exec(
                            sys.executable, "-m", "goldis_commissions.cli", operation,
                            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                            stderr=asyncio.subprocess.PIPE, env=self._engine_environment(os.environ),
                        ),
                        timeout=min(PROCESS_START_TIMEOUT_SECONDS, max(0.001, deadline - loop.time())),
                    )
                except TimeoutError as exc:
                    code = "ENGINE_TIMEOUT" if loop.time() >= deadline else "ENGINE_START_TIMEOUT"
                    raise EngineProcessError(code) from exc
                self._active[execution_id] = RunningExecution(process, attempt_token)
                registered = True
            output = await asyncio.wait_for(self._run_process(process, payload), timeout=max(0.001, deadline - loop.time()))
            async with self._lock:
                active = self._active.get(execution_id)
                if active and active.process is process and active.attempt_token == attempt_token and active.cancelled:
                    raise EngineProcessError("ENGINE_CANCELLED")
            return output
        except TimeoutError as exc:
            if process is not None:
                await self._kill(process)
            raise EngineProcessError("ENGINE_TIMEOUT") from exc
        except asyncio.CancelledError:
            if process is not None:
                await self._kill(process)
            raise
        finally:
            if registered:
                async with self._lock:
                    active = self._active.get(execution_id)
                    if active and active.process is process and active.attempt_token == attempt_token:
                        self._active.pop(execution_id, None)
            self._slots.release()

    async def _run_process(self, process: asyncio.subprocess.Process, payload: bytes) -> bytes:
        stdout_task = asyncio.create_task(self._read_limited(process.stdout, MAX_OUTPUT_BYTES, "ENGINE_OUTPUT_LIMIT"))
        stderr_task = asyncio.create_task(self._read_limited(process.stderr, MAX_STDERR_BYTES, "ENGINE_STDERR_LIMIT"))
        wait_task = asyncio.create_task(process.wait())
        tasks = {stdout_task, stderr_task, wait_task}
        try:
            if process.stdin is None:
                raise EngineProcessError("ENGINE_INPUT_PIPE_UNAVAILABLE")
            process.stdin.write(payload)
            await process.stdin.drain()
            process.stdin.close()
            done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_EXCEPTION)
            for task in done:
                error = task.exception()
                if error:
                    raise error
            if pending:
                await asyncio.gather(*pending)
            stdout = stdout_task.result()
            if process.returncode != 0 and not stdout:
                raise EngineProcessError("ENGINE_INPUT_INVALID")
            return stdout
        except BaseException:
            await self._kill(process)
            for task in tasks:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            raise

    @staticmethod
    def _engine_environment(source: Mapping[str, str]) -> dict[str, str]:
        allowed = {"PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR", "PYTHONPATH", "PYTHONHOME", "VIRTUAL_ENV", "LANG", "LC_ALL"}
        environment = {key: value for key, value in source.items() if key in allowed}
        environment["PYTHONUNBUFFERED"] = "1"
        return environment

    async def cancel(self, execution_id: str, attempt_token: str) -> bool:
        async with self._lock:
            active = self._active.get(execution_id)
            if not active or active.attempt_token != attempt_token:
                return False
            active.cancelled = True
            process = active.process
        await self._kill(process)
        return True

    @staticmethod
    async def _read_limited(stream: asyncio.StreamReader | None, limit: int, error_code: str) -> bytes:
        if stream is None:
            return b""
        chunks: list[bytes] = []
        size = 0
        while chunk := await stream.read(64 * 1024):
            size += len(chunk)
            if size > limit:
                raise EngineProcessError(error_code)
            chunks.append(chunk)
        return b"".join(chunks)

    @staticmethod
    async def _kill(process: asyncio.subprocess.Process) -> None:
        if process.returncode is None:
            try:
                process.kill()
            except ProcessLookupError:
                pass
            try:
                await asyncio.wait_for(process.wait(), timeout=5)
            except TimeoutError:
                pass
