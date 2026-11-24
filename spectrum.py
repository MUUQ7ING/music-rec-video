"""spectrum.py — High-speed frosted-glass audio spectrum visualizer for Premiere Pro V5 overlay.

Samples the song's own 1:1 album cover (covers/*.png), applies optical Gaussian blur +
subtle frosted-glass sheen + crisp glass rim highlights, and renders 20 reactive frosted-glass
bars into a 186x68 RGBA QuickTime (.mov, PNG codec with true Alpha channel).
Because each bar refracts the exact blurred colors of the album cover behind it,
it blends naturally with any cover palette (bright white, dark, or vivid).
"""

from __future__ import annotations

import math
import subprocess
from pathlib import Path
from typing import Callable

import numpy as np
from PIL import Image, ImageFilter

from download import slug
from preprocess import find_ffmpeg, parse_time_str
from schema import SongItem, load_playlist, save_playlist

COVER_DISPLAY_SIZE = 186
SPEC_W = 186
SPEC_H = 68
NUM_BARS = 20
BAR_W = 5
SAMPLE_RATE = 22050
FFT_SIZE = 2048


def build_frosted_cover_texture(song: SongItem, project_root: Path) -> np.ndarray:
    """Create a 186x68 frosted-glass texture by blurring the bottom strip of the song's cover."""
    cover_img: Image.Image | None = None
    if song.cover_path:
        cp = Path(song.cover_path)
        if not cp.is_absolute():
            cp = project_root / cp
        if cp.is_file():
            try:
                cover_img = Image.open(cp).convert("RGB")
            except Exception:
                cover_img = None

    if cover_img is None:
        # Neutral frosted gray fallback when no cover exists
        base = np.full((SPEC_H, SPEC_W, 3), 210, dtype=np.float32)
    else:
        resized = cover_img.resize((COVER_DISPLAY_SIZE, COVER_DISPLAY_SIZE), Image.Resampling.LANCZOS)
        # Optical Gaussian blur across the cover before cropping bottom strip (avoids edge darkening)
        blurred = resized.filter(ImageFilter.GaussianBlur(radius=7))
        # Bottom strip aligned with cover bottom (Y = 186 - 68 - 2 .. 186 - 2)
        y_end = COVER_DISPLAY_SIZE - 2
        y_start = max(0, y_end - SPEC_H)
        strip = blurred.crop((0, y_start, SPEC_W, y_end))
        if strip.size != (SPEC_W, SPEC_H):
            strip = strip.resize((SPEC_W, SPEC_H), Image.Resampling.LANCZOS)
        base = np.asarray(strip, dtype=np.float32)

    # Frosted-glass optical lift: subtle translucent milky sheen (22% white blend)
    # with a gentle vertical highlight gradient (brighter at top, softer near bottom)
    grad = np.linspace(0.32, 0.16, SPEC_H, dtype=np.float32)[:, None, None]
    frosted = base * (1.0 - grad) + 255.0 * grad
    return np.clip(frosted, 0, 255).astype(np.uint8)


def extract_mono_pcm(
    ffmpeg: str,
    media_path: Path,
    start_sec: float,
    duration_sec: float,
) -> np.ndarray:
    """Decode audio slice [start_sec, start_sec + duration_sec] as float32 mono PCM."""
    cmd = [
        ffmpeg,
        "-y",
        "-ss",
        f"{start_sec:.3f}",
        "-t",
        f"{duration_sec:.3f}",
        "-i",
        str(media_path),
        "-vn",
        "-ac",
        "1",
        "-ar",
        str(SAMPLE_RATE),
        "-f",
        "f32le",
        "pipe:1",
    ]
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=False)
    if proc.returncode != 0 or not proc.stdout:
        return np.zeros(int(duration_sec * SAMPLE_RATE), dtype=np.float32)
    return np.frombuffer(proc.stdout, dtype=np.float32)


def compute_bar_heights(samples: np.ndarray, num_frames: int, fps: int = 30) -> np.ndarray:
    """Compute smoothed logarithmic frequency bar heights in [0.0, 1.0] for each frame."""
    freqs = np.fft.rfftfreq(FFT_SIZE, d=1.0 / SAMPLE_RATE)
    band_edges = np.geomspace(45.0, 13500.0, NUM_BARS + 1)
    band_bins: list[tuple[int, int]] = []
    n_bins = len(freqs)
    for b in range(NUM_BARS):
        lo = int(np.searchsorted(freqs, band_edges[b]))
        hi = int(np.searchsorted(freqs, band_edges[b + 1]))
        lo = max(1, min(lo, n_bins - 1))
        hi = max(lo + 1, min(hi, n_bins))
        band_bins.append((lo, hi))

    window = np.hanning(FFT_SIZE).astype(np.float32)
    hop = SAMPLE_RATE / float(fps)
    raw_bars = np.zeros((num_frames, NUM_BARS), dtype=np.float32)

    total_samples = len(samples)
    for f in range(num_frames):
        center = int(f * hop)
        start = center - FFT_SIZE // 2
        if start < 0:
            chunk = np.zeros(FFT_SIZE, dtype=np.float32)
            valid = min(total_samples, FFT_SIZE + start)
            if valid > 0:
                chunk[-start : -start + valid] = samples[:valid]
        elif start + FFT_SIZE > total_samples:
            chunk = np.zeros(FFT_SIZE, dtype=np.float32)
            valid = max(0, total_samples - start)
            if valid > 0:
                chunk[:valid] = samples[start : start + valid]
        else:
            chunk = samples[start : start + FFT_SIZE]

        mag = np.abs(np.fft.rfft(chunk * window))
        for b, (lo, hi) in enumerate(band_bins):
            raw_bars[f, b] = float(np.mean(mag[lo:hi]))

    raw_bars = np.nan_to_num(raw_bars, nan=0.0, posinf=0.0, neginf=0.0)
    log_bars = np.log1p(raw_bars * 2.2)
    tilt = np.linspace(0.85, 1.35, NUM_BARS, dtype=np.float32)
    log_bars *= tilt

    ref = float(np.percentile(log_bars, 97)) if log_bars.size > 0 else 1.0
    if ref < 1e-5:
        ref = 1.0
    norm_bars = np.clip(log_bars / (ref * 1.15), 0.0, 1.0)

    if NUM_BARS >= 3:
        padded = np.pad(norm_bars, ((0, 0), (1, 1)), mode="edge")
        norm_bars = 0.2 * padded[:, :-2] + 0.6 * padded[:, 1:-1] + 0.2 * padded[:, 2:]

    # Frame-rate-independent temporal attack/decay damping (snappy rise, silky fall at 30/60fps)
    dt = 30.0 / max(1.0, float(fps))
    attack_keep = 0.42 ** dt
    decay_keep = 0.78 ** dt
    smoothed = np.zeros_like(norm_bars)
    prev = np.zeros(NUM_BARS, dtype=np.float32)
    for f in range(num_frames):
        cur = norm_bars[f]
        rising = cur > prev
        prev = np.where(
            rising,
            prev * attack_keep + cur * (1.0 - attack_keep),
            prev * decay_keep + cur * (1.0 - decay_keep),
        )
        smoothed[f] = prev

    return smoothed


def render_spectrum_mov(
    song: SongItem,
    project_root: Path,
    fps: int = 60,
    log: Callable[[str], None] | None = None,
) -> Path | None:
    """Render a transparent 186x68 frosted-glass RGBA .mov audio spectrum overlay for a song."""
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        if log:
            log("FFmpeg not found; cannot render spectrum.")
        return None

    src_rel = song.normalized_path or song.file_path
    if not src_rel:
        return None
    src_path = Path(src_rel)
    if not src_path.is_absolute():
        src_path = project_root / src_path
    if not src_path.is_file():
        return None

    start_sec = parse_time_str(song.start)
    end_sec = parse_time_str(song.end)
    dur_sec = max(1.0, end_sec - start_sec)
    # Add 15 extra tail frames so Pr never hits EOF frame-substitution recursion on float rounding
    core_frames = max(1, int(math.ceil(dur_sec * fps)))
    num_frames = core_frames + 15

    out_dir = project_root / "processed"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_name = f"{slug(song.title, song.artist)}_spectrum.mov"
    out_path = out_dir / out_name

    # Precompute frosted-glass blurred texture from the song's album cover
    frosted_rgb = build_frosted_cover_texture(song, project_root)
    samples = extract_mono_pcm(ffmpeg, src_path, start_sec, dur_sec + 0.5)
    bars = compute_bar_heights(samples, num_frames, fps=fps)

    # Evenly distribute 20 bars across 186px with 8px side margins
    xs = np.linspace(8, SPEC_W - 8 - BAR_W, NUM_BARS).astype(np.int32)

    # Apple ProRes 4444 with Alpha: native high-speed Premiere Pro mezzanine codec (zero frame-recursion stalls)
    cmd = [
        ffmpeg,
        "-y",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgba",
        "-s",
        f"{SPEC_W}x{SPEC_H}",
        "-r",
        str(fps),
        "-i",
        "pipe:0",
        "-c:v",
        "prores_ks",
        "-profile:v",
        "4444",
        "-vendor",
        "apl0",
        "-bits_per_mb",
        "4000",
        "-pix_fmt",
        "yuva444p10le",
        "-alpha_bits",
        "8",
        str(out_path),
    ]
    proc = subprocess.Popen(
        cmd,
        stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    assert proc.stdin is not None
    max_bar_h = SPEC_H - 8
    min_bar_h = 6

    for f in range(num_frames):
        frame = np.zeros((SPEC_H, SPEC_W, 4), dtype=np.uint8)
        heights = (min_bar_h + bars[f] * (max_bar_h - min_bar_h)).astype(np.int32)

        for b in range(NUM_BARS):
            x0 = int(xs[b])
            x1 = x0 + BAR_W
            bh = int(heights[b])
            y1 = SPEC_H - 4
            y0 = max(4, y1 - bh)

            # Subtle dark glass ambient shadow around bar (separates frosted glass from bright/white covers)
            sy0 = max(0, y0 - 1)
            sy1 = min(SPEC_H, y1 + 2)
            sx0 = max(0, x0 - 1)
            sx1 = min(SPEC_W, x1 + 2)
            frame[sy0:sy1, sx0:sx1, 0:3] = 0
            frame[sy0:sy1, sx0:sx1, 3] = 75

            # Frosted-glass body: refracted blurred cover colors at ~82% opacity
            frame[y0:y1, x0:x1, 0:3] = frosted_rgb[y0:y1, x0:x1]
            frame[y0:y1, x0:x1, 3] = 212

            # Delicate 1px specular glass rim along top & left edges
            frame[y0, x0:x1, 0:3] = np.clip(frosted_rgb[y0, x0:x1].astype(np.int32) + 65, 0, 255).astype(np.uint8)
            frame[y0, x0:x1, 3] = 225
            frame[y0:y1, x0, 0:3] = np.clip(frosted_rgb[y0:y1, x0].astype(np.int32) + 40, 0, 255).astype(np.uint8)

            # Soften top 2 corner pixels for pill-like glass tip
            if y1 - y0 >= 3:
                frame[y0, x0, 3] = 110
                frame[y0, x1 - 1, 3] = 110

        proc.stdin.write(frame.tobytes())

    proc.stdin.close()
    proc.wait()

    if proc.returncode == 0 and out_path.is_file():
        rel = out_path.relative_to(project_root).as_posix()
        song.spectrum_path = rel
        if log:
            log(f"Rendered frosted spectrum: {rel} ({num_frames} frames)")
        return out_path
    return None


def main():
    project_root = Path(__file__).resolve().parent
    playlist_path = project_root / "playlist.json"
    playlist = load_playlist(playlist_path)

    for idx, song in enumerate(playlist.songs, 1):
        print(f"[{idx}/{len(playlist.songs)}] Rendering frosted-glass spectrum for {song.artist} - {song.title} ...")
        res = render_spectrum_mov(song, project_root, fps=playlist.fps, log=print)
        if not res:
            print(f"  [WARN] Skipped {song.title}")

    save_playlist(playlist, playlist_path)
    print("All frosted-glass audio spectrum overlays generated and saved to playlist.json.")


if __name__ == "__main__":
    main()
