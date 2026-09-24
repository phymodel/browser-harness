# Browser Harness v0.1

一个**自带浏览器窗口**的智能体浏览器 harness：内置 Chromium（独立 profile，不碰设备浏览器、不需要任何系统权限、不需要装扩展），
感知层**以无障碍树为主、截图按需**，动作层用**稳定引用 `[ref=eN]`** 驱动，控制面是一个本地守护进程 + 一条命令 `browserctl`。

```text
        browserctl <cmd>  (CLI, 由 agent 用 run_shell 调用)
              │  POST 127.0.0.1:<port>/rpc   (带 x-bh-token, 仅监听回环)
              ▼
        daemon (browser-harness/src/daemon.ts, 常驻)
              │  Playwright launchPersistentContext
              ▼
       内置 Chromium 窗口  ── 专用 user-data-dir: <root>/.profile/chromium
              │
              ├─ 感知: page.ariaSnapshot({mode:'ai'})  →  - button "提交" [ref=e8]      ← 主通道（token 低、确定性高）
              └─ 执行: page.locator('aria-ref=e8').click()  ← 真实输入事件 + Playwright 可操作性等待
                  截图: page.screenshot() → .state/shots/*.png（给人看，不给模型看）
```

## 核心原则

> **内置 ≠ 控制设备浏览器。** 内置窗口跑的是 harness 自己管理的 Chromium 进程 + 自己的 user-data-dir；
> 不读用户 Chrome 的 profile、不需要「连接我的 Chrome」扩展、不需要任何自动化/辅助功能授权。
> 代价是首次需要一次性的浏览器内核下载（进入 Playwright 全局缓存，所有 Playwright 项目共享）。

| 原则 | 说明 |
|------|------|
| 无障碍树优先 | 页面感知走 AI 版 aria snapshot：语义角色 + 名称 + 状态 + `[ref=eN]`，一屏通常几百 token；截图只做人工/视觉核验 |
| 引用而非坐标 | 动作针对 `ref`，不是像素坐标；点击/输入由 Playwright 做可操作性检查（可见、稳定、可接收事件） |
| 引用失败必须关闭 | 导航或 DOM 变更后旧 `ref` 直接报 `E_STALE_REF` 并给修复提示，**绝不猜**一个"差不多"的元素 |
| 无状态 CLI | CLI 每次调用都是一次 RPC；浏览器状态活在 daemon 里，跨调用保持（登录态、标签页、滚动位置） |
| 一切都可审计 | 控制台日志 / 页面错误 / 网络请求 / 下载 / 截图全部落盘在 `.state/`，用 `logs`、`requests`、`downloads` 取回 |

## 目录与状态布局

```text
browser-harness/
├── HARNESS.md                 # 本文件
├── README.md
├── package.json               # 无运行时依赖（playwright 动态解析，可为全局安装）
├── src/
│   ├── cli.ts                 # browserctl：参数解析 + RPC 客户端 + 人类可读渲染
│   ├── daemon.ts              # 常驻进程：窗口生命周期 + HTTP JSON-RPC + 令牌鉴权
│   ├── session.ts             # 全部命令实现（快照/查找/动作/标签/遥测/窗口）
│   ├── pw.ts                  # playwright 解析（本地 → npm root -g → 常见全局路径 / BH_PLAYWRIGHT）
│   ├── paths.ts               # 路径与 fs 小工具（根部、state、profile、原子写）
│   └── log.ts                 # stderr + .state/daemon.log
├── scripts/                   # harness 入口（run_shell 直接调）
│   ├── browserctl             # → node src/cli.ts
│   ├── daemon                 # → node src/daemon.ts（前台调试）
│   ├── setup.sh / setup.ts    # 环境自检 + 补装 Chromium
│   └── smoke.sh / smoke.ts    # 隔离端到端自测（28 项断言）
├── references/                # 详细文档（按需读）
└── .state/                    # 运行时产物（git 忽略）
    ├── daemon.json            # pid / port / token（0600）
    ├── daemon.log
    ├── shots/                 # 截图
    └── downloads/             # 页面下载的文件
```

`.profile/chromium/` 是内置浏览器的 user-data-dir（cookie、登录态都在这里，git 忽略）。
需要人工登录一手时，直接在那个窗口里操作即可，agent 之后继续用 `ref` 接管。

## 环境变量

| 变量 | 作用 | 默认 |
|------|------|------|
| `BH_ROOT` | harness 根目录覆盖 | 由 `src/` 位置推导 |
| `BH_STATE_DIR` | 运行时状态目录 | `<root>/.state` |
| `BH_PROFILE_DIR` | 内置浏览器 user-data-dir | `<root>/.profile/chromium` |
| `BH_PORT` / `BH_HOST` | 守护进程监听（占用时自动 +1…+20） | `8737` / `127.0.0.1` |
| `BH_TOKEN` | RPC 令牌（默认每次启动随机生成，写在 `daemon.json`） | 随机 |
| `BH_NO_AUTH` | `1` = 关闭令牌校验（仅本机调试） | 关 |
| `BH_PLAYWRIGHT` | 指定 playwright 安装目录/入口 | 自动解析 |
| `BH_HEADLESS` | `1` = 无窗口（CI 用） | 关（有窗口） |
| `BH_WINDOW_SIZE` / `BH_WINDOW_POSITION` | 窗口尺寸 / 位置，如 `1400x900`、`22+33` | `1400x900` |
| `BH_EXTRA_ARGS` | 追加 Chromium 启动参数（空格分隔） | 空 |
| `BH_TIMEOUT_MS` / `BH_NAV_TIMEOUT_MS` | 动作 / 导航超时 | `15000` / `45000` |
| `BH_MAX_LINES` / `BH_MAX_TEXT` / `BH_MAX_JSON` | 快照行数 / 正文 / eval 返回上限 | `1500` / `20000` / `40000` |
| `BH_RING_MAX` | 日志/请求环形缓冲条数 | `400` |
| `BH_IDLE_TIMEOUT_MS` | 空闲自动关闭守护进程（0 = 常驻） | `0` |
| `BH_DIALOG_ACTION` | 弹窗策略 `dismiss` / `accept` | `dismiss` |
| `BH_LOG_ALL_REQUESTS` | `1` = 连图片/字体/脚本也记进请求环 | 否 |
| `BH_IGNORE_HTTPS_ERRORS` | `1` = 忽略 TLS 错误 | 否 |
| `BH_DEBUG` | `1` = RPC 错误里带 stack | 否 |

## 命令索引（CLI ↔ 内部 RPC）

| 分组 | CLI | RPC cmd |
|------|-----|---------|
| 会话 | `start [url]` / `stop` / `restart` / `status` / `doctor` / `profile` | `shutdown`、`status` |
| 页面 | `goto` / `back` / `forward` / `reload` / `focus` | 同名 |
| 感知 | `snapshot` / `find` / `text` / `html` / `screenshot` / `eval` | 同名 |
| 动作 | `click` / `dblclick` / `hover` / `type` / `fill` / `press` / `select` / `check` / `uncheck` / `toggle` / `upload` / `scroll` / `wait` | 同名 |
| 标签 | `tabs` / `newtab` / `switchtab <n>` / `closetab <n>` | 同名 |
| 遥测 | `logs` / `requests` / `downloads` | 同名 |
| 窗口 | `window [--width/--height/--left/--top/--state]` | `window` |

详见 [references/cli-reference.md](./references/cli-reference.md)；
快照格式与引用语义见 [references/snapshot-and-refs.md](./references/snapshot-and-refs.md)。

## 快速开始

```bash
export BH=/path/to/browser-harness

sh "$BH/scripts/setup.sh"                 # 自检；缺 playwright / Chromium 会给出修复命令
sh "$BH/scripts/smoke.sh"                 # 28 项隔离自测（临时 state + 临时 profile + 独立端口）

sh "$BH/scripts/browserctl" start https://example.com     # 打开内置窗口
sh "$BH/scripts/browserctl" snapshot                      # 无障碍树 + refs ← 主感知调用
sh "$BH/scripts/browserctl" type e12 "hello" --submit      # 按 ref 输入并回车
sh "$BH/scripts/browserctl" logs --errors                  # 控制台 / 页面错误
sh "$BH/scripts/browserctl" screenshot --full              # 落盘 PNG（人工核验）
sh "$BH/scripts/browserctl" stop
```

实测输出（真实站点）：

```text
$ browserctl snapshot --grep searchbox
[PAGE] title="Wikipedia, the free encyclopedia" url=https://en.wikipedia.org/wiki/Main_Page tab=1/1 viewport=1400x773 scroll=0/2650 snap=#1
[TREE]
  - search [ref=e17]:
    - generic [ref=e20]:
      - searchbox "Search Wikipedia" [ref=e23]
      - button "Search" [ref=e25]
[STATS] lines=7/812 refs=1 truncated=yes 187ms

$ browserctl type e23 "Playwright (software)" --submit
✓ type target=e23 ref=e23 21 chars submitted (25ms)
  → https://en.wikipedia.org/wiki/Playwright_(software) tab 1/1
```

## Agent 工作流（推荐）

1. `setup.sh` → `doctor`：确认 `playwrightOk` 与 `chromiumInstalled`。
2. `browserctl start <url>`：一条命令拉起窗口；已运行则复用（`--restart` 才重启）。
3. **每次页面变化后先 `snapshot`**（或 `snapshot --grep=关键词` 压行数），拿 `[ref=eN]`——
   ref 原样复制，可能是 `e12`，也可能是界面渲染在帧里时的 `f2e34`。
4. 动作用 ref：`click e8` / `type e4 "文本" --submit`；一次动作后加 `--snapshot` 可省一次往返。
5. 结果校验优先用低成本通道：`text`（正文）、`logs --errors`（前端报错）、`requests --failed`（接口失败）；
   需要人眼确认时再 `screenshot`（模型看不到像素）。
6. `ref` 报 `E_STALE_REF` ⇒ 立即重新 `snapshot`，不要复用旧 ref。
7. 收尾 `browserctl stop`（或设 `BH_IDLE_TIMEOUT_MS` 让它自己退场）。

## 自测与验证

`scripts/smoke.sh` 在**隔离环境**（临时 `BH_STATE_DIR` / `BH_PROFILE_DIR`、独立端口）跑全链路断言，覆盖：
启动与窗口、a11y 快照与 refs、`find`、ref 输入/点击/勾选/下拉、**iframe 内引用（`f1e2`）**、
旧 ref 失败关闭、截图落盘与尺寸、控制台与网络遥测、`eval` 三种写法、标签页增删切、窗口 bounds、停止。

```text
✓ PASS — 28 passed, 0 failed
```

## 边界与非目标

- **不做反爬/指纹对抗**：这是自动化 harness，不是爬虫对抗工具；遇到验证码/风控请在窗口里人工过一手。
- **不修改设备浏览器**：不装扩展、不改系统设置、不动用户 profile；卸载 harness 即彻底消失（`.state/`、`.profile/`、全局浏览器缓存可选删除）。
- **截图不喂模型**：默认只落盘。若你的客户端支持读图，可自行把 `.state/shots/*.png` 交给模型。
- **下载与上传**：下载落到 `.state/downloads/`；`upload` 只接受真实存在的本地路径。
- **协议**：本地回环 + 随机令牌；`daemon.json` 权限 0600。不要把端口暴露到公网（`BH_HOST` 默认 `127.0.0.1`）。
- **版本**：`node >= 22.6`（直接跑 TypeScript，无构建步骤）、`playwright >= 1.49`（需要 AI 版 aria snapshot 与 `aria-ref` 引擎）。
