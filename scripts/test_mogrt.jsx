/**
 * scripts/test_mogrt.jsx — Premiere Pro 2025 路线 A (.mogrt) 最小 API 实测脚本
 *
 * 兼容：VS Code ExtendScript Debugger / CEP MCP Bridge / Pr 脚本运行
 * 特点：
 * - 全程 try/catch 兜底，任何异常都会写入 scripts/mogrt_probe_report.txt 并返回字符串
 * - 自动搜索项目 templates/annual.mogrt 或 Windows 本机内置 .mogrt，找不到再弹窗
 */

(function () {
    var logLines = [];
    function log(msg) {
        logLines.push(String(msg));
        try { $.writeln(String(msg)); } catch (e) {}
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

        var mgtComp = importedClip.getMGTComponent();
        if (!mgtComp) {
            log("WARN: getMGTComponent() returned null");
            writeReport(logLines);
            alert("导入成功，但 getMGTComponent() 为空。");
            return logLines.join("\n");
        }

        var props = mgtComp.properties;
        log("Total MGT Properties: " + props.numItems);
        log("");

        var summary = [];
        var textTested = false;
        for (var i = 0; i < props.numItems; i++) {
            var p = props[i];
            var valStr = "";
            try { valStr = String(p.getValue()); } catch (eVal) { valStr = "<err: " + eVal + ">"; }
            var hasSetMedia = (typeof p.setMediaFilePath === "function");
            var hasGetMedia = (typeof p.getMediaFilePath === "function");

            log(
                "[" + i + "] displayName=" + p.displayName
                + " | matchName=" + p.matchName
                + " | value=" + valStr.substring(0, 80).replace(/\r|\n/g, " ")
                + " | setMediaFilePath=" + hasSetMedia
                + " | getMediaFilePath=" + hasGetMedia
            );

            if (i < 10) {
                summary.push("[" + i + "] " + p.displayName + " (setMedia=" + hasSetMedia + ")");
            }

            if (!textTested && valStr.indexOf("textEditValue") >= 0) {
                try {
                    var parsed = eval("(" + valStr + ")");
                    parsed.textEditValue = "Pr2025 API 实测成功";
                    if (typeof JSON !== "undefined" && JSON.stringify) {
                        p.setValue(JSON.stringify(parsed), true);
                        log("  -> Tested JSON textEditValue setValue(): OK");
                        textTested = true;
                    }
                } catch (eTxt) {
                    log("  -> Text setValue test error: " + eTxt);
                }
            }
        }

        var reportPath = writeReport(logLines);
        alert("MOGRT 实测完成！共 " + props.numItems + " 个属性。\n报告: " + reportPath + "\n\n" + summary.join("\n"));
        return logLines.join("\n");
    } catch (fatal) {
        log("FATAL ERROR: " + fatal + " (line " + (fatal.line || "?") + ")");
        var rp = writeReport(logLines);
        try { alert("脚本异常: " + fatal + "\n日志已写入: " + rp); } catch (e2) {}
        return logLines.join("\n");
    }
})();
