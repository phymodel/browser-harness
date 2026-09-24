# 快照格式与引用语义

感知只有一条主通道：**无障碍树（accessibility tree）**。截图只做人工/视觉核验。

## 快照长什么样

`browserctl snapshot` 输出三段：`[PAGE]` 头、`[TREE]` 树、`[STATS]` 统计 + `[HINT]`。

```text
[PAGE] title="Smoke Fixture" url=file:///tmp/fixture.html tab=1/1 viewport=1400x773 scroll=0/0 snap=#3
[TREE]
- generic [active] [ref=e1]:
  - heading "Smoke Fixture" [level=1] [ref=e2]
  - generic [ref=e3]:
    - text: 用户名
    - textbox "用户名" [ref=e4]:
      - /placeholder: name
    - generic [ref=e5]:
      - checkbox "记住我" [checked] [ref=e6]
      - text: 记住我
    - combobox [ref=e7]:
      - option "One" [selected]
      - option "Two"
    - button "提交" [ref=e8]
  - generic [ref=e9]: "-"
[STATS] lines=18/18 refs=9 truncated=no 41ms
[HINT] act with the EXACT ref token printed above (e12, or f2e34 when the app renders inside a frame). Refs are stable inside one document; a new document re-issues them, so re-snapshot instead of reusing an old ref.
```

要点：

- `role "name"` 是语义与可访问名（来自 ARIA / 原生标签 / `aria-label`，不是 CSS 类名）。
- `[ref=eN]` 是可操作句柄；`[level=1]`、`[checked]`、`[disabled]`、`[selected]`、`[active]`、`[cursor=pointer]` 等是状态。
- `- text: …` 是静态文本；`- /placeholder: name`、`- /url: https://…` 是元素的附加属性。
- 缩进表示层级，便于定位"哪个按钮属于哪个表单/对话框"。
- 一个中型页面通常 200–600 行；比整份 HTML 小一个数量级，比截图省得多（且截图对模型不可读）。

## 快照瘦身

| flag | 作用 |
|------|------|
| `--grep=TEXT` | 只保留包含该文本的行**及其祖先链**（用于大页面快速定位） |
| `--depth=N` | 限制树深 |
| `--max-lines=N` | 硬上限（默认 `BH_MAX_LINES=1500`），超出会标注 `truncated=yes` |
| `--boxes` | 在行尾附加 `[box=x,y,w,h]`（需要坐标时用） |
| `--json` | 额外返回 `slots`（结构化 ref/role/name/text/depth）与 `json`（原始 JSON 树） |

```bash
browserctl snapshot --grep 搜索 --max-lines 40
browserctl snapshot --json | jq '.slots[] | select(.ref)'
```

## 引用（ref）语义

1. **作用域**：ref 由 Playwright 的 AI 版 aria snapshot 发放，**在同一 document 内稳定**——连续两次 `snapshot`
   给同一元素发同一个 `eN`；新出现的元素拿新号（不是每次都从 e1 重排）。
2. **跨帧**：当页面把界面渲染在 iframe / 帧里时，ref 会带帧前缀，如 `f2e34`；主文档里的元素不带前缀。
   两种形态都直接可用（`click f2e34`），harness 内部走的是 `aria-ref` 引擎，会自己进帧。
   ⚠️ **不要手写 ref、也不要按 `eN` 的规律猜**：前缀编号会随文档重建而增长（同一个应用从 f1e34 变成 f2e34），
   唯一正确的做法是从最近一次 `snapshot` / `find` 的输出里原样复制那个 token。
3. **失效**：导航、`innerHTML` 重写、元素被移除后，旧 ref 不再指向该元素。此时 harness **不会**兜底猜测：
   - 解析阶段找不到 → `E_STALE_REF`（提示重新 `snapshot`）；
   - 元素存在但动作失败 → `E_ACTION_REF`。
4. **不要手搓 ref**：`e12` 这种编号是发放器给的，猜号只会拿到别的元素或报错。要 ref 就 `snapshot`/`find`。

## ref 还是选择器？

| 场景 | 建议 |
|------|------|
| 常规交互 | 用 ref：与视觉/风格改版无关，不依赖类名 |
| 需要精确批量/循环（如"点开所有结果"） | 用选择器：`click "ul.results li a"`（Playwright 会等到可操作） |
| 页面无稳定语义（Canvas、`div` 汤） | `text` 取正文 + `eval` 取数据；必要时 `screenshot` 给人看 |
| 巨型列表 / 虚拟滚动 | `snapshot --grep` 定位 → ref 点击 → 重复；或 `scroll` + 再快照 |

## 为什么不动像素坐标

坐标点击一次偏移就点错，且窗口尺寸/缩放/滚动一变就全废；无障碍树是语义定位 + 可操作性等待，
确定性高、token 低、跨分辨率稳定。截图只在"人要看一眼"或"UI 无可访问语义"时作为**补充**。
