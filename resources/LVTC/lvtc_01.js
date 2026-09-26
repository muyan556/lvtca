/**
 * 六安职业技术学院 —— 拾光课程表适配器 (LVTC_01)  v2
 *
 * 教务系统：强智 jsxsd（校园内网 192.168.21.95），须经学校深信服 WebVPN
 * 统一信息门户访问（https://webport.lvtc.edu.cn:8443/ → webvpn.lvtc.edu.cn:8443）。
 *
 * v2 修订依据（docs/evidence/har-findings-20260926.md，2026-09-26 真实抓包）：
 *   1. 教务为强智「新版 2020 UI」，课表数据源为
 *      GET {通道}/jsxsd/xskb/xskb_list.do?viweType=0 —— 返回完整 HTML 网格，
 *      不再是旧版 kbcx/xskbcx_cxXsKb.html 的 kbList JSON 接口。
 *   2. WebVPN 通道前缀为 {origin}/http/webvpn<64位hash>/（内网为 HTTP 站点，
 *      故用 /http/ 而非 /https/；host 被编码为 hash 而非明文 IP），
 *      必须从当前页面 location 动态提取，不得硬编码明文 IP 形式。
 *   3. 学期参数为 xnxq01id（如 2026-2027-1），不复用旧版 xnm/xqm。
 *   4. 作息节次按官方 2021 表（第1节 08:00 起，第5节 14:00 起，共 8 节；
 *      晚自习 18:50-20:30，官方未细分小节，不在预设中拆分）。
 *   5. 登录链路：统一门户（泛微 e-cology + 深信服 WebVPN）SSO 自动带 ticket
 *      登入教务，无需 jsxsd 二次密码；脚本只做「门户已登录 + 教务会话已建立」检测。
 *
 * 运行环境（拾光 App）：
 *   1. 用户选择本适配器 → App 用 WebView 打开 import_url（统一门户登录页）；
 *   2. 用户完成门户登录并进入教务「个人课表查询」页（xskb_list.do 所在页）；
 *   3. 用户点「执行导入」→ App 在当前 WebView 上下文中执行本脚本；
 *   4. 脚本同源 fetch 课表 HTML 接口（自动携带 WebVPN/教务 Cookie），
 *      解析后经 shiguangBridgePromise 写回课表。
 */
(function () {
  "use strict";

  // ------------------------------------------------------------------
  // 0. 常量与路径
  // ------------------------------------------------------------------

  // 教务应用根路径（强智 jsxsd）。
  var JWXT_BASE = "/jsxsd";
  // 课表接口（HTML 网格，HAR 实测）：GET {通道}/jsxsd/xskb/xskb_list.do?viweType=0
  var TIMETABLE_PAGE = "xskb/xskb_list.do";
  // 实测的教务 WebVPN 通道前缀（内网 HTTP 站点的 hash 编码通道；HAR 2026-09-26 记录）
  var DEFAULT_CHANNEL_PREFIX = "/http/webvpn4187770a7c56e43e44257ad4fe6f521f/";

  // 六安职业技术学院作息节次表（官方 2021-10-08 起执行，办公室 2021-09-27 通知）
  // 来源：https://bgs.lvtc.edu.cn/2021/0930/c543a42370/page.htm
  // 说明：官方仅到第8节；晚自习 18:50-20:30 未细分小节，若课表出现 9 节及以后，
  //       请在 App 课表设置中按实际补充。
  var PRESET_TIME_SLOTS = [
    { "number": 1, "startTime": "08:00", "endTime": "08:45" },
    { "number": 2, "startTime": "08:55", "endTime": "09:40" },
    { "number": 3, "startTime": "10:00", "endTime": "10:45" },
    { "number": 4, "startTime": "10:55", "endTime": "11:40" },
    { "number": 5, "startTime": "14:00", "endTime": "14:45" },
    { "number": 6, "startTime": "14:55", "endTime": "15:40" },
    { "number": 7, "startTime": "15:50", "endTime": "16:35" },
    { "number": 8, "startTime": "16:45", "endTime": "17:30" }
  ];

  // 学期边界：9 月起为第一学期（-1），3-8 月为第二学期（-2），1-2 月属上一学年第二学期
  var AUTUMN_START_MONTH = 9;
  var SPRING_START_MONTH = 3;

  // ------------------------------------------------------------------
  // 1. 通用小工具
  // ------------------------------------------------------------------

  /** 根据周次字符串展开为绝对周号数组：支持 "1-16"、"1-8,10-16"、"2-16(双)"、"1-16周"。 */
  function parseWeeks(weekStr) {
    if (!weekStr) return [];
    var weeks = new Set();
    var normalized = String(weekStr)
      .replace(/[（(]/g, "(").replace(/[）)]/g, ")")
      .replace(/[，、]/g, ",")
      .trim();
    var segments = normalized.split(/[,，]/);
    for (var i = 0; i < segments.length; i++) {
      var seg = segments[i].trim();
      var m = /^(\d+)\s*(?:-\s*(\d+))?\s*(?:周)?\s*(?:\(\s*(单|双|单周|双周|全部|周)\s*\))?$/.exec(seg);
      if (!m) continue;
      var start = parseInt(m[1], 10);
      var end = m[2] ? parseInt(m[2], 10) : start;
      if (start < 1 || end > 60 || start > end) continue;
      var flag = 0;
      if (m[3]) {
        if (m[3].indexOf("单") >= 0) flag = 1;
        else if (m[3].indexOf("双") >= 0) flag = 2;
      }
      for (var w = start; w <= end; w++) {
        if (flag === 1 && w % 2 !== 1) continue;
        if (flag === 2 && w % 2 !== 0) continue;
        weeks.add(w);
      }
    }
    return Array.from(weeks).sort(function (a, b) { return a - b; });
  }

  /** 提取对象字段（兼容多种大小写字段名）。 */
  function textOf(obj, keys, fallback) {
    for (var i = 0; i < keys.length; i++) {
      var v = obj && obj[keys[i]];
      if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
    }
    return fallback !== undefined ? fallback : "";
  }

  /** 解析节次字符串 "3-4" / "5" / "1,2,3" → [start, end]，非法返回 null。 */
  function parseSections(sectionStr) {
    if (!sectionStr) return null;
    var parts = String(sectionStr).split(/[-—~至,，、]/);
    var nums = [];
    for (var i = 0; i < parts.length; i++) {
      var n = parseInt(parts[i].trim(), 10);
      if (!isNaN(n) && n >= 1 && n <= 30) nums.push(n);
    }
    if (nums.length === 0) return null;
    return [Math.min.apply(null, nums), Math.max.apply(null, nums)];
  }

  /**
   * 按当前日期推导学期：xnxq01id 字符串，如 "2026-2027-1"。
   * 9 月开学 = 第一学期；3 月开学 = 第二学期；1-2 月归上一学年第二学期。
   */
  function guessXnxq01id() {
    var now = new Date();
    var year = now.getFullYear();
    var month = now.getMonth() + 1;
    if (month >= AUTUMN_START_MONTH) {
      return year + "-" + (year + 1) + "-1";
    }
    if (month >= SPRING_START_MONTH) {
      return (year - 1) + "-" + year + "-2";
    }
    return (year - 1) + "-" + year + "-2"; // 1-2 月：上一学年第二学期
  }

  /** 兼容旧接口：由 xnxq01id 推导学年学期对象 {xnm, xqm}（旧协议口径，仅供参考）。 */
  function guessCurrentTerm() {
    var id = guessXnxq01id();
    var parts = id.split("-");
    return { xnm: parts[0], xqm: parts[2] === "1" ? "3" : "12" };
  }

  /**
   * 提取 WebVPN 的「教务」通道前缀（动态，HAR 实测必须用 hash 形式）。
   * 注意：门户自身通道（/https/webvpn3fa9.../wui/...）与教务通道
   * （/http/webvpn4187770.../jsxsd/...）是**两个不同的 hash**，只有教务通道可拼接 jsxsd 接口。
   * 当前页面 URL 形如：
   *   https://webvpn.lvtc.edu.cn:8443/http/webvpn4187770a7c56e43e44257ad4fe6f521f/jsxsd/...  ← 教务页
   *   https://webvpn.lvtc.edu.cn:8443/https/webvpn3fa9a4b0ee032d18433db6a4825915c405dbddf67bfb6e8477d3cbd14e615f56/wui/...  ← 门户页
   * 返回 "/http/webvpn<64hex>/" 或 "/https/webvpn<64hex>/"；无法判定时为实测默认教务通道。
   */
  function detectChannelPrefix() {
    try {
      var loc = window.location;
      var path = loc.pathname || loc.path || "";
      // 仅当路径指向 jsxsd 时才认为当前在教务通道内，可复用该前缀
      var m = /^\/(https?)\/webvpn([0-9a-f]{40,})\/jsxsd\//i.exec(path);
      if (m) {
        return "/" + m[1].toLowerCase() + "/webvpn" + m[2] + "/";
      }
      // 门户应用中心页（wui）等场景：无法从当前页判定教务通道时使用实测默认值
    } catch (e) { /* noop */ }
    return DEFAULT_CHANNEL_PREFIX;
  }

  /**
   * 拼接教务接口在 WebVPN 通道下的完整 URL（与当前页面同源）。
   * 例：origin=https://webvpn.lvtc.edu.cn:8443，通道=/http/webvpn4187770.../
   *     jwUrl(["xskb","xskb_list.do"]) →
   *     https://webvpn.lvtc.edu.cn:8443/http/webvpn4187770.../jsxsd/xskb/xskb_list.do
   */
  function jwUrl(pathParts) {
    var origin = window.location.origin;
    if (!origin) return null;
    var prefix = detectChannelPrefix();
    var parts = [JWXT_BASE].concat(pathParts || []);
    var path = parts.map(function (p) { return String(p).replace(/^\/+|\/+$/g, ""); }).filter(Boolean).join("/");
    return origin + prefix + path;
  }

  // ------------------------------------------------------------------
  // 2. 教务访问与会话判定（统一门户认证器）
  // ------------------------------------------------------------------

  /**
   * 探测当前 WebView 是否已具备访问教务课表的会话：
   * 直接请求课表接口本身（HAR 实测：未登录时网关会 302 到 sso/login 或返回登录特征页）：
   *  - fetch 重定向到 wui|por|sso|login → 未登录
   *  - 响应 HTML 含登录页特征（"用户登录"、login 表单、wui 门户）→ 未登录
   *  - 响应含课表网格特征（qz-weeklyTable）→ 已登录
   * 返回 { ok, kind }，kind: 'session-ok' | 'login-page' | 'network-error' | 'blocked'。
   */
  async function probeJwSession() {
    var url = jwUrl([TIMETABLE_PAGE]) + "?viweType=0";
    if (!url) return { ok: false, kind: "network-error" };
    try {
      var resp = await fetch(url, {
        method: "GET",
        credentials: "include",
        headers: {
          "X-Requested-With": "XMLHttpRequest",
          "Referer": window.location.href || ""
        }
      });
      if (resp.redirected && /(wui|por|sso\/login|login)/i.test(resp.url)) {
        return { ok: false, kind: "login-page" };
      }
      if (resp.status === 302 || resp.status === 401 || resp.status === 403) {
        return { ok: false, kind: "login-page" };
      }
      var text = await resp.text();
      if (!text) return { ok: false, kind: "network-error" };
      // 课表网格特征 → 已登录
      if (/qz-weeklyTable/.test(text)) {
        return { ok: true, kind: "session-ok" };
      }
      // 登录页 / 门户特征
      if (/(用户登录|登录界面|请输入用户名|login_slogin|sso\/login|wui\/index|融合门户|统一身份认证)/i.test(text)) {
        return { ok: false, kind: "login-page" };
      }
      // WebVPN 网关错误页 / 权限提示
      if (/(没有访问权限|无访问权限|WebVPN|登录超时|会话已过期)/i.test(text) && text.length < 2000) {
        return { ok: false, kind: "blocked" };
      }
      return { ok: true, kind: "session-ok" };
    } catch (e) {
      return { ok: false, kind: "network-error" };
    }
  }

  // ------------------------------------------------------------------
  // 3. 课表 HTML 解析（HAR 实测结构）
  // ------------------------------------------------------------------
  // 表格结构（强智新版 2020 UI 课表网格）：
  //   <table class="qz-weeklyTable">
  //     <tr>（表头）<th>周次</th><th>星期一</th>…<th>星期日</th></tr>
  //     <tr class="qz-weeklyTable-tr">（第一大节…第六大节，6 行）
  //       <td name="timeTd">第一大节</td>
  //       <td name="kbDataTd" rowspan="2" colSize="2">
  //         <ul class="courselists"><li class="courselists-item qz-hasCourse-1">
  //           <div class="qz-hasCourse-title qz-ellipse">模拟飞行</div>
  //           <span class="qz-hasCourse-abbrinfo">老师:张鑫;时间:6-17周[1-4节];地点:知行楼东(知行楼东303)</span>
  //           <span name="kchSpan">;课程号:0315090</span>
  //           <span name="dealeSpan">班级:…;总人数:39;考核方式:考查;总学时:48</span>
  //         </li></ul>
  //       </td>
  //       …
  //     </tr>
  //   </table>
  // 注意：
  //   - 星期 = td 在行内的“列位置”（第1数据列=星期一…第7数据列=星期日），
  //     li 的 qz-hasCourse-N class 是样式冗余（服务端全部输出 1），不可用作星期判定。
  //   - rowspan 会导致后续行 td 数量减少（合并格不重复渲染），解析时必须模拟
  //     表格列布局（把被上行 rowspan 占用的列跳过），否则列位置会错位。
  //   - 节次/周次以 abbrinfo 文本“时间:6-17周[1-4节]”为准；colSize 仅影响界面高度。
  //   - 教室名“知行楼东(知行楼东303)”取括号内为精确地点。
  //   - 一个 td 内可有多门课（多 li），各自独立解析。

  /** 提取 HTML 字符串中 <tr>...</tr> 列表（不含嵌套 tr 的简单解析）。 */
  function splitRows(html) {
    var rows = [];
    var re = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    var m;
    while ((m = re.exec(html)) !== null) {
      rows.push(m[1]);
    }
    return rows;
  }

  /** 提取一行内 <td ...>...</td> 列表，返回 { attrs, html, name, rowspan }。 */
  function splitCells(rowHtml) {
    var cells = [];
    var re = /<td([^>]*)>([\s\S]*?)<\/td>/gi;
    var m;
    while ((m = re.exec(rowHtml)) !== null) {
      var attrs = m[1] || "";
      var name = /name="([^"]*)"/.exec(attrs);
      var rspan = /rowspan="(\d+)"/.exec(attrs);
      var cspan = /colspan="(\d+)"/.exec(attrs);
      cells.push({
        name: name ? name[1].trim() : "",
        rowspan: rspan ? parseInt(rspan[1], 10) : 1,
        colspan: cspan ? parseInt(cspan[1], 10) : 1,
        attrs: attrs,
        html: m[2] || ""
      });
    }
    return cells;
  }

  /**
   * 解析课表 HTML 网格 → 拾光课程 JSON 数组。
   * 模拟表格列布局：维护每行已被上行 rowspan 占用的列序号集合。
   */
  function parseTimetableHtml(html) {
    var courses = [];
    if (!html || typeof html !== "string") return courses;
    var tableRe = /<table[^>]*class="[^"]*qz-weeklyTable[^"]*"[\s\S]*?<\/table>/i;
    var tm = tableRe.exec(html);
    var tableHtml = tm ? tm[0] : html;

    var rows = splitRows(tableHtml);
    if (rows.length === 0) return courses;

    // 表头：第一个 tr 的 th 数量决定列布局（第1列=周次标签，其后为星期一~星期日）
    var headerCells = (function () {
      var ths = [];
      var re = /<th[^>]*>([\s\S]*?)<\/th>/gi;
      var m;
      while ((m = re.exec(rows[0])) !== null) ths.push(m[1]);
      return ths;
    })();
    // 数据列数：默认 7（周一~周日）；以表头 th 数量减 1 为准（兼容首列标签）
    var dataCols = headerCells.length > 1 ? headerCells.length - 1 : 7;
    if (dataCols < 1 || dataCols > 7) dataCols = 7;

    // 每行被占用列的集合（源自上行 rowspan=2+ 的课程格）
    // occupied[rowIndex] = Set(列序号 0-based)
    var occupied = {};

    for (var r = 1; r < rows.length; r++) {
      var rowHtml = rows[r];
      var cells = splitCells(rowHtml);
      var occ = occupied[r] || {};
      var colIdx = 0;      // 0-based 数据列游标
      for (var c = 0; c < cells.length; c++) {
        var cell = cells[c];
        // 行标签格（timeTd）与无 name 的格跳过，不占数据列
        if (cell.name === "timeTd" || (!cell.name && cell.rowspan === 1)) {
          continue;
        }
        // 前进到下一个未占用的列
        while (colIdx < dataCols && occ[colIdx]) colIdx++;
        if (colIdx >= dataCols) break;
        var day = colIdx + 1; // 1=星期一
        var cellCourses = parseCellCourses(cell.html);
        for (var k = 0; k < cellCourses.length; k++) {
          var cc = cellCourses[k];
          courses.push({
            name: cc.name,
            teacher: cc.teacher,
            position: cc.position,
            day: day,
            startSection: cc.startSection,
            endSection: cc.endSection,
            weeks: cc.weeks
          });
        }
        colIdx++;
      }
      // 记录本行 rowspan>1 的格对后续行的占用
      var occ2 = occupied[r] || {};
      colIdx = 0;
      for (var c2 = 0; c2 < cells.length; c2++) {
        var cell2 = cells[c2];
        if (cell2.name === "timeTd" || (!cell2.name && cell2.rowspan === 1)) continue;
        while (colIdx < dataCols && occ2[colIdx]) colIdx++;
        if (colIdx >= dataCols) break;
        if (cell2.rowspan > 1 && cell2.name === "kbDataTd") {
          for (var rr = r + 1; rr < r + cell2.rowspan; rr++) {
            if (!occupied[rr]) occupied[rr] = {};
            occupied[rr][colIdx] = true;
          }
        }
        colIdx++;
      }
    }
    return courses;
  }

  /** 解析一个课表 td 内的所有课程（可能多门）。 */
  function parseCellCourses(cellHtml) {
    var out = [];
    if (!cellHtml) return out;
    var liRe = /<li[^>]*class="[^"]*courselists-item[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
    var m;
    while ((m = liRe.exec(cellHtml)) !== null) {
      var li = m[1];
      // 课程名
      var nameM = /qz-hasCourse-title[^>]*>([\s\S]*?)<\/div/i.exec(li);
      var name = nameM ? cleanText(nameM[1]) : "";
      if (!name) continue;
      // 摘要信息：老师:张鑫;时间:6-17周[1-4节];地点:知行楼东(知行楼东303)
      var abbrM = /qz-hasCourse-abbrinfo[^>]*>([\s\S]*?)<\/span/i.exec(li);
      var abbr = abbrM ? cleanText(abbrM[1]) : "";
      var parsed = parseAbbrInfo(abbr);
      var teacher = parsed.teacher || "未知";
      var position = parsed.position || "未知";
      if (!parsed.sections || parsed.weeks.length === 0) continue; // 缺节次/周次视为异常行
      out.push({
        name: name,
        teacher: teacher,
        position: position,
        startSection: parsed.sections[0],
        endSection: parsed.sections[1],
        weeks: parsed.weeks
      });
    }
    return out;
  }

  /** 清理单元格文本（去空白/换行）。 */
  function cleanText(s) {
    return String(s || "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
  }

  /**
   * 解析 abbrinfo 摘要：`老师:张鑫;时间:6-17周[1-4节];地点:知行楼东(知行楼东303)`
   * 返回 { teacher, position, weeks, sections }。
   * 兼容：时间含多段（"1-8周[1-2节],10-16周[3-4节]"）、单双周（"2-6(双)周[3-4节]"）、
   * 地点含括号（取括号内精确教室）。
   */
  function parseAbbrInfo(abbr) {
    var teacher = "";
    var position = "";
    var weeksAcc = [];
    var sections = null;
    if (!abbr) return { teacher: "", position: "", weeks: [], sections: null };

    // 老师
    var tm = /老师[:：]\s*([^;；]*)/.exec(abbr);
    if (tm && tm[1].trim()) teacher = tm[1].trim();

    // 地点：优先括号内（精确教室），否则整体
    var pm = /地点[:：]\s*([^;；]*)/.exec(abbr);
    if (pm) {
      var raw = pm[1].trim();
      var inner = /\(([^()]*)\)/.exec(raw);
      position = inner && inner[1].trim() ? inner[1].trim() : raw;
    }

    // 时间：匹配所有「N-M(单/双)?周[节次]」片段（兼容多段、单双周）
    // 兼容形如：6-17周[1-4节] / 2-6(双)周[3-4节] / 1-8(单),10-16周[1-2节]
    var timeRe = /([\d\-~至,，、]+(?:\s*[（(]\s*[单双]\s*[）)])?)\s*(?:周)?\s*[\[（(]\s*([\d\-~至,，、]+)\s*节\s*[\]）)]/g;
    var mt;
    while ((mt = timeRe.exec(abbr)) !== null) {
      var weekPart = mt[1].trim();
      var secPart = mt[2].trim();
      // 周次部分直接交给 parseWeeks（兼容 "1-8(单)"、"2-6(双)"、"1-8,10-16"）
      var wl = parseWeeks(weekPart);
      var sec = parseSections(secPart);
      weeksAcc = weeksAcc.concat(wl);
      if (sec) {
        if (!sections) sections = sec;
        else sections = [Math.min(sections[0], sec[0]), Math.max(sections[1], sec[1])];
      }
    }

    // 去重排序
    var uniq = [];
    var seen = {};
    for (var i = 0; i < weeksAcc.length; i++) {
      var w = weeksAcc[i];
      if (!seen[w]) { seen[w] = true; uniq.push(w); }
    }
    uniq.sort(function (a, b) { return a - b; });

    return { teacher: teacher, position: position, weeks: uniq, sections: sections };
  }

  /** 从当前页面读取学年学期下拉（xnxq01id）。 */
  function readTermFromPage() {
    try {
      var el = document.querySelector("#xnxq01id") || document.querySelector('[name="xnxq01id"]');
      if (el && el.value) return el.value.trim();
      var sel = document.querySelector("#xnxq01id option:checked, [name='xnxq01id'] option:checked");
      if (sel && sel.value) return sel.value.trim();
    } catch (e) { /* noop */ }
    return null;
  }

  /**
   * 请求课表 HTML 接口并解析。
   * term：期望的 xnxq01id（如 "2026-2027-1"）；服务端按当前会话默认学期返回，
   * 若接口返回的页面下拉选中项与期望不同，则以返回页面的 h1 下拉为准并返回实际学期。
   * 返回 { courses, term }。
   */
  async function fetchTimetable(term) {
    var want = term || guessXnxq01id();
    var url = jwUrl([TIMETABLE_PAGE]) + "?viweType=0";
    if (!url) return { courses: [], term: want };
    try {
      var resp = await fetch(url, {
        method: "GET",
        credentials: "include",
        headers: {
          "X-Requested-With": "XMLHttpRequest",
          "Referer": window.location.href || ""
        }
      });
      if (resp.redirected && /(wui|por|sso\/login|login)/i.test(resp.url)) {
        return { courses: [], term: want };
      }
      var text = await resp.text();
      if (!text) return { courses: [], term: want };
      // 实际学期：优先接口返回页面下拉的选中项
      var actual = (function () {
        var sm = /<select[^>]*id="xnxq01id"[^>]*>([\s\S]*?)<\/select>/i.exec(text);
        if (sm) {
          var om = /<option[^>]*value="([^"]*)"[^>]*selected[^>]*>/.exec(sm[1]);
          if (om) return om[1].trim();
        }
        return null;
      })();
      var resolvedTerm = actual || readTermFromPage() || want;
      var courses = parseTimetableHtml(text);
      if (courses.length > 0 && actual && actual !== want) {
        // 期望学期与教务实际学期不一致：仍返回解析到的（当前学期课表），并带实际学期
      }
      return { courses: courses, term: resolvedTerm };
    } catch (e) {
      return { courses: [], term: want };
    }
  }

  // ------------------------------------------------------------------
  // 4. 主流程
  // ------------------------------------------------------------------

  async function runImportFlow() {
    var bridge = window.shiguangBridgePromise;

    // 4.1 会话检测：必须已登录门户并访问到教务
    var probe = await probeJwSession();
    if (!probe.ok) {
      var hint = probe.kind === "network-error"
        ? "无法连接到教务系统。请确认网络可用后重试。"
        : probe.kind === "blocked"
          ? "教务返回「无访问权限」，请确认账号有课表查询权限，或稍后重试。"
          : "请先在学校统一信息门户（webport.lvtc.edu.cn:8443）完成登录，并进入教务系统「个人课表查询」页（xskb_list.do）后，再点击执行导入。";
      await bridge.showAlert("未检测到登录状态", hint, "我知道了");
      return;
    }

    // 4.2 学期：优先当前课表页下拉，否则按日期推导
    var term = readTermFromPage() || guessXnxq01id();
    if (!term) {
      await bridge.showAlert("无法确定学期", "当前日期无法推导学年学期，请在课表查询页选择学年学期后重试。", "我知道了");
      return;
    }

    window.shiguangBridge.showToast("正在获取课表数据...");

    var result = await fetchTimetable(term);
    if (result.courses.length === 0) {
      await bridge.showAlert(
        "未找到课程数据",
        "教务课表页未解析出课程（学期 " + result.term + "）。\n请确认：1) 已进入教务「个人课表查询」页并正常显示课表；2) 所选学期有课；3) 教务接口未被拦截。",
        "我知道了"
      );
      return;
    }

    // 4.3 写回课表
    var savedCourses = await bridge.saveImportedCourses(JSON.stringify(result.courses));
    await bridge.savePresetTimeSlots(JSON.stringify(PRESET_TIME_SLOTS));
    await bridge.saveCourseConfig(JSON.stringify({
      semesterTotalWeeks: 20,
      defaultClassDuration: 45,
      defaultBreakDuration: 10,
      firstDayOfWeek: 1
    }));

    if (savedCourses === true) {
      window.shiguangBridge.showToast("成功导入 " + result.courses.length + " 门课程！");
      window.shiguangBridge.notifyTaskCompletion();
    } else {
      await bridge.showAlert("导入失败", "课程数据已获取但保存失败，请重试或联系适配器维护者。", "知道了");
    }
  }

  // 拾光 WebView 环境：自动执行；Node 测试环境：导出内部函数供单测
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      parseWeeks: parseWeeks,
      parseSections: parseSections,
      textOf: textOf,
      guessXnxq01id: guessXnxq01id,
      guessCurrentTerm: guessCurrentTerm,
      detectChannelPrefix: detectChannelPrefix,
      jwUrl: jwUrl,
      parseTimetableHtml: parseTimetableHtml,
      parseCellCourses: parseCellCourses,
      parseAbbrInfo: parseAbbrInfo,
      fetchTimetable: fetchTimetable,
      probeJwSession: probeJwSession,
      PRESET_TIME_SLOTS: PRESET_TIME_SLOTS,
      _runImportFlow: runImportFlow
    };
  }
  // 拾光 App 注入执行（测试环境通过 __LVTC_TEST__ 抑制自动运行）
  if (typeof window !== "undefined" && window.shiguangBridgePromise && !window.__LVTC_TEST__) {
    runImportFlow();
  }
})();