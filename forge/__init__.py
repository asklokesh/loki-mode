"""Loki Forge - integrated backend-as-a-service for the autonomous loop.

Loki Forge is the BaaS subsystem the agent uses *during* a RARV iteration to
materialize backend primitives the spec requires. The user does not invoke
Forge directly - the agent calls forge MCP tools as part of building the
app described in the PRD.

Phase F-1 (this commit) ships:
- Spec detector that reads the PRD/issue/checklist and produces a structured
  ForgeRequirements record at .loki/forge/required.json.
- SQLite-backed database service with introspection, migration spec parsing,
  and apply/rollback support.
- Semantic-layer renderer that emits a prompt-injection block with the live
  state of the forge resources, capped at ~2KB.
- A provisioner facade that wires the pieces together.

Phases F-2 through F-5 add auth, storage, functions, gateway, realtime,
schedules, secrets, payments, deploy, and SDK generation. See
docs/plans/ULTRAPLAN-FORGE-BAAS.md for the full plan.
"""

from __future__ import annotations

__version__ = "0.1.0"

# Surface the canonical entry points so callers (mcp/forge_tools.py, the
# autonomy/forge_detector.sh hook, the dashboard router) do not have to
# know the internal package layout.
from .spec_detector import (  # noqa: F401
    ForgeRequirements,
    detect_from_path,
    detect_from_bmad_workspace,
)
from .semantic_layer import render_prompt_block  # noqa: F401
from .provisioner import provision  # noqa: F401
