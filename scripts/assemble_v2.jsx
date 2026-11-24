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
 *           V2      : Floating glass frosted blur (same MV clip with Gaussian Blur 32 + 4-side sharp Crop to [28..1892, 870..1056])
 *           V3      : AE-exported 30fps static-friendly templates/annual.mogrt (native editable text + marquee + dynamic shadow boost)
 *           V4      : Official 1:1 album cover (covers/*.png) flush-left with floating glass bar (186x186)
 *           V5      : Transparent 60fps frosted-glass audio spectrum visualizer (processed/*_spectrum.mov) inside cover bottom
 *           V6      : Native GPU 60fps progress bar (templates/progress_bar.png with Crop Right 100% -> 0% keyframes)
 *           V7      : Bilingual lyrics (templates/lyric_line.mogrt, auto-shifted down +34px when song title is long)
 *           Transitions: Configurable video/audio transitions (Cross Dissolve / Dip to Black + Constant Power + optional AE overlay)
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

    /**
     * Preserve user's exact manual line breaks for top-right recommendation text (no auto-wrapping).
     */
    function formatReasonText(text) {
        if (!text) return "";
        return String(text).replace(/\r\n/g, "\r").replace(/\n/g, "\r");
    }

    function readJsonFile(fsPath) {
        if (!fsPath) return null;
        try {
            var f = new File(fsPath);
            if (!f.exists) return null;
            f.encoding = "UTF-8";
            f.open("r");
            var txt = f.read();
            f.close();
            return eval("(" + txt + ")");
        } catch (e) {
            return null;
        }
    }

    function resolveShadowFlag(song, zoneKey) {
        var mode = song.shadow_boost || "auto";
        if (mode === "strong") return 1;
        if (mode === "normal") return 0;
        var det = song.detected_bright || {};
        return det[zoneKey] ? 1 : 0;
    }

    /** Apply low-frequency beat-reactive scale pulse & subtle shake keyframes onto V1/V2 Motion */
    function applyBeatMotionKeyframes(clip, beatData, fitScalePct) {
        if (!beatData || !beatData.keyframes || beatData.keyframes.length === 0) return false;
        var kfs = beatData.keyframes;
        var scaleProp = null;
        var posProp = null;
        try {
            for (var c = 0; c < clip.components.numItems; c++) {
                var comp = clip.components[c];
                if (comp.matchName === "AE.ADBE Motion" || comp.displayName === "运动" || comp.displayName === "Motion") {
                    for (var p = 0; p < comp.properties.numItems; p++) {
                        var prop = comp.properties[p];
                        if (prop.displayName === "缩放" || prop.displayName === "Scale") scaleProp = prop;
                        else if (prop.displayName === "位置" || prop.displayName === "Position") posProp = prop;
                    }
                    break;
                }
            }
            if (!scaleProp || !posProp) return false;

            scaleProp.setTimeVarying(true);
            posProp.setTimeVarying(true);
            var baseInSec = clip.inPoint.seconds;
            var factor = (fitScalePct || 100.0) / 100.0;

            for (var i = 0; i < kfs.length; i++) {
                var kf = kfs[i];
                var t = secsToTime(baseInSec + kf.t);
                var sVal = kf.scale * factor;
                var px = 0.5 + (kf.dx / SEQ_W);
                var py = 0.5 + (kf.dy / SEQ_H);
                scaleProp.addKey(t);
                scaleProp.setValueAtKey(t, sVal, true);
                posProp.addKey(t);
                posProp.setValueAtKey(t, [px, py], true);
            }
            return true;
        } catch (eBeat) {
            return false;
        }
    }

    function findQeVideoTransition(names) {
        for (var i = 0; i < names.length; i++) {
            try {
                var tr = qe.project.getVideoTransitionByName(names[i]);
                if (tr && tr.name && String(tr.name).length > 0) return tr;
            } catch (e) {}
        }
        return null;
    }

    function findQeAudioTransition(names) {
        for (var i = 0; i < names.length; i++) {
            try {
                var tr = qe.project.getAudioTransitionByName(names[i]);
                if (tr && tr.name && String(tr.name).length > 0) return tr;
            } catch (e) {}
        }
        return null;
    }

    /** Apply configurable video/audio transitions between adjacent song clips */
    function applyTrackTransitions(qeSeq, transCfg, fps) {
        var style = (transCfg && transCfg.video_style) ? String(transCfg.video_style) : "cross_dissolve";
        var vDurSec = (transCfg && typeof transCfg.video_duration === "number") ? transCfg.video_duration : 0.6;
        var aDurSec = (transCfg && typeof transCfg.audio_duration === "number") ? transCfg.audio_duration : 0.8;
        var vFrames = Math.max(4, Math.round(vDurSec * fps));
        var aFrames = Math.max(4, Math.round(aDurSec * fps));
        var applied = 0;

        if (style !== "none") {
            var vNames = (style === "dip_to_black")
                ? ["黑场过渡", "Dip to Black", "交叉溶解", "Cross Dissolve"]
                : ["交叉溶解", "Cross Dissolve"];
            var vTrans = findQeVideoTransition(vNames);
            if (vTrans) {
                // Apply to V1 (0) and V2 (1) cut points between consecutive songs
                var tracksToCross = [0, 1];
                for (var tIdx = 0; tIdx < tracksToCross.length; tIdx++) {
                    try {
                        var qeVTrack = qeSeq.getVideoTrackAt(tracksToCross[tIdx]);
                        var seenClips = 0;
                        for (var i = 0; i < qeVTrack.numItems; i++) {
                            var it = qeVTrack.getItemAt(i);
                            if (it && it.type === "Clip") {
                                if (seenClips > 0) {
                                    try {
                                        it.addTransition(vTrans, true, "00:00:00:" + pad2(Math.min(59, vFrames)));
                                        if (tracksToCross[tIdx] === 0) applied++;
                                    } catch (eVT) {}
                                }
                                seenClips++;
                            }
                        }
                    } catch (eTrkV) {}
                }
            }
        }

        // Audio Constant Power crossfade on A1 (0)
        if (aDurSec > 0.05) {
            var aTrans = findQeAudioTransition(["恒定功率", "Constant Power"]);
            if (aTrans) {
                try {
                    var qeATrack = qeSeq.getAudioTrackAt(0);
                    var seenAudio = 0;
                    for (var j = 0; j < qeATrack.numItems; j++) {
                        var ait = qeATrack.getItemAt(j);
                        if (ait && ait.type === "Clip") {
                            if (seenAudio > 0) {
                                try {
                                    ait.addTransition(aTrans, true, "00:00:00:" + pad2(Math.min(59, aFrames)));
                                } catch (eAT) {}
                            }
                            seenAudio++;
                        }
                    }
                } catch (eTrkA) {}
            }
        }
        return applied;
    }

    function shiftClipVerticalPx(clip, dyPx) {
        if (!dyPx) return;
        try {
            for (var c = 0; c < clip.components.numItems; c++) {
                var comp = clip.components[c];
                if (comp.matchName === "AE.ADBE Motion" || comp.displayName === "运动" || comp.displayName === "Motion") {
                    for (var p = 0; p < comp.properties.numItems; p++) {
                        var prop = comp.properties[p];
                        if (prop.displayName === "位置" || prop.displayName === "Position") {
                            prop.setValue([0.5, 0.5 + (dyPx / SEQ_H)], true);
                            return;
                        }
                    }
                }
            }
        } catch (eSh) {}
    }

    /**
     * Native Pr GPU 60fps Marquee Scroll on V8 (track index 7) using 3840x1080 title_scroll.mogrt:
     * 1. Effect #1: Transform (GPU) -> Position keyframes scroll left smoothly (1.5s pause -> 82px/s -> 1.5s pause)
     * 2. Effect #2: Crop (GPU) -> fixed screen window [X=242..1868] (Left=6.30%, Right=51.35% on 3840w canvas)
     * 3. Motion -> Position = [1.0, 0.5] aligns 3840w canvas left edge (X=0) with 1920w sequence left edge (X=0)
     */
    function animateGpuMarqueeTitle(qeSeq, clip, durSec, overflowPx) {
        try {
            // Align 3840x1080 left edge to 1920x1080 left edge
            for (var c = 0; c < clip.components.numItems; c++) {
                var comp = clip.components[c];
                if (comp.matchName === "AE.ADBE Motion" || comp.displayName === "运动" || comp.displayName === "Motion") {
                    for (var p = 0; p < comp.properties.numItems; p++) {
                        var prop = comp.properties[p];
                        if (prop.displayName === "位置" || prop.displayName === "Position") {
                            prop.setValue([1.0, 0.5], true);
                            break;
                        }
                    }
                    break;
                }
            }

            var qeTrack = qeSeq.getVideoTrackAt(6);
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

            // 1. Add GPU Transform effect FIRST
            var tfFx = findQeVideoEffect(["变换", "Transform"]);
            if (tfFx) qeClip.addVideoEffect(tfFx);

            // 2. Add GPU Crop effect SECOND (clips scrolled text cleanly to X=242..1868)
            var cropFx = findQeVideoEffect(["裁剪", "Crop"]);
            if (cropFx) qeClip.addVideoEffect(cropFx);

            var baseIn = clip.inPoint.seconds;
            var speed = 82.0; // px/sec
            var startPause = 1.5;
            var endPause = 1.5;
            var scrollTime = Math.max(1.0, overflowPx / speed);
            var cycle = startPause + scrollTime + endPause;

            for (var c2 = 0; c2 < clip.components.numItems; c2++) {
                var comp2 = clip.components[c2];
                var mName = comp2.matchName || "";
                var dName = comp2.displayName || "";

                if (mName.indexOf("Geometry2") >= 0 || dName === "变换" || dName === "Transform") {
                    for (var p2 = 0; p2 < comp2.properties.numItems; p2++) {
                        var pr2 = comp2.properties[p2];
                        if (pr2.displayName === "位置" || pr2.displayName === "Position") {
                            pr2.setTimeVarying(true);
                            // Transform Position uses normalized [0..1] on the 3840x1080 clip -> center is [0.5, 0.5]
                            var shiftNorm = overflowPx / 3840.0;
                            var tCursor = 0.0;
                            while (tCursor < durSec) {
                                var t0 = secsToTime(baseIn + tCursor);
                                pr2.addKey(t0);
                                pr2.setValueAtKey(t0, [0.5, 0.5], true);

                                var t1Sec = Math.min(durSec, tCursor + startPause);
                                var t1 = secsToTime(baseIn + t1Sec);
                                pr2.addKey(t1);
                                pr2.setValueAtKey(t1, [0.5, 0.5], true);

                                var t2Sec = Math.min(durSec, tCursor + startPause + scrollTime);
                                var frac = (t2Sec - t1Sec) / scrollTime;
                                var t2 = secsToTime(baseIn + t2Sec);
                                pr2.addKey(t2);
                                pr2.setValueAtKey(t2, [0.5 - shiftNorm * frac, 0.5], true);

                                var t3Sec = Math.min(durSec, tCursor + cycle);
                                if (t3Sec > t2Sec + 0.05) {
                                    var t3 = secsToTime(baseIn + t3Sec);
                                    pr2.addKey(t3);
                                    pr2.setValueAtKey(t3, [0.5 - shiftNorm * frac, 0.5], true);
                                }
                                tCursor += cycle;
                            }
                            break;
                        }
                    }
                } else if (mName.indexOf("Crop") >= 0 || dName === "裁剪" || dName === "Crop") {
                    for (var p3 = 0; p3 < comp2.properties.numItems; p3++) {
                        var pr3 = comp2.properties[p3];
                        if (pr3.displayName === "左侧" || pr3.displayName === "Left") {
                            pr3.setValue(6.3, true); // 242 / 3840
                        } else if (pr3.displayName === "右侧" || pr3.displayName === "Right") {
                            pr3.setValue(52.5, true); // (3840 - 1824) / 3840 -> aligns cleanly with Pr native caption right edge (95%)
                        } else if (pr3.displayName === "边缘羽化" || pr3.displayName === "Edge Feather") {
                            pr3.setValue(0, true);
                        }
                    }
                }
            }
            return true;
        } catch (eMq) {
            return false;
        }
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

    function applyFrostedBarEffects(qeSeq, clip, cropBox, beatData, renderedW, renderedH) {
        // True optical glass mask pipeline on V2 (strict GPU effect order):
        //   1. Transform (optional beat-reactive scale/shake matching V1 BEFORE crop!)
        //   2. Gaussian Blur (32, Repeat Edge Pixels)
        //   3. Crop (fixed 4-side sharp screen rectangle -> glass frame stays rock-steady while refracted content moves!)
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

            if (beatData && beatData.keyframes && beatData.keyframes.length > 0) {
                var tfFx = findQeVideoEffect(["变换", "Transform"]);
                if (tfFx) qeClip.addVideoEffect(tfFx);
            }

            var blurFx = findQeVideoEffect(["高斯模糊", "Gaussian Blur"]);
            if (blurFx) {
                qeClip.addVideoEffect(blurFx);
                appliedBlur = true;
            }

            var cropFx = findQeVideoEffect(["裁剪", "Crop"]);
            if (cropFx) {
                qeClip.addVideoEffect(cropFx);
            }

            // 4. Add Drop Shadow AFTER Crop so the entire floating glass rectangle casts a soft 3D shadow onto V1
            var shadowFx = findQeVideoEffect(["投影", "Drop Shadow"]);
            if (shadowFx) {
                qeClip.addVideoEffect(shadowFx);
            }
        } catch (eQE) {}

        // Configure Transform keyframes (if beatData), Gaussian Blur (32), and fixed 4-side sharp Crop
        try {
            for (var c = 0; c < clip.components.numItems; c++) {
                var comp = clip.components[c];
                var mName = comp.matchName || "";
                var dName = comp.displayName || "";

                if (beatData && beatData.keyframes && (mName.indexOf("Geometry2") >= 0 || dName === "变换" || dName === "Transform")) {
                    var tfScale = null;
                    var tfPos = null;
                    for (var pt = 0; pt < comp.properties.numItems; pt++) {
                        var prt = comp.properties[pt];
                        var pn = prt.displayName;
                        // In Pr's Transform effect (Geometry2), uniform scale is controlled by "缩放高度" / "Scale Height"
                        if (pn === "缩放高度" || pn === "Scale Height" || pn === "缩放" || pn === "Scale") {
                            tfScale = prt;
                        } else if (pn === "位置" || pn === "Position") {
                            tfPos = prt;
                        }
                    }
                    if (tfScale && tfPos) {
                        tfScale.setTimeVarying(true);
                        tfPos.setTimeVarying(true);
                        var baseInSec = clip.inPoint.seconds;
                        var rw = renderedW || SEQ_W;
                        var rh = renderedH || SEQ_H;
                        var kfs = beatData.keyframes;
                        for (var ki = 0; ki < kfs.length; ki++) {
                            var kf = kfs[ki];
                            var kt = secsToTime(baseInSec + kf.t);
                            tfScale.addKey(kt);
                            tfScale.setValueAtKey(kt, kf.scale, true);
                            tfPos.addKey(kt);
                            tfPos.setValueAtKey(kt, [0.5 + (kf.dx / rw), 0.5 + (kf.dy / rh)], true);
                        }
                    }
                } else if (mName.indexOf("Gaussian Blur") >= 0 || dName.indexOf("高斯模糊") >= 0 || dName.indexOf("Gaussian Blur") >= 0) {
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
                } else if (mName.indexOf("Drop Shadow") >= 0 || dName === "投影" || dName === "Drop Shadow") {
                    for (var p3 = 0; p3 < comp.properties.numItems; p3++) {
                        var pr3 = comp.properties[p3];
                        var sn = pr3.displayName;
                        if (sn === "不透明度" || sn === "Opacity") {
                            pr3.setValue(65, true);
                        } else if (sn === "方向" || sn === "Direction") {
                            pr3.setValue(180, true);
                        } else if (sn === "距离" || sn === "Distance") {
                            pr3.setValue(10, true);
                        } else if (sn === "柔和度" || sn === "Softness") {
                            pr3.setValue(38, true);
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

    function animateProgressBarClip(qeSeq, clip) {
        // Position 1864x4 white bar right on top edge of floating glass (Y=868, X=960)
        try {
            for (var c = 0; c < clip.components.numItems; c++) {
                var comp = clip.components[c];
                if (comp.matchName === "AE.ADBE Motion" || comp.displayName === "运动" || comp.displayName === "Motion") {
                    for (var p = 0; p < comp.properties.numItems; p++) {
                        var prop = comp.properties[p];
                        if (prop.displayName === "位置" || prop.displayName === "Position") {
                            prop.setValue([960 / SEQ_W, 868 / SEQ_H], true);
                        }
                    }
                    break;
                }
            }
        } catch (ePos) {}

        // Add native GPU-accelerated Crop effect on V6 (track index 5) and keyframe Right: 100% -> 0%
        try {
            var qeTrack = qeSeq.getVideoTrackAt(5);
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

            var cropFx = findQeVideoEffect(["裁剪", "Crop"]);
            if (!cropFx) return false;
            qeClip.addVideoEffect(cropFx);

            for (var c2 = 0; c2 < clip.components.numItems; c2++) {
                var comp2 = clip.components[c2];
                if ((comp2.matchName || "").indexOf("Crop") >= 0 || comp2.displayName === "裁剪" || comp2.displayName === "Crop") {
                    for (var p2 = 0; p2 < comp2.properties.numItems; p2++) {
                        var pr2 = comp2.properties[p2];
                        if (pr2.displayName === "右侧" || pr2.displayName === "Right") {
                            pr2.setTimeVarying(true);
                            var tStart = clip.inPoint;
                            var tEnd = clip.outPoint;
                            pr2.addKey(tStart);
                            pr2.setValueAtKey(tStart, 100.0, true);
                            pr2.addKey(tEnd);
                            pr2.setValueAtKey(tEnd, 0.0, true);
                            return true;
                        }
                    }
                }
            }
        } catch (eProg) {}
        return false;
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
        var lyricMogrtFile = new File(projectRoot + "/templates/lyric_line.mogrt");
        var scrollTitleMogrtFile = new File(projectRoot + "/templates/title_scroll.mogrt");
        var progBarFile = new File(projectRoot + "/templates/progress_bar.png");

        var root = project.rootItem;
        var mvBin = getOrCreateBin(root, "MV素材");
        var coverBin = getOrCreateBin(root, "封面素材");
        var specBin = getOrCreateBin(root, "频谱素材");
        var specialBin = getOrCreateBin(root, "特殊模板成片");
        var progBarItem = progBarFile.exists ? importOrReuse(project, coverBin, progBarFile.fsName, false) : null;

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
                    mediaItem: importOrReuse(project, specialBin, prePath, false),
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
                mediaItem: importOrReuse(project, mvBin, vidPath, false),
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

        // Ensure sequence timebase matches playlist.json fps (default 60fps)
        var targetFps = parseFloat(playlistData.fps) || 60;
        try {
            var settings = targetSeq.getSettings();
            settings.videoFrameRate = secsToTime(1.0 / targetFps);
            targetSeq.setSettings(settings);
        } catch (eFps) {}

        // Ensure at least 8 video tracks (V1..V8; V8 hosts Pr GPU marquee for long song titles)
        var qeSeq = qe.project.getActiveSequence();
        while (targetSeq.videoTracks.numTracks < 8) {
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
        var v6 = targetSeq.videoTracks.numTracks > 5 ? targetSeq.videoTracks[5] : null;
        var v7 = targetSeq.videoTracks.numTracks > 6 ? targetSeq.videoTracks[6] : null;
        var v8 = targetSeq.videoTracks.numTracks > 7 ? targetSeq.videoTracks[7] : null;
        var a1 = targetSeq.audioTracks[0];
        var a2 = targetSeq.audioTracks.numTracks > 1 ? targetSeq.audioTracks[1] : null;

        clearTrack(v1);
        clearTrack(v2);
        clearTrack(v3);
        clearTrack(v4);
        clearTrack(v5);
        clearTrack(v6);
        clearTrack(v7);
        clearTrack(v8);
        clearTrack(a1);
        clearTrack(a2);

        var curTimeSec = 0.0;
        var mogrtWarned = false;
        var v2BlurOkCount = 0;
        var v2TotalCount = 0;
        var v5SpecCount = 0;
        var v6ProgCount = 0;
        var v7LyricCount = 0;
        var v8MarqueeCount = 0;
        var beatMotionCount = 0;

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

            // Optional beat-reactive motion for static-cover MVs (loaded from processed/*_beat.json)
            var beatData = null;
            if (song.beat_motion !== "off" && song.beat_path) {
                beatData = readJsonFile(resolvePath(projectRoot, song.beat_path));
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
                // Keep V2 glass rectangle rock-steady aligned with progress bar & cover (do NOT apply beat shake to V2!)
                if (Math.abs(fitScale - 100.0) > 0.5) {
                    setClipScale(blurClip, fitScale);
                }
                v2TotalCount++;
                if (applyFrostedBarEffects(qeSeq, blurClip, cropBox, beatData, renderedW, renderedH)) {
                    v2BlurOkCount++;
                }
            }

            // V1/A1 SECOND: Crisp original MV (auto-fitted + optional beat motion) + clean single audio track on A1
            v1.overwriteClip(entry.mediaItem, insTime);
            var mainClip = v1.clips[v1.clips.numItems - 1];
            if (beatData) {
                if (applyBeatMotionKeyframes(mainClip, beatData, fitScale)) {
                    beatMotionCount++;
                }
            } else if (Math.abs(fitScale - 100.0) > 0.5) {
                setClipScale(mainClip, fitScale);
            }

            // V3: Zero-expression annual.mogrt (static frame cached in Pr!)
            // If title overflows 1626px (~68 half-width units at 44px serif), move title to V8 Pr native GPU marquee
            var singleLineTitle = String(song.title || "").replace(/\r\n|\r|\n/g, " ").replace(/^\s+|\s+$/g, "");
            var singleLineAlbum = String(song.album || "").replace(/\r\n|\r|\n/g, " ").replace(/^\s+|\s+$/g, "");
            var singleLineArtist = String(song.artist || "").replace(/\r\n|\r|\n/g, " ").replace(/^\s+|\s+$/g, "");
            var titleVisUnits = visualWidth(singleLineTitle);
            var estTitlePx = titleVisUnits * 23.5;
            var useGpuMarquee = (v7 && scrollTitleMogrtFile.exists && estTitlePx > 1580);

            if (v3 && annualMogrtFile.exists) {
                var mogrtClip = targetSeq.importMGT(annualMogrtFile.fsName, secsToTicksStr(curTimeSec), 2, 0);
                if (mogrtClip) {
                    mogrtClip.end = secsToTime(curTimeSec + dur);
                    var mgtComp = mogrtClip.getMGTComponent();
                    if (mgtComp) {
                        setMgtTextProp(mgtComp, "INDEX_TEXT", "#" + pad2(entry.index));
                        setMgtTextProp(mgtComp, "TITLE_TEXT", useGpuMarquee ? "" : singleLineTitle);
                        setMgtTextProp(mgtComp, "ALBUM_TEXT", singleLineAlbum);
                        setMgtTextProp(mgtComp, "ARTIST_TEXT", singleLineArtist);
                        setMgtTextProp(mgtComp, "REASON_TEXT", formatReasonText(song.reason || ""));
                    } else if (!mogrtWarned) {
                        mogrtWarned = true;
                        alert("提示：templates/annual.mogrt 的 getMGTComponent() 返回为空。\n请确认已使用 AE 运行 scripts/build_annual_mogrt_ae.jsx 导出新版模板。");
                    }
                }
            }

            // V7 (index 6): Native Pr GPU 60fps marquee scroll for overflowing long titles (0 AE expressions!)
            if (useGpuMarquee) {
                var mqClip = targetSeq.importMGT(scrollTitleMogrtFile.fsName, secsToTicksStr(curTimeSec), 6, 0);
                if (mqClip) {
                    mqClip.end = secsToTime(curTimeSec + dur);
                    var mqComp = mqClip.getMGTComponent();
                    if (mqComp) {
                        setMgtTextProp(mqComp, "SCROLL_TITLE_TEXT", singleLineTitle);
                    }
                    var overflowPx = Math.max(120, Math.round(estTitlePx - 1582 + 60));
                    if (animateGpuMarqueeTitle(qeSeq, mqClip, dur, overflowPx)) {
                        v8MarqueeCount++;
                    }
                }
            }

            // V4: Official 1:1 album cover flush-left with floating glass bar (186x186)
            if (v4 && entry.coverItem) {
                entry.coverItem.setInPoint(secsToTime(0), 4);
                entry.coverItem.setOutPoint(secsToTime(dur), 4);
                v4.overwriteClip(entry.coverItem, insTime);
                var covClip = v4.clips[v4.clips.numItems - 1];
                covClip.end = secsToTime(curTimeSec + dur);
                positionCoverClip(covClip);
            }

            // V5: Transparent audio spectrum visualizer inside the bottom of the cover
            if (v5 && entry.specItem) {
                entry.specItem.setInPoint(secsToTime(0), 4);
                entry.specItem.setOutPoint(secsToTime(dur), 4);
                v5.overwriteClip(entry.specItem, insTime);
                var specClip = v5.clips[v5.clips.numItems - 1];
                specClip.end = secsToTime(curTimeSec + dur);
                positionSpectrumClip(specClip);
                v5SpecCount++;
            }

            // V6: Native GPU 60fps progress bar (Crop Right 100% -> 0% keyframes)
            if (v6 && progBarItem) {
                progBarItem.setInPoint(secsToTime(0), 4);
                progBarItem.setOutPoint(secsToTime(dur), 4);
                v6.overwriteClip(progBarItem, insTime);
                var progClip = v6.clips[v6.clips.numItems - 1];
                progClip.end = secsToTime(curTimeSec + dur);
                if (animateProgressBarClip(qeSeq, progClip)) {
                    v6ProgCount++;
                }
            }

            curTimeSec += dur;
        }

        // Remove any duplicate audio placed onto A2 by V2 frosted-bar clips
        clearTrack(a2);

        // Apply configurable song-to-song video & audio transitions
        var transApplied = applyTrackTransitions(qeSeq, playlistData.transition || {}, targetFps);

        // Import timeline-aligned bilingual SRT into Premiere Pro Native Caption Track (0 AE CPU overhead!)
        var srtStatus = "未找到 output/lyrics_timeline.srt";
        var srtFile = new File(projectRoot + "/output/lyrics_timeline.srt");
        var srtBin = getOrCreateBin(root, "字幕素材");
        if (srtFile.exists) {
            var srtItem = importOrReuse(project, srtBin, srtFile.fsName, true);
            if (srtItem) {
                var addedCaption = false;
                try {
                    if (typeof targetSeq.createCaptionTrack === "function") {
                        addedCaption = targetSeq.createCaptionTrack(srtItem, 0);
                    }
                } catch (eCap) {}
                srtStatus = addedCaption
                    ? "已自动创建 Pr 原生字幕轨 (C1)"
                    : "已导入「字幕素材」Bin（直接拖入时间线即可生成 C1 原生字幕轨）";
            }
        }

        // Auto-import reusable caption track style (templates/推歌.prtextstyle) if not already in project
        var styleFile = new File(projectRoot + "/templates/推歌.prtextstyle");
        if (styleFile.exists) {
            var hasStyle = false;
            try {
                for (var si = 0; si < root.children.numItems; si++) {
                    if (root.children[si].name === "推歌") { hasStyle = true; break; }
                }
                if (!hasStyle) {
                    for (var sbi = 0; sbi < srtBin.children.numItems; sbi++) {
                        if (srtBin.children[sbi].name === "推歌") { hasStyle = true; break; }
                    }
                }
                if (!hasStyle) {
                    project.importFiles([styleFile.fsName], true, srtBin, false);
                }
            } catch (eSty) {}
            srtStatus += "（轨道样式「推歌」已自动加载，在 C1 下拉框一键选用）";
        }

        var msg = "assemble_v2.jsx 组装完成！\n"
            + "序列：" + seqName + " (" + targetFps + "fps)\n"
            + "已装配曲目：" + prepared.length + " 首\n"
            + "V1 切歌转场：" + transApplied + " 处 | 封面律动：" + beatMotionCount + " 首\n"
            + "V2 悬浮毛玻璃：" + v2BlurOkCount + " / " + v2TotalCount + "\n"
            + "V5 音频频谱：" + v5SpecCount + " / " + prepared.length + " | V6 GPU进度条：" + v6ProgCount + " / " + prepared.length + "\n"
            + "V7 GPU跑马灯：" + v8MarqueeCount + " 首\n"
            + "C1 原生双语字幕：" + srtStatus + "\n"
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
