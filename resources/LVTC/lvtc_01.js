/*
 * 六安职业技术学院 · 拾光课程表适配器 v4
 *
 * v4 修正（依据实际 HAR 抓包数据 ProxyPin9-26_23_11_54.har 定位）：
 *
 * 1.【核心修复】不再信任课程 li 自身的 qz-hasCourse-N 类来判断星期。
 *    抓包发现：本校强智页面里，所有课程 li 的 class 一律是
 *    "courselists-item qz-hasCourse-1"，无论它实际处于星期几的列，
 *    这个数字并不随列变化。v3 把它当作"主要判断依据"，导致所有课程
 *    全部被错误地判成"周一"（且由于该类一定能匹配上，永远不会走到
 *    正确的网格兜底逻辑）。
 *    v4 改为：星期几只由该课程所在 <td name="kbDataTd"> 在表格网格中
 *    的列位置决定（结合 rowspan/colspan 精确计算），并且用表头
 *    <thead> 里"星期一.....星期日"的文字反推列号->星期几的映射，
 *    不再对着列号硬编码，防止表头顺序变化时错位。
 *
 * 2.【健壮性修复】抓包发现该系统接口返回的响应体其实是两段拼接的
 *    HTML 文档（前面是一段独立的 <html>...</html> 页头片段，紧接着
 *    又是一个完整的 <!DOCTYPE html><html>...）。不同内核的 WebView
 *    对这种"重复 <html>/<head>"畸形文档的容错解析结果不一致，
 *    可能导致 DOMParser 解析出来的 document 里根本取不到真正的课表
 *    表格节点（即"课表页面已经成功取得，但是课程节点没有解析成功"）。
 *    v4 改为：先用正则从原始响应文本里单独抠出
 *    <table class="qz-weeklyTable">...</table> 这一段，包一层干净的
 *    <html><body> 后单独喂给 DOMParser，彻底避开前面那段畸形文档的
 *    干扰；只有正则没抠到时才退回整段解析（兼容其它学校/其它接口
 *    返回单一文档的情况）。
 *
 * 3. 入口仍为 xsMainV.htmlx，脚本通过同源 fetch 获取完整课表 HTML。
 */

(function () {
    "use strict";

    const SCHEDULE_URL =
        "/jsxsd/xskb/xskb_list.do?viweType=0";

    const HOME_PATH =
        "/jsxsd/framework/xsMainV.htmlx";

    const WEEKDAY_NAME_TO_NUM = {
        "星期一": 1, "周一": 1,
        "星期二": 2, "周二": 2,
        "星期三": 3, "周三": 3,
        "星期四": 4, "周四": 4,
        "星期五": 5, "周五": 5,
        "星期六": 6, "周六": 6,
        "星期日": 7, "星期天": 7, "周日": 7, "周天": 7
    };

    function clean(s) {
        return String(s || "")
            .replace(/\u00a0/g, " ")
            .replace(/\s+/g, " ")
            .trim();
    }

    function toast(message) {
        try {
            if (window.shiguangBridge &&
                window.shiguangBridge.showToast) {
                window.shiguangBridge.showToast(message);
                return;
            }
        } catch (_) {}
        console.log("[LVTC]", message);
    }

    async function alertBox(title, message) {
        try {
            if (window.shiguangBridgePromise &&
                window.shiguangBridgePromise.showAlert) {
                await window.shiguangBridgePromise.showAlert(
                    title, message, "确定"
                );
                return;
            }
        } catch (_) {}
        console.error("[LVTC]", title, message);
        toast(message);
    }

    function parseWeeks(raw) {
        let s = clean(raw)
            .replace(/第/g, "")
            .replace(/周/g, "")
            .replace(/至/g, "-")
            .replace(/、/g, ",")
            .replace(/，/g, ",");

        if (!s) return [];

        const result = new Set();

        for (let item of s.split(",")) {
            item = item.trim();
            if (!item) continue;

            const odd = /单$/.test(item);
            const even = /双$/.test(item);
            item = item.replace(/[单双]$/, "");

            const range = item.match(/^(\d+)\s*-\s*(\d+)$/);
            if (range) {
                let a = Number(range[1]);
                let b = Number(range[2]);

                if (a > b) [a, b] = [b, a];

                for (let w = a; w <= b; w++) {
                    if ((!odd && !even) ||
                        (odd && w % 2 === 1) ||
                        (even && w % 2 === 0)) {
                        result.add(w);
                    }
                }
                continue;
            }

            const one = item.match(/^\d+$/);
            if (one) {
                const w = Number(one[0]);

                if ((!odd && !even) ||
                    (odd && w % 2 === 1) ||
                    (even && w % 2 === 0)) {
                    result.add(w);
                }
            }
        }

        return [...result].sort((a, b) => a - b);
    }

    function parseSections(raw) {
        const s = clean(raw).replace(/\s+/g, "");

        let m = s.match(/(\d+)\s*-\s*(\d+)\s*节/);

        if (m) {
            return {
                startSection: Number(m[1]),
                endSection: Number(m[2])
            };
        }

        m = s.match(/(\d+)\s*节/);

        if (m) {
            const n = Number(m[1]);

            return {
                startSection: n,
                endSection: n
            };
        }

        return null;
    }

    function parseDetail(detail) {
        const s = clean(detail);

        const teacherMatch =
            s.match(/老师\s*:\s*(.*?);?\s*时间\s*:/);

        const timeMatch =
            s.match(/时间\s*:\s*(.*?);?\s*地点\s*:/);

        const positionMatch =
            s.match(/地点\s*:\s*(.*)$/);

        const teacher =
            teacherMatch ? clean(teacherMatch[1]) : "";

        const time =
            timeMatch ? clean(timeMatch[1]) : "";

        const position =
            positionMatch ? clean(positionMatch[1]) : "";

        const weekMatch =
            time.match(/^(.+?)\s*\[/);

        const sectionMatch =
            time.match(/\[([^\]]+)\]/);

        return {
            teacher: teacher,
            position: position,
            weeks: parseWeeks(
                weekMatch ? weekMatch[1] : time
            ),
            sections: parseSections(
                sectionMatch ? sectionMatch[1] : ""
            )
        };
    }

    /*
     * 从原始响应文本里单独抠出 qz-weeklyTable 这个 <table> 片段。
     *
     * 抓包发现该接口返回的其实是两段拼接的 HTML 文档（前面一段独立
     * 的 <html>...</html> 页头片段 + 后面完整的 <!DOCTYPE html>
     * 文档），不同 WebView 内核对这种畸形文档的容错解析可能不一致，
     * 直接整体丢给 DOMParser 有风险，因此优先只截取表格本身。
     */
    function extractWeeklyTableHtml(rawHtml) {
        const m = rawHtml.match(
            /<table\b[^>]*class\s*=\s*["'][^"']*qz-weeklyTable[^"']*["'][^>]*>[\s\S]*?<\/table>/i
        );

        return m ? m[0] : null;
    }

    /*
     * 遍历 <tr> 计算每一个单元格（含表头 th）在网格中的真实列号，
     * 正确处理 rowspan / colspan 占位。
     *
     * 返回 { cellCol: Map<Element, number> }
     */
    function computeGrid(table) {
        const cellCol = new Map();
        const occupied = [];
        const rows = [...table.querySelectorAll("tr")];

        rows.forEach((row, rowIndex) => {
            if (!occupied[rowIndex]) {
                occupied[rowIndex] = [];
            }

            let col = 0;

            for (const cell of [...row.children]) {
                while (occupied[rowIndex][col]) col++;

                cellCol.set(cell, col);

                const rowspan = Math.max(
                    1,
                    Number(cell.getAttribute("rowspan") || "1")
                );

                const colspan = Math.max(
                    1,
                    Number(cell.getAttribute("colspan") || "1")
                );

                for (let r = 0; r < rowspan; r++) {
                    if (!occupied[rowIndex + r]) {
                        occupied[rowIndex + r] = [];
                    }

                    for (let c = 0; c < colspan; c++) {
                        occupied[rowIndex + r][col + c] = true;
                    }
                }

                col += colspan;
            }
        });

        return cellCol;
    }

    /*
     * 依据表头文字（星期一...星期日）反推 "列号 -> 星期几" 的映射，
     * 不再硬编码"第 1..7 列 = 周一..周日"，避免表头结构变化时错位。
     * 如果表头解析失败，退回 1..7 直接当星期几的兜底方案。
     */
    function buildColumnDayMap(table, cellCol) {
        const map = new Map();

        const headCells = [
            ...table.querySelectorAll("thead th")
        ];

        for (const th of headCells) {
            const col = cellCol.get(th);
            if (col === undefined) continue;

            const text = clean(th.textContent);
            const day = WEEKDAY_NAME_TO_NUM[text];

            if (day) {
                map.set(col, day);
            }
        }

        if (map.size === 0) {
            // 表头没解析出来，退回旧的"列 1-7 = 周一到周日"假设
            for (let col = 1; col <= 7; col++) {
                map.set(col, col);
            }
        }

        return map;
    }

    function parseScheduleDocument(doc) {
        const table =
            doc.querySelector("table.qz-weeklyTable");

        if (!table) {
            throw new Error(
                "课表请求成功，但没有找到 qz-weeklyTable。"
            );
        }

        const cellCol = computeGrid(table);
        const columnDayMap = buildColumnDayMap(table, cellCol);

        const courses = [];

        const dataCells = [
            ...table.querySelectorAll('td[name="kbDataTd"]')
        ];

        for (const td of dataCells) {
            const col = cellCol.get(td);
            const day = columnDayMap.get(col) || 0;

            if (day < 1 || day > 7) continue;

            const lis = [
                ...td.querySelectorAll("li.courselists-item")
            ];

            for (const li of lis) {
                const name = clean(
                    li.querySelector(".qz-hasCourse-title")
                );

                if (!name) continue;

                const detail = clean(
                    li.querySelector(
                        ".qz-hasCourse-abbrinfo"
                    )
                );

                const parsed = parseDetail(detail);

                if (!parsed.weeks.length ||
                    !parsed.sections) {
                    console.warn(
                        "[LVTC] 无法解析周次/节次：",
                        name,
                        detail
                    );
                    continue;
                }

                const course = {
                    name: name,
                    teacher: parsed.teacher,
                    position: parsed.position,
                    day: day,
                    startSection:
                        parsed.sections.startSection,
                    endSection:
                        parsed.sections.endSection,
                    weeks: parsed.weeks
                };

                const kchNode =
                    li.querySelector('[name="kchSpan"]');

                const kch = clean(
                    kchNode
                        ? kchNode.textContent
                        : ""
                ).replace(
                    /^;\s*课程号\s*:\s*/i,
                    ""
                );

                if (kch) {
                    course.remark =
                        "课程号:" + kch;
                }

                courses.push(course);
            }
        }

        return courses;
    }

    async function fetchSchedule() {
        const response = await fetch(
            SCHEDULE_URL,
            {
                method: "GET",
                credentials: "include",
                cache: "no-store",
                headers: {
                    "Accept":
                        "text/html,application/xhtml+xml"
                }
            }
        );

        if (!response.ok) {
            throw new Error(
                "课表请求失败：HTTP " +
                response.status
            );
        }

        const finalUrl =
            response.url || "";

        if (/\/sso\/|\/cas\//i.test(finalUrl)) {
            throw new Error(
                "教务 Session 已失效，" +
                "请求被重新跳转到统一认证。"
            );
        }

        return await response.text();
    }

    function buildScheduleDocument(rawHtml) {
        const tableHtml = extractWeeklyTableHtml(rawHtml);

        // 优先只解析单独抠出来的表格片段，避开该接口返回的
        // "两段拼接 HTML 文档" 在不同 WebView 内核下解析不一致的问题。
        const htmlToParse = tableHtml
            ? "<!DOCTYPE html><html><body>" +
              tableHtml +
              "</body></html>"
            : rawHtml;

        const doc =
            new DOMParser().parseFromString(
                htmlToParse,
                "text/html"
            );

        if (!tableHtml) {
            console.warn(
                "[LVTC] 未能用正则单独抠出 qz-weeklyTable，" +
                "已退回整段 HTML 解析。"
            );
        }

        return doc;
    }

    async function importCourses() {
        const path =
            location.pathname || "";

        /*
         * 正常入口：
         * /jsxsd/framework/xsMainV.htmlx
         *
         * 如果当前页面已经存在课表 DOM，
         * 也允许直接处理。
         */
        if (!path.includes(HOME_PATH) &&
            !document.querySelector(
                "table.qz-weeklyTable"
            )) {

            await alertBox(
                "六安职业技术学院",
                "当前不是强智学生主页。\n\n" +
                "请先完成统一信息门户登录，" +
                "并进入教务系统学生主页。"
            );

            return;
        }

        toast(
            "正在获取六安职业技术学院课表..."
        );

        let html;

        try {
            html = await fetchSchedule();
        } catch (e) {
            await alertBox(
                "课表请求失败",
                e.message || String(e)
            );
            return;
        }

        const doc = buildScheduleDocument(html);

        let courses;

        try {
            courses =
                parseScheduleDocument(doc);
        } catch (e) {
            await alertBox(
                "课表解析失败",
                e.message || String(e)
            );
            return;
        }

        if (!courses.length) {
            await alertBox(
                "没有解析到有效课程",
                "课表页面已经成功取得，" +
                "但课程节点没有解析成功。\n\n" +
                "请把本次测试的页面截图或错误信息发给开发者。"
            );
            return;
        }

        console.log(
            "[LVTC] 成功解析课程：",
            courses.length
        );

        console.table(courses);

        try {
            const result =
                await window
                    .shiguangBridgePromise
                    .saveImportedCourses(
                        JSON.stringify(courses)
                    );

            console.log(
                "[LVTC] saveImportedCourses:",
                result
            );

            toast(
                "六安职业技术学院课表导入成功，" +
                "共 " + courses.length + " 条课程。"
            );

        } catch (e) {
            await alertBox(
                "拾光导入失败",
                e.message || String(e)
            );
        }
    }

    importCourses();
})();
