# Windows 端任务交接文档 (`HANDOFF_WIN.md`)

> 本文件用于将 Mac 端已完成的架构搭建、Web 控制台升级与预处理模块，无缝交接给 Windows 端（`D:\prworks\music-rec-video`）的 Antigravity 继续推进 **Premiere Pro 2025 / After Effects 实测与模板出片**。

---

## 1. 已敲定的核心技术路线与用户偏好（请严格遵循）

1. **运行主环境**：Windows 11 + **Adobe Premiere Pro 2025 (`25.0.0.61`)** + **Adobe After Effects** + Python 3.10+ + FFmpeg。
2. **文案来源**：**用户自己手写文案，不需要 AI 生成文案**。
3. **年度歌单主模板（`annual`）—— 路线 A（Pr 原生 `.mogrt` + ExtendScript 批量填充）**：
   - 视觉参考 B 站 `BV1xr421u7HP`（已分析片头与中段）：
     - **底部毛玻璃栏**：接近全宽、占底部约 **15% 高度**（`V2` 调整图层高斯模糊 + **30%~40% 暗色半透明压暗**，解决纯白/高曝光 MV 底色导致白字看不清的问题）。
     - **左下区**：`1:1` 官方专辑封面（来自网易云音乐）+ 歌名（大号白色衬线体）+ 歌手（小号白色衬线体）。
     - **左上角**：`#序号` 大号白色衬线体 + 投影。
     - **右上角**：**无底板**、右对齐白色衬线体推荐语 + 较强暗色投影（或顶部微弱暗化渐变，保证白底 MV 可读性）。
4. **可选开场白（`intro`）**：支持开关、自定义时长、背景模式（纯黑底 / 首曲虚化 / 自定义图片）与用户手写文本，位于首曲之前。
5. **特殊单曲模板（`wangye_ae`，参考 `BV1SihXz4EJA`）—— 必须完全独立可插拔**：
   - 通过独立适配器 `renderers/wangye_ae.py` + `templates/wangye_ae/` 调用 `AfterFX.exe` / `aerender.exe` 预先渲染成 `.mp4`。
   - 主组装脚本不写死任何 `"wangye_ae"` 逻辑，只判断 `song.pre_rendered_clip` 是否存在；若存在则直接插入 `V1`，跳过 `V2/V3` 包装。方便后续随时替换成其他 AE 模板。
6. **操作入口**：继续围绕本地 **Web 控制台**（`server.py` + `web/index.html`）开展交互。

---

## 2. Mac 端已完成的工作（均已推送至 `origin/main`）

| 文件 / 目录 | 作用与当前状态 |
| :--- | :--- |
| `schema.py` | 统一 Pydantic v2 数据模型：`PlaylistConfig`、`IntroConfig`、`SongItem`（含 `template`、`cover_url`、`cover_path`、`normalized_path`、`pre_rendered_clip`），向后兼容旧版 `playlist.json`。 |
| `netease.py` | 新增 `search_netease_cover_url()` 与 `fetch_song_cover_url()`；实测现有 8 首歌 **8/8 精准命中网易云官方 1:1 专辑封面**；导入歌单时也会自动带上 `cover_url`。 |
| `preprocess.py` | 1）从网易云拉取官方封面并规范为 `600×600` 1:1 PNG（存至 `covers/`）；2）用 FFmpeg 对 MV 做 `-c:v copy`（画面无损直通）+ EBU R128 **`-14 LUFS` / 48kHz** 响度统一（输出至 `processed/*_norm.mp4`）。 |
| `renderers/` | 可插拔渲染器层：`base.py`（`ClipRenderer` 抽象类）、`__init__.py`（注册表与 `render_song_clip`）、`wangye_ae.py`（Windows `aerender.exe` / `AfterFX.exe` 独立适配器）。 |
| `server.py` & `web/index.html` | 接入 `schema.py` 与 `renderers/`；新增 `/api/renderers`、`/api/preprocess`、`/api/render_special`、`/covers` 静态服务；前端已支持 **开场白编辑、单曲模板切换、1:1 封面预览、预处理与特殊渲染触发、以及拖拽式歌单排序弹窗**（用户已验收满意）。 |
| `templates/README.md` | 约定了 `annual.mogrt`、`intro.mogrt` 及 `templates/<name>/`（`template.aep` + `prepare.jsx`）的接口契约。 |
| `scripts/test_mogrt.jsx` | Pr 2025 路线 A 最小 `.mogrt` API 实测脚本（含全局 `try/catch`、自动搜索本机 `.mogrt`、输出 `scripts/mogrt_probe_report.txt`）。 |

---

## 3. Windows 端接手后的待办清单（按优先级）

### Step 0：环境同步与自检
1. 在 `D:\prworks\music-rec-video` 执行 `git pull origin main`。
2. 确认 Python 环境依赖（`pip install -r requirements.txt`）与 `ffmpeg` 可用。
3. 启动 `python server.py` 访问 `http://localhost:8000`，点击一次 **`预处理 (封面+响度)`** 生成本地 `covers/` 与 `processed/*_norm.mp4`。

### Step 1（最高优先级）：实测 Windows Pr 2025 `.mogrt` API
* 通过 **VS Code ExtendScript Debugger** 或 **CEP MCP Bridge** 在 Premiere Pro 2025 中运行 `scripts/test_mogrt.jsx`。
* 查看生成的 `scripts/mogrt_probe_report.txt`，重点确认两件事：
  1. `seq.importMGT(...)` 导入 `.mogrt` 到 `V3` 是否稳定；
  2. `getMGTComponent().properties` 中：
     - `textEditValue`（JSON 字符串）写入中文与换行是否正常；
     - **封面图媒体替换（`setMediaFilePath`）**在 Pr 2025 脚本层是否可用；如果不可用，直接采用「`.mogrt` 负责原生可调文字 + 脚本在独立图像轨同步对齐 `covers/*.png`」的方案。

### Step 2：制作主模板 `.mogrt` 与新版组装脚本 `scripts/assemble_v2.jsx`
1. 制作并放入 `templates/annual.mogrt`（与可选 `templates/intro.mogrt`）。
2. 编写 `scripts/assemble_v2.jsx`（替代旧版 `assemble.jsx` / `auto_assemble.jsx`）：
   - 读取 `playlist.json`；
   - 若 `intro.enabled === true`，在时间线最前端插入开场白段落；
   - 遍历 `songs`：
     - 若 `song.pre_rendered_clip` 存在且文件有效 → 直接将该 `.mp4` 插入 `V1/A1`，跳过 `V2/V3`；
     - 否则 → 优先使用 `song.normalized_path || song.file_path` 裁切入出点插入 `V1/A1`，在 `V2` 铺设毛玻璃压暗调整图层，在 `V3` 导入并填充 `annual.mogrt`（`#序号`、歌名、歌手、封面、右上角推荐语）。

### Step 3：Web 控制台闭环与 `wangye_ae` 模板制作
1. 在 `server.py` / `web/index.html` 增加「一键生成/触发 Pr 组装」入口（对接本地 CEP MCP Bridge）。
2. 在 Windows After Effects 中搭建 `templates/wangye_ae/template.aep`（主合成 `MAIN_COMP`，内置频谱/波形/粒子/音频振幅表达式，无需第三方付费插件）与 `prepare.jsx`，完成特殊单曲闭环测试。
