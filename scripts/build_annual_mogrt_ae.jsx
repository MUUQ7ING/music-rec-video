/**
 * scripts/build_annual_mogrt_ae.jsx
 *
 * After Effects ExtendScript: Builds and exports:
 *   1. templates/annual.mogrt  (Floating light frosted-glass bar + real-time progress bar + serif typography)
 *   2. templates/intro.mogrt   (Centered serif intro text card)
 *   3. templates/annual_master.aep (Editable master AE project)
 *
 * Layout (1920x1080 @ 30fps):
 *   - Floating Glass Bar: X = 42..1878 (W=1836), Y = 898..1054 (H=156), sharp 90-deg corners,
 *     26px bottom gap & 42px side gaps revealing crisp original MV underneath.
 *     Light cool-white tint (#EFF4F9, 32% opacity) + 1px crisp glass highlight border.
 *   - Progress Bar: Directly on top edge of the glass bar (Y=896, W=1836, H=4),
 *     driven by exposed Essential Graphics slider `DURATION_SEC`.
 *   - Left 1:1 Cover slot (placed on Pr V4): 156x156 flush with glass bar (X=42..198, Y=898..1054).
 *   - Title & Artist: Right of cover (X=222), pure white serif + strong dark drop shadows.
 *   - Top-left #INDEX_TEXT & Top-right REASON_TEXT: Pure white serif + strong dark drop shadows.
 */

(function () {
    app.beginUndoGroup("Build Floating Glass Annual & Intro MOGRT");
    var currentStep = "init";
    var SILENT = ($.getenv("AE_SHOW_ALERTS") !== "1");
    // Note: Do NOT call app.beginSuppressDialogs() here, as it auto-cancels AE's font warning dialog on MOGRT export!

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
        // Check AE preference: Allow Scripts to Write Files and Access Network
        currentStep = "check_security_pref";
        try {
            var canWrite = app.preferences.getPrefAsLong("Main Pref Section", "Pref_SCRIPTING_FILE_NETWORK_SECURITY");
            if (canWrite !== 1) {
                alert("请先在 After Effects 中开启脚本写入权限：\n\n编辑 (Edit) → 首选项 (Preferences) → 脚本和表达式 (Scripting & Expressions)\n勾选「允许脚本写入文件和访问网络」后重新运行本脚本！");
                return;
            }
        } catch (ePref) {}

        // Resolve project root and templates directory
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

        // Detect best installed Chinese serif font (prefer Noto Serif SC / Source Han Serif, fallback SimSun)
        function pickSerifFont(preferBold) {
            var fallback = "SimSun";
            try {
                if (app.fonts && app.fonts.allFonts) {
                    var families = app.fonts.allFonts;
                    var bestBold = null;
                    var bestRegular = null;
                    for (var i = 0; i < families.length; i++) {
                        var group = families[i];
                        for (var j = 0; j < group.length; j++) {
                            var f = group[j];
                            var ps = String(f.postScriptName || "");
                            var lower = ps.toLowerCase();
                            if (lower.indexOf("notoserifsc") >= 0 || lower.indexOf("sourcehanserif") >= 0) {
                                if (lower.indexOf("semibold") >= 0 || lower.indexOf("bold") >= 0) {
                                    if (!bestBold) bestBold = ps;
                                } else if (lower.indexOf("regular") >= 0 || lower.indexOf("medium") >= 0 || !bestRegular) {
                                    bestRegular = ps;
                                }
                            }
                        }
                    }
                    if (preferBold && bestBold) return bestBold;
                    if (bestRegular) return bestRegular;
                    if (bestBold) return bestBold;
                }
            } catch (eFont) {}
            return fallback;
        }

        var FONT_BOLD = pickSerifFont(true);
        var FONT_REGULAR = pickSerifFont(false);

        if (app.project && app.project.numItems > 0) {
            app.newProject();
        }

        var COMP_W = 1920;
        var COMP_H = 1080;
        var COMP_FPS = 30;

        // Floating glass bar geometry (matches reference: tall ~186px, narrow 28px side gaps & 24px bottom gap)
        var BAR_LEFT = 28;
        var BAR_RIGHT = 1892;
        var BAR_W = BAR_RIGHT - BAR_LEFT; // 1864
        var BAR_H = 186;
        var BAR_BOTTOM_GAP = 24;
        var BAR_BOTTOM = COMP_H - BAR_BOTTOM_GAP; // 1056
        var BAR_TOP = BAR_BOTTOM - BAR_H;         // 870
        var BAR_CX = BAR_LEFT + BAR_W / 2;        // 960
        var BAR_CY = BAR_TOP + BAR_H / 2;         // 963

        /** Helper: add drop shadow effect to a layer */
        function addDropShadow(layer, opacity255, directionDeg, distancePx, softnessPx) {
            var fx = layer.property("ADBE Effect Parade").addProperty("ADBE Drop Shadow");
            if (!fx) return;
            try { fx.property("ADBE Drop Shadow-0001").setValue([0, 0, 0, 1]); } catch (e) {}
            try { fx.property("ADBE Drop Shadow-0002").setValue(opacity255); } catch (e) {}
            try { fx.property("ADBE Drop Shadow-0003").setValue(directionDeg); } catch (e) {}
            try { fx.property("ADBE Drop Shadow-0004").setValue(distancePx); } catch (e) {}
            try { fx.property("ADBE Drop Shadow-0005").setValue(softnessPx); } catch (e) {}
        }

        /** Helper: add gentle fade-in on layer opacity */
        function addFadeIn(layer, fadeSec, targetOpacity) {
            var op = layer.property("ADBE Transform Group").property("ADBE Opacity");
            op.setValueAtTime(0, 0);
            op.setValueAtTime(fadeSec, targetOpacity);
        }

        /** Helper: configure a text layer and expose its Source Text to Essential Graphics */
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
            if (cfg.leading) {
                doc.leading = cfg.leading;
            }
            if (cfg.tracking) {
                doc.tracking = cfg.tracking;
            }
            textProp.setValue(doc);

            layer.property("ADBE Transform Group").property("ADBE Position").setValue(cfg.position);
            addFadeIn(layer, cfg.fadeSec || 0.35, 100);

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
        // 1. Build `annual` Composition (60s duration)
        // =========================================================================
        var annualComp = app.project.items.addComp("annual", COMP_W, COMP_H, 1.0, 60.0, COMP_FPS);
        annualComp.motionGraphicsTemplateName = "annual";

        // Controller Null for DURATION_SEC slider (drives the real-time progress bar)
        currentStep = "create_ctrl_slider";
        var ctrlNull = annualComp.layers.addNull(60.0);
        ctrlNull.name = "CTRL";
        ctrlNull.enabled = false;
        var durEffect = ctrlNull.property("ADBE Effect Parade").addProperty("ADBE Slider Control");
        durEffect.name = "DURATION_SEC";
        var durSlider = durEffect.property("ADBE Slider Control-0001");
        durSlider.setValue(30.0);
        if (typeof durSlider.addToMotionGraphicsTemplateAs === "function") {
            durSlider.addToMotionGraphicsTemplateAs(annualComp, "DURATION_SEC");
        } else {
            durSlider.addToMotionGraphicsTemplate(annualComp);
        }

        // Pure transparent floating frosted glass: NO color tint layer here.
        // The crisp 4-side cropped medium Gaussian Blur (32) on Pr V2 provides pure clear glass.

        // Track Progress Bar Background (flush on top edge of floating glass bar: dark translucent track for clear contrast)
        currentStep = "create_progress_bar";
        var PROG_H = 4;
        var PROG_Y = BAR_TOP - PROG_H / 2; // 868 (sits right on top of Y=870)
        var progBg = annualComp.layers.addSolid([0, 0, 0], "PROGRESS_TRACK", BAR_W, PROG_H, 1.0, 60.0);
        progBg.property("ADBE Transform Group").property("ADBE Position").setValue([BAR_CX, PROG_Y]);
        addFadeIn(progBg, 0.3, 38);

        // Track Progress Bar Fill (bright white bar growing 0% -> 100% over DURATION_SEC; index (1) is locale-safe)
        var progFill = annualComp.layers.addSolid([1, 1, 1], "PROGRESS_FILL", BAR_W, PROG_H, 1.0, 60.0);
        progFill.property("ADBE Transform Group").property("ADBE Anchor Point").setValue([0, PROG_H / 2]);
        progFill.property("ADBE Transform Group").property("ADBE Position").setValue([BAR_LEFT, PROG_Y]);
        progFill.property("ADBE Transform Group").property("ADBE Scale").expression =
            'var d = Math.max(0.1, thisComp.layer("CTRL").effect("DURATION_SEC")(1));\n'
            + 'var pct = Math.min(100, Math.max(0, (time / d) * 100));\n'
            + '[pct, 100];';
        addDropShadow(progFill, 180, 135, 1, 6);
        addFadeIn(progFill, 0.3, 96);

        // Layer 1: Top-left #Index (e.g., #01)
        createExposedTextLayer(annualComp, {
            name: "INDEX_TEXT",
            defaultText: "#01",
            font: FONT_BOLD,
            fontSize: 82,
            fillColor: [1, 1, 1],
            justification: ParagraphJustification.LEFT_JUSTIFY,
            tracking: 16,
            position: [34, 106],
            fadeSec: 0.4,
            shadows: [
                [230, 135, 4, 10],
                [160, 135, 0, 24]
            ]
        });

        // Layer 2: Song Title inside floating glass bar (right of 186x186 cover at X=28..214 -> starts X=242)
        // Generous serif hierarchy matching reference (52px title, 32px artist) with crisp dark drop shadows
        createExposedTextLayer(annualComp, {
            name: "TITLE_TEXT",
            defaultText: "Song Title",
            font: FONT_BOLD,
            fontSize: 52,
            leading: 56,
            fillColor: [1, 1, 1],
            justification: ParagraphJustification.LEFT_JUSTIFY,
            tracking: 6,
            position: [242, 948],
            fadeSec: 0.35,
            shadows: [
                [245, 135, 3, 8],
                [185, 135, 0, 20]
            ]
        });

        // Layer 3: Artist Name directly below Title
        createExposedTextLayer(annualComp, {
            name: "ARTIST_TEXT",
            defaultText: "Artist Name",
            font: FONT_REGULAR,
            fontSize: 32,
            fillColor: [1, 1, 1],
            justification: ParagraphJustification.LEFT_JUSTIFY,
            tracking: 12,
            position: [242, 1028],
            fadeSec: 0.35,
            shadows: [
                [235, 135, 2, 7],
                [175, 135, 0, 16]
            ]
        });

        // Layer 4: Top-right Recommendation Reason (no background card, right-aligned, strong dark shadow)
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
            fadeSec: 0.5,
            shadows: [
                [240, 135, 3, 12],
                [180, 135, 0, 28]
            ]
        });

        // Export templates/annual.mogrt
        currentStep = "export_annual_mogrt";
        var annualExportOk = annualComp.exportAsMotionGraphicsTemplate(true, templatesDir.fsName);
        var annualOutPath = templatesDir.fsName + "\\annual.mogrt";

        // =========================================================================
        // 2. Build `intro` Composition (30s duration, optional opening monologue)
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
            shadows: [
                [210, 135, 3, 18]
            ]
        });

        currentStep = "export_intro_mogrt";
        var introExportOk = introComp.exportAsMotionGraphicsTemplate(true, templatesDir.fsName);
        var introOutPath = templatesDir.fsName + "\\intro.mogrt";

        // Save editable master AE project for future visual adjustments
        currentStep = "save_master_aep";
        var masterAep = new File(templatesDir.fsName + "\\annual_master.aep");
        app.project.save(masterAep);

        var doneMsg = "悬浮毛玻璃 + 进度条 MOGRT 模板导出完成！\n\n"
            + "使用字体: " + FONT_BOLD + " / " + FONT_REGULAR + "\n"
            + "annual.mogrt: " + (annualExportOk ? "成功" : "请检查") + " -> " + annualOutPath + "\n"
            + "intro.mogrt: " + (introExportOk ? "成功" : "请检查") + " -> " + introOutPath + "\n"
            + "母版工程已保存: " + masterAep.fsName;
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
        try {
            var flagFile = new File("D:/prworks/music-rec-video/scripts/.ae_headless");
            if (flagFile.exists) {
                flagFile.remove();
                app.quit();
            }
        } catch (eQuit) {}
    }
})();
