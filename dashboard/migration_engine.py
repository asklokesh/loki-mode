"""
Migration Engine for Loki Mode.

Core backend for the `loki migrate` enterprise code transformation feature.
Implements data models, MigrationPipeline, and phase gates for safe,
incremental codebase migrations with checkpoint/rollback support.
"""

import dataclasses
import json
import logging
import os
import re
import subprocess
import tempfile
import threading
from dataclasses import asdict, dataclass, field, fields
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger("loki-migration")

LOKI_DATA_DIR = os.environ.get("LOKI_DATA_DIR", os.path.expanduser("~/.loki"))
MIGRATIONS_DIR = os.path.join(LOKI_DATA_DIR, "migrations")

# Phase ordering for gate validation
PHASE_ORDER = ["understand", "guardrail", "migrate", "verify"]


# ---------------------------------------------------------------------------
# Data Models
# ---------------------------------------------------------------------------


@dataclass
class Feature:
    """Individual feature tracked during migration."""

    id: str
    category: str = ""
    description: str = ""
    verification_steps: list[str] = field(default_factory=list)
    passes: bool = False
    characterization_test: str = ""
    risk: str = "low"
    notes: str = ""


@dataclass
class MigrationStep:
    """Single step in a migration plan."""

    id: str
    description: str = ""
    type: str = ""  # e.g. "refactor", "rewrite", "config", "test"
    files: list[str] = field(default_factory=list)
    tests_required: list[str] = field(default_factory=list)
    estimated_tokens: int = 0
    risk: str = "low"
    rollback_point: bool = False
    depends_on: list[str] = field(default_factory=list)
    assigned_agent: str = ""
    status: str = "pending"  # pending | in_progress | completed | failed


@dataclass
class MigrationPlan:
    """Full migration plan with strategy and steps."""

    version: int = 1
    strategy: str = "incremental"
    constraints: list[str] = field(default_factory=list)
    steps: list[MigrationStep] = field(default_factory=list)
    rollback_strategy: str = "checkpoint"
    exit_criteria: dict[str, Any] = field(default_factory=dict)


@dataclass
class SeamInfo:
    """Detected seam (boundary/interface) in the codebase."""

    id: str
    description: str = ""
    type: str = ""  # e.g. "api", "module", "database", "config"
    location: str = ""
    name: str = ""
    priority: str = "medium"
    files: list[str] = field(default_factory=list)
    dependencies: list[str] = field(default_factory=list)
    complexity: str = ""
    confidence: float = 0.0
    suggested_interface: str = ""


@dataclass
class PhaseResult:
    """Result of executing a migration phase."""

    phase: str
    status: str  # pending | in_progress | completed | failed
    artifacts: list[str] = field(default_factory=list)
    started_at: str = ""
    completed_at: str = ""
    error: str = ""


@dataclass
class CostEstimate:
    """Token cost estimation for migration."""

    total_tokens: int = 0
    estimated_cost_usd: float = 0.0
    by_phase: dict[str, int] = field(default_factory=dict)


@dataclass
class MigrationManifest:
    """Tracks overall migration state."""

    id: str = ""
    created_at: str = ""
    source_info: dict[str, Any] = field(default_factory=dict)
    target_info: dict[str, Any] = field(default_factory=dict)
    phases: dict[str, dict[str, Any]] = field(default_factory=dict)
    feature_list_path: str = ""
    migration_plan_path: str = ""
    checkpoints: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Atomic file write helper
# ---------------------------------------------------------------------------


def _atomic_write(path: Path, content: str) -> None:
    """Write content to file atomically using temp-file-then-rename.

    Matches the pattern in prompt_optimizer.py for POSIX safety.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = None
    try:
        fd, tmp_path = tempfile.mkstemp(
            dir=str(path.parent), suffix=".tmp"
        )
        try:
            os.write(fd, content.encode("utf-8"))
            os.fsync(fd)
        finally:
            os.close(fd)
        os.rename(tmp_path, str(path))
    except OSError as exc:
        logger.error("Failed to write %s: %s", path, exc)
        # Clean up temp file on failure
        if tmp_path is not None:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
        raise


def _timestamp_iso() -> str:
    """Return current UTC timestamp in ISO format."""
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# MigrationPipeline
# ---------------------------------------------------------------------------


class MigrationPipeline:
    """Manages the lifecycle of a codebase migration.

    All state is persisted under ~/.loki/migrations/<migration_id>/.
    Thread-safe for concurrent manifest reads and writes.
    """

    def __init__(
        self,
        codebase_path: str,
        target: str,
        options: Optional[dict[str, Any]] = None,
    ) -> None:
        self.codebase_path = os.path.abspath(codebase_path.rstrip(os.sep))
        basename = os.path.basename(self.codebase_path)
        if not basename:
            raise ValueError(f"Cannot derive project name from codebase path: {codebase_path}")
        self.target = target
        self.options = options or {}
        self.migration_id = self._generate_migration_id()
        self.migration_dir = Path(MIGRATIONS_DIR) / self.migration_id
        self._lock = threading.Lock()
        self._logger = logging.getLogger("loki-migration")

        # Ensure directory structure exists
        self.migration_dir.mkdir(parents=True, exist_ok=True)
        (self.migration_dir / "docs").mkdir(exist_ok=True)
        (self.migration_dir / "checkpoints").mkdir(exist_ok=True)

    def _generate_migration_id(self) -> str:
        """Generate a unique migration ID like mig_20260223_143052_<dirname>."""
        dirname = os.path.basename(self.codebase_path)
        # Sanitize dirname to match validation regex
        safe_dirname = re.sub(r'[^a-zA-Z0-9_-]', '_', dirname)
        if not safe_dirname:
            safe_dirname = 'unnamed'
        now = datetime.now(timezone.utc)
        date_str = now.strftime("%Y%m%d")
        time_str = now.strftime("%H%M%S")
        return f"mig_{date_str}_{time_str}_{safe_dirname}"

    @classmethod
    def load(cls, migration_id: str) -> 'MigrationPipeline':
        """Load an existing migration by ID."""
        if not re.match(r'^mig_\d{8}_\d{6}_[a-zA-Z0-9_-]+$', migration_id):
            raise ValueError(
                f"Invalid migration_id '{migration_id}': must match ^mig_YYYYMMDD_HHMMSS_<name>$"
            )
        migrations_dir = MIGRATIONS_DIR
        migration_dir = os.path.join(migrations_dir, migration_id)
        if not os.path.isdir(migration_dir):
            raise FileNotFoundError(f"Migration not found: {migration_id}")
        manifest_path = os.path.join(migration_dir, 'manifest.json')
        if not os.path.isfile(manifest_path):
            raise FileNotFoundError(f"Manifest not found for migration: {migration_id}")
        with open(manifest_path) as f:
            data = json.load(f)
        # Reconstruct pipeline without re-creating directories
        pipeline = cls.__new__(cls)
        pipeline.codebase_path = data.get('source_info', {}).get('path', '')
        pipeline.target = data.get('target_info', {}).get('target', '') or data.get('target_info', {}).get('language', '')
        pipeline.options = {}
        pipeline.migration_dir = Path(migration_dir)
        pipeline.migration_id = migration_id
        pipeline._lock = threading.Lock()
        pipeline._logger = logging.getLogger('loki-migration')
        return pipeline

    # -- Manifest operations -------------------------------------------------

    def create_manifest(self) -> MigrationManifest:
        """Create the initial manifest.json for this migration."""
        manifest = MigrationManifest(
            id=self.migration_id,
            created_at=_timestamp_iso(),
            source_info={
                "path": self.codebase_path,
                "type": self.options.get("source_type", "unknown"),
            },
            target_info={
                "target": self.target,
                "options": self.options,
            },
            phases={
                phase: {
                    "status": "in_progress" if phase == "understand" else "pending",
                    "started_at": _timestamp_iso() if phase == "understand" else "",
                    "completed_at": "",
                }
                for phase in PHASE_ORDER
            },
            feature_list_path=str(self.migration_dir / "features.json"),
            migration_plan_path=str(self.migration_dir / "migration-plan.json"),
            checkpoints=[],
        )
        self.save_manifest(manifest)
        logger.info("Created migration manifest: %s", self.migration_id)
        return manifest

    def _load_manifest_unlocked(self) -> MigrationManifest:
        """Load manifest.json from disk (caller must hold self._lock)."""
        manifest_path = self.migration_dir / "manifest.json"
        try:
            data = json.loads(manifest_path.read_text(encoding="utf-8"))
            valid_fields = {f.name for f in dataclasses.fields(MigrationManifest)}
            filtered = {k: v for k, v in data.items() if k in valid_fields}
            return MigrationManifest(**filtered)
        except FileNotFoundError:
            logger.warning("Manifest not found at %s", manifest_path)
            raise
        except (json.JSONDecodeError, TypeError) as exc:
            logger.error("Corrupt manifest at %s: %s", manifest_path, exc)
            raise

    def _save_manifest_unlocked(self, manifest: MigrationManifest) -> None:
        """Persist manifest to disk atomically (caller must hold self._lock)."""
        manifest_path = self.migration_dir / "manifest.json"
        content = json.dumps(asdict(manifest), indent=2, ensure_ascii=False)
        _atomic_write(manifest_path, content)

    def load_manifest(self) -> MigrationManifest:
        """Load manifest.json from disk."""
        with self._lock:
            return self._load_manifest_unlocked()

    def save_manifest(self, manifest: MigrationManifest) -> None:
        """Persist manifest to disk atomically."""
        with self._lock:
            self._save_manifest_unlocked(manifest)

    # -- Phase gate logic ----------------------------------------------------

    def get_phase_status(self, phase: str) -> str:
        """Return the status of a given phase from the manifest."""
        if phase not in PHASE_ORDER:
            raise ValueError(f"Unknown phase: {phase}")
        manifest = self.load_manifest()
        phase_data = manifest.phases.get(phase, {})
        return phase_data.get("status", "pending")

    def start_phase(self, phase: str) -> None:
        """Start a phase (transition from pending to in_progress). Idempotent if already in_progress."""
        if phase not in PHASE_ORDER:
            raise ValueError(f"Unknown phase: {phase}")
        with self._lock:
            manifest = self._load_manifest_unlocked()
            current_status = manifest.phases[phase]["status"]
            if current_status == "in_progress":
                return  # Already started, idempotent
            if current_status != "pending":
                raise RuntimeError(
                    f"Cannot start phase '{phase}': status is '{current_status}', expected 'pending'"
                )
            manifest.phases[phase]["status"] = "in_progress"
            manifest.phases[phase]["started_at"] = datetime.now(timezone.utc).isoformat()
            self._save_manifest_unlocked(manifest)

    def _check_phase_gate_unlocked(self, from_phase: str, to_phase: str) -> tuple[bool, str]:
        """Validate phase transition (caller must hold self._lock or ensure safety).

        This variant does not acquire locks, so it can be called from within
        locked sections like advance_phase.
        """
        if from_phase not in PHASE_ORDER or to_phase not in PHASE_ORDER:
            return False, f"Unknown phase: {from_phase} or {to_phase}"

        from_idx = PHASE_ORDER.index(from_phase)
        to_idx = PHASE_ORDER.index(to_phase)
        if to_idx != from_idx + 1:
            return False, f"Cannot jump from {from_phase} to {to_phase}"

        # Gate: understand -> guardrail
        if from_phase == "understand" and to_phase == "guardrail":
            docs_dir = self.migration_dir / "docs"
            has_docs = any(docs_dir.iterdir()) if docs_dir.exists() else False
            if not has_docs:
                return False, "Phase gate failed: no documentation generated in docs/"
            seams_path = self.migration_dir / "seams.json"
            if not seams_path.exists():
                return False, "Phase gate failed: seams.json does not exist"
            return True, "Gate passed: docs generated and seams.json exists"

        # Gate: guardrail -> migrate
        if from_phase == "guardrail" and to_phase == "migrate":
            features_path = self.migration_dir / "features.json"
            try:
                data = json.loads(features_path.read_text(encoding="utf-8"))
                # Handle both flat list and {"features": [...]} wrapper
                if isinstance(data, dict):
                    data = data.get("features", [])
                # Filter to known Feature fields to tolerate extra keys
                _feature_fields = {f.name for f in fields(Feature)}
                features = [Feature(**{k: v for k, v in f.items() if k in _feature_fields}) for f in data]
            except FileNotFoundError:
                return False, "Phase gate failed: features.json not found"
            except (json.JSONDecodeError, TypeError) as exc:
                return False, f"Phase gate failed: features.json is invalid: {exc}"
            if not features:
                return False, "No features defined"
            failing = [f for f in features if not f.passes]
            if failing:
                ids = ", ".join(f.id for f in failing[:5])
                return False, f"Phase gate failed: {len(failing)} characterization tests not passing ({ids})"
            return True, "Gate passed: all characterization tests pass"

        # Gate: migrate -> verify
        if from_phase == "migrate" and to_phase == "verify":
            plan_path = self.migration_dir / "migration-plan.json"
            try:
                data = json.loads(plan_path.read_text(encoding="utf-8"))
                steps_data = data.get("steps", [])
                _plan_fields = {f.name for f in fields(MigrationPlan)}
                _step_fields = {f.name for f in fields(MigrationStep)}
                plan_data = {k: v for k, v in data.items() if k in _plan_fields and k != "steps"}
                plan = MigrationPlan(**plan_data)
                plan.steps = [MigrationStep(**{k: v for k, v in s.items() if k in _step_fields}) for s in steps_data]
            except FileNotFoundError:
                return False, "Phase gate failed: migration-plan.json not found"
            except (json.JSONDecodeError, TypeError) as exc:
                return False, f"Phase gate failed: migration-plan.json is invalid: {exc}"
            incomplete = [s for s in plan.steps if s.status != "completed"]
            if incomplete:
                ids = ", ".join(s.id for s in incomplete[:5])
                return False, f"Phase gate failed: {len(incomplete)} steps not completed ({ids})"
            return True, "Gate passed: all migration steps completed"

        return True, "Gate passed"

    def check_phase_gate(self, from_phase: str, to_phase: str) -> tuple[bool, str]:
        """Validate whether transition from from_phase to to_phase is allowed.

        Returns:
            Tuple of (allowed, reason). If allowed is False, reason explains why.
        """
        if from_phase not in PHASE_ORDER or to_phase not in PHASE_ORDER:
            return False, f"Unknown phase: {from_phase} or {to_phase}"

        from_idx = PHASE_ORDER.index(from_phase)
        to_idx = PHASE_ORDER.index(to_phase)
        if to_idx != from_idx + 1:
            return False, f"Cannot jump from {from_phase} to {to_phase}"

        # Gate: understand -> guardrail
        if from_phase == "understand" and to_phase == "guardrail":
            docs_dir = self.migration_dir / "docs"
            has_docs = any(docs_dir.iterdir()) if docs_dir.exists() else False
            if not has_docs:
                return False, "Phase gate failed: no documentation generated in docs/"
            seams_path = self.migration_dir / "seams.json"
            if not seams_path.exists():
                return False, "Phase gate failed: seams.json does not exist"
            return True, "Gate passed: docs generated and seams.json exists"

        # Gate: guardrail -> migrate
        if from_phase == "guardrail" and to_phase == "migrate":
            try:
                features = self.load_features()
            except FileNotFoundError:
                return False, "Phase gate failed: features.json not found"
            if not features:
                return False, "No features defined"
            failing = [f for f in features if not f.passes]
            if failing:
                ids = ", ".join(f.id for f in failing[:5])
                return False, f"Phase gate failed: {len(failing)} characterization tests not passing ({ids})"
            return True, "Gate passed: all characterization tests pass"

        # Gate: migrate -> verify
        if from_phase == "migrate" and to_phase == "verify":
            try:
                plan = self.load_plan()
            except FileNotFoundError:
                return False, "Phase gate failed: migration-plan.json not found"
            incomplete = [s for s in plan.steps if s.status != "completed"]
            if incomplete:
                ids = ", ".join(s.id for s in incomplete[:5])
                return False, f"Phase gate failed: {len(incomplete)} steps not completed ({ids})"
            return True, "Gate passed: all migration steps completed"

        return True, "Gate passed"

    def advance_phase(self, phase: str) -> PhaseResult:
        """Mark the current phase as complete and start the next one.

        Args:
            phase: The phase that has just been completed.

        Returns:
            PhaseResult for the completed phase.
        """
        if phase not in PHASE_ORDER:
            raise ValueError(f"Unknown phase: {phase}")

        phase_idx = PHASE_ORDER.index(phase)
        next_phase = PHASE_ORDER[phase_idx + 1] if phase_idx + 1 < len(PHASE_ORDER) else None

        with self._lock:
            # Enforce phase gate if there is a next phase (inside lock for consistency)
            if next_phase is not None:
                allowed, reason = self._check_phase_gate_unlocked(phase, next_phase)
                if not allowed:
                    raise RuntimeError(f"Phase gate failed: {reason}")

            manifest = self._load_manifest_unlocked()
            now = _timestamp_iso()

            # Verify current phase is in_progress before advancing
            if phase in manifest.phases:
                current_status = manifest.phases[phase].get("status", "pending")
                if current_status != "in_progress":
                    raise RuntimeError(
                        f"Cannot advance phase '{phase}': status is '{current_status}', expected 'in_progress'"
                    )

            # Mark current phase completed
            if phase in manifest.phases:
                manifest.phases[phase]["status"] = "completed"
                manifest.phases[phase]["completed_at"] = now

            # Start next phase if there is one
            if next_phase is not None:
                manifest.phases[next_phase]["status"] = "in_progress"
                manifest.phases[next_phase]["started_at"] = now

            self._save_manifest_unlocked(manifest)

        result = PhaseResult(
            phase=phase,
            status="completed",
            completed_at=now,
        )
        logger.info("Phase '%s' completed for migration %s", phase, self.migration_id)
        return result

    # -- Features CRUD -------------------------------------------------------

    def load_features(self) -> list[Feature]:
        """Load features from features.json."""
        features_path = self.migration_dir / "features.json"
        with self._lock:
            try:
                data = json.loads(features_path.read_text(encoding="utf-8"))
                # Handle both flat list and {"features": [...]} wrapper
                if isinstance(data, dict):
                    data = data.get("features", [])
                # Filter to known Feature fields to tolerate extra keys
                _feature_fields = {f.name for f in fields(Feature)}
                return [Feature(**{k: v for k, v in f.items() if k in _feature_fields}) for f in data]
            except FileNotFoundError:
                logger.warning("Features file not found: %s", features_path)
                raise
            except (json.JSONDecodeError, TypeError) as exc:
                logger.error("Corrupt features file: %s", exc)
                raise

    def save_features(self, features: list[Feature]) -> None:
        """Save features to features.json atomically."""
        features_path = self.migration_dir / "features.json"
        content = json.dumps(
            [asdict(f) for f in features], indent=2, ensure_ascii=False
        )
        with self._lock:
            _atomic_write(features_path, content)
        logger.info("Saved %d features to %s", len(features), features_path)

    # -- Plan CRUD -----------------------------------------------------------

    def load_plan(self) -> MigrationPlan:
        """Load migration plan from migration-plan.json."""
        plan_path = self.migration_dir / "migration-plan.json"
        with self._lock:
            try:
                data = json.loads(plan_path.read_text(encoding="utf-8"))
                # Reconstruct nested MigrationStep objects
                steps_data = data.get("steps", [])
                _plan_fields = {f.name for f in fields(MigrationPlan)}
                _step_fields = {f.name for f in fields(MigrationStep)}
                plan_data = {k: v for k, v in data.items() if k in _plan_fields and k != "steps"}
                plan = MigrationPlan(**plan_data)
                plan.steps = [MigrationStep(**{k: v for k, v in s.items() if k in _step_fields}) for s in steps_data]
                return plan
            except FileNotFoundError:
                logger.warning("Plan file not found: %s", plan_path)
                raise
            except (json.JSONDecodeError, TypeError) as exc:
                logger.error("Corrupt plan file: %s", exc)
                raise

    def save_plan(self, plan: MigrationPlan) -> None:
        """Save migration plan to migration-plan.json atomically."""
        plan_path = self.migration_dir / "migration-plan.json"
        content = json.dumps(asdict(plan), indent=2, ensure_ascii=False)
        with self._lock:
            _atomic_write(plan_path, content)
        logger.info("Saved migration plan (v%d) to %s", plan.version, plan_path)

    # -- Seams CRUD ----------------------------------------------------------

    def load_seams(self) -> list[SeamInfo]:
        """Load seams from seams.json."""
        seams_path = self.migration_dir / "seams.json"
        with self._lock:
            try:
                data = json.loads(seams_path.read_text(encoding="utf-8"))
                # Handle both flat list and {"seams": [...]} wrapper
                if isinstance(data, dict):
                    data = data.get("seams", [])
                _seam_fields = {f.name for f in fields(SeamInfo)}
                return [SeamInfo(**{k: v for k, v in s.items() if k in _seam_fields}) for s in data]
            except FileNotFoundError:
                logger.warning("Seams file not found: %s", seams_path)
                raise
            except (json.JSONDecodeError, TypeError) as exc:
                logger.error("Corrupt seams file: %s", exc)
                raise

    def save_seams(self, seams: list[SeamInfo]) -> None:
        """Save seams to seams.json atomically."""
        seams_path = self.migration_dir / "seams.json"
        content = json.dumps(
            [asdict(s) for s in seams], indent=2, ensure_ascii=False
        )
        with self._lock:
            _atomic_write(seams_path, content)
        logger.info("Saved %d seams to %s", len(seams), seams_path)

    # -- Checkpoints ---------------------------------------------------------

    @staticmethod
    def _validate_step_id(step_id: str) -> None:
        """Validate step_id contains only safe characters for git tag names."""
        if not re.match(r'^[a-zA-Z0-9_-]+$', step_id):
            raise ValueError(
                f"Invalid step_id '{step_id}': must match ^[a-zA-Z0-9_-]+$"
            )

    def create_checkpoint(self, step_id: str) -> str:
        """Create a git tag checkpoint for a migration step.

        Creates tag: loki-migrate/<step_id>/pre

        Returns:
            The tag name created.
        """
        self._validate_step_id(step_id)
        tag_name = f"loki-migrate/{step_id}/pre"
        try:
            subprocess.run(
                ["git", "tag", tag_name],
                cwd=self.codebase_path,
                check=True,
                capture_output=True,
                text=True,
            )
        except subprocess.CalledProcessError as exc:
            logger.error("Failed to create checkpoint tag %s: %s", tag_name, exc.stderr)
            raise RuntimeError(f"Git tag creation failed: {exc.stderr}") from exc

        # Record in manifest (hold lock for entire read-modify-write)
        try:
            with self._lock:
                manifest = self._load_manifest_unlocked()
                manifest.checkpoints.append(tag_name)
                self._save_manifest_unlocked(manifest)
        except Exception:
            # Bug 9: rollback git tag if manifest save fails
            logger.error("Manifest save failed after git tag creation; deleting tag %s", tag_name)
            try:
                subprocess.run(
                    ["git", "tag", "-d", tag_name],
                    cwd=self.codebase_path,
                    check=True,
                    capture_output=True,
                    text=True,
                )
            except subprocess.CalledProcessError:
                logger.error("Failed to delete orphaned git tag %s", tag_name)
            raise

        # Write checkpoint metadata
        meta_path = self.migration_dir / "checkpoints" / f"{step_id}.json"
        meta = {
            "step_id": step_id,
            "tag": tag_name,
            "created_at": _timestamp_iso(),
        }
        _atomic_write(meta_path, json.dumps(meta, indent=2))
        logger.info("Created checkpoint: %s", tag_name)
        return tag_name

    def rollback_to_checkpoint(self, step_id: str) -> None:
        """Reset the codebase to the checkpoint tag for a given step.

        Runs: git reset --hard loki-migrate/<step_id>/pre
        """
        self._validate_step_id(step_id)
        tag_name = f"loki-migrate/{step_id}/pre"
        try:
            subprocess.run(
                ["git", "reset", "--hard", tag_name],
                cwd=self.codebase_path,
                check=True,
                capture_output=True,
                text=True,
            )
        except subprocess.CalledProcessError as exc:
            logger.error("Failed to rollback to %s: %s", tag_name, exc.stderr)
            raise RuntimeError(f"Git rollback failed: {exc.stderr}") from exc
        logger.info("Rolled back to checkpoint: %s", tag_name)

    # -- Progress and summary ------------------------------------------------

    def get_progress(self) -> dict[str, Any]:
        """Return a progress summary of the migration.

        Returns:
            Dict with phase, step, features stats, last checkpoint, source,
            target, completed_phases, and nested features/steps/checkpoint dicts.
        """
        manifest = self.load_manifest()

        # Current phase and overall status
        current_phase = "pending"
        overall_status = "pending"
        completed_phases: list[str] = []
        for phase in PHASE_ORDER:
            status = manifest.phases.get(phase, {}).get("status", "pending")
            if status == "in_progress":
                current_phase = phase
                overall_status = "in_progress"
                break
            if status == "completed":
                current_phase = phase
                completed_phases.append(phase)
                overall_status = "completed"

        # Feature stats
        features_total = 0
        features_passing = 0
        try:
            features = self.load_features()
            features_total = len(features)
            features_passing = sum(1 for f in features if f.passes)
        except (FileNotFoundError, json.JSONDecodeError, TypeError):
            pass

        # Step stats
        steps_total = 0
        steps_completed = 0
        current_step = None
        current_step_index = 0
        try:
            plan = self.load_plan()
            steps_total = len(plan.steps)
            steps_completed = sum(1 for s in plan.steps if s.status == "completed")
            in_progress = [s for s in plan.steps if s.status == "in_progress"]
            if in_progress:
                current_step = in_progress[0].id
            # Current step index: completed + 1 (1-based) or completed if all done
            current_step_index = min(steps_completed + 1, steps_total) if steps_total else 0
        except (FileNotFoundError, json.JSONDecodeError, TypeError):
            pass

        # Last checkpoint metadata
        last_checkpoint_data: Optional[dict[str, Any]] = None
        if manifest.checkpoints:
            last_tag = manifest.checkpoints[-1]
            # Try to read checkpoint metadata file
            # Tag format: loki-migrate/<step_id>/pre
            parts = last_tag.split("/")
            if len(parts) >= 2:
                cp_step_id = parts[1]
                meta_path = self.migration_dir / "checkpoints" / f"{cp_step_id}.json"
                try:
                    meta = json.loads(meta_path.read_text(encoding="utf-8"))
                    last_checkpoint_data = {
                        "tag": meta.get("tag", last_tag),
                        "step_id": meta.get("step_id", cp_step_id),
                        "timestamp": meta.get("created_at", ""),
                    }
                except (FileNotFoundError, json.JSONDecodeError):
                    last_checkpoint_data = {"tag": last_tag, "step_id": "", "timestamp": ""}

        return {
            "migration_id": self.migration_id,
            "status": overall_status,
            "current_phase": current_phase,
            "phases": manifest.phases,
            "completed_phases": completed_phases,
            "source": manifest.source_info,
            "target": manifest.target_info,
            "current_step": current_step,
            "features": {"passing": features_passing, "total": features_total},
            "steps": {"current": current_step_index, "completed": steps_completed, "total": steps_total},
            "last_checkpoint": last_checkpoint_data,
            "checkpoints_count": len(manifest.checkpoints),
        }

    def generate_plan_summary(self) -> str:
        """Generate a human-readable plan summary for --show-plan.

        Returns:
            Formatted string representation of the migration plan.
        """
        try:
            plan = self.load_plan()
        except FileNotFoundError:
            return "No migration plan found. Run the 'understand' phase first."

        lines: list[str] = []
        lines.append(f"Migration Plan v{plan.version}")
        lines.append(f"Strategy: {plan.strategy}")
        lines.append(f"Rollback: {plan.rollback_strategy}")
        lines.append("")

        if plan.constraints:
            lines.append("Constraints:")
            for c in plan.constraints:
                lines.append(f"  - {c}")
            lines.append("")

        lines.append(f"Steps ({len(plan.steps)} total):")
        lines.append("-" * 60)

        for step in plan.steps:
            status_marker = {
                "pending": "[ ]",
                "in_progress": "[>]",
                "completed": "[x]",
                "failed": "[!]",
            }.get(step.status, "[ ]")

            lines.append(f"  {status_marker} {step.id}: {step.description}")
            lines.append(f"      Type: {step.type} | Risk: {step.risk} | Tokens: {step.estimated_tokens}")
            if step.files:
                lines.append(f"      Files: {', '.join(step.files[:5])}")
                if len(step.files) > 5:
                    lines.append(f"             ... and {len(step.files) - 5} more")
            if step.depends_on:
                lines.append(f"      Depends on: {', '.join(step.depends_on)}")
            if step.rollback_point:
                lines.append("      [Rollback point]")
            lines.append("")

        if plan.exit_criteria:
            lines.append("Exit Criteria:")
            for key, val in plan.exit_criteria.items():
                lines.append(f"  {key}: {val}")

        return "\n".join(lines)


# ---------------------------------------------------------------------------
# Singleton accessor
# ---------------------------------------------------------------------------

_pipeline_instance: Optional[MigrationPipeline] = None
_pipeline_lock = threading.Lock()


def get_migration_pipeline(
    codebase_path: Optional[str] = None,
    target: Optional[str] = None,
    options: Optional[dict[str, Any]] = None,
) -> MigrationPipeline:
    """Get or create the singleton MigrationPipeline instance.

    On first call, codebase_path and target are required.
    Subsequent calls return the existing instance.
    """
    global _pipeline_instance
    with _pipeline_lock:
        if _pipeline_instance is None:
            if codebase_path is None or target is None:
                raise ValueError(
                    "codebase_path and target are required for first initialization"
                )
            _pipeline_instance = MigrationPipeline(
                codebase_path=codebase_path,
                target=target,
                options=options,
            )
        return _pipeline_instance


def reset_migration_pipeline() -> None:
    """Reset the singleton MigrationPipeline instance.

    Useful for testing or when starting a new migration session.
    """
    global _pipeline_instance
    with _pipeline_lock:
        _pipeline_instance = None


# ---------------------------------------------------------------------------
# Utility: list all migrations
# ---------------------------------------------------------------------------


def list_migrations() -> list[dict[str, Any]]:
    """List all migrations in ~/.loki/migrations/.

    Returns:
        List of dicts with id, created_at, source path, target, and status.
    """
    migrations_path = Path(MIGRATIONS_DIR)
    if not migrations_path.exists():
        return []

    results: list[dict[str, Any]] = []
    for entry in sorted(migrations_path.iterdir()):
        if not entry.is_dir():
            continue
        manifest_file = entry / "manifest.json"
        if not manifest_file.exists():
            continue
        try:
            data = json.loads(manifest_file.read_text(encoding="utf-8"))
            # Determine overall status from phases (clean string, no parenthesized phase)
            phases = data.get("phases", {})
            status = "pending"
            for phase in PHASE_ORDER:
                phase_status = phases.get(phase, {}).get("status", "pending")
                if phase_status == "in_progress":
                    status = "in_progress"
                    break
                if phase_status == "completed":
                    status = "completed"

            source_info = data.get("source_info", {})
            results.append({
                "id": data.get("id", entry.name),
                "created_at": data.get("created_at", ""),
                "source": source_info,
                "source_path": source_info.get("path", ""),
                "target": data.get("target_info", {}).get("target", ""),
                "status": status,
            })
        except (json.JSONDecodeError, OSError) as exc:
            logger.warning("Skipping corrupt migration at %s: %s", entry, exc)
            continue

    return results
