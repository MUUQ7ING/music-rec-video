# 音乐推荐视频生成器 (`music-rec-video`)

完整工作流：**解析网易云歌单** → **Web 可视化挑选候选 (B站 + YouTube)、拖拽排序与 0.1s 精准定剪** → **下载 1080p 素材 & 预处理 (1:1 封面 / -14 LUFS / 60fps 毛玻璃音频频谱)** → **Premiere Pro 2025 五轨自动装配 (悬浮透明毛玻璃 + AE `.mogrt` 原生可编辑模板)**

---

## 📂 项目结构

```text
music-rec-video/
├── server.py                       ← 🌐 可视化工作台服务端 (FastAPI，聚合搜索 / 流式定剪 / 下载 / 预处理 / 频谱更新)
├── web/
│   └── index.html                  ← 🖥️ 可视化前端 (Vue 3 + Tailwind，双平台切换、拖拽排序、✂️ 精准定剪弹窗)
├── schema.py                       ← 📐 统一歌单数据模型 (Pydantic 校验 playlist.json，默认 60fps)
├── netease.py                      ← 🎵 网易云音乐歌单解析 & 官方 1:1 专辑封面抓取
├── bilibili.py                     ← 📺 哔哩哔哩开放接口解析模块 (免登录原生 Wbi 签名)
├── download.py                     ← ⬇️ 1080p 视频素材下载引擎 (yt-dlp + FFmpeg，支持 B站 & YouTube)
├── preprocess.py                   ← 🎛️ 素材预处理 (1:1 封面裁剪 + -14 LUFS 响度归一化)
├── spectrum.py                     ← 🌊 60fps 封面取样真·毛玻璃音频频谱渲染器 (Apple ProRes 4444 带 Alpha)
├── renderers/                      ← 🧩 可插拔特殊单曲渲染器框架 (如 wangye_ae 无头 AE 渲染)
├── templates/                      ← 🎨 Pr / AE 模板目录
│   ├── README.md                   ←    模板命名与占位图层规范
│   ├── annual.mogrt                ←    年度歌单主模板 (AE 导出 60fps：单行跑马灯歌名 + 专辑/歌手 + 实时进度条)
│   ├── intro.mogrt                 ←    可选开场白模板
│   └── annual_master.aep           ←    可随时在 AE 二次微调的母版工程
├── scripts/
│   ├── build_annual_mogrt_ae.jsx   ← ✨ AE 一键生成并导出 annual.mogrt / intro.mogrt 脚本
│   ├── assemble_v2.jsx             ← 🎬 Pr 2025 五轨全自动组装脚本 (支持 MCP Bridge 静默调用)
│   └── test_mogrt.jsx              ← 🧪 Pr 2025 MOGRT 参数探测测试脚本
├── playlist.example.json           ← 📋 歌单配置示例
├── playlist.json                   ← 🎯 当前歌单配置文件
└── requirements.txt                ← 📦 Python 依赖清单
```

---

## 🚀 环境安装

确保已安装 **Windows 11 + Python 3.10+ + FFmpeg + Adobe Premiere Pro 2025 + Adobe After Effects 2025**，然后安装 Python 依赖：

```powershell
cd D:\prworks\music-rec-video
pip install -r requirements.txt
```

---

## 🛠️ 完整操作指南（从选歌到 60fps 出片）

### 第一步：在 Web 工作台选歌、排序与精准定剪

1. 启动本地服务端：
   ```powershell
   python server.py
   ```
2. 浏览器打开 **[http://localhost:8000](http://localhost:8000)**：
   * 点击 **导入网易云歌单**（支持覆盖或追加新歌）；
   * 为每首歌在 `[ 全部 ]` / `[ 📺 B站 ]` / `[ 🔴 YouTube ]` 中挑选画质最好的 MV 候选并点击 **下载**；
   * 点击 **预处理 (封面 + 响度)**，自动拉取网易云 1:1 官方专辑封面（`covers/`）并对全部 MV 做 `-14 LUFS` 响度统一（`processed/*_norm.mp4`）；
   * 点击每首歌卡片上的 **「✂️ 精准定剪试听」**，在内置播放器中用快捷键（`Space` 播放、`I` 设入点、`O` 设出点、`←/→` 步进 0.5s、`-0.1s/+0.1s` 微调）精确卡好高潮片段，勾选 **「保存后同步更新毛玻璃频谱」** 后保存；
   * 如需批量为全部曲目生成/刷新 60fps 毛玻璃音频频谱，可运行：
     ```powershell
     python spectrum.py
     ```

---

### 第二步：导出 AE `.mogrt` 母版（仅修改模板样式时才需执行）

> [!NOTE]
> **平时新增歌曲、换歌单、改排序、改文案或改入出点，均无需重新打开 AE！**  
> 只有当你修改了 `scripts/build_annual_mogrt_ae.jsx` 中的字号、坐标、跑马灯宽度或帧率时，才需要执行本步骤一次：

1. 首次使用前，在 After Effects 中开启脚本写入权限：  
   **`编辑 (Edit) → 首选项 (Preferences) → 脚本和表达式 (Scripting & Expressions)`** → 勾选 **「允许脚本写入文件和访问网络」**。
2. 在 After Effects 菜单点击 **`文件 → 脚本 → 运行脚本文件...`**，选择 [scripts/build_annual_mogrt_ae.jsx](file:///d:/prworks/music-rec-video/scripts/build_annual_mogrt_ae.jsx)（遇到思源宋体未从 Adobe Fonts 同步提示时点 **确定** 即可）。
3. 脚本会自动在 `templates/` 下生成 `annual.mogrt`、`intro.mogrt` 和可编辑母版 `annual_master.aep`。

---

### 第三步：在 Premiere Pro 2025 中一键组装时间线

* **方式 A（推荐，全自动零手动）**：在 Pr 菜单打开 **`窗口 → 扩展 → MCP Bridge`** 启动桥接面板，直接让 AI Agent 通过 `premiere_pro` MCP 远程静默执行 `scripts/assemble_v2.jsx`。
* **方式 B（手动运行）**：在 Pr 中通过 VS Code `ExtendScript Debugger` 或菜单 **`文件 → 脚本 → 运行脚本...`** 运行 [scripts/assemble_v2.jsx](file:///d:/prworks/music-rec-video/scripts/assemble_v2.jsx)。

**自动装配后的 6 轨动静分离结构（1920×1080 @ 60fps）：**
* **V1 / A1**：`-14 LUFS` 归一化 MV 原画与唯一干净音轨（小分辨率如 `640×480` 自动等比适配帧高）；
* **V2**：悬浮透明毛玻璃层（同源 MV 四边精确直角裁剪 `X=28..1892, Y=870..1056` + 中度高斯模糊 `32`，四边留缝透出清晰原画）；
* **V3**：AE 原生可编辑 `annual.mogrt`（30fps 极速动静分离版：左上 `#序号`、右上推荐语、封面右侧三行信息 + 超长单行跑马灯歌名；无进度条表达式，普通曲目淡入后全程静止自动命中 Pr 帧缓存）；
* **V4**：左下角 `186×186` 网易云 1:1 官方专辑封面（与毛玻璃条等高齐平）；
* **V5**：叠放在封面底部的 `186×68` 60fps 封面取样毛玻璃音频频谱（Apple ProRes 4444 带 Alpha）；
* **V6**：Pr 原生 GPU 60fps 实时进度条（`templates/progress_bar.png` + `裁剪 (右侧 100% → 0%)` 关键帧，100% 显卡实时插值零 CPU 负担）。

---

### 第四步：60fps 丝滑预览 & 极速导出技巧（重要）

因为 V3 是 AE 导出的 `.mogrt`（在 Pr 中走 CPU 渲染），在 60fps 序列下直接导出会明显拖慢速度。建议采用 Pr 官方专业提速流程：

1. **确认开启显卡 GPU 加速**：  
   菜单 **`文件 → 项目设置 → 常规 → 视频渲染和播放 → 渲染程序`** → 选择 **`Mercury Playback Engine GPU 加速 (CUDA)`**。
2. **预览时**：将节目监视器右下角回放分辨率调为 **`1/2`**（不影响最终导出画质）。
3. **定稿导出前做一次「渲染并替换」（强烈推荐，导出速度提升 10~30 倍）**：
   * 在时间线框选 **V3 轨道上的所有 `.mogrt` 片段** → 右键选择 **`渲染并替换 (Render and Replace)...`**；
   * 格式选择 **`QuickTime`**，预设选择 **`Apple ProRes 4444 with alpha`**，点确定；
   * Pr 会用官方原生编码器将其缓存为高速透明片段（零黑条、零崩溃），之后预览全程 60fps 丝滑，导出直接跑满 GPU；
   * 如果事后想改某首歌的文字，随时右键该片段点击 **`恢复未渲染 (Restore Unrendered)`** 即可一秒还原为可编辑 `.mogrt`！
4. **导出设置建议**：
   * 格式：`H.264`（1920×1080，60fps）；
   * 视频 → 编码设置 → 性能：**硬件编码 (Hardware Encoding)**；
   * 视频 → 更多 → 时间插值：保持默认 **`帧采样 (Frame Sampling)`**（切勿开启「光流法」，否则静态封面视频会被无意义插帧拖慢数倍）。
