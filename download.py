"""
download.py — Phase 1: 下载 MV / 视频素材（最高高清画质 1080p+），自动写回 playlist.json

借鉴与整合了 video-downloader 项目的最高画质策略：
  - 自动调用 deno/ejs 求解 YouTube JS 校验，解锁完整 1080p/4K 码率与格式
  - 优先下载 H.264(AVC) + AAC 最佳轨并无损混流封装为标准 MP4，Premiere Pro 剪辑最流畅
  - 自动备选 VP9/AV1 + Opus 高清轨，由 FFmpeg 后台自动封装

用法：
    python download.py                                    # 下载未完成的歌曲
    python download.py --force                            # 强制重新下载（覆盖之前的低画质）
    python download.py --quality 1080                     # 指定画质（默认 1080，可选 720, 1080, best）
    python download.py --only "Our Love Is Alive"         # 针对指定单曲下载
    python download.py --netease "https://music.163.com/..." # 一键解析网易云并下载
"""

import argparse
import json
import os
import re
import sys
import yt_dlp
from netease import import_netease_playlist

PLAYLIST = os.path.join(os.path.dirname(__file__), "playlist.json")
RAW_DIR = os.path.join(os.path.dirname(__file__), "raw")
os.makedirs(RAW_DIR, exist_ok=True)


def slug(title: str, artist: str) -> str:
    """Generate safe filename slug from artist and title."""
    return re.sub(r"[^\w\-]", "_", f"{artist}_{title}")


def search_youtube(query: str) -> str | None:
    """Search YouTube and return the top matching video URL."""
    opts = {
        "quiet": True,
        "no_warnings": True,
        "extract_flat": True,
        "remote_components": ["ejs:github"],
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(f"ytsearch1:{query}", download=False)
        entries = info.get("entries", [])
        if entries:
            return entries[0].get("url") or entries[0].get("webpage_url")
    return None


def get_format_selector(quality: str = "1080") -> str:
    """
    Build yt-dlp format selector string.
    Prioritizes AVC(H.264)+AAC for best Premiere Pro compatibility,
    then falls back to any best video+audio.
    """
    if quality == "best":
        return (
            "bestvideo[vcodec^=avc]+bestaudio[acodec^=mp4a]/"
            "bestvideo+bestaudio/best"
        )
    elif quality == "720":
        return (
            "bestvideo[height<=720][vcodec^=avc]+bestaudio[acodec^=mp4a]/"
            "bestvideo[height<=720]+bestaudio/best[height<=720]/best"
        )
    else:  # default 1080
        return (
            "bestvideo[height<=1080][vcodec^=avc]+bestaudio[acodec^=mp4a]/"
            "bestvideo[height<=1080]+bestaudio/best[height<=1080]/best"
        )


def download_mv(url: str, out_path: str, quality: str = "1080") -> bool:
    """
    Download video with high quality (1080p) and merge into mp4 container.
    """
    fmt = get_format_selector(quality)
    opts = {
        "format": fmt,
        "outtmpl": out_path,
        "merge_output_format": "mp4",
        "remote_components": ["ejs:github"],
        "quiet": False,
        "retries": 3,
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        ydl.download([url])
    return os.path.isfile(out_path)


def main():
    parser = argparse.ArgumentParser(description="高清 MV 素材下载工具")
    parser.add_argument("--only", default="", help="只下载包含此歌名的歌曲")
    parser.add_argument("--netease", default="", help="网易云歌单链接，先解析再下载")
    parser.add_argument("--limit", type=int, default=10, help="网易云歌单歌曲数量上限")
    parser.add_argument("--quality", default="1080", choices=["720", "1080", "best"], help="视频画质 (默认 1080)")
    parser.add_argument("--force", action="store_true", help="强制重新下载（覆盖已有文件）")
    args = parser.parse_args()

    if args.netease:
        print(f"[网易云] 正在从链接解析歌单: {args.netease}")
        try:
            count, name = import_netease_playlist(args.netease, limit=args.limit, output_path=PLAYLIST)
            print(f"[网易云] 成功解析《{name}》，已导入 {count} 首歌曲。\n")
        except Exception as e:
            print(f"[ERROR] 解析网易云歌单失败: {e}")
            sys.exit(1)

    with open(PLAYLIST, encoding="utf-8") as f:
        data = json.load(f)

    changed = False
    for song in data["songs"]:
        title, artist = song["title"], song["artist"]
        if args.only and args.only.lower() not in title.lower():
            continue

        out_path = os.path.join(RAW_DIR, slug(title, artist) + ".mp4")

        # 如果已有文件且未指定 --force，跳过；若指定 --force 则删除旧文件重新下载
        if song.get("file_path") and os.path.isfile(song["file_path"]):
            if not args.force:
                print(f"[SKIP] 已存在: {title} (使用 --force 可重新以 1080p 高清覆盖)")
                continue
            else:
                try:
                    os.remove(song["file_path"])
                except Exception:
                    pass

        url = song.get("youtube_url") or ""
        if not url:
            # 搜索时使用精炼关键词，避免长标题影响匹配
            clean_title = title.split("(")[0].split("（")[0].strip()[:40]
            query = f"{clean_title} {artist} official MV"
            print(f"[搜索] {query} ...")
            url = search_youtube(query)

        if not url:
            print(f"[WARN] 找不到: {title}，跳过")
            continue

        print(f"[下载高清 {args.quality}p] {title} → {out_path}")
        try:
            if download_mv(url, out_path, quality=args.quality):
                song["file_path"] = out_path
                changed = True
                print(f"[OK] {out_path}")
        except Exception as e:
            print(f"[ERROR] {title}: {e}")

    if changed:
        with open(PLAYLIST, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        print("\n[完成] playlist.json 已更新，可以在 Premiere Pro 中运行 assemble.jsx 了。")


if __name__ == "__main__":
    main()
