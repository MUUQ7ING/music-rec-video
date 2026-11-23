/**
 * scripts/test_mogrt.jsx — Premiere Pro 2025 路线 A (.mogrt) 全面 API 实测脚本
 *
 * 兼容：VS Code ExtendScript Debugger / CEP MCP Bridge / Pr 脚本运行
 * 特性：
 * 1. 自动兼容 AE 导出 .mogrt（getMGTComponent()）与 Pr 原生 .mogrt（importedClip.components 回退）
 * 2. 自带 ES3 兼容 JSON 序列化工具，实测中文 + 换行符写入（textEditValue）
 * 3. 自动探测媒体替换 API（setMediaFilePath / getMediaFilePath）
 * 4. 全程 try/catch 兜底，详细报告写入 scripts/mogrt_probe_report.txt
 */

(function () {
    var logLines = [];
    function log(msg) {
        logLines.push(String(msg));
        try { $.writeln(String(msg)); } catch (e) {}
    }

    // Minimal ES3-safe JSON serializer for ExtendScript
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

    var projectRoot = "D:/prworks/music-rec-video";
    try {
        if ($.fileName) {
            var f = new File($.fileName);
            if (f.parent && f.parent.parent) {
                projectRoot = f.parent.parent.fsName.replace(/\\/g, "/");
            }
        }
    } catch (e) {}

    function writeReport(lines) {
        try {
            var rf = new File(projectRoot + "/scripts/mogrt_probe_report.txt");
            rf.encoding = "UTF-8";
            rf.open("w");
            rf.write(lines.join("\n"));
            rf.close();
            return rf.fsName;
        } catch (eWrite) {
            return "write error: " + eWrite;
        }
    }

    function findAnyMogrt() {
        var candidates = [
            projectRoot + "/templates/annual.mogrt"
        ];
        try {
            var appData = Folder.userData.fsName.replace(/\\/g, "/");
            candidates.push(appData + "/Adobe/Common/Motion Graphics Templates");
        } catch (e1) {}
        candidates.push("C:/Program Files/Adobe/Adobe Premiere Pro 2025/Essential Graphics");

        for (var i = 0; i < candidates.length; i++) {
            var p = candidates[i];
            if (p.indexOf(".mogrt") > 0) {
                var mf = new File(p);
                if (mf.exists) return mf;
            } else {
                var dir = new Folder(p);
                if (dir.exists) {
                    var files = dir.getFiles("*.mogrt");
                    if (files && files.length > 0) {
                        return files[0];
                    }
                }
            }
        }
        return null;
    }

    function probeProperties(props, prefix, summary, state) {
        for (var i = 0; i < props.numItems; i++) {
            var p = props[i];
            var valStr = "";
            try { valStr = String(p.getValue()); } catch (eVal) { valStr = "<err: " + eVal + ">"; }
            var hasSetMedia = (typeof p.setMediaFilePath === "function");
            var hasGetMedia = (typeof p.getMediaFilePath === "function");

            if (hasSetMedia || hasGetMedia) {
                state.mediaPropCount++;
            }

            log(
                prefix + "[" + i + "] displayName=" + p.displayName
                + " | matchName=" + p.matchName
                + " | value=" + valStr.substring(0, 100).replace(/\r|\n/g, " ")
                + " | setMedia=" + hasSetMedia
                + " | getMedia=" + hasGetMedia
            );

            if (summary.length < 12) {
                summary.push(prefix + "[" + i + "] " + p.displayName + " (setMedia=" + hasSetMedia + ")");
            }

            // Test writing Chinese + newline into the first textEditValue JSON property
            if (!state.textTested && valStr.indexOf("textEditValue") >= 0) {
                try {
                    var parsed = eval("(" + valStr + ")");
                    parsed.textEditValue = "#01 年度推荐\r中文与换行写入成功";
                    var serialized = (typeof JSON !== "undefined" && JSON.stringify)
                        ? JSON.stringify(parsed)
                        : toJson(parsed);
                    p.setValue(serialized, true);
                    var verifyVal = "";
                    try { verifyVal = String(p.getValue()); } catch (eV) {}
                    var verified = (verifyVal.indexOf("中文与换行写入成功") >= 0);
                    log("  -> Tested JSON textEditValue setValue(): " + (verified ? "VERIFIED OK" : "CALLED (verify=" + verifyVal.substring(0, 80) + ")"));
                    state.textTested = true;
                    state.textVerified = verified;
                } catch (eTxt) {
                    log("  -> Text setValue test error: " + eTxt);
                }
            }
        }
    }

    try {
        log("=== Premiere Pro .mogrt API Probe Report ===");
        log("Pr Version: " + app.version);
        log("ProjectRoot: " + projectRoot);

        var project = app.project;
        if (!project) {
            log("ERROR: app.project is null (请先打开一个项目)");
            writeReport(logLines);
            alert("请先在 Premiere Pro 中打开或新建一个项目！");
            return logLines.join("\n");
        }

        var seq = project.activeSequence;
        if (!seq && project.sequences.numSequences > 0) {
            seq = project.sequences[0];
            project.activeSequence = seq;
        }
        if (!seq) {
            log("ERROR: activeSequence is null (请先新建或打开一个序列)");
            writeReport(logLines);
            alert("未找到活动序列，请先打开一个序列后再运行！");
            return logLines.join("\n");
        }
        log("Sequence: " + seq.name);

        var mogrtFile = findAnyMogrt();
        if (!mogrtFile) {
            mogrtFile = File.openDialog("请选择任意一个 .mogrt 模板文件", "*.mogrt");
        }
        if (!mogrtFile || !mogrtFile.exists) {
            log("CANCELLED: 未找到或未选择 .mogrt 文件");
            writeReport(logLines);
            alert("未找到或未选择 .mogrt 文件。");
            return logLines.join("\n");
        }
        log("MOGRT: " + mogrtFile.fsName);

        var importedClip = seq.importMGT(mogrtFile.fsName, "0", 2, 0);
        if (!importedClip) {
            log("ERROR: seq.importMGT returned null");
            writeReport(logLines);
            alert("seq.importMGT 返回 null，请检查 V3 轨道是否存在。");
            return logLines.join("\n");
        }

        log("Imported Clip: " + importedClip.name);
        log("Duration (sec): " + (importedClip.end.seconds - importedClip.start.seconds));

        var summary = [];
        var state = { textTested: false, textVerified: false, mediaPropCount: 0 };
        var mode = "";

        var mgtComp = importedClip.getMGTComponent();
        if (mgtComp) {
            mode = "AE-MOGRT (getMGTComponent)";
            log("Mode: " + mode);
            log("Total MGT Properties: " + mgtComp.properties.numItems);
            log("");
            probeProperties(mgtComp.properties, "", summary, state);
        } else {
            mode = "Pr-Native-MOGRT (components fallback)";
            log("WARN: getMGTComponent() returned null -> falling back to importedClip.components");
            var comps = importedClip.components;
            log("Total Components on Clip: " + (comps ? comps.numItems : 0));
            log("");
            if (comps) {
                for (var c = 0; c < comps.numItems; c++) {
                    var comp = comps[c];
                    var cName = comp.displayName || "";
                    var cMatch = comp.matchName || "";
                    log("--- Component [" + c + "] displayName=" + cName + " | matchName=" + cMatch + " | props=" + comp.properties.numItems + " ---");
                    // Skip standard intrinsic components (Motion / Opacity / Time Remapping)
                    if (cMatch === "AE.ADBE Motion" || cMatch === "AE.ADBE Opacity" || cMatch === "AE.ADBE Time Remapping") {
                        continue;
                    }
                    probeProperties(comp.properties, "C" + c + ".", summary, state);
                }
            }
        }

        var reportPath = writeReport(logLines);
        alert(
            "MOGRT 实测完成！\n"
            + "模式: " + mode + "\n"
            + "中文+换行写入: " + (state.textVerified ? "成功" : (state.textTested ? "已调用(见报告)" : "未发现文本属性")) + "\n"
            + "媒体替换属性数: " + state.mediaPropCount + "\n"
            + "报告: " + reportPath + "\n\n"
            + summary.join("\n")
        );
        return logLines.join("\n");
    } catch (fatal) {
        log("FATAL ERROR: " + fatal + " (line " + (fatal.line || "?") + ")");
        var rp = writeReport(logLines);
        try { alert("脚本异常: " + fatal + "\n日志已写入: " + rp); } catch (e2) {}
        return logLines.join("\n");
    }
})();
