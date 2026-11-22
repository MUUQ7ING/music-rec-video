/**
 * assemble.jsx  —  Premiere Pro ExtendScript 自动化脚本
 *
 * 功能：
 *   1. 读取同目录的 playlist.json
 *   2. 新建（或复用）序列
 *   3. 逐首歌曲：导入 MV → 裁剪入出点 → 放到 V1
 *   4. 每首歌上方添加：
 *        V2  毛玻璃底板（纯色 + 高斯模糊 + 透明度）
 *        V3  歌曲信息文字（标题 / 艺人 / 推荐语）
 *        V4  进度条（白色线条，Scale-X 关键帧动画）
 *
 * 运行方式：Premiere Pro → 文件 → 脚本 → 运行脚本... → 选择此文件
 *
 * 注意：脚本依赖 Premiere Pro 2019 或更新版本（ExtendScript API v14+）
 */

// ─────────────────────────────────────────────────────────────────────────────
// 配置
// ─────────────────────────────────────────────────────────────────────────────

var SCRIPT_DIR   = File($.fileName).parent.fsName;
var PLAYLIST_PATH = SCRIPT_DIR + "/playlist.json";

// 视频尺寸（需与 playlist.json 中一致）
var SEQ_W = 1920;
var SEQ_H = 1080;
var SEQ_FPS = 30;

// 毛玻璃面板参数
var PANEL_H_PX   = 270;           // 面板高度（像素）
var PANEL_Y_PCT  = (SEQ_H - PANEL_H_PX) / SEQ_H * 100;  // 面板顶部 Y（%）
var PROGRESS_H   = 6;             // 进度条高度（像素）

// 颜色与字体（按系统自动选择中文字体）
var COLOR_WHITE  = { red: 255, green: 255, blue: 255 };
var COLOR_BLACK  = { red:   0, green:   0, blue:   0 };
var IS_MAC       = $.os.toLowerCase().indexOf("mac") >= 0;
var DEFAULT_FONT = IS_MAC ? "PingFang SC" : "Microsoft YaHei";


// ─────────────────────────────────────────────────────────────────────────────
// 工具函数
// ─────────────────────────────────────────────────────────────────────────────

/** 解析 "MM:SS" 或秒数字符串 → 秒（浮点） */
function parseTime(t) {
    if (typeof t === "number") return t;
    t = String(t).replace(/^\s+|\s+$/g, "");
    var parts = t.split(":");
    if (parts.length === 2) {
        return parseInt(parts[0], 10) * 60 + parseFloat(parts[1]);
    } else if (parts.length === 3) {
        return parseInt(parts[0], 10) * 3600 + parseInt(parts[1], 10) * 60 + parseFloat(parts[2]);
    }
    return parseFloat(t);
}

/** 秒 → Premiere Pro Ticks（1秒 = 254016000000 ticks @ 30fps，但用 Time 对象更可靠） */
function secsToTime(secs) {
    var t = new Time();
    t.seconds = secs;
    return t;
}

/** 读取文件内容为字符串 */
function readFile(path) {
    var f = new File(path);
    if (!f.exists) { alert("找不到文件：" + path); return null; }
    f.encoding = "UTF-8";
    f.open("r");
    var content = f.read();
    f.close();
    return content;
}

/** 解析媒体路径：支持相对路径、当前系统绝对路径，以及跨平台历史绝对路径回退到 raw/ */
function resolveMediaPath(filePath) {
    if (!filePath) return "";
    var normalized = String(filePath).replace(/\\/g, "/");
    var isAbs = (normalized.charAt(0) === "/" || /^[A-Za-z]:\//.test(normalized));

    // 1. 相对路径（如 "raw/xxx.mp4"）：基于脚本所在目录解析
    if (!isAbs) {
        var relFile = new File(SCRIPT_DIR + "/" + normalized);
        if (relFile.exists) return relFile.fsName;
    }

    // 2. 当前系统绝对路径
    var directFile = new File(filePath);
    if (directFile.exists) return directFile.fsName;

    // 3. 跨平台历史绝对路径回退：按文件名在同目录 raw/ 下查找
    var parts = normalized.split("/");
    var fileName = parts[parts.length - 1];
    if (fileName) {
        var rawFile = new File(SCRIPT_DIR + "/raw/" + fileName);
        if (rawFile.exists) return rawFile.fsName;
    }
    return "";
}

/** 在项目 bin 中查找或创建文件夹 */
function getOrCreateBin(name) {
    var root = app.project.rootItem;
    for (var i = 0; i < root.children.numItems; i++) {
        if (root.children[i].name === name) return root.children[i];
    }
    return root.createBin(name);
}

/** 导入单个文件，返回 ProjectItem（已存在则直接返回） */
function importFile(filePath, bin) {
    // 检查是否已导入
    var allItems = app.project.rootItem;
    for (var i = 0; i < bin.children.numItems; i++) {
        if (bin.children[i].getMediaPath &&
            bin.children[i].getMediaPath() === filePath) {
            return bin.children[i];
        }
    }
    var arr = [filePath];
    app.project.importFiles(arr, true, bin, false);
    // 返回刚导入的 item（最后一个）
    return bin.children[bin.children.numItems - 1];
}

/** 在序列的指定 track 末尾追加一个 clip，设置入出点，返回 clip */
function appendClip(sequence, trackIndex, projectItem, inSecs, outSecs) {
    var vTrack = sequence.videoTracks[trackIndex];

    // 计算当前 track 的末尾时间
    var insertTime = new Time();
    insertTime.seconds = 0;
    if (vTrack.clips.numItems > 0) {
        var lastClip = vTrack.clips[vTrack.clips.numItems - 1];
        insertTime = lastClip.end;
    }

    // 设置入出点
    var inTime  = secsToTime(inSecs);
    var outTime = secsToTime(outSecs);

    vTrack.insertClip(projectItem, insertTime);
    var clip = vTrack.clips[vTrack.clips.numItems - 1];
    clip.inPoint  = inTime;
    clip.outPoint = outTime;
    return clip;
}


// ─────────────────────────────────────────────────────────────────────────────
// 毛玻璃面板（V2）
// 原理：纯色图层 → 高斯模糊（大半径）→ 透明度降低
// 在 Pr 中用 Fast Color Corrector 或 Gaussian Blur 效果叠加实现
// ─────────────────────────────────────────────────────────────────────────────

function addGlassPanel(sequence, startSecs, durationSecs, bin) {
    // 创建一个纯色合成 clip（Premiere Pro 用 color matte 实现）
    var colorMatteItem = app.project.createNewSequence
        ? null : null; // 纯色通过 clip.colorMatte 获得

    // Premiere Pro API 中创建纯色：
    var colorMatte = app.project.createNewCountdownLeader
        ? null : null;

    // 实际方式：用 newColorMatte
    // app.project.newColorMatte(size, color, name, bin)
    var size = { width: SEQ_W, height: PANEL_H_PX };
    var matteItem = app.project.newColorMatte(size, COLOR_WHITE, "GlassPanel_" + startSecs.toFixed(0), bin);

    if (!matteItem) {
        $.writeln("[WARN] 无法创建 Color Matte，跳过毛玻璃层");
        return null;
    }

    var vTrack = sequence.videoTracks[1]; // V2
    var insertTime = secsToTime(startSecs);

    vTrack.insertClip(matteItem, insertTime);
    var clip = vTrack.clips[vTrack.clips.numItems - 1];

    // 调整 clip 时长
    clip.outPoint = secsToTime(startSecs + durationSecs);

    // 位置：居中 X，底部 Y（Motion → Position）
    var posY = (SEQ_H - PANEL_H_PX / 2) / SEQ_H * 100; // %

    // 应用效果：高斯模糊 + 透明度
    // ── 高斯模糊 ──────────────────────────────────────────
    var effects = clip.components;
    // "Gaussian Blur" 在 Pr 中的显示名（英文版）
    clip.addVideoEffect(
        app.project.getEffectByName("Gaussian Blur") ||
        app.project.getEffectByName("Fast Blur")
    );

    // 透明度（Opacity）
    var opacity = clip.opacity;
    if (opacity) {
        opacity.setValue(60, true); // 60% 不透明度
    }

    // 位置调整（Motion > Position）
    var motion = clip.getComponentAt(0); // Motion 总是第一个
    var posComp = null;
    for (var i = 0; i < motion.properties.numItems; i++) {
        if (motion.properties[i].displayName === "Position") {
            posComp = motion.properties[i];
            break;
        }
    }
    if (posComp && posComp.setValue) {
        // Position 值是 [x, y]，单位是像素
        posComp.setValue([SEQ_W / 2, SEQ_H - PANEL_H_PX / 2], true);
    }

    return clip;
}


// ─────────────────────────────────────────────────────────────────────────────
// 歌曲信息文字（V3）— 使用 Legacy Title（旧版字幕）
// ─────────────────────────────────────────────────────────────────────────────

function addSongInfoTitle(sequence, song, startSecs, durationSecs, bin) {
    var titleName = "Info_" + song.title;

    // 创建旧版字幕
    var title = app.project.createNewTitle(titleName, false);
    if (!title) {
        $.writeln("[WARN] 无法创建 Title，检查 Pr 版本");
        return null;
    }

    var titleObj = title.getTitle();
    var doc      = titleObj.getItemByIndex(0); // TitleDocument

    // ── 歌曲标题（大字）────────────────────────────────────
    var titleText = titleObj.addTextObject(song.title);
    titleText.font          = DEFAULT_FONT;
    titleText.fontSize      = 72;
    titleText.fillColor     = COLOR_WHITE;
    titleText.shadowEnabled = true;
    titleText.shadowColor   = COLOR_BLACK;
    titleText.shadowOpacity = 60;
    titleText.shadowAngle   = 135;
    titleText.shadowDistance = 3;
    // 位置：左对齐，面板内上部
    var panelTop = SEQ_H - PANEL_H_PX;
    titleText.position = { x: 48, y: panelTop + 36 };

    // ── 艺人 · 专辑（小字）─────────────────────────────────
    var subLabel = song.artist + (song.album ? "  ·  " + song.album : "");
    var subText  = titleObj.addTextObject(subLabel);
    subText.font      = DEFAULT_FONT;
    subText.fontSize  = 36;
    subText.fillColor = { red: 220, green: 220, blue: 220 };
    subText.position  = { x: 48, y: panelTop + 110 };

    // ── 推荐语（更小字）────────────────────────────────────
    if (song.reason) {
        var reasonText = titleObj.addTextObject(song.reason);
        reasonText.font      = DEFAULT_FONT;
        reasonText.fontSize  = 28;
        reasonText.fillColor = { red: 200, green: 200, blue: 200 };
        reasonText.position  = { x: 48, y: panelTop + 160 };
    }

    titleObj.setTitle(doc);
    title.refreshMedia();

    // 放到 V3
    var vTrack = sequence.videoTracks[2];
    vTrack.insertClip(title, secsToTime(startSecs));
    var clip = vTrack.clips[vTrack.clips.numItems - 1];
    clip.outPoint = secsToTime(startSecs + durationSecs);
    return clip;
}


// ─────────────────────────────────────────────────────────────────────────────
// 进度条（V4）— 白色纯色 + Scale-X 关键帧
// ─────────────────────────────────────────────────────────────────────────────

function addProgressBar(sequence, startSecs, durationSecs, bin) {
    var size     = { width: SEQ_W, height: PROGRESS_H };
    var barItem  = app.project.newColorMatte(size, COLOR_WHITE, "ProgressBar_" + startSecs.toFixed(0), bin);
    if (!barItem) return null;

    var vTrack = sequence.videoTracks[3]; // V4
    vTrack.insertClip(barItem, secsToTime(startSecs));
    var clip = vTrack.clips[vTrack.clips.numItems - 1];
    clip.outPoint = secsToTime(startSecs + durationSecs);

    // Motion → Position（置于面板顶部左侧，Scale 锚点在左）
    var panelTopY = SEQ_H - PANEL_H_PX;
    var barY      = panelTopY + PROGRESS_H / 2;

    // 设置 Anchor Point 到左侧，这样 Scale-X 从左开始扩展
    var motion = clip.components.getComponentAt(0);
    var anchorProp = null, scaleProp = null, posProp = null;
    for (var i = 0; i < motion.properties.numItems; i++) {
        var propName = motion.properties[i].displayName;
        if (propName === "Anchor Point")  anchorProp = motion.properties[i];
        if (propName === "Scale Width" || propName === "Scale") scaleProp = motion.properties[i];
        if (propName === "Position")      posProp    = motion.properties[i];
    }

    // Position 中心 X = 0（从左开始）→ 通过设 Anchor Point 实现
    if (anchorProp) anchorProp.setValue([0, PROGRESS_H / 2], true);
    if (posProp)    posProp.setValue([0, barY], true);

    // Scale-X 关键帧：开始=0% → 结束=100%
    if (scaleProp) {
        // 关闭等比缩放
        var uniformScale = null;
        for (var i = 0; i < motion.properties.numItems; i++) {
            if (motion.properties[i].displayName === "Uniform Scale") {
                uniformScale = motion.properties[i];
                break;
            }
        }
        if (uniformScale) uniformScale.setValue(false, true);

        scaleProp.addKey(secsToTime(startSecs));
        scaleProp.setValueAtKey(secsToTime(startSecs), [0, 100], true);
        scaleProp.addKey(secsToTime(startSecs + durationSecs));
        scaleProp.setValueAtKey(secsToTime(startSecs + durationSecs), [100, 100], true);

        // 线性插值
        scaleProp.setInterpolationTypeAtKey(secsToTime(startSecs), KeyframeInterpolationType.LINEAR);
        scaleProp.setInterpolationTypeAtKey(secsToTime(startSecs + durationSecs), KeyframeInterpolationType.LINEAR);
    }

    // 透明度 90%
    if (clip.opacity) clip.opacity.setValue(90, true);

    return clip;
}


// ─────────────────────────────────────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────────────────────────────────────

function main() {
    // ── 读取 playlist.json ────────────────────────────────
    var jsonStr = readFile(PLAYLIST_PATH);
    if (!jsonStr) return;
    var playlist = JSON.parse(jsonStr);

    if (!playlist.songs || playlist.songs.length === 0) {
        alert("playlist.json 中没有歌曲，请先运行 download.py");
        return;
    }

    var seqName = playlist.output_sequence_name || "音乐推荐合辑";

    // ── 创建项目 bin ──────────────────────────────────────
    var mediaBin   = getOrCreateBin("媒体素材");
    var graphicBin = getOrCreateBin("图形元素");

    // ── 创建序列 ──────────────────────────────────────────
    // 查找是否已存在同名序列
    var sequence = null;
    var seqItems = app.project.sequences;
    for (var i = 0; i < seqItems.numSequences; i++) {
        if (seqItems[i].name === seqName) {
            sequence = seqItems[i];
            break;
        }
    }

    if (!sequence) {
        // 用 Pr 预设创建序列（1920x1080 30fps）
        // 使用 DSLR 1080p 30 预设（适合大多数安装）
        var presets = app.project.getSequencePresets();
        var targetPreset = null;
        for (var i = 0; i < presets.length; i++) {
            var p = presets[i];
            if (p.name.indexOf("1080") >= 0 &&
                (p.name.indexOf("30") >= 0 || p.name.indexOf("29.97") >= 0)) {
                targetPreset = p;
                break;
            }
        }
        sequence = app.project.createSequenceFromPreset(seqName, targetPreset || presets[0]);
        if (!sequence) {
            alert("无法创建序列，请手动创建一个 1920×1080 30fps 的序列后重新运行。");
            return;
        }
    }

    // 确保有足够的视频轨道（V1~V4）
    while (sequence.videoTracks.numTracks < 4) {
        sequence.videoTracks.addTrack();
    }

    // ── 逐首歌曲处理 ──────────────────────────────────────
    var cursor = 0; // 时间线当前末尾（秒）

    for (var i = 0; i < playlist.songs.length; i++) {
        var song = playlist.songs[i];

        var resolvedPath = resolveMediaPath(song.file_path);
        if (!resolvedPath) {
            $.writeln("[SKIP] 素材文件不存在: " + song.title +
                      " → 请先运行 download.py");
            continue;
        }

        var inSecs  = parseTime(song.start);
        var outSecs = parseTime(song.end);
        var clipDur = outSecs - inSecs;

        $.writeln("[处理] " + song.title + "  " + inSecs + "s → " + outSecs + "s  (" + clipDur.toFixed(1) + "s)");

        // 1. 导入并放置 MV 到 V1
        var projectItem = importFile(resolvedPath, mediaBin);
        var v1Clip = appendClip(sequence, 0, projectItem, inSecs, outSecs);

        // 2. 毛玻璃面板到 V2
        addGlassPanel(sequence, cursor, clipDur, graphicBin);

        // 3. 歌曲信息文字到 V3
        addSongInfoTitle(sequence, song, cursor, clipDur, graphicBin);

        // 4. 进度条到 V4
        addProgressBar(sequence, cursor, clipDur, graphicBin);

        cursor += clipDur;
    }

    // ── 完成 ──────────────────────────────────────────────
    app.project.activeSequence = sequence;
    $.writeln("\n[完成] 序列已组装：" + seqName +
              "\n       总时长：" + cursor.toFixed(1) + " 秒");
    alert("✅ 组装完成！\n\n序列：" + seqName +
          "\n歌曲数：" + playlist.songs.length +
          "\n总时长：" + Math.floor(cursor / 60) + " 分 " + Math.floor(cursor % 60) + " 秒\n\n" +
          "毛玻璃效果请手动调整 V2 层的「Gaussian Blur」参数（建议模糊量 80~120）。");
}

// 执行
main();
