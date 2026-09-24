# 排障

## 先跑这两个

```bash
sh scripts/setup.sh      # node / playwright / Chromium
sh scripts/browserctl doctor
sh scripts/browserctl status
tail -50 .state/daemon.log
```

## 错误码与修复

| 错误码 | 含义 | 处理 |
|--------|------|------|
| `E_NO_PLAYWRIGHT` | 找不到 playwright 模块 | `npm i -g playwright`，或 `BH_PLAYWRIGHT=/path/to/playwright` |
| `E_NO_CHROMIUM` | 模块在但没有 `chromium` 导出 | 重装 playwright；确认不是只装了 `playwright-core` |
| `E_NO_DAEMON` | `.state/daemon.json` 不存在 | `browserctl start <url>` |
| `E_DAEMON_DOWN` | daemon.json 在但端口不通 | `browserctl stop`（会清掉过期记录）→ `browserctl start` |
| `E_START_TIMEOUT` | 90s 内没就绪 | 看 `.state/daemon.log`；首次启动可能需要装 Chromium；端口段被占满 |
| `E_STALE_REF` | ref 已失效 | 重新 `browserctl snapshot`，用新 ref；不要复用旧 ref |
| `E_ACTION_REF` | ref 找到了但动作失败（被遮挡/未稳定） | 重新快照；或 `click --force` 跳过可操作性检查；或改用选择器 |
| `E_ACTION` | 一般动作失败（多为选择器写错/元素不存在） | 错误信息会附"当前匹配数"；用 `snapshot` / `find` 确认 |
| `E_SNAPSHOT` | 取不到无障碍树 | 页面可能在导航中；`wait domcontentloaded` 后再试 |
| `E_UNKNOWN_CMD` | 命令名写错 | `browserctl help` |
| `E_AUTH` | RPC 令牌不匹配 | 说明 `.state/daemon.json` 与运行中的 daemon 不一致：`browserctl stop && start` |
| `E_CLOSING` | daemon 正在退出 | 重新 `start` |

## 常见现象

**窗口没出现。** `BH_HEADLESS=1` 会无窗口运行；`browserctl status` 里 `headless` 会告诉你。
另外若机器不在图形会话里（纯 SSH），窗口不会画出来，但自动化仍可用。

**点了没反应 / click 超时。** 元素可能被遮挡或还没稳定。错误信息里会写"当前匹配 N 个元素"：
先 `snapshot --grep=关键词` 看现在的 ref，再决定重试 `click` 还是 `click --force`。
弹窗（alert/confirm）会被默认 dismiss 并记进 `logs`（`kind=dialog`）。

**页面看起来变了但快照还是旧的。** 快照是即时抓取，不是缓存；若确实是 SPA 局部更新，ref 可能仍有效。
真正变化（导航、整块重渲染）后旧 ref 会报 `E_STALE_REF`——这就是设计上的"失败关闭"。

**`type` 没触发前端校验/联想。** `type` 是逐字键盘输入，`fill` 是直接赋值。
框架对 `input` 事件敏感的用 `type`（可加 `--slow`），追求快的用 `fill`。

**端口冲突。** daemon 会自动 +1 到 +20；也可 `browserctl start --port=8800`。
`browserctl start` 会先探测已有实例并复用，误连风险由 `pid` 校验兜住。

**想彻底重置浏览器状态。** `browserctl stop && rm -rf .profile/chromium && browserctl start`（会丢掉登录态）。

**想彻底卸载。** 删掉 harness 目录即可；`.state/`、`.profile/` 随目录消失。
浏览器内核在全局缓存（`~/Library/Caches/ms-playwright`，macOS），可用 `playwright uninstall --all` 清掉 ——
注意那是所有 Playwright 项目共享的缓存。

**CI 里跑。** `BH_HEADLESS=1 BH_STATE_DIR=$(mktemp -d)/state BH_PROFILE_DIR=$(mktemp -d)/profile sh scripts/smoke.sh --headless`。
