"""Unified playlist schema and load/save helpers for music-rec-video."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field


DEFAULT_PLAYLIST_PATH = Path(__file__).resolve().parent / "playlist.json"


class ResolutionConfig(BaseModel):
    """Output sequence resolution."""

    model_config = ConfigDict(extra="allow")

    width: int = 1920
    height: int = 1080


class IntroConfig(BaseModel):
    """Optional opening monologue/intro card before the first song."""

    model_config = ConfigDict(extra="allow")

    enabled: bool = False
    text: str = ""
    duration: float = 8.0
    bg_mode: Literal["black", "blur_first_song", "image"] = "black"
    bg_image: str = ""


class SongItem(BaseModel):
    """Single song entry in the playlist."""

    model_config = ConfigDict(extra="allow")

    title: str
    artist: str
    album: str = ""
    youtube_url: str = ""
    start: str = "0:00"
    end: str = "0:30"
    file_path: str = ""
    normalized_path: str = ""
    spectrum_path: str = ""
    cover_url: str = ""
    cover_path: str = ""
    reason: str = ""
    template: str = "annual"
    pre_rendered_clip: str = ""
    display_index: Optional[int] = None


class PlaylistConfig(BaseModel):
    """Root playlist configuration."""

    model_config = ConfigDict(extra="allow")

    output_sequence_name: str = "音乐推荐合辑"
    resolution: ResolutionConfig = Field(default_factory=ResolutionConfig)
    fps: int = 30
    intro: IntroConfig = Field(default_factory=IntroConfig)
    songs: list[SongItem] = Field(default_factory=list)


def load_playlist(path: Path | str = DEFAULT_PLAYLIST_PATH) -> PlaylistConfig:
    """Load and validate playlist.json, filling defaults for missing fields."""
    target = Path(path)
    if not target.exists():
        return PlaylistConfig()
    raw = json.loads(target.read_text(encoding="utf-8"))
    return PlaylistConfig.model_validate(raw)


def save_playlist(
    playlist: PlaylistConfig | dict,
    path: Path | str = DEFAULT_PLAYLIST_PATH,
) -> Path:
    """Persist playlist configuration as formatted UTF-8 JSON."""
    target = Path(path)
    model = (
        playlist
        if isinstance(playlist, PlaylistConfig)
        else PlaylistConfig.model_validate(playlist)
    )
    target.write_text(
        json.dumps(model.model_dump(exclude_none=True), ensure_ascii=False, indent=2)
        + "\n",
        encoding="utf-8",
    )
    return target
