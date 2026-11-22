/**
 * scripts/test_mogrt.jsx — Premiere Pro 2025 路线 A (.mogrt) 最小 API 实测脚本
 *
 * 用法（在 Windows Premiere Pro 2025 中）：
 *   文件 -> 脚本 -> 运行脚本 -> 选择 scripts/test_mogrt.jsx
 *   (或通过 VS Code ExtendScript Debugger / MCP Bridge 执行)
 *
 * 功能：
 * 1. 自动查找 templates/annual.mogrt，若不存在则弹窗让你选择任意 .mogrt 文件
 * 2. 调用 seq.importMGT(...) 导入到活动序列的 V3 轨道 (index=2)
 * 3. 枚举 getMGTComponent().properties，检测文字属性与媒体替换（封面图）API 支持情况
 * 4. 尝试修改第一个文本属性并保存详细报告到 scripts/mogrt_probe_report.txt
 */

(function () {
    var project = app.project;
    if (!project) {
        alert("请先在 Premiere Pro 中打开或新建一个项目！");
        return;
    }

    var seq = project.activeSequence;
    if (!seq && project.sequences.numSequences > 0) {
        seq = project.sequences[0];
        project.activeSequence = seq;
    }
    if (!seq) {
        alert("未找到活动序列，请先新建一个 1920x1080 序列后再运行！");
        return;
    }

    var scriptDir = "";
    try {
        if ($.fileName) {
            scriptDir = File($.fileName).parent.fsName.replace(/\\/g, "/");
        }
    } catch (e) {}

    var projectRoot = scriptDir ? scriptDir.replace(/\/scripts$/, "") : "D:/prworks/music-rec-video";
    var defaultMogrt = new File(projectRoot + "/templates/annual.mogrt");
    var mogrtFile = defaultMogrt.exists
        ? defaultMogrt
        : File.openDialog("请选择任意一个 .mogrt 模板文件进行 Pr 2025 API 实测", "Motion Graphics Template:*.mogrt");

    if (!mogrtFile || !mogrtFile.exists) {
        alert("未选择 .mogrt 文件，已取消测试。");
        return;
    }

    var reportLines = [];
    reportLines.push("=== Premiere Pro .mogrt API Probe Report ===");
    reportLines.push("Pr Version: " + app.version);
    reportLines.push("Sequence: " + seq.name);
    reportLines.push("MOGRT: " + mogrtFile.fsName);
    reportLines.push("");

    // importMGT(path, timeInTicks, videoTrackOffset, audioTrackOffset)
    var importedClip = null;
    try {
        importedClip = seq.importMGT(mogrtFile.fsName, "0", 2, 0);
    } catch (err) {
        alert("seq.importMGT 调用失败: " + err);
        return;
    }

    if (!importedClip) {
        alert("seq.importMGT 返回 null，请检查 V3 轨道是否存在或模板是否兼容。");
        return;
    }

    reportLines.push("Imported Clip Name: " + importedClip.name);
    reportLines.push("Clip Duration (sec): " + (importedClip.end.seconds - importedClip.start.seconds));

    var mgtComp = null;
    try {
        mgtComp = importedClip.getMGTComponent();
    } catch (err2) {
        reportLines.push("getMGTComponent() error: " + err2);
    }

    if (!mgtComp) {
        alert("导入成功，但 clip.getMGTComponent() 为空（该模板可能未暴露基本图形参数）。");
        return;
    }

    var props = mgtComp.properties;
    reportLines.push("Total MGT Properties: " + props.numItems);
    reportLines.push("");

    var summaryLines = [];
    var textTested = false;

    for (var i = 0; i < props.numItems; i++) {
        var p = props[i];
        var valStr = "";
        try {
            valStr = String(p.getValue());
        } catch (eVal) {
            valStr = "<getValue error: " + eVal + ">";
        }

        var hasSetMedia = (typeof p.setMediaFilePath === "function");
        var hasGetMedia = (typeof p.getMediaFilePath === "function");
        var line = "[" + i + "] displayName=" + p.displayName
            + " | matchName=" + p.matchName
            + " | value=" + valStr.substring(0, 80).replace(/\r|\n/g, " ")
            + " | setMediaFilePath=" + hasSetMedia
            + " | getMediaFilePath=" + hasGetMedia;
        reportLines.push(line);

        if (i < 12) {
            summaryLines.push("[" + i + "] " + p.displayName + " (setMedia=" + hasSetMedia + ")");
        }

        // Probe updating the first string-like property (often JSON text payload in AE/Pr MOGRTs)
        if (!textTested && valStr.indexOf("textEditValue") >= 0) {
            try {
                var parsed = eval("(" + valStr + ")");
                parsed.textEditValue = "Pr2025 API 实测成功";
                // Serialize back simply if JSON exists, else skip
                if (typeof JSON !== "undefined" && JSON.stringify) {
                    p.setValue(JSON.stringify(parsed), true);
                    reportLines.push("  -> Tested JSON textEditValue setValue(): OK");
                    textTested = true;
                }
            } catch (eTxt) {
                reportLines.push("  -> Text setValue test error: " + eTxt);
            }
        }
    }

    var reportFile = new File(projectRoot + "/scripts/mogrt_probe_report.txt");
    reportFile.encoding = "UTF-8";
    reportFile.open("w");
    reportFile.write(reportLines.join("\n"));
    reportFile.close();

    alert(
        "MOGRT 实测完成！共发现 " + props.numItems + " 个属性。\n"
        + "详细报告已写入:\n" + reportFile.fsName + "\n\n"
        + "前几项属性:\n" + summaryLines.join("\n")
    );
})();
