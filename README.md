# dsh-measured

Reproducible measurements of DeepSeek Harness behavior. No vibes, just receipts.

[中文](./README.zh.md)

The DSH ecosystem is three days old and already full of claims. Minimal mode is smarter. The cache is dark magic. Windows is second class. This repo tests those claims against the live system, publishes the data, and ships the script so you can reproduce every number on your own machine.

## Measurements

| # | Question | Headline result |
|---|---|---|
| [001](./measurements/001-prefix-cache/) | Does stock DSH actually exploit DeepSeek's prefix cache? | **97.3% hit rate** after the first request. You do not need a cache plugin. |

## Planned

| # | Question | Status |
|---|---|---|
| 002 | Windows vs Linux. Does DSH really only show its "true capabilities" under Linux, as claimed? | queued |
| 003 | Minimal vs Standard first-request anchoring. Independent replication of the dsh-anchored-standard result. | queued |
| 004 | What exactly is inside the 8.4k token standard session bootstrap? | queued |
| 005 | What does one compaction event do to your cache hit rate and your bill? | queued |

Want a claim measured? [Open an issue](../../issues) with the claim and its source.

## Principles

- Every number comes from a fresh run against the real system, never from a paper or a feeling.
- Every measurement ships its script, its raw data, and its limitations.
- Negative and boring results get published too. 001 is a boring result. Stock DSH is already excellent, which kills an entire category of plugin ideas, and that is worth knowing before you build one.

## License

MIT
