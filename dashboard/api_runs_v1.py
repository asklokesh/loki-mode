"""REST API for runs: /api/v1/runs.

A thin, stable surface over code that already exists:
  GET  /api/v1/runs            -> api_runs.list_runs (envelope kept intact)
  GET  /api/v1/runs/{id}       -> api_runs.get_run (404 when the run is unknown)
  POST /api/v1/runs            -> the existing /api/control/start handler
  POST /api/v1/runs/{id}/stop  -> the existing /api/control/stop handler,
                                  only when {id} is the current run

Auth is the dashboard's own scope check: "read" for GETs, "control" for POSTs.
The dashboard binds loopback by default; nothing here opens a listener.
"""
import os
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from . import auth

router = APIRouter(prefix="/api/v1/runs", tags=["runs-v1"])
_READ = [Depends(auth.require_scope("read"))]
_CONTROL = [Depends(auth.require_scope("control"))]


def _loki_dir() -> str:
    try:
        from . import server
        return str(server._get_loki_dir())
    except Exception:
        return os.environ.get("LOKI_DIR") or os.path.join(os.getcwd(), ".loki")


class RunStartIn(BaseModel):
    prd_text: Optional[str] = Field(default=None, max_length=1_048_576)
    prd_path: Optional[str] = None
    provider: str = "claude"
    parallel: bool = False


async def _start_impl(request: Request, body: RunStartIn):
    from . import server
    return await server.start_build(request, server.StartBuildRequest(**body.model_dump()))


async def _stop_impl(request: Request):
    from . import server
    return await server.stop_session(request)


@router.get("", dependencies=_READ)
def list_runs_v1():
    from . import api_runs
    return api_runs.list_runs(_loki_dir())


@router.get("/{run_id}", dependencies=_READ)
def get_run_v1(run_id: str):
    from . import api_runs
    env = api_runs.get_run(_loki_dir(), run_id)
    if env.get("run") is None:
        raise HTTPException(status_code=404, detail=env.get("reason") or "run not found")
    return env


@router.post("", dependencies=_CONTROL)
async def start_run_v1(request: Request, body: RunStartIn):
    return await _start_impl(request, body)


@router.post("/{run_id}/stop", dependencies=_CONTROL)
async def stop_run_v1(run_id: str, request: Request):
    from . import api_runs
    env = api_runs.get_run(_loki_dir(), run_id)
    row = env.get("run")
    if row is None:
        raise HTTPException(status_code=404, detail=env.get("reason") or "run not found")
    if not row.get("current"):
        raise HTTPException(status_code=409, detail="only the current run can be stopped")
    return await _stop_impl(request)
