# 禁用、卸载或移除 dsh-win32（disable / uninstall / remove）

[English](./uninstall.md)

升级 DSH 后旧插件不兼容时，不能要求你先把 DSH 启动起来才能修复。从 **0.17.14** 起，独立 CLI 的 `disable` 命令可离线解除旧 bundle 的启用状态，不加载 DSH 或旧插件，不执行包管理器，也不访问 GitHub。这是 [#92](https://github.com/sjh9714/dsh-win32/issues/92) 的恢复入口。

## DSH 无法启动时，先禁用旧 bundle

1. 关闭受影响的 DSH 应用及会话，停止该 profile 的包安装操作。不要修改运行中的 profile。
2. 确认原启动入口使用的 **同一个 profile 和 `DSH_HOME`**。默认 Web profile 是 `$DSH_HOME/profiles/web`；未设置 `DSH_HOME` 时根目录是 `%USERPROFILE%\.dsh`。Desktop 可能使用应用自己的目录，请确认实际路径，不要猜成这里的 `desktop` profile。
3. 先预览将要修改的文件：

   ```powershell
   npx dsh-win32@0.17.14 disable --profile web
   ```

4. 核对输出的 `package.json` 路径，再执行：

   ```powershell
   npx dsh-win32@0.17.14 disable --profile web --apply
   ```

对于应用单独管理的 profile，使用已经确认的、包含 `package.json` 的目录：

```powershell
npx dsh-win32@0.17.14 disable --profile-dir "C:\your-confirmed-profile-directory"
npx dsh-win32@0.17.14 disable --profile-dir "C:\your-confirmed-profile-directory" --apply
```

`--profile` 与 `--profile-dir` 二选一。默认 profile 为 `web`，不会根据进程猜测路径。链接/junction profile、链接 manifest、损坏或有重复键等歧义的 JSON 会被拒绝；不存在的 profile 不会自动创建。若存在 `package.json.lock`，命令不会抢占：等待原包操作结束，或在所有写入者停止后人工调查遗留锁。

预览不会写文件。`--apply` 会在**选定 profile 内**创建唯一的 `.dsh-win32-backup-*` 目录，逐字节备份原 `package.json`，然后只移除 `dsh.profile.bundles` 中精确的 `dsh-win32` 项。其他字段及其原文本保持不变，完成后输出备份路径。重复禁用不会重复修改或生成备份。

此时包本身仍在磁盘上。依赖、lockfile、自定义 patch、预设、会话、凭据、BusyBox、快捷方式及包管理政策均保留。成功只说明 bundle 已断开，不表示任意自定义配置或完整会话已修复。Profile patch 是另一层：若输出提示 `cordis.patch.yml` 或 `cordis.yml` 仍含旧引用，请继续下面的人工检查。命令不会遍历所有自定义 `--patch` 文件或历史会话快照。

`npx` 首次可能需要下载独立 CLI。已有本地 **0.17.14 或更新版本**时，可以直接用对应 `dsh-win32`，或 `node <该包路径>/bin/cli.mjs disable ...` 完全离线执行。获取 CLI 时保留现有发布时间/构建政策。如果独立 CLI 也无法运行，按下面的方法手动恢复。

## 连独立 CLI 都无法运行：手动恢复

停止 DSH，找到真实 profile 目录，先把 `package.json` 及存在的 `cordis.patch.yml` / `cordis.yml` **复制到唯一的备份目录**。备份可能含凭据，请保存在本机。不要删除或替换整个 profile。

用文本编辑器打开原 `package.json`，**只在 `dsh.profile.bundles` 数组内**删除 `"dsh-win32"`。例如：

```json
["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-win32"]
```

改成：

```json
["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]
```

上面只是一个数组的示例，不是让你替换整个 manifest。保留其他 bundle、依赖及字段，保存为无 BOM 的有效 UTF-8 JSON。恢复期间 `dependencies["dsh-win32"]` 可以保留；[官方 profile loader](https://github.com/deepseek-ai/deepseek-harness/blob/46a7f68b0922371ce7144b668b90e377d8e799f4/packages/boot/app-boot/src/profile.ts) 区分安装和启用。

如果 bundle 项已经不存在，或曾手动修改配置，还要单独检查：

- 在已备份的 profile patch/roster 和启动时额外传入的 `--patch` 文件中搜索 `dsh-win32`、`subprocess-windows`。
- 旧手动接线可能是一对操作：先在 Windows 上禁用官方 `id: subprocess`，再插入 `id: subprocess-windows`、`name: dsh-win32`。只移除确认属于旧接线的这一对操作，保留其他 patch。只删插入的 runtime 会让官方 runtime 仍处于禁用状态。不要全局搜索删除，也不要修改权限政策。
- 自定义 roster 也可能直接挂载 `dsh-win32/fs` 或 `dsh-win32/fs-confined`。取消 bundle 启用不会重写它。保留备份，在当前 DSH 中用官方 **stock Minimal + Workspace Write 新建会话**；不要继续旧 `minimal-windows` / `minimal-windows-sandboxed` 会话并把它当成迁移验证。

两个旧预设位于 `$DSH_HOME/.agent-presets/minimal-windows` 和 `minimal-windows-sandboxed`，可能被多个 profile 共用。若要停用，先确认其他 profile/会话不再需要，再把**整个目录移动到 `.agent-presets` 之外的备份目录**，保留自定义文件和已有备份。不要删除整个 `.agent-presets`。改名后的自定义副本需要单独检查。

## 禁用后，再卸载磁盘上的包

原 DSH 包管理命令仍可运行时，通过**同一个已安装入口、同一个 profile**执行：

```powershell
dsh plugin --profile web remove dsh-win32
```

这里的 `dsh` 指你原来的启动入口，不是重新下载的宿主。如果这个入口也损坏，直接用**已安装的 pnpm**，指定刚才预览确认的精确 profile 目录：

```powershell
pnpm --dir "C:\your-confirmed-profile-directory" remove dsh-win32
```

这是独立的包操作：移除依赖，并更新这个 profile 的 lockfile/module tree，不需要先启动 DSH。保留 pnpm 原来的配置和发布时间/构建政策。如果卸载失败，保留错误和备份；不要强制重装或删除 `node_modules` / 整个 profile。调查卸载错误期间，旧 bundle 可以保持禁用。

不再需要桌面的 `DeepSeek Harness` 快捷方式时，先查看目标，再只把该快捷方式移到回收站。当前普通 `setup` 主要检查官方组件并创建这个快捷方式，不会安装旧 bundle。`npx` 本身也不是全局安装；只有你曾明确全局安装 CLI 时，才用原包管理器单独卸载，例如 npm 全局安装对应 `npm uninstall --global dsh-win32`。不要因此卸载 DSH、PowerShell、Git 或共享依赖。

## 如何恢复备份

关闭 DSH 和 profile 包操作，先对比备份与当前 manifest。若之后没有需要保留的新包/配置变更，可把输出路径里的备份 `package.json` 复制回原位置；若之后已有变更，只合并需要的 bundle-list 修改，避免覆盖更新内容。恢复会重新启用旧 bundle 及其兼容限制，不能修复新宿主兼容性。恢复预设目录前也要确认原目标不存在，且确实仍需要旧宿主。

若官方新会话仍失败，请在 [#92](https://github.com/sjh9714/dsh-win32/issues/92) 提供准确的宿主/CLI 版本、失败操作及最短脱敏错误，不要上传完整 profile、备份或凭据。
