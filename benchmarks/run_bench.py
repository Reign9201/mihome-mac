#!/usr/bin/env python3
"""在本机跑四种运行时的启动、JSON 解码、AES-128-CBC 解密基准。

不是完整 App 基准：只测协议层最热的两个动作，用来支撑技术栈取舍。
"""

import json
import re
import statistics
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data" / "home.json"
RUNNERS = {
    "Swift 6.2": [str(ROOT / "bench_swift")],
    "Rust 1.86": [str(ROOT / "rust" / "target" / "release" / "bench")],
    "Node 24": ["node", str(ROOT / "bench.js")],
    "Python 3.9": ["python3", str(ROOT / "bench.py")],
}
ITERS_JSON = 30
ITERS_CRYPTO = 3000


def run_once(cmd, timeout=120):
    started = time.perf_counter()
    proc = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=timeout)
    wall_ms = (time.perf_counter() - started) * 1000
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr[-400:])
    return wall_ms, proc.stdout.strip()


def measure_startup(cmd, runs=15):
    for _ in range(2):
        run_once(cmd)
    walls = [run_once(cmd)[0] for _ in range(runs)]
    return statistics.median(walls), min(walls)


def measure_reported(mode, iterations, runs=5):
    values = []
    for _ in range(runs):
        _, out = run_once([*cmd, mode, str(DATA), str(iterations)])
        m = re.search(r"ns_per_iter=(\d+)", out)
        values.append(int(m.group(1)))
    return statistics.median(values)


def measure_rss(cmd):
    # macOS /usr/bin/time -l 输出单位为字节
    proc = subprocess.run(["/usr/bin/time", "-l", *cmd, "startup", str(DATA)],
                          cwd=ROOT, capture_output=True, text=True)
    m = re.search(r"(\d+)\s+maximum resident set size", proc.stderr)
    return round(int(m.group(1)) / 1024 / 1024, 1) if m else None


results = {}
for name, base in RUNNERS.items():
    cmd = base
    print(f"running {name} ...", file=sys.stderr)
    startup_med, startup_min = measure_startup([*cmd, "startup", str(DATA), "1"])
    json_ns = measure_reported("json", ITERS_JSON)
    crypto_ns = measure_reported("crypto", ITERS_CRYPTO)
    rss = measure_rss(cmd)
    results[name] = {
        "startup_ms": round(startup_med, 1),
        "startup_min_ms": round(startup_min, 1),
        "json_ms": round(json_ns / 1e6, 2),
        "crypto_us": round(crypto_ns / 1e3, 2),
        "rss_mb": rss,
    }

payload = {
    "hardware": "Apple M4 / 32 GB / macOS 26.6.2 (25G83)",
    "data": {"file": str(DATA), "size_kb": round(DATA.stat().st_size / 1024, 1), "devices": 120, "props_per_device": 40},
    "iters": {"json": ITERS_JSON, "crypto": ITERS_CRYPTO},
    "results": results,
}
(ROOT / "results.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

lines = [
    "# 本机微基准结果",
    "",
    f"- 机器：{payload['hardware']}",
    f"- 数据：{payload['data']['size_kb']} KiB，120 台设备 × 40 条属性",
    f"- JSON 每轮 {ITERS_JSON} 次取中位数；AES 每轮 {ITERS_CRYPTO} 次取中位数",
    "",
    "| 运行时 | 进程启动 (ms, 中位) | 启动最快 (ms) | JSON 解码 (ms) | AES-128-CBC 1 KiB (µs) | 峰值内存 (MB) |",
    "|---|---:|---:|---:|---:|---:|",
]
for name, r in results.items():
    lines.append(f"| {name} | {r['startup_ms']} | {r['startup_min_ms']} | {r['json_ms']} | {r['crypto_us']} | {r['rss_mb']} |")
lines += [
    "",
    "说明：",
    "",
    "- 启动时间为进程从 exec 到退出的墙钟时间，包含运行时初始化、读取 1.7 MiB 文件并解码一次。",
    "- JSON 解码为单次解码 1.7 MiB 嵌套对象的中位耗时；Swift 用 `JSONDecoder` 到强类型模型。",
    "- AES 为每次新建 cipher 上下文后解密 1 KiB 数据的中位耗时，包含密钥扩展。",
    "- 峰值内存取自 `/usr/bin/time -l` 的 maximum resident set size。",
    "- 这是协议层微基准，不代表完整 GUI App 的启动和内存；GUI 另计入窗口系统、图形栈和资源。",
]
(ROOT / "results.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
print(json.dumps(payload, ensure_ascii=False, indent=2))
