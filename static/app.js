"use strict";

const LIST_LIMIT = 400;

const els = {
  expectedLength: document.getElementById("expectedLength"),
  fragments: document.getElementById("fragments"),
  addFrag: document.getElementById("addFrag"),
  submit: document.getElementById("submit"),
  prioSubmit: document.getElementById("prioSubmit"),
  loadDemoPrio: document.getElementById("loadDemoPrio"),
  error: document.getElementById("error"),
  resultCard: document.getElementById("resultCard"),
  loadDemoGap: document.getElementById("loadDemoGap"),
  loadDemoOk: document.getElementById("loadDemoOk"),
};

// 优先级可接受任意整数（含负数），范围与服务端 PRIORITY_VALUE_LIMIT 对齐
const PRIORITY_VALUE_LIMIT = Number.MAX_SAFE_INTEGER;

function parsePriority(text, what) {
  const t = text.trim();
  if (t === "") return 0; // 缺省为 0
  if (!/^[+-]?\d+$/.test(t)) {
    throw new Error(`${what} 只能是整数（默认 0）：${t}`);
  }
  const n = parseInt(t, 10);
  if (!Number.isSafeInteger(n) || Math.abs(n) > PRIORITY_VALUE_LIMIT) {
    throw new Error(`${what} 超出允许范围：${t}`);
  }
  return n;
}

function parseOffset(text, what) {
  const t = text.trim();
  if (t === "") throw new Error(`请填写${what}`);
  let n;
  if (/^0x[0-9a-fA-F]+$/.test(t)) {
    n = parseInt(t, 16);
  } else if (/^\d+$/.test(t)) {
    n = parseInt(t, 10);
  } else {
    throw new Error(`${what} 只能是十进制或 0x 开头的十六进制整数：${t}`);
  }
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error(`${what} 非法：${t}`);
  }
  return n;
}

function hexByteLen(hex) {
  return hex.replace(/[\s:_-]/g, "").length / 2;
}

let fragSeq = 0;

function addFragment(offset = "", data = "", priority = "") {
  fragSeq += 1;
  const row = document.createElement("div");
  row.className = "frag-row single-frag-row";
  row.innerHTML = `
    <input class="frag-offset" placeholder="如 12 或 0x0c" spellcheck="false" />
    <input class="frag-priority" placeholder="0" inputmode="numeric" spellcheck="false" title="整数优先级，默认 0，越大越优先" />
    <input class="frag-data" placeholder="如 48656c6c6f 或 48:65:6c" spellcheck="false" />
    <span class="col-op">
      <span class="idx"></span>
      <button type="button" class="del" title="删除该分片">✕</button>
    </span>`;
  row.querySelector(".frag-offset").value = offset;
  row.querySelector(".frag-data").value = data;
  row.querySelector(".frag-priority").value = priority;
  row.querySelector(".del").addEventListener("click", () => {
    row.remove();
    refreshIndexes();
  });
  els.fragments.appendChild(row);
  refreshIndexes();
  return row;
}

function refreshIndexes() {
  els.fragments.querySelectorAll(".frag-row").forEach((row, i) => {
    row.querySelector(".idx").textContent = `#${i + 1}`;
  });
}

function loadDemo(expected, frags) {
  els.expectedLength.value = String(expected);
  els.fragments.innerHTML = "";
  frags.forEach(([off, data, priority]) => addFragment(off, data, priority));
  els.resultCard.hidden = true;
  document.getElementById("prioResultCard").hidden = true;
  els.error.hidden = true;
  document.getElementById("traceResultCard").hidden = true;
}

els.addFrag.addEventListener("click", () => addFragment());
els.loadDemoGap.addEventListener("click", () => {
  // 乱序到达：中部重叠异值（冲突）、尾部有缺口
  loadDemo(16, [
    ["10", "313020746f"],          // "10 to" @ [10,15)
    ["0", "48656c6c6f20576f"],     // "Hello Wo" @ [0,8)
    ["6", "5858313020746f21"],     // "XX10 to!" @ [6,14)，与上一分片在 [6,8) 异值
  ]);
});
els.loadDemoOk.addEventListener("click", () => {
  loadDemo(16, [
    // "Hello World" @ [0,11)
    ["0", "48656c6c6f20576f726c64"],
    // "d0 to!" @ [10,16)，与前一片在偏移 10 处同为 'd'，去重；乱序到达
    ["10", "643020746f21"],
  ]);
});
els.loadDemoPrio.addEventListener("click", () => {
  // 优先级恢复：优先级 0 的两片在 [6,8) 异值冲突；优先级 2 的片恢复 [0,14)，
  // 低级噪声片给出的错误值全部被抑制；最终仅剩偏移 15 同级异值冲突。
  loadDemo(16, [
    ["0",  "5858585858585858", "-1"], // 8 个 'X' @ [0,8)，低级噪声
    ["0",  "48656c6c6f20576f", "0"],  // "Hello Wo" @ [0,8)
    ["6",  "5858313020746f21", "0"],  // "XX10 to!" @ [6,14)，[6,8) 与上片异值
    ["0",  "48656c6c6f20576f726c643020746f", "2"], // "Hello World0 to" @ [0,14)，高级恢复
    ["10", "643020746f", "0"],        // "d0 to" @ [10,15)，低级异值被高级片抑制
    ["14", "21", "0"],                // '!' @ [14,15)，唯一覆盖 -> 裁决
    ["15", "3f", "0"],                // '?' @ 偏移 15，与下片同级异值 -> 未决冲突
    ["15", "21", "0"],                // '!' @ 偏移 15
  ]);
});

function showError(msg) {
  els.error.textContent = msg;
  els.error.hidden = false;
}

// 收集单次重组表单中的分片（到达过程诊断复用同一表单与录入顺序）
// withPriority=true 时附带整数优先级，供 /api/reassemble-priority 使用
function collectSingleFragments(expected, withPriority = false) {
  const rows = [...els.fragments.querySelectorAll(".frag-row")];
  const fragments = [];
  rows.forEach((row, i) => {
    const offText = row.querySelector(".frag-offset").value;
    const dataText = row.querySelector(".frag-data").value;
    const prioEl = row.querySelector(".frag-priority");
    const prioText = prioEl ? prioEl.value : "";
    if (offText.trim() === "" && dataText.trim() === "" && prioText.trim() === "") return; // 跳过完全空行
    const off = parseOffset(offText, `分片 #${i + 1} 的起始偏移`);
    const stripped = dataText.replace(/[\s:_-]/g, "");
    if (stripped === "") throw new Error(`分片 #${i + 1} 的十六进制内容为空`);
    if (stripped.length % 2 !== 0) {
      throw new Error(`分片 #${i + 1} 的十六进制长度为奇数（${stripped.length}）`);
    }
    if (!/^[0-9a-fA-F]+$/.test(stripped)) {
      throw new Error(`分片 #${i + 1} 含非法十六进制字符`);
    }
    if (off + stripped.length / 2 > expected) {
      throw new Error(
        `分片 #${i + 1}（偏移 ${off}，长度 ${stripped.length / 2}）超出预期长度 ${expected}`
      );
    }
    const frag = { offset: off, data: stripped };
    if (withPriority) {
      frag.priority = parsePriority(prioText, `分片 #${i + 1} 的优先级`);
    }
    fragments.push(frag);
  });
  if (fragments.length === 0) {
    throw new Error("请至少填写一个分片（起始偏移 + 十六进制内容）");
  }
  return fragments;
}

els.submit.addEventListener("click", () => {
  els.error.hidden = true;
  let expected, fragments;
  try {
    expected = parseOffset(els.expectedLength.value, "预期字节数");
    fragments = collectSingleFragments(expected);
  } catch (e) {
    showError(e.message);
    return;
  }

  els.submit.disabled = true;
  els.submit.textContent = "重组中…";
  fetch("/api/reassemble", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expected_length: expected, fragments }),
  })
    .then(async (resp) => {
      const body = await resp.json();
      if (!resp.ok) throw new Error(body.detail || `HTTP ${resp.status}`);
      render(expected, body, fragments);
    })
    .catch((e) => showError(e.message))
    .finally(() => {
      els.submit.disabled = false;
      els.submit.textContent = "重组";
    });
});

els.prioSubmit.addEventListener("click", () => {
  els.error.hidden = true;
  let expected, fragments;
  try {
    expected = parseOffset(els.expectedLength.value, "预期字节数");
    fragments = collectSingleFragments(expected, true);
  } catch (e) {
    showError(e.message);
    return;
  }

  els.prioSubmit.disabled = true;
  els.prioSubmit.textContent = "裁决中…";
  fetch("/api/reassemble-priority", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expected_length: expected, fragments }),
  })
    .then(async (resp) => {
      const body = await resp.json();
      if (!resp.ok) throw new Error(body.detail || `HTTP ${resp.status}`);
      renderPriority(expected, body, fragments);
    })
    .catch((e) => showError(e.message))
    .finally(() => {
      els.prioSubmit.disabled = false;
      els.prioSubmit.textContent = "优先级恢复";
    });
});

// ------------------------------ 渲染 -------------------------------------

function hexOff(n) {
  return "0x" + n.toString(16);
}

function fmtRange([s, e]) {
  const len = e - s;
  return `[${s}, ${e})  ≡  [${hexOff(s)}, ${hexOff(e)})  长度 ${len}`;
}

function fillRangeList(ul, runs, emptyText, limit) {
  ul.innerHTML = "";
  if (runs.length === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = emptyText;
    ul.appendChild(li);
    return;
  }
  const shown = runs.slice(0, limit);
  shown.forEach((r) => {
    const li = document.createElement("li");
    li.textContent = fmtRange(r);
    li.title = `十进制 [${r[0]}, ${r[1]})`;
    ul.appendChild(li);
  });
  if (runs.length > shown.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = `… 其余 ${runs.length - shown.length} 个区间已省略`;
    ul.appendChild(li);
  }
}

function addStat(k, v, cls) {
  const d = document.createElement("div");
  d.className = "stat";
  d.innerHTML = `<div class="k"></div><div class="v ${cls || ""}"></div>`;
  d.querySelector(".k").textContent = k;
  d.querySelector(".v").textContent = v;
  return d;
}

function renderBar(total, coverage, conflicts, barId = "coverageBar", hintId = "barHint") {
  const bar = document.getElementById(barId);
  bar.innerHTML = "";
  const hint = document.getElementById(hintId);
  if (total === 0) {
    const seg = document.createElement("div");
    seg.className = "seg gap";
    seg.style.flex = "1";
    seg.title = "预期长度为 0";
    bar.appendChild(seg);
    hint.textContent = "预期长度为 0";
    return;
  }

  const BUCKETS = 1200;
  // state: 0 缺口 1 覆盖 2 冲突（逐桶由冲突区间提升）
  const state = new Uint8Array(Math.min(total, BUCKETS));
  const buckets = state.length;
  const scale = total / buckets;

  coverage.forEach(([s, e]) => {
    const b0 = Math.floor((s * buckets) / total);
    const b1 = Math.max(b0 + 1, Math.ceil((e * buckets) / total));
    for (let b = b0; b < Math.min(b1, buckets); b++) if (state[b] < 1) state[b] = 1;
  });
  conflicts.forEach(([s, e]) => {
    const b0 = Math.floor((s * buckets) / total);
    const b1 = Math.max(b0 + 1, Math.ceil((e * buckets) / total));
    for (let b = b0; b < Math.min(b1, buckets); b++) state[b] = 2;
  });

  const names = ["缺口", "覆盖", "冲突"];
  const cls = ["gap", "covered", "conflict"];
  let i = 0;
  while (i < buckets) {
    const st = state[i];
    let j = i + 1;
    while (j < buckets && state[j] === st) j++;
    const seg = document.createElement("div");
    seg.className = `seg ${cls[st]}`;
    seg.style.flex = String(j - i);
    const offS = Math.floor(i * scale);
    const offE = Math.floor(j * scale);
    seg.title = `${names[st]}：[${offS}, ${offE})  (${hexOff(offS)} - ${hexOff(offE)})`;
    bar.appendChild(seg);
    i = j;
  }
  hint.textContent =
    buckets < total ? `共 ${buckets} 个示意桶（每桶 ≈ ${scale.toFixed(2)} 字节，悬停看范围）` : "每格 1 字节，悬停看范围";
}

function renderPreview(expected, previewHex, truncated, conflictRuns, preId = "preview") {
  const pre = document.getElementById(preId);
  pre.innerHTML = "";
  if (expected === 0) {
    pre.textContent = "（预期长度为 0，无字节可预览）";
    return;
  }
  const bytes = new Uint8Array(previewHex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(previewHex.substr(i * 2, 2), 16);
  }
  // 冲突字节集合（仅预览范围内）
  const conflictSet = new Set();
  for (const [s, e] of conflictRuns) {
    for (let p = s; p < Math.min(e, bytes.length); p++) conflictSet.add(p);
  }

  const lines = Math.ceil(bytes.length / 16);
  for (let row = 0; row < lines; row++) {
    const base = row * 16;
    const line = document.createElement("div");

    const addr = document.createElement("span");
    addr.className = "addr";
    addr.textContent = hexOff(base).padStart(8, "0");
    line.appendChild(addr);

    const hexPart = document.createElement("span");
    let ascii = "";
    for (let k = 0; k < 16; k++) {
      const pos = base + k;
      if (k === 8) hexPart.appendChild(document.createTextNode(" "));
      if (pos < bytes.length) {
        const span = document.createElement("span");
        span.textContent = bytes[pos].toString(16).padStart(2, "0");
        if (conflictSet.has(pos)) span.className = "conflict-byte";
        hexPart.appendChild(span);
        const c = bytes[pos];
        ascii += c >= 0x20 && c <= 0x7e ? String.fromCharCode(c) : ".";
      } else {
        const span = document.createElement("span");
        span.className = "gap-byte";
        span.textContent = "··";
        hexPart.appendChild(span);
        ascii += " ";
      }
      hexPart.appendChild(document.createTextNode(" "));
    }
    line.appendChild(hexPart);

    const asc = document.createElement("span");
    asc.className = "ascii";
    asc.textContent = ascii;
    line.appendChild(asc);
    pre.appendChild(line);
  }
  if (truncated) {
    const note = document.createElement("div");
    note.className = "addr";
    note.textContent = `… 仅预览前 ${bytes.length} 字节，完整内容需在可下载时获取。`;
    pre.appendChild(note);
  }
}

function render(expected, r, submitted) {
  els.resultCard.hidden = false;
  els.resultCard.scrollIntoView({ behavior: "smooth", block: "start" });

  const banner = document.getElementById("banner");
  const note = document.getElementById("downloadNote");
  const dlBtn = document.getElementById("downloadBtn");
  dlBtn.hidden = true;

  if (r.downloadable) {
    banner.className = "banner ok";
    banner.textContent = `✓ 范围完整且无冲突：${expected} 字节全部覆盖，可以下载还原的二进制。`;
  } else {
    const problems = [];
    if (!r.complete) problems.push(`存在 ${r.gaps.length} 段缺口（共 ${r.stats.gap_length} 字节）`);
    if (r.has_conflict) problems.push(`存在 ${r.conflicts.length} 段冲突（共 ${r.stats.conflict_length} 字节）`);
    banner.className = "banner bad";
    banner.textContent = "✗ 不可下载：" + problems.join("；") + "。";
  }

  // 统计
  const stats = document.getElementById("stats");
  stats.innerHTML = "";
  const s = r.stats;
  [
    ["分片数", s.fragment_count],
    ["输入字节总量", s.total_input_bytes],
    ["已覆盖字节", `${s.covered_length} / ${expected}`, r.complete ? "ok" : "warn"],
    ["缺口字节", s.gap_length, s.gap_length ? "bad" : "ok"],
    ["冲突字节", s.conflict_length, s.conflict_length ? "bad" : "ok"],
    ["同值去重字节", s.duplicate_bytes],
    ["分片是否按序到达", r.in_order ? "是" : "否（乱序）", r.in_order ? "ok" : "warn"],
  ].forEach(([k, v, cls]) => stats.appendChild(addStat(k, v, cls)));

  renderBar(expected, r.coverage, r.conflicts);

  document.getElementById("coveredCount").textContent = `（${r.coverage.length} 段）`;
  document.getElementById("conflictCount").textContent = `（${r.conflicts.length} 段）`;
  document.getElementById("gapCount").textContent = `（${r.gaps.length} 段）`;
  fillRangeList(document.getElementById("coveredList"), r.coverage, "无覆盖", LIST_LIMIT);
  fillRangeList(document.getElementById("conflictList"), r.conflicts, "无冲突", LIST_LIMIT);
  fillRangeList(document.getElementById("gapList"), r.gaps, "无缺口，[0, 预期长度) 全覆盖", LIST_LIMIT);

  // 冲突取值抽样
  const samples = document.getElementById("conflictSamples");
  samples.innerHTML = "";
  r.conflict_samples.forEach((sm) => {
    const line = document.createElement("div");
    line.className = "sample-line";
    const vals = sm.values.map((v) => v.toString(16).padStart(2, "0")).join(" ≠ ");
    line.textContent = `偏移 ${sm.offset} (${hexOff(sm.offset)})：收到过 ${vals}`;
    samples.appendChild(line);
  });
  if (r.conflict_samples_truncated) {
    const more = document.createElement("div");
    more.className = "hint";
    more.textContent = "冲突位置过多，仅展示前若干个位置的取值。";
    samples.appendChild(more);
  }

  // 分片表
  const tbody = document.querySelector("#fragTable tbody");
  tbody.innerHTML = "";
  r.fragments.forEach((f, i) => {
    const tr = document.createElement("tr");
    const clientLen = hexByteLen(submitted[i].data);
    tr.innerHTML = `<td>${f.index}</td><td><code>${f.offset} (${hexOff(f.offset)})</code></td>
      <td>${f.length}${clientLen !== f.length ? " (输入解析异常!)" : ""}</td>
      <td><code>[${f.offset}, ${f.end})</code></td>`;
    tbody.appendChild(tr);
  });

  renderPreview(expected, r.preview_hex || "", r.preview_truncated, r.conflicts);

  if (r.downloadable) {
    dlBtn.hidden = false;
    note.textContent = `下载内容为重组后的 ${expected} 字节原始二进制。`;
    dlBtn.onclick = () => {
      window.location.href = r.download_url;
    };
  } else {
    note.textContent = "仅当范围完整且无冲突时才提供下载。";
  }
}

// ------------------------------ 优先级恢复渲染 ------------------------------

function renderPriority(expected, r, submitted) {
  const card = document.getElementById("prioResultCard");
  card.hidden = false;
  card.scrollIntoView({ behavior: "smooth", block: "start" });

  const banner = document.getElementById("prioBanner");
  const note = document.getElementById("prioDownloadNote");
  const dlBtn = document.getElementById("prioDownloadBtn");
  dlBtn.hidden = true;

  if (r.downloadable) {
    banner.className = "banner ok";
    banner.textContent =
      `✓ ${expected} 字节全部有唯一裁决（无缺口、无未决冲突），可以下载裁决后的二进制。`;
  } else {
    const problems = [];
    if (!r.complete) problems.push(`存在 ${r.gaps.length} 段缺口（共 ${r.stats.gap_length} 字节）`);
    if (r.has_conflict) problems.push(`存在 ${r.conflicts.length} 段未决冲突（共 ${r.stats.conflict_length} 字节）`);
    banner.className = "banner bad";
    banner.textContent = "✗ 无法形成唯一裁决：" + problems.join("；") + "。";
  }

  const stats = document.getElementById("prioStats");
  stats.innerHTML = "";
  const s = r.stats;
  [
    ["分片数", s.fragment_count],
    ["输入字节总量", s.total_input_bytes],
    ["已覆盖字节", `${s.covered_length} / ${expected}`, r.complete ? "ok" : "warn"],
    ["已裁决字节（唯一取值）", s.decided_length, s.decided_length === expected ? "ok" : "warn"],
    ["缺口字节", s.gap_length, s.gap_length ? "bad" : "ok"],
    ["未决冲突字节", s.conflict_length, s.conflict_length ? "bad" : "ok"],
    ["被高级片恢复的冲突字节", s.recovered_conflict_bytes, s.recovered_conflict_bytes ? "ok" : ""],
    ["低级片被抑制写入次数", s.suppressed_write_count, s.suppressed_write_count ? "warn" : "ok"],
    ["同级同值去重字节", s.duplicate_bytes],
  ].forEach(([k, v, cls]) => stats.appendChild(addStat(k, v, cls)));

  renderBar(expected, r.coverage, r.conflicts, "prioBar", "prioBarHint");

  // 获胜来源区间：展示裁决依据（来源片 # + 优先级）
  document.getElementById("prioSourceCount").textContent = `（${r.source_runs.length} 段）`;
  const sourceUl = document.getElementById("prioSourceList");
  sourceUl.innerHTML = "";
  if (r.source_runs.length === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "无已裁决字节";
    sourceUl.appendChild(li);
  }
  r.source_runs.slice(0, LIST_LIMIT).forEach((run) => {
    const li = document.createElement("li");
    li.textContent =
      `${fmtRange([run.start, run.end])} ｜ 来源片 #${run.fragment}（优先级 ${run.priority}）`;
    li.title = `十进制 [${run.start}, ${run.end})，由第 ${run.fragment} 个分片（优先级 ${run.priority}）裁决`;
    sourceUl.appendChild(li);
  });
  if (r.source_runs.length > LIST_LIMIT) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = `… 其余 ${r.source_runs.length - LIST_LIMIT} 个区间已省略`;
    sourceUl.appendChild(li);
  }

  document.getElementById("prioConflictCount").textContent = `（${r.conflicts.length} 段）`;
  document.getElementById("prioGapCount").textContent = `（${r.gaps.length} 段）`;
  fillRangeList(document.getElementById("prioConflictList"), r.conflicts, "无未决冲突", LIST_LIMIT);
  fillRangeList(document.getElementById("prioGapList"), r.gaps, "无缺口，[0, 预期长度) 全覆盖", LIST_LIMIT);

  // 未决冲突样本：列出最高优先级层的候选值与各自最早来源片，作为裁决依据
  const samplesBox = document.getElementById("prioConflictSamples");
  samplesBox.innerHTML = "";
  r.conflict_samples.forEach((sm) => {
    const cands = sm.candidates
      .map((c) => `#${c.fragment} 给出 ${hexByte(c.value)}`)
      .join(" ≠ ");
    const line = document.createElement("div");
    line.className = "sample-line";
    line.textContent =
      `偏移 ${sm.offset} (${hexOff(sm.offset)})：优先级 ${sm.priority} 层 ${cands}` +
      (sm.candidates_truncated ? "（候选值过多，仅列前若干个）" : "");
    samplesBox.appendChild(line);
  });
  if (r.conflict_samples_truncated) {
    const more = document.createElement("div");
    more.className = "hint";
    more.textContent = "冲突位置过多，仅展示前若干个位置的候选值。";
    samplesBox.appendChild(more);
  }

  // 分片表（含优先级）
  const tbody = document.querySelector("#prioFragTable tbody");
  tbody.innerHTML = "";
  r.fragments.forEach((f) => {
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td>${f.index}</td>` +
      `<td class="prio-cell">${f.priority}</td>` +
      `<td><code>${f.offset} (${hexOff(f.offset)})</code></td>` +
      `<td>${f.length}</td>` +
      `<td><code>[${f.offset}, ${f.end})</code></td>`;
    tbody.appendChild(tr);
  });

  renderPreview(expected, r.preview_hex || "", r.preview_truncated, r.conflicts, "prioPreview");

  if (r.downloadable) {
    dlBtn.hidden = false;
    note.textContent = `下载内容为优先级裁决后的 ${expected} 字节原始二进制。`;
    dlBtn.onclick = () => {
      window.location.href = r.download_url;
    };
  } else {
    note.textContent = "仅当全部字节都有唯一裁决（无缺口、无未决冲突）时才提供下载。";
  }
}

// 初始放一个空分片，方便直接输入
addFragment();

// 输入发生变化后，旧的重组结果不再可信，隐藏结果区
function invalidateResult() {
  els.resultCard.hidden = true;
  document.getElementById("prioResultCard").hidden = true;
  els.error.hidden = true;
}
els.expectedLength.addEventListener("input", invalidateResult);
els.fragments.addEventListener("input", invalidateResult);

// ------------------------------ 分片到达过程诊断 ------------------------------
// 复用上方单次重组表单（预期长度 + 分片录入顺序），调用 /api/arrival-trace，
// 逐片展示新增覆盖 / 首次冲突与累计值；诊断结果不进入下载缓存。

const traceEls = {
  submit: document.getElementById("traceSubmit"),
  resultCard: document.getElementById("traceResultCard"),
  banner: document.getElementById("traceBanner"),
  stats: document.getElementById("traceStats"),
  tableBody: document.querySelector("#traceTable tbody"),
  sampleCount: document.getElementById("traceSampleCount"),
  sampleBody: document.querySelector("#traceSampleTable tbody"),
  sampleNote: document.getElementById("traceSampleNote"),
};

function hexByte(v) {
  return "0x" + v.toString(16).padStart(2, "0");
}

traceEls.submit.addEventListener("click", () => {
  els.error.hidden = true;
  let expected, fragments;
  try {
    expected = parseOffset(els.expectedLength.value, "预期字节数");
    fragments = collectSingleFragments(expected);
  } catch (e) {
    showError(e.message);
    return;
  }

  traceEls.submit.disabled = true;
  traceEls.submit.textContent = "诊断中…";
  fetch("/api/arrival-trace", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expected_length: expected, fragments }),
  })
    .then(async (resp) => {
      const body = await resp.json();
      if (!resp.ok) throw new Error(body.detail || `HTTP ${resp.status}`);
      renderTrace(expected, body);
    })
    .catch((e) => showError(e.message))
    .finally(() => {
      traceEls.submit.disabled = false;
      traceEls.submit.textContent = "诊断到达过程";
    });
});

function renderTrace(expected, r) {
  traceEls.resultCard.hidden = false;
  traceEls.resultCard.scrollIntoView({ behavior: "smooth", block: "start" });

  const firstConflictStep = r.steps.find((s) => s.new_conflicts > 0) || null;
  const f = r.final;

  if (f.conflict_length > 0) {
    traceEls.banner.className = "banner bad";
    traceEls.banner.textContent =
      `✗ 到达过程中共 ${f.conflict_length} 字节首次变为冲突，` +
      `最早由分片 #${firstConflictStep.index} 引入（该步新增冲突 ${firstConflictStep.new_conflicts} 字节）。`;
  } else if (f.gap_length > 0) {
    traceEls.banner.className = "banner warn";
    traceEls.banner.textContent =
      `到达过程无冲突；最终仍缺 ${f.gap_length} 字节未覆盖（已覆盖 ${f.covered_length} / ${expected}）。`;
  } else {
    traceEls.banner.className = "banner ok";
    traceEls.banner.textContent =
      `✓ ${r.fragment_count} 个分片依次到达后完整覆盖 ${expected} 字节，无任何冲突。`;
  }

  traceEls.stats.innerHTML = "";
  [
    ["分片数", r.fragment_count],
    ["输入字节总量", r.total_input_bytes],
    ["最终覆盖", `${f.covered_length} / ${expected}`, f.gap_length ? "warn" : "ok"],
    ["最终缺口", f.gap_length, f.gap_length ? "bad" : "ok"],
    ["最终冲突", f.conflict_length, f.conflict_length ? "bad" : "ok"],
    ["首次引入冲突的分片", firstConflictStep ? `#${firstConflictStep.index}` : "无", firstConflictStep ? "bad" : "ok"],
    ["分片是否按序到达", r.in_order ? "是" : "否（乱序）", r.in_order ? "ok" : "warn"],
  ].forEach(([k, v, cls]) => traceEls.stats.appendChild(addStat(k, v, cls)));

  // 到达步骤表：引入新冲突的分片整行标红，最早的一行加「首次引入冲突」标记
  traceEls.tableBody.innerHTML = "";
  r.steps.forEach((s) => {
    const tr = document.createElement("tr");
    if (s.new_conflicts > 0) tr.className = "trace-conflict";
    const mark =
      firstConflictStep && s.index === firstConflictStep.index
        ? '<span class="first-mark">◀ 首次引入冲突</span>'
        : "";
    tr.innerHTML =
      `<td>${s.index}${mark}</td>` +
      `<td><code>${s.offset} (${hexOff(s.offset)})</code></td>` +
      `<td>${s.length}</td>` +
      `<td><code>[${s.offset}, ${s.end})</code></td>` +
      `<td>${s.new_covered}</td>` +
      `<td class="${s.new_conflicts ? "cell-bad" : ""}">${s.new_conflicts}</td>` +
      `<td>${s.cumulative_covered}</td>` +
      `<td class="${s.cumulative_conflicts ? "cell-bad" : ""}">${s.cumulative_conflicts}</td>`;
    traceEls.tableBody.appendChild(tr);
  });

  // 首次冲突样本：偏移 + 最先写入的分片 + 触发冲突的分片
  traceEls.sampleCount.textContent = `（${r.first_conflict_samples.length} 条）`;
  traceEls.sampleBody.innerHTML = "";
  if (r.first_conflict_samples.length === 0) {
    const tr = document.createElement("tr");
    tr.innerHTML = '<td colspan="5" class="empty">无首次冲突：所有到达均为首次覆盖或同值重发。</td>';
    traceEls.sampleBody.appendChild(tr);
  } else {
    r.first_conflict_samples.forEach((sm) => {
      const tr = document.createElement("tr");
      tr.innerHTML =
        `<td><code>${sm.offset} (${hexOff(sm.offset)})</code></td>` +
        `<td>分片 #${sm.first_fragment}</td>` +
        `<td><code>${hexByte(sm.first_value)}</code></td>` +
        `<td>分片 #${sm.conflict_fragment}</td>` +
        `<td><code>${hexByte(sm.conflict_value)}</code></td>`;
      traceEls.sampleBody.appendChild(tr);
    });
  }
  traceEls.sampleNote.textContent = r.first_conflict_samples_truncated
    ? `首次冲突位置共 ${f.conflict_length} 处，仅列出前 ${r.first_conflict_samples.length} 处（上限 ${r.sample_limit} 条）。`
    : "";
}

// 输入变化后旧的诊断结果不再可信，隐藏诊断结果区
function invalidateTrace() {
  traceEls.resultCard.hidden = true;
}
els.expectedLength.addEventListener("input", invalidateTrace);
els.fragments.addEventListener("input", invalidateTrace);
