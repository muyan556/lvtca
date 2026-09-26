/*
 * 六安职业技术学院 · 拾光课程表适配器 v3
 *
 * v3 修正：
 * 1. 不再依赖 td 的 rowspan 来判断星期。
 * 2. 优先读取课程 li 自身的 qz-hasCourse-N：
 *      qz-hasCourse-1 = 周一
 *      ...
 *      qz-hasCourse-7 = 周日
 * 3. rowspan 网格计算仅作为备用。
 * 4. 入口仍为 xsMainV.htmlx，脚本通过同源 fetch 获取完整课表 HTML。
 */

(function () {
    "use strict";

    const SCHEDULE_URL =
        "/jsxsd/xskb/xskb_list.do?viweType=0";

    const HOME_PATH =
        "/jsxsd/framework/xsMainV.htmlx";

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
     * 直接从课程 li 的 class 获取星期。
     *
     * 实际强智页面：
     *   qz-hasCourse-1 -> 周一
     *   qz-hasCourse-2 -> 周二
     *   ...
     *   qz-hasCourse-7 -> 周日
     */
    function getDayFromClass(li) {
        const classes = [...li.classList];

        for (const cls of classes) {
            const m = cls.match(
                /^qz-hasCourse-([1-7])$/
            );

            if (m) {
                return Number(m[1]);
            }
        }

        /*
         * 某些页面可能把标记写在父节点。
         */
        let parent = li.parentElement;

        for (let level = 0;
             parent && level < 3;
             level++, parent = parent.parentElement) {

            for (const cls of [...parent.classList]) {
                const m = cls.match(
                    /^qz-hasCourse-([1-7])$/
                );

                if (m) {
                    return Number(m[1]);
                }
            }
        }

        return 0;
    }

    /*
     * 备用：从 td 的网格位置推算星期。
     */
    function collectFallbackCellDays(table) {
        const result = new Map();
        const occupied = [];
        const rows = [...table.querySelectorAll("tr")];

        rows.forEach((row, rowIndex) => {
            if (!occupied[rowIndex]) {
                occupied[rowIndex] = [];
            }

            let col = 0;

            for (const cell of [...row.children]) {
                while (occupied[rowIndex][col]) col++;

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

                if (cell.matches(
                    'td[name="kbDataTd"]'
                )) {
                    const day =
                        col >= 1 && col <= 7 ? col : 0;

                    for (const li of cell.querySelectorAll(
                        "li.courselists-item"
                    )) {
                        result.set(li, day);
                    }
                }

                col += colspan;
            }
        });

        return result;
    }

    function parseScheduleDocument(doc) {
        const table =
            doc.querySelector("table.qz-weeklyTable");

        if (!table) {
            throw new Error(
                "课表请求成功，但没有找到 qz-weeklyTable。"
            );
        }

        const fallbackDays =
            collectFallbackCellDays(table);

        const courses = [];

        const lis = [
            ...table.querySelectorAll(
                "li.courselists-item"
            )
        ];

        for (const li of lis) {
            const name = clean(
                li.querySelector(".qz-hasCourse-title")
            );

            if (!name) continue;

            let day = getDayFromClass(li);

            if (!day) {
                day = fallbackDays.get(li) || 0;
            }

            if (day < 1 || day > 7) {
                console.warn(
                    "[LVTC] 无法确定星期：",
                    name
                );
                continue;
            }

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

        const doc =
            new DOMParser().parseFromString(
                html,
                "text/html"
            );

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
