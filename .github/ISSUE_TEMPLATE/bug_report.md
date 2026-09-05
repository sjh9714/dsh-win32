---
name: Bug report
about: Something broke on your Windows setup
labels: bug
---

**What happened**

<!-- What you did, what you expected, what you got. Error text verbatim if any. -->

**Failed check and short redacted error**

```
Run npx dsh-win32 doctor --json and name the failed or warning checks.
Do not paste credentials, private paths, full configuration, or terminal logs.
```

**Environment**

- Actual installed DSH version and launcher used:
- Node and PowerShell versions:
- dsh-win32 version:
- Preset used: stock Minimal / explicit legacy preset / other
- Permission mode: workspace-write / danger-full-access
- Windows version + locale (e.g. Win11 23H2, zh-CN):

**Verification reached**

- `verify`: passed / failed / not run
- Stock Minimal session: worked / blocked / not run

These are separate results: `verify` does not boot the complete Minimal session.
