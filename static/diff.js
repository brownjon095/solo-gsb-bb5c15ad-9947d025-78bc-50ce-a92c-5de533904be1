"use strict";

// 双次抓包差异定位（A/B 对比）。
// 复用 app.js 中的全局函数：parseOffset / hexOff / fmtRange / fillRangeList / addStat
// （app.js 先于本文件加载）。

const DIFF_LIST_LIMIT = 400;
const DIFF_MAX_WINDOW = 65536;

const diffEls = {
  expected: document.getElementById("diffExpected"),
  winStart: document.getElementById("diffWinStart"),
  winLen: document.getElementById("diffWinLen"),
  fragA: document.getElementById("fragmentsA"),
  fragB: document.getElementById("fragmentsB"),
  addA: document.getElementById("addFragA"),
  addB: document.getElementById("addFragB"),
  demo: document.getElementById("diffDemo"),
  submit: document.getElementById("diffSubmit"),
  prev: document.getElementById("diffPrev"),
  next: document.getElementById("diffNext"),
  prev2: document.getElementById("diffPrev2"),
  next2: document.getElementById("diffNext2"),
  error: document.getElementById("diffError"),
  resultCard: document.getElementById("diffResultCard"),
};

const DIFF_REASON_LABEL = { gap: "缺口", conflict: "冲突" };

// ------------------------------ 分片表单 -----------------------------------

function diffAddFragment(container, offset = "", data = "") {
  const row = document.createElement("div");
  row.className = "frag-row";
  row.innerHTML = `
    <input class="frag-offset" placeholder="如 12 或 0x0c" spellcheck="false" />
    <input class="frag-data" placeholder="如 48656c6c6f 或 48:65:6c" spellcheck="false" />
    <span class="col-op">
      <span class="idx"></span>
      <button type="button" class="del" title="删除该分片">✕</button>
    </span>`;
  row.querySelector(".frag-offset").value = offset;
  row.querySelector(".frag-data").value = data;
  row.querySelector(".del").addEventListener("click", () => {
    row.remove();
    diffRefreshIndexes(container);
  });
  container.appendChild(row);
  diffRefreshIndexes(container);
  return row;
}

function diffRefreshIndexes(container) {
  container.querySelectorAll(".frag-row").forEach((row, i) => {
    row.querySelector(".idx").textContent = `#${i + 1}`;
  });
}

function diffCollect(container, expected, sideLabel) {
  const rows = [...container.querySelectorAll(".frag-row")];
  const fragments = [];
  rows.forEach((row, i) => {
    const offText = row.querySelector(".frag-offset").value;
    const dataText = row.querySelector(".frag-data").value;
    if (offText.trim() === "" && dataText.trim() === "") return; // 跳过完全空行
    const off = parseOffset(offText, `${sideLabel}分片 #${i + 1} 的起始偏移`);
    const stripped = dataText.replace(/[\s:_-]/g, "");
    if (stripped === "") throw new Error(`${sideLabel}分片 #${i + 1} 的十六进制内容为空`);
    if (stripped.length % 2 !== 0) {
      throw new Error(`${sideLabel}分片 #${i + 1} 的十六进制长度为奇数（${stripped.length}）`);
    }
    if (!/^[0-9a-fA-F]+$/.test(stripped)) {
      throw new Error(`${sideLabel}分片 #${i + 1} 含非法十六进制字符`);
    }
    if (off + stripped.length / 2 > expected) {
      throw new Error(
        `${sideLabel}分片 #${i + 1}（偏移 ${off}，长度 ${stripped.length / 2}）超出预期长度 ${expected}`
      );
    }
    fragments.push({ offset: off, data: stripped });
  });
  if (fragments.length === 0) {
    throw new Error(`${sideLabel}至少需要填写一个分片（起始偏移 + 十六进制内容）`);
  }
  return fragments;
}

// ------------------------------ 提交与窗口平移 ------------------------------

function diffShowError(msg) {
  diffEls.error.textContent = msg;
  diffEls.error.hidden = false;
}

function readWindowInputs() {
  const expected = parseOffset(diffEls.expected.value, "预期字节数");
  const winStart = parseOffset(diffEls.winStart.value, "窗口起点");
  const winLen = parseOffset(diffEls.winLen.value, "窗口长度");
  if (winLen < 1) throw new Error("窗口长度至少为 1 字节");
  if (winLen > DIFF_MAX_WINDOW) {
    throw new Error(`窗口长度 ${winLen} 超过上限 ${DIFF_MAX_WINDOW}`);
  }
  if (winStart + winLen > expected) {
    throw new Error(`比较窗口 [${winStart}, ${winStart + winLen}) 超出预期长度 ${expected}`);
  }
  return { expected, winStart, winLen };
}

function submitDiff() {
  diffEls.error.hidden = true;
  let win, fragmentsA, fragmentsB;
  try {
    win = readWindowInputs();
    fragmentsA = diffCollect(diffEls.fragA, win.expected, "A 侧");
    fragmentsB = diffCollect(diffEls.fragB, win.expected, "B 侧");
  } catch (e) {
    diffShowError(e.message);
    return;
  }

  diffEls.submit.disabled = true;
  diffEls.submit.textContent = "对比中…";
  fetch("/api/diff", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      expected_length: win.expected,
      window_start: win.winStart,
      window_length: win.winLen,
      fragments_a: fragmentsA,
      fragments_b: fragmentsB,
    }),
  })
    .then(async (resp) => {
      const body = await resp.json();
      if (!resp.ok) throw new Error(body.detail || `HTTP ${resp.status}`);
      renderDiff(body);
    })
    .catch((e) => diffShowError(e.message))
    .finally(() => {
      diffEls.submit.disabled = false;
      diffEls.submit.textContent = "对比";
    });
}

function shiftDiffWindow(dir) {
  diffEls.error.hidden = true;
  let expected, winStart, winLen;
  try {
    expected = parseOffset(diffEls.expected.value, "预期字节数");
    winStart = parseOffset(diffEls.winStart.value, "窗口起点");
    winLen = parseOffset(diffEls.winLen.value, "窗口长度");
    if (winLen < 1) throw new Error("窗口长度至少为 1 字节");
  } catch (e) {
    diffShowError(e.message);
    return;
  }
  const maxStart = Math.max(0, expected - winLen);
  const next = Math.max(0, Math.min(winStart + dir * winLen, maxStart));
  diffEls.winStart.value = String(next);
  submitDiff();
}

// ------------------------------ 渲染 ---------------------------------------

function renderDiffBar(r) {
  const bar = document.getElementById("diffBar");
  bar.innerHTML = "";
  const hint = document.getElementById("diffBarHint");
  const w = r.window;
  const total = w.length;

  const BUCKETS = 1200;
  // state: 0 相同 1 不同 2 不可判定（桶内取最严重类别）
  const state = new Uint8Array(Math.min(total, BUCKETS));
  const buckets = state.length;
  const scale = total / buckets;

  const apply = (runs, level) => {
    runs.forEach(([s, e]) => {
      const b0 = Math.floor(((s - w.start) * buckets) / total);
      const b1 = Math.max(b0 + 1, Math.ceil(((e - w.start) * buckets) / total));
      for (let b = b0; b < Math.min(b1, buckets); b++) {
        if (state[b] < level) state[b] = level;
      }
    });
  };
  apply(r.diff_runs, 1);
  apply(r.undecidable_runs.map((u) => [u.start, u.end]), 2);

  const names = ["相同", "不同", "不可判定"];
  const cls = ["covered", "conflict", "undecidable"];
  let i = 0;
  while (i < buckets) {
    const st = state[i];
    let j = i + 1;
    while (j < buckets && state[j] === st) j++;
    const seg = document.createElement("div");
    seg.className = `seg ${cls[st]}`;
    seg.style.flex = String(j - i);
    const offS = w.start + Math.floor(i * scale);
    const offE = w.start + Math.floor(j * scale);
    seg.title = `${names[st]}：[${offS}, ${offE})  (${hexOff(offS)} - ${hexOff(offE)})`;
    bar.appendChild(seg);
    i = j;
  }
  hint.textContent =
    buckets < total
      ? `共 ${buckets} 个示意桶（每桶 ≈ ${scale.toFixed(2)} 字节，悬停看范围）`
      : "每格 1 字节，悬停看范围";
}

function renderDiffReasons(r) {
  const ul = document.getElementById("undecidableList");
  ul.innerHTML = "";
  const runs = r.undecidable_runs;
  if (runs.length === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "无不可判定字节：窗口内每个偏移两侧均为唯一值";
    ul.appendChild(li);
    return;
  }
  runs.slice(0, DIFF_LIST_LIMIT).forEach((u) => {
    const parts = [];
    if (u.reason_a) parts.push(`A侧${DIFF_REASON_LABEL[u.reason_a]}`);
    if (u.reason_b) parts.push(`B侧${DIFF_REASON_LABEL[u.reason_b]}`);
    const li = document.createElement("li");
    li.textContent = `${fmtRange([u.start, u.end])} ｜ ${parts.join("，")}`;
    li.title = `十进制 [${u.start}, ${u.end})`;
    ul.appendChild(li);
  });
  if (runs.length > DIFF_LIST_LIMIT) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = `… 其余 ${runs.length - DIFF_LIST_LIMIT} 个区间已省略`;
    ul.appendChild(li);
  }
}

function renderDiff(r) {
  diffEls.resultCard.hidden = false;
  diffEls.resultCard.scrollIntoView({ behavior: "smooth", block: "start" });

  const w = r.window;
  const c = r.counts;
  const banner = document.getElementById("diffBanner");
  if (c.diff === 0 && c.undecidable === 0) {
    banner.className = "banner ok";
    banner.textContent = `✓ 窗口 [${w.start}, ${w.end}) 内 ${c.same} 字节两侧全部一致。`;
  } else if (c.diff === 0) {
    banner.className = "banner warn";
    banner.textContent =
      `窗口 [${w.start}, ${w.end})：可判定字节全部一致（相同 ${c.same} 字节），` +
      `另有 ${c.undecidable} 字节不可判定（存在缺口或冲突）。`;
  } else {
    banner.className = "banner bad";
    banner.textContent =
      `✗ 窗口 [${w.start}, ${w.end})：不同 ${c.diff} 字节` +
      (c.undecidable ? `，不可判定 ${c.undecidable} 字节` : "") +
      `（相同 ${c.same} 字节）。`;
  }

  const stats = document.getElementById("diffStats");
  stats.innerHTML = "";
  [
    ["窗口范围", `[${w.start}, ${w.end}) 长度 ${w.length}`],
    ["相同字节", c.same, c.diff === 0 ? "ok" : ""],
    ["不同字节", c.diff, c.diff ? "bad" : "ok"],
    ["不可判定字节", c.undecidable, c.undecidable ? "warn" : "ok"],
    ["A 侧分片数 / 冲突字节", `${r.sides.a.fragment_count} / ${r.sides.a.conflict_length}`, r.sides.a.conflict_length ? "warn" : ""],
    ["B 侧分片数 / 冲突字节", `${r.sides.b.fragment_count} / ${r.sides.b.conflict_length}`, r.sides.b.conflict_length ? "warn" : ""],
  ].forEach(([k, v, cls]) => stats.appendChild(addStat(k, v, cls)));

  renderDiffBar(r);

  document.getElementById("diffCount").textContent = `（${r.diff_runs.length} 段）`;
  document.getElementById("undecidableCount").textContent = `（${r.undecidable_runs.length} 段）`;
  fillRangeList(
    document.getElementById("diffList"),
    r.diff_runs,
    "无差异：窗口内可判定字节两侧全部一致",
    DIFF_LIST_LIMIT
  );
  renderDiffReasons(r);

  const tbody = document.querySelector("#sideTable tbody");
  tbody.innerHTML = "";
  const A = r.sides.a;
  const B = r.sides.b;
  [
    ["分片数", A.fragment_count, B.fragment_count],
    ["覆盖字节", A.covered_length, B.covered_length],
    ["缺口字节", A.gap_length, B.gap_length],
    ["冲突字节", A.conflict_length, B.conflict_length],
    ["同值去重字节", A.duplicate_bytes, B.duplicate_bytes],
    ["按序到达", A.in_order ? "是" : "否（乱序）", B.in_order ? "是" : "否（乱序）"],
  ].forEach(([k, va, vb]) => {
    const tr = document.createElement("tr");
    const th = document.createElement("th");
    th.textContent = k;
    const tdA = document.createElement("td");
    tdA.textContent = va;
    const tdB = document.createElement("td");
    tdB.textContent = vb;
    tr.append(th, tdA, tdB);
    tbody.appendChild(tr);
  });
}

// ------------------------------ 事件绑定 -----------------------------------

diffEls.addA.addEventListener("click", () => diffAddFragment(diffEls.fragA));
diffEls.addB.addEventListener("click", () => diffAddFragment(diffEls.fragB));
diffEls.submit.addEventListener("click", submitDiff);
diffEls.prev.addEventListener("click", () => shiftDiffWindow(-1));
diffEls.prev2.addEventListener("click", () => shiftDiffWindow(-1));
diffEls.next.addEventListener("click", () => shiftDiffWindow(1));
diffEls.next2.addEventListener("click", () => shiftDiffWindow(1));

diffEls.demo.addEventListener("click", () => {
  // 预期 24 字节：A 侧在偏移 22 处有冲突，B 侧缺 [12,16)，偏移 17 处两侧取值不同
  diffEls.expected.value = "24";
  diffEls.winStart.value = "0";
  diffEls.winLen.value = "24";
  diffEls.fragA.innerHTML = "";
  diffEls.fragB.innerHTML = "";
  [
    ["0", "000102030405060708090a0b0c0d0e0f"], // [0,16)
    ["16", "1011121314151617"],                 // [16,24)
    ["20", "1415ff17"],                         // [20,24)，偏移 22 处 ff≠16 -> A 侧冲突
  ].forEach(([o, d]) => diffAddFragment(diffEls.fragA, o, d));
  [
    ["0", "000102030405060708090a0b"],          // [0,12)，留出缺口 [12,16)
    ["16", "1099121314151617"],                 // [16,24)，偏移 17 处 99≠11 -> 差异
  ].forEach(([o, d]) => diffAddFragment(diffEls.fragB, o, d));
  diffEls.resultCard.hidden = true;
  diffEls.error.hidden = true;
});

// 输入发生变化后，旧的对比结果不再可信，隐藏结果区
function invalidateDiff() {
  diffEls.resultCard.hidden = true;
  diffEls.error.hidden = true;
}
[diffEls.expected, diffEls.winStart, diffEls.winLen].forEach((el) =>
  el.addEventListener("input", invalidateDiff)
);
diffEls.fragA.addEventListener("input", invalidateDiff);
diffEls.fragB.addEventListener("input", invalidateDiff);

// 初始两侧各放一个空分片，方便直接输入
diffAddFragment(diffEls.fragA);
diffAddFragment(diffEls.fragB);
