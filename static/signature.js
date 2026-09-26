"use strict";

// 字节签名定位。
// 复用 app.js 中的全局函数：parseOffset / collectSingleFragments /
// hexOff / addStat（app.js 先于本文件加载）。
// 沿用单次重组表单的预期长度与分片输入，不生成下载。

const SIG_MAX_BYTES = 64;
const SIG_MAX_WINDOW = 65536;
const SIG_HIT_LIMIT = 200;

const sigEls = {
  pattern: document.getElementById("sigPattern"),
  winStart: document.getElementById("sigWinStart"),
  winLen: document.getElementById("sigWinLen"),
  submit: document.getElementById("sigSubmit"),
  prev: document.getElementById("sigPrev"),
  next: document.getElementById("sigNext"),
  prev2: document.getElementById("sigPrev2"),
  next2: document.getElementById("sigNext2"),
  demo: document.getElementById("sigDemo"),
  error: document.getElementById("sigError"),
  resultCard: document.getElementById("sigResultCard"),
  banner: document.getElementById("sigBanner"),
  stats: document.getElementById("sigStats"),
  hitBody: document.querySelector("#sigHitTable tbody"),
  hitNote: document.getElementById("sigHitNote"),
};

// 解析并校验签名字符串，返回去掉分隔符后的规范形式（原样保留 ?? 与两位 hex）
function sigParsePattern(text) {
  const stripped = text.replace(/[\s:_-]/g, "").toLowerCase();
  if (stripped === "") throw new Error("请填写字节签名");
  if (stripped.length % 2 !== 0) {
    throw new Error(`签名长度为奇数（${stripped.length} 个字符），每个字节位需写两位 hex 或 ??`);
  }
  const tokens = [];
  for (let i = 0; i < stripped.length; i += 2) {
    const tok = stripped.slice(i, i + 2);
    if (tok === "??") {
      tokens.push("??");
    } else if (/^[0-9a-f]{2}$/.test(tok)) {
      tokens.push(tok);
    } else {
      throw new Error(`签名含非法字节位 “${tok}”：每位必须是两位十六进制或 ??`);
    }
  }
  if (tokens.length < 1 || tokens.length > SIG_MAX_BYTES) {
    throw new Error(`签名长度 ${tokens.length} 字节超出允许范围 1~${SIG_MAX_BYTES} 字节`);
  }
  if (!tokens.some((t) => t !== "??")) {
    throw new Error("签名不能全部为 ?? 通配位，至少需要一个确定字节");
  }
  return stripped;
}

function sigShowError(msg) {
  sigEls.error.textContent = msg;
  sigEls.error.hidden = false;
}

// 读取并校验窗口参数与签名、分片
function sigCollect() {
  const expected = parseOffset(
    document.getElementById("expectedLength").value,
    "预期字节数"
  );
  const signature = sigParsePattern(sigEls.pattern.value);
  const winStart = parseOffset(sigEls.winStart.value, "窗口起点");
  const winLen = parseOffset(sigEls.winLen.value, "窗口长度");
  if (winLen < 1) throw new Error("窗口长度至少为 1 字节");
  if (winLen > SIG_MAX_WINDOW) {
    throw new Error(`窗口长度 ${winLen} 超过上限 ${SIG_MAX_WINDOW}`);
  }
  if (winStart > expected) {
    throw new Error(`窗口起点 ${winStart} 超出预期长度 ${expected}`);
  }
  const fragments = collectSingleFragments(expected);
  return { expected, signature, winStart, winLen, fragments };
}

function submitSignature() {
  sigEls.error.hidden = true;
  let payload;
  try {
    payload = sigCollect();
  } catch (e) {
    sigShowError(e.message);
    return;
  }

  sigEls.submit.disabled = true;
  sigEls.submit.textContent = "定位中…";
  fetch("/api/signature-scan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      expected_length: payload.expected,
      signature: payload.signature,
      window_start: payload.winStart,
      window_length: payload.winLen,
      fragments: payload.fragments,
    }),
  })
    .then(async (resp) => {
      const body = await resp.json();
      if (!resp.ok) throw new Error(body.detail || `HTTP ${resp.status}`);
      renderSignature(body);
    })
    .catch((e) => sigShowError(e.message))
    .finally(() => {
      sigEls.submit.disabled = false;
      sigEls.submit.textContent = "签名定位";
    });
}

function shiftSignatureWindow(dir) {
  sigEls.error.hidden = true;
  let expected, winStart, winLen;
  try {
    expected = parseOffset(
      document.getElementById("expectedLength").value,
      "预期字节数"
    );
    winStart = parseOffset(sigEls.winStart.value, "窗口起点");
    winLen = parseOffset(sigEls.winLen.value, "窗口长度");
    if (winLen < 1) throw new Error("窗口长度至少为 1 字节");
  } catch (e) {
    sigShowError(e.message);
    return;
  }
  // 起点允许抵达预期长度本身（此时窗口内全部为越界起点）
  const next = Math.max(0, Math.min(winStart + dir * winLen, expected));
  sigEls.winStart.value = String(next);
  submitSignature();
}

// ------------------------------ 渲染 ---------------------------------------

function sigHexByte(v) {
  return "0x" + Number(v).toString(16).padStart(2, "0");
}

function sigUncertaintyHtml(u, sigLen) {
  const posText = `签名内第 ${u.position + 1} 字节（负载偏移 ${u.offset} / ${hexOff(u.offset)}），目标 ${sigHexByte(u.target)}`;
  if (u.reason === "gap") {
    return `缺口：${posText} 无任何分片覆盖`;
  }
  // conflict：取值中含目标值，仍可能相等
  const vals = u.conflict_values
    .map((v) => sigHexByte(v))
    .join("、");
  const more = u.conflict_values_truncated ? "（取值过多，仅列前若干个）" : "";
  return `冲突：${posText}，冲突取值 ${vals}${more} 中包含目标值`;
}

function renderSignature(r) {
  sigEls.resultCard.hidden = false;
  sigEls.resultCard.scrollIntoView({ behavior: "smooth", block: "start" });

  const c = r.counts;
  const w = r.window;
  const sigLen = r.signature.length;

  if (c.definite > 0) {
    sigEls.banner.className = "banner ok";
    sigEls.banner.textContent =
      `✓ 窗口 [${w.start}, ${w.end}) 内确定命中 ${c.definite} 个起点` +
      (c.possible ? `，另有 ${c.possible} 个起点可能命中。` : "。");
  } else if (c.possible > 0) {
    sigEls.banner.className = "banner warn";
    sigEls.banner.textContent =
      `窗口 [${w.start}, ${w.end}) 内无确定命中，${c.possible} 个起点可能命中（存在缺口或含目标值的冲突）。`;
  } else {
    sigEls.banner.className = "banner bad";
    sigEls.banner.textContent =
      `✗ 窗口 [${w.start}, ${w.end}) 内无任何命中：已检查 ${w.checked_count} 个起点，全部排除。` +
      (w.out_of_bounds_count ? `（另有 ${w.out_of_bounds_count} 个越界起点不参与判定）` : "");
  }

  sigEls.stats.innerHTML = "";
  [
    ["签名", r.signature.hex],
    [
      "签名长度",
      `${sigLen} 字节（确定 ${r.signature.fixed_byte_count} / 通配 ${r.signature.wildcard_count}）`,
    ],
    [
      "窗口",
      `[${w.start}, ${w.end})，检查 ${w.checked_count} 个起点`,
    ],
    ["确定命中", c.definite, c.definite ? "ok" : ""],
    ["可能命中", c.possible, c.possible ? "warn" : "ok"],
    ["排除起点", c.excluded, c.excluded ? "bad" : "ok"],
    ["越界起点（不参与）", c.out_of_bounds_count, w.out_of_bounds_count ? "warn" : ""],
    ["合法候选起点总数", r.total_candidate_starts],
    [
      "分片数 / 输入字节总量",
      `${r.stats.fragment_count} / ${r.stats.total_input_bytes}`,
    ],
  ].forEach(([k, v, cls]) => sigEls.stats.appendChild(addStat(k, v, cls)));

  sigEls.hitBody.innerHTML = "";
  if (r.hits.length === 0) {
    const tr = document.createElement("tr");
    tr.innerHTML = '<td colspan="4" class="empty">本窗口无确定命中或可能命中的起点。</td>';
    sigEls.hitBody.appendChild(tr);
  }
  r.hits.forEach((h) => {
    const tr = document.createElement("tr");
    const tdStart = document.createElement("td");
    tdStart.innerHTML = `<code>${h.start} (${hexOff(h.start)})</code>`;
    const tdType = document.createElement("td");
    if (h.category === "definite") {
      tdType.innerHTML = '<span class="sig-tag sig-tag-definite">确定命中</span>';
    } else {
      tdType.innerHTML = '<span class="sig-tag sig-tag-possible">可能命中</span>';
    }
    const tdRange = document.createElement("td");
    tdRange.innerHTML = `<code>[${h.start}, ${h.start + sigLen})</code>`;
    const tdWhy = document.createElement("td");
    if (h.uncertainties.length === 0) {
      tdWhy.classList.add("empty");
      tdWhy.textContent = "—";
    } else {
      const ul = document.createElement("ul");
      ul.className = "sig-why-list";
      h.uncertainties.forEach((u) => {
        const li = document.createElement("li");
        li.textContent = sigUncertaintyHtml(u, sigLen);
        ul.appendChild(li);
      });
      tdWhy.appendChild(ul);
    }
    tr.append(tdStart, tdType, tdRange, tdWhy);
    sigEls.hitBody.appendChild(tr);
  });

  const totalHits = c.definite + c.possible;
  sigEls.hitNote.textContent = r.hits_truncated
    ? `两类命中合计 ${totalHits} 个起点，仅展示前 ${r.hits.length} 个（上限 ${r.hit_sample_limit} 个）；请用「上一窗口 / 下一窗口」调整窗口继续查找。`
    : totalHits > 0
      ? `共 ${totalHits} 个命中起点。`
      : "";
}

// ------------------------------ 事件绑定 -----------------------------------

sigEls.submit.addEventListener("click", submitSignature);
sigEls.prev.addEventListener("click", () => shiftSignatureWindow(-1));
sigEls.prev2.addEventListener("click", () => shiftSignatureWindow(-1));
sigEls.next.addEventListener("click", () => shiftSignatureWindow(1));
sigEls.next2.addEventListener("click", () => shiftSignatureWindow(1));

sigEls.demo.addEventListener("click", () => {
  // 预期 16 字节：偏移 0..4 为唯一 "Hello"，偏移 5 为缺口，偏移 6 为含目标值的冲突，
  // 其余缺口。签名 "48 65 ?? ?? 6f 20 ?? 57"：起点 0 为可能命中（缺口/冲突）。
  document.getElementById("expectedLength").value = "16";
  const fragBox = document.getElementById("fragments");
  fragBox.innerHTML = "";
  // 复用 app.js 的 addFragment（offset, data, priority）
  addFragment("0", "48656c6c6f", "");      // "Hello" @ [0,5)
  addFragment("6", "5858", "");            // "XX"  @ [6,8)
  addFragment("6", "2057", "");            // " W"  @ [6,8)，偏移 6 处 0x20/0x58 冲突
  sigEls.pattern.value = "48 65 ?? ?? 6f 20 ?? 57";
  sigEls.winStart.value = "0";
  sigEls.winLen.value = "16";
  sigEls.resultCard.hidden = true;
  sigEls.error.hidden = true;
});

// 输入发生变化后，旧的定位结果不再可信
function invalidateSignature() {
  sigEls.resultCard.hidden = true;
  sigEls.error.hidden = true;
}
[sigEls.pattern, sigEls.winStart, sigEls.winLen].forEach((el) =>
  el.addEventListener("input", invalidateSignature)
);
// 单次重组表单的预期长度 / 分片变化同样使定位结果失效（app.js 已持有这些元素）
document.getElementById("expectedLength").addEventListener("input", invalidateSignature);
document.getElementById("fragments").addEventListener("input", invalidateSignature);
