/*
 * 六安职业技术学院 · 拾光课程表适配器 v1
 *
 * 目标：
 *   统一信息门户登录 -> 强智教务系统 -> 个人课表信息 -> 拾光
 *
 * 使用方式：
 *   1. 通过统一信息门户完成登录。
 *   2. 进入强智教务系统的“个人课表信息”页面。
 *   3. 在拾光中点击“执行导入”。
 *
 * 本版本不保存、不上传账号、密码、Cookie、CAS Ticket。
 * 只读取当前 WebView 已经登录的页面 DOM。
 */

(function () {
    "use strict";

    const QZ_SCHEDULE_PATH = "/jsxsd/xskb/xskb_list.do";

    function text(el) {
        return el ? (el.textContent || "").replace(/\s+/g, " ").trim() : "";
    }

    function toast(message) {
        try {
            if (window.shiguangBridge && window.shiguangBridge.showToast) {
                window.shiguangBridge.showToast(message);
            }
        } catch (_) {}
    }

    async function alertBox(title, message) {
        try {
            if (window.shiguangBridgePromise &&
                window.shiguangBridgePromise.showAlert) {
                await window.shiguangBridgePromise.showAlert(title, message, "确定");
                return;
            }
        } catch (_) {}
        toast(message);
    }

    function isSchedulePage() {
        const path = location.pathname || "";
        return path.includes(QZ_SCHEDULE_PATH) ||
            !!document.querySelector("table.qz-weeklyTable");
    }

    function parseWeeks(raw) {
        let s = String(raw || "")
            .replace(/[第\s]/g, "")
            .replace(/周/g, "")
            .replace(/（/g, "(")
            .replace(/）/g, ")")
            .trim();

        if (!s) return [];

        const weeks = new Set();

        // 兼容：1-8,10-12；1、3、5；1至8
        s = s.replace(/至/g, "-").replace(/、/g, ",").replace(/，/g, ",");

        for (const part0 of s.split(",")) {
            const part = part0.trim();
            if (!part) continue;

            // 兼容单双周
            const odd = /单$/.test(part);
            const even = /双$/.test(part);
            const clean = part.replace(/[单双]$/, "");

            const range = clean.match(/^(\d+)\s*-\s*(\d+)$/);
            if (range) {
                let a = Number(range[1]);
                let b = Number(range[2]);
                if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
                if (a > b) [a, b] = [b, a];
                for (let w = a; w <= b; w++) {
                    if ((!odd && !even) || (odd && w % 2 === 1) || (even && w % 2 === 0)) {
                        weeks.add(w);
                    }
                }
                continue;
            }

            const one = clean.match(/^\d+$/);
            if (one) {
                const w = Number(one[0]);
                if ((!odd && !even) || (odd && w % 2 === 1) || (even && w % 2 === 0)) {
                    weeks.add(w);
                }
            }
        }

        return Array.from(weeks).sort((a, b) => a - b);
    }

    function parseSections(raw) {
        const s = String(raw || "").replace(/\s+/g, "");
        const m = s.match(/(\d+)\s*-\s*(\d+)\s*节/);
        if (m) {
            return {
                startSection: Number(m[1]),
                endSection: Number(m[2])
            };
        }

        const one = s.match(/(\d+)\s*节/);
        if (one) {
            const n = Number(one[1]);
            return { startSection: n, endSection: n };
        }

        return null;
    }

    function parseTimeInfo(info) {
        const s = String(info || "").replace(/\s+/g, " ").trim();

        const teacherMatch = s.match(/老师\s*:\s*(.*?);?\s*时间\s*:/);
        const timeMatch = s.match(/时间\s*:\s*(.*?);?\s*地点\s*:/);
        const positionMatch = s.match(/地点\s*:\s*(.*)$/);

        const timeRaw = timeMatch ? timeMatch[1].trim() : "";
        const weekMatch = timeRaw.match(/(.+?)\s*\[/);
        const weekRaw = weekMatch ? weekMatch[1].trim() : timeRaw;
        const sectionRaw = timeRaw.match(/\[([^\]]+)\]/);

        return {
            teacher: teacherMatch ? teacherMatch[1].trim() : "",
            position: positionMatch ? positionMatch[1].trim() : "",
            weeks: parseWeeks(weekRaw),
            sections: parseSections(sectionRaw ? sectionRaw[1] : "")
        };
    }

    /*
     * qz-weeklyTable 使用 rowspan。
     * 因此不能用“第几个 td = 星期几”简单处理。
     * 这里建立一个小型 HTML 网格，计算每个 kbDataTd 的真实列号。
     */
    function collectCourseCells(table) {
        const rows = Array.from(table.querySelectorAll("tbody tr"));
        const occupied = [];
        const cells = [];

        rows.forEach((row, rowIndex) => {
            if (!occupied[rowIndex]) occupied[rowIndex] = [];

            let col = 0;
            const children = Array.from(row.children);

            for (const cell of children) {
                while (occupied[rowIndex][col]) col++;

                const rowSpan = Math.max(1, Number(cell.getAttribute("rowspan") || "1"));
                const colSpan = Math.max(1, Number(cell.getAttribute("colspan") || "1"));

                for (let r = 0; r < rowSpan; r++) {
                    if (!occupied[rowIndex + r]) occupied[rowIndex + r] = [];
                    for (let c = 0; c < colSpan; c++) {
                        occupied[rowIndex + r][col + c] = true;
                    }
                }

                // 第0列是“第几大节”的标签列。
                if (cell.matches('td[name="kbDataTd"]')) {
                    cells.push({
                        cell,
                        day: col // col 0 是标签列，因此星期一为 1
                    });
                }

                col += colSpan;
            }
        });

        return cells;
    }

    function parseCourses() {
        const table = document.querySelector("table.qz-weeklyTable");
        if (!table) {
            throw new Error("没有找到强智课表 table.qz-weeklyTable。请先进入“个人课表信息”页面。");
        }

        const result = [];
        const cells = collectCourseCells(table);

        for (const item of cells) {
            if (item.day < 1 || item.day > 7) continue;

            const lis = Array.from(item.cell.querySelectorAll(
                'ul[name="kbdataUl"] > li.courselists-item'
            ));

            for (const li of lis) {
                const name = text(li.querySelector(".qz-hasCourse-title"));
                const detail = text(li.querySelector(".qz-hasCourse-abbrinfo"));

                if (!name || !detail) continue;

                const parsed = parseTimeInfo(detail);

                if (!parsed.sections || !parsed.weeks.length) {
                    console.warn("[LVTC] 跳过无法解析的课程：", name, detail);
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

                // 可选课程号作为备注，便于排查同名课程。
                const kch = text(li.querySelector('[name="kchSpan"]'))
                    .replace(/^;\s*课程号\s*:\s*/i, "")
                    .trim();

                if (kch) {
                    course.remark = "课程号:" + kch;
                }

                result.push(course);
            }
        }

        return result;
    }

    function findCurrentTerm() {
        const select = document.querySelector("#xnxq01id, select[name='xnxq01id']");
        if (!select) return "";
        const option = select.querySelector("option:checked") || select.querySelector("option[selected]");
        return option ? (option.value || text(option)) : "";
    }

    async function tryNavigateToAcademicSystem() {
        const links = Array.from(document.querySelectorAll("a[href]"));

        const preferred = links.find(a => {
            const label = text(a);
            const href = a.href || "";
            return /教务系统|教务|教学管理/.test(label) ||
                /jsxsd|sso\/login|cas/i.test(href);
        });

        if (preferred) {
            const label = text(preferred) || "教务系统";
            toast("正在打开" + label + "，登录后再次点击“执行导入”。");
            preferred.click();
            return true;
        }

        return false;
    }

    async function importCourses() {
        if (!isSchedulePage()) {
            const navigated = await tryNavigateToAcademicSystem();
            if (navigated) return;

            await alertBox(
                "六安职业技术学院",
                "当前页面不是强智“个人课表信息”页面。\n\n请先完成统一信息门户登录，然后进入：\n教务系统 → 个人课表信息\n再点击“执行导入”。"
            );
            return;
        }

        toast("正在解析六安职业技术学院课表...");

        let courses;
        try {
            courses = parseCourses();
        } catch (e) {
            await alertBox("课表解析失败", e.message || String(e));
            return;
        }

        if (!courses.length) {
            await alertBox(
                "没有解析到课程",
                "页面找到了强智课表结构，但没有识别到有效课程。\n请确认当前学期已经选中并显示课程。"
            );
            return;
        }

        console.log("[LVTC] 学期:", findCurrentTerm());
        console.log("[LVTC] 解析课程:", courses);

        try {
            const ok = await window.shiguangBridgePromise.saveImportedCourses(
                JSON.stringify(courses)
            );

            if (ok === true || ok === "true") {
                toast("六安职业技术学院课表导入成功，共 " + courses.length + " 条课程。");
            } else {
                await alertBox("导入结果", "拾光没有确认导入成功，请查看日志。");
            }
        } catch (e) {
            await alertBox("导入失败", e.message || String(e));
        }
    }

    importCourses();
})();
