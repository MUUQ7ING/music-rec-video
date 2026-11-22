"""Registry for pluggable special-template clip renderers."""

from __future__ import annotations

from pathlib import Path

from renderers.base import ClipRenderer, RenderResult
from renderers.wangye_ae import WangYeAERenderer
from schema import ResolutionConfig, SongItem

_REGISTRY: dict[str, ClipRenderer] = {}


def register_renderer(renderer: ClipRenderer) -> None:
    """Register a clip renderer by its unique template name."""
    if not renderer.name:
        raise ValueError("Renderer must define a non-empty 'name'.")
    _REGISTRY[renderer.name] = renderer


def get_renderer(name: str) -> ClipRenderer | None:
    """Look up a registered special renderer by template name."""
    return _REGISTRY.get(name)


def list_renderers() -> dict[str, ClipRenderer]:
    """Return a copy of all registered special renderers."""
    return dict(_REGISTRY)


def render_song_clip(
    song: SongItem,
    project_root: Path,
    out_path: Path,
    resolution: ResolutionConfig,
    fps: int = 30,
) -> RenderResult:
    """Dispatch clip rendering to the renderer matching song.template."""
    renderer = get_renderer(song.template)
    if renderer is None:
        return RenderResult(
            success=False,
            message=f"未注册的特殊模板渲染器: {song.template}",
        )
    return renderer.render_clip(song, project_root, out_path, resolution, fps)


# Built-in special renderers
register_renderer(WangYeAERenderer())
