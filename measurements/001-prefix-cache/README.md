# 001. Prefix cache hit rate of a stock DSH session

**Result. After the first request of a session, a stock DeepSeek Harness standard session hits the provider prefix cache at 97.3%. Misses are only the tokens appended since the previous request.**

## 中文摘要

对本机真实开发会话日志（7 个会话、19 次模型请求、deepseek-v4-flash、standard 预设）的实测。除每个会话的第一次请求外，前缀缓存命中率为 97.3%，未命中部分恰好等于新追加的内容。DSH 的会话架构（"每个请求都是会话日志的纯函数"）在实际使用中确实兑现了 DeepSeek 出了名的缓存优势。结论是，你不需要任何"缓存优化插件"，官方实现已经接近理论上限。复现方法见文末。

## Question

r/LocalLLaMA lore says DeepSeek's prefix cache hit rate is dark magic and that some harnesses exploit it far better than others. DSH's own architecture notes promise that every model request is a pure function of the append-only session log. Does a stock DSH session actually cash that promise in, measured against the live API?

## Method

Data source is the local DSH session store at `~/.dsh/sessions`. Every `session.jsonl.zstd` is an append-only event log. Each `assistant/message` event records the final token usage of one model request. The DeepSeek adapter maps the wire fields into disjoint counts, so `cacheReadTokens` is exactly `prompt_cache_hit_tokens` and `inputTokens` is the cache miss remainder ([translate.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm-deepseek/src/translate.ts)).

`measure.py` (in this directory, stdlib only, needs the `zstd` CLI) extracts one row per request into `data.csv` and prints the summary. The sessions are real plugin development work from 2026-08-15, not synthetic prompts.

## Results

| Metric | Value |
|---|---|
| Sessions / requests | 7 / 19 |
| Model | deepseek-v4-flash, standard preset, macOS |
| Overall hit rate | 86.8% (143,744 hit / 21,930 miss tokens) |
| Hit rate after the first request of each session | **97.3%** (n=12) |
| Worst single non-first miss | 722 tokens (against 8,320 hit) |

Every session pays one cold bootstrap of roughly 8.3k to 8.7k tokens on request #1 (system prompt, tool catalog, workspace context). From request #2 on, the entire previous prefix hits the cache and the miss column is just the newly appended turn content.

Excerpt from `data.csv`.

| session | request | hit | miss |
|---|---|---|---|
| 07177b45 | 1 | 0 | 8,350 |
| 07177b45 | 2 | 8,320 | 722 |
| b962c94f | 2 | 8,448 | 344 |
| b962c94f | 3 | 8,960 | 94 |
| b962c94f | 4 | 9,088 | 263 |

## Why it holds

This is not luck. It is designed in, and the receipts are in the DSH repo.

1. The reconstructability invariant. Every model request is a pure function of the session log. Features that would break it get rejected on that ground alone (for one example, see the REPL kernel rejection in the [code mode design note](https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/feature/2026-06-15-code-mode.md)).
2. A key gated e2e test asserts real provider cache hits on every request after the first, against the live DeepSeek API ([request-cache.e2e.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/agent-loop/tests/request-cache.e2e.ts)). Its comment states the design intent plainly. "prefix stability is corollary #1".
3. Mutable context, such as workspace instruction changes, is rendered as appended delta events instead of rewriting earlier messages ([agent-instructions render](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/context/agent-instructions/src/render.ts)).

## What this means for your bill

Cache hit input tokens are billed at a steep discount relative to miss tokens (see the [DeepSeek pricing page](https://api-docs.deepseek.com/quick_start/pricing) for the current ratio, which is changing after the announced price increase). At a hit price of one tenth of the miss price, the input side of these sessions costs 78% less than the same traffic without a cache. The practical takeaway is the opposite of what the plugin gold rush suggests. You do not need a cache optimizer plugin. Stock DSH is already within a few percent of the theoretical ceiling, and anything that rewrites earlier context (custom compaction, history editing, prompt injecting plugins that mutate old messages) can only make it worse.

## Limitations

- n=19 requests over 7 sessions, one machine, one model (v4-flash), standard preset only.
- Short development sessions. No compaction event occurred, so the cache cost of compaction is unmeasured (planned as measurement 005).
- Third party plugins that mutate history were not present. Their effect is unmeasured.
- DeepSeek bills at 64 token cache block granularity, so per-request numbers carry small rounding effects.

## Reproduce

```sh
python3 measure.py --selftest
python3 measure.py --csv data.csv          # reads ~/.dsh/sessions
python3 measure.py --sessions-dir /path/to/sessions
```
