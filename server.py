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

from download import (
    download_mv,
    is_bilibili_url,
    slug,
    RAW_DIR,
    resolve_file_path,
    to_relative_path,
)
from netease import import_netease_playlist
from netease_audio import (
    download_netease_for_song,
    get_music_source_status,
    parse_lx_script_text,
    save_music_source_config,
)
from bilibili import (
    search_bilibili,
    generate_bilibili_qr,
    poll_bilibili_qr,
    get_bilibili_login_status,
    clear_bilibili_cookies,
)
from preprocess import preprocess_song
from spectrum import render_spectrum_mov
from lyrics import fetch_and_save_lyrics, export_timeline_srt
from analyze_visuals import analyze_song_visuals
from renderers import list_renderers, render_song_clip
from schema import load_playlist as load_playlist_model, save_playlist as save_playlist_model

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
BASE_PATH = Path(BASE_DIR)
PLAYLIST_FILE = os.path.join(BASE_DIR, "playlist.json")
BILI_COOKIES_FILE = os.path.join(BASE_DIR, "cookies.txt")
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
    try:
        export_timeline_srt(load_playlist_model(PLAYLIST_FILE), BASE_PATH)
    except Exception:
        pass


@app.get("/")
def serve_index():
    """Serve the frontend single-page application."""
    index_file = os.path.join(WEB_DIR, "index.html")
    if not os.path.isfile(index_file):
        raise HTTPException(status_code=404, detail="index.html not found")
    return FileResponse(index_file)


@app.get("/api/media/{index}")
def stream_song_media(index: int):
    """Stream local video file (normalized preferred) with Range support for precise web trimming."""
    data = load_playlist()
    songs = data.get("songs", [])
    if index < 0 or index >= len(songs):
        raise HTTPException(status_code=404, detail="Song index out of range")
    song = songs[index]
    for key in ("normalized_path", "file_path"):
        fp = resolve_file_path(song.get(key, ""))
        if fp and os.path.isfile(fp):
            return FileResponse(fp, media_type="video/mp4")
    raise HTTPException(status_code=404, detail="Local media file not found")


@app.get("/api/audio/{index}")
def download_song_audio_file(index: int):
    """Download or stream the saved pure NetEase audio file for a song."""
    data = load_playlist()
    songs = data.get("songs", [])
    if index < 0 or index >= len(songs):
        raise HTTPException(status_code=404, detail="Song index out of range")
    song = songs[index]
    ap = resolve_file_path(song.get("audio_path", ""))
    if ap and os.path.isfile(ap):
        return FileResponse(ap, filename=os.path.basename(ap))
    raise HTTPException(status_code=404, detail="Local audio file not found")


@app.post("/api/spectrum/{index}")
def rebuild_single_spectrum(index: int):
    """Re-render frosted-glass spectrum overlay for a single song after start/end trim changes."""
    playlist = load_playlist_model(PLAYLIST_FILE)
    if index < 0 or index >= len(playlist.songs):
        raise HTTPException(status_code=404, detail="Song index out of range")

    def _run():
        song = playlist.songs[index]
        log_task(f"🎨 重新生成频谱: {song.title} ({song.start} - {song.end})")
        res = render_spectrum_mov(song, BASE_PATH, fps=playlist.fps, log=log_task)
        if res:
            save_playlist_model(playlist, PLAYLIST_FILE)
            log_task(f"✅ 频谱更新完成: {song.title}")
        else:
            log_task(f"⚠️ 频谱更新失败: {song.title}")

    threading.Thread(target=_run, daemon=True).start()
    return {"status": "started"}


@app.get("/api/lyrics/{index}")
def get_song_lyrics(index: int):
    """Return parsed bilingual lyrics lines for the given song index."""
    playlist = load_playlist_model(PLAYLIST_FILE)
    if index < 0 or index >= len(playlist.songs):
        raise HTTPException(status_code=404, detail="Song index out of range")
    song = playlist.songs[index]
    lp = resolve_file_path(song.lyrics_path)
    if lp and os.path.isfile(lp):
        try:
            with open(lp, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {"lines": [], "has_translation": False}


@app.post("/api/lyrics/{index}")
def fetch_single_lyrics(index: int):
    """Fetch or refresh bilingual lyrics from NetEase for a single song."""
    playlist = load_playlist_model(PLAYLIST_FILE)
    if index < 0 or index >= len(playlist.songs):
        raise HTTPException(status_code=404, detail="Song index out of range")
    song = playlist.songs[index]
    out = fetch_and_save_lyrics(song, BASE_PATH, force=True, log=log_task)
    if out and out.is_file():
        save_playlist_model(playlist, PLAYLIST_FILE)
        return json.loads(out.read_text(encoding="utf-8"))
    return {"lines": [], "has_translation": False}


@app.post("/api/analyze_visuals")
def analyze_all_visuals_api():
    """Run batch lyrics fetch + 3-zone brightness analysis + static-MV beat curve extraction."""
    with task_lock:
        if tasks_state["is_downloading"]:
            raise HTTPException(status_code=409, detail="Another background task is already running")
        tasks_state["is_downloading"] = True
        tasks_state["current_song"] = "视觉分析 & 双语歌词"
        tasks_state["progress_percent"] = 0

    def _run():
        try:
            playlist = load_playlist_model(PLAYLIST_FILE)
            total = max(1, len(playlist.songs))
            for i, song in enumerate(playlist.songs):
                with task_lock:
                    tasks_state["current_song"] = f"分析 {song.title}"
                    tasks_state["progress_percent"] = int((i / total) * 100)
                fetch_and_save_lyrics(song, BASE_PATH, force=False, log=log_task)
                analyze_song_visuals(song, BASE_PATH, log=log_task)
            save_playlist_model(playlist, PLAYLIST_FILE)
            srt_path, cues = export_timeline_srt(playlist, BASE_PATH)
            log_task(f"✅ 视觉亮度、封面律动与双语歌词分析完成！(已导出 {cues} 句原生字幕 -> {srt_path.name})")
        except Exception as e:
            log_task(f"❌ 视觉分析异常: {e}")
        finally:
            with task_lock:
                tasks_state["is_downloading"] = False
                tasks_state["current_song"] = ""
                tasks_state["progress_percent"] = 100

    threading.Thread(target=_run, daemon=True).start()
    return {"status": "started"}


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
        lp = resolve_file_path(song.get("lyrics_path", ""))
        song["has_lyrics"] = bool(lp and os.path.isfile(lp))
        bp = resolve_file_path(song.get("beat_path", ""))
        song["has_beat"] = bool(bp and os.path.isfile(bp))
        ap = resolve_file_path(song.get("audio_path", ""))
        song["has_audio"] = bool(ap and os.path.isfile(ap))
        if song["has_audio"]:
            try:
                song["audio_size_mb"] = round(os.path.getsize(ap) / 1024 / 1024, 2)
            except Exception:
                song["audio_size_mb"] = 0
        else:
            song["audio_size_mb"] = 0
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
    """Parse NetEase Cloud Music playlist link, update playlist.json, and auto-run preprocessing."""
    try:
        count, name = import_netease_playlist(
            input_str=req.url,
            limit=req.limit,
            append=req.append,
            output_path=PLAYLIST_FILE,
        )
        # Automatically run background preprocessing (fetch 1:1 covers & normalize any existing videos)
        if not tasks_state["is_downloading"]:
            t = threading.Thread(target=_worker_preprocess, args=(False,), daemon=True)
            t.start()
        return {"status": "ok", "count": count, "playlist_name": name}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/api/bilibili/status")
def bilibili_login_status_api():
    """Return current Bilibili cookies.txt login & VIP status."""
    return get_bilibili_login_status(BILI_COOKIES_FILE)


@app.post("/api/bilibili/qr/generate")
def bilibili_qr_generate_api():
    """Generate a new Bilibili web QR login URL and qrcode_key."""
    try:
        return generate_bilibili_qr()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/bilibili/qr/poll")
def bilibili_qr_poll_api(qrcode_key: str = Query(..., description="Bilibili QR login key")):
    """Poll Bilibili QR login status and persist cookies.txt on success."""
    try:
        result = poll_bilibili_qr(qrcode_key, BILI_COOKIES_FILE)
        if result.get("status") == "success":
            u = result.get("user") or {}
            vip_tag = f" ({u.get('vip_label') or '大会员'})" if u.get("is_vip") else ""
            log_task(f"✅ B站扫码登录成功: {u.get('uname', '')}{vip_tag}，已保存 cookies.txt")
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/bilibili/logout")
def bilibili_logout_api():
    """Clear locally saved Bilibili cookies.txt."""
    clear_bilibili_cookies(BILI_COOKIES_FILE)
    log_task("已退出 B 站登录并删除本地 cookies.txt")
    return {"status": "ok"}


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


def _preprocess_after_download(index: int, refresh_norm: bool = True):
    """Ensure 1:1 cover and -14 LUFS loudness normalization are updated right after download."""
    playlist = load_playlist_model(PLAYLIST_FILE)
    if index < 0 or index >= len(playlist.songs):
        return
    song = playlist.songs[index]
    if refresh_norm:
        # Remove stale normalized video so loudness is re-computed from the newly downloaded file
        stale_norm = BASE_PATH / "processed" / f"{slug(song.title, song.artist)}_norm.mp4"
        if stale_norm.is_file():
            try:
                stale_norm.unlink()
            except OSError:
                pass
    preprocess_song(song, BASE_PATH, force=False, log_fn=log_task)
    save_playlist_model(playlist, PLAYLIST_FILE)


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
        success = download_mv(url, out_path, quality=quality, log_fn=log_task)
        if success:
            song["file_path"] = to_relative_path(out_path)
            save_playlist(data)
            log_task(f"✓ 下载成功: {title}")
            _preprocess_after_download(index, refresh_norm=True)
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

        bili_downloads = 0
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
                # Ensure cover & loudness normalization still exist for already-downloaded songs
                _preprocess_after_download(i, refresh_norm=False)
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

            # Throttle consecutive Bilibili downloads to avoid HTTP 412 risk control
            if is_bilibili_url(url) and bili_downloads > 0:
                log_task("[B站] 节流等待 2 秒以防风控...")
                time.sleep(2.0)

            log_task(f"下载 [{i+1}/{total}] {title}...")
            try:
                if download_mv(url, out_path, quality=quality, log_fn=log_task):
                    if is_bilibili_url(url):
                        bili_downloads += 1
                    song["file_path"] = to_relative_path(out_path)
                    save_playlist(data)
                    log_task(f"✓ 成功: {title}")
                    _preprocess_after_download(i, refresh_norm=True)
                else:
                    log_task(f"✗ 失败: {title}")
            except Exception as song_err:
                log_task(f"✗ 下载异常 ({title}): {song_err}")

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


class NeteaseAudioConfigRequest(BaseModel):
    api_url: Optional[str] = None
    api_key: Optional[str] = None
    default_quality: Optional[str] = None
    script_text: Optional[str] = None


@app.get("/api/netease_audio/config")
def get_netease_audio_config_api():
    """Return NetEase custom audio source status and non-sensitive config."""
    return get_music_source_status()


@app.post("/api/netease_audio/config")
def update_netease_audio_config_api(req: NeteaseAudioConfigRequest):
    """Update NetEase custom audio source config directly or by parsing an LX Music JS script."""
    api_url = req.api_url
    api_key = req.api_key
    if req.script_text and req.script_text.strip():
        parsed = parse_lx_script_text(req.script_text)
        if not parsed.get("api_url") and not parsed.get("api_key"):
            raise HTTPException(status_code=400, detail="未能从脚本文本中解析出 API_URL 或 API_KEY")
        api_url = parsed.get("api_url") or api_url
        api_key = parsed.get("api_key") or api_key

    save_music_source_config(
        api_url=api_url,
        api_key=api_key,
        default_quality=req.default_quality,
    )
    log_task("✅ 已更新网易云音源配置")
    return get_music_source_status()


class NeteaseAudioSingleRequest(BaseModel):
    index: int
    mode: str = "video"  # "audio" | "video"
    quality: Optional[str] = None
    force: bool = True


def _worker_netease_audio_single(index: int, mode: str, quality: Optional[str], force: bool):
    """Background worker to download NetEase audio (and optionally compose cover MP4) for one song."""
    with task_lock:
        tasks_state["is_downloading"] = True
        tasks_state["progress_percent"] = 10
    try:
        playlist = load_playlist_model(PLAYLIST_FILE)
        if index < 0 or index >= len(playlist.songs):
            log_task("无效的歌曲序号")
            return
        song = playlist.songs[index]
        mode_label = "封面合成 1080p MP4" if mode == "video" else "纯音频"
        with task_lock:
            tasks_state["current_song"] = f"网易云({mode_label}): {song.artist} - {song.title}"

        log_task(f"🎵 开始下载网易云音源 ({mode_label}): {song.artist} - {song.title}")
        res = download_netease_for_song(
            song=song,
            base_dir=BASE_PATH,
            mode=mode,
            quality=quality,
            force=force,
            width=playlist.resolution.width,
            height=playlist.resolution.height,
            fps=min(playlist.fps, 30),
            log_fn=log_task,
        )
        save_playlist_model(playlist, PLAYLIST_FILE)
        with task_lock:
            tasks_state["progress_percent"] = 80

        if mode == "video":
            _preprocess_after_download(index, refresh_norm=True)
            log_task(f"✅ 网易云音源 + 封面合成完成: {song.title} ({res['quality']})")
        else:
            log_task(f"✅ 网易云纯音频下载完成: {song.title} ({res['quality']} -> {res['audio_path']})")

        with task_lock:
            tasks_state["progress_percent"] = 100
    except Exception as e:
        log_task(f"❌ 网易云音源下载失败: {e}")
    finally:
        with task_lock:
            tasks_state["is_downloading"] = False
            tasks_state["current_song"] = ""


@app.post("/api/netease_audio/download_single")
def netease_audio_download_single_api(req: NeteaseAudioSingleRequest):
    """Trigger single-song NetEase audio download (pure audio or cover-composed 1080p MP4)."""
    if tasks_state["is_downloading"]:
        return JSONResponse(status_code=400, content={"message": "当前已有后台任务在进行中"})
    mode = "audio" if req.mode == "audio" else "video"
    t = threading.Thread(
        target=_worker_netease_audio_single,
        args=(req.index, mode, req.quality, req.force),
        daemon=True,
    )
    t.start()
    return {"status": "started", "message": "已在后台启动网易云音源下载"}


class NeteaseAudioBatchRequest(BaseModel):
    mode: str = "video"  # "audio" | "video"
    quality: Optional[str] = None
    force: bool = False
    missing_only: bool = False


def _worker_netease_audio_batch(mode: str, quality: Optional[str], force: bool, missing_only: bool):
    """Background worker for batch NetEase audio download / cover-video composition."""
    with task_lock:
        tasks_state["is_downloading"] = True
        tasks_state["progress_percent"] = 0
    try:
        playlist = load_playlist_model(PLAYLIST_FILE)
        total = max(1, len(playlist.songs))
        processed_requests = 0

        for i, song in enumerate(playlist.songs):
            with task_lock:
                tasks_state["current_song"] = f"网易云 [{i+1}/{len(playlist.songs)}] {song.title}"
                tasks_state["progress_percent"] = int((i / total) * 100)

            if missing_only:
                if mode == "video":
                    existing_video = resolve_file_path(song.file_path)
                    if existing_video and os.path.isfile(existing_video):
                        log_task(f"[跳过] 已有视频素材: {song.title}")
                        continue
                else:
                    existing_audio = resolve_file_path(song.audio_path)
                    if existing_audio and os.path.isfile(existing_audio):
                        log_task(f"[跳过] 已有纯音频: {song.title}")
                        continue

            # Throttle consecutive API calls to avoid HTTP 429 rate limiting
            if processed_requests > 0:
                time.sleep(1.5)

            try:
                res = download_netease_for_song(
                    song=song,
                    base_dir=BASE_PATH,
                    mode=mode,
                    quality=quality,
                    force=force,
                    width=playlist.resolution.width,
                    height=playlist.resolution.height,
                    fps=min(playlist.fps, 30),
                    log_fn=log_task,
                )
                processed_requests += 1
                save_playlist_model(playlist, PLAYLIST_FILE)
                if mode == "video":
                    _preprocess_after_download(i, refresh_norm=True)
                log_task(f"✓ [{i+1}/{len(playlist.songs)}] {song.title} ({res['quality']})")
            except Exception as song_err:
                processed_requests += 1
                log_task(f"✗ 网易云下载异常 ({song.title}): {song_err}")

        with task_lock:
            tasks_state["progress_percent"] = 100
        log_task("🎉 网易云音源批量任务完成！")
    except Exception as e:
        log_task(f"❌ 网易云批量任务中断: {e}")
    finally:
        with task_lock:
            tasks_state["is_downloading"] = False
            tasks_state["current_song"] = ""


@app.post("/api/netease_audio/download_all")
def netease_audio_download_all_api(req: NeteaseAudioBatchRequest):
    """Trigger batch NetEase audio download or cover-video composition."""
    if tasks_state["is_downloading"]:
        return JSONResponse(status_code=400, content={"message": "当前已有后台任务在进行中"})
    mode = "audio" if req.mode == "audio" else "video"
    t = threading.Thread(
        target=_worker_netease_audio_batch,
        args=(mode, req.quality, req.force, req.missing_only),
        daemon=True,
    )
    t.start()
    return {"status": "started", "message": "已在后台启动网易云批量下载"}


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
