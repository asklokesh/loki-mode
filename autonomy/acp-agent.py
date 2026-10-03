#!/usr/bin/env python3
"""Loki Mode as an ACP (Agent Client Protocol) agent over stdio.

Newline-delimited JSON-RPC 2.0. stdout carries protocol frames only; all
diagnostics go to stderr. Each session/prompt runs `loki quick "<prompt>"` in
the session cwd and streams its output as agent_message_chunk updates. A
non-zero exit is reported in the text as NOT VERIFIED, never as success.
"""
import json
import os
import subprocess
import sys
import threading

PROTOCOL_VERSION = 1
LOKI_CMD = os.environ.get("LOKI_ACP_LOKI") or "loki"

out_lock = threading.Lock()
sessions = {}  # sessionId -> {"cwd": str, "proc": Popen|None, "cancelled": bool}


def send(obj):
    with out_lock:
        sys.stdout.write(json.dumps(obj) + "\n")
        sys.stdout.flush()


def reply(rid, result):
    send({"jsonrpc": "2.0", "id": rid, "result": result})


def error(rid, code, msg):
    send({"jsonrpc": "2.0", "id": rid, "error": {"code": code, "message": msg}})


def update(sid, text):
    send({"jsonrpc": "2.0", "method": "session/update", "params": {
        "sessionId": sid,
        "update": {"sessionUpdate": "agent_message_chunk",
                   "content": {"type": "text", "text": text}}}})


def prompt_text(blocks):
    parts = []
    for b in blocks or []:
        if b.get("type") == "text":
            parts.append(b.get("text", ""))
        elif b.get("type") == "resource_link":
            parts.append(b.get("uri", ""))
        elif b.get("type") == "resource":
            r = b.get("resource", {})
            parts.append(r.get("text") or r.get("uri", ""))
    return "\n".join(p for p in parts if p).strip()


def run_prompt(rid, sid, text):
    s = sessions[sid]
    s["cancelled"] = False
    if not text:
        reply(rid, {"stopReason": "end_turn"})
        return
    env = dict(os.environ, LOKI_NO_BROWSER="1")
    try:
        proc = subprocess.Popen([LOKI_CMD, "quick", text], cwd=s["cwd"], env=env,
                                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, text=True, bufsize=1)
    except OSError as exc:
        update(sid, "Could not start loki: %s\nNOT VERIFIED: nothing ran.\n" % exc)
        reply(rid, {"stopReason": "end_turn"})
        return
    s["proc"] = proc
    for line in proc.stdout:
        update(sid, line)
    code = proc.wait()
    s["proc"] = None
    if s["cancelled"]:
        reply(rid, {"stopReason": "cancelled"})
        return
    if code != 0:
        update(sid, "\nloki exited with code %d. This run is NOT VERIFIED.\n" % code)
    reply(rid, {"stopReason": "end_turn"})


def handle(msg):
    method, rid, params = msg.get("method"), msg.get("id"), msg.get("params") or {}
    if method == "initialize":
        reply(rid, {"protocolVersion": PROTOCOL_VERSION,
                    "agentCapabilities": {"loadSession": False,
                                          "promptCapabilities": {"embeddedContext": True}},
                    "agentInfo": {"name": "loki", "title": "Loki Mode"},
                    "authMethods": []})
    elif method == "session/new":
        sid = "loki-%d-%d" % (os.getpid(), len(sessions) + 1)
        sessions[sid] = {"cwd": params.get("cwd") or os.getcwd(), "proc": None, "cancelled": False}
        reply(rid, {"sessionId": sid})
    elif method == "session/prompt":
        sid = params.get("sessionId")
        if sid not in sessions:
            error(rid, -32602, "unknown session")
            return
        threading.Thread(target=run_prompt, daemon=True,
                         args=(rid, sid, prompt_text(params.get("prompt")))).start()
    elif method == "session/cancel":
        s = sessions.get(params.get("sessionId"))
        if s and s["proc"]:
            s["cancelled"] = True
            s["proc"].terminate()
    elif rid is not None:
        error(rid, -32601, "method not found: %s" % method)


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            handle(json.loads(line))
        except json.JSONDecodeError:
            error(None, -32700, "parse error")
    # Let in-flight prompts finish their replies before exiting.
    for t in threading.enumerate():
        if t is not threading.current_thread():
            t.join(timeout=600)


if __name__ == "__main__":
    main()
