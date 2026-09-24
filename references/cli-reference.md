# CLI 参考

所有命令都通过 `scripts/browserctl` 调用（或 `node src/cli.ts`）。加 `--json` 得到机器可读输出；
失败时退出码 `1`，`--json` 下会打印 `{ok:false,error:{code,message,hint}}`。

## 会话

| 命令 | 说明 |
|------|------|
| `start [url]` | 启动守护进程 + 内置窗口；已在运行时**复用**（打印当前状态），`--restart` 才重启 |
| `stop` | 关闭窗口并停止守护进程；记录过期时自动清理 `daemon.json` |
| `restart [url]` | `stop` + `start` |
| `status` | 守护进程 / 窗口 / 当前页面 / 计数 |
| `doctor` | node、playwright 版本、Chromium 路径与是否存在、守护进程状态 |
| `profile` | profile / state / 截图 / 下载 / 日志路径 |

`start` 的额外参数：`--port=N`、`--window-size=1400x900`、`--idle-timeout=秒`、`--headless`、
`--foreground`（在当前进程里跑守护进程，便于看日志）、`--start-timeout=毫秒`。

```bash
browserctl start https://example.com
# ✓ built-in browser window ready
#   pid 52903  port 8737  1 tab(s)
#   profile /Users/me/browser-harness/.profile/chromium
```

## 页面与感知

| 命令 | 关键参数 | 说明 |
|------|---------|------|
| `goto <url>` | `--wait-until`(默认 domcontentloaded)、`--timeout` | 无 scheme 时补 `https://`；`localhost`/IP 补 `http://` |
| `back` / `forward` / `reload` | | 等同于 history 操作 |
| `focus [target]` | | 把窗口提到最前（可选同时聚焦元素） |
| `snapshot` | `--grep=TEXT`、`--depth=N`、`--max-lines=N`、`--boxes`、`--json` | **主感知调用**，见 snapshot-and-refs.md |
| `find <text>` | `--limit=N` | 按 role/name/text 模糊查元素，返回 `ref` |
| `text [target]` | `--max-chars=N` | 可见正文（默认 `body`）；Canvas/图多的页面用它兜底 |
| `html [target]` | `--max-chars=N` | `innerHTML` |
| `screenshot [target]` | `--full`、`--out=FILE` | 落盘 PNG，返回路径/尺寸/字节数。**模型看不到像素** |
| `eval "<js>"` | | 三种写法都支持：表达式 `document.title`、多语句 `const a=1; a+1`、箭头函数 `() => location.href` |

```bash
browserctl find 登录
# 2 match(es) for "登录":
#   [e18] link "登录"
#   [ref-less) button "登录/注册"
```

## 动作（target = `e12` 这种 ref，或任何 Playwright 选择器 `#id` / `.cls` / `text=…` / `xpath=…`）

| 命令 | 关键参数 | 说明 |
|------|---------|------|
| `click <target>` | `--count=2`、`--force`、`--button=right` | 真实鼠标事件 + 可操作性等待 |
| `dblclick <target>` | | 等价 `click --count=2` |
| `hover <target>` | | 触发 hover 菜单 |
| `type <target> <text...>` | `--submit`、`--slow`、`--no-clear` | 点击 → 全选 → 逐字键入（触发自动补全/React 输入），`--submit` 追加 Enter |
| `fill <target> <text...>` | `--submit` | 直接赋值（快，不触发键盘事件） |
| `press <key>` / `press <target> <key>` | | 页面级或元素级按键 |
| `select <target> <value...>` | | 下拉选择，返回实际选中值 |
| `check` / `uncheck` / `toggle <target>` | | 复选框/单选框 |
| `upload <target> <file...>` | | `setInputFiles`，文件必须真实存在 |
| `scroll up\|down\|left\|right\|top\|bottom [px]` / `scroll <target>` | `--amount=N` | 无 target 时滚页，有 target 时滚到可见 |
| `wait [sel \| text=… \| ms \| load\|domcontentloaded\|networkidle]` | `--state=visible\|attached\|hidden`、`--timeout` | 无参数默认等 `networkidle` |

任何动作都返回动作名、target、`ref`、耗时，以及**动作后的页面状态**（url / title / tab / scroll），
所以很多场景不用再单独 `status`。加 `--snapshot` 会在动作后自动追加一次快照。

```bash
browserctl type e4 "alice" --submit --snapshot
browserctl click e8 --json
```

## 标签页

`tabs`（1 基序号，`*` 标记当前）、`newtab [url]`、`switchtab <n>`、`closetab <n>`（默认关最后一个；
关到 0 个会自动开一个空白页）。

## 遥测

| 命令 | 参数 | 说明 |
|------|------|------|
| `logs` | `--limit=N`、`--kind=console\|pageerror\|dialog\|download`、`--level=error\|warn\|info`、`--errors`、`--clear` | 环形缓冲（默认 400 条）。`--errors` = error/warn/pageerror |
| `requests` | `--limit=N`、`--failed`、`--clear` | 默认只记 document/xhr/fetch 与所有 4xx/5xx；`BH_LOG_ALL_REQUESTS=1` 记全部 |
| `downloads` | | `.state/downloads/` 里的文件与大小 |

## 窗口

`window` 读当前 bounds；`--width/--height/--left/--top/--state=maximized|normal|fullscreen` 时写入。

```bash
browserctl window --width 1600 --height 1000
# window 1: 1600x1000 at (22,33) normal
```

## 全局 flag

`--json`、`--timeout=MS`（单次动作超时）、`--snapshot`（动作后补快照）、`--help`。
