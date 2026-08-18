# dsh-win32

**在 Windows 上把 DSH 用起来。极简模式、持久 shell、沙箱，全部可用。**

[English](./README.en.md)

<p>
<a href="https://www.npmjs.com/package/dsh-win32"><img src="https://img.shields.io/npm/v/dsh-win32?style=flat-square&label=npm&color=cb3837" alt="npm"></a>
<a href="https://github.com/sjh9714/dsh-win32/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/sjh9714/dsh-win32/ci.yml?style=flat-square&label=CI" alt="CI"></a>
<a href="https://github.com/sjh9714/dsh-win32/stargazers"><img src="https://img.shields.io/github/stars/sjh9714/dsh-win32?style=flat-square" alt="stars"></a>
<img src="https://img.shields.io/badge/platform-win32-0078D4?style=flat-square" alt="win32">
<img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="MIT">
</p>

![沙箱内跑完一整轮真实的修 bug](./assets/shot-persistent-sandboxed.png)

真机截图。沙箱模式（`Workspace Write`）下，Agent 跑测试看到失败、读源码定位、改掉、再跑一次拿到 `all tests passed`。

## 三步装好

```powershell
npx dsh-win32 setup --sandboxed
```

需要 [Git for Windows](https://git-scm.com)（`winget install Git.Git`）。

装完桌面上会多一个 **「DeepSeek Harness」** 快捷方式，**双击就能起**，不用每次去翻命令（不想要的话加 `--no-shortcut`）。它会开一个控制台窗口，用那个窗口打印的**那一条**网址。也可以照旧 `npx @deepseek-ai/dsh web`。

起来之后。

1. 左侧 `Workspaces` 那行点文件夹图标，**先加一个工作区**。不加的话输入框是灰的，打不了字
2. 预设选择器里选 **Minimal (Windows, sandboxed)**
3. 权限徽章保持 **Workspace Write**

想要 Git Bash 而不是 busybox，`npx dsh-win32 setup` 装另一个预设，选 **Minimal (Windows)**，权限切到 `danger-full-access`。两个预设的区别见下面第 ① 条。

出问题了跑 `npx dsh-win32 doctor`，它会逐项指出已知的坑。

## 四件别处做不到的事

**① 沙箱里也能用持久 shell**（v0.4 起）

其它 Windows 方案都只能要求 `danger-full-access`，因为 Git Bash 这类 shell 在沙箱里根本起不来。我们换了一个能在沙箱里活下来的 shell（busybox-w32 ash），所以 `workspace-write` 下也有持久 shell。据我们所知这是目前唯一一个。

代价是 ash 不是 bash，没有数组、没有 `[[ ]]`。原因写在下面「为什么会这样」。

**② 极简模式真正可用**

Windows 上选极简模式会直接报错，持久 shell 和依赖它的极简模式整个用不了。我们把官方缺的那块补上了，**不改核心一行代码**。取消命令（Ctrl-C）也修好了，不再把整个会话打断。

![Windows 上真正可用的极简模式](./assets/shot-persistent-gitbash.png)

`export BUILD=v1` 在一次工具调用里结束，下一次独立的工具调用里 `$BUILD` 还活着，所以提交信息是 `v1`，`git log --oneline` 的输出就是证据。持久性是在真实工作里顺带证明的，不是靠专门造的标记变量。

**③ 命令跑完了 Agent 才知道**（v0.7 起，社区贡献）

Windows 上没法直接问「终端里现在跑着什么」，所以 Agent 会把还在跑的命令当成已结束。改成从 ConPTY 控制台进程列表解析后修好了，约 81ms。

**④ Read Only 真的是只读**（v0.11 起）

官方极简模式挂的是裸 `fs-local`，它不上报 `sandboxMode`。而 `str_replace_editor` 正是读这个值来决定要不要建写入策略。

```ts
// tool-str-replace-editor/src/index.ts:69
this.policy = ctx.fs.sandboxMode === undefined ? undefined : ctx.get('sandboxPolicy')
```

裸后端下这里是 `undefined`，于是**没有任何写入围栏**。权限徽章写着 Read Only，编辑器照样能改机器上任意绝对路径的文件。读能穿透是设计如此（`fs-sandbox` 在所有模式下也放行读），写能穿透不是。已上报 [#2066](https://github.com/deepseek-ai/deepseek-harness/discussions/2066)。

**两个预设都换成了会围栏的后端**，GBK/UTF-16 读取解码照旧。`read-only` 拒绝一切写入，`workspace-write` 只放行工作区、`/tmp` 和系统临时目录。

**这里有个 Windows 上的坑，是核心的 `writableRoots` 带来的，我们继承了它。** 那个列表里的 `/tmp` 是 POSIX 字面量，在 Windows 上 `realpathSync.native('/tmp')` 会按当前盘符解析成 `C:\tmp`。这个目录如果存在（装机脚本常建），默认 ACL 是所有已认证用户可写的**机器级共享目录**，于是编辑器能往那儿写。更别扭的是 ACL 沙箱会拒绝 shell 往那儿写，所以两个写入平面对同一路径的判断不一致。已上报 [#2562](https://github.com/deepseek-ai/deepseek-harness/discussions/2562)（报告者 Binhna / @maycuatroi1）。在核心修掉之前，Windows 上把 `C:\tmp` 当成围栏外来对待。`npx dsh-win32 doctor` 里的 `write_fence` 一项会告诉你装的是哪个版本。

Git Bash 预设一开始没接，理由是它本来就要求 `danger-full-access`。那个理由用错了工具。要求 `danger-full-access` 的是 **shell**，因为 MSYS 在受限令牌下起不来；**编辑器是另一个工具**，跟 shell 起没起来无关。所以徽章停在 Read Only 的会话，会是「shell 用不了 + 编辑器能改机器上任何文件」。`danger-full-access` 下围栏是直通的，所以接上去在预期模式下零代价，在非预期模式下把洞堵上。v0.11.1 起两个都接了。

## 为什么会这样

上面几条的根因。想知道自己撞的是不是这些，或者自己写 preset 会不会踩到，看这里。

### 报错 `terminal inspection is unsupported on platform win32`

**这个报错和 node-pty 无关。** 重装 node-pty、换 Node 版本、装 VS Build Tools 都不会有任何变化，报错一个字都不变。很多人在这上面花了时间。

原因在官方 subprocess 运行时的 `createProcessInspector`。它按平台分派 ProcessInspector 实现，win32 分支直接 throw，而且这次调用发生在 `nodePty.spawn` **之前**。所以 PTY 根本没有机会启动。官方架构笔记里把它标为待补项。

我们通过官方留的注入座补上 win32 实现，进程树用一次 CIM 快照（pid、ppid、CreationDate 三者构成进程身份，防 pid 复用），信号用 taskkill，取消命令按 ConPTY 惯例把 Ctrl-C 作为 PTY 输入写进去。

### 沙箱里 Git Bash 起不来

`workspace-write` 用的是受限令牌。Cygwin / MSYS 运行时启动时要做 cygheap 初始化，涉及令牌操作和共享内存映射，受限令牌不给，进程当场死掉。实测两个同族签名。

```
cygheap_user::init: NtSetInformationToken (TokenDefaultDacl), 0xC0000022
CreateFileMapping ... Win32 error 5
```

第二个是用户在自己机器上报告的，显式配了 `shellPath` 仍然复现，排除了路径问题。这是 MSYS 运行时模型和受限令牌的直接冲突，**在插件层无解**。这也解释了为什么现有 Windows 方案清一色要求 `danger-full-access`，不是作者们偷懒。

busybox-w32 的 ash 是纯 Win32 实现，没有 POSIX 模拟层，也就没有那步会被拒的初始化。windows-latest CI 上有完整的 send/read 往返实测，是必跑任务，同一条路径上 MSYS bash 复现已知死法也留在 CI 里。

### 前台命令识别为什么不能靠父进程链

MSYS 的 fork 模拟会切断父子链。实测很直白，Git Bash 的 PTY 里跑 `sleep 20`，查它的直接子进程，是空的。同一时刻查 ConPTY 的控制台进程列表，那个 sleep 清清楚楚在里面。控制台归属是控制台自身的属性，不依赖父子关系维持。

`/proc` 也不行。MSYS 确实模拟 POSIX 作业控制，每个作业有独立 pgid，但 `/proc/<pid>/stat` 第 8 个字段 `tpgid`（tty 的前台组）永远是 -1，Cygwin 不暴露 `tcgetpgrp`。所以 `/proc` 和控制台列表回答的是同一个问题，**没有任何时点查询能分开前台命令和后台作业**。

分开它们的是时间。前台命令会在 shell 拿回终端之前退出，后台作业不会。这块和上面的控制台列表解析都是社区贡献者做的。

### 旧编码文件读不了

官方 fs 对 GBK / UTF-16 文件返回 `FS_NOT_TEXT` 直接拒读，国内老项目里这种文件一大把，Agent 连打开都做不到。两个预设都挂了 `dsh-win32/fs-confined`，读取路径自动嗅探解码（同时按会话权限模式围栏写入，见上面第 ④ 条）。写入保持 UTF-8，所以编辑一个旧编码文件会把它转成 UTF-8，不做往返。

## 其它安装方式

上面那条最短。这里是其它路径。

按生态惯例的一行装法，插件激活时会自动把预设装进 `$DSH_HOME/.agent-presets/`（已存在则不覆盖）。

```sh
dsh plugin --profile web add dsh-win32
```

不想手工接线的话，PowerShell 里一行全自动。

```powershell
irm https://raw.githubusercontent.com/sjh9714/dsh-win32/master/install.ps1 | iex
```

它会把运行时 bundle 接入 web profile、安装预设、建桌面快捷方式并输出体检报告。想用 npx 也一样。

```sh
npx dsh-win32 setup              # bundle + 预设 + 体检
npx dsh-win32 setup --sandboxed  # 额外装沙箱内可用的 busybox 变体
npx dsh-win32 setup --no-shortcut  # 不建桌面快捷方式
```

![预设选择器](./assets/shot-preset-picker.png)

预设立即出现在选择器里，无需重启。需要 [Git for Windows](https://git-scm.com)（`winget install Git.Git`）。

沙箱变体（`minimal-windows-sandboxed`）只能由 `setup --sandboxed` 安装，因为它要下载 busybox-w32，而 busybox 是 GPLv2，插件激活时静默下载既是许可问题也是同意问题。接入 bundle 还需要 pnpm，因为 `dsh plugin add` 是用它装进 profile 目录的。缺失时 `setup` 会通过 corepack 自动启用，`doctor` 也会单独列出该项。

已经出问题了？`npx dsh-win32 doctor` 逐项指出已知的坑（koffi 3.1.3/3.1.4 损坏预编译导致的安装失败与选择器崩溃、缺 PowerShell 7 时 5.1 的 0xC0000142（有桌面打包版的崩溃报告，本 CLI 路径上实测受限令牌下 5.1 能正常启动）、localhost 与 127.0.0.1 的 403、System32 里的 WSL 假 bash），`npx dsh-win32 fix` 自动修复能安全修的部分。

`doctor` 还能吐机器可读的结果，给 CI 和支持流程用。

```sh
npx dsh-win32 doctor --json
```

输出是社区共同定的 `dsh-doctor/v1` 信封（[deepseek-harness#1719](https://github.com/deepseek-ai/deepseek-harness/discussions/1719)），退出码沿用契约的 0 / 1 / 2（全通过 / 有 warn / 有 fail）。里面的 `skip` 状态是我们提的，因为 `git_bash` 这类检查在 Linux 上既不是通过也不是失败而是不适用，只有三个状态的话实现要么说谎要么污染整条 CI。`skip` 必须带原因，且不计入通过或失败。

**`dsh-doctor/v1` 词汇表 r5 兼容。** 由 [@ciceroyang](https://github.com/ciceroyang)（ciceroyang/dsh-doctor）起草，[@sjh9714](https://github.com/sjh9714)（dsh-win32）与 [@moonquake2004](https://github.com/moonquake2004) 参与评审。

状态字面量是 `pass` / `warn` / `fail` / `skip`。`node` 只有两态，在声明范围内是 `pass`，范围外是 `warn`（对齐 npm 的 EBADENGINE 语义，范围之下没有任何有出处的 fail 边界）。

## 还有

**黑框修复。** 超时杀进程的 taskkill 补上 `windowsHide`，不再闪控制台窗口。

**前台 shell 输出的旧编码。** v0.5 起 collect 输出和文件读取走同样的嗅探解码。

## 实证

- windows-latest CI 每次推送都跑：持久 Git Bash PTY 状态跨调用保留（先 `STATE=x`，再 `echo $STATE`）、中断 `sleep 60` 得 exit 130、前台解析三态、GBK 子进程输出解码。
- 受限令牌（workspace-write 沙箱）内 busybox ash 完整往返，MSYS bash 在同一路径复现已知死法。一条命令可复现，`SANDBOX_MODE=workspace-write node scripts/sandbox-smoke.mjs`。
- 真实模型会话：两次 bash 工具调用之间变量和 cwd 都活着。
- 第三方在真实 Windows 机器上独立复现过测试套件（见 deepseek-harness#1889）。

## 诚实的限制

- Git Bash 预设需要 `danger-full-access`（MSYS 受限令牌问题如上，已实测）。沙箱内请用 busybox 变体，代价是 ash 而非 bash（没有数组、没有 `[[ ]]`）。
- **`toPortableEval` 只覆盖实现了 ANSI-C 引用（`$'...'`）的 shell，不是所有 POSIX shell。** 它把核心发的 `eval -- $'...'` 改写成 `eval $' ...'`，前导空格绕开了 `--` 这个 bashism，但 `$'...'` 本身也是 bashism。busybox ash 实现了它（我们的 CI 门禁就是这个形式，windows-latest 上是绿的），**dash 没有**，`$'abc'` 在 dash 里得到字面量 `$abc`，于是报错从 `eval: --: not found` 变成 `eval: $: not found`，同样是 exit 127。真正的全 POSIX 覆盖要求核心的 `quoteForBash` 有一条普通单引号转义路径，那在上游（[#2271](https://github.com/deepseek-ai/deepseek-harness/discussions/2271)）。我们只支持 busybox ash 一路。
- 旧编码文件的编辑会保存为 UTF-8，不做往返。
- PTY 输出的旧代码页在插件层无法解码：node-pty 在任何 DSH 代码运行之前就按 UTF-8 解码，且在 Windows 上拒绝编码覆盖。随附 shell 默认 UTF-8，所以预设不受影响。
- `foregroundPgid` 只能返回一个 pid，但管道的每一段都附着在控制台上。就就绪判据而言这很够（只需区分“shell”与“不是 shell”），但信号投递不够，所以 `signalGroup` 会**重新解析并扇出**到该终端当前所有非后台附着（[#24](https://github.com/sjh9714/dsh-win32/issues/24)）：`sleep 90 | cat | cat` 实测三段全部被 SIGTERM 清除，而之前三段全部存活。残留是竞态：若作业在解析与发信号之间变了，只有原先那个 pid 会被打到，即退回旧行为。后台作业被 `resting` 排除在外，不会被误伤。SIGINT 不受影响，它走 Ctrl-C 注入，由 shell 自己给整个作业发信号。取最新而不是最老是有意的，后台作业比前台命令更老，取最老会打错目标，还会在 shell 已经回到提示符时报告前台繁忙，那正是 [#7](https://github.com/sjh9714/dsh-win32/issues/7) 说的判别器失效。
- 官方 bash 工具把每条命令包成 `eval -- $'...'`（注意 `$`，`quoteForBash` 用的是 ANSI-C 引用），而 `eval --` 是 bash 特有的写法，POSIX shell 不接受，busybox ash 会把 `--` 当成命令名，于是沙箱预设里每条命令都以 `eval: --: not found`（exit 127）失败（[#12](../../issues/12)，实测 busybox-w32 v1.38，在 dash 上同样复现，所以不是 busybox 的怪癖）。`eval` 是特殊内建，没法用函数覆盖（`Bad function name`），所以我们在写入 PTY 的那一层把它改写成等价的可移植形式（引号内加一个前导空格）。那个 `$` 是关键。0.8.1 的改写把锚点写成了普通单引号，和生产字符串对不上，于是一次都没触发，沙箱预设在「已修复」的说法下继续死着，直到 0.9.1 才真的修好。这个改写只匹配官方包装器的完整形状，对 bash 行为完全等价（包括 `--` 本来要防的「命令以 `-` 开头」那种情况）。已上报 [deepseek-harness#2271](https://github.com/deepseek-ai/deepseek-harness/discussions/2271)，官方修好后我们这段就删掉。
- **win32 上控制台进程没有优雅终止，所以 `SIGTERM` 在优雅形式被拒后会升级为强杀。** 不带 `/F` 的 taskkill 是向窗口发关闭请求，而控制台进程没有窗口，实测 exit 128、进程照跑；旧实现把这个失败当成“目标已退出”，于是对每一条 MSYS 命令 `SIGTERM` 都是空操作。现在仍先做优雅尝试，仅当 taskkill 报失败**且进程仍存活**时才强杀，所以自己退出的进程不会被追杀。**这里没有牺牲任何东西**：优雅形式在这个平台上根本无法生效，选择是“强杀”而不是“不杀”，不是“优雅”与“强杀”之选。见 [#24](https://github.com/sjh9714/dsh-win32/issues/24)。
- `isStdinWaiting` 恒为 false。Windows 没有可靠的「控制台读阻塞」探测，假装有会把还在跑的命令判成结束。
- 基于 DSH `0.1.0-rc.6` 开发，rc 更新会快速跟进。

## 自己写 preset 的注意事项

如果你的 preset 挂载 `@deepseek-ai/dsh-terminal-bash` 却不显式配 `shellPath`，默认的 `/bin/bash` 在 Windows 上会命中 `C:\Windows\System32\bash.exe`（WSL 启动器），PTY 启动即退。请显式指向真正的 shell。

```yaml
- id: terminal-bash
  name: '@deepseek-ai/dsh-terminal-bash'
  config:
    shellPath: 'C:/Program Files/Git/usr/bin/bash.exe'
    shellArgs: ['--noprofile', '--norc', '-i']
```

用 `usr/bin/bash.exe` 而不是 `bin/bash.exe`。后者是 47KB 的 wrapper，会再拉起前者，PTY 的 pid 会落在 wrapper 上而不是 shell 上。来自 #6 用户报告。

## 中国网络提示

`irm raw.githubusercontent.com...` 和 busybox 的 `frippery.org` 在部分网络环境下可能无法直连。替代路径：安装用 `npx dsh-win32 setup`（npm 源可换 npmmirror），busybox 手动下载后用 `npx dsh-win32 setup --sandboxed --busybox <路径>` 指定。

## 相关项目

从 Claude Code 迁过来的话，[dsh-movein](https://github.com/sjh9714/dsh-movein) 一条命令把技能、MCP、hooks、子代理和权限规则整套搬进 DSH，默认先出搬家清单预演，搬完 `npx dsh-movein doctor` 随时体检。

## 贡献

欢迎实机报告（[#3](../../issues/3) 收集不同 Windows 环境的结果）、issue 和 PR。v0.7 的前台解析就来自社区贡献。

## 相关

[dsh-lean](https://github.com/sjh9714/dsh-lean) — 关掉单智能体会话用不到的委派/目标/后台任务工具，把 DSH 提示词前缀压掉 53%。`npx dsh-lean audit` 什么都不装就能看自己会话的钱花在哪。

## License

MIT。预设组合复刻自官方极简模式（MIT）并注明出处。踩坑清单提炼自 DSH 官方讨论区的社区报告。
