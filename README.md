# dsh-win32

## Native Windows. No WSL.

**One command. Workspace Write.**

Run DSH Minimal mode on Windows with the sandboxed preset.

```powershell
npx dsh-win32 setup --sandboxed
```

DeepSeek Harness already runs natively on Windows with PowerShell. dsh-win32 adds persistent Minimal presets, including one that survives Workspace Write.

This preset uses busybox ash, so Git Bash and WSL are not required.

[中文](./README.zh.md) · [Windows details](./docs/windows-details.md)

<p>
<a href="https://www.npmjs.com/package/dsh-win32"><img src="https://img.shields.io/npm/v/dsh-win32?style=flat-square&label=npm&color=cb3837" alt="npm"></a>
<a href="https://github.com/sjh9714/dsh-win32/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/sjh9714/dsh-win32/ci.yml?style=flat-square&label=CI" alt="CI"></a>
<a href="https://github.com/sjh9714/dsh-win32/stargazers"><img src="https://img.shields.io/github/stars/sjh9714/dsh-win32?style=flat-square" alt="stars"></a>
<img src="https://img.shields.io/badge/platform-win32-0078D4?style=flat-square" alt="win32">
<img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="MIT">
</p>

## See it work

**Illustrated installation reproduction. This is not a real capture.**

![Illustrated dsh-win32 installation reproduction](./assets/demo.gif)

**Real Windows session.**

![A real Windows session fixes a failing test in Workspace Write](./assets/shot-persistent-sandboxed.png)

The real session runs a failing test, reads the source, applies a fix, and reruns it to `all tests passed` in `Workspace Write`.

## Choose a preset

After setup, start DSH, add a workspace, and choose the preset.

- **Minimal (Windows, sandboxed)** uses busybox ash inside `Workspace Write`. Install it with `npx dsh-win32 setup --sandboxed`.
- **Minimal (Windows)** uses Git Bash and needs `danger-full-access`. Install it with `npx dsh-win32 setup` after installing [Git for Windows](https://git-scm.com).

Using DSH Desktop instead of the Web profile?

```powershell
npx dsh-win32 setup --sandboxed --profile desktop --no-shortcut
```

Restart DSH Desktop after setup, then choose **Minimal (Windows, sandboxed)**.

## Doctor

```powershell
npx dsh-win32 doctor
```

`doctor` lists known Windows setup traps and their safe fixes. Use `npx dsh-win32 fix` for fixes it can apply safely.

## Honest limits

- The sandboxed preset is ash, not Bash. It does not support arrays or `[[ ]]`.
- Legacy-encoded files are read automatically, but saving an edited file writes UTF-8.
- Treat `C:\tmp` as outside the expected write fence until the upstream Windows path issue is fixed.

[Read the Windows details, evidence, and complete limitations](./docs/windows-details.md). [Read the Chinese translation](./README.zh.md).

## License

MIT. The preset composition mirrors the official Minimal preset with credit.
