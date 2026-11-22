"""Pluggable After Effects renderer for the 'wangye_ae' HUD template.

Completely decoupled from the main pipeline: replacing or removing this file
(and templates/wangye_ae/) swaps out the special template without touching
playlist schema, Web UI, or Premiere Pro assembly scripts.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

from renderers.base import ClipRenderer, RenderResult
from schema import ResolutionConfig, SongItem

DEFAULT_WINDOWS_AE_DIRS = (
    r"C:\Program Files\Adobe\Adobe After Effects 2025\Support Files",
    r"C:\Program Files\Adobe\Adobe After Effects 2024\Support Files",
    r"C:\Program Files\Adobe\Adobe After Effects 2023\Support Files",
)


def find_aerender() -> Path | None:
    """Locate aerender executable via env var, PATH, or standard Windows dirs."""
    env_path = os.environ.get("AERENDER_PATH", "").strip()
    if env_path and Path(env_path).is_file():
        return Path(env_path)

    which_path = shutil.which("aerender") or shutil.which("aerender.exe")
    if which_path:
        return Path(which_path)

    for ae_dir in DEFAULT_WINDOWS_AE_DIRS:
        candidate = Path(ae_dir) / "aerender.exe"
        if candidate.is_file():
            return candidate
    return None


def find_afterfx() -> Path | None:
    """Locate AfterFX.exe (used to run ExtendScript headlessly to swap assets)."""
    env_path = os.environ.get("AFTERFX_PATH", "").strip()
    if env_path and Path(env_path).is_file():
        return Path(env_path)

    for ae_dir in DEFAULT_WINDOWS_AE_DIRS:
        candidate = Path(ae_dir) / "AfterFX.exe"
        if candidate.is_file():
            return candidate
    return None


class WangYeAERenderer(ClipRenderer):
    """Independent AE renderer for the -WangYe- style audio-reactive HUD."""

    name = "wangye_ae"
    description = "After Effects 音频驱动 HUD 特效单曲模板（可独立替换）"

    def _template_dir(self, project_root: Path) -> Path:
        return project_root / "templates" / "wangye_ae"

    def check_readiness(self, project_root: Path) -> tuple[bool, str]:
        tdir = self._template_dir(project_root)
        aep_path = tdir / "template.aep"
        jsx_path = tdir / "prepare.jsx"

        if not aep_path.is_file():
            return False, f"缺少 AE 母版工程: {aep_path}"
        if not jsx_path.is_file():
            return False, f"缺少 AE 替换脚本: {jsx_path}"

        aerender = find_aerender()
        if not aerender:
            return (
                False,
                "未找到 aerender.exe（可通过环境变量 AERENDER_PATH 指定路径）",
            )
        return True, f"就绪 (aerender: {aerender})"

    def render_clip(
        self,
        song: SongItem,
        project_root: Path,
        out_path: Path,
        resolution: ResolutionConfig,
        fps: int = 30,
    ) -> RenderResult:
        ready, msg = self.check_readiness(project_root)
        if not ready:
            return RenderResult(success=False, message=msg)

        aerender = find_aerender()
        afterfx = find_afterfx()
        tdir = self._template_dir(project_root)
        aep_path = tdir / "template.aep"
        jsx_path = tdir / "prepare.jsx"

        out_path.parent.mkdir(parents=True, exist_ok=True)

        with tempfile.TemporaryDirectory(prefix="wangye_ae_") as tmp:
            tmp_dir = Path(tmp)
            temp_aep = tmp_dir / "render_job.aep"
            job_json = tmp_dir / "job.json"

            job_payload = {
                "template_aep": str(aep_path.resolve()),
                "output_aep": str(temp_aep.resolve()),
                "output_mp4": str(out_path.resolve()),
                "width": resolution.width,
                "height": resolution.height,
                "fps": fps,
                "song": song.model_dump(),
                "project_root": str(project_root.resolve()),
            }
            job_json.write_text(
                json.dumps(job_payload, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )

            # Step 1: Run prepare.jsx if AfterFX.exe is available to save a
            # parameterized temp_aep; otherwise aerender uses template.aep directly.
            target_aep = aep_path
            if afterfx:
                wrapper_jsx = tmp_dir / "run_prepare.jsx"
                wrapper_jsx.write_text(
                    f'var WANGYE_JOB_FILE = {json.dumps(str(job_json.resolve()))};\n'
                    f'#include {json.dumps(str(jsx_path.resolve()))}\n',
                    encoding="utf-8",
                )
                subprocess.run(
                    [str(afterfx), "-noui", "-r", str(wrapper_jsx)],
                    check=True,
                )
                if temp_aep.is_file():
                    target_aep = temp_aep

            # Step 2: Headless render via aerender.exe
            cmd = [
                str(aerender),
                "-project",
                str(target_aep),
                "-comp",
                "MAIN_COMP",
                "-output",
                str(out_path),
            ]
            proc = subprocess.run(cmd, capture_output=True, text=True)
            if proc.returncode != 0:
                return RenderResult(
                    success=False,
                    message=f"aerender 失败 (code={proc.returncode}): {proc.stderr[-500:]}",
                )

        return RenderResult(
            success=True,
            output_path=out_path,
            message=f"渲染完成: {out_path.name}",
        )
