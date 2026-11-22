"""Base contract for pluggable special-template clip renderers."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path

from schema import ResolutionConfig, SongItem


@dataclass
class RenderResult:
    """Result returned by a clip renderer."""

    success: bool
    output_path: Path | None = None
    message: str = ""


class ClipRenderer(ABC):
    """Abstract base class for independent clip renderers (e.g. AE templates)."""

    name: str = ""
    description: str = ""

    @abstractmethod
    def check_readiness(self, project_root: Path) -> tuple[bool, str]:
        """Return (is_ready, human_readable_reason) for this renderer."""

    @abstractmethod
    def render_clip(
        self,
        song: SongItem,
        project_root: Path,
        out_path: Path,
        resolution: ResolutionConfig,
        fps: int = 30,
    ) -> RenderResult:
        """Render a self-contained .mp4 clip for the given song."""
