"""FastAPI 入口：重组 API、双次抓包差异定位 API、分片到达过程诊断 API、结果下载与静态页面托管。"""

from __future__ import annotations

import os
import time
import uuid
from collections import OrderedDict
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, StrictInt

from .reassembly import (
    FIRST_CONFLICT_SAMPLE_LIMIT,
    MAX_DIFF_WINDOW as DEFAULT_MAX_DIFF_WINDOW,
    PRIORITY_VALUE_LIMIT,
    ReassemblyError,
    arrival_trace as run_arrival_trace,
    assemble,
    assemble_priority,
    diff_captures,
)

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"

# ---- 可调配置（环境变量） -------------------------------------------------
MAX_EXPECTED_LENGTH = int(os.getenv("MAX_EXPECTED_LENGTH", str(16 * 1024 * 1024)))
MAX_FRAGMENTS = int(os.getenv("MAX_FRAGMENTS", "4096"))
MAX_TOTAL_INPUT = int(os.getenv("MAX_TOTAL_INPUT", str(64 * 1024 * 1024)))
# 双次抓包差异定位的比较窗口最大字节数
MAX_DIFF_WINDOW = int(os.getenv("MAX_DIFF_WINDOW", str(DEFAULT_MAX_DIFF_WINDOW)))
# 重组结果（含可下载字节）最多保留多少份 / 多久（秒）
JOB_RETENTION_COUNT = int(os.getenv("JOB_RETENTION_COUNT", "100"))
JOB_RETENTION_SECONDS = int(os.getenv("JOB_RETENTION_SECONDS", "1800"))


class FragmentIn(BaseModel):
    model_config = ConfigDict(extra="ignore")

    offset: StrictInt = Field(..., description="分片起始字节偏移，0 起算")
    data: str = Field(..., description="分片原始内容的十六进制表示")
    priority: StrictInt = Field(
        default=0,
        description="优先级恢复模式下的整数优先级，越大越优先；其他接口忽略该字段",
    )


class ReassembleIn(BaseModel):
    model_config = ConfigDict(extra="ignore", strict=True)

    expected_length: StrictInt = Field(..., ge=0, description="预期还原负载的总字节数")
    fragments: list[FragmentIn] = Field(..., min_length=1)


class ReassemblePriorityIn(BaseModel):
    model_config = ConfigDict(extra="ignore", strict=True)

    expected_length: StrictInt = Field(..., ge=0, description="预期还原负载的总字节数")
    fragments: list[FragmentIn] = Field(..., min_length=1, description="带整数优先级的分片")


class DiffIn(BaseModel):
    model_config = ConfigDict(extra="ignore", strict=True)

    expected_length: StrictInt = Field(..., ge=0, description="预期负载总字节数（A/B 两侧相同）")
    window_start: StrictInt = Field(..., ge=0, description="比较窗口起始偏移，0 起算")
    window_length: StrictInt = Field(..., ge=0, description="比较窗口字节数，上限见 /api/health")
    fragments_a: list[FragmentIn] = Field(..., min_length=1, description="第一次抓包的分片")
    fragments_b: list[FragmentIn] = Field(..., min_length=1, description="第二次抓包的分片")


# job_id -> (created_at, payload_bytes)
_jobs: "OrderedDict[str, tuple[float, bytes]]" = OrderedDict()


def _store_job(payload: bytes) -> str:
    job_id = uuid.uuid4().hex
    _jobs[job_id] = (time.time(), payload)
    now = time.time()
    # 先按时间淘汰过期结果
    expired = [
        jid for jid, (created_at, _) in _jobs.items()
        if now - created_at > JOB_RETENTION_SECONDS
    ]
    for jid in expired:
        _jobs.pop(jid, None)
    # 再按容量淘汰最旧结果
    while len(_jobs) > JOB_RETENTION_COUNT:
        _jobs.popitem(last=False)
    return job_id


app = FastAPI(
    title="单向抓包负载重组工具",
    description="按字节偏移重组乱序分片，标注重叠冲突与覆盖缺口；支持优先级恢复、A/B 双次抓包差异定位与分片到达过程诊断。",
    version="1.3.0",
)


@app.exception_handler(ReassemblyError)
async def reassembly_error_handler(_request, exc: ReassemblyError):
    return JSONResponse(status_code=400, content={"detail": str(exc)})


@app.get("/api/health")
async def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "limits": {
            "max_expected_length": MAX_EXPECTED_LENGTH,
            "max_fragments": MAX_FRAGMENTS,
            "max_total_input": MAX_TOTAL_INPUT,
            "max_diff_window": MAX_DIFF_WINDOW,
            "max_first_conflict_samples": FIRST_CONFLICT_SAMPLE_LIMIT,
            "priority_value_limit": PRIORITY_VALUE_LIMIT,
        },
    }


@app.post("/api/reassemble")
async def reassemble(body: ReassembleIn) -> dict[str, Any]:
    if body.expected_length > MAX_EXPECTED_LENGTH:
        raise HTTPException(
            status_code=400,
            detail=f"预期字节数 {body.expected_length} 超过上限 {MAX_EXPECTED_LENGTH}",
        )
    if len(body.fragments) > MAX_FRAGMENTS:
        raise HTTPException(
            status_code=400,
            detail=f"分片数量 {len(body.fragments)} 超过上限 {MAX_FRAGMENTS}",
        )

    report, payload = assemble(
        body.expected_length,
        [f.model_dump() for f in body.fragments],
        max_fragments=MAX_FRAGMENTS,
        max_total_input=MAX_TOTAL_INPUT,
    )

    if payload is not None:
        report["job_id"] = _store_job(payload)
        report["download_url"] = f"/api/download/{report['job_id']}"
    else:
        report["job_id"] = None
        report["download_url"] = None
    return report


@app.post("/api/reassemble-priority")
async def reassemble_priority(body: ReassemblePriorityIn) -> dict[str, Any]:
    """优先级恢复：每片带整数优先级，逐字节只采用最高优先级层的裁决。

    复用与 /api/reassemble 相同的 hex 解析、分片数、字节总量与预期长度上限；
    仅当全部字节都有唯一裁决（无缺口、无未决冲突）时写入下载缓存并开放下载。
    """
    if body.expected_length > MAX_EXPECTED_LENGTH:
        raise HTTPException(
            status_code=400,
            detail=f"预期字节数 {body.expected_length} 超过上限 {MAX_EXPECTED_LENGTH}",
        )
    if len(body.fragments) > MAX_FRAGMENTS:
        raise HTTPException(
            status_code=400,
            detail=f"分片数量 {len(body.fragments)} 超过上限 {MAX_FRAGMENTS}",
        )

    report, payload = assemble_priority(
        body.expected_length,
        [f.model_dump() for f in body.fragments],
        max_fragments=MAX_FRAGMENTS,
        max_total_input=MAX_TOTAL_INPUT,
    )

    if payload is not None:
        report["job_id"] = _store_job(payload)
        report["download_url"] = f"/api/download/{report['job_id']}"
    else:
        report["job_id"] = None
        report["download_url"] = None
    return report


@app.post("/api/arrival-trace")
async def arrival_trace(body: ReassembleIn) -> dict[str, Any]:
    if body.expected_length > MAX_EXPECTED_LENGTH:
        raise HTTPException(
            status_code=400,
            detail=f"预期字节数 {body.expected_length} 超过上限 {MAX_EXPECTED_LENGTH}",
        )
    if len(body.fragments) > MAX_FRAGMENTS:
        raise HTTPException(
            status_code=400,
            detail=f"分片数量 {len(body.fragments)} 超过上限 {MAX_FRAGMENTS}",
        )

    # 诊断结果不进入下载缓存，直接返回
    return run_arrival_trace(
        body.expected_length,
        [f.model_dump() for f in body.fragments],
        max_fragments=MAX_FRAGMENTS,
        max_total_input=MAX_TOTAL_INPUT,
    )


@app.post("/api/diff")
async def diff(body: DiffIn) -> dict[str, Any]:
    if body.expected_length > MAX_EXPECTED_LENGTH:
        raise HTTPException(
            status_code=400,
            detail=f"预期字节数 {body.expected_length} 超过上限 {MAX_EXPECTED_LENGTH}",
        )
    if len(body.fragments_a) > MAX_FRAGMENTS:
        raise HTTPException(
            status_code=400,
            detail=f"A 侧分片数量 {len(body.fragments_a)} 超过上限 {MAX_FRAGMENTS}",
        )
    if len(body.fragments_b) > MAX_FRAGMENTS:
        raise HTTPException(
            status_code=400,
            detail=f"B 侧分片数量 {len(body.fragments_b)} 超过上限 {MAX_FRAGMENTS}",
        )

    return diff_captures(
        body.expected_length,
        [f.model_dump() for f in body.fragments_a],
        [f.model_dump() for f in body.fragments_b],
        body.window_start,
        body.window_length,
        max_fragments=MAX_FRAGMENTS,
        max_total_input=MAX_TOTAL_INPUT,
        max_window=MAX_DIFF_WINDOW,
    )


@app.get("/api/download/{job_id}")
async def download(job_id: str) -> Response:
    entry = _jobs.get(job_id)
    if entry is None:
        raise HTTPException(status_code=404, detail="结果不存在或已过期，请重新重组")
    _, payload = entry
    _jobs.move_to_end(job_id)
    return Response(
        content=payload,
        media_type="application/octet-stream",
        headers={
            "Content-Disposition": f'attachment; filename="reassembled_{job_id[:8]}.bin"',
            "Content-Length": str(len(payload)),
        },
    )


@app.get("/", include_in_schema=False)
async def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
