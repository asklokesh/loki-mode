from __future__ import annotations

import unittest
from unittest import mock


class ExecutionTargetStatusTests(unittest.TestCase):
    def test_status_response_exposes_engine_execution_target(self):
        from dashboard import server

        response = server.StatusResponse(
            status="idle",
            version="test",
            uptime_seconds=0,
        )
        self.assertEqual(response.execution_os, server._EXECUTION_OS)
        self.assertEqual(response.execution_cpu, server._EXECUTION_CPU)
        self.assertEqual(response.execution_libc, server._EXECUTION_LIBC)

    def test_darwin_arm64_maps_to_npm_target(self):
        from dashboard import server

        with mock.patch.object(server.sys, "platform", "darwin"), \
             mock.patch.object(server.platform, "machine", return_value="arm64"):
            self.assertEqual(
                server._npm_execution_target(),
                ("darwin", "arm64", ""),
            )

    def test_linux_target_requires_known_libc(self):
        from dashboard import server

        with mock.patch.object(server.sys, "platform", "linux"), \
             mock.patch.object(server.platform, "machine", return_value="x86_64"), \
             mock.patch.object(server.platform, "libc_ver", return_value=("glibc", "2.39")):
            self.assertEqual(
                server._npm_execution_target(),
                ("linux", "x64", "glibc"),
            )

    def test_unknown_platform_fails_closed(self):
        from dashboard import server

        with mock.patch.object(server.sys, "platform", "plan9"), \
             mock.patch.object(server.platform, "machine", return_value="mips"):
            self.assertEqual(server._npm_execution_target(), ("", "", ""))


if __name__ == "__main__":
    unittest.main()
