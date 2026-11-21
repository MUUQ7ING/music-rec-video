# 音乐推荐视频生成器

完整工作流：**解析网易云歌单** → **Web 可视化挑选候选方案 (B站 + YouTube)** → **下载 1080p 高清素材** → **Premiere Pro 自动组装**

---

## 📂 项目结构

```
music-rec-video/
├── server.py       ← 🌐 可视化工作台服务端 (FastAPI, 包含 B站/YouTube 聚合搜索与下载)
├── bilibili.py     ← 📺 哔哩哔哩开放接口解析模块 (原生 Wbi 签名)
├── web/
│   └── index.html  ← 🖥️ 可视化交互前端 (Vue3 + Tailwind, 双平台候选切换)
├── netease.py      ← 🎵 解析网易云音乐歌单
├── playlist.json   ← 🎯 歌单配置文件
├── download.py     ← ⬇️ 1080p 视频素材下载引擎 (支持 B站 & YouTube)
└── assemble.jsx    ← 🎬 在 Premiere Pro 内一键组装时间线
```

---

## 🚀 启动与使用

### 1. 启动可视化工作台

在终端中运行：

```powershell
cd D:\prworks\music-rec-video
python server.py
```

在浏览器打开：👉 **[http://localhost:8000](http://localhost:8000)**

---

### ✨ 双平台多方案特色功能

1. **哔哩哔哩 (B站) + YouTube 聚合检索**：
   - 每首歌曲均提供平台切换标签：`[ 全部 ]`、`[ 📺 B站 ]`、`[ 🔴 YouTube ]`；
   - 华语歌曲在 B 站常有 UP 主自制的 **【4K修复版】**、**【官方现场Live】**、**【无损重制版】**，现在可以直接一键检索并选用！
2. **免登录原生 Wbi 解析**：
   - 实现了轻量级 B站 Wbi 签名算法，无需登录账号，自动抓取高清封面缩略图、UP主、视频时长及 BV 号。
3. **极速 1080p 混流下载**：
   - 底层由 `yt-dlp` 与 `FFmpeg` 联合驱动，无论是 B 站链接（`bilibili.com/video/BV...`）还是 YouTube 链接，均一键自动下载最高画质并混流封装为标准 MP4。
4. **Pr 参数所见即所得**：
   - 随手修改入出点时间（`start` / `end`）与毛玻璃推荐文案。

---

## 🎬 最后一键入 Pr 剪辑

素材下载完成后：
1. 打开 **Premiere Pro**；
2. 菜单点击 **文件 (File)** → **脚本 (Scripts)** → **运行脚本... (Run Script...)**；
3. 选择 [assemble.jsx](file:///d:/prworks/music-rec-video/assemble.jsx)。

全自动创建序列、裁剪视频 (V1)、生成毛玻璃底板 (V2)、压制推荐语文字 (V3) 及动态进度条 (V4)！
