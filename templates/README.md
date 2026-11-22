# 模板目录规范 (`templates/`)

本目录存放可独立替换的 Pr `.mogrt` 与 AE `.aep` 模板，与主流水线完全解耦。

## 1. 年度歌单主模板（路线 A，Pr 原生）
* `annual.mogrt`：单曲包装模板（左上 `#序号` + 左下 1:1 封面/歌名/歌手 + 右上无底板投影推荐语）。
* `intro.mogrt`：可选开场白模板（黑底/虚化底 + 居中衬线体文本）。

## 2. 特殊单曲模板（可插拔 AE 渲染器）
以 `wangye_ae` 为例，每个特殊模板独占一个子目录 `templates/<template_name>/`：
* `template.aep`：AE 母版工程，主合成固定命名为 `MAIN_COMP`。
  * 约定替换占位图层/素材名：`TITLE_TEXT`、`ARTIST_TEXT`、`COVER_IMG`、`BG_MEDIA`、`AUDIO_TRACK`。
* `prepare.jsx`：读取 `WANGYE_JOB_FILE`（JSON），替换上述图层/素材并另存为临时 `.aep` 供 `aerender.exe` 无头渲染。

> 如需替换或新增其他特殊模板，只需在 `templates/<new_name>/` 放入新工程，并在 `renderers/` 注册对应适配器即可，无需改动 Web 控制台或 Pr 主组装脚本。
