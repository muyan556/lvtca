/*
 * 六安职业技术学院 · 拾光课程表适配器 v2
 *
 * 入口：
 *   /jsxsd/framework/xsMainV.htmlx
 *
 * 流程：
 *   已登录的统一门户/CAS
 *      -> 强智学生主页 xsMainV.htmlx
 *      -> fetch xskb/xskb_list.do
 *      -> 解析完整课表 HTML
 *      -> saveImportedCourses()
 *
 * 注意：
 *   不保存、不上传账号、密码、Cookie、CAS Ticket。
 */

(function () {
    "use strict";

    const SCHEDULE_URL =
        "/jsxsd/xskb/xskb_list.do?viweType=0";

    const HOME_PATH =
        "/jsxsd/framework/xsMainV.htmlx";

    function clean(s) {
        return String(s || "").replace(/\s+/g, " ").trim();
    }

    function toast(message) {
        try {
            if (window.shiguangBridge && window.shiguangBridge.showToast) {
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

        for (const item0 of s.split(",")) {
            let item = item0.trim();
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

            const single = item.match(/^\d+$/);
            if (single) {
                const w = Number(single[0]);
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

        const time = timeMatch ? clean(timeMatch[1]) : "";

        const weekPart =
            time.match(/^(.+?)\s*\[/);

        const sectionPart =
            time.match(/\[([^\]]+)\]/);

        return {
            teacher: teacherMatch ? clean(teacherMatch[1]) : "",
            position: positionMatch ? clean(positionMatch[1]) : "",
            weeks: parseWeeks(
                weekPart ? weekPart[1] : time
            ),
            sections: parseSections(
                sectionPart ? sectionPart[1] : ""
            )
        };
    }

    /*
     * 强智课表使用 rowspan。
     * 建立 DOM 网格，计算 kbDataTd 的真实星期列。
     */
    function collectCourseCells(table) {
        const rows = [...table.querySelectorAll("tr")];
        const occupied = [];
        const result = [];

        rows.forEach((row, rowIndex) => {
            if (!occupied[rowIndex]) occupied[rowIndex] = [];

            let col = 0;

            for (const cell of [...row.children]) {
                while (occupied[rowIndex][col]) col++;

                const rowspan =
                    Math.max(
                        1,
                        Number(cell.getAttribute("rowspan") || "1")
                    );

                const colspan =
                    Math.max(
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

                if (cell.matches('td[name="kbDataTd"]')) {
                    result.push({
                        cell: cell,
                        day: col
                    });
                }

                col += colspan;
            }
        });

        return result;
    }

    function parseScheduleDocument(doc) {
        const table = doc.querySelector(
            "table.qz-weeklyTable"
        );

        if (!table) {
            throw new Error(
                "课表请求成功，但响应中没有找到 qz-weeklyTable。"
            );
        }

        const courses = [];

        for (const item of collectCourseCells(table)) {
            // 第 0 列是节次标签，所以 1~7 才是周一~周日。
            if (item.day < 1 || item.day > 7) continue;

            const lis = [
                ...item.cell.querySelectorAll(
                    'ul[name="kbdataUl"] > li.courselists-item'
                )
            ];

            for (const li of lis) {
                const name = clean(
                    li.querySelector(".qz-hasCourse-title")
                );

                if (!name) continue;

                const detail = clean(
                    li.querySelector(".qz-hasCourse-abbrinfo")
                );

                const parsed = parseDetail(detail);

                if (!parsed.weeks.length ||
                    !parsed.sections) {
                    console.warn(
                        "[LVTC] 无法完整解析课程：",
                        name,
                        detail
                    );
                    continue;
                }

                const course = {
                    name: name,
                    teacher: parsed.teacher,
                    position: parsed.position,
                    day: item.day,
                    startSection: parsed.sections.startSection,
                    endSection: parsed.sections.endSection,
                    weeks: parsed.weeks
                };

                const kchNode =
                    li.querySelector('[name="kchSpan"]');

                const kch = clean(
                    kchNode ? kchNode.textContent : ""
                ).replace(
                    /^;\s*课程号\s*:\s*/i,
                    ""
                );

                if (kch) {
                    course.remark = "课程号:" + kch;
                }

                courses.push(course);
            }
        }

        return courses;
    }

    function getCurrentTerm() {
        const select =
            document.querySelector(
                "#xnxq01id, select[name='xnxq01id']"
            );

        if (!select) return "";

        const option =
            select.querySelector("option:checked") ||
            select.querySelector("option[selected]");

        return option
            ? clean(option.value || option.textContent)
            : "";
    }

    async function fetchSchedule() {
        /*
         * 关键点：
         * 当前 WebView 已经通过 CAS 建立了教务 Session。
         * fetch 使用同源 credentials，因此会自动携带
         * 当前教务系统 Cookie。
         */
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
                "课表请求失败：HTTP " + response.status
            );
        }

        const finalUrl = response.url || "";

        if (/\/sso\/|cas/i.test(finalUrl)) {
            throw new Error(
                "教务 Session 已失效，课表请求被重新跳转到统一认证。"
            );
        }

        return await response.text();
    }

    async function importCourses() {
        const path = location.pathname || "";

        /*
         * v2 不要求当前页面就是 xskb_list.do。
         * 正确入口是 xsMainV.htmlx。
         */
        if (!path.includes(HOME_PATH)) {
            console.warn(
                "[LVTC] 当前路径不是标准学生主页：",
                location.href
            );

            /*
             * 只要 DOM 中已有强智课表表格，也允许直接解析。
             * 这样可以兼容部分 WebView 跳转行为。
             */
            if (!document.querySelector(
                "table.qz-weeklyTable"
            )) {
                await alertBox(
                    "六安职业技术学院",
                    "当前不是强智学生主页。\n\n" +
                    "请先完成统一认证并进入：\n" +
                    "/jsxsd/framework/xsMainV.htmlx"
                );
                return;
            }
        }

        toast("正在获取六安职业技术学院课表...");

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

        const parser = new DOMParser();
        const doc = parser.parseFromString(
            html,
            "text/html"
        );

        let courses;

        try {
            courses = parseScheduleDocument(doc);
        } catch (e) {
            await alertBox(
                "课表解析失败",
                e.message || String(e)
            );
            return;
        }

        if (!courses.length) {
            await alertBox(
                "没有解析到课程",
                "已经成功取得课表页面，但没有解析到有效课程。"
            );
            return;
        }

        const term = getCurrentTerm();

        console.log(
            "[LVTC] 学期:",
            term
        );

        console.log(
            "[LVTC] 课程数量:",
            courses.length
        );

        console.table(courses);

        try {
            const result =
                await window.shiguangBridgePromise
                    .saveImportedCourses(
                        JSON.stringify(courses)
                    );

            console.log(
                "[LVTC] saveImportedCourses:",
                result
            );

            toast(
                "导入完成，共 " +
                courses.length +
                " 条课程。"
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
