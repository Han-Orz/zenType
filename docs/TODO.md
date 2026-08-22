## 当前

### 🟡 v2.6.6 发布准备（v2.6.2 已并入 v2.6.3）
- **背景**：bazaar stage/plugins.json 冻结 `siyuan-zen` 在 v1.0.6（name="ZenType"），v2.0.0 起 plugin.json name 改为 `siyuan-zen` 触发 stage 校验冲突，stage 静默保留旧数据，集市从未更新。
- **方案**：统一改名 `zenType`（repo + plugin.json name + plugins.txt path），两步 PR 重新上架。
- **进度**：
  - [x] 调研根因 + bazaar 校验 / 清理机制
  - [x] PR #1 删旧 path：plugins.txt 移除 `Han-Orz/siyuan-zen`（siyuan-note/bazaar#1894，等合并）
  - [x] 本仓库改名（plugin.json name/url/version→`zenType`, `zh_CN`→`zh-CN`, `make_dev_link.js`, README）
  - [x] GitHub repo 改名 `siyuan-zen` → `zenType`
  - [x] 发 v2.6.3 release（v2.6.2 → v2.6.3 间累积重构：cursor 模块拆分、lifecycle 工具、popover 观察者自清理；用户行为不变），见 `1b9a832` + tag `v2.6.3`
  - [x] 发 v2.6.4 release（修复集市包缺少 README；用户行为不变）
  - [x] 发 v2.6.5 release（修复非空块尾部光标回退定位）
  - [x] PR #2 加新 path：plugins.txt 已包含 `Han-Orz/zenType`
  - [x] 定位 v2.6.5 Stage 失败：`preview.png` 205.3KB 超过当前 200KB 上限
  - [x] v2.6.6 本地发布准备：版本同步、预览图压缩、`pnpm run build` 默认生成 `package.zip`
  - [ ] 提交并发布 v2.6.6 Release，上传新 `package.zip`
  - [ ] 等待 Bazaar Stage 自动收录并关闭 `siyuan-note/bazaar#2152`
- **本仓库侧**v2.6.6 代码、文档和构建流程已进入发布校验阶段。

### 🟢 文档清洁 + 发布前同步（v2.6.1 收尾）
- [x] 统一本次触及文件为 UTF-8 + LF 行尾，并新增 `.gitattributes` 固定 LF
- README / README_zh-CN 同步 v2.6.1 行为：
  - 默认配置下，加载时初始化共享状态为 ON（cursor、typewriter、ripple 默认配置均开启）
  - 新增 `CLICK_CENTER_LOW` / `CLICK_CENTER_HIGH` / `TYPING_GAP_MS` / `COMFORT_ZONE` / `SCROLL_DURATION_TIERS` / `SCROLL_CURVE` / `SENTENCE_DIM_ALPHA` / `TRANSITION_SEC` / `WEIGHT_MIN` / `MIN_SCALE` / `EDGE_ARROW.ENABLED` 等配置项
  - "Edge Cases" 补 IME 防护 + Enter/Backspace 居中区分

### 🟢 BUG 修复（v2.6.1 收尾）

#### BUG #1：ripple 句级高亮在 SiYuan block 重渲染后失效
- **状态**：本地已修复；基础 Markdown 解析路径已观察正常，`#标签` 路径已追加当前块 DOM mutation 兜底，待最终思源实测确认。
- **复现路径**：敲 `**` + 字符 + 空格，或输入 `#标签` 触发 SiYuan inline tokenizer 重渲染当前 block。
- **根因结论**：
  - 原短路条件只看 `text === lastDimText` + 首个旧 text node 仍在 block 内。
  - 调试日志显示 SiYuan 可出现 `sameText=true`、首 text node 未变、但后续 text node 已替换的情况；CSS Highlight Range 仍引用旧节点时会失效。
  - 仅检查 `textNodeMap[0].node` / `isConnected` 不够，因为重渲染不一定替换首节点。
  - 早期把 `textNodesUnchanged` 放进 `canAnimate` 会导致持续输入第二句时旧当前句不走动画；该错误路径已清理。
- **当前修复**：
  - 缓存完整 text node snapshot（node 引用 + len），只在 snapshot 未变时允许同句短路。
  - `canAnimate` 改为基于上一句 range 是否仍存在，不再依赖 DOM 节点完全不变，避免第二句动画回归。
  - `input` 时立即刷新一次，并保留 rAF 刷新，减少 tokenizer 重渲染后的空窗。
  - 新增只监听 `childList` / `characterData` 的当前块 mutation 兜底，覆盖 `#标签` 这类 input/selectionchange 之后的二次重渲染。
- **性能判断**：当前块级别开销，mutation 回调有 focusActive + 当前块过滤，不监听 attributes，不会被本模块写 opacity/transition 自触发；可接受。

#### BUG #2：cursor transition 每帧重写字符串的微优化
- **状态**：已实施低风险版 `lastCursorDur`；未改 CSS 变量方案。
- **判断**：CSS 变量方案理论上更干净，但实际收益很小，还会引入样式契约和首次变量写入时机问题；本次只缓存 `dur`，距离档位不变时跳过 `style.transition` 字符串重写。
- **当前修复**：
  - `lastCursorDur` 记录上次 transition duration。
  - 仅当 `dur !== lastCursorDur` 时重写 `cursorEl.style.transition`。
  - `cursorEl.style.opacity = ""` 也加空值判断，避免每帧重复删除 inline opacity。
  - `destroyCursor()` 重置 `lastCursorDur`。
- **性能判断**：这是微优化，主要减少无意义 style 字符串解析和属性写入；体感差异预计很小，但风险低。

---

## 已完成

### ✅ 性能热点收敛（v2.6.2）
- **Typewriter FLIP**：Enter / Backspace 块位移动画正常路径不再扫描整个编辑器；改为围绕当前选区起止块采样前后 sibling 窗口，并沿祖先层级采样，异常选择区容器仍保留全量 fallback，降低长文档下的 `getBoundingClientRect()` 数量。
- **Ripple MutationObserver**：不再监听整个 `document.body`；focus active 时监听当前顶层块 subtree，并监听父容器一层 `childList` 捕获整块替换，刷新复用 rAF 队列。

### ✅ 顶栏银河图标位置微调
- **状态**：已完成；用户已通过 SVG 属性平移把图标移动到正确位置。
- **结论**：SVG 内部 `translate(x y)` 使用 `viewBox` 用户单位，不是屏幕像素。银河图标 `viewBox="0 0 1024 1024"`、渲染尺寸 24px 时，`translate(2 -2)` 只有约 0.047px，肉眼不可见。
- **实测经验**：需要按 `viewBox` 与渲染尺寸换算；例如 24px 尺寸下，`128` 个 viewBox 单位约等于 3px。

### ✅ 文档清洁 + 发布前同步（v2.6.1）
- 统一本次触及文件为 UTF-8 + LF 行尾，并新增 `.gitattributes` 固定 LF
- README / README_zh-CN 同步 v2.6.1 行为：
  - 默认配置下，加载时初始化共享状态为 ON（cursor、typewriter、ripple 默认配置均开启）
  - 新增 `CLICK_CENTER_LOW` / `CLICK_CENTER_HIGH` / `TYPING_GAP_MS` / `COMFORT_ZONE` / `SCROLL_DURATION_TIERS` / `SCROLL_CURVE` / `SENTENCE_DIM_ALPHA` / `TRANSITION_SEC` / `WEIGHT_MIN` / `MIN_SCALE` / `EDGE_ARROW.ENABLED` 等配置项
  - "Edge Cases" 补 IME 防护 + Enter/Backspace 居中区分

### ✅ ripple 句级高亮在 SiYuan block 重渲染后失效（v2.6.1）
- **状态**：已修复；基础 Markdown 解析路径已观察正常，`#标签` 路径已追加当前块 DOM mutation 兜底。
- **复现路径**：敲 `**` + 字符 + 空格，或输入 `#标签` 触发 SiYuan inline tokenizer 重渲染当前 block。
- **根因结论**：
  - 原短路条件只看 `text === lastDimText` + 首个旧 text node 仍在 block 内。
  - 调试日志显示 SiYuan 可出现 `sameText=true`、首 text node 未变、但后续 text node 已替换的情况；CSS Highlight Range 仍引用旧节点时会失效。
  - 仅检查 `textNodeMap[0].node` / `isConnected` 不够，因为重渲染不一定替换首节点。
  - 早期把 `textNodesUnchanged` 放进 `canAnimate` 会导致持续输入第二句时旧当前句不走动画；该错误路径已清理。
- **修复**：
  - 缓存完整 text node snapshot（node 引用 + len），只在 snapshot 未变时允许同句短路。
  - `canAnimate` 改为基于上一句 range 是否仍存在，不再依赖 DOM 节点完全不变，避免第二句动画回归。
  - `input` 时立即刷新一次，并保留 rAF 刷新，减少 tokenizer 重渲染后的空窗。
  - 新增只监听 `childList` / `characterData` 的当前块 mutation 兜底，覆盖 `#标签` 这类 input/selectionchange 之后的二次重渲染。

### ✅ cursor transition 每帧重写字符串的微优化（v2.6.1）
- **状态**：已实施低风险版 `lastCursorDur`；未改 CSS 变量方案。
- **判断**：CSS 变量方案理论上更干净，但实际收益很小，还会引入样式契约和首次变量写入时机问题；本次只缓存 `dur`，距离档位不变时跳过 `style.transition` 字符串重写。
- **修复**：
  - `lastCursorDur` 记录上次 transition duration。
  - 仅当 `dur !== lastCursorDur` 时重写 `cursorEl.style.transition`。
  - `cursorEl.style.opacity = ""` 也加空值判断，避免每帧重复删除 inline opacity。
  - `destroyCursor()` 重置 `lastCursorDur`。
- **性能判断**：这是微优化，主要减少无意义 style 字符串解析和属性写入；体感差异预计很小，但风险低。

### ✅ Neo / Neo-Plus 主题下切换标签页后顺滑光标上移
- **状态**：已完成；已改为通过 SiYuan 内部 `EventBus.switch-protyle` 统一处理，默认主题和带进入动画的主题都走同一条“隐藏 - 稳定 - 淡入”路径。
- **现象**：
  - 切换标签页后，顺滑光标会相对当前行略微上移或偏移。
  - 许多主题的标签页 / 内容切换动画会让 selection / Range 的目标坐标在切换后继续变化。
  - 之前已经排除了 `line-height` / `getCursorRect` 公式本身的问题，根因不在这两个计算上。
- **最终修复**：
  - 通过 SiYuan 内部 `EventBus` 的 `switch-protyle` 触发切换处理。
  - 切换时先隐藏旧位置光标，短窗口内等待目标坐标稳定。
  - 坐标稳定后在新位置无过渡定位，再淡入显示。
  - 修复旧配置 `cursor=false` 会阻断 `EventBus` 回调的问题；当前在 cursor 常开时强制 `enabled.cursor=true`，确保切换流程可执行。
  - 清理了无用的 CSS 动画 / `transition` 检测代码，因为默认主题也接受隐藏淡入，统一走 `switch-protyle` 隐藏稳定淡入路径。
- **修复结果**：
  - 切换标签页后，光标不再因为主题动画或切换过渡而停在偏上的旧坐标。
  - 默认主题、Neo、Neo-Plus 及其他带过渡动画的主题都使用同一套稳定定位流程。
  - 不再依赖主题的 `animationend` 或 CSS 动画状态判断，兼容面更稳定。

### ✅ 撰写详尽的项目设计文档
- `docs/DESIGN.md` 覆盖：模块依赖图、状态机、关键算法（FLIP / Highlight / 边界检测）、配置项、决策记录、已知限制
- 面向"编辑小白也能定位问题"的目标，按模块 + 决策时间线组织

### ✅ 聚焦模式句级 dim 切换动画（v2.6.1）
- 验证结论：不改 `Range + CSS Custom Highlight API` 架构也能做句级动画；多 highlight 名称承载稳定 dim、fade-in、fade-out 三层
- 实现：旧当前句 `zt-sentence-fade-out` 从原文字色插值到 dim 色；新当前句 `zt-sentence-fade-in` 从 dim 色插值到原文字色；`requestAnimationFrame + easeInOutCubic` 驱动颜色插值
- 当前句稳定态偏淡根因：当前块原先会乘 `visualWeightOf`，当块在视窗边缘时整体 opacity 小于 1；已改为 `distance === 0` 强制 `1.0`

### ✅ 聚焦模式嵌套列表透明度叠加 bug（v2.6.1, commit f121839）
- 嵌套列表出现透明度×透明度叠加（父块 opacity × 子块 opacity → 几乎不可见）
- 退出聚焦模式（wheel/arrow/click）和关闭插件（destroyRipple）均无法恢复透明度
- 根因：v2.6.0 的 `isConnected` 检查 + P0-3 缓存导致清理不可靠，断开/脱离追踪的块残留 opacity
- 修复：移除三处 `isConnected` 检查；普通退出清理已追踪块，`destroyRipple` 用 `querySelectorAll` 做全局兜底；清 `--zt-sentence-dim-color` CSS 变量

### ✅ 打字机模式的滚动问题（v2.6.1, commit f121839）
- 首字不滚动：vertical-jump defer 内部清 `lastCheckRect=null` + keydown 加 `setBothOn` 修复
- 连续键入不滚动 / 空隙滚动：input 监听维护 `lastInputAt`，debounce gate（`TYPING_GAP_MS=400`），首字 `firstCharAfterIdle` 立即滚
- 滚动拖 IME 候选窗一卡一卡：`compositionstart` / `compositionend` 监听 + `composing` 门禁，compositionstart 取消 in-flight smoothScroll
- Enter / Backspace 立即重新对齐舒适区；click 居中（Option B `[0.25, 0.75]`，缓起缓收 + 加长 40%）
