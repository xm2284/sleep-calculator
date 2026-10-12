/**
 * sleep-core.js —— 睡眠计算核心算法模块
 * 零依赖。Node 直接跑：node sleep-core.js
 * 浏览器：<script src="sleep-core.js"></script> 后使用 window.SleepCore
 *
 * 覆盖能力：
 *   1. 给定起床时间 → 推荐就寝时间序列
 *   2. 给定就寝时间 → 推荐起床时间序列
 *   3. 小憩计算
 *   4. 睡眠负债
 *   5. 咖啡因截止线
 *   6. 周期/质量分档
 */

const DEFAULTS = {
  cycleMin: 90,        // 睡眠周期长度，个体 80~120
  latencyMin: 15,      // 入睡潜伏期（躺下到睡着）
  minCycles: 3,
  maxCycles: 6,
  bestCycles: [5, 6],  // 视为「最佳」的周期数
};

/* ---------- 工具 ---------- */

// "23:00" / "7:00" → 当天的 Date（用固定基准日，避免跨天歧义）
function parseTimeHHMM(str, baseDate = new Date(2000, 0, 1)) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(str).trim());
  if (!m) throw new Error(`时间格式应为 HH:MM，收到: ${str}`);
  const h = Number(m[1]), mi = Number(m[2]);
  if (h > 23 || mi > 59) throw new Error(`非法时间: ${str}`);
  const d = new Date(baseDate);
  d.setHours(h, mi, 0, 0);
  return d;
}

function fmtHHMM(date) {
  const h = String(date.getHours()).padStart(2, "0");
  const m = String(date.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

// 中文时段标签（LF 版同款切分）
function periodCN(hour) {
  if (hour < 6) return "凌晨";
  if (hour < 9) return "早上";
  if (hour < 12) return "上午";
  if (hour < 13) return "中午";
  if (hour < 18) return "下午";
  if (hour < 22) return "晚上";
  return "深夜";
}

// 质量分档
function grade(cycles, best = DEFAULTS.bestCycles) {
  if (best.includes(cycles)) return { key: "optimal", label: "最佳时长" };
  if (cycles > Math.max(...best)) return { key: "plenty", label: "睡眠充足" };
  if (cycles >= 4) return { key: "ok", label: "勉强够" };
  return { key: "short", label: "睡眠不足" };
}

/* ---------- 1. 就寝时间推荐 ---------- */

/**
 * @param {string|Date} wakeUp  想醒来的时间
 * @param {object} opt  { cycleMin, latencyMin, minCycles, maxCycles }
 * @returns {Array} 从早到晚排序的候选，含 cycles/hours/grade
 */
function bedtimesFor(wakeUp, opt = {}) {
  const { cycleMin, latencyMin, minCycles, maxCycles } = { ...DEFAULTS, ...opt };
  const base = wakeUp instanceof Date ? wakeUp : parseTimeHHMM(wakeUp);
  const out = [];
  for (let n = minCycles; n <= maxCycles; n++) {
    const d = new Date(base);
    d.setMinutes(d.getMinutes() - (latencyMin + n * cycleMin));
    const hours = +(n * cycleMin / 60).toFixed(2);
    out.push({
      time: fmtHHMM(d),
      period: periodCN(d.getHours()),
      cycles: n,
      hours,
      raw: d,
      ...{ grade: grade(n, opt.bestCycles || DEFAULTS.bestCycles).key,
           gradeLabel: grade(n, opt.bestCycles || DEFAULTS.bestCycles).label },
    });
  }
  return out.sort((a, b) => a.raw - b.raw);
}

/* ---------- 2. 起床时间推荐 ---------- */

function waketimesFor(bedtime, opt = {}) {
  const { cycleMin, latencyMin, minCycles, maxCycles } = { ...DEFAULTS, ...opt };
  const base = bedtime instanceof Date ? bedtime : parseTimeHHMM(bedtime);
  const out = [];
  for (let n = minCycles; n <= maxCycles; n++) {
    const d = new Date(base);
    d.setMinutes(d.getMinutes() + latencyMin + n * cycleMin);
    const hours = +(n * cycleMin / 60).toFixed(2);
    const g = grade(n, opt.bestCycles || DEFAULTS.bestCycles);
    out.push({
      time: fmtHHMM(d),
      period: periodCN(d.getHours()),
      cycles: n,
      hours,
      raw: d,
      grade: g.key,
      gradeLabel: g.label,
    });
  }
  return out.sort((a, b) => a.raw - b.raw);
}

/* ---------- 3. 小憩 ---------- */

const NAP_PRESETS = {
  20: "能量小睡 —— 快速恢复精力，不进入深睡",
  60: "轻度恢复 —— 有助记忆巩固",
  90: "完整周期 —— 充分恢复，但留意睡醒昏沉",
};

function napPlan(now, napMinutes = 20, latencyMin = 0) {
  const start = now instanceof Date ? now : new Date();
  const wake = new Date(start.getTime() + (latencyMin + napMinutes) * 60000);
  const total = latencyMin + napMinutes;
  return {
    sleepAt: fmtHHMM(start),
    wakeAt: fmtHHMM(wake),
    wakePeriod: periodCN(wake.getHours()),
    napMinutes,
    latencyMin,
    totalMinutes: total,
    // 相对真实睡眠周期的等效周期数（20/60 不足一整周期）
    cycles: +(napMinutes / 90).toFixed(2),
    note: NAP_PRESETS[napMinutes] || `${napMinutes} 分钟小憩`,
  };
}

/* ---------- 4. 睡眠负债 ---------- */

/**
 * @param {number[]} actualHours   最近 N 天实际睡眠小时数（按时间正序）
 * @param {number}   targetHours   每日目标（成人 7~9，默认 8）
 * @returns 债务明细 + 补觉建议
 */
function sleepDebt(actualHours, targetHours = 8) {
  const days = actualHours.length;
  const debt = actualHours.reduce((s, h) => s + (targetHours - h), 0);
  // 以 7.5h（5 周期）为一个「可恢复单位」估算补觉夜数
  const recoverNights = Math.max(0, Math.ceil(debt / 1.5));
  return {
    days,
    targetHours,
    totalDebtHours: +debt.toFixed(2),
    avgHours: +(actualHours.reduce((s, h) => s + h, 0) / days).toFixed(2),
    // 经验值：每夜最多额外补 1~1.5h，超出会打乱节律
    advice:
      debt <= 0
        ? "没有负债，保持当前作息。"
        : debt < 3
        ? "轻度负债，接下来两晚各早睡 30~60 分钟即可。"
        : debt < 8
        ? `中度负债，建议连续 ${recoverNights} 晚把就寝时间提前 1~1.5 小时，比周末一次性猛补更有效。`
        : `重度负债（${debt.toFixed(1)}h），别指望周末一次补回，按每晚多睡 1~1.5h 分 ${recoverNights} 晚摊平。`,
  };
}

/** 社会时差：工作日 vs 休息日的睡眠中点之差（小时） */
function socialJetlag(workdayMid, freeMid) {
  const toMin = (s) => {
    const d = parseTimeHHMM(s);
    // 把凌晨时间视作 +24h，避免跨日符号翻转
    return d.getHours() * 60 + d.getMinutes() + (d.getHours() < 12 ? 24 * 60 : 0);
  };
  const diff = Math.abs(toMin(freeMid) - toMin(workdayMid)) / 60;
  return {
    hours: +diff.toFixed(2),
    level: diff < 1 ? "正常" : diff < 2 ? "偏大" : "严重",
  };
}

/* ---------- 5. 咖啡因截止线 ---------- */

const CAFFEINE_SOURCES = {
  "美式(中杯)": 150, "拿铁(中杯)": 75, "意式浓缩": 63, "手冲咖啡": 120,
  "红茶": 47, "绿茶": 28, "可乐(330ml)": 34, "能量饮料": 80, "奶茶": 60,
};

/**
 * @param {string|Date} drinkAt   喝下的时间
 * @param {number} mg             摄入量
 * @param {string|Date} sleepAt   计划入睡时间
 * @param {number} halfLifeH      半衰期（成人均值 5h，孕期/服避孕药可到 8~15h）
 */
function caffeineCutoff(drinkAt, mg, sleepAt, halfLifeH = 5) {
  const t0 = drinkAt instanceof Date ? drinkAt : parseTimeHHMM(drinkAt);
  const t1 = sleepAt instanceof Date ? sleepAt : parseTimeHHMM(sleepAt);
  let gapH = (t1 - t0) / 3600000;
  if (gapH < 0) gapH += 24;
  const remaining = mg * Math.pow(0.5, gapH / halfLifeH);
  // 一般认为睡前血中残留 <50mg 影响较小
  const safe = remaining < 50;
  return {
    gapHours: +gapH.toFixed(2),
    remainingMg: +remaining.toFixed(1),
    safe,
    advice: safe
      ? `睡前残留约 ${remaining.toFixed(0)}mg，影响较小。`
      : `睡前仍有约 ${remaining.toFixed(0)}mg 咖啡因，建议再提前 ${Math.ceil(
          Math.log(remaining / 50) / Math.log(2) * halfLifeH
        )} 小时喝完，或改喝低因。`,
  };
}

/* ---------- 导出 ---------- */

const SleepCore = {
  DEFAULTS, parseTimeHHMM, fmtHHMM, periodCN, grade,
  bedtimesFor, waketimesFor, napPlan, sleepDebt, socialJetlag,
  caffeineCutoff, CAFFEINE_SOURCES, NAP_PRESETS,
};

if (typeof module !== "undefined" && module.exports) module.exports = SleepCore;
if (typeof window !== "undefined") window.SleepCore = SleepCore;

/* ---------- 自测 ---------- */
if (require.main === module) {
  const line = (t) => console.log("\n=== " + t + " ===");

  line("想 7:00 起床，潜伏期 15min → 该几点睡");
  console.table(bedtimesFor("07:00").map(r => ({
    入睡: r.time + " " + r.period, 周期: r.cycles, 时长: r.hours + "h", 评级: r.gradeLabel,
  })));

  line("23:15 上床，潜伏期 15min → 该几点起");
  console.table(waketimesFor("23:15").map(r => ({
    起床: r.time + " " + r.period, 周期: r.cycles, 时长: r.hours + "h", 评级: r.gradeLabel,
  })));

  line("现在 13:20 小憩 20 分钟");
  console.log(napPlan(new Date(2000, 0, 1, 13, 20), 20, 0));

  line("最近 7 天睡眠负债（目标 8h）");
  console.log(sleepDebt([6, 5.5, 7, 4, 8, 6.5, 7.5], 8));

  line("社会时差：工作日中点 03:00 vs 休息日中点 05:00");
  console.log(socialJetlag("03:00", "05:00"));

  line("14:00 喝了 150mg 咖啡，计划 23:30 睡");
  console.log(caffeineCutoff("14:00", 150, "23:30", 5));
}
