"""Real-local transport coverage for bounded chat image uploads."""

from __future__ import annotations

import socket
import tempfile
import threading
import time
from pathlib import Path

import httpx
import pytest
import uvicorn


PNG = (
    b"\x89PNG\r\n\x1a\n"
    b"\x00\x00\x00\x0dIHDR" + b"\x00" * 13 + b"\x00" * 4
    + b"\x00\x00\x00\x00IEND" + b"\x00" * 4
)


class _TrackedSpool(tempfile.SpooledTemporaryFile):
    instances: list["_TrackedSpool"] = []

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.explicitly_closed = False
        self.instances.append(self)

    def close(self):
        self.explicitly_closed = True
        return super().close()

    def __del__(self):
        # Deliberately suppress implementation-dependent destructor cleanup so
        # the test can distinguish request-owned closure from eventual GC.
        pass


def _free_port() -> int:
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


@pytest.fixture
def local_image_server(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    import server
    import starlette.formparsers

    _TrackedSpool.instances = []
    monkeypatch.setattr(starlette.formparsers, "SpooledTemporaryFile", _TrackedSpool)
    monkeypatch.setattr(server, "_find_session_dir", lambda _session_id: tmp_path)

    port = _free_port()
    config = uvicorn.Config(server.app, host="127.0.0.1", port=port, log_level="error")
    instance = uvicorn.Server(config)
    thread = threading.Thread(target=instance.run, name=f"p547-uvicorn-{port}")
    thread.start()
    deadline = time.monotonic() + 5
    while not instance.started and thread.is_alive() and time.monotonic() < deadline:
        time.sleep(0.01)
    assert instance.started and thread.is_alive()

    yield f"http://127.0.0.1:{port}", port, tmp_path

    for spool in _TrackedSpool.instances:
        if not spool.closed:
            spool.close()
    instance.should_exit = True
    thread.join(timeout=5)
    assert not thread.is_alive()
    with socket.socket() as probe:
        probe.settimeout(0.2)
        assert probe.connect_ex(("127.0.0.1", port)) != 0


def _multipart_body(content: bytes, *, include_close: bool = True) -> tuple[str, bytes]:
    boundary = "p547-boundary"
    body = (
        f"--{boundary}\r\n"
        'Content-Disposition: form-data; name="note"\r\n\r\n'
        "small text control\r\n"
        f"--{boundary}\r\n"
        'Content-Disposition: form-data; name="image"; filename="shot.png"\r\n'
        "Content-Type: image/png\r\n\r\n"
    ).encode() + content
    if include_close:
        body += f"\r\n--{boundary}--\r\n".encode()
    return boundary, body


def test_oversized_content_length_is_refused_before_body(local_image_server):
    _base_url, port, session_dir = local_image_server
    declared = 11 * 1024 * 1024
    with socket.create_connection(("127.0.0.1", port), timeout=2) as client:
        client.settimeout(1)
        client.sendall(
            (
                "POST /api/sessions/session-1/chat/image HTTP/1.1\r\n"
                f"Host: 127.0.0.1:{port}\r\n"
                "Content-Type: multipart/form-data; boundary=p547\r\n"
                f"Content-Length: {declared}\r\n"
                "Connection: close\r\n\r\n"
            ).encode()
        )
        response = client.recv(4096)

    assert b" 413 " in response
    assert _TrackedSpool.instances == []
    assert not (session_dir / ".loki" / "images").exists()


def test_overdeclared_disconnected_body_closes_parser_artifact(local_image_server):
    _base_url, port, session_dir = local_image_server
    boundary, body = _multipart_body(b"x" * (2 * 1024 * 1024), include_close=False)
    with socket.create_connection(("127.0.0.1", port), timeout=2) as client:
        client.sendall(
            (
                "POST /api/sessions/session-1/chat/image HTTP/1.1\r\n"
                f"Host: 127.0.0.1:{port}\r\n"
                f"Content-Type: multipart/form-data; boundary={boundary}\r\n"
                f"Content-Length: {len(body) + 4096}\r\n"
                "Connection: close\r\n\r\n"
            ).encode()
            + body
        )
        client.shutdown(socket.SHUT_WR)

    deadline = time.monotonic() + 2
    while (not _TrackedSpool.instances or not all(s.explicitly_closed for s in _TrackedSpool.instances)) and time.monotonic() < deadline:
        time.sleep(0.01)
    assert _TrackedSpool.instances
    assert all(s.explicitly_closed for s in _TrackedSpool.instances)
    assert not (session_dir / ".loki" / "images").exists()


def test_missing_content_length_is_bounded_and_closes_temp(local_image_server):
    base_url, _port, session_dir = local_image_server
    boundary, body = _multipart_body(b"x" * (11 * 1024 * 1024))

    def chunks():
        for offset in range(0, len(body), 64 * 1024):
            yield body[offset:offset + 64 * 1024]

    with httpx.Client(base_url=base_url, timeout=5) as client:
        response = client.post(
            "/api/sessions/session-1/chat/image",
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
            content=chunks(),
        )

    assert response.status_code == 413
    assert all(s.explicitly_closed for s in _TrackedSpool.instances)
    assert not (session_dir / ".loki" / "images").exists()


def test_upload_read_exception_refuses_without_leaking(local_image_server, monkeypatch):
    import starlette.datastructures

    async def fail_read(_upload, _size=-1):
        raise OSError("injected upload read failure")

    monkeypatch.setattr(starlette.datastructures.UploadFile, "read", fail_read)
    base_url, _port, session_dir = local_image_server
    with httpx.Client(base_url=base_url, timeout=5) as client:
        response = client.post(
            "/api/sessions/session-1/chat/image",
            files={"image": ("shot.png", PNG, "image/png")},
        )

    assert response.status_code == 400
    assert response.json() == {"error": "Image upload was interrupted"}
    assert all(s.explicitly_closed for s in _TrackedSpool.instances)
    assert not (session_dir / ".loki" / "images").exists()


def test_valid_small_multipart_and_text_control_survive(local_image_server):
    base_url, _port, session_dir = local_image_server
    with httpx.Client(base_url=base_url, timeout=5) as client:
        response = client.post(
            "/api/sessions/session-1/chat/image",
            data={"note": "small text control"},
            files={"image": ("shot.png", PNG, "image/png")},
        )

    assert response.status_code == 200
    assert response.json()["size"] == len(PNG)
    assert (session_dir / response.json()["path"]).read_bytes() == PNG
    assert all(s.explicitly_closed for s in _TrackedSpool.instances)
