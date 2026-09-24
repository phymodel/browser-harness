# 架构

## 进程模型

```text
┌─────────────────────┐        ┌──────────────────────────────┐        ┌──────────────────────────┐
│ browserctl (CLI)    │  HTTP  │ daemon (node src/daemon.ts)  │  CDP   │ 内置 Chromium 窗口        │
│ 每次调用 = 一个进程  │ ─────► │ 常驻；持有 Playwright 对象    │ ─────► │ 独立 user-data-dir        │
│ 参数解析 + RPC 客户端 │ ◄───── │ 127.0.0.1:<port>/rpc + token │ ◄───── │ .profile/chromium         │
└─────────────────────┘        └──────────────────────────────┘        └──────────────────────────┘
```

- **CLI 无状态**：不缓存浏览器对象，只读 `.state/daemon.json` 拿到 `port`/`token` 发一次 RPC。
  好处：agent 每次 `run_shell` 都是干净的一发；坏处可忽略（本地回环 RPC 亚毫秒级）。
- **daemon 有状态**：浏览器上下文、标签页、日志/请求环形缓冲、快照计数都在这里，所以跨调用保持。
- **窗口生命周期独立于调用**：CLI 进程退出不会关窗口；窗口被用户手动关掉后，下一条命令会在同一 profile 上
  自动重新拉起窗口（`daemon.log` 会记一行）。

## RPC 协议

```text
GET  /health                     → {ok, pid, port, version, harnessRoot, profile, headless, pages, uptimeMs}
POST /rpc   (x-bh-token: <token>) → {ok:true, result:{…}}
                                    {ok:false, error:{code, message, hint?}}
body: {"cmd":"click","args":{"target":"e8"}}
```

- 仅监听 `127.0.0.1`（可用 `BH_HOST` 改，但不建议）。
- 令牌默认每次启动用 `crypto.randomBytes(24)` 生成，写在 `.state/daemon.json`（权限 `0600`）；
  比较用 `crypto.timingSafeEqual`。`BH_NO_AUTH=1` 可关闭（仅本机调试）。
- 端口默认 `8737`，被占用时依次 `+1 … +20`；真实端口写在 `daemon.json`，CLI 通过 `/health` 的 `pid` 校验
  "这个端口上的确实是我启动的那个 daemon"（避免连到别人的进程）。
- 请求体上限 4MB；`shutdown` 会先回包再退出（CLI 不会看到连接被掐断）。
- 停止方式：`browserctl stop`（RPC `shutdown`）、`SIGTERM/SIGINT/SIGHUP`、`BH_IDLE_TIMEOUT_MS` 空闲超时、
  或未捕获异常（会先尝试关窗口再退出）。退出时删除 `daemon.json`，所以 `status` 能准确区分"没运行"和"崩了"。

## 感知/动作实现

| 环节 | 实现 | 为什么 |
|------|------|--------|
| 感知 | `page.ariaSnapshot({mode:'ai'})`（Playwright ≥1.49 的 AI 版无障碍快照） | 语义化、token 低、自带稳定 `[ref=eN]`、**自动包含 iframe** |
| 结构化 | `page.ariaSnapshotJSON({mode:'ai'})` | `find` 与 `--json` 用；无需自己做 CDP `Accessibility.getFullAXTree` |
| 动作 | `page.locator('aria-ref=eN')` + 常规 Playwright 动作 | 复用 Playwright 的可操作性等待（可见/稳定/可接收事件）与真实输入事件 |
| 回退 | 任何选择器字符串直通 `page.locator(sel)` | 循环、批量、无语义页面 |
| 截图 | `page.screenshot()` → `.state/shots/`，读 PNG 头拿尺寸 | 只落盘，不把像素塞进上下文 |

## 遥测环形缓冲

- `logs`：`console`（含 level）、`pageerror`、`dialog`（策略由 `BH_DIALOG_ACTION` 决定，默认 dismiss 并记录）、
  `download`（落到 `.state/downloads/`）。
- `requests`：默认记录 document/xhr/fetch 与所有 ≥400 的响应，跳过图片/字体/样式/脚本成功项；
  `BH_LOG_ALL_REQUESTS=1` 记录全部。
- 容量 `BH_RING_MAX`（默认 400）条，超出丢最旧。

## 与"控制设备浏览器"方案的区别

| | 本 harness | 连接真实 Chrome（扩展 / CDP） |
|---|---|---|
| 浏览器 | harness 自己拉起并管理的内置 Chromium | 设备上用户正在用的 Chrome |
| profile | 专用 `user-data-dir`，与用户数据隔离 | 用户真实 profile（cookie/登录态） |
| 权限 | 不需要任何授权 | 需要装扩展 / 开调试端口 / 系统自动化授权 |
| 登录态 | 空 profile，需要时在窗口里人工登一次，之后复用 | 直接复用现有登录态 |
| 可移植 | 换机器即用（一次内核下载） | 依赖用户机器上装了 Chrome 且已登录 |
| 风险 | 不碰用户数据 | 可能误操作用户真实账号 |

需要"复用我已登录的浏览器"时，本 harness 的等价做法是：在**内置窗口**里人工登录一次，
登录态就存在 `.profile/chromium/` 里，后续 agent 调用直接复用——仍然不需要任何系统权限。
