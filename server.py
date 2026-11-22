"""
server.py — Visual Web Studio for Music Recommendation Video Workflow

Features:
  - Visual interface for playlist songs
  - Multi-candidate MV search on YouTube (4-6 options with thumbnails & metadata)
  - Interactive selection of candidates with one-click adoption
  - In-place editing of start/end timestamps and recommendation reasons
  - One-click 1080p downloading with real-time status feedback
  - NetEase playlist link parser integration
"""

import json
import os
import threading
import time
from pathlib import Path
from typing import Optional
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import uvicorn
import yt_dlp

from download import download_mv, slug, RAW_DIR, resolve_file_path, to_relative_path
from netease import import_netease_playlist
from bilibili import search_bilibili
from preprocess import preprocess_song
from renderers import list_renderers, render_song_clip
from schema import load_playlist as load_playlist_model, save_playlist as save_playlist_model

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
BASE_PATH = Path(BASE_DIR)
PLAYLIST_FILE = os.path.join(BASE_DIR, "playlist.json")
WEB_DIR = os.path.join(BASE_DIR, "web")
COVERS_DIR = os.path.join(BASE_DIR, "covers")
os.makedirs(COVERS_DIR, exist_ok=True)

app = FastAPI(title="Music Rec Video Studio")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.mount("/covers", StaticFiles(directory=COVERS_DIR), name="covers")

# Global task state tracking
task_lock = threading.Lock()
tasks_state = {
    "is_downloading": False,
    "current_song": "",
    "logs": [],
    "progress_percent": 0,
}


def log_task(msg: str):
    """Append a timestamped message to task logs."""
    timestamp = time.strftime("%H:%M:%S")
    entry = f"[{timestamp}] {msg}"
    print(entry)
    with task_lock:
        tasks_state["logs"].append(entry)
        if len(tasks_state["logs"]) > 50:
            tasks_state["logs"].pop(0)


def load_playlist() -> dict:
    """Load playlist.json via unified schema, filling defaults for missing fields."""
    return load_playlist_model(PLAYLIST_FILE).model_dump()


def save_playlist(data: dict):
    """Save playlist.json to disk, normalizing local file_path entries to portable relative paths."""
    for song in data.get("songs", []):
        fp = song.get("file_path", "")
        if fp:
            resolved = resolve_file_path(fp)
            if os.path.isabs(resolved) and os.path.isfile(resolved):
                song["file_path"] = to_relative_path(resolved)
            elif os.path.isabs(fp):
                song["file_path"] = to_relative_path(fp)
    save_playlist_model(data, PLAYLIST_FILE)


@app.get("/")
def serve_index():
    """Serve the frontend single-page application."""
    index_file = os.path.join(WEB_DIR, "index.html")
    if not os.path.isfile(index_file):
        raise HTTPException(status_code=404, detail="index.html not found")
    return FileResponse(index_file)


@app.get("/api/playlist")
def get_playlist_api():
    """Get the current playlist configuration."""
    data = load_playlist()
    # Check actual file existence on disk for each song
    for song in data.get("songs", []):
        fp = resolve_file_path(song.get("file_path", ""))
        song["has_file"] = bool(fp and os.path.isfile(fp))
        if song["has_file"]:
            try:
                song["file_size_mb"] = round(os.path.getsize(fp) / 1024 / 1024, 2)
            except Exception:
                song["file_size_mb"] = 0
        else:
            song["file_size_mb"] = 0

        cp = resolve_file_path(song.get("cover_path", ""))
        song["has_cover"] = bool(cp and os.path.isfile(cp))
        np = resolve_file_path(song.get("normalized_path", ""))
        song["has_normalized"] = bool(np and os.path.isfile(np))
        sp = resolve_file_path(song.get("pre_rendered_clip", ""))
        song["has_pre_rendered"] = bool(sp and os.path.isfile(sp))
    return data


class PlaylistUpdateRequest(BaseModel):
    data: dict


@app.post("/api/playlist")
def update_playlist_api(req: PlaylistUpdateRequest):
    """Save updated playlist configuration."""
    save_playlist(req.data)
    return {"status": "ok", "message": "歌单已保存"}


class NeteaseImportRequest(BaseModel):
    url: str
    limit: int = 10
    append: bool = False


@app.post("/api/netease")
def import_netease_api(req: NeteaseImportRequest):
    """Parse NetEase Cloud Music playlist link and update playlist.json."""
    try:
        count, name = import_netease_playlist(
            input_str=req.url,
            limit=req.limit,
            append=req.append,
            output_path=PLAYLIST_FILE,
        )
        return {"status": "ok", "count": count, "playlist_name": name}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/api/candidates")
def search_candidates_api(
    query: str = Query(..., description="Search query string"),
    platform: str = Query("all", description="Search platform: all, bilibili, or youtube"),
    limit: int = Query(4, ge=1, le=10),
):
    """
    Search candidate videos from YouTube and Bilibili.
    Returns list of options with title, uploader, duration, thumbnail, platform, and URL.
    """
    results = []
    log_task(f"正在检索候选方案 ({platform}): {query}")

    # ── 1. Bilibili candidates ───────────────────────────────
    if platform in ("all", "bilibili"):
        try:
            bili_limit = limit if platform == "bilibili" else min(3, limit)
            bili_results = search_bilibili(query, limit=bili_limit)
            results.extend(bili_results)
        except Exception as e:
            log_task(f"[B站] 检索异常: {e}")

    # ── 2. YouTube candidates ────────────────────────────────
    if platform in ("all", "youtube"):
        try:
            yt_limit = limit if platform == "youtube" else min(3, limit)
            opts = {
                "quiet": True,
                "no_warnings": True,
                "extract_flat": True,
                "remote_components": ["ejs:github"],
            }
            search_term = f"ytsearch{yt_limit}:{query}"
            with yt_dlp.YoutubeDL(opts) as ydl:
                res = ydl.extract_info(search_term, download=False)
                entries = res.get("entries", [])
                for e in entries:
                    vid = e.get("id") or ""
                    dur = e.get("duration")
                    if dur:
                        mins = int(dur) // 60
                        secs = int(dur) % 60
                        dur_str = f"{mins}:{secs:02d}"
                    else:
                        dur_str = "--:--"

                    v_url = e.get("url")
                    if not v_url or "http" not in v_url:
                        v_url = f"https://www.youtube.com/watch?v={vid}"

                    thumb = f"https://i.ytimg.com/vi/{vid}/mqdefault.jpg" if vid else ""

                    results.append({
                        "id": vid,
                        "title": e.get("title", "未知标题"),
                        "uploader": e.get("uploader", "未知作者"),
                        "duration_str": dur_str,
                        "url": v_url,
                        "thumbnail": thumb,
                        "platform": "youtube",
                    })
        except Exception as e:
            log_task(f"[YouTube] 检索异常: {e}")

    return {"status": "ok", "candidates": results}


class DownloadSingleRequest(BaseModel):
    index: int
    force: bool = True
    quality: str = "1080"


def _worker_download_single(index: int, force: bool, quality: str):
    """Background worker for downloading a single song."""
    with task_lock:
        tasks_state["is_downloading"] = True
    try:
        data = load_playlist()
        songs = data.get("songs", [])
        if index < 0 or index >= len(songs):
            log_task("无效的歌曲序号")
            return

        song = songs[index]
        title, artist = song.get("title", ""), song.get("artist", "")
        url = song.get("youtube_url", "").strip()

        with task_lock:
            tasks_state["current_song"] = f"{artist} - {title}"

        out_path = os.path.join(RAW_DIR, slug(title, artist) + ".mp4")

        if force and os.path.isfile(out_path):
            try:
                os.remove(out_path)
            except Exception:
                pass

        if not url:
            log_task(f"未指定 URL，自动搜索: {title}")
            clean_title = title.split("(")[0].split("（")[0].strip()[:40]
            query = f"{clean_title} {artist} official MV"
            with yt_dlp.YoutubeDL({"quiet": True, "extract_flat": True, "remote_components": ["ejs:github"]}) as ydl:
                info = ydl.extract_info(f"ytsearch1:{query}", download=False)
                entries = info.get("entries", [])
                if entries:
                    url = entries[0].get("url") or entries[0].get("webpage_url")
                    song["youtube_url"] = url

        if not url:
            log_task(f"未找到可用的下载链接: {title}")
            return

        log_task(f"开始下载 {title} ({quality}p)...")
        success = download_mv(url, out_path, quality=quality)
        if success:
            song["file_path"] = to_relative_path(out_path)
            save_playlist(data)
            log_task(f"✓ 下载成功: {title}")
        else:
            log_task(f"✗ 下载失败: {title}")
    except Exception as e:
        log_task(f"下载异常: {e}")
    finally:
        with task_lock:
            tasks_state["is_downloading"] = False
            tasks_state["current_song"] = ""


@app.post("/api/download_single")
def download_single_api(req: DownloadSingleRequest):
    """Trigger download for a single song."""
    if tasks_state["is_downloading"]:
        return JSONResponse(status_code=400, content={"message": "当前已有下载任务在进行中"})

    t = threading.Thread(
        target=_worker_download_single,
        args=(req.index, req.force, req.quality),
        daemon=True,
    )
    t.start()
    return {"status": "started", "message": "已在后台启动下载"}


def _worker_download_all(force: bool, quality: str):
    """Background worker for batch downloading all songs in playlist."""
    with task_lock:
        tasks_state["is_downloading"] = True
    try:
        data = load_playlist()
        songs = data.get("songs", [])
        total = len(songs)

        for i, song in enumerate(songs):
            title, artist = song.get("title", ""), song.get("artist", "")
            with task_lock:
                tasks_state["current_song"] = f"[{i+1}/{total}] {artist} - {title}"
                tasks_state["progress_percent"] = int((i / total) * 100)

            out_path = os.path.join(RAW_DIR, slug(title, artist) + ".mp4")

            # Check if file exists
            existing_path = resolve_file_path(song.get("file_path", ""))
            if not force and existing_path and os.path.isfile(existing_path):
                log_task(f"跳过已存在: {title}")
                continue

            if force and os.path.isfile(out_path):
                try:
                    os.remove(out_path)
                except Exception:
                    pass

            url = song.get("youtube_url", "").strip()
            if not url:
                clean_title = title.split("(")[0].split("（")[0].strip()[:40]
                query = f"{clean_title} {artist} official MV"
                with yt_dlp.YoutubeDL({"quiet": True, "extract_flat": True, "remote_components": ["ejs:github"]}) as ydl:
                    info = ydl.extract_info(f"ytsearch1:{query}", download=False)
                    entries = info.get("entries", [])
                    if entries:
                        url = entries[0].get("url") or entries[0].get("webpage_url")
                        song["youtube_url"] = url

            if not url:
                log_task(f"未找到链接: {title}，跳过")
                continue

            log_task(f"下载 [{i+1}/{total}] {title}...")
            if download_mv(url, out_path, quality=quality):
                song["file_path"] = to_relative_path(out_path)
                save_playlist(data)
                log_task(f"✓ 成功: {title}")
            else:
                log_task(f"✗ 失败: {title}")

        with task_lock:
            tasks_state["progress_percent"] = 100
        log_task("🎉 全部下载流程结束！")
    except Exception as e:
        log_task(f"批量下载中断: {e}")
    finally:
        with task_lock:
            tasks_state["is_downloading"] = False
            tasks_state["current_song"] = ""


class DownloadAllRequest(BaseModel):
    force: bool = False
    quality: str = "1080"


@app.post("/api/download_all")
def download_all_api(req: DownloadAllRequest):
    """Trigger batch download of all songs in playlist."""
    if tasks_state["is_downloading"]:
        return JSONResponse(status_code=400, content={"message": "当前已有下载任务在进行中"})

    t = threading.Thread(
        target=_worker_download_all,
        args=(req.force, req.quality),
        daemon=True,
    )
    t.start()
    return {"status": "started", "message": "已在后台启动全量下载"}


@app.get("/api/status")
def get_status_api():
    """Get the current download task status and logs."""
    with task_lock:
        return dict(tasks_state)


@app.get("/api/renderers")
def get_renderers_api():
    """List built-in annual template and all registered special clip renderers."""
    items = [
        {
            "name": "annual",
            "description": "年度歌单主模板（Pr 原生 .mogrt + 底部毛玻璃）",
            "ready": True,
            "message": "Pr 主模板",
        }
    ]
    for name, renderer in list_renderers().items():
        ready, msg = renderer.check_readiness(BASE_PATH)
        items.append(
            {
                "name": name,
                "description": renderer.description,
                "ready": ready,
                "message": msg,
            }
        )
    return {"renderers": items}


def _worker_preprocess(force: bool):
    with task_lock:
        tasks_state["is_downloading"] = True
        tasks_state["progress_percent"] = 0
    try:
        playlist = load_playlist_model(PLAYLIST_FILE)
        total = len(playlist.songs)
        for i, song in enumerate(playlist.songs):
            with task_lock:
                tasks_state["current_song"] = f"预处理 [{i+1}/{total}] {song.title}"
                tasks_state["progress_percent"] = int((i / max(1, total)) * 100)
            preprocess_song(song, BASE_PATH, force=force, log_fn=log_task)
            save_playlist_model(playlist, PLAYLIST_FILE)
        with task_lock:
            tasks_state["progress_percent"] = 100
        log_task("🎉 全部素材预处理（1:1 封面 + -14 LUFS 响度统一）完成！")
    except Exception as e:
        log_task(f"预处理异常: {e}")
    finally:
        with task_lock:
            tasks_state["is_downloading"] = False
            tasks_state["current_song"] = ""


class PreprocessRequest(BaseModel):
    force: bool = False


@app.post("/api/preprocess")
def preprocess_api(req: PreprocessRequest):
    """Trigger background cover extraction and -14 LUFS audio normalization."""
    if tasks_state["is_downloading"]:
        return JSONResponse(status_code=400, content={"message": "当前已有后台任务在进行中"})
    t = threading.Thread(target=_worker_preprocess, args=(req.force,), daemon=True)
    t.start()
    return {"status": "started", "message": "已在后台启动预处理"}


def _worker_render_special(index: Optional[int]):
    with task_lock:
        tasks_state["is_downloading"] = True
        tasks_state["progress_percent"] = 0
    try:
        playlist = load_playlist_model(PLAYLIST_FILE)
        targets = (
            [(index, playlist.songs[index])]
            if index is not None and 0 <= index < len(playlist.songs)
            else [(i, s) for i, s in enumerate(playlist.songs) if s.template != "annual"]
        )
        total = len(targets)
        if total == 0:
            log_task("没有需要特殊模板渲染的单曲（全部为 annual 主模板）")
            return

        for step, (idx, song) in enumerate(targets):
            with task_lock:
                tasks_state["current_song"] = f"特殊渲染 [{step+1}/{total}] {song.title}"
                tasks_state["progress_percent"] = int((step / total) * 100)
            out_path = BASE_PATH / "processed" / f"special_{idx+1:02d}_{slug(song.title, song.artist)}.mp4"
            res = render_song_clip(
                song,
                BASE_PATH,
                out_path,
                playlist.resolution,
                playlist.fps,
            )
            if res.success and res.output_path:
                song.pre_rendered_clip = res.output_path.relative_to(BASE_PATH).as_posix()
                save_playlist_model(playlist, PLAYLIST_FILE)
                log_task(f"✓ [{song.template}] {res.message}")
            else:
                log_task(f"✗ [{song.template}] {song.title}: {res.message}")

        with task_lock:
            tasks_state["progress_percent"] = 100
        log_task("🎉 特殊单曲渲染流程结束！")
    except Exception as e:
        log_task(f"特殊渲染异常: {e}")
    finally:
        with task_lock:
            tasks_state["is_downloading"] = False
            tasks_state["current_song"] = ""


class RenderSpecialRequest(BaseModel):
    index: Optional[int] = None


@app.post("/api/render_special")
def render_special_api(req: RenderSpecialRequest):
    """Trigger background rendering for special-template songs (e.g. wangye_ae)."""
    if tasks_state["is_downloading"]:
        return JSONResponse(status_code=400, content={"message": "当前已有后台任务在进行中"})
    t = threading.Thread(target=_worker_render_special, args=(req.index,), daemon=True)
    t.start()
    return {"status": "started", "message": "已在后台启动特殊单曲渲染"}


if __name__ == "__main__":
    print("=======================================================")
    print(" 🎵 音乐推荐视频制作工作台 (Web Studio)")
    print(" 本地服务已启动: http://localhost:8000")
    print("=======================================================")
    uvicorn.run(app, host="127.0.0.1", port=8000, log_level="warning")
