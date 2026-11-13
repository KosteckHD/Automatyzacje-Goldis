import http.client
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
import unittest


class TransportSecurityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            cls.port = listener.getsockname()[1]
        allowed = {"path", "systemroot", "windir", "temp", "tmp", "userprofile", "localappdata"}
        environment = {key: value for key, value in os.environ.items() if key.lower() in allowed}
        cls.token = "synthetic-transport-token-" + "x" * 32
        environment.update({
            "PYTHONPATH": str(Path(__file__).resolve().parents[2] / "src"),
            "COMMISSION_INTERNAL_TOKEN": cls.token,
            "COMMISSION_MAX_REQUEST_BYTES": "4096",
            "COMMISSION_EXECUTION_TIMEOUT_SECONDS": "2",
        })
        cls.server = subprocess.Popen([
            sys.executable, "-m", "uvicorn", "goldis_commissions.transport.app:app",
            "--host", "127.0.0.1", "--port", str(cls.port), "--log-level", "warning",
        ], env=environment, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            try:
                if cls.request("GET", "/health/ready")[0] == 200:
                    return
            except OSError:
                pass
            if cls.server.poll() is not None:
                break
            time.sleep(0.1)
        cls.server.terminate()
        cls.server.wait(timeout=5)
        raise RuntimeError("ISOLATED_ENGINE_START_FAILED")

    @classmethod
    def tearDownClass(cls):
        cls.server.terminate()
        try:
            cls.server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            cls.server.kill()
            cls.server.wait(timeout=5)

    @classmethod
    def request(cls, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", cls.port, timeout=3)
        try:
            connection.request(method, path, body=body, headers=headers or {})
            response = connection.getresponse()
            return response.status, response.read()
        finally:
            connection.close()

    def test_readiness_and_disabled_documentation(self):
        status, body = self.request("GET", "/health/ready")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["contractVersion"], 1)
        self.assertEqual(self.request("GET", "/docs")[0], 404)
        self.assertEqual(self.request("GET", "/openapi.json")[0], 404)

    def test_cancel_requires_token_and_rejects_extra_fields(self):
        path = "/internal/v1/executions/synthetic-absent/cancel"
        body = json.dumps({"attemptToken": "synthetic-attempt"})
        headers = {"Content-Type": "application/json"}
        self.assertEqual(self.request("POST", path, body, headers)[0], 401)
        headers["Authorization"] = "Bearer wrong"
        self.assertEqual(self.request("POST", path, body, headers)[0], 401)
        headers["Authorization"] = "Bearer " + self.token
        status, response = self.request("POST", path, body, headers)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(response), {"cancelled": False})
        body = json.dumps({"attemptToken": "synthetic-attempt", "command": "unexpected"})
        self.assertEqual(self.request("POST", path, body, headers)[0], 422)

    def test_small_bounded_request_limit(self):
        status, body = self.request("POST", "/internal/v1/compare", b"x" * 4097,
                                    {"Content-Type": "application/json"})
        self.assertEqual(status, 413)
        self.assertEqual(json.loads(body)["code"], "REQUEST_LIMIT")

    def test_internal_request_requires_content_length(self):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        try:
            connection.putrequest("POST", "/internal/v1/compare")
            connection.endheaders()
            response = connection.getresponse()
            self.assertEqual(response.status, 411)
            self.assertEqual(json.loads(response.read())["code"], "CONTENT_LENGTH_REQUIRED")
        finally:
            connection.close()
