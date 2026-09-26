"""单向抓包负载重组核心逻辑。

输入为若干乱序分片（起始偏移 + 原始字节），按字节位置重组：
  * 同一字节位置多次覆盖且取值相同 -> 去重；
  * 同一字节位置取值不同         -> 标记为冲突；
  * 从未被覆盖的字节             -> 计入缺口区间。

重组结果以行程（run）列表表示 [start, end, value?]，end 为开区间端点。

另提供双次抓包差异定位：对 A/B 两组分片分别重建逐字节状态
（唯一值 / 缺口 / 冲突），在指定比较窗口内逐偏移判定异同，
并把连续同类且原因相同的字节合并为半开区间。

分片到达过程诊断：按录入顺序逐片应用分片，按字节维护
未覆盖 / 唯一值 / 冲突 三态，逐片统计本次新增覆盖与
首次变为冲突的字节数及累计值，并抽样记录首次冲突位置
（偏移、最先写入的分片、触发冲突的分片）。

优先级恢复：每个分片额外带整数优先级（默认 0，越大越优先），
逐字节只在覆盖该位置的最高优先级片之间裁决：
  * 最高层取值一致 -> 唯一裁决，来源取最早录入片；
  * 最高层取值不同 -> 未决冲突；
  * 更低优先级片的异值 / 同值写入一律被抑制，不污染结果；
  * 更高优先级片到达时，旧顶层写入整体降级，旧冲突可被恢复。
返回缺口、未决冲突区间与连续相同获胜来源的半开区间；
仅全部字节有唯一裁决时产出可下载二进制。
"""

from __future__ import annotations

from array import array
from typing import Any

# 每个冲突位置最多保留几个不同取值（用于页面展示，防止异常输入撑爆内存）
SAMPLE_VALUES_PER_POSITION = 8
# 最多抽样多少个冲突位置
SAMPLE_POSITION_LIMIT = 2000
# 覆盖区预览最多返回多少字节
PREVIEW_LIMIT = 512
# 双次抓包差异定位中，比较窗口的最大字节数
MAX_DIFF_WINDOW = 65536
# 到达过程诊断中，首次冲突样本的最大条数
FIRST_CONFLICT_SAMPLE_LIMIT = 2000
# 优先级恢复中，单片优先级数值的允许范围（与 JS 安全整数对齐）
PRIORITY_VALUE_LIMIT = 2**53 - 1

# 字节签名定位中，签名长度（字节 / 通配位个数）的范围
MIN_SIGNATURE_BYTES = 1
MAX_SIGNATURE_BYTES = 64
# 字节签名定位中，单次最多检查多少个候选起点
MAX_SIGNATURE_WINDOW = 65536
# 字节签名定位中，最多返回多少个命中起点（确定命中与可能命中合计）
SIGNATURE_HIT_SAMPLE_LIMIT = 200
# 字节签名定位中，每个不确定位最多展示几个冲突取值
SIGNATURE_VALUE_SAMPLE_LIMIT = 8

# 差异定位的逐字节类别
CATEGORY_SAME = "same"  # 两侧均为唯一值且相等
CATEGORY_DIFF = "diff"  # 两侧均为唯一值但不相等
CATEGORY_UNDECIDABLE = "undecidable"  # 任一侧为缺口或冲突，无法判定

# 单侧不可判定的原因
REASON_GAP = "gap"
REASON_CONFLICT = "conflict"


class ReassemblyError(ValueError):
    """可直接作为 400 返回给前端的重组错误。"""


def parse_hex_payload(raw: str, index: int, side: str = "") -> bytes:
    """解析用户填写的十六进制内容，允许空白与冒号分隔，要求偶数个 hex 位。"""
    if not isinstance(raw, str):
        raise ReassemblyError(f"{side}分片 {index + 1} 的内容必须是十六进制字符串")
    text = raw.replace(":", "").replace("-", "").replace("\n", "").replace("\r", "")
    text = "".join(text.split())
    if text == "":
        raise ReassemblyError(f"{side}分片 {index + 1} 的内容为空")
    if len(text) % 2 != 0:
        raise ReassemblyError(
            f"{side}分片 {index + 1} 的十六进制长度为奇数（{len(text)}），无法按字节解析"
        )
    try:
        return bytes.fromhex(text)
    except ValueError as exc:
        raise ReassemblyError(f"{side}分片 {index + 1} 含非法十六进制字符：{exc}") from None


def invert_runs(runs: list[list[int]], total: int) -> list[list[int]]:
    """求区间列表在 [0, total) 内的补集（即全部缺口区间）。"""
    gaps: list[list[int]] = []
    cursor = 0
    for start, end in runs:
        if start > cursor:
            gaps.append([cursor, start])
        cursor = max(cursor, end)
    if cursor < total:
        gaps.append([cursor, total])
    return gaps


def _check_expected_length(expected_length: int) -> None:
    if isinstance(expected_length, bool) or not isinstance(expected_length, int):
        raise ReassemblyError("预期字节数必须是非负整数")
    if expected_length < 0:
        raise ReassemblyError("预期字节数不能为负数")


def _parse_fragments(
    expected_length: int,
    fragments: list[dict[str, Any]],
    *,
    max_fragments: int,
    max_total_input: int,
    side: str = "",
    with_priority: bool = False,
) -> tuple[list[tuple[int, bytes]], int, bool] | tuple[
    list[tuple[int, bytes, int]], int, bool
]:
    """校验并解析一组分片。

    side 为错误消息前缀（如 "A 侧"），单次重组时留空。
    with_priority=True 时读取每片的 priority（整数，缺省 0），
    返回三元组 [(offset, payload, priority), ...]；
    否则返回二元组 [(offset, payload), ...]。
    第二项为输入字节总量，第三项为是否按序到达。
    """
    if not isinstance(fragments, list) or not fragments:
        raise ReassemblyError(f"{side}至少需要提交一个分片")
    if len(fragments) > max_fragments:
        raise ReassemblyError(f"{side}分片数量 {len(fragments)} 超过上限 {max_fragments}")

    parsed: list[tuple[int, bytes]] | list[tuple[int, bytes, int]] = []
    total_input = 0
    last_end = 0
    in_order = True
    for i, frag in enumerate(fragments):
        if not isinstance(frag, dict):
            raise ReassemblyError(f"{side}分片 {i + 1} 格式不合法")
        offset = frag.get("offset")
        if isinstance(offset, bool) or not isinstance(offset, int):
            raise ReassemblyError(f"{side}分片 {i + 1} 的起始偏移必须是非负整数")
        if offset < 0:
            raise ReassemblyError(f"{side}分片 {i + 1} 的起始偏移不能为负数")
        payload = parse_hex_payload(frag.get("data", ""), i, side)
        length = len(payload)
        if length == 0:
            raise ReassemblyError(f"{side}分片 {i + 1} 的长度为 0")
        if offset + length > expected_length:
            raise ReassemblyError(
                f"{side}分片 {i + 1}（偏移 {offset}，长度 {length}）超出预期长度 "
                f"{expected_length}，覆盖范围 [{offset}, {offset + length}) 越界"
            )
        total_input += length
        if total_input > max_total_input:
            raise ReassemblyError(
                f"{side}所有分片的字节总量 {total_input} 超过上限 {max_total_input}"
            )
        if offset < last_end:
            in_order = False
        last_end = max(last_end, offset + length)
        if with_priority:
            priority = frag.get("priority", 0)
            if isinstance(priority, bool) or not isinstance(priority, int):
                raise ReassemblyError(f"{side}分片 {i + 1} 的优先级必须是整数")
            if abs(priority) > PRIORITY_VALUE_LIMIT:
                raise ReassemblyError(
                    f"{side}分片 {i + 1} 的优先级 {priority} 超出范围 "
                    f"[-{PRIORITY_VALUE_LIMIT}, {PRIORITY_VALUE_LIMIT}]"
                )
            parsed.append((offset, payload, priority))
        else:
            parsed.append((offset, payload))
    return parsed, total_input, in_order


def _build_masks(
    expected_length: int, parsed: list[tuple[int, bytes]]
) -> tuple[bytearray, bytearray, bytearray, dict[int, list[int]], int, int]:
    """把分片写入逐字节状态。

    返回 (data, covered, conflict, value_sets, 同值去重字节数, 异值写入次数)：
      * data     —— 每个位置最先到达的取值；
      * covered  —— 0/1 掩码，该位置是否被至少一个分片覆盖；
      * conflict —— 0/1 掩码，该位置是否收到过互相矛盾的取值；
      * value_sets —— 冲突位置 -> 收到过的不同取值（限幅，仅用于展示）。
    """
    data = bytearray(expected_length)
    covered = bytearray(expected_length)  # 0/1 掩码
    conflict = bytearray(expected_length)  # 0/1 掩码
    # 冲突位置 -> 收到过的不同取值（限幅，仅用于展示）
    value_sets: dict[int, list[int]] = {}
    dup_bytes = 0  # 同值重叠字节数
    conflict_bytes = 0  # 异值重叠写入次数（按写入计）

    for offset, payload in parsed:
        for j, value in enumerate(payload):
            pos = offset + j
            if not covered[pos]:
                covered[pos] = 1
                data[pos] = value
                continue
            if data[pos] == value and not conflict[pos]:
                # 与已采纳字节同值：去重
                dup_bytes += 1
                continue
            # 异值
            if not conflict[pos]:
                conflict[pos] = 1
                vs = [data[pos], value]
                value_sets[pos] = vs[:SAMPLE_VALUES_PER_POSITION]
            else:
                vs = value_sets.get(pos)
                if vs is not None and value not in vs and len(vs) < SAMPLE_VALUES_PER_POSITION:
                    vs.append(value)
            conflict_bytes += 1

    return data, covered, conflict, value_sets, dup_bytes, conflict_bytes


def assemble(
    expected_length: int,
    fragments: list[dict[str, Any]],
    *,
    max_fragments: int,
    max_total_input: int,
) -> tuple[dict[str, Any], bytes | None]:
    """执行重组。

    返回 (报告字典, 可下载字节)。
    只有范围完整（无缺口）且无冲突时，第二项才是完整字节串，否则为 None。
    """
    _check_expected_length(expected_length)
    parsed, total_input, in_order = _parse_fragments(
        expected_length,
        fragments,
        max_fragments=max_fragments,
        max_total_input=max_total_input,
    )
    data, covered, conflict, value_sets, dup_bytes, conflict_bytes = _build_masks(
        expected_length, parsed
    )

    # 由 0/1 掩码生成行程区间（逐字节扫描，上限受 expected_length 配置约束）
    coverage_runs = _mask_to_runs(covered)
    conflict_runs = _mask_to_runs(conflict)
    gap_runs = invert_runs(coverage_runs, expected_length)

    covered_length = sum(e - s for s, e in coverage_runs)
    conflict_length = sum(e - s for s, e in conflict_runs)
    complete = covered_length == expected_length
    has_conflict = conflict_length > 0
    downloadable = complete and not has_conflict
    payload_out: bytes | None = bytes(data) if downloadable else None

    conflict_samples = [
        {"offset": pos, "values": vs}
        for pos, vs in sorted(value_sets.items())[:SAMPLE_POSITION_LIMIT]
    ]

    preview_hex = None
    preview_truncated = False
    if expected_length:
        preview_len = min(expected_length, PREVIEW_LIMIT)
        preview_hex = bytes(data[:preview_len]).hex()
        preview_truncated = expected_length > preview_len

    fragment_report = [
        {
            "index": i + 1,
            "offset": off,
            "length": len(pay),
            "end": off + len(pay),
        }
        for i, (off, pay) in enumerate(parsed)
    ]

    report: dict[str, Any] = {
        "expected_length": expected_length,
        "complete": complete,
        "has_conflict": has_conflict,
        "downloadable": downloadable,
        "in_order": in_order,
        "stats": {
            "fragment_count": len(parsed),
            "total_input_bytes": total_input,
            "covered_length": covered_length,
            "gap_length": expected_length - covered_length,
            "conflict_length": conflict_length,
            "duplicate_bytes": dup_bytes,
            "conflict_write_count": conflict_bytes,
        },
        "coverage": coverage_runs,
        "conflicts": conflict_runs,
        "gaps": gap_runs,
        "conflict_samples": conflict_samples,
        "conflict_samples_truncated": len(value_sets) > len(conflict_samples),
        "preview_hex": preview_hex,
        "preview_truncated": preview_truncated,
        "fragments": fragment_report,
    }
    return report, payload_out


def arrival_trace(
    expected_length: int,
    fragments: list[dict[str, Any]],
    *,
    max_fragments: int,
    max_total_input: int,
) -> dict[str, Any]:
    """分片到达过程诊断。

    按录入顺序逐片应用分片，按字节维护 未覆盖 / 唯一值 / 冲突 三态：
      * 每片统计本次新增覆盖字节数，以及由本片首次变为冲突的字节数；
      * 同值重发、已冲突位置的后续写入不改变状态，不计入上述统计；
      * 首次冲突样本记录偏移、最先写入的分片与触发冲突的分片（限幅）。
    返回逐步骤的累计覆盖 / 累计冲突；诊断结果不提供下载。
    """
    _check_expected_length(expected_length)
    parsed, total_input, in_order = _parse_fragments(
        expected_length,
        fragments,
        max_fragments=max_fragments,
        max_total_input=max_total_input,
    )

    data = bytearray(expected_length)  # 每个位置最先到达的取值
    covered = bytearray(expected_length)  # 0/1 掩码
    conflict = bytearray(expected_length)  # 0/1 掩码
    # 每个位置最先写入的分片序号（0 起算，-1 表示尚未覆盖）
    first_writer = array("i", [-1]) * expected_length

    steps: list[dict[str, Any]] = []
    samples: list[dict[str, Any]] = []
    cum_covered = 0
    cum_conflict = 0
    for k, (offset, payload) in enumerate(parsed):
        new_covered = 0
        new_conflicts = 0
        for j, value in enumerate(payload):
            pos = offset + j
            if not covered[pos]:
                covered[pos] = 1
                data[pos] = value
                first_writer[pos] = k
                new_covered += 1
                continue
            if conflict[pos] or data[pos] == value:
                # 已冲突位置的后续写入 / 同值重发：状态不变，不重复计入
                continue
            # 唯一值位置收到异值：首次变为冲突
            conflict[pos] = 1
            new_conflicts += 1
            if len(samples) < FIRST_CONFLICT_SAMPLE_LIMIT:
                samples.append(
                    {
                        "offset": pos,
                        "first_fragment": first_writer[pos] + 1,
                        "first_value": data[pos],
                        "conflict_fragment": k + 1,
                        "conflict_value": value,
                    }
                )
        cum_covered += new_covered
        cum_conflict += new_conflicts
        steps.append(
            {
                "index": k + 1,
                "offset": offset,
                "length": len(payload),
                "end": offset + len(payload),
                "new_covered": new_covered,
                "new_conflicts": new_conflicts,
                "cumulative_covered": cum_covered,
                "cumulative_conflicts": cum_conflict,
            }
        )

    return {
        "expected_length": expected_length,
        "fragment_count": len(parsed),
        "total_input_bytes": total_input,
        "in_order": in_order,
        "final": {
            "covered_length": cum_covered,
            "gap_length": expected_length - cum_covered,
            "conflict_length": cum_conflict,
        },
        "steps": steps,
        "first_conflict_samples": samples,
        "first_conflict_samples_truncated": cum_conflict > len(samples),
        "sample_limit": FIRST_CONFLICT_SAMPLE_LIMIT,
    }


def assemble_priority(
    expected_length: int,
    fragments: list[dict[str, Any]],
    *,
    max_fragments: int,
    max_total_input: int,
) -> tuple[dict[str, Any], bytes | None]:
    """优先级恢复重组。

    每个分片带整数优先级（缺省 0，越大越优先）。逐字节只在覆盖该位置的
    最高优先级片之间裁决：
      * 最高层取值一致 -> 唯一裁决，来源取最早录入片（同级同值去重）；
      * 最高层出现异值 -> 未决冲突（不裁决、不产生获胜来源）；
      * 更低优先级片的写入一律被抑制，既不覆盖获胜值也不制造冲突；
      * 更高优先级片到达时旧顶层写入整体降级，旧冲突可由此被恢复。
    只有全部字节都有唯一裁决（无缺口、无未决冲突）时才产出可下载字节。
    """
    _check_expected_length(expected_length)
    parsed, total_input, in_order = _parse_fragments(
        expected_length,
        fragments,
        max_fragments=max_fragments,
        max_total_input=max_total_input,
        with_priority=True,
    )

    n = expected_length
    covered = bytearray(n)  # 0/1：该位置是否被任一分片覆盖
    # 最高优先级层的获胜值（仅在有唯一裁决时有意义）
    win_value = bytearray(n)
    # 获胜来源片的录入序号（1 起算，0 表示无唯一裁决：缺口 / 未决冲突）
    win_source = array("i", [0]) * n
    # 覆盖该位置的最高优先级（q 为 8 字节有符号整数）
    top_priority = array("q", [0]) * n
    # 未决冲突位置 -> 最高层收到过的不同值及各自最早来源片（限幅，仅用于展示）
    candidates: dict[int, list[dict[str, int]]] = {}
    # 未决冲突位置 -> 最高层不同取值的实际个数（可能超过候选样本限幅）
    distinct_counts: dict[int, int] = {}

    dup_bytes = 0  # 最高层同值重写字节数（含冲突位上的同值重写）
    conflict_writes = 0  # 最高层异值写入次数（按写入计）
    suppressed_writes = 0  # 因优先级更低被抑制的字节写入次数
    recovered_bytes = 0  # 曾为未决冲突、后被更高优先级恢复的字节数

    for k, (offset, payload, priority) in enumerate(parsed):
        frag_no = k + 1
        for j, value in enumerate(payload):
            pos = offset + j
            if not covered[pos]:
                covered[pos] = 1
                win_value[pos] = value
                win_source[pos] = frag_no
                top_priority[pos] = priority
                continue

            if priority < top_priority[pos]:
                # 低级片不污染结果：异值 / 同值写入都被抑制
                suppressed_writes += 1
                continue

            if priority > top_priority[pos]:
                # 新顶层覆盖旧顶层：旧冲突（若有）被恢复，旧值不参与新裁决
                if win_source[pos] == 0:
                    recovered_bytes += 1
                candidates.pop(pos, None)
                distinct_counts.pop(pos, None)
                win_value[pos] = value
                win_source[pos] = frag_no
                top_priority[pos] = priority
                continue

            # 同级写入
            if win_source[pos] != 0 and win_value[pos] == value:
                # 同级同值：保留最早录入片作来源，计为同值去重
                dup_bytes += 1
                continue

            conflict_writes += 1
            if win_source[pos] != 0:
                # 由唯一裁决首次变为未决冲突：旧获胜值与本片同时成为候选
                candidates[pos] = [
                    {"value": win_value[pos], "fragment": win_source[pos]},
                    {"value": value, "fragment": frag_no},
                ][:SAMPLE_VALUES_PER_POSITION]
                distinct_counts[pos] = 2
                win_source[pos] = 0
            else:
                entry = candidates.get(pos)
                if entry is not None and not any(c["value"] == value for c in entry):
                    distinct_counts[pos] += 1
                    if len(entry) < SAMPLE_VALUES_PER_POSITION:
                        entry.append({"value": value, "fragment": frag_no})
                # 同级同值重发（指向更晚的同值来源片）：不重复计候选

    coverage_runs = _mask_to_runs(covered)
    # 未决冲突位置：已覆盖但无唯一裁决（win_source == 0）
    undecided = bytearray(n)
    for pos in range(n):
        if win_source[pos] == 0:
            undecided[pos] = covered[pos]
    conflict_runs = _mask_to_runs(undecided)
    gap_runs = invert_runs(coverage_runs, n)

    covered_length = sum(e - s for s, e in coverage_runs)
    conflict_length = sum(e - s for s, e in conflict_runs)
    complete = covered_length == n
    has_conflict = conflict_length > 0
    downloadable = complete and not has_conflict
    payload_out: bytes | None = bytes(win_value) if downloadable else None

    # 连续相同获胜来源片的半开区间（缺口与未决冲突位置会打断区间）
    source_runs: list[dict[str, int]] = []
    run_start = -1
    run_source = 0
    run_priority = 0
    for pos in range(n + 1):
        source = win_source[pos] if pos < n else 0
        if source != 0:
            if run_start == -1:
                run_start = pos
                run_source = source
                run_priority = top_priority[pos]
            elif source != run_source:
                source_runs.append(
                    {"start": run_start, "end": pos, "fragment": run_source,
                     "priority": run_priority}
                )
                run_start = pos
                run_source = source
                run_priority = top_priority[pos]
        elif run_start != -1:
            source_runs.append(
                {"start": run_start, "end": pos, "fragment": run_source,
                 "priority": run_priority}
            )
            run_start = -1

    conflict_samples = [
        {
            "offset": pos,
            "priority": top_priority[pos],
            "candidates": candidates[pos],
            "candidates_truncated": distinct_counts[pos] > len(candidates[pos]),
        }
        for pos in sorted(candidates)[:SAMPLE_POSITION_LIMIT]
    ]

    preview_hex = None
    preview_truncated = False
    if n:
        preview_len = min(n, PREVIEW_LIMIT)
        preview_hex = bytes(win_value[:preview_len]).hex()
        preview_truncated = n > preview_len

    fragment_report = [
        {
            "index": i + 1,
            "offset": off,
            "length": len(pay),
            "end": off + len(pay),
            "priority": priority,
        }
        for i, (off, pay, priority) in enumerate(parsed)
    ]

    report: dict[str, Any] = {
        "mode": "priority",
        "expected_length": n,
        "complete": complete,
        "has_conflict": has_conflict,
        "downloadable": downloadable,
        "in_order": in_order,
        "stats": {
            "fragment_count": len(parsed),
            "total_input_bytes": total_input,
            "covered_length": covered_length,
            "gap_length": n - covered_length,
            "decided_length": covered_length - conflict_length,
            "conflict_length": conflict_length,
            "duplicate_bytes": dup_bytes,
            "conflict_write_count": conflict_writes,
            "suppressed_write_count": suppressed_writes,
            "recovered_conflict_bytes": recovered_bytes,
        },
        "coverage": coverage_runs,
        "conflicts": conflict_runs,
        "gaps": gap_runs,
        "source_runs": source_runs,
        "conflict_samples": conflict_samples,
        "conflict_samples_truncated": len(candidates) > len(conflict_samples),
        "preview_hex": preview_hex,
        "preview_truncated": preview_truncated,
        "fragments": fragment_report,
    }
    return report, payload_out


def _side_reason(covered: bytearray, conflict: bytearray, pos: int) -> str | None:
    """单侧某偏移不可判定的原因：缺口 / 冲突；该侧为唯一值时返回 None。"""
    if not covered[pos]:
        return REASON_GAP
    if conflict[pos]:
        return REASON_CONFLICT
    return None


def diff_captures(
    expected_length: int,
    fragments_a: list[dict[str, Any]],
    fragments_b: list[dict[str, Any]],
    window_start: int,
    window_length: int,
    *,
    max_fragments: int,
    max_total_input: int,
    max_window: int = MAX_DIFF_WINDOW,
) -> dict[str, Any]:
    """双次抓包差异定位。

    对窗口 [window_start, window_start + window_length) 内每个偏移分别判定：
      * 两侧均为唯一值     -> 取值相等归 same，不等归 diff；
      * 任一侧为缺口或冲突 -> undecidable，并记录两侧各自的原因。
    连续同类且原因相同的字节合并为半开区间 [start, end)。
    """
    _check_expected_length(expected_length)
    for name, value in (("窗口起点", window_start), ("窗口长度", window_length)):
        if isinstance(value, bool) or not isinstance(value, int):
            raise ReassemblyError(f"{name}必须是整数")
    if window_start < 0:
        raise ReassemblyError("窗口起点不能为负数")
    if window_length < 1:
        raise ReassemblyError("窗口长度至少为 1 字节")
    if window_length > max_window:
        raise ReassemblyError(f"窗口长度 {window_length} 超过上限 {max_window}")
    window_end = window_start + window_length
    if window_end > expected_length:
        raise ReassemblyError(
            f"比较窗口 [{window_start}, {window_end}) 超出预期长度 {expected_length}"
        )

    # 两侧各自复用单次重组的校验与输入上限；字节总量合并后再卡一次总上限
    parsed_a, total_a, in_order_a = _parse_fragments(
        expected_length,
        fragments_a,
        max_fragments=max_fragments,
        max_total_input=max_total_input,
        side="A 侧",
    )
    parsed_b, total_b, in_order_b = _parse_fragments(
        expected_length,
        fragments_b,
        max_fragments=max_fragments,
        max_total_input=max_total_input,
        side="B 侧",
    )
    if total_a + total_b > max_total_input:
        raise ReassemblyError(
            f"两侧分片的字节总量 {total_a + total_b} 超过上限 {max_total_input}"
        )

    data_a, covered_a, conflict_a, _, dup_a, cw_a = _build_masks(expected_length, parsed_a)
    data_b, covered_b, conflict_b, _, dup_b, cw_b = _build_masks(expected_length, parsed_b)

    counts = {CATEGORY_SAME: 0, CATEGORY_DIFF: 0, CATEGORY_UNDECIDABLE: 0}
    runs: list[dict[str, Any]] = []
    prev_key: tuple[str, str | None, str | None] | None = None
    run_start = window_start
    for pos in range(window_start, window_end):
        reason_a = _side_reason(covered_a, conflict_a, pos)
        reason_b = _side_reason(covered_b, conflict_b, pos)
        if reason_a is None and reason_b is None:
            key = (
                (CATEGORY_SAME, None, None)
                if data_a[pos] == data_b[pos]
                else (CATEGORY_DIFF, None, None)
            )
        else:
            key = (CATEGORY_UNDECIDABLE, reason_a, reason_b)
        counts[key[0]] += 1
        if key != prev_key:
            if prev_key is not None:
                runs.append(_make_diff_run(run_start, pos, prev_key))
            run_start = pos
            prev_key = key
    assert prev_key is not None  # window_length >= 1，循环至少执行一次
    runs.append(_make_diff_run(run_start, window_end, prev_key))

    diff_runs = [[r["start"], r["end"]] for r in runs if r["category"] == CATEGORY_DIFF]
    undecidable_runs = [
        {
            "start": r["start"],
            "end": r["end"],
            "reason_a": r["reason_a"],
            "reason_b": r["reason_b"],
        }
        for r in runs
        if r["category"] == CATEGORY_UNDECIDABLE
    ]

    def side_stats(
        parsed: list[tuple[int, bytes]],
        total_input: int,
        in_order: bool,
        covered: bytearray,
        conflict: bytearray,
        dup_bytes: int,
        conflict_writes: int,
    ) -> dict[str, Any]:
        # 统计范围为整个 [0, expected_length)，而非仅比较窗口
        covered_length = covered.count(1)
        conflict_length = conflict.count(1)
        return {
            "fragment_count": len(parsed),
            "total_input_bytes": total_input,
            "covered_length": covered_length,
            "gap_length": expected_length - covered_length,
            "conflict_length": conflict_length,
            "duplicate_bytes": dup_bytes,
            "conflict_write_count": conflict_writes,
            "in_order": in_order,
        }

    return {
        "expected_length": expected_length,
        "window": {"start": window_start, "length": window_length, "end": window_end},
        "max_window_length": max_window,
        "counts": counts,
        "runs": runs,
        "diff_runs": diff_runs,
        "undecidable_runs": undecidable_runs,
        "sides": {
            "a": side_stats(parsed_a, total_a, in_order_a, covered_a, conflict_a, dup_a, cw_a),
            "b": side_stats(parsed_b, total_b, in_order_b, covered_b, conflict_b, dup_b, cw_b),
        },
    }


def _make_diff_run(
    start: int, end: int, key: tuple[str, str | None, str | None]
) -> dict[str, Any]:
    category, reason_a, reason_b = key
    return {
        "start": start,
        "end": end,
        "category": category,
        "reason_a": reason_a,
        "reason_b": reason_b,
    }


def _mask_to_runs(mask: bytearray) -> list[list[int]]:
    """把 0/1 掩码压缩为 [start, end) 行程列表。"""
    runs: list[list[int]] = []
    n = len(mask)
    i = 0
    while i < n:
        if mask[i] == 0:
            i += 1
            continue
        start = i
        end = mask.find(0, i + 1)
        if end == -1:
            runs.append([start, n])
            break
        runs.append([start, end])
        i = end + 1
    return runs


# ------------------------------ 字节签名定位 ------------------------------

# 逐起点判定结果
SIG_HIT_DEFINITE = "definite"  # 确定命中：每个确定字节均唯一且相等
SIG_HIT_POSSIBLE = "possible"  # 可能命中：存在缺口或含目标值的冲突
SIG_REASON_GAP = "gap"  # 不确定位原因：该位无任何分片覆盖
SIG_REASON_CONFLICT = "conflict"  # 不确定位原因：该位有冲突，且冲突取值中包含目标值


def parse_signature(raw: str) -> list[int | None]:
    """解析字节签名。

    每个字节位写作两位十六进制（如 ``48``、``ff``）或通配符 ``??``，
    允许空格、冒号、横线分隔；返回每项为 0~255 的确定字节或 None（通配）。
    长度需在 1~64 字节之间，且至少包含一个确定字节。
    """
    if not isinstance(raw, str):
        raise ReassemblyError("签名必须是字符串")
    text = raw.replace(":", "").replace("-", "")
    text = "".join(text.split()).lower()
    if text == "":
        raise ReassemblyError("签名为空")
    if len(text) % 2 != 0:
        raise ReassemblyError(
            f"签名长度为奇数（{len(text)} 个字符），每个字节位需写两位 hex 或 ??"
        )
    tokens = [text[i : i + 2] for i in range(0, len(text), 2)]
    if not (MIN_SIGNATURE_BYTES <= len(tokens) <= MAX_SIGNATURE_BYTES):
        raise ReassemblyError(
            f"签名长度 {len(tokens)} 字节超出允许范围 "
            f"{MIN_SIGNATURE_BYTES}~{MAX_SIGNATURE_BYTES} 字节"
        )
    pattern: list[int | None] = []
    for tok in tokens:
        if tok == "??":
            pattern.append(None)
            continue
        try:
            pattern.append(int(tok, 16))
        except ValueError:
            raise ReassemblyError(
                f"签名含非法字节位 {tok!r}：每位必须是两位十六进制或 ??"
            ) from None
    if not any(b is not None for b in pattern):
        raise ReassemblyError("签名不能全部为 ?? 通配位，至少需要一个确定字节")
    return pattern


def _build_conflict_value_index(
    expected_length: int,
    parsed: list[tuple[int, bytes]],
) -> tuple[bytearray, bytearray, dict[int, set[int]]]:
    """构建逐字节状态与冲突位置 -> 该位置全部出现过的取值集合。

    返回 (state, data, values)：
      * state —— 0 缺口 / 1 唯一值 / 2 冲突；
      * data  —— 唯一值位置的取值（先到先得）；
      * values —— 冲突位置 -> 该位置出现过的**全部**不同取值（不限幅），
        以便签名判定时确认目标值是否仍有可能成立。

    与 _build_masks 采用相同的逐字节语义（先到先得、同值去重、异值标冲突）；
    冲突集合的内存规模与输入字节总量同阶，受 max_total_input 约束。
    """
    state = bytearray(expected_length)  # 0 缺口 / 1 唯一 / 2 冲突
    data = bytearray(expected_length)
    values: dict[int, set[int]] = {}
    for offset, payload in parsed:
        for j, value in enumerate(payload):
            pos = offset + j
            st = state[pos]
            if st == 0:
                state[pos] = 1
                data[pos] = value
            elif st == 1:
                if data[pos] != value:
                    # 唯一值位置首次收到异值：升级为冲突，此时才建立取值集合
                    state[pos] = 2
                    values[pos] = {data[pos], value}
            else:
                values[pos].add(value)
    return state, data, values


def signature_scan(
    expected_length: int,
    fragments: list[dict[str, Any]],
    signature: str,
    window_start: int,
    window_length: int,
    *,
    max_fragments: int,
    max_total_input: int,
    max_window: int = MAX_SIGNATURE_WINDOW,
) -> dict[str, Any]:
    """字节签名定位。

    签名由确定字节（0~255）与 ``??`` 通配位组成。对候选起点窗口
    [window_start, window_start + window_length) 内的每个起点 s
    （要求 s + 签名长度 ≤ 预期长度，越界起点计入 out_of_bounds 且不参与判定），
    按所有分片在每个确定字节位上的实际取值判定：

      * 每个确定字节位都恰好有一个唯一取值且与目标相等 -> 确定命中；
      * 某确定字节位为缺口，或为冲突且冲突取值中包含目标值（仍可能相等），
        且不存在任何“唯一异值 / 不含目标值的冲突”位 -> 可能命中；
      * 任一确定字节位有唯一异值，或冲突取值中不含目标值 -> 排除该起点；
      * 通配位忽略，不作任何判断。

    返回确定命中 / 可能命中总数（全窗口）、前 SIGNATURE_HIT_SAMPLE_LIMIT
    个命中起点（两类混合按起点排序）以及每个可能命中的不确定位原因。
    不生成下载、不进入下载缓存。
    """
    _check_expected_length(expected_length)
    for name, value in (("窗口起点", window_start), ("窗口长度", window_length)):
        if isinstance(value, bool) or not isinstance(value, int):
            raise ReassemblyError(f"{name}必须是整数")
    if window_start < 0:
        raise ReassemblyError("窗口起点不能为负数")
    if window_length < 1:
        raise ReassemblyError("窗口长度至少为 1 字节")
    if window_length > max_window:
        raise ReassemblyError(f"窗口长度 {window_length} 超过上限 {max_window}")
    if window_start > expected_length:
        raise ReassemblyError(
            f"窗口起点 {window_start} 超出预期长度 {expected_length}"
        )

    pattern = parse_signature(signature)
    sig_len = len(pattern)
    fixed = [(i, b) for i, b in enumerate(pattern) if b is not None]

    # 复用单次重组的输入校验与上限（hex 解析、分片数、字节总量、越界）
    parsed, total_input, _in_order = _parse_fragments(
        expected_length,
        fragments,
        max_fragments=max_fragments,
        max_total_input=max_total_input,
    )
    covered, data, values = _build_conflict_value_index(expected_length, parsed)

    window_end = min(window_start + window_length, expected_length + 1)
    # 起点 s 合法当且仅当 s + sig_len <= expected_length
    last_valid_start = expected_length - sig_len

    definite_count = 0
    possible_count = 0
    excluded_count = 0
    out_of_bounds_count = 0
    hits: list[dict[str, Any]] = []

    for start in range(window_start, window_end):
        if start > last_valid_start:
            # 起点加上签名长度后越界：不参与判定
            out_of_bounds_count += 1
            continue

        possible = False
        uncertainties: list[dict[str, Any]] | None = None
        excluded = False
        for offset_in_sig, target in fixed:
            pos = start + offset_in_sig
            st = covered[pos]
            if st == 0:
                # 缺口：无法证明相等也无法证明不等
                possible = True
                if uncertainties is None:
                    uncertainties = []
                uncertainties.append(
                    {
                        "position": offset_in_sig,
                        "offset": pos,
                        "target": target,
                        "reason": SIG_REASON_GAP,
                    }
                )
                continue
            if st == 1:
                if data[pos] != target:
                    # 唯一异值：该起点排除
                    excluded = True
                    break
                continue
            # 冲突位置：只有冲突取值中包含目标值时才仍可能命中
            seen = values[pos]
            if target not in seen:
                excluded = True
                break
            possible = True
            if uncertainties is None:
                uncertainties = []
            shown = sorted(seen)[:SIGNATURE_VALUE_SAMPLE_LIMIT]
            uncertainties.append(
                {
                    "position": offset_in_sig,
                    "offset": pos,
                    "target": target,
                    "reason": SIG_REASON_CONFLICT,
                    "conflict_values": shown,
                    "conflict_values_truncated": len(seen) > len(shown),
                }
            )

        if excluded:
            excluded_count += 1
        elif possible:
            possible_count += 1
            hits.append(
                {
                    "start": start,
                    "category": SIG_HIT_POSSIBLE,
                    "uncertainties": uncertainties or [],
                }
            )
        else:
            definite_count += 1
            hits.append(
                {"start": start, "category": SIG_HIT_DEFINITE, "uncertainties": []}
            )

    # 两类命中混合按起点升序，仅保留前 SIGNATURE_HIT_SAMPLE_LIMIT 个
    total_hits = len(hits)
    hits.sort(key=lambda h: h["start"])
    hits_truncated = total_hits > SIGNATURE_HIT_SAMPLE_LIMIT
    hits = hits[:SIGNATURE_HIT_SAMPLE_LIMIT]

    checked_count = definite_count + possible_count + excluded_count
    pattern_hex = " ".join("??" if b is None else f"{b:02x}" for b in pattern)

    return {
        "expected_length": expected_length,
        "signature": {
            "hex": pattern_hex,
            "length": sig_len,
            "fixed_byte_count": len(fixed),
            "wildcard_count": sig_len - len(fixed),
        },
        "window": {
            "start": window_start,
            "length": window_length,
            "end": window_end,
            "checked_count": checked_count,
            "out_of_bounds_count": out_of_bounds_count,
        },
        "max_window_length": max_window,
        "total_candidate_starts": max(0, expected_length - sig_len + 1),
        "counts": {
            "definite": definite_count,
            "possible": possible_count,
            "excluded": excluded_count,
            "out_of_bounds": out_of_bounds_count,
        },
        "hits": hits,
        "hits_truncated": hits_truncated,
        "hit_sample_limit": SIGNATURE_HIT_SAMPLE_LIMIT,
        "stats": {
            "fragment_count": len(parsed),
            "total_input_bytes": total_input,
        },
    }
