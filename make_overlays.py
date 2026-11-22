import os
import json
from PIL import Image, ImageDraw, ImageFont

W, H = 1920, 1080
BAR_H = 220
BAR_Y = H - BAR_H

out_dir = r"D:\prworks\music-rec-video\overlays"
os.makedirs(out_dir, exist_ok=True)

playlist_path = r"D:\prworks\music-rec-video\playlist.json"
with open(playlist_path, "r", encoding="utf-8") as f:
    data = json.load(f)

songs = data.get("songs", [])

# Fonts
font_bold = ImageFont.truetype("C:/Windows/Fonts/msyhbd.ttc", 36)
font_title_small = ImageFont.truetype("C:/Windows/Fonts/msyhbd.ttc", 28)
font_regular = ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", 24)
font_small = ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", 20)
font_tag = ImageFont.truetype("C:/Windows/Fonts/msyhbd.ttc", 16)

for idx, song in enumerate(songs, 1):
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # 1. Frosted-glass dark gradient bottom bar (soft, elegant vignette)
    for y in range(BAR_Y, H):
        ratio = (y - BAR_Y) / BAR_H
        alpha = int(140 + ratio * 80)  # 140 -> 220
        draw.line([(0, y), (W, y)], fill=(10, 12, 18, alpha))

    # Top highlight line
    draw.line([(0, BAR_Y), (W, BAR_Y)], fill=(255, 255, 255, 75), width=2)
    draw.line([(0, BAR_Y + 2), (W, BAR_Y + 2)], fill=(255, 255, 255, 25), width=1)

    # Left Section: Track Pill + Title + Artist
    left_x = 90
    content_y = BAR_Y + 45

    # Index Pill Badge
    tag_text = f"{idx:02d} / {len(songs):02d}"
    pill_w = 84
    pill_h = 30
    draw.rounded_rectangle([left_x, content_y, left_x + pill_w, content_y + pill_h], radius=15, fill=(255, 255, 255, 38))
    draw.text((left_x + 14, content_y + 4), tag_text, font=font_tag, fill=(255, 255, 255, 230))

    # Title
    title = song.get("title", "")
    title_x = left_x + pill_w + 20
    t_font = font_bold
    if len(title) > 36:
        t_font = font_title_small
    if len(title) > 52:
        title = title[:50] + "..."
    draw.text((title_x, content_y - 4), title, font=t_font, fill=(255, 255, 255, 255))

    # Artist & Album
    artist = song.get("artist", "")
    album = song.get("album", "")
    sub_text = artist
    if album and album != title:
        sub_text += f"   |   《{album}》"
    draw.text((left_x + 4, content_y + 54), sub_text, font=font_regular, fill=(205, 212, 222, 225))

    # Right Section: Recommendation Reason Card
    reason = song.get("reason", "")
    if reason:
        card_w = 480
        card_r = W - 90
        card_l = card_r - card_w
        card_t = BAR_Y + 36
        card_b = BAR_Y + BAR_H - 36

        # Translucent glass card
        draw.rounded_rectangle([card_l, card_t, card_r, card_b], radius=14, fill=(255, 255, 255, 20), outline=(255, 255, 255, 45), width=1)

        # Header tag
        draw.text((card_l + 20, card_t + 16), "RECOMMENDED", font=font_tag, fill=(250, 204, 21, 230))

        # Reason text
        r_text = reason
        if len(r_text) > 28:
            r_text = r_text[:26] + "..."
        draw.text((card_l + 20, card_t + 52), f"“{r_text}”", font=font_small, fill=(245, 248, 250, 240))

    out_file = os.path.join(out_dir, f"card_{idx:02d}.png")
    img.save(out_file, "PNG")
    print(f"Generated: {out_file}")

print("All 8 overlay cards generated successfully.")
