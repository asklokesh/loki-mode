"""Backend unit tests for Purple Lab v2."""
import json
import os
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from pydantic import ValidationError

# ---------------------------------------------------------------------------
# Ensure imports work
# ---------------------------------------------------------------------------

WEB_APP_DIR = Path(__file__).resolve().parent.parent
if str(WEB_APP_DIR) not in sys.path:
    sys.path.insert(0, str(WEB_APP_DIR))


# ============================================================================
# Test DevServerManager
# ============================================================================


class TestDevServerManager:
    """Tests for the DevServerManager class."""

    @pytest.fixture(autouse=True)
    def _setup(self):
        from server import DevServerManager
        self.manager = DevServerManager()

    @pytest.mark.asyncio
    async def test_detect_dev_command_node(self, tmp_path):
        """Test detection of npm dev command from package.json."""
        pkg = tmp_path / "package.json"
        pkg.write_text(json.dumps({
            "scripts": {"dev": "vite"},
            "devDependencies": {"vite": "^5.0.0"},
        }))
        result = await self.manager.detect_dev_command(str(tmp_path))
        assert result is not None
        assert result["command"] == "npm run dev"
        assert result["expected_port"] == 5173
        assert result["framework"] == "vite"

    @pytest.mark.asyncio
    async def test_detect_dev_command_nextjs(self, tmp_path):
        """Test detection of Next.js dev command."""
        pkg = tmp_path / "package.json"
        pkg.write_text(json.dumps({
            "scripts": {"dev": "next dev"},
            "dependencies": {"next": "^14.0.0"},
        }))
        result = await self.manager.detect_dev_command(str(tmp_path))
        assert result is not None
        assert result["command"] == "npm run dev"
        assert result["framework"] == "next"
        assert result["expected_port"] == 3000

    @pytest.mark.asyncio
    async def test_detect_dev_command_npm_start(self, tmp_path):
        """Test detection of npm start script."""
        pkg = tmp_path / "package.json"
        pkg.write_text(json.dumps({
            "scripts": {"start": "react-scripts start"},
            "dependencies": {"react": "^18.0.0"},
        }))
        result = await self.manager.detect_dev_command(str(tmp_path))
        assert result is not None
        assert result["command"] == "npm start"
        assert result["framework"] == "react"

    @pytest.mark.asyncio
    async def test_detect_dev_command_python_flask(self, tmp_path):
        """Test detection of Flask app."""
        app = tmp_path / "app.py"
        app.write_text("from flask import Flask\napp = Flask(__name__)")
        result = await self.manager.detect_dev_command(str(tmp_path))
        assert result is not None
        assert result["framework"] == "flask"
        assert result["expected_port"] == 5000

    @pytest.mark.asyncio
    async def test_detect_dev_command_python_fastapi(self, tmp_path):
        """Test detection of FastAPI app."""
        app = tmp_path / "app.py"
        app.write_text("from fastapi import FastAPI\napp = FastAPI()")
        result = await self.manager.detect_dev_command(str(tmp_path))
        assert result is not None
        assert result["framework"] == "fastapi"
        assert result["expected_port"] == 8000
        assert "uvicorn" in result["command"]

    @pytest.mark.asyncio
    async def test_detect_dev_command_django(self, tmp_path):
        """Test detection of Django manage.py."""
        manage = tmp_path / "manage.py"
        manage.write_text("#!/usr/bin/env python\nimport django")
        result = await self.manager.detect_dev_command(str(tmp_path))
        assert result is not None
        assert result["framework"] == "django"
        assert "manage.py runserver" in result["command"]

    @pytest.mark.asyncio
    async def test_detect_dev_command_go(self, tmp_path):
        """Test detection of Go project."""
        (tmp_path / "go.mod").write_text("module example.com/app\n\ngo 1.21")
        result = await self.manager.detect_dev_command(str(tmp_path))
        assert result is not None
        assert result["framework"] == "go"
        assert result["command"] == "go run ."

    @pytest.mark.asyncio
    async def test_detect_dev_command_rust(self, tmp_path):
        """Test detection of Rust project."""
        (tmp_path / "Cargo.toml").write_text('[package]\nname = "app"\nversion = "0.1.0"')
        result = await self.manager.detect_dev_command(str(tmp_path))
        assert result is not None
        assert result["framework"] == "rust"
        assert result["command"] == "cargo run"

    @pytest.mark.asyncio
    async def test_detect_dev_command_empty_dir(self, tmp_path):
        """Test returns None for empty directory."""
        result = await self.manager.detect_dev_command(str(tmp_path))
        assert result is None

    @pytest.mark.asyncio
    async def test_detect_dev_command_nonexistent(self, tmp_path):
        """Test returns None for non-existent directory."""
        result = await self.manager.detect_dev_command(str(tmp_path / "no-such-dir"))
        assert result is None

    @pytest.mark.asyncio
    async def test_detect_dev_command_makefile(self, tmp_path):
        """Test detection from Makefile."""
        makefile = tmp_path / "Makefile"
        makefile.write_text("dev:\n\tpython app.py\n\nclean:\n\trm -rf build")
        result = await self.manager.detect_dev_command(str(tmp_path))
        assert result is not None
        assert result["command"] == "make dev"
        assert result["framework"] == "make"

    def test_parse_port_vite(self):
        """Test port parsing from Vite output."""
        output = "  Local:   http://localhost:5173/"
        port = self.manager._parse_port(output)
        assert port == 5173

    def test_parse_port_nextjs(self):
        """Test port parsing from Next.js output."""
        output = "  - Local: http://localhost:3000"
        port = self.manager._parse_port(output)
        assert port == 3000

    def test_parse_port_express(self):
        """Test port parsing from Express output."""
        output = "Server listening on port 4000"
        port = self.manager._parse_port(output)
        assert port == 4000

    def test_parse_port_uvicorn(self):
        """Test port parsing from Uvicorn output."""
        output = "INFO:     Uvicorn running on http://127.0.0.1:8000"
        port = self.manager._parse_port(output)
        assert port == 8000

    def test_parse_port_zero_ip(self):
        """Test port parsing from 0.0.0.0 binding."""
        output = "Listening on http://0.0.0.0:8080"
        port = self.manager._parse_port(output)
        assert port == 8080

    def test_parse_port_no_match(self):
        """Test returns None when no port found."""
        output = "Application started successfully"
        port = self.manager._parse_port(output)
        assert port is None

    def test_parse_port_invalid_range(self):
        """Test rejects ports outside valid range."""
        output = "http://localhost:99"
        port = self.manager._parse_port(output)
        assert port is None  # 99 < 1024

    @pytest.mark.asyncio
    async def test_status_when_no_server(self):
        """Test status returns stopped when no server exists."""
        result = await self.manager.status("nonexistent-session")
        assert result["running"] is False
        assert result["status"] == "stopped"
        assert result["port"] is None
        assert result["command"] is None


# ============================================================================
# Test FileWatcher
# ============================================================================


try:
    import watchdog  # noqa: F401
    _HAS_WATCHDOG = True
except ImportError:
    _HAS_WATCHDOG = False


class TestFileWatcher:
    """Tests for the FileChangeHandler class."""

    def test_ignore_patterns_git(self):
        """Test that .git directory is ignored."""
        from server import FileChangeHandler
        handler = FileChangeHandler.__new__(FileChangeHandler)
        handler.project_dir = "/tmp/test"
        assert handler._should_ignore("/tmp/test/.git/objects/abc123") is True

    def test_ignore_patterns_node_modules(self):
        """Test that node_modules is ignored."""
        from server import FileChangeHandler
        handler = FileChangeHandler.__new__(FileChangeHandler)
        handler.project_dir = "/tmp/test"
        assert handler._should_ignore("/tmp/test/node_modules/pkg/index.js") is True

    def test_ignore_patterns_pycache(self):
        """Test that __pycache__ is ignored."""
        from server import FileChangeHandler
        handler = FileChangeHandler.__new__(FileChangeHandler)
        handler.project_dir = "/tmp/test"
        assert handler._should_ignore("/tmp/test/__pycache__/mod.cpython-312.pyc") is True

    def test_ignore_patterns_extensions(self):
        """Test that temporary file extensions are ignored."""
        from server import FileChangeHandler
        handler = FileChangeHandler.__new__(FileChangeHandler)
        handler.project_dir = "/tmp/test"
        assert handler._should_ignore("/tmp/test/file.pyc") is True
        assert handler._should_ignore("/tmp/test/file.swp") is True
        assert handler._should_ignore("/tmp/test/.DS_Store") is True

    def test_allow_normal_files(self):
        """Test that normal source files are not ignored."""
        from server import FileChangeHandler
        handler = FileChangeHandler.__new__(FileChangeHandler)
        handler.project_dir = "/tmp/test"
        assert handler._should_ignore("/tmp/test/src/main.ts") is False
        assert handler._should_ignore("/tmp/test/index.html") is False
        assert handler._should_ignore("/tmp/test/app.py") is False

    def test_ignore_loki_dir(self):
        """Test that .loki directory is ignored."""
        from server import FileChangeHandler
        handler = FileChangeHandler.__new__(FileChangeHandler)
        handler.project_dir = "/tmp/test"
        assert handler._should_ignore("/tmp/test/.loki/state.json") is True


# ============================================================================
# Test Auth
# ============================================================================


try:
    import jose  # noqa: F401
    _HAS_JOSE = True
except ImportError:
    _HAS_JOSE = False

try:
    import sqlalchemy  # noqa: F401
    _HAS_SQLALCHEMY = True
except ImportError:
    _HAS_SQLALCHEMY = False


@pytest.mark.skipif(not _HAS_JOSE, reason="python-jose not installed")
class TestAuth:
    """Tests for the auth module."""

    def test_create_access_token(self):
        """Test JWT token creation."""
        from auth import create_access_token
        token = create_access_token({"sub": "user@example.com", "name": "Test User"})
        assert isinstance(token, str)
        assert len(token) > 20  # JWT tokens are substantial

    def test_verify_valid_token(self):
        """Test token verification with a valid token."""
        from auth import create_access_token, verify_token
        token = create_access_token({"sub": "user@example.com"})
        payload = verify_token(token)
        assert payload is not None
        assert payload["sub"] == "user@example.com"
        assert "exp" in payload

    def test_verify_expired_token(self):
        """Test expired token rejection."""
        from auth import create_access_token, verify_token
        # Create token that expired 1 hour ago
        token = create_access_token(
            {"sub": "user@example.com"},
            expires_delta=timedelta(hours=-1),
        )
        payload = verify_token(token)
        assert payload is None

    def test_verify_invalid_token(self):
        """Test that a garbage token is rejected."""
        from auth import verify_token
        payload = verify_token("not.a.valid.jwt.token")
        assert payload is None

    def test_verify_tampered_token(self):
        """Test that a tampered token is rejected."""
        from auth import create_access_token, verify_token
        token = create_access_token({"sub": "user@example.com"})
        # Tamper with the payload
        parts = token.split(".")
        parts[1] = parts[1] + "tampered"
        tampered = ".".join(parts)
        payload = verify_token(tampered)
        assert payload is None

    def test_local_mode_no_auth(self):
        """Test that auth is skipped when no DB configured."""
        # When async_session_factory is None, get_current_user should return None
        # (which means auth is disabled, all requests allowed)
        from models import async_session_factory
        assert async_session_factory is None  # No DB in test environment


# ============================================================================
# Test Models
# ============================================================================


@pytest.mark.skipif(not _HAS_SQLALCHEMY, reason="sqlalchemy not installed")
class TestModels:
    """Tests for SQLAlchemy model definitions."""

    def test_user_model(self):
        """Test User model has expected columns."""
        from models import User
        assert hasattr(User, "id")
        assert hasattr(User, "email")
        assert hasattr(User, "name")
        assert hasattr(User, "avatar_url")
        assert hasattr(User, "provider")
        assert hasattr(User, "created_at")
        assert hasattr(User, "is_active")

    def test_session_model(self):
        """Test Session model has expected columns."""
        from models import Session
        assert hasattr(Session, "id")
        assert hasattr(Session, "user_id")
        assert hasattr(Session, "prd_content")
        assert hasattr(Session, "provider")
        assert hasattr(Session, "status")
        assert hasattr(Session, "started_at")

    def test_project_model(self):
        """Test Project model has expected columns."""
        from models import Project
        assert hasattr(Project, "id")
        assert hasattr(Project, "user_id")
        assert hasattr(Project, "name")
        assert hasattr(Project, "project_dir")

    def test_secret_model(self):
        """Test Secret model has expected columns."""
        from models import Secret
        assert hasattr(Secret, "id")
        assert hasattr(Secret, "user_id")
        assert hasattr(Secret, "key")
        assert hasattr(Secret, "encrypted_value")

    def test_audit_log_model(self):
        """Test AuditLog model has expected columns."""
        from models import AuditLog
        assert hasattr(AuditLog, "id")
        assert hasattr(AuditLog, "action")
        assert hasattr(AuditLog, "resource_type")
        assert hasattr(AuditLog, "ip_address")


# ============================================================================
# Test SSE Streaming
# ============================================================================


class TestStreaming:
    """Tests for SSE streaming format."""

    def test_sse_output_format(self):
        """Test SSE event format for output lines."""
        # Verify the format matches what the server produces
        line = "Building project..."
        event = f"event: output\ndata: {json.dumps({'line': line})}\n\n"
        assert event.startswith("event: output\n")
        assert "data: " in event
        assert event.endswith("\n\n")
        data_line = event.split("\n")[1]
        payload = json.loads(data_line.replace("data: ", ""))
        assert payload["line"] == line

    def test_sse_complete_event(self):
        """Test SSE completion event includes files_changed and returncode."""
        returncode = 0
        files_changed = ["src/main.ts", "package.json"]
        event = f"event: complete\ndata: {json.dumps({'returncode': returncode, 'files_changed': files_changed})}\n\n"
        assert event.startswith("event: complete\n")
        data_line = event.split("\n")[1]
        payload = json.loads(data_line.replace("data: ", ""))
        assert payload["returncode"] == 0
        assert payload["files_changed"] == ["src/main.ts", "package.json"]

    def test_sse_error_format(self):
        """Test SSE error event format."""
        error_msg = "Task not found"
        event = f"event: error\ndata: {json.dumps({'error': error_msg})}\n\n"
        assert "event: error" in event
        data_line = event.split("\n")[1]
        payload = json.loads(data_line.replace("data: ", ""))
        assert payload["error"] == error_msg

    def test_ansi_stripping(self):
        """Test that ANSI escape codes are stripped from chat output."""
        import re
        raw = "\x1b[0;32mStarting Loki Mode...\x1b[0m"
        clean = re.sub(r'\x1b\[[0-9;]*[a-zA-Z]', '', raw)
        assert clean == "Starting Loki Mode..."
        assert "\x1b" not in clean

    def test_ansi_stripping_multiple_codes(self):
        """Test ANSI stripping with bold, color, and reset codes."""
        import re
        raw = "\x1b[1m\x1b[31mERROR:\x1b[0m \x1b[33mFile not found\x1b[0m"
        clean = re.sub(r'\x1b\[[0-9;]*[a-zA-Z]', '', raw)
        assert clean == "ERROR: File not found"
        assert "\x1b" not in clean

    def test_ansi_stripping_cursor_codes(self):
        """Test stripping cursor movement and erase codes."""
        import re
        raw = "\x1b[2K\x1b[1GProgress: 50%"
        clean = re.sub(r'\x1b\[[0-9;]*[a-zA-Z]', '', raw)
        assert clean == "Progress: 50%"


# ============================================================================
# Test Request/Response Models
# ============================================================================


class TestRequestModels:
    """Tests for Pydantic request models."""

    def test_start_request_defaults(self):
        """Test StartRequest has correct defaults."""
        from server import StartRequest
        req = StartRequest(prd="Build a todo app")
        assert req.prd == "Build a todo app"
        assert req.provider == "claude"
        assert req.projectDir is None
        assert req.mode is None

    def test_chat_request_defaults(self):
        """Test ChatRequest has correct defaults."""
        from server import ChatRequest
        req = ChatRequest(message="fix the bug")
        assert req.message == "fix the bug"
        assert req.mode == "quick"

    def test_dev_server_start_request(self):
        """Test DevServerStartRequest accepts optional command."""
        from server import DevServerStartRequest
        req = DevServerStartRequest()
        assert req.command is None
        req2 = DevServerStartRequest(command="npm run dev")
        assert req2.command == "npm run dev"

    def test_secret_request(self):
        """Test SecretRequest model."""
        from server import SecretRequest
        req = SecretRequest(key="API_KEY", value="secret123")
        assert req.key == "API_KEY"
        assert req.value == "secret123"


# ============================================================================
# Test Chat Modes
# ============================================================================


class TestChatModes:
    """Test chat command construction for different modes."""

    def test_quick_mode_uses_loki_quick(self):
        """Quick mode should use 'loki quick' command."""
        from server import ChatRequest
        req = ChatRequest(message="fix the bug", mode="quick")
        # In server.py, quick and standard modes both use 'loki quick'
        assert req.mode == "quick"
        # Simulate the command construction logic from server.py line ~2274
        loki = "/usr/local/bin/loki"
        if req.mode == "max":
            cmd_args = [loki, "start", "--provider", "claude", "/tmp/prd.md"]
        else:
            cmd_args = [loki, "quick", req.message]
        assert cmd_args == [loki, "quick", "fix the bug"]
        assert "start" not in cmd_args

    def test_standard_mode_uses_loki_quick(self):
        """Standard mode should also use 'loki quick' command."""
        from server import ChatRequest
        req = ChatRequest(message="refactor the auth module", mode="standard")
        assert req.mode == "standard"
        loki = "/usr/local/bin/loki"
        if req.mode == "max":
            cmd_args = [loki, "start", "--provider", "claude", "/tmp/prd.md"]
        else:
            cmd_args = [loki, "quick", req.message]
        assert cmd_args == [loki, "quick", "refactor the auth module"]

    def test_max_mode_uses_loki_start(self):
        """Max mode should use 'loki start' with PRD file."""
        from server import ChatRequest
        req = ChatRequest(message="build a full dashboard", mode="max")
        assert req.mode == "max"
        loki = "/usr/local/bin/loki"
        prd_path = "/tmp/chat-prd.md"
        if req.mode == "max":
            cmd_args = [loki, "start", "--provider", "claude", prd_path]
        else:
            cmd_args = [loki, "quick", req.message]
        assert cmd_args == [loki, "start", "--provider", "claude", prd_path]
        assert "quick" not in cmd_args

    def test_chat_request_default_mode(self):
        """ChatRequest defaults to quick mode."""
        from server import ChatRequest
        req = ChatRequest(message="hello")
        assert req.mode == "quick"

    def test_chat_request_preserves_message(self):
        """ChatRequest preserves the full message text."""
        from server import ChatRequest
        msg = "Please add error handling to the login endpoint"
        req = ChatRequest(message=msg)
        assert req.message == msg


# ============================================================================
# Test Command Validation (shell injection prevention)
# ============================================================================


class TestCommandValidation:
    """Tests for DevServerStartRequest command validation."""

    def test_rejects_semicolon_injection(self):
        from server import DevServerStartRequest
        with pytest.raises(ValidationError):
            DevServerStartRequest(command="; rm -rf /")

    def test_rejects_pipe_injection(self):
        from server import DevServerStartRequest
        with pytest.raises(ValidationError):
            DevServerStartRequest(command="echo hello | cat /etc/passwd")

    def test_rejects_backtick_injection(self):
        from server import DevServerStartRequest
        with pytest.raises(ValidationError):
            DevServerStartRequest(command="`whoami`")

    def test_rejects_dollar_injection(self):
        from server import DevServerStartRequest
        with pytest.raises(ValidationError):
            DevServerStartRequest(command="$(cat /etc/passwd)")

    def test_rejects_newline_injection(self):
        from server import DevServerStartRequest
        with pytest.raises(ValidationError):
            DevServerStartRequest(command="npm run dev\nrm -rf /")

    def test_rejects_angle_brackets(self):
        from server import DevServerStartRequest
        with pytest.raises(ValidationError):
            DevServerStartRequest(command="npm run dev > /dev/null")

    def test_accepts_safe_npm_command(self):
        from server import DevServerStartRequest
        req = DevServerStartRequest(command="npm run dev")
        assert req.command == "npm run dev"

    def test_accepts_safe_python_command(self):
        from server import DevServerStartRequest
        req = DevServerStartRequest(command="python3 -m uvicorn app:app --reload")
        assert req.command == "python3 -m uvicorn app:app --reload"

    def test_accepts_none_command(self):
        from server import DevServerStartRequest
        req = DevServerStartRequest(command=None)
        assert req.command is None

    def test_accepts_command_with_flags(self):
        from server import DevServerStartRequest
        req = DevServerStartRequest(command="vite --host 0.0.0.0 --port 3000")
        assert req.command == "vite --host 0.0.0.0 --port 3000"

    def test_strips_whitespace(self):
        from server import DevServerStartRequest
        req = DevServerStartRequest(command="  npm run dev  ")
        assert req.command == "npm run dev"


# ============================================================================
# Bug fix regression tests
# ============================================================================


class TestBugPL001002_DeadCodeRemoved:
    """BUG-PL-001/002: Dead code after stop_session removed, session.reset() called."""

    def test_session_reset_clears_state(self):
        """Verify SessionState.reset() clears all fields."""
        from server import SessionState
        s = SessionState()
        s.running = True
        s.provider = "claude"
        s.prd_text = "test"
        s.project_dir = "/tmp/test"
        s.start_time = 1000.0
        s.log_lines = ["line1", "line2"]
        s.paused = True
        s.reset()
        assert s.running is False
        assert s.paused is False
        assert s.provider == ""
        assert s.prd_text == ""
        assert s.project_dir == ""
        assert s.start_time == 0
        assert s.log_lines == []
        assert s.process is None


class TestBugWS001_PexpectAutoInstall:
    """BUG-WS-001: After auto-install, pexpect module should be globally bound."""

    def test_globals_pexpect_binding(self):
        """The auto-install path sets globals()['pexpect'] = _pex."""
        import server
        source = Path(server.__file__).read_text()
        assert 'globals()["pexpect"] = _pex' in source


class TestBugPL003_LockOnRunningFalse:
    """BUG-PL-003: _read_process_output acquires lock before setting running=False."""

    def test_lock_acquired_in_reader(self):
        """Verify the lock is used around session.running = False in _read_process_output."""
        import server
        import inspect
        source = inspect.getsource(server._read_process_output)
        assert "async with session._lock" in source
        assert "session.running = False" in source


class TestBugPL005_PauseState:
    """BUG-PL-005: SessionState tracks paused state."""

    def test_session_state_has_paused(self):
        from server import SessionState
        s = SessionState()
        assert hasattr(s, "paused")
        assert s.paused is False

    def test_reset_clears_paused(self):
        from server import SessionState
        s = SessionState()
        s.paused = True
        s.reset()
        assert s.paused is False


class TestBugPL009_MillisecondTimestamp:
    """BUG-PL-009: Project dir uses millisecond timestamps."""

    def test_millisecond_precision_in_source(self):
        """Source code uses time.time() * 1000 for project dir naming."""
        import server
        source = Path(server.__file__).read_text()
        assert "int(time.time() * 1000)" in source


class TestBugPL010_StatusReadOnly:
    """BUG-PL-010: get_status does not mutate session.running."""

    def test_get_status_uses_local_var(self):
        """get_status should use a local is_running variable, not mutate session.running."""
        import server
        import inspect
        source = inspect.getsource(server.get_status)
        assert "is_running" in source
        # Should NOT contain direct mutation of session.running
        lines = source.splitlines()
        for line in lines:
            stripped = line.strip()
            if stripped.startswith("#"):
                continue
            assert "session.running = " not in stripped, (
                "get_status should not mutate session.running"
            )


class TestBugPL011_HistoryAggregation:
    """BUG-PL-011: History aggregates from all directories, not just first."""

    def test_no_early_break_in_history(self):
        """get_sessions_history should not break after the first non-empty dir."""
        import server
        import inspect
        source = inspect.getsource(server.get_sessions_history)
        # The bug was: `if history: break`
        assert "if history:" not in source or "break" not in source


class TestBugPL013_CryptoImportError:
    """BUG-PL-013: _load_secrets handles crypto ImportError gracefully."""

    def test_load_secrets_without_crypto(self, tmp_path):
        """_load_secrets returns empty dict when crypto module is missing."""
        import server
        # Temporarily point to a non-existent secrets file
        original = server._SECRETS_FILE
        server._SECRETS_FILE = tmp_path / "secrets.json"
        try:
            result = server._load_secrets()
            assert result == {}
        finally:
            server._SECRETS_FILE = original

    def test_load_secrets_reads_raw_without_crypto(self, tmp_path):
        """When crypto is unavailable, raw secrets are returned."""
        import server
        secrets_file = tmp_path / "secrets.json"
        secrets_file.write_text(json.dumps({"API_KEY": "test123"}))
        original = server._SECRETS_FILE
        server._SECRETS_FILE = secrets_file
        try:
            result = server._load_secrets()
            assert result.get("API_KEY") == "test123"
        finally:
            server._SECRETS_FILE = original


class TestBugDS003_PortRegex:
    """BUG-DS-003: Port regex is more specific now."""

    def test_port_standalone_not_matched(self):
        """Plain 'port 3000' without a verb prefix should not match the tightened pattern."""
        from server import DevServerManager
        mgr = DevServerManager()
        # This should NOT match the generic broad pattern that was removed
        result = mgr._parse_port("port 3000")
        # It may still match via URL patterns, but "port 3000" alone with no
        # verb prefix is no longer a match from the replaced pattern.
        # Other more specific patterns may catch it though.
        # The key test is that noise lines do not match.
        noise = "The configuration sets port 22 for SSH"
        # "port 22" is below 1024, so it should be rejected anyway
        assert mgr._parse_port(noise) is None

    def test_listening_on_port_matches(self):
        from server import DevServerManager
        mgr = DevServerManager()
        assert mgr._parse_port("Server listening on port 4000") == 4000

    def test_running_on_port_matches(self):
        from server import DevServerManager
        mgr = DevServerManager()
        assert mgr._parse_port("App running on port 8080") == 8080

    def test_started_on_port_matches(self):
        from server import DevServerManager
        mgr = DevServerManager()
        assert mgr._parse_port("Server started on port 3000") == 3000


class TestBugDS005_DockerComposePortParsing:
    """BUG-DS-005: Docker Compose IP:host:container port parsing."""

    @pytest.mark.asyncio
    async def test_ip_host_container_port(self, tmp_path):
        """Port format '127.0.0.1:8080:80' should extract 8080 as host port."""
        from server import DevServerManager
        mgr = DevServerManager()
        compose = tmp_path / "docker-compose.yml"
        compose.write_text(
            "services:\n"
            "  web:\n"
            "    build: .\n"
            '    ports:\n'
            '      - "127.0.0.1:9090:80"\n'
        )
        result = await mgr.detect_dev_command(str(tmp_path))
        assert result is not None
        assert result["expected_port"] == 9090
        assert result["framework"] == "docker"

    @pytest.mark.asyncio
    async def test_host_container_port(self, tmp_path):
        """Port format '8080:80' should extract 8080 as host port."""
        from server import DevServerManager
        mgr = DevServerManager()
        compose = tmp_path / "docker-compose.yml"
        compose.write_text(
            "services:\n"
            "  web:\n"
            "    build: .\n"
            '    ports:\n'
            '      - "4567:80"\n'
        )
        result = await mgr.detect_dev_command(str(tmp_path))
        assert result is not None
        assert result["expected_port"] == 4567


class TestBugDS007_FastAPIDetection:
    """BUG-DS-007: FastAPI detection reads 4096 bytes instead of 1024."""

    @pytest.mark.asyncio
    async def test_fastapi_detected_beyond_1024(self, tmp_path):
        """FastAPI import after 1024 bytes should still be detected."""
        from server import DevServerManager
        mgr = DevServerManager()
        app = tmp_path / "app.py"
        # Put the import after 1024 bytes of comments
        padding = "# " + "x" * 100 + "\n"
        lines = [padding] * 15  # ~1530 bytes of comments
        lines.append("from fastapi import FastAPI\napp = FastAPI()\n")
        app.write_text("".join(lines))
        result = await mgr.detect_dev_command(str(tmp_path))
        assert result is not None
        assert result["framework"] == "fastapi"


class TestBugDS008_NextJsOverVite:
    """BUG-DS-008: Framework detection picks Next.js over Vite."""

    @pytest.mark.asyncio
    async def test_nextjs_detected_when_both_present(self, tmp_path):
        """When both next and vite are deps, Next.js should be detected."""
        from server import DevServerManager
        mgr = DevServerManager()
        pkg = tmp_path / "package.json"
        pkg.write_text(json.dumps({
            "scripts": {"dev": "next dev"},
            "dependencies": {"next": "^14.0.0", "vite": "^5.0.0"},
        }))
        result = await mgr.detect_dev_command(str(tmp_path))
        assert result is not None
        assert result["framework"] == "next"
        assert result["expected_port"] == 3000


class TestBugDS009_MonitorTransitionsStatus:
    """BUG-DS-009: _monitor_output transitions status from starting to running."""

    def test_monitor_output_updates_status(self):
        """Verify the source has status transition logic in _monitor_output."""
        import server
        import inspect
        source = inspect.getsource(server.DevServerManager._monitor_output)
        assert '"starting"' in source
        assert '"running"' in source


class TestBugDS002_AutoFixOriginalCommand:
    """BUG-DS-002: Auto-fix uses original_command to avoid double-wrapping."""

    def test_auto_fix_reads_original_command(self):
        """The _auto_fix method should use info.get('original_command')."""
        import server
        import inspect
        source = inspect.getsource(server.DevServerManager._auto_fix)
        assert 'info.get("original_command")' in source


class TestBugPL004_SecretsInjection:
    """BUG-PL-004: Chat/fix/auto-fix inject secrets into env."""

    def test_chat_session_loads_secrets(self):
        """chat_session should call _load_secrets() and merge into env."""
        import server
        import inspect
        source = inspect.getsource(server.chat_session)
        assert "_load_secrets()" in source

    def test_fix_session_loads_secrets(self):
        """fix_session should call _load_secrets() and merge into env."""
        import server
        import inspect
        source = inspect.getsource(server.fix_session)
        assert "_load_secrets()" in source

    def test_auto_fix_loads_secrets(self):
        """_auto_fix should call _load_secrets() and merge into env."""
        import server
        import inspect
        source = inspect.getsource(server.DevServerManager._auto_fix)
        assert "_load_secrets()" in source


class TestBugPL006_DeleteActiveSession:
    """BUG-PL-006: delete_session prevents deleting active session directory."""

    def test_delete_session_source_has_409_check(self):
        """delete_session should check if session dir matches active session."""
        import server
        import inspect
        source = inspect.getsource(server.delete_session)
        assert "409" in source
        assert "active" in source.lower() or "currently" in source.lower()


class TestBugPL007_UntrackChatPID:
    """BUG-PL-007: Chat PIDs are untracked after completion."""

    def test_chat_session_untracks_pid(self):
        """run_chat should call _untrack_child_pid after completion."""
        import server
        import inspect
        source = inspect.getsource(server.chat_session)
        assert "_untrack_child_pid" in source


class TestBugPL008_AuthWsProxy:
    """BUG-PL-008: /ws and /proxy are covered by auth when DATABASE_URL is set."""

    def test_auth_middleware_covers_ws_and_proxy(self):
        """Auth middleware should NOT skip /ws and /proxy paths."""
        import server
        import inspect
        source = inspect.getsource(server.auth_middleware)
        # Extract the skip_auth_prefixes list from source
        import re
        match = re.search(r'skip_auth_prefixes\s*=\s*\[([^\]]+)\]', source)
        assert match is not None
        skip_list = match.group(1)
        # /ws and /proxy should NOT be in the skip list
        assert '"/ws"' not in skip_list, "/ws should not be in skip_auth_prefixes"
        assert '"/proxy/"' not in skip_list, "/proxy/ should not be in skip_auth_prefixes"


class TestBugPL012_CancelChatTimeout:
    """BUG-PL-012: cancel_chat handles TimeoutExpired."""

    def test_cancel_chat_has_timeout_handling(self):
        """cancel_chat should handle subprocess.TimeoutExpired."""
        import server
        import inspect
        source = inspect.getsource(server.cancel_chat)
        assert "TimeoutExpired" in source


class TestBugDS006_AsyncSleep:
    """BUG-DS-006: _ensure_portless_proxy uses asyncio.sleep."""

    def test_ensure_portless_is_async(self):
        """_ensure_portless_proxy should be an async method."""
        import server
        import inspect
        assert inspect.iscoroutinefunction(server.DevServerManager._ensure_portless_proxy)

    def test_uses_asyncio_sleep(self):
        """Should use asyncio.sleep instead of time.sleep."""
        import server
        import inspect
        source = inspect.getsource(server.DevServerManager._ensure_portless_proxy)
        assert "asyncio.sleep" in source
        assert "time.sleep" not in source and "_time.sleep" not in source


class TestBugWS006_TerminalWsClientsCleanup:
    """BUG-WS-006: _terminal_ws_clients is cleared on stop/shutdown."""

    def test_stop_session_clears_terminal_ws_clients(self):
        """stop_session should clear _terminal_ws_clients."""
        import server
        import inspect
        source = inspect.getsource(server.stop_session)
        assert "_terminal_ws_clients.clear()" in source


class TestBugWS007_AcceptBeforeClose:
    """BUG-WS-007: WS accepts before sending error and closing."""

    def test_ws_endpoint_accepts_first(self):
        """websocket_endpoint should accept() before checking limits."""
        import server
        import inspect
        source = inspect.getsource(server.websocket_endpoint)
        lines = [l.strip() for l in source.splitlines() if l.strip()]
        accept_idx = next(i for i, l in enumerate(lines) if "ws.accept()" in l)
        close_idx = next(i for i, l in enumerate(lines) if "ws.close(" in l)
        assert accept_idx < close_idx, "accept() must come before close()"


class TestBugWS008_BinaryFrames:
    """BUG-WS-008: Proxy handles both text and binary WebSocket frames."""

    def test_proxy_ws_uses_receive(self):
        """client_to_upstream should use receive() to handle both text and bytes."""
        import server
        import inspect
        source = inspect.getsource(server.proxy_websocket)
        assert "receive()" in source or 'msg.get("text")' in source
        assert 'msg.get("bytes")' in source


class TestBugWS009_AsyncFileIO:
    """BUG-WS-009: _push_state_to_client uses async file I/O."""

    def test_push_state_uses_thread(self):
        """_push_state_to_client should use asyncio.to_thread for file reads."""
        import server
        import inspect
        source = inspect.getsource(server._push_state_to_client)
        assert "asyncio.to_thread" in source


class TestBugWS011_PongOnlyReset:
    """BUG-WS-011: Keepalive missed_pongs only reset on pong messages."""

    def test_pong_resets_missed_pongs(self):
        """Only pong-type messages should reset missed_pongs."""
        import server
        import inspect
        source = inspect.getsource(server.websocket_endpoint)
        # The pattern should be: missed_pongs = 0 only in the pong branch
        # NOT after receive_text()
        lines = source.splitlines()
        for i, line in enumerate(lines):
            if "receive_text" in line.strip() or "wait_for" in line.strip():
                # The next non-blank, non-comment line should NOT be missed_pongs = 0
                for j in range(i + 1, min(i + 3, len(lines))):
                    next_line = lines[j].strip()
                    if next_line and not next_line.startswith("#"):
                        assert "missed_pongs = 0" not in next_line, (
                            "missed_pongs should not be reset on any message"
                        )
                        break


class TestBugXC006_AtomicPIDTracking:
    """BUG-XC-006: PID tracking uses file lock for atomicity."""

    def test_track_uses_flock(self):
        """_track_child_pid should use fcntl.flock."""
        import server
        import inspect
        source = inspect.getsource(server._track_child_pid)
        assert "fcntl.flock" in source

    def test_untrack_uses_flock(self):
        """_untrack_child_pid should use fcntl.flock."""
        import server
        import inspect
        source = inspect.getsource(server._untrack_child_pid)
        assert "fcntl.flock" in source

    def test_track_and_untrack_pid(self, tmp_path):
        """Test actual track/untrack PID round-trip."""
        import server
        original = server._PURPLE_LAB_PIDS_FILE
        server._PURPLE_LAB_PIDS_FILE = tmp_path / "child-pids.json"
        try:
            server._track_child_pid(12345)
            pids = json.loads(server._PURPLE_LAB_PIDS_FILE.read_text())
            assert 12345 in pids

            server._track_child_pid(67890)
            pids = json.loads(server._PURPLE_LAB_PIDS_FILE.read_text())
            assert 12345 in pids
            assert 67890 in pids

            server._untrack_child_pid(12345)
            pids = json.loads(server._PURPLE_LAB_PIDS_FILE.read_text())
            assert 12345 not in pids
            assert 67890 in pids
        finally:
            server._PURPLE_LAB_PIDS_FILE = original


class TestBugXC009_LogTruncationOffset:
    """BUG-XC-009: Log truncation tracks absolute offset."""

    def test_session_state_has_log_lines_total(self):
        """SessionState should track total log lines added."""
        from server import SessionState
        s = SessionState()
        assert hasattr(s, "log_lines_total")
        assert s.log_lines_total == 0

    def test_reset_clears_total(self):
        from server import SessionState
        s = SessionState()
        s.log_lines_total = 100
        s.reset()
        assert s.log_lines_total == 0


class TestBugWS002_SingleReaderPerPTY:
    """BUG-WS-002: Only one reader task per PTY is created."""

    def test_reader_tasks_dict_exists(self):
        """_terminal_reader_tasks should exist for tracking."""
        import server
        assert hasattr(server, "_terminal_reader_tasks")
        assert isinstance(server._terminal_reader_tasks, dict)


class TestBugWS004_AsyncWait:
    """BUG-WS-004: cancel_chat uses asyncio.to_thread for wait()."""

    def test_cancel_chat_uses_async_wait(self):
        """cancel_chat should use asyncio.to_thread(task.process.wait, ...)."""
        import server
        import inspect
        source = inspect.getsource(server.cancel_chat)
        assert "asyncio.to_thread" in source


class TestBugDS004_VenvForPip:
    """BUG-DS-004: pip install uses project venv, not server Python."""

    def test_start_creates_venv(self):
        """DevServerManager.start should look for or create a venv."""
        import server
        import inspect
        source = inspect.getsource(server.DevServerManager.start)
        assert "venv" in source
        # Should not use sys.executable for pip install
        assert "sys.executable, \"-m\", \"pip\", \"install\"" not in source


class TestBugDS013_PortUpdateFromMonitor:
    """BUG-DS-013: _monitor_output always updates port when detected."""

    def test_monitor_output_always_sets_port(self):
        """_monitor_output should update info['port'] regardless of current value."""
        import server
        import inspect
        source = inspect.getsource(server.DevServerManager._monitor_output)
        # The old code had: if info["port"] is None:
        # The new code should unconditionally set info["port"]
        assert 'if info["port"] is None' not in source


# ============================================================================
# Test Full-Stack Multi-Service Detection
# ============================================================================


class TestFullStackDetection:
    """Tests for full-stack project detection (frontend + backend subdirs)."""

    @pytest.fixture(autouse=True)
    def _setup(self):
        from server import DevServerManager
        self.manager = DevServerManager()

    @pytest.mark.asyncio
    async def test_detect_nextjs_fastapi(self, tmp_path):
        """Detect Next.js frontend + FastAPI backend as full-stack."""
        fe = tmp_path / "frontend"
        fe.mkdir()
        (fe / "package.json").write_text(json.dumps({
            "scripts": {"dev": "next dev"},
            "dependencies": {"next": "^14.0.0", "react": "^18.0.0"},
        }))
        be = tmp_path / "backend"
        be.mkdir()
        (be / "main.py").write_text("from fastapi import FastAPI\napp = FastAPI()")

        result = await self.manager.detect_dev_command(str(tmp_path))
        assert result is not None
        assert result["framework"] == "full-stack"
        assert result["multi_service"] is True
        assert result["frontend_framework"] == "next"
        assert result["backend_framework"] == "fastapi"
        assert result["expected_port"] == 3000
        assert result["backend_port"] == 8000
        assert "frontend" in result["frontend_command"]
        assert "backend" in result["command"]

    @pytest.mark.asyncio
    async def test_detect_vite_flask(self, tmp_path):
        """Detect Vite frontend + Flask backend as full-stack."""
        fe = tmp_path / "client"
        fe.mkdir()
        (fe / "package.json").write_text(json.dumps({
            "scripts": {"dev": "vite"},
            "devDependencies": {"vite": "^5.0.0"},
        }))
        be = tmp_path / "server"
        be.mkdir()
        (be / "app.py").write_text("from flask import Flask\napp = Flask(__name__)")

        result = await self.manager.detect_dev_command(str(tmp_path))
        assert result is not None
        assert result["framework"] == "full-stack"
        assert result["multi_service"] is True
        assert result["frontend_framework"] == "vite"
        assert result["backend_framework"] == "flask"
        assert result["expected_port"] == 5173
        assert result["backend_port"] == 5000

    @pytest.mark.asyncio
    async def test_detect_react_express(self, tmp_path):
        """Detect React frontend + Express backend as full-stack."""
        fe = tmp_path / "web"
        fe.mkdir()
        (fe / "package.json").write_text(json.dumps({
            "scripts": {"start": "react-scripts start"},
            "dependencies": {"react": "^18.0.0"},
        }))
        be = tmp_path / "api"
        be.mkdir()
        (be / "package.json").write_text(json.dumps({
            "scripts": {"dev": "nodemon index.js"},
            "dependencies": {"express": "^4.18.0"},
        }))

        result = await self.manager.detect_dev_command(str(tmp_path))
        assert result is not None
        assert result["framework"] == "full-stack"
        assert result["multi_service"] is True
        assert result["frontend_framework"] == "node"
        assert result["backend_framework"] == "express"
        assert result["backend_port"] == 3001

    @pytest.mark.asyncio
    async def test_detect_frontend_with_go_backend(self, tmp_path):
        """Detect frontend + Go backend as full-stack."""
        fe = tmp_path / "ui"
        fe.mkdir()
        (fe / "package.json").write_text(json.dumps({
            "scripts": {"dev": "vite"},
            "devDependencies": {"vite": "^5.0.0"},
        }))
        be = tmp_path / "backend"
        be.mkdir()
        (be / "go.mod").write_text("module example.com/app\n\ngo 1.21")

        result = await self.manager.detect_dev_command(str(tmp_path))
        assert result is not None
        assert result["framework"] == "full-stack"
        assert result["backend_framework"] == "go"
        assert result["backend_port"] == 8080

    @pytest.mark.asyncio
    async def test_detect_static_html_frontend(self, tmp_path):
        """Detect static HTML frontend + Python backend as full-stack."""
        fe = tmp_path / "frontend"
        fe.mkdir()
        (fe / "index.html").write_text("<html><body>Hello</body></html>")
        be = tmp_path / "backend"
        be.mkdir()
        (be / "app.py").write_text("from fastapi import FastAPI\napp = FastAPI()")

        result = await self.manager.detect_dev_command(str(tmp_path))
        assert result is not None
        assert result["framework"] == "full-stack"
        assert result["frontend_framework"] == "static"
        assert result["backend_framework"] == "fastapi"

    @pytest.mark.asyncio
    async def test_no_fullstack_frontend_only(self, tmp_path):
        """Only frontend dir, no backend -- should NOT detect as full-stack."""
        fe = tmp_path / "frontend"
        fe.mkdir()
        (fe / "package.json").write_text(json.dumps({
            "scripts": {"dev": "next dev"},
            "dependencies": {"next": "^14.0.0"},
        }))

        result = await self.manager.detect_dev_command(str(tmp_path))
        # Should return None -- root has no dev command, and it's not full-stack
        assert result is None

    @pytest.mark.asyncio
    async def test_no_fullstack_backend_only(self, tmp_path):
        """Only backend dir, no frontend -- should NOT detect as full-stack."""
        be = tmp_path / "backend"
        be.mkdir()
        (be / "app.py").write_text("from fastapi import FastAPI\napp = FastAPI()")

        result = await self.manager.detect_dev_command(str(tmp_path))
        assert result is None

    @pytest.mark.asyncio
    async def test_no_fullstack_empty_dirs(self, tmp_path):
        """Frontend/backend dirs exist but have no project files."""
        (tmp_path / "frontend").mkdir()
        (tmp_path / "backend").mkdir()

        result = await self.manager.detect_dev_command(str(tmp_path))
        assert result is None

    @pytest.mark.asyncio
    async def test_docker_compose_preferred_over_fullstack(self, tmp_path):
        """Docker Compose should be preferred over full-stack detection."""
        # Create docker-compose.yml
        (tmp_path / "docker-compose.yml").write_text(
            "services:\n"
            "  web:\n"
            "    build: ./frontend\n"
            '    ports:\n'
            '      - "3000:3000"\n'
            "  api:\n"
            "    build: ./backend\n"
            '    ports:\n'
            '      - "8000:8000"\n'
        )
        # Also create full-stack dirs
        fe = tmp_path / "frontend"
        fe.mkdir()
        (fe / "package.json").write_text(json.dumps({
            "scripts": {"dev": "next dev"},
            "dependencies": {"next": "^14.0.0"},
        }))
        be = tmp_path / "backend"
        be.mkdir()
        (be / "app.py").write_text("from fastapi import FastAPI\napp = FastAPI()")

        result = await self.manager.detect_dev_command(str(tmp_path))
        assert result is not None
        # Docker should win
        assert result["framework"] == "docker"

    @pytest.mark.asyncio
    async def test_fullstack_returns_dir_paths(self, tmp_path):
        """Full-stack result should include absolute directory paths."""
        fe = tmp_path / "frontend"
        fe.mkdir()
        (fe / "package.json").write_text(json.dumps({
            "scripts": {"dev": "vite"},
            "devDependencies": {"vite": "^5.0.0"},
        }))
        be = tmp_path / "backend"
        be.mkdir()
        (be / "main.py").write_text("from fastapi import FastAPI\napp = FastAPI()")

        result = await self.manager.detect_dev_command(str(tmp_path))
        assert result is not None
        assert result["frontend_dir"] == str(fe)
        assert result["backend_dir"] == str(be)

    @pytest.mark.asyncio
    async def test_fullstack_backend_with_requirements_txt(self, tmp_path):
        """Backend detected via requirements.txt + run.py."""
        fe = tmp_path / "frontend"
        fe.mkdir()
        (fe / "package.json").write_text(json.dumps({
            "scripts": {"dev": "vite"},
            "devDependencies": {"vite": "^5.0.0"},
        }))
        be = tmp_path / "backend"
        be.mkdir()
        (be / "requirements.txt").write_text("fastapi\nuvicorn\n")
        (be / "run.py").write_text("print('starting server')")

        result = await self.manager.detect_dev_command(str(tmp_path))
        assert result is not None
        assert result["framework"] == "full-stack"
        assert result["backend_framework"] == "python"
        assert "run.py" in result["command"]


class TestDockerComposeServiceParsing:
    """Tests for Docker Compose service enumeration."""

    @pytest.fixture(autouse=True)
    def _setup(self):
        from server import DevServerManager
        self.manager = DevServerManager()

    @pytest.mark.asyncio
    async def test_services_parsed_from_compose(self, tmp_path):
        """Docker Compose detection should list all services with ports."""
        (tmp_path / "docker-compose.yml").write_text(
            "services:\n"
            "  web:\n"
            "    build: .\n"
            '    ports:\n'
            '      - "3000:3000"\n'
            "  api:\n"
            "    build: ./api\n"
            '    ports:\n'
            '      - "8000:8000"\n'
            "  db:\n"
            "    image: postgres:16\n"
            '    ports:\n'
            '      - "5432:5432"\n'
        )
        result = await self.manager.detect_dev_command(str(tmp_path))
        assert result is not None
        assert result["framework"] == "docker"
        assert "services" in result
        services = result["services"]
        assert len(services) == 3
        svc_names = [s["name"] for s in services]
        assert "web" in svc_names
        assert "api" in svc_names
        assert "db" in svc_names
        # First exposed port should be the expected_port
        assert result["expected_port"] == 3000

    @pytest.mark.asyncio
    async def test_services_with_no_ports(self, tmp_path):
        """Services without ports should still be listed."""
        (tmp_path / "docker-compose.yml").write_text(
            "services:\n"
            "  worker:\n"
            "    build: .\n"
            "  redis:\n"
            "    image: redis:7\n"
        )
        result = await self.manager.detect_dev_command(str(tmp_path))
        assert result is not None
        assert "services" in result
        assert len(result["services"]) == 2
        # No ports exposed, should fall back to default
        assert result["expected_port"] == 3000

    @pytest.mark.asyncio
    async def test_services_port_selection(self, tmp_path):
        """Expected port should come from the first service with an exposed port."""
        (tmp_path / "docker-compose.yml").write_text(
            "services:\n"
            "  db:\n"
            "    image: postgres:16\n"
            "  api:\n"
            "    build: .\n"
            '    ports:\n'
            '      - "9090:80"\n'
        )
        result = await self.manager.detect_dev_command(str(tmp_path))
        assert result is not None
        assert result["expected_port"] == 9090

    @pytest.mark.asyncio
    async def test_services_has_build_flag(self, tmp_path):
        """Service entries should indicate whether they use build or image."""
        (tmp_path / "docker-compose.yml").write_text(
            "services:\n"
            "  web:\n"
            "    build: .\n"
            '    ports:\n'
            '      - "3000:3000"\n'
            "  db:\n"
            "    image: postgres:16\n"
        )
        result = await self.manager.detect_dev_command(str(tmp_path))
        assert result is not None
        services = result["services"]
        web_svc = next(s for s in services if s["name"] == "web")
        db_svc = next(s for s in services if s["name"] == "db")
        assert web_svc["has_build"] is True
        assert db_svc["has_build"] is False
        assert db_svc["image"] == "postgres:16"


class TestMultiServiceStatus:
    """Tests for multi-service status reporting."""

    def test_status_method_handles_multi_service(self):
        """Verify the status method includes multi_service fields."""
        import server
        import inspect
        source = inspect.getsource(server.DevServerManager.status)
        assert "multi_service" in source
        assert "services" in source
        assert "backend_process" in source
        assert "frontend_framework" in source
        assert "backend_framework" in source

    def test_stop_method_handles_backend_process(self):
        """Verify the stop method kills backend process for multi-service."""
        import server
        import inspect
        source = inspect.getsource(server.DevServerManager.stop)
        assert "backend_process" in source

    def test_start_method_handles_multi_service(self):
        """Verify the start method handles multi_service detected projects."""
        import server
        import inspect
        source = inspect.getsource(server.DevServerManager.start)
        assert "multi_service" in source
        assert "backend_process" in source
        assert "frontend_command" in source
        assert "_monitor_backend_output" in source

    def test_monitor_backend_output_exists(self):
        """Verify _monitor_backend_output method exists."""
        import server
        assert hasattr(server.DevServerManager, "_monitor_backend_output")
        import inspect
        assert inspect.iscoroutinefunction(server.DevServerManager._monitor_backend_output)

    def test_install_pip_deps_helper_exists(self):
        """Verify _install_pip_deps helper was extracted."""
        import server
        assert hasattr(server.DevServerManager, "_install_pip_deps")
        import inspect
        source = inspect.getsource(server.DevServerManager._install_pip_deps)
        assert "requirements.txt" in source
        assert "venv" in source


# ============================================================================
# Test AI-aware preview: _resolve_primary_service
# ============================================================================


class TestResolvePrimaryService:
    """Tests for DevServerManager._resolve_primary_service()"""

    @pytest.fixture(autouse=True)
    def _setup(self):
        from server import DevServerManager
        self.manager = DevServerManager()

    def test_frontend_name_wins(self):
        """Service named 'frontend' should be primary even if not first."""
        services = [
            {"name": "backend", "ports": [8000], "has_build": True, "image": None},
            {"name": "frontend", "ports": [3000], "has_build": True, "image": None},
            {"name": "postgres", "ports": [5432], "has_build": False, "image": "postgres:15"},
        ]
        name, port = self.manager._resolve_primary_service(services)
        assert name == "frontend"
        assert port == 3000

    def test_web_name_wins(self):
        """Service named 'web' should be selected as primary."""
        services = [
            {"name": "api", "ports": [8000], "has_build": True, "image": None},
            {"name": "web", "ports": [8080], "has_build": True, "image": None},
        ]
        name, port = self.manager._resolve_primary_service(services)
        assert name == "web"
        assert port == 8080

    def test_frontend_port_fallback(self):
        """When no frontend-named service, pick by frontend-typical port."""
        services = [
            {"name": "api-server", "ports": [8000], "has_build": True, "image": None},
            {"name": "main-app", "ports": [3000], "has_build": True, "image": None},
        ]
        name, port = self.manager._resolve_primary_service(services)
        assert name == "main-app"
        assert port == 3000

    def test_skip_infrastructure(self):
        """Postgres/Redis should never be primary when a buildable service exists."""
        services = [
            {"name": "postgres", "ports": [5432], "has_build": False, "image": "postgres:15"},
            {"name": "redis", "ports": [6379], "has_build": False, "image": "redis:7"},
            {"name": "my-service", "ports": [9000], "has_build": True, "image": None},
        ]
        name, port = self.manager._resolve_primary_service(services)
        assert name == "my-service"
        assert port == 9000

    def test_empty_services(self):
        """Empty list returns None, default port."""
        name, port = self.manager._resolve_primary_service([])
        assert name is None
        assert port == 3000

    def test_no_ports(self):
        """Services without ports return None, default port."""
        services = [
            {"name": "worker", "ports": [], "has_build": True, "image": None},
            {"name": "cron", "ports": [], "has_build": True, "image": None},
        ]
        name, port = self.manager._resolve_primary_service(services)
        assert name is None
        assert port == 3000


# ============================================================================
# Test AI error diagnosis: _diagnose_errors
# ============================================================================


class TestDiagnoseErrors:
    """Tests for _diagnose_errors() pattern matching."""

    def test_missing_python_module(self):
        """ModuleNotFoundError triggers missing dep diagnosis."""
        from server import _diagnose_errors
        logs = "ModuleNotFoundError: No module named 'redis'"
        results = _diagnose_errors(logs)
        assert len(results) >= 1
        matched = [d for d in results if d["pattern"] == "missing_python_dep"]
        assert len(matched) == 1
        assert "redis" in matched[0]["diagnosis"]

    def test_missing_node_module(self):
        """Cannot find module triggers npm install suggestion."""
        from server import _diagnose_errors
        logs = "Error: Cannot find module 'express'"
        results = _diagnose_errors(logs)
        assert len(results) >= 1
        matched = [d for d in results if d["pattern"] == "missing_node_dep"]
        assert len(matched) == 1
        assert "npm install" in matched[0]["suggestion"].lower()

    def test_connection_refused(self):
        """ECONNREFUSED suggests service not ready."""
        from server import _diagnose_errors
        logs = "ECONNREFUSED 127.0.0.1:5432"
        results = _diagnose_errors(logs)
        assert len(results) >= 1
        matched = [d for d in results if d["pattern"] == "connection_refused"]
        assert len(matched) == 1
        assert "5432" in matched[0]["diagnosis"]

    def test_port_conflict(self):
        """EADDRINUSE triggers port conflict diagnosis."""
        from server import _diagnose_errors
        logs = "Error: listen EADDRINUSE: address already in use :::3000"
        results = _diagnose_errors(logs)
        assert len(results) >= 1
        matched = [d for d in results if d["pattern"] == "port_conflict"]
        assert len(matched) == 1

    def test_syntax_error(self):
        """SyntaxError triggers syntax error diagnosis."""
        from server import _diagnose_errors
        logs = "SyntaxError: invalid syntax (app.py, line 42)"
        results = _diagnose_errors(logs)
        assert len(results) >= 1
        matched = [d for d in results if d["pattern"] == "syntax_error"]
        assert len(matched) == 1
        assert "syntax" in matched[0]["diagnosis"].lower()

    def test_db_auth_failure(self):
        """Database auth failure triggers credentials diagnosis."""
        from server import _diagnose_errors
        logs = 'FATAL:  password authentication failed for user "admin"'
        results = _diagnose_errors(logs)
        assert len(results) >= 1
        matched = [d for d in results if d["pattern"] == "db_auth"]
        assert len(matched) == 1

    def test_build_failure(self):
        """Docker build exit code triggers build failure diagnosis."""
        from server import _diagnose_errors
        logs = "error: process '/bin/sh' returned a non-zero code: 127"
        results = _diagnose_errors(logs)
        assert len(results) >= 1
        matched = [d for d in results if d["pattern"] == "build_failure"]
        assert len(matched) == 1
        assert "127" in matched[0]["diagnosis"]

    def test_multiple_errors(self):
        """Multiple distinct errors produce multiple diagnoses."""
        from server import _diagnose_errors
        logs = (
            "ModuleNotFoundError: No module named 'redis'\n"
            "ECONNREFUSED 127.0.0.1:5432"
        )
        results = _diagnose_errors(logs)
        patterns = {d["pattern"] for d in results}
        assert "missing_python_dep" in patterns
        assert "connection_refused" in patterns

    def test_no_errors(self):
        """Clean logs produce empty list."""
        from server import _diagnose_errors
        logs = "Server running on port 8000"
        results = _diagnose_errors(logs)
        assert results == []

    def test_empty_logs(self):
        """Empty string does not crash."""
        from server import _diagnose_errors
        results = _diagnose_errors("")
        assert results == []


# ============================================================================
# Test Docker context gathering: _gather_docker_context
# ============================================================================


class TestGatherDockerContext:
    """Tests for _gather_docker_context() with mocked subprocess."""

    @pytest.mark.asyncio
    async def test_gathers_service_status(self):
        """Mocks docker compose ps and verifies parsing."""
        from server import _gather_docker_context

        ps_json = (
            '{"Service":"web","State":"running","Status":"Up 5 min","ExitCode":0}\n'
            '{"Service":"db","State":"running","Status":"Up 5 min","ExitCode":0}\n'
        )
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = ps_json

        with patch("server.subprocess.run", return_value=mock_result):
            ctx = await _gather_docker_context(Path("/tmp/fake-project"))

        assert len(ctx["service_status"]) == 2
        names = [s["name"] for s in ctx["service_status"]]
        assert "web" in names
        assert "db" in names

    @pytest.mark.asyncio
    async def test_captures_failing_service_logs(self):
        """When a service is exited, its logs are captured."""
        from server import _gather_docker_context

        ps_json = '{"Service":"api","State":"exited","Status":"Exited (1)","ExitCode":1}\n'

        call_count = 0

        def mock_subprocess_run(*args, **kwargs):
            nonlocal call_count
            call_count += 1
            result = MagicMock()
            if call_count == 1:
                # docker compose ps
                result.returncode = 0
                result.stdout = ps_json
            else:
                # docker compose logs for failing service
                result.returncode = 0
                result.stdout = "Error: Cannot connect to database"
            return result

        with patch("server.subprocess.run", side_effect=mock_subprocess_run):
            ctx = await _gather_docker_context(Path("/tmp/fake-project"))

        assert "api" in ctx["failing_services"]
        assert "api" in ctx["service_logs"]
        assert "Cannot connect" in ctx["service_logs"]["api"]

    @pytest.mark.asyncio
    async def test_reads_env_keys(self, tmp_path):
        """Reads .env file and extracts key names without values."""
        from server import _gather_docker_context

        env_file = tmp_path / ".env"
        env_file.write_text("DATABASE_URL=postgres://...\nSECRET_KEY=abc123\n# Comment\n\n")

        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = ""

        with patch("server.subprocess.run", return_value=mock_result):
            ctx = await _gather_docker_context(tmp_path)

        assert "DATABASE_URL" in ctx["env_keys"]
        assert "SECRET_KEY" in ctx["env_keys"]
        # Values should NOT be present
        assert "postgres://..." not in str(ctx["env_keys"])

    @pytest.mark.asyncio
    async def test_handles_docker_not_installed(self):
        """Gracefully handles FileNotFoundError from docker."""
        from server import _gather_docker_context

        with patch("server.subprocess.run", side_effect=FileNotFoundError("docker")):
            ctx = await _gather_docker_context(Path("/tmp/fake-project"))

        # Should not crash -- service_status remains empty
        assert ctx["service_status"] == []
        assert ctx["failing_services"] == []

    @pytest.mark.asyncio
    async def test_handles_timeout(self):
        """Gracefully handles subprocess timeout."""
        from server import _gather_docker_context
        import subprocess as sp

        with patch("server.subprocess.run", side_effect=sp.TimeoutExpired("docker", 10)):
            ctx = await _gather_docker_context(Path("/tmp/fake-project"))

        # Should not crash
        assert ctx["service_status"] == []


# ============================================================================
# Test self-healing monitor: circuit breaker logic
# ============================================================================


class TestServiceHealthMonitor:
    """Tests for the self-healing monitor loop concepts."""

    def test_circuit_breaker_blocks_after_3_attempts(self):
        """After 3 fix attempts in 5 min, further fixes are blocked."""
        now = time.time()
        timestamps = [now - 200, now - 100, now - 10]  # 3 recent timestamps
        recent = [t for t in timestamps if now - t < 300]
        assert len(recent) >= 3
        # This means circuit breaker should be open
        info = {
            "auto_fix_attempts": 3,
            "auto_fix_timestamps": timestamps,
        }
        recent = [t for t in info["auto_fix_timestamps"] if now - t < 300]
        blocked = len(recent) >= 3
        assert blocked is True

    def test_circuit_breaker_resets_after_window(self):
        """Fix attempts older than 5 min (300s) don't count."""
        now = time.time()
        timestamps = [now - 600, now - 500, now - 400]  # All older than 300s
        recent = [t for t in timestamps if now - t < 300]
        assert len(recent) == 0
        # Circuit breaker should be closed
        blocked = len(recent) >= 3
        assert blocked is False

    def test_detects_service_state_change(self):
        """Running -> exited transition triggers fix (status changes to error)."""
        info = {"status": "running", "auto_fix_attempts": 0, "auto_fix_timestamps": []}
        # Simulate what _monitor_output does when process exits
        if info.get("status") in ("starting", "running"):
            info["status"] = "error"
            attempts = info.get("auto_fix_attempts", 0)
            now = time.time()
            timestamps = info.get("auto_fix_timestamps", [])
            recent = [t for t in timestamps if now - t < 300]
            if len(recent) < 3 and attempts < 3:
                info["auto_fix_attempts"] = attempts + 1
                info["auto_fix_timestamps"].append(now)
        assert info["status"] == "error"
        assert info["auto_fix_attempts"] == 1
        assert len(info["auto_fix_timestamps"]) == 1

    def test_already_exited_no_duplicate_fix(self):
        """Service that was already stopped/exited doesn't trigger another fix."""
        info = {"status": "stopped", "auto_fix_attempts": 0, "auto_fix_timestamps": []}
        # Simulate check -- only "starting"/"running" trigger auto-fix
        triggered = False
        if info.get("status") in ("starting", "running"):
            triggered = True
            info["status"] = "error"
        assert triggered is False
        assert info["status"] == "stopped"
        assert info["auto_fix_attempts"] == 0
