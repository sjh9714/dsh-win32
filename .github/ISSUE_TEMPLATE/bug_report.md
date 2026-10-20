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
- For Desktop, application name, About version/build, release channel, and public download URL (record bundled DSH separately):
- Node and PowerShell versions:
- dsh-win32 version:
- Preset used: stock Minimal / explicit legacy preset / other
- Permission mode: workspace-write / danger-full-access
- Windows version + locale (e.g. Win11 23H2, zh-CN):

For a PowerShell startup failure, include the short error and whether it came from a foreground command or persistent terminal. If discovery failed, include only the redacted `where.exe pwsh` result and doctor PowerShell check. Do not paste your full PATH or change permissions to obtain a passing result.

**Verification reached**

- `verify`: passed / failed / not run
- Actual installed version/source selected by `verify` (redact private paths):
- Stock Minimal session: worked / blocked / not run
- Fresh isolated-profile comparison: worked / blocked / not run (do not reset your existing profile)

These are separate results: `verify` does not boot the complete Minimal session.
