/**
 * scripts/assemble_v2.jsx — Premiere Pro 2025 Route-A Automated Timeline Assembler
 *
 * Timeline Architecture (1920x1080 @ 30fps):
 *   - Optional Intro segment (if playlist.intro.enabled === true)
 *   - For each song in playlist.json:
 *       * If song.pre_rendered_clip exists on disk:
 *           Insert directly to V1/A1 and skip V2/V3/V4 packaging (pluggable AE renderer support).
 *       * Otherwise (standard 'annual' template):
 *           V1 / A1 : Normalized (-14 LUFS) or raw MV clip trimmed to [start, end]
 *           V2      : Floating glass frosted blur (same MV clip with Gaussian Blur 28 + 4-side sharp Crop to [42..1878, 898..1054])
 *           V3      : AE-exported templates/annual.mogrt (light translucent glass tint, real-time progress bar via DURATION_SEC, white serif text + dark shadow)
 *           V4      : Official 1:1 album cover (covers/*.png) flush-left with floating glass bar (156x156)
 *           V5      : Transparent audio spectrum visualizer (processed/*_spectrum.mov) directly above progress bar
 *
 * Usage:
 *   Premiere Pro 2025 -> VS Code ExtendScript Debugger / CEP Bridge / File -> Scripts -> Run Script...
 */

(function () {
    app.enableQE();

    var TICKS_PER_SEC = 254016000000;
    var SEQ_W = 1920;
    var SEQ_H = 1080;

    // -------------------------------------------------------------------------
    // Utilities (ES3-safe)
    // -------------------------------------------------------------------------
    function escapeJsonStr(s) {
        return String(s)
            .replace(/\\/g, "\\\\")
            .replace(/"/g, '\\"')
            .replace(/\r/g, "\\r")
            .replace(/\n/g, "\\n")
            .replace(/\t/g, "\\t");
    }

    function toJson(val) {
        if (val === null) return "null";
        var t = typeof val;
        if (t === "boolean" || t === "number") return String(val);
        if (t === "string") return '"' + escapeJsonStr(val) + '"';
        if (val instanceof Array) {
            var arr = [];
            for (var i = 0; i < val.length; i++) arr.push(toJson(val[i]));
            return "[" + arr.join(",") + "]";
        }
        if (t === "object") {
            var pairs = [];
            for (var k in val) {
                if (val.hasOwnProperty(k) && typeof val[k] !== "function" && typeof val[k] !== "undefined") {
                    pairs.push('"' + escapeJsonStr(k) + '":' + toJson(val[k]));
                }
            }
            return "{" + pairs.join(",") + "}";
        }
        return "null";
    }

    function secsToTime(secs) {
        var t = new Time();
        t.seconds = secs;
        return t;
    }

    function secsToTicksStr(secs) {
        return String(Math.round(secs * TICKS_PER_SEC));
    }

    function parseTime(t) {
        if (typeof t === "number") return t;
        t = String(t || "0").replace(/^\s+|\s+$/g, "");
        var parts = t.split(":");
        if (parts.length === 2) {
            return parseInt(parts[0], 10) * 60 + parseFloat(parts[1]);
        } else if (parts.length === 3) {
            return parseInt(parts[0], 10) * 3600 + parseInt(parts[1], 10) * 60 + parseFloat(parts[2]);
        }
        return parseFloat(t) || 0;
    }

    function pad2(n) {
        return n < 10 ? ("0" + n) : String(n);
    }

    function visualWidth(str) {
        var w = 0;
        for (var i = 0; i < str.length; i++) {
            w += (str.charCodeAt(i) > 255) ? 2 : 1;
        }
        return w;
    }

    /** Smart word-aware line wrap for long song titles (preserves English words) */
    function formatTitleText(title, maxUnits) {
        if (!title) return "";
        var clean = String(title).replace(/\r\n|\r|\n/g, " ").replace(/^\s+|\s+$/g, "");
        if (visualWidth(clean) <= maxUnits) {
            return clean;
        }
        var lines = [];
        var remaining = clean;
        while (remaining.length > 0 && lines.length < 2) {
            if (visualWidth(remaining) <= maxUnits) {
                lines.push(remaining);
                remaining = "";
                break;
            }
            // Find the furthest cut index within maxUnits
            var cut = 0;
            var acc = 0;
            var lastSpace = -1;
            for (var i = 0; i < remaining.length; i++) {
                var ch = remaining.charAt(i);
                var cw = (remaining.charCodeAt(i) > 255) ? 2 : 1;
                if (acc + cw > maxUnits) break;
                acc += cw;
                cut = i + 1;
                if (ch === " " || ch === "," || ch === "/" || ch === "-" || ch === "、" || ch === "，") {
                    lastSpace = i + 1;
                }
            }
            // Prefer breaking at word boundary if not too early
            var breakAt = (lastSpace > cut * 0.55) ? lastSpace : cut;
            if (breakAt <= 0) breakAt = 1;
            lines.push(remaining.substring(0, breakAt).replace(/\s+$/, ""));
            remaining = remaining.substring(breakAt).replace(/^\s+/, "");
        }
        if (remaining.length > 0 && lines.length === 2) {
            // Append overflow to 2nd line with ellipsis if still huge
            var second = lines[1] + " " + remaining;
            if (visualWidth(second) > maxUnits + 8) {
                var trim = "";
                var tw = 0;
                for (var j = 0; j < second.length; j++) {
                    var jw = (second.charCodeAt(j) > 255) ? 2 : 1;
                    if (tw + jw > maxUnits + 4) break;
                    trim += second.charAt(j);
                    tw += jw;
                }
                lines[1] = trim.replace(/\s+$/, "") + "…";
            } else {
                lines[1] = second;
            }
        }
        return lines.join("\r");
    }

    function formatReasonText(text, maxCharsPerLine) {
        if (!text) return "";
        // Normalize newlines to \r (AE/Pr textEditValue convention)
        var rawLines = String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
        var outLines = [];
        for (var i = 0; i < rawLines.length; i++) {
            var line = rawLines[i];
            // Avoid orphan 1-3 chars dangling on the next line
            if (line.length <= maxCharsPerLine + 3) {
                outLines.push(line);
            } else {
                var pos = 0;
                while (pos < line.length) {
                    var rem = line.length - pos;
                    if (rem <= maxCharsPerLine + 3) {
                        outLines.push(line.substring(pos));
                        break;
                    }
                    outLines.push(line.substring(pos, pos + maxCharsPerLine));
                    pos += maxCharsPerLine;
                }
            }
        }
        return outLines.join("\r");
    }

    /** Parse native video resolution (width, height) from ProjectItem column metadata */
    function getItemVideoSize(projectItem) {
        try {
            var meta = projectItem.getProjectColumnsMetadata();
            if (meta) {
                // Matches patterns like "640 x 480" or "1920 x 1080"
                var m = String(meta).match(/(\d{3,4})\s*x\s*(\d{3,4})/i);
                if (m && m.length >= 3) {
                    var w = parseInt(m[1], 10);
                    var h = parseInt(m[2], 10);
                    if (w > 0 && h > 0) return { width: w, height: h };
                }
            }
        } catch (eMeta) {}
        return { width: SEQ_W, height: SEQ_H };
    }

    /** Set uniform Motion Scale on a video clip */
    function setClipScale(clip, scalePct) {
        try {
            for (var c = 0; c < clip.components.numItems; c++) {
                var comp = clip.components[c];
                if (comp.matchName === "AE.ADBE Motion" || comp.displayName === "运动" || comp.displayName === "Motion") {
                    for (var p = 0; p < comp.properties.numItems; p++) {
                        var prop = comp.properties[p];
                        if (prop.displayName === "缩放" || prop.displayName === "Scale") {
                            prop.setValue(scalePct, true);
                            return;
                        }
                    }
                }
            }
        } catch (eSc) {}
    }

    function resolvePath(projectRoot, p) {
        if (!p) return "";
        var norm = String(p).replace(/\\/g, "/");
        var isAbs = (norm.charAt(0) === "/" || /^[A-Za-z]:\//.test(norm));
        if (!isAbs) {
            var relF = new File(projectRoot + "/" + norm);
            if (relF.exists) return relF.fsName;
        }
        var absF = new File(p);
        if (absF.exists) return absF.fsName;
        return "";
    }

    function getOrCreateBin(root, binName) {
        for (var i = 0; i < root.children.numItems; i++) {
            if (root.children[i].name === binName && root.children[i].type === ProjectItemType.BIN) {
                return root.children[i];
            }
        }
        return root.createBin(binName);
    }

    function clearBin(bin) {
        if (!bin) return;
        while (bin.children.numItems > 0) {
            try { bin.children[bin.children.numItems - 1].deleteBin ? null : null; } catch (e) {}
            break;
        }
    }

    function importOrReuse(project, bin, fsPath, forceRefresh) {
        var normTarget = fsPath.replace(/\\/g, "/").toLowerCase();
        for (var i = 0; i < bin.children.numItems; i++) {
            var child = bin.children[i];
            if (child.getMediaPath && child.getMediaPath().replace(/\\/g, "/").toLowerCase() === normTarget) {
                if (forceRefresh && typeof child.refreshMedia === "function") {
                    try { child.refreshMedia(); } catch (eRef) {}
                }
                return child;
            }
        }
        project.importFiles([fsPath], true, bin, false);
        return bin.children[bin.children.numItems - 1];
    }

    function findAdjustmentLayer(container) {
        for (var i = 0; i < container.children.numItems; i++) {
            var item = container.children[i];
            var lower = (item.name || "").toLowerCase();
            if (lower.indexOf("调整图层") >= 0 || lower.indexOf("adjustment") >= 0) {
                return item;
            }
            if (item.type === ProjectItemType.BIN) {
                var found = findAdjustmentLayer(item);
                if (found) return found;
            }
        }
        return null;
    }

    function clearTrack(track) {
        if (!track) return;
        while (track.clips.numItems > 0) {
            track.clips[track.clips.numItems - 1].remove(false, false);
        }
    }

    function setMgtTextProp(mgtComp, propName, newText) {
        if (!mgtComp || !mgtComp.properties) return false;
        var props = mgtComp.properties;
        for (var i = 0; i < props.numItems; i++) {
            var p = props[i];
            if (p.displayName === propName) {
                var valStr = String(p.getValue());
                if (valStr.indexOf("textEditValue") >= 0) {
                    var parsed = eval("(" + valStr + ")");
                    parsed.textEditValue = String(newText);
                    var serialized = (typeof JSON !== "undefined" && JSON.stringify)
                        ? JSON.stringify(parsed)
                        : toJson(parsed);
                    p.setValue(serialized, true);
                    return true;
                } else {
                    p.setValue(String(newText), true);
                    return true;
                }
            }
        }
        return false;
    }

    function setMgtNumberProp(mgtComp, propName, numVal) {
        if (!mgtComp || !mgtComp.properties) return false;
        var props = mgtComp.properties;
        for (var i = 0; i < props.numItems; i++) {
            var p = props[i];
            if (p.displayName === propName) {
                try {
                    p.setValue(Number(numVal), true);
                    return true;
                } catch (eNum) {}
            }
        }
        return false;
    }

    function findQeVideoEffect(names) {
        for (var i = 0; i < names.length; i++) {
            try {
                var fx = qe.project.getVideoEffectByName(names[i]);
                if (fx && fx.name && String(fx.name).length > 0) {
                    return fx;
                }
            } catch (e) {}
        }
        return null;
    }

    function applyFrostedBarEffects(qeSeq, clip, cropBox) {
        // cropBox: { top, bottom, left, right } in percentages (0..99)
        var appliedBlur = false;
        try {
            var qeTrack = qeSeq.getVideoTrackAt(1);
            var targetTicks = String(clip.start.ticks);
            var qeClip = null;
            for (var i = qeTrack.numItems - 1; i >= 0; i--) {
                var item = qeTrack.getItemAt(i);
                if (item && item.type === "Clip" && String(item.start.ticks) === targetTicks) {
                    qeClip = item;
                    break;
                }
            }
            if (!qeClip) return false;

            var blurFx = findQeVideoEffect(["高斯模糊", "Gaussian Blur"]);
            if (blurFx) {
                qeClip.addVideoEffect(blurFx);
                appliedBlur = true;
            }

            var cropFx = findQeVideoEffect(["裁剪", "Crop"]);
            if (cropFx) {
                qeClip.addVideoEffect(cropFx);
            }
        } catch (eQE) {}

        // Medium-strength Gaussian Blur (28) preserves silhouette/motion; sharp 4-side Crop creates floating glass gap
        try {
            for (var c = 0; c < clip.components.numItems; c++) {
                var comp = clip.components[c];
                var mName = comp.matchName || "";
                var dName = comp.displayName || "";

                if (mName.indexOf("Gaussian Blur") >= 0 || dName.indexOf("高斯模糊") >= 0 || dName.indexOf("Gaussian Blur") >= 0) {
                    for (var p1 = 0; p1 < comp.properties.numItems; p1++) {
                        var pr1 = comp.properties[p1];
                        if (pr1.displayName === "模糊度" || pr1.displayName === "Blurriness") {
                            pr1.setValue(32, true);
                        } else if (pr1.displayName === "重复边缘像素" || pr1.displayName === "Repeat Edge Pixels") {
                            pr1.setValue(true, true);
                        }
                    }
                } else if (mName.indexOf("Crop") >= 0 || dName === "裁剪" || dName === "Crop") {
                    for (var p2 = 0; p2 < comp.properties.numItems; p2++) {
                        var pr2 = comp.properties[p2];
                        var dn = pr2.displayName;
                        if (dn === "顶部" || dn === "Top") {
                            pr2.setValue(cropBox.top, true);
                        } else if (dn === "底部" || dn === "Bottom") {
                            pr2.setValue(cropBox.bottom, true);
                        } else if (dn === "左侧" || dn === "Left") {
                            pr2.setValue(cropBox.left, true);
                        } else if (dn === "右侧" || dn === "Right") {
                            pr2.setValue(cropBox.right, true);
                        } else if (dn === "边缘羽化" || dn === "Edge Feather") {
                            pr2.setValue(0, true); // Sharp 90-degree glass edges, no feathering
                        }
                    }
                }
            }
        } catch (eProps) {}
        return appliedBlur;
    }

    function positionCoverClip(clip) {
        // Place 600x600 1:1 album cover flush-left with floating glass bar: 186x186 px, center=(121, 963)
        try {
            for (var c = 0; c < clip.components.numItems; c++) {
                var comp = clip.components[c];
                if (comp.matchName === "AE.ADBE Motion" || comp.displayName === "运动" || comp.displayName === "Motion") {
                    for (var p = 0; p < comp.properties.numItems; p++) {
                        var prop = comp.properties[p];
                        if (prop.displayName === "缩放" || prop.displayName === "Scale") {
                            prop.setValue(31.0, true); // 600 * 0.31 = 186px (flush with glass bar height)
                        } else if (prop.displayName === "位置" || prop.displayName === "Position") {
                            prop.setValue([121 / SEQ_W, 963 / SEQ_H], true);
                        }
                    }
                    break;
                }
            }
        } catch (eCov) {}
    }

    function positionSpectrumClip(clip) {
        // Place 186x68 transparent audio spectrum inside the bottom of the 186x186 cover (X=28..214, Y=870..1056)
        // Center X = 121, Bottom aligns at Y = 1054 -> Center Y = 1054 - 34 = 1020
        try {
            for (var c = 0; c < clip.components.numItems; c++) {
                var comp = clip.components[c];
                if (comp.matchName === "AE.ADBE Motion" || comp.displayName === "运动" || comp.displayName === "Motion") {
                    for (var p = 0; p < comp.properties.numItems; p++) {
                        var prop = comp.properties[p];
                        if (prop.displayName === "位置" || prop.displayName === "Position") {
                            prop.setValue([121 / SEQ_W, 1020 / SEQ_H], true);
                        }
                    }
                    break;
                }
            }
        } catch (eSpec) {}
    }

    // -------------------------------------------------------------------------
    // Main Entry
    // -------------------------------------------------------------------------
    try {
        var project = app.project;
        if (!project) {
            alert("请先在 Premiere Pro 中打开一个项目！");
            return;
        }

        var projectRoot = "D:/prworks/music-rec-video";
        try {
            if ($.fileName) {
                var sf = new File($.fileName);
                if (sf.parent && sf.parent.parent) {
                    projectRoot = sf.parent.parent.fsName.replace(/\\/g, "/");
                }
            }
        } catch (eR) {}

        var playlistFile = new File(projectRoot + "/playlist.json");
        if (!playlistFile.exists) {
            alert("找不到 playlist.json：" + playlistFile.fsName);
            return;
        }
        playlistFile.encoding = "UTF-8";
        playlistFile.open("r");
        var playlistData = eval("(" + playlistFile.read() + ")");
        playlistFile.close();

        var songs = playlistData.songs || [];
        if (songs.length === 0) {
            alert("playlist.json 中没有歌曲！");
            return;
        }

        var annualMogrtFile = new File(projectRoot + "/templates/annual.mogrt");
        if (!annualMogrtFile.exists) {
            alert("未找到 templates/annual.mogrt！\n请先在 After Effects 中运行 scripts/build_annual_mogrt_ae.jsx 导出模板。");
            return;
        }
        var introMogrtFile = new File(projectRoot + "/templates/intro.mogrt");

        var root = project.rootItem;
        var mvBin = getOrCreateBin(root, "MV素材");
        var coverBin = getOrCreateBin(root, "封面素材");
        var specBin = getOrCreateBin(root, "频谱素材");
        var specialBin = getOrCreateBin(root, "特殊模板成片");

        // Resolve and import media items for all songs
        var prepared = [];
        for (var i = 0; i < songs.length; i++) {
            var s = songs[i];
            var prePath = resolvePath(projectRoot, s.pre_rendered_clip);
            if (prePath) {
                prepared.push({
                    song: s,
                    index: s.display_index || (i + 1),
                    isPreRendered: true,
                    mediaItem: importOrReuse(project, specialBin, prePath),
                    coverItem: null,
                    specItem: null,
                    inSec: 0,
                    outSec: 0
                });
                continue;
            }

            // Prefer loudness-normalized video; fallback to raw file_path
            var vidPath = resolvePath(projectRoot, s.normalized_path) || resolvePath(projectRoot, s.file_path);
            if (!vidPath) continue;

            var covPath = resolvePath(projectRoot, s.cover_path);
            var specPath = resolvePath(projectRoot, s.spectrum_path);
            prepared.push({
                song: s,
                index: s.display_index || (i + 1),
                isPreRendered: false,
                mediaItem: importOrReuse(project, mvBin, vidPath),
                coverItem: covPath ? importOrReuse(project, coverBin, covPath, false) : null,
                specItem: specPath ? importOrReuse(project, specBin, specPath, true) : null,
                inSec: parseTime(s.start),
                outSec: parseTime(s.end)
            });
        }

        if (prepared.length === 0) {
            alert("未找到任何可用的本地视频文件，请先在 Web 控制台完成下载与预处理！");
            return;
        }

        // Find or create target sequence
        var seqName = playlistData.output_sequence_name || "音乐推荐合辑";
        var targetSeq = null;
        for (var sq = 0; sq < project.sequences.numSequences; sq++) {
            if (project.sequences[sq].name === seqName) {
                targetSeq = project.sequences[sq];
                break;
            }
        }
        if (!targetSeq) {
            targetSeq = project.createNewSequenceFromClips(seqName, [prepared[0].mediaItem], root);
        }
        project.activeSequence = targetSeq;

        // Ensure 30fps timebase
        try {
            var settings = targetSeq.getSettings();
            settings.videoFrameRate = secsToTime(1.0 / 30.0);
            targetSeq.setSettings(settings);
        } catch (eFps) {}

        // Ensure at least 5 video tracks (V1..V5)
        var qeSeq = qe.project.getActiveSequence();
        while (targetSeq.videoTracks.numTracks < 5) {
            try {
                qeSeq.addTracks(1, targetSeq.videoTracks.numTracks, 0, 0);
            } catch (eTrk) {
                break;
            }
        }

        var v1 = targetSeq.videoTracks[0];
        var v2 = targetSeq.videoTracks.numTracks > 1 ? targetSeq.videoTracks[1] : null;
        var v3 = targetSeq.videoTracks.numTracks > 2 ? targetSeq.videoTracks[2] : null;
        var v4 = targetSeq.videoTracks.numTracks > 3 ? targetSeq.videoTracks[3] : null;
        var v5 = targetSeq.videoTracks.numTracks > 4 ? targetSeq.videoTracks[4] : null;
        var a1 = targetSeq.audioTracks[0];
        var a2 = targetSeq.audioTracks.numTracks > 1 ? targetSeq.audioTracks[1] : null;

        clearTrack(v1);
        clearTrack(v2);
        clearTrack(v3);
        clearTrack(v4);
        clearTrack(v5);
        clearTrack(a1);
        clearTrack(a2);

        var curTimeSec = 0.0;
        var mogrtWarned = false;
        var v2BlurOkCount = 0;
        var v2TotalCount = 0;
        var v5SpecCount = 0;

        // ---------------------------------------------------------------------
        // 1. Optional Intro Segment
        // ---------------------------------------------------------------------
        var intro = playlistData.intro || {};
        if (intro.enabled) {
            var introDur = parseFloat(intro.duration) || 8.0;
            if (intro.bg_mode === "image") {
                var bgImgPath = resolvePath(projectRoot, intro.bg_image);
                if (bgImgPath) {
                    var bgImgItem = importOrReuse(project, coverBin, bgImgPath);
                    bgImgItem.setInPoint(secsToTime(0), 4);
                    bgImgItem.setOutPoint(secsToTime(introDur), 4);
                    v1.overwriteClip(bgImgItem, secsToTime(0));
                    if (v1.clips.numItems > 0) {
                        v1.clips[v1.clips.numItems - 1].end = secsToTime(introDur);
                    }
                }
            } else if (intro.bg_mode === "blur_first_song" && prepared.length > 0) {
                var firstItem = prepared[0].mediaItem;
                firstItem.setInPoint(secsToTime(prepared[0].inSec), 4);
                firstItem.setOutPoint(secsToTime(prepared[0].inSec + introDur), 4);
                v1.overwriteClip(firstItem, secsToTime(0));
            }

            if (introMogrtFile.exists && v3) {
                var introClip = targetSeq.importMGT(introMogrtFile.fsName, secsToTicksStr(0), 2, 0);
                if (introClip) {
                    introClip.end = secsToTime(introDur);
                    var introMgt = introClip.getMGTComponent();
                    if (introMgt) {
                        setMgtTextProp(introMgt, "INTRO_TEXT", formatReasonText(intro.text || "", 26));
                    }
                }
            }
            curTimeSec += introDur;
        }

        // ---------------------------------------------------------------------
        // 2. Assemble Songs
        // ---------------------------------------------------------------------
        for (var k = 0; k < prepared.length; k++) {
            var entry = prepared[k];
            var song = entry.song;
            var insTime = secsToTime(curTimeSec);

            if (entry.isPreRendered) {
                // Pluggable pre-rendered clip: insert directly to V1/A1, skip V2/V3/V4
                v1.overwriteClip(entry.mediaItem, insTime);
                var preClip = v1.clips[v1.clips.numItems - 1];
                curTimeSec = preClip.end.seconds;
                continue;
            }

            var dur = entry.outSec - entry.inSec;
            if (dur <= 0.1) dur = 20.0;

            entry.mediaItem.setInPoint(secsToTime(entry.inSec), 4);
            entry.mediaItem.setOutPoint(secsToTime(entry.outSec), 4);

            // Compute fit-to-frame scale for non-1080p clips (e.g., 640x480 -> scale 225% to fill 1080p height)
            var dim = getItemVideoSize(entry.mediaItem);
            var fitScale = Math.min(SEQ_W / dim.width, SEQ_H / dim.height) * 100.0;
            var renderedW = dim.width * (fitScale / 100.0);
            var renderedH = dim.height * (fitScale / 100.0);
            var clipLeftX = (SEQ_W - renderedW) / 2.0;
            var clipRightX = clipLeftX + renderedW;
            var clipTopY = (SEQ_H - renderedH) / 2.0;
            var clipBottomY = clipTopY + renderedH;

            // Floating glass rectangle geometry matching reference: X=[28..1892], Y=[870..1056] (24px bottom, 28px side gaps)
            var BAR_LEFT = 28.0;
            var BAR_RIGHT = 1892.0;
            var BAR_TOP = 870.0;
            var BAR_BOTTOM = 1056.0;

            function clampPct(v) {
                if (v < 0) return 0;
                if (v > 99) return 99;
                return v;
            }

            // Only add V2 floating frosted blur if the fitted video overlaps the floating glass rectangle
            if (v2 && clipBottomY > BAR_TOP + 2 && clipTopY < BAR_BOTTOM - 2) {
                var cropBox = {
                    top: clampPct(((BAR_TOP - clipTopY) / renderedH) * 100.0),
                    bottom: clampPct(((clipBottomY - BAR_BOTTOM) / renderedH) * 100.0),
                    left: clampPct(((BAR_LEFT - clipLeftX) / renderedW) * 100.0),
                    right: clampPct(((clipRightX - BAR_RIGHT) / renderedW) * 100.0)
                };

                v2.overwriteClip(entry.mediaItem, insTime);
                var blurClip = v2.clips[v2.clips.numItems - 1];
                if (Math.abs(fitScale - 100.0) > 0.5) {
                    setClipScale(blurClip, fitScale);
                }
                v2TotalCount++;
                if (applyFrostedBarEffects(qeSeq, blurClip, cropBox)) {
                    v2BlurOkCount++;
                }
            }

            // V1/A1 SECOND: Crisp original MV (auto-fitted to frame) + clean single audio track on A1
            v1.overwriteClip(entry.mediaItem, insTime);
            var mainClip = v1.clips[v1.clips.numItems - 1];
            if (Math.abs(fitScale - 100.0) > 0.5) {
                setClipScale(mainClip, fitScale);
            }

            // V3: AE-exported annual.mogrt with live text + DURATION_SEC progress bar injection
            if (v3) {
                var mogrtClip = targetSeq.importMGT(annualMogrtFile.fsName, secsToTicksStr(curTimeSec), 2, 0);
                if (mogrtClip) {
                    mogrtClip.end = secsToTime(curTimeSec + dur);
                    var mgtComp = mogrtClip.getMGTComponent();
                    if (mgtComp) {
                        setMgtNumberProp(mgtComp, "DURATION_SEC", dur);
                        setMgtTextProp(mgtComp, "INDEX_TEXT", "#" + pad2(entry.index));
                        setMgtTextProp(mgtComp, "TITLE_TEXT", formatTitleText(song.title || "", 44));
                        setMgtTextProp(mgtComp, "ARTIST_TEXT", song.artist || "");
                        setMgtTextProp(mgtComp, "REASON_TEXT", formatReasonText(song.reason || "", 22));
                    } else if (!mogrtWarned) {
                        mogrtWarned = true;
                        alert("提示：templates/annual.mogrt 的 getMGTComponent() 返回为空。\n请确认已使用 AE 运行 scripts/build_annual_mogrt_ae.jsx 导出新版模板。");
                    }
                }
            }

            // V4: Official 1:1 album cover flush-left with floating glass bar (156x156)
            if (v4 && entry.coverItem) {
                entry.coverItem.setInPoint(secsToTime(0), 4);
                entry.coverItem.setOutPoint(secsToTime(dur), 4);
                v4.overwriteClip(entry.coverItem, insTime);
                var covClip = v4.clips[v4.clips.numItems - 1];
                covClip.end = secsToTime(curTimeSec + dur);
                positionCoverClip(covClip);
            }

            // V5: Transparent audio spectrum visualizer directly above the progress bar
            if (v5 && entry.specItem) {
                entry.specItem.setInPoint(secsToTime(0), 4);
                entry.specItem.setOutPoint(secsToTime(dur), 4);
                v5.overwriteClip(entry.specItem, insTime);
                var specClip = v5.clips[v5.clips.numItems - 1];
                specClip.end = secsToTime(curTimeSec + dur);
                positionSpectrumClip(specClip);
                v5SpecCount++;
            }

            curTimeSec += dur;
        }

        // Remove any duplicate audio placed onto A2 by V2 frosted-bar clips
        clearTrack(a2);

        var msg = "assemble_v2.jsx 组装完成！\n"
            + "序列：" + seqName + "\n"
            + "已装配曲目：" + prepared.length + " 首\n"
            + "V2 悬浮毛玻璃挂载：" + v2BlurOkCount + " / " + v2TotalCount + "\n"
            + "V5 音频频谱挂载：" + v5SpecCount + " / " + prepared.length + "\n"
            + "总时长：" + curTimeSec.toFixed(1) + " 秒";
        $.global.__ASSEMBLE_RESULT__ = msg;
        if (!$.global.__MCP_SILENT__) {
            alert(msg);
        }
    } catch (fatal) {
        var errText = "assemble_v2.jsx 运行异常：" + fatal + " (line " + (fatal.line || "?") + ")";
        $.global.__ASSEMBLE_RESULT__ = errText;
        if (!$.global.__MCP_SILENT__) {
            alert(errText);
        }
    }
})();
