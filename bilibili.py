"""
bilibili.py — Search and resolve Bilibili videos using official Wbi signing.
Zero heavy dependencies, pure requests + standard libraries.
"""

import hashlib
import re
import time
import urllib.parse
import requests

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Referer": "https://www.bilibili.com/",
}

MIXIN_KEY_ENC_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
    33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
    61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
    36, 20, 34, 44, 52
]


def _get_mixin_key(orig: str) -> str:
    """Generate mixin key for Wbi signing."""
    return "".join([orig[i] for i in MIXIN_KEY_ENC_TAB])[:32]


def _enc_wbi(params: dict, img_key: str, sub_key: str) -> dict:
    """Sign params with Wbi algorithm."""
    mixin_key = _get_mixin_key(img_key + sub_key)
    curr_time = round(time.time())
    params["wts"] = curr_time
    params = dict(sorted(params.items()))
    # Filter disallowed characters
    params = {
        k: "".join(filter(lambda chr: chr not in "!'()*", str(v)))
        for k, v in params.items()
    }
    query = urllib.parse.urlencode(params)
    wbi_sign = hashlib.md5((query + mixin_key).encode()).hexdigest()
    params["w_rid"] = wbi_sign
    return params


def search_bilibili(keyword: str, limit: int = 5) -> list[dict]:
    """
    Search Bilibili for video candidates.
    Returns list of dicts with: id, title, uploader, duration_str, url, thumbnail, platform ('bilibili')
    """
    session = requests.Session()
    # 1. Fetch nav to get Wbi keys
    try:
        nav_resp = session.get("https://api.bilibili.com/x/web-interface/nav", headers=HEADERS, timeout=8).json()
        wbi_img = nav_resp.get("data", {}).get("wbi_img", {})
        img_key = wbi_img.get("img_url", "").rsplit("/", 1)[1].split(".")[0]
        sub_key = wbi_img.get("sub_url", "").rsplit("/", 1)[1].split(".")[0]
        if not img_key or not sub_key:
            return []
    except Exception as e:
        print(f"[Bilibili] Failed to fetch nav keys: {e}")
        return []

    # 2. Get buvid cookies
    try:
        session.get("https://api.bilibili.com/x/frontend/finger/spi", headers=HEADERS, timeout=5)
    except Exception:
        pass

    # 3. Sign parameters and search
    params = {
        "keyword": keyword,
        "search_type": "video",
        "page_size": limit,
    }
    signed = _enc_wbi(params, img_key, sub_key)
    search_url = "https://api.bilibili.com/x/web-interface/wbi/search/type"

    candidates = []
    try:
        resp = session.get(search_url, params=signed, headers=HEADERS, timeout=10)
        data = resp.json()
        if data.get("code") != 0:
            print(f"[Bilibili] Search code {data.get('code')}: {data.get('message')}")
            return []

        results = data.get("data", {}).get("result", [])
        for item in results[:limit]:
            bvid = item.get("bvid") or ""
            # Strip XML/HTML highlight tags from title like <em class="keyword">...</em>
            raw_title = item.get("title", "")
            clean_title = re.sub(r"<[^>]+>", "", raw_title)

            author = item.get("author", "B站UP主")
            pic = item.get("pic", "")
            if pic and pic.startswith("//"):
                pic = "https:" + pic

            dur_str = item.get("duration", "0:00")
            url = f"https://www.bilibili.com/video/{bvid}"

            candidates.append({
                "id": bvid,
                "title": clean_title,
                "uploader": author,
                "duration_str": dur_str,
                "url": url,
                "thumbnail": pic,
                "platform": "bilibili"
            })
    except Exception as e:
        print(f"[Bilibili] Search failed: {e}")

    return candidates


if __name__ == "__main__":
    results = search_bilibili("周杰伦 夜曲 官方MV", limit=4)
    print(f"Found {len(results)} videos:")
    for r in results:
        print(f"[{r['id']}] {r['title']} - {r['uploader']} ({r['duration_str']})")
        print(f"  URL: {r['url']}")
        print(f"  Pic: {r['thumbnail']}")
