/**
 * auto_assemble.jsx - Premiere Pro 自动化剪辑脚本
 * 
 * 作用：
 * 1. 自动读取 playlist.json
 * 2. 在项目内新建 "MV素材" 文件夹并导入已下载的 8 首 1080P MV 视频及字幕文件
 * 3. 自动创建 1920x1080 30fps 序列 "Our Love Is Alive"
 * 4. 严格按照设定的精确入点/出点（In/Out Point），无缝顺次拼接到 V1 / A1 时间线轨道
 */

(function () {
    app.enableQE();

    var project = app.project;
    if (!project) {
        alert("请先在 Premiere Pro 中打开或新建一个项目！");
        return;
    }

    // 1. 确定项目目录路径
    var scriptDir = "D:/prworks/music-rec-video";
    try {
        if ($.fileName) {
            scriptDir = File($.fileName).parent.fsName.replace(/\\/g, "/");
        }
    } catch (e) {}

    var playlistFile = new File(scriptDir + "/playlist.json");
    if (!playlistFile.exists) {
        alert("未找到歌单配置文件：" + playlistFile.fsName);
        return;
    }

    // 2. 解析时间辅助函数
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

    // 3. 读取 playlist.json
    playlistFile.encoding = "UTF-8";
    playlistFile.open("r");
    var content = playlistFile.read();
    playlistFile.close();

    var data;
    try {
        data = eval("(" + content + ")");
    } catch (err) {
        alert("playlist.json 解析失败: " + err);
        return;
    }

    var songs = data.songs || [];
    if (songs.length === 0) {
        alert("playlist.json 中没有歌曲列表！");
        return;
    }

    // 4. 创建或获取 MV素材 Bin
    var root = project.rootItem;
    var bin = null;
    for (var i = 0; i < root.children.numItems; i++) {
        if (root.children[i].name === "MV素材") {
            bin = root.children[i];
            break;
        }
    }
    if (!bin) {
        bin = root.createBin("MV素材");
    }

    // 5. 导入所有有效素材
    var validItems = [];
    for (var sIdx = 0; sIdx < songs.length; sIdx++) {
        var s = songs[sIdx];
        var relPath = s.file_path ? s.file_path.replace(/\\/g, "/") : "";
        var absPath = scriptDir + "/" + relPath;
        var f = new File(absPath);
        if (!f.exists) {
            // 尝试直接作为绝对路径
            f = new File(s.file_path);
        }

        if (f.exists) {
            // 检查 Bin 中是否已存在
            var existingItem = null;
            for (var b = 0; b < bin.children.numItems; b++) {
                var child = bin.children[b];
                if (child.getMediaPath && child.getMediaPath().replace(/\\/g, "/") === f.fsName.replace(/\\/g, "/")) {
                    existingItem = child;
                    break;
                }
            }

            if (!existingItem) {
                project.importFiles([f.fsName], true, bin, false);
                // 刚导入的一定在末尾
                existingItem = bin.children[bin.children.numItems - 1];
            }

            validItems.push({
                item: existingItem,
                inSec: parseTime(s.start),
                outSec: parseTime(s.end),
                title: s.title
            });
        }
    }

    if (validItems.length === 0) {
        alert("未找到任何已下载的本地视频文件，请先在 Web 页面下载素材！");
        return;
    }

    // 6. 获取或创建 Sequence
    var seqName = data.output_sequence_name || "音乐推荐合辑";
    var targetSeq = null;
    for (var sq = 0; sq < project.sequences.numSequences; sq++) {
        if (project.sequences[sq].name === seqName) {
            targetSeq = project.sequences[sq];
            break;
        }
    }

    if (!targetSeq) {
        // 关键修复：挑选 30fps/标准帧率的视频作为序列模板，避免使用 6fps 的静态视频创建序列
        var templateItem = validItems[0].item;
        for (var vi = 0; vi < validItems.length; vi++) {
            var itemTitle = validItems[vi].title || "";
            if (itemTitle.indexOf("安室奈美恵") >= 0 || itemTitle.indexOf("サカナクション") >= 0) {
                templateItem = validItems[vi].item;
                break;
            }
        }
        targetSeq = project.createNewSequenceFromClips(seqName, [templateItem], root);
    }

    // 确保序列时基为 30fps
    try {
        var seqSettings = targetSeq.getSettings();
        var fpsTime = new Time();
        fpsTime.seconds = 1.0 / 30.0;
        seqSettings.videoFrameRate = fpsTime;
        targetSeq.setSettings(seqSettings);
    } catch (e) {}

    project.activeSequence = targetSeq;

    // 7. 清空 V1 (视频), V2 (毛玻璃底板/信息), A1 (音频)
    var v0 = targetSeq.videoTracks[0];
    var v1 = targetSeq.videoTracks.numTracks > 1 ? targetSeq.videoTracks[1] : null;
    var a0 = targetSeq.audioTracks[0];

    while (v0.clips.numItems > 0) {
        v0.clips[v0.clips.numItems - 1].remove(false, false);
    }
    if (v1) {
        while (v1.clips.numItems > 0) {
            v1.clips[v1.clips.numItems - 1].remove(false, false);
        }
    }
    while (a0.clips.numItems > 0) {
        a0.clips[a0.clips.numItems - 1].remove(false, false);
    }

    // 8. 导入毛玻璃排版卡片并创建【视觉卡片】箱
    var cardBin = null;
    for (var cb = 0; cb < root.children.numItems; cb++) {
        if (root.children[cb].name === "视觉卡片") {
            cardBin = root.children[cb];
            break;
        }
    }
    if (!cardBin) {
        cardBin = root.createBin("视觉卡片");
    }

    var cardItems = [];
    for (var cIdx = 1; cIdx <= songs.length; cIdx++) {
        var numStr = cIdx < 10 ? "0" + cIdx : "" + cIdx;
        var cardFile = new File(scriptDir + "/overlays/card_" + numStr + ".png");
        if (cardFile.exists) {
            var existingCard = null;
            for (var cci = 0; cci < cardBin.children.numItems; cci++) {
                var cItem = cardBin.children[cci];
                if (cItem.getMediaPath && cItem.getMediaPath().replace(/\\/g, "/") === cardFile.fsName.replace(/\\/g, "/")) {
                    existingCard = cItem;
                    break;
                }
            }
            if (!existingCard) {
                project.importFiles([cardFile.fsName], true, cardBin, false);
                existingCard = cardBin.children[cardBin.children.numItems - 1];
            }
            cardItems.push(existingCard);
        } else {
            cardItems.push(null);
        }
    }

    // 9. 顺次裁剪并追加到时间线（V1: MV视频，V2: 毛玻璃信息卡片）
    var curTimeSec = 0.0;
    for (var k = 0; k < validItems.length; k++) {
        var vInfo = validItems[k];
        var item = vInfo.item;
        var dur = vInfo.outSec - vInfo.inSec;

        // V1 放置 MV 画面
        var inTime = new Time();
        inTime.seconds = vInfo.inSec;
        var outTime = new Time();
        outTime.seconds = vInfo.outSec;

        item.setInPoint(inTime, 4);
        item.setOutPoint(outTime, 4);

        var insTime = new Time();
        insTime.seconds = curTimeSec;

        v0.overwriteClip(item, insTime);

        // V2 放置对应的毛玻璃信息卡片
        if (v1 && k < cardItems.length && cardItems[k]) {
            var cItem = cardItems[k];
            var cardIn = new Time();
            cardIn.seconds = 0;
            var cardOut = new Time();
            cardOut.seconds = dur;

            cItem.setInPoint(cardIn, 4);
            cItem.setOutPoint(cardOut, 4);

            v1.overwriteClip(cItem, insTime);

            // 确保卡片末尾时间与 MV 严格对齐
            if (v1.clips.numItems > 0) {
                var lastCardClip = v1.clips[v1.clips.numItems - 1];
                var endT = new Time();
                endT.seconds = curTimeSec + dur;
                lastCardClip.end = endT;
            }
        }

        curTimeSec += dur;
    }

    // 10. 导入同步生成的 SRT 字幕文件
    var srtFile = new File(scriptDir + "/subtitles.srt");
    if (srtFile.exists) {
        project.importFiles([srtFile.fsName], true, bin, false);
    }

    alert("✨ 自动化拼接与视觉包装完成！\n已成功将 " + validItems.length + " 首精选 MV 导入序列【" + seqName + "】\n已在 V2 轨道添加底部毛玻璃与音乐信息卡片！\n总时长：" + curTimeSec.toFixed(1) + " 秒。");
})();
