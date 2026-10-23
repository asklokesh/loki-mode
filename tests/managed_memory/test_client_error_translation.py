"""
tests/managed_memory/test_client_error_translation.py
v7.1.0 T3: SDK error translation in ManagedClient.

The ManagedClient is the only file that imports the anthropic SDK. When the
SDK raises any Exception during a network call, the client wrapper MUST
translate it to ManagedDisabled with chained context (`raise ... from e`)
so that:
    - callers have a single exception type to handle (no anthropic.* leakage)
    - the original exception is preserved on `__cause__` for debuggability
    - the original message is included in the new message

This file injects a fake SDK that raises on every wrapped method
(`stores.list`, `stores.create`, `memories.create`, `memories.retrieve`,
`memories.list`) and asserts ManagedDisabled is raised with a chained cause
in each case.

Sibling concerns covered:
    - The wrapper does NOT swallow ManagedDisabled raised internally
      (e.g. from the SDK-availability checks earlier in the method).
"""

from __future__ import annotations

import unittest

from memory.managed_memory import ManagedDisabled
from memory.managed_memory.client import ManagedClient


class _BoomMemories:
    """Fake `client.beta.memories` namespace whose methods all raise."""

    def __init__(self, exc: Exception) -> None:
        self._exc = exc

    def create(self, **kwargs):  # noqa: ARG002
        raise self._exc

    def retrieve(self, **kwargs):  # noqa: ARG002
        raise self._exc

    def list(self, **kwargs):  # noqa: ARG002
        raise self._exc


class _BoomStores:
    """Fake `client.beta.memory_stores` namespace whose methods all raise."""

    def __init__(self, exc: Exception) -> None:
        self._exc = exc

    def list(self, *args, **kwargs):  # noqa: ARG002
        raise self._exc

    def create(self, *args, **kwargs):  # noqa: ARG002
        raise self._exc


class _BoomBeta:
    def __init__(self, exc: Exception) -> None:
        self.memory_stores = _BoomStores(exc)
        self.memories = _BoomMemories(exc)


class _BoomSDKClient:
    def __init__(self, exc: Exception) -> None:
        self.beta = _BoomBeta(exc)


def _build_client(exc: Exception) -> ManagedClient:
    """
    Construct a ManagedClient bypassing __init__ so we never touch anthropic
    or env vars. We populate just the attributes the wrapped methods read.
    """
    mc = ManagedClient.__new__(ManagedClient)
    mc._client = _BoomSDKClient(exc)  # type: ignore[attr-defined]
    mc._anthropic = None  # type: ignore[attr-defined]
    mc._timeout = 10.0  # type: ignore[attr-defined]
    return mc


class ClientErrorTranslationTests(unittest.TestCase):
    """Every SDK-call wrapper must re-raise as ManagedDisabled with chain."""

    def _assert_translates(self, callable_, *, original: Exception, label: str):
        with self.assertRaises(ManagedDisabled) as ctx:
            callable_()
        # Original chained on __cause__ (the `from e` clause).
        self.assertIs(
            ctx.exception.__cause__,
            original,
            f"{label}: original exception not chained via `from e`",
        )
        # Original message preserved in the new message.
        msg = str(ctx.exception)
        self.assertIn(
            str(original),
            msg,
            f"{label}: original message {original!s} missing from {msg!r}",
        )

    # ---- one test per wrapped SDK method ---------------------------------

    def test_stores_list_translates_runtime_error(self):
        original = RuntimeError("network down on stores.list")
        client = _build_client(original)
        self._assert_translates(
            client.stores_list,
            original=original,
            label="stores_list",
        )

    def test_stores_get_or_create_translates_runtime_error(self):
        # stores_get_or_create() first calls stores_list() internally, which
        # itself wraps stores.list. We assert the same translation invariant
        # holds for whichever call surfaces first.
        original = RuntimeError("network down on stores.create")
        client = _build_client(original)
        self._assert_translates(
            lambda: client.stores_get_or_create(name="loki-test"),
            original=original,
            label="stores_get_or_create",
        )

    def test_memory_create_translates_runtime_error(self):
        original = RuntimeError("server 500 on memories.create")
        client = _build_client(original)
        self._assert_translates(
            lambda: client.memory_create(
                store_id="store_1", path="/x", content="hello"
            ),
            original=original,
            label="memory_create",
        )

    def test_memory_read_translates_runtime_error(self):
        original = RuntimeError("404 on memories.retrieve")
        client = _build_client(original)
        self._assert_translates(
            lambda: client.memory_read(store_id="store_1", memory_id="mem_1"),
            original=original,
            label="memory_read",
        )

    def test_memories_list_translates_runtime_error(self):
        original = RuntimeError("auth failed on memories.list")
        client = _build_client(original)
        self._assert_translates(
            lambda: client.memories_list(store_id="store_1"),
            original=original,
            label="memories_list",
        )

    # ---- invariant: do NOT swallow ManagedDisabled -----------------------

    def test_managed_disabled_passes_through_unchanged(self):
        """If the SDK raises ManagedDisabled itself, do not re-wrap it."""
        original = ManagedDisabled("explicit disabled inside SDK call")
        client = _build_client(original)
        with self.assertRaises(ManagedDisabled) as ctx:
            client.stores_list()
        # Same object -- not re-wrapped.
        self.assertIs(ctx.exception, original)
        # And no chained cause was added.
        self.assertIsNone(ctx.exception.__cause__)

    # ---- exotic exception types still translate --------------------------

    def test_keyerror_also_translates(self):
        original = KeyError("missing-field")
        client = _build_client(original)
        self._assert_translates(
            lambda: client.memory_read(store_id="s", memory_id="m"),
            original=original,
            label="memory_read(KeyError)",
        )

    def test_value_error_also_translates(self):
        original = ValueError("bad payload")
        client = _build_client(original)
        self._assert_translates(
            client.stores_list,
            original=original,
            label="stores_list(ValueError)",
        )


class RealSdkWireTests(unittest.TestCase):
    """
    Drive the real anthropic 2.x client through httpx2.MockTransport and assert
    what goes on the wire (no network, no key). A kwarg-name check cannot see
    the path shape, the list view, paging or the update precondition.
    """

    PAGE = 20

    def setUp(self):
        try:
            import anthropic
            import httpx2
        except ImportError:
            self.skipTest("anthropic SDK not installed")
        self.sent = []
        self.rows = {}  # path -> memory dict
        self.seq = 0

        def sha(text):
            import hashlib

            return hashlib.sha256(text.encode("utf-8")).hexdigest()

        def mem(path, content, mid):
            return {
                "type": "memory",
                "id": mid,
                "path": path,
                "content": content,
                "content_sha256": sha(content),
                "content_size_bytes": len(content),
                "created_at": "2026-10-23T00:00:00Z",
                "updated_at": "2026-10-23T00:00:00Z",
                "memory_store_id": "memstore_1",
                "memory_version_id": "memver_1",
            }

        def err(code):
            return httpx2.Response(
                code,
                json={
                    "type": "error",
                    "error": {"type": "invalid_request_error", "message": "x"},
                },
            )

        def handler(req):
            import json

            body = json.loads(req.content) if req.content else {}
            params = dict(req.url.params)
            self.sent.append((req.method, req.url.path, params, body))
            p = req.url.path
            if p.endswith("/memory_stores") and req.method == "GET":
                return httpx2.Response(200, json={"data": [], "next_page": None})
            if p.endswith("/memory_stores") and req.method == "POST":
                return httpx2.Response(
                    200,
                    json={
                        "type": "memory_store",
                        "id": "memstore_1",
                        "name": body.get("name"),
                        "created_at": "2026-10-23T00:00:00Z",
                        "updated_at": "2026-10-23T00:00:00Z",
                    },
                )
            if p.endswith("/memories") and req.method == "POST":
                path = body.get("path", "")
                if not path.startswith("/"):
                    return err(400)
                if path in self.rows:
                    return err(409)
                self.seq += 1
                self.rows[path] = mem(path, body["content"], f"mem_{self.seq}")
                return httpx2.Response(200, json=self.rows[path])
            if p.endswith("/memories") and req.method == "GET":
                prefix = params.get("path_prefix", "")
                full = params.get("view") == "full"
                items = [
                    dict(m, content=m["content"] if full else None)
                    for k, m in sorted(self.rows.items())
                    if k.startswith(prefix)
                ]
                start = int(params.get("page", "0"))
                chunk = items[start : start + self.PAGE]
                nxt = str(start + self.PAGE) if start + self.PAGE < len(items) else None
                return httpx2.Response(200, json={"data": chunk, "next_page": nxt})
            if req.method == "POST" and "/memories/" in p:
                mid = p.rsplit("/", 1)[1]
                cur = next((m for m in self.rows.values() if m["id"] == mid), None)
                pre = body.get("precondition") or {}
                if cur is None or pre.get("content_sha256") != cur["content_sha256"]:
                    return err(409)
                self.rows[cur["path"]] = mem(cur["path"], body["content"], mid)
                return httpx2.Response(200, json=self.rows[cur["path"]])
            return err(404)

        mc = ManagedClient.__new__(ManagedClient)
        mc._client = anthropic.Anthropic(
            api_key="test-key",
            http_client=httpx2.Client(transport=httpx2.MockTransport(handler)),
            max_retries=0,
        )
        mc._anthropic = anthropic
        mc._timeout = 10.0
        self.mc = mc
        self.sha = sha

    def _memory_requests(self, method):
        return [
            s for s in self.sent if s[0] == method and s[1].endswith("/memories")
        ]

    def test_memories_resolve_to_nested_namespace(self):
        ns, id_kw = self.mc._memories()
        self.assertIs(ns, self.mc._client.beta.memory_stores.memories)
        self.assertEqual(id_kw, "memory_store_id")

    def test_store_metadata_carries_scope(self):
        self.mc.stores_get_or_create("n", scope="user")
        (create,) = [s for s in self.sent if s[0] == "POST"]
        self.assertEqual(create[3]["metadata"], {"scope": "user"})
        self.assertNotIn("scope", create[3])

    def test_create_sends_absolute_path_and_no_precondition(self):
        self.mc.memory_create(
            "memstore_1", "verdicts/iteration-1.json", "{}", sha256_precondition="ab"
        )
        (req,) = self._memory_requests("POST")
        self.assertEqual(req[3]["path"], "/verdicts/iteration-1.json")
        self.assertNotIn("precondition", req[3])
        self.assertNotIn("if_match_sha256", req[3])

    def test_list_requests_full_view_and_follows_cursor(self):
        for i in range(45):
            self.mc.memory_create("memstore_1", f"/verdicts/i-{i:02d}.json", f"c{i}")
        self.sent.clear()
        rows = self.mc.memories_list("memstore_1", path_prefix="verdicts/")
        lists = self._memory_requests("GET")
        self.assertEqual(len(lists), 3)
        for _, _, params, _ in lists:
            self.assertEqual(params["view"], "full")
            self.assertEqual(params["path_prefix"], "/verdicts/")
        self.assertEqual(len(rows), 45)
        self.assertTrue(all(r["content"] for r in rows))

    def test_create_on_existing_path_is_409_and_update_uses_stored_sha(self):
        self.mc.memory_create("memstore_1", "/p/a.json", "old")
        with self.assertRaises(Exception) as cm:
            self.mc.memory_create("memstore_1", "/p/a.json", "new")
        self.assertEqual(getattr(cm.exception, "status_code", None), 409)

        (stored,) = self.mc.memories_list("memstore_1", path_prefix="/p/")
        self.sent.clear()
        self.mc.memory_update(
            "memstore_1", stored["id"], "merged", stored["content_sha256"]
        )
        (req,) = [s for s in self.sent if s[0] == "POST"]
        self.assertEqual(
            req[3]["precondition"],
            {"type": "content_sha256", "content_sha256": self.sha("old")},
        )
        self.assertEqual(self.rows["/p/a.json"]["content"], "merged")

        # The hash of the NEW content is the wrong precondition.
        with self.assertRaises(ManagedDisabled):
            self.mc.memory_update(
                "memstore_1", stored["id"], "again", self.sha("again")
            )

    def test_shadow_write_conflict_merges_via_update_on_the_wire(self):
        import json
        import os
        import tempfile

        from memory.managed_memory import client as client_mod
        from memory.managed_memory import shadow_write

        self.mc.memory_create(
            "memstore_1", "/verdicts/iteration-9.json", json.dumps({"verdict": "A"})
        )
        old_sha = self.rows["/verdicts/iteration-9.json"]["content_sha256"]
        prev = {k: os.environ.get(k) for k in ("LOKI_MANAGED_AGENTS", "LOKI_MANAGED_MEMORY", "LOKI_TARGET_DIR")}
        os.environ["LOKI_MANAGED_AGENTS"] = "true"
        os.environ["LOKI_MANAGED_MEMORY"] = "true"
        os.environ["LOKI_TARGET_DIR"] = tempfile.mkdtemp(prefix="loki-managed-")
        client_mod._singleton = self.mc
        try:
            self.sent.clear()
            ok = shadow_write._shadow_write_blob(
                "/verdicts/iteration-9.json", {"verdict": "B"}, kind="verdict"
            )
        finally:
            client_mod.reset_client()
            for k, v in prev.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v
        self.assertTrue(ok)
        updates = [s for s in self.sent if s[0] == "POST" and "/memories/" in s[1]]
        self.assertEqual(len(updates), 1)
        self.assertEqual(updates[0][3]["precondition"]["content_sha256"], old_sha)
        merged = json.loads(self.rows["/verdicts/iteration-9.json"]["content"])
        self.assertEqual(merged["verdict"], "B")


if __name__ == "__main__":
    unittest.main()
