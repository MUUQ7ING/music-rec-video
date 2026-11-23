# 音乐推荐视频生成器 (`music-rec-video`)

完整工作流：**解析网易云歌单** → **Web 可视化挑选候选 (B站 + YouTube) 与拖拽排序** → **下载 1080p 素材 & 预处理 (1:1 封面 / -14 LUFS)** → **Premiere Pro `.mogrt` 模板 / 可插拔 AE 渲染器自动包装**

---

## 📂 项目结构

```text
music-rec-video/
├── server.py               ← 🌐 可视化工作台服务端 (FastAPI，聚合搜索 / 下载 / 预处理 / 渲染接口)
├── web/
│   └── index.html          ← 🖥️ 可视化交互前端 (Vue 3 + Tailwind，双平台切换、拖拽排序、入出点编辑)
├── schema.py               ← 📐 统一歌单数据模型 (Pydantic 校验 playlist.json)
├── netease.py              ← 🎵 网易云音乐歌单解析 & 官方 1:1 专辑封面抓取
├── bilibili.py             ← 📺 哔哩哔哩开放接口解析模块 (免登录原生 Wbi 签名)
├── download.py             ← ⬇️ 1080p 视频素材下载引擎 (yt-dlp + FFmpeg，支持 B站 & YouTube)
├── preprocess.py           ← 🎛️ 素材预处理 (1:1 封面裁剪 + -14 LUFS 音频响度归一化)
├── renderers/              ← 🧩 可插拔特殊单曲渲染器框架 (与主流水线解耦)
│   ├── base.py             ←    渲染器抽象基类 (ClipRenderer)
│   └── wangye_ae.py        ←    After Effects 无头渲染适配器 (aerender)
├── templates/              ← 🎨 Pr (.mogrt) 与 AE (.aep) 模板目录
│   ├── README.md           ←    模板命名与占位图层规范
│   └── annual.mogrt        ←    年度歌单主包装模板 (Pr 原生 MOGRT)
├── scripts/
│   └── test_mogrt.jsx      ← 🧪 Premiere Pro 2025 MOGRT 模板探测与参数注入测试脚本
├── assemble.jsx            ← 🎬 Premiere Pro 时间线自动化组装脚本
├── playlist.example.json   ← 📋 歌单配置示例
├── playlist.json           ← 🎯 当前歌单配置文件
└── requirements.txt        ← 📦 Python 依赖清单
```

---

## 🚀 安装与启动

### 1. 安装依赖

确保已安装 Python 3.10+ 与 `FFmpeg`，然后安装 Python 依赖：

```powershell
cd D:\prworks\music-rec-video
pip install -r requirements.txt
```

### 2. 启动可视化工作台

```powershell
python server.py
```

在浏览器打开：👉 **[http://localhost:8000](http://localhost:8000)**

---

## ✨ 核心特性

1. **哔哩哔哩 (B站) + YouTube 双平台聚合检索**
   - 每首歌曲支持在 `[ 全部 ]`、`[ 📺 B站 ]`、`[ 🔴 YouTube ]` 间切换候选；
   - 原生实现 B站免登录 Wbi 签名算法，轻松选用 4K 修复版、官方 Live 现场或无损重制版。
2. **可视化编排与拖拽排序**
   - 在 Web 工作台中直接导入网易云歌单、拖拽调整歌曲顺序、修改入出点（`start` / `end`）、编辑推荐语，并自动持久化至 [playlist.json](file:///d:/prworks/music-rec-video/playlist.json)。
3. **高清下载与标准化预处理**
   - 底层由 `yt-dlp` 与 `FFmpeg` 驱动，自动下载 1080p 高清画质并混流封装为标准 MP4（存放于 `raw/`）；
   - [preprocess.py](file:///d:/prworks/music-rec-video/preprocess.py) 自动拉取网易云官方 1:1 专辑封面并执行 **-14 LUFS** 响度归一化，保证各首歌曲音量平滑一致。
4. **模板解耦：Pr 原生 `.mogrt` + 可插拔 AE 渲染器**
   - **主模板（Pr 原生）**：通过 `templates/annual.mogrt` 在 Premiere Pro 中实现原生可编辑包装（序号、1:1 封面、歌名/歌手、推荐语）；
   - **特殊单曲模板（可插拔）**：可在 `renderers/` 中扩展独立渲染器（如 `wangye_ae` 调用 `AfterFX.exe` / `aerender.exe` 无头渲染音频响应 HUD），无需改动 Web 端或 Pr 主流程。详见 [templates/README.md](file:///d:/prworks/music-rec-video/templates/README.md)。

---

## 🎬 Premiere Pro 脚本使用

### 1. 测试 MOGRT 模板参数注入（Pr 2025）
在 Premiere Pro 中打开项目与目标序列，通过 ExtendScript Debugger / CEP Bridge 或菜单运行 [scripts/test_mogrt.jsx](file:///d:/prworks/music-rec-video/scripts/test_mogrt.jsx)，脚本会自动探测 `templates/annual.mogrt` 并在 `scripts/mogrt_probe_report.txt` 输出可用参数清单。

### 2. 运行时间线组装脚本
素材下载与预处理完成后，在 Premiere Pro 中通过 **文件 (File) → 脚本 (Scripts) → 运行脚本... (Run Script...)** 或 ExtendScript Debugger 运行 [assemble.jsx](file:///d:/prworks/music-rec-video/assemble.jsx)。
