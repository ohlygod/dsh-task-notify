# dsh-task-notify

每次 DSH 的一轮任务跑完，就在 Windows 上弹一条**系统通知**（托盘气泡）。不联网、不上传任何内容。

## 为什么是托盘气泡，不是 Toast

实测两条路，只有一条能用：

| 方式 | 结果 |
|---|---|
| WinRT `ToastNotificationManager` | ❌ `The process has no package identity`（`0x80073D54`） |
| `NotifyIcon.ShowBalloonTip` | ✅ 可用 |

Toast 只认 MSIX 打包、带包身份的应用，而 DSH 桌面端的引擎子是普通进程。所以这里用托盘气泡 —— 它同样进系统通知中心，只是不会套用「专注助手」的置顶样式。

## 装

```bash
pnpm add -w dsh-task-notify
```

bundle 型插件（`cordis.patch.yml` 会 insert 一行），装完重启 DSH 生效。

## 用

**设置 → 任务提醒**：

- 开关（默认开）
- 「试一条」立刻弹一条测试通知，用来确认系统没把通知吞掉

不想看通知时关掉即可，配置存在 `$DSH_HOME/task-notify/config.json`。

## 行为细节

- **只认 `turn/end`**：`assistant/message` 之后还可能跟工具调用，拿它当完成信号会让用户以为任务好了、其实还在跑。
- **5 秒内同一会话合并成一条**：一轮跑完用户常会立刻追问，逐条弹会刷屏。
- **标题取会话标题**，取不到就显示「DSH 任务完成」。正文优先用事件里的收尾摘要。
- **通知进程超时 15 秒被杀**，不会堆积卡住的 PowerShell。

## 安全

会话标题是**外部输入**。它里面有引号、反引号、`$()`、换行都很正常（一个叫 `$(rm -rf)` 的会话标题完全合法）。所以：

- 脚本主体是**常量**，整段 UTF-16LE base64 走 `-EncodedCommand`；
- 标题与正文只经**环境变量**传进去，**永远不拼进命令串**；
- 子进程 `stdio: 'ignore'`（受限环境下管道捕获会 `EPERM`，实测）。

## 平台

目前只有 Windows 支持托盘气泡。其它平台插件照常加载，但提醒会记一条「跳过」日志，不会报错。

## 开发

```bash
node --check lib/index.js
node selftest.mjs      # 事件/配置 7 项
node route-test.mjs    # 本地路由 4 项
```

## 许可

MIT
