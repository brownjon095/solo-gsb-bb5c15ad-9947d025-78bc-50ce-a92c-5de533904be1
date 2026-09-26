"use strict";

// 字节签名定位：在单次重组表单（预期长度 + 分片）中查找字节签名。
// 复用 app.js 中的全局函数与对象：els / parseOffset / collectSingleFragments /
// showError / hexOff / addStat（app.js 先于本文件加载）。

const SIG_MAX_LENGTH = 64; // 签名最大字节数（含 ?? 通配符）
const SIG_MAX_WINDOW = 65536; // 候选起点窗口最多检查的起点数

const sigEls = {
  pattern: document.getElementById("sigPattern"),
  winStart: document.getElementById("sigWinStart"),
  winLen: document.getElementById("sigWinLen"),
  submit: document.getElementById("sigSubmit"),
  demo: document.getElementById("sigDemo"),
  prev: document.getElementById("sigPrev"),
  next: document.getElementById("sigNext"),
  resultCard: document.getElementById("sigResultCard"),
  banner: document.getElementById("sigBanner"),
  stats: document.getElementById("sigStats"),
  defCount: document.getElementById("sigDefCount"),
  defList: document.getElementById("sigDefList"),
  posCount: document.getElementById("sigPosCount"),
  posList: document.getElementById("sigPosList"),
};

const SIG_REASON_LABEL = { gap: "缺口", conflict: "冲突含目标值" };

// 校验并规范化签名输入：两位十六进制为确定字节，?? 为通配符；
// 返回去掉分隔符后的签名文本（服务端会再次完整校验）。
function parseSignatureInput(text) {
  const stripped = text.replace(/[\s:_-]/g, "");
  if (stripped === "") throw new Error("请填写字节签名");
  if (stripped.length % 2 !== 0) {
    throw new Error(`签名长度为奇数（${stripped.length}），无法按字节解析（通配符请用成对的 ??）`);
  }
  let determinate = 0;
  const byteCount = stripped.length / 2;
  for (let k = 0; k < stripped.length; k += 2) {
    const token = stripped.substr(k, 2);
    if (token === "??") continue;
    if (/^[0-9a-fA-F]{2}$/.test(token)) {
      determinate += 1;
      continue;
    }
    throw new Error(`签名第 ${k / 2 + 1} 个字节「${token}」非法：应为两位十六进制或 ??`);
  }
  if (byteCount > SIG_MAX_LENGTH) {
    throw new Error(`签名长度 ${byteCount} 字节超过上限 ${SIG_MAX_LENGTH}`);
  }
  if (determinate === 0) {
    throw new Error("签名至少包含一个确定字节（不能全是 ?? 通配符）");
  }
  return stripped;
}

function readSignatureInputs() {
  const expected = parseOffset(els.expectedLength.value, "预期字节数");
  const fragments = collectSingleFragments(expected);
  const signature = parseSignatureInput(sigEls.pattern.value);
  const winStart = parseOffset(sigEls.winStart.value, "起点窗口");
  const winLen = parseOffset(sigEls.winLen.value, "窗口长度");
  if (winLen < 1) throw new Error("窗口长度至少为 1");
  if (winLen > SIG_MAX_WINDOW) {
    throw new Error(`窗口长度 ${winLen} 超过上限 ${SIG_MAX_WINDOW}`);
  }
  return { expected, fragments, signature, winStart, winLen };
}

function submitSignature() {
  els.error.hidden = true;
  let inputs;
  try {
    inputs = readSignatureInputs();
  } catch (e) {
    showError(e.message);
    return;
  }

  sigEls.submit.disabled = true;
  sigEls.submit.textContent = "定位中…";
  fetch("/api/signature-locate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      expected_length: inputs.expected,
      signature: inputs.signature,
      window_start: inputs.winStart,
      window_length: inputs.winLen,
      fragments: inputs.fragments,
    }),
  })
    .then(async (resp) => {
      const body = await resp.json();
      if (!resp.ok) throw new Error(body.detail || `HTTP ${resp.status}`);
      renderSignature(body);
    })
    .catch((e) => showError(e.message))
    .finally(() => {
      sigEls.submit.disabled = false;
      sigEls.submit.textContent = "定位签名";
    });
}

// 按当前窗口长度平移候选起点窗口（窗口允许超出预期长度，越界起点由服务端跳过）
function shiftSigWindow(dir) {
  els.error.hidden = true;
  let winStart, winLen;
  try {
    winStart = parseOffset(sigEls.winStart.value, "起点窗口");
    winLen = parseOffset(sigEls.winLen.value, "窗口长度");
    if (winLen < 1) throw new Error("窗口长度至少为 1");
  } catch (e) {
    showError(e.message);
    return;
  }
  sigEls.winStart.value = String(Math.max(0, winStart + dir * winLen));
  submitSignature();
}

// ------------------------------ 渲染 ---------------------------------------

function renderSignature(r) {
  sigEls.resultCard.hidden = false;
  sigEls.resultCard.scrollIntoView({ behavior: "smooth", block: "start" });

  const w = r.window;
  if (r.definite_total === 0 && r.possible_total === 0) {
    sigEls.banner.className = "banner bad";
    sigEls.banner.textContent =
      `✗ 窗口 [${w.start}, ${w.end}) 内无任何命中：` +
      `检查 ${r.checked} 个起点，全部被唯一异值或不含目标值的冲突排除。`;
  } else if (r.definite_total > 0) {
    sigEls.banner.className = "banner ok";
    sigEls.banner.textContent =
      `✓ 确定命中 ${r.definite_total} 处、可能命中 ${r.possible_total} 处` +
      `（窗口 [${w.start}, ${w.end})，检查 ${r.checked} 个起点）。`;
  } else {
    sigEls.banner.className = "banner warn";
    sigEls.banner.textContent =
      `无确定命中；可能命中 ${r.possible_total} 处（确定字节落在缺口或含目标值的冲突上，` +
      `窗口 [${w.start}, ${w.end})，检查 ${r.checked} 个起点）。`;
  }

  const s = r.stats;
  sigEls.stats.innerHTML = "";
  [
    ["窗口范围", `[${w.start}, ${w.end}) 长度 ${w.length}`],
    ["签名长度 / 确定字节", `${r.signature.length} / ${r.signature.determinate_bytes}`],
    ["参与检查起点", r.checked],
    ["越界跳过起点", r.skipped_out_of_range, r.skipped_out_of_range ? "warn" : "ok"],
    ["确定命中", r.definite_total, r.definite_total ? "ok" : ""],
    ["可能命中", r.possible_total, r.possible_total ? "warn" : "ok"],
    ["分片数 / 冲突字节", `${s.fragment_count} / ${s.conflict_length}`, s.conflict_length ? "warn" : ""],
    ["缺口字节", s.gap_length, s.gap_length ? "warn" : "ok"],
  ].forEach(([k, v, cls]) => sigEls.stats.appendChild(addStat(k, v, cls)));

  // 确定命中起点列表
  sigEls.defCount.textContent = `（共 ${r.definite_total} 处）`;
  sigEls.defList.innerHTML = "";
  if (r.definite_total === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "无确定命中";
    sigEls.defList.appendChild(li);
  } else {
    r.definite_starts.forEach((start) => {
      const li = document.createElement("li");
      li.textContent = `起点 ${start} (${hexOff(start)}) ｜ 覆盖 [${start}, ${start + r.signature.length})`;
      sigEls.defList.appendChild(li);
    });
    if (r.definite_truncated) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent = `… 其余 ${r.definite_total - r.definite_starts.length} 个起点已省略（最多列出 ${r.hit_sample_limit} 个）`;
      sigEls.defList.appendChild(li);
    }
  }

  // 可能命中起点列表：附每个不确定位的签名下标、负载偏移与原因
  sigEls.posCount.textContent = `（共 ${r.possible_total} 处）`;
  sigEls.posList.innerHTML = "";
  if (r.possible_total === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "无可能命中";
    sigEls.posList.appendChild(li);
  } else {
    r.possible_hits.forEach((hit) => {
      const bits = hit.uncertain.map(
        (u) => `签名#${u.index}@偏移${u.offset} ${SIG_REASON_LABEL[u.reason] || u.reason}`
      );
      const li = document.createElement("li");
      li.textContent =
        `起点 ${hit.start} (${hexOff(hit.start)}) ｜ ${hit.uncertain.length} 位不确定：${bits.join("；")}`;
      li.title = `签名对齐到 [${hit.start}, ${hit.start + r.signature.length})，不确定位：${bits.join("；")}`;
      sigEls.posList.appendChild(li);
    });
    if (r.possible_truncated) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent = `… 其余 ${r.possible_total - r.possible_hits.length} 个起点已省略（最多列出 ${r.hit_sample_limit} 个）`;
      sigEls.posList.appendChild(li);
    }
  }
}

// ------------------------------ 事件绑定 -----------------------------------

sigEls.submit.addEventListener("click", submitSignature);
sigEls.prev.addEventListener("click", () => shiftSigWindow(-1));
sigEls.next.addEventListener("click", () => shiftSigWindow(1));

sigEls.demo.addEventListener("click", () => {
  // 预期 24 字节："Hel" 在偏移 12 处唯一出现（确定命中）；偏移 2 处为冲突位
  // 且冲突取值包含签名目标值 6c（可能命中：冲突含目标值）；[18,24) 为缺口
  // （可能命中：缺口）；窗口末尾的起点因签名越界被跳过。
  els.expectedLength.value = "24";
  els.fragments.innerHTML = "";
  [
    ["0", "48656c6c6f20576f"], // "Hello Wo" @ [0,8)
    ["8", "726c64214865"],     // "rld!He"   @ [8,14)
    ["14", "6c414243"],        // "lABC"     @ [14,18)，[18,24) 留缺口
    ["2", "58"],               // 'X' @ 偏移 2，与片 1 的 6c 异值 -> 冲突 {6c, 58}
  ].forEach(([off, data]) => addFragment(off, data));
  sigEls.pattern.value = "48 65 6c";
  sigEls.winStart.value = "0";
  sigEls.winLen.value = "24";
  sigEls.resultCard.hidden = true;
  els.resultCard.hidden = true;
  document.getElementById("prioResultCard").hidden = true;
  document.getElementById("traceResultCard").hidden = true;
  els.error.hidden = true;
});

// 输入发生变化后，旧的定位结果不再可信，隐藏结果区
function invalidateSignature() {
  sigEls.resultCard.hidden = true;
}
els.expectedLength.addEventListener("input", invalidateSignature);
els.fragments.addEventListener("input", invalidateSignature);
[sigEls.pattern, sigEls.winStart, sigEls.winLen].forEach((el) =>
  el.addEventListener("input", invalidateSignature)
);
