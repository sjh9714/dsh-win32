#!/usr/bin/env python3
"""Measure DeepSeek prefix-cache hit rates from local DSH session logs.

Reads every `session.jsonl.zstd` under the DSH sessions directory, extracts
per-request token usage from `assistant/message` events (one event per model
request; usage fields are disjoint, see
packages/llm/llm-deepseek/src/translate.ts in the DSH repo), writes a CSV,
and prints hit-rate summaries.

Requires the `zstd` CLI (`brew install zstd` / `apt install zstd`).
Usage:
    python3 measure.py [--sessions-dir ~/.dsh/sessions] [--csv data.csv]
    python3 measure.py --selftest
"""

import argparse
import csv
import glob
import json
import os
import subprocess
import sys


def iter_events(jsonl: str):
    for line in jsonl.splitlines():
        try:
            yield json.loads(line)
        except json.JSONDecodeError:
            continue


def extract_rows(jsonl: str, session_id: str):
    """One row per model request: assistant/message events carry final usage."""
    rows = []
    request = 0
    for ev in iter_events(jsonl):
        if ev.get("type") != "assistant/message":
            continue
        data = ev.get("data") or {}
        usage = data.get("usage")
        if not isinstance(usage, dict):
            continue
        request += 1
        message = data.get("message") or {}
        source = message.get("source") or {}
        rows.append({
            "session": session_id,
            "request": request,
            "turn": data.get("turn"),
            "step": data.get("step"),
            "seq": ev.get("seq"),
            "time": ev.get("time"),
            "model": source.get("model", ""),
            "miss_tokens": usage.get("inputTokens", 0),
            "hit_tokens": usage.get("cacheReadTokens", 0),
            "output_tokens": usage.get("outputTokens", 0),
            "reasoning_tokens": usage.get("reasoningTokens", 0),
        })
    return rows


def summarize(rows):
    total_hit = sum(r["hit_tokens"] for r in rows)
    total_miss = sum(r["miss_tokens"] for r in rows)
    rest = [r for r in rows if r["request"] > 1]
    rest_hit = sum(r["hit_tokens"] for r in rest)
    rest_miss = sum(r["miss_tokens"] for r in rest)
    return {
        "requests": len(rows),
        "sessions": len({r["session"] for r in rows}),
        "hit_tokens": total_hit,
        "miss_tokens": total_miss,
        "hit_rate": total_hit / (total_hit + total_miss) if total_hit + total_miss else 0.0,
        "non_first_hit_rate": rest_hit / (rest_hit + rest_miss) if rest_hit + rest_miss else 0.0,
        "non_first_requests": len(rest),
    }


def selftest():
    sample = "\n".join([
        json.dumps({"type": "assistant/chunk", "seq": 1, "data": {"turn": 1, "step": 1,
                    "chunk": {"type": "usage", "usage": {"inputTokens": 100, "outputTokens": 5}}}}),
        json.dumps({"type": "assistant/message", "seq": 2, "time": 0, "data": {"turn": 1, "step": 1,
                    "message": {"source": {"model": "m"}},
                    "usage": {"inputTokens": 100, "cacheReadTokens": 0, "outputTokens": 5}}}),
        json.dumps({"type": "assistant/message", "seq": 3, "time": 1, "data": {"turn": 1, "step": 2,
                    "message": {"source": {"model": "m"}},
                    "usage": {"inputTokens": 10, "cacheReadTokens": 100, "outputTokens": 5}}}),
    ])
    rows = extract_rows(sample, "test")
    assert len(rows) == 2, "chunk events must not be counted as requests"
    s = summarize(rows)
    assert s["requests"] == 2 and s["hit_tokens"] == 100 and s["miss_tokens"] == 110
    assert abs(s["non_first_hit_rate"] - 100 / 110) < 1e-9
    print("selftest ok")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--sessions-dir", default=os.path.expanduser("~/.dsh/sessions"))
    parser.add_argument("--csv", default=None, help="write per-request rows to this CSV")
    parser.add_argument("--selftest", action="store_true")
    args = parser.parse_args()
    if args.selftest:
        selftest()
        return

    rows = []
    pattern = os.path.join(args.sessions_dir, "**", "session.jsonl.zstd")
    for path in sorted(glob.glob(pattern, recursive=True)):
        session_id = os.path.basename(os.path.dirname(path)).removeprefix("session-")[:8]
        decoded = subprocess.run(["zstd", "-dc", path], capture_output=True, check=False)
        rows.extend(extract_rows(decoded.stdout.decode("utf-8", "replace"), session_id))

    if not rows:
        sys.exit(f"no assistant/message usage rows found under {args.sessions_dir}")

    if args.csv:
        with open(args.csv, "w", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
            writer.writeheader()
            writer.writerows(rows)
        print(f"wrote {len(rows)} rows to {args.csv}")

    s = summarize(rows)
    print(f"sessions={s['sessions']} requests={s['requests']}")
    print(f"overall     hit={s['hit_tokens']} miss={s['miss_tokens']} hit_rate={s['hit_rate']*100:.1f}%")
    print(f"after first request per session: hit_rate={s['non_first_hit_rate']*100:.1f}% (n={s['non_first_requests']})")
    print("\nper-request (worst 10 by miss, excluding first requests):")
    for r in sorted((r for r in rows if r["request"] > 1), key=lambda r: -r["miss_tokens"])[:10]:
        print(f"  {r['session']} req#{r['request']:<3} hit={r['hit_tokens']:<7} miss={r['miss_tokens']}")


if __name__ == "__main__":
    main()
