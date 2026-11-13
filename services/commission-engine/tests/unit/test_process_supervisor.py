import asyncio
import unittest
from unittest.mock import patch

from goldis_commissions.transport import process_supervisor
from goldis_commissions.transport.process_supervisor import EngineProcessError, ProcessSupervisor


class ProcessSupervisorEnvironmentTest(unittest.TestCase):
    def test_engine_child_receives_runtime_paths_but_no_application_secrets(self):
        environment = ProcessSupervisor._engine_environment({
            "PATH": "/usr/bin",
            "PYTHONPATH": "/app/src",
            "TMPDIR": "/tmp",
            "COMMISSION_INTERNAL_TOKEN_FILE": "/run/secrets/engine-token",
            "DATABASE_URL": "postgres://private",
            "SESSION_SECRET": "private",
            "PZU_PASSWORD": "private",
        })
        self.assertEqual(environment, {
            "PATH": "/usr/bin",
            "PYTHONPATH": "/app/src",
            "TMPDIR": "/tmp",
            "PYTHONUNBUFFERED": "1",
        })

    def test_execution_limit_is_configurable_but_bounded(self):
        with patch.dict("os.environ", {"COMMISSION_ENGINE_MAX_ACTIVE_EXECUTIONS": "2"}):
            supervisor = ProcessSupervisor()
            self.assertEqual(supervisor._slots._value, 2)
        with patch.dict("os.environ", {"COMMISSION_ENGINE_MAX_ACTIVE_EXECUTIONS": "9"}):
            with self.assertRaisesRegex(ValueError, "MAX_ACTIVE_EXECUTIONS_INVALID"):
                ProcessSupervisor()


class FakeStream:
    def __init__(self, contents=b""):
        self.contents = contents
        self.closed = asyncio.Event()

    async def read(self, size):
        if self.contents:
            result = self.contents[:size]
            self.contents = self.contents[size:]
            return result
        await self.closed.wait()
        return b""


class FakeStdin:
    def write(self, _payload):
        pass

    async def drain(self):
        pass

    def close(self):
        pass


class FakeProcess:
    def __init__(self, stdout=b"", stderr=b""):
        self.stdin = FakeStdin()
        self.stdout = FakeStream(stdout)
        self.stderr = FakeStream(stderr)
        self.returncode = None
        self.finished = asyncio.Event()
        self.killed = False

    async def wait(self):
        await self.finished.wait()
        return self.returncode

    def kill(self):
        self.killed = True
        self.returncode = -9
        self.stdout.closed.set()
        self.stderr.closed.set()
        self.finished.set()


class ProcessSupervisorAsyncTests(unittest.IsolatedAsyncioTestCase):
    async def test_timeout_kills_process_cleans_active_slot_and_registry(self):
        child = FakeProcess()

        async def create(*_args, **_kwargs):
            return child

        supervisor = ProcessSupervisor(timeout_seconds=0.05)
        with patch.object(process_supervisor.asyncio, "create_subprocess_exec", create):
            with self.assertRaisesRegex(EngineProcessError, "ENGINE_TIMEOUT"):
                await supervisor.execute("compare", "synthetic-execution", "synthetic-attempt", b"{}")
        self.assertTrue(child.killed)
        self.assertEqual(supervisor._active, {})
        self.assertEqual(supervisor._slots._value, 1)

    async def test_reader_limit_kills_child_and_releases_global_capacity(self):
        child = FakeProcess(stdout=b"x" * 9)

        async def create(*_args, **_kwargs):
            return child

        supervisor = ProcessSupervisor()
        with patch.object(process_supervisor.asyncio, "create_subprocess_exec", create):
            with patch.object(process_supervisor, "MAX_OUTPUT_BYTES", 8):
                with self.assertRaisesRegex(EngineProcessError, "ENGINE_OUTPUT_LIMIT"):
                    await supervisor.execute("compare", "synthetic-execution", "synthetic-attempt", b"{}")
        self.assertTrue(child.killed)
        self.assertEqual(supervisor._active, {})
        self.assertEqual(supervisor._slots._value, 1)

    async def test_capacity_timeout_is_bounded_and_cancel_is_attempt_fenced(self):
        child = FakeProcess(stdout=b"done")

        async def create(*_args, **_kwargs):
            return child

        supervisor = ProcessSupervisor(timeout_seconds=5)
        with patch.object(process_supervisor.asyncio, "create_subprocess_exec", create):
            first = asyncio.create_task(supervisor.execute("compare", "same-id", "attempt-one", b"{}"))
            await asyncio.sleep(0.02)
            with self.assertRaisesRegex(EngineProcessError, "ENGINE_CAPACITY_EXCEEDED"):
                await supervisor.execute("compare", "second-id", "attempt-two", b"{}")
            self.assertFalse(await supervisor.cancel("same-id", "stale-attempt"))
            self.assertTrue(await supervisor.cancel("same-id", "attempt-one"))
            with self.assertRaises(EngineProcessError):
                await first
        self.assertEqual(supervisor._active, {})
        self.assertEqual(supervisor._slots._value, 1)


if __name__ == "__main__":
    unittest.main()
