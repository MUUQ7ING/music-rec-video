/**
 * scripts/build_annual_mogrt_ae.jsx
 *
 * After Effects ExtendScript: Builds and exports ZERO-EXPRESSION, static-frame-cached MOGRT templates:
 *   1. templates/annual.mogrt       (1920x1080 @ 30fps, 0 expressions, 0 track mattes -> Pr caches static frames!)
 *   2. templates/title_scroll.mogrt (3840x1080 @ 30fps, wide single-line title for Pr native GPU marquee!)
 *   3. templates/lyric_line.mogrt   (1920x1080 @ 30fps, 0 expressions, right-aligned bilingual lyrics)
 *   4. templates/intro.mogrt        (1920x1080 @ 30fps, centered serif intro text card)
 *   5. templates/annual_master.aep  (Editable master AE project)
 */

(function () {
    app.beginUndoGroup("Build Zero-Expression GPU-Friendly MOGRT Templates");
    var currentStep = "init";
    var SILENT = ($.getenv("AE_SHOW_ALERTS") !== "1");

    function writeAeLog(projectRoot, msg) {
        try {
            var lf = new File(projectRoot + "/scripts/ae_build_report.txt");
            lf.encoding = "UTF-8";
            lf.open("w");
            lf.write(msg);
            lf.close();
        } catch (eLog) {}
    }

    try {
        currentStep = "check_security_pref";
        try {
            var canWrite = app.preferences.getPrefAsLong("Main Pref Section", "Pref_SCRIPTING_FILE_NETWORK_SECURITY");
            if (canWrite !== 1) {
                alert("请先在 After Effects 中开启脚本写入权限：\n\n编辑 (Edit) → 首选项 (Preferences) → 脚本和表达式 (Scripting & Expressions)\n勾选「允许脚本写入文件和访问网络」后重新运行本脚本！");
                return;
            }
        } catch (ePref) {}

        currentStep = "resolve_paths";
        var projectRoot = "D:/prworks/music-rec-video";
        try {
            if ($.fileName) {
                var sf = new File($.fileName);
                if (sf.parent && sf.parent.parent) {
                    projectRoot = sf.parent.parent.fsName.replace(/\\/g, "/");
                }
            }
        } catch (ePath) {}

        var templatesDir = new Folder(projectRoot + "/templates");
        if (!templatesDir.exists) {
            templatesDir.create();
        }

        // Verified installed Noto Serif SC PostScript names (instant, no slow font scan)
        var FONT_BOLD = "NotoSerifSC-SemiBold";
        var FONT_REGULAR = "NotoSerifSC-Medium";

        if (app.project && app.project.numItems > 0) {
            app.newProject();
        }

        var COMP_W = 1920;
        var COMP_H = 1080;
        var COMP_FPS = 30;

        // Floating glass geometry (X=28..1892, Y=870..1056)
        var BAR_LEFT = 28;
        var BAR_RIGHT = 1892;
        var BAR_W = BAR_RIGHT - BAR_LEFT; // 1864
        var BAR_TOP = 870;
        var BAR_CX = BAR_LEFT + BAR_W / 2; // 960

        /** Helper: add clean static dark drop shadow (zero expressions -> maximum Pr cache speed) */
        function addDropShadow(layer, opacity255, directionDeg, distancePx, softnessPx) {
            var fx = layer.property("ADBE Effect Parade").addProperty("ADBE Drop Shadow");
            if (!fx) return;
            try { fx.property("ADBE Drop Shadow-0001").setValue([0, 0, 0, 1]); } catch (e) {}
            try { fx.property("ADBE Drop Shadow-0002").setValue(opacity255); } catch (e) {}
            try { fx.property("ADBE Drop Shadow-0003").setValue(directionDeg); } catch (e) {}
            try { fx.property("ADBE Drop Shadow-0004").setValue(distancePx); } catch (e) {}
            try { fx.property("ADBE Drop Shadow-0005").setValue(softnessPx); } catch (e) {}
        }

        /** Helper: gentle fade-in on opacity */
        function addFadeIn(layer, fadeSec, targetOpacity) {
            var op = layer.property("ADBE Transform Group").property("ADBE Opacity");
            op.setValueAtTime(0, 0);
            op.setValueAtTime(fadeSec, targetOpacity);
        }

        /** Helper: create exposed text layer (zero expressions, zero track mattes) */
        function createExposedTextLayer(comp, cfg) {
            currentStep = "create_layer_" + cfg.name;
            var layer = comp.layers.addText(cfg.defaultText);
            layer.name = cfg.name;

            var textProp = layer.property("ADBE Text Properties").property("ADBE Text Document");
            var doc = textProp.value;
            doc.resetCharStyle();
            doc.fontSize = cfg.fontSize;
            doc.fillColor = cfg.fillColor || [1, 1, 1];
            doc.applyFill = true;
            doc.applyStroke = false;
            try { doc.font = cfg.font; } catch (eF1) {
                try { doc.font = "SimSun"; } catch (eF2) {}
            }
            doc.justification = cfg.justification;
            if (cfg.leading) doc.leading = cfg.leading;
            if (cfg.tracking) doc.tracking = cfg.tracking;
            textProp.setValue(doc);

            layer.property("ADBE Transform Group").property("ADBE Position").setValue(cfg.position);
            if (cfg.fadeSec && cfg.fadeSec > 0) {
                addFadeIn(layer, cfg.fadeSec, 100);
            }

            if (cfg.shadows) {
                for (var s = 0; s < cfg.shadows.length; s++) {
                    var sh = cfg.shadows[s];
                    addDropShadow(layer, sh[0], sh[1], sh[2], sh[3]);
                }
            }

            currentStep = "expose_egp_" + cfg.name;
            if (typeof textProp.addToMotionGraphicsTemplateAs === "function") {
                textProp.addToMotionGraphicsTemplateAs(comp, cfg.name);
            } else {
                textProp.addToMotionGraphicsTemplate(comp);
            }
            return layer;
        }

        // =========================================================================
        // 1. `annual.mogrt` (1920x1080 @ 30fps, 0 expressions, 0 track mattes)
        // =========================================================================
        var annualComp = app.project.items.addComp("annual", COMP_W, COMP_H, 1.0, 60.0, COMP_FPS);
        annualComp.motionGraphicsTemplateName = "annual";

        // Top-left #Index
        createExposedTextLayer(annualComp, {
            name: "INDEX_TEXT",
            defaultText: "#01",
            font: FONT_BOLD,
            fontSize: 82,
            fillColor: [1, 1, 1],
            justification: ParagraphJustification.LEFT_JUSTIFY,
            tracking: 16,
            position: [34, 106],
            fadeSec: 0.35,
            shadows: [[245, 135, 3, 12]]
        });

        // Row 1: Song Title (left blank by assemble_v2.jsx when long title uses Pr GPU marquee track)
        createExposedTextLayer(annualComp, {
            name: "TITLE_TEXT",
            defaultText: "Song Title",
            font: FONT_BOLD,
            fontSize: 44,
            fillColor: [1, 1, 1],
            justification: ParagraphJustification.LEFT_JUSTIFY,
            tracking: 6,
            position: [242, 932],
            fadeSec: 0.35,
            shadows: [[250, 135, 3, 11]]
        });

        // Row 2: Album Name
        createExposedTextLayer(annualComp, {
            name: "ALBUM_TEXT",
            defaultText: "Album Name",
            font: FONT_REGULAR,
            fontSize: 26,
            fillColor: [0.92, 0.94, 0.98],
            justification: ParagraphJustification.LEFT_JUSTIFY,
            tracking: 10,
            position: [242, 982],
            fadeSec: 0.35,
            shadows: [[245, 135, 2, 10]]
        });

        // Row 3: Artist Name
        createExposedTextLayer(annualComp, {
            name: "ARTIST_TEXT",
            defaultText: "Artist Name",
            font: FONT_REGULAR,
            fontSize: 24,
            fillColor: [0.86, 0.90, 0.95],
            justification: ParagraphJustification.LEFT_JUSTIFY,
            tracking: 12,
            position: [242, 1024],
            fadeSec: 0.35,
            shadows: [[245, 135, 2, 10]]
        });

        // Top-right Recommendation Reason (preserves user's exact line breaks)
        createExposedTextLayer(annualComp, {
            name: "REASON_TEXT",
            defaultText: "在这里填写你的推荐语\r支持多行换行展示",
            font: FONT_BOLD,
            fontSize: 42,
            leading: 58,
            fillColor: [1, 1, 1],
            justification: ParagraphJustification.RIGHT_JUSTIFY,
            tracking: 10,
            position: [1884, 96],
            fadeSec: 0.4,
            shadows: [[250, 135, 3, 13]]
        });

        currentStep = "export_annual_mogrt";
        var annualExportOk = annualComp.exportAsMotionGraphicsTemplate(true, templatesDir.fsName);

        // =========================================================================
        // 2. `title_scroll.mogrt` (3840x1080 @ 30fps, wide canvas for Pr native GPU marquee!)
        // =========================================================================
        currentStep = "build_title_scroll_comp";
        var scrollComp = app.project.items.addComp("title_scroll", 3840, COMP_H, 1.0, 60.0, COMP_FPS);
        scrollComp.motionGraphicsTemplateName = "title_scroll";

        createExposedTextLayer(scrollComp, {
            name: "SCROLL_TITLE_TEXT",
            defaultText: "Long Song Title For Pr GPU Marquee",
            font: FONT_BOLD,
            fontSize: 44,
            fillColor: [1, 1, 1],
            justification: ParagraphJustification.LEFT_JUSTIFY,
            tracking: 6,
            position: [242, 932],
            fadeSec: 0.35,
            shadows: [[250, 135, 3, 11]]
        });

        currentStep = "export_title_scroll_mogrt";
        var scrollExportOk = scrollComp.exportAsMotionGraphicsTemplate(true, templatesDir.fsName);

        // =========================================================================
        // 3. `lyric_line.mogrt` (1920x1080 @ 30fps, 0 expressions, bilingual lyrics)
        // =========================================================================
        currentStep = "build_lyric_comp";
        var lyricComp = app.project.items.addComp("lyric_line", COMP_W, COMP_H, 1.0, 15.0, COMP_FPS);
        lyricComp.motionGraphicsTemplateName = "lyric_line";

        createExposedTextLayer(lyricComp, {
            name: "LYRIC_ORIG",
            defaultText: "飾らないで話せたら いいね",
            font: FONT_REGULAR,
            fontSize: 30,
            fillColor: [1, 1, 1],
            justification: ParagraphJustification.RIGHT_JUSTIFY,
            tracking: 8,
            position: [1868, 950],
            fadeSec: 0.15,
            shadows: [[245, 135, 2, 11]]
        });

        createExposedTextLayer(lyricComp, {
            name: "LYRIC_TRANS",
            defaultText: "若能不加藻饰地说出来 就好",
            font: FONT_REGULAR,
            fontSize: 25,
            fillColor: [0.92, 0.94, 0.98],
            justification: ParagraphJustification.RIGHT_JUSTIFY,
            tracking: 8,
            position: [1868, 992],
            fadeSec: 0.15,
            shadows: [[240, 135, 2, 10]]
        });

        currentStep = "export_lyric_mogrt";
        var lyricExportOk = lyricComp.exportAsMotionGraphicsTemplate(true, templatesDir.fsName);

        // =========================================================================
        // 4. `intro.mogrt` (1920x1080 @ 30fps, optional opening monologue)
        // =========================================================================
        currentStep = "build_intro_comp";
        var introComp = app.project.items.addComp("intro", COMP_W, COMP_H, 1.0, 30.0, COMP_FPS);
        introComp.motionGraphicsTemplateName = "intro";

        createExposedTextLayer(introComp, {
            name: "INTRO_TEXT",
            defaultText: "2026 年度私藏歌单\r献给每一个听歌的夜晚",
            font: FONT_REGULAR,
            fontSize: 44,
            leading: 72,
            fillColor: [1, 1, 1],
            justification: ParagraphJustification.CENTER_JUSTIFY,
            tracking: 30,
            position: [COMP_W / 2, COMP_H / 2 - 20],
            fadeSec: 0.8,
            shadows: [[220, 135, 3, 14]]
        });

        currentStep = "export_intro_mogrt";
        var introExportOk = introComp.exportAsMotionGraphicsTemplate(true, templatesDir.fsName);

        currentStep = "save_master_aep";
        var masterAep = new File(templatesDir.fsName + "\\annual_master.aep");
        app.project.save(masterAep);

        var doneMsg = "零表达式极速 MOGRT 模板导出完成！\n\n"
            + "annual.mogrt: " + (annualExportOk ? "成功" : "请检查") + "\n"
            + "title_scroll.mogrt (Pr GPU跑马灯): " + (scrollExportOk ? "成功" : "请检查") + "\n"
            + "lyric_line.mogrt: " + (lyricExportOk ? "成功" : "请检查") + "\n"
            + "intro.mogrt: " + (introExportOk ? "成功" : "请检查") + "\n"
            + "母版工程: " + masterAep.fsName;
        writeAeLog(projectRoot, doneMsg);
        if (!SILENT) {
            alert(doneMsg);
        }
    } catch (err) {
        var errMsg = (err && err.message) ? String(err.message) : String(err);
        var errLine = (err && err.line) ? String(err.line) : "?";
        var failMsg = "AE 模板生成失败\n步骤: " + currentStep + "\n行号: " + errLine + "\n详情: " + errMsg;
        writeAeLog("D:/prworks/music-rec-video", failMsg);
        if (!SILENT) {
            alert(failMsg);
        }
    } finally {
        app.endUndoGroup();
    }
})();
