# Changelog

## v2.6.5 (2026-08-21) — Non-empty Block Caret Fallback

修复输入过程中按方向键下时光标视觉位置与实际输入位置不一致的问题。

### Fixed
- **非空块尾部光标定位**：当 Selection 落在没有可渲染矩形的空 Text 节点中时，为非空块回退到相邻真实文本节点的边界 Range；真正的空块继续使用块顶部定位，避免按 ArrowDown 后光标看似跳到块首、继续输入却跳回块尾。

---

## v2.6.4 (2026-07-27) — Bazaar Package Documentation

修复集市包构建流程：将中英文 README 一并打入 `package.zip`，与 `plugin.json` 的 `readme` 声明保持一致。

### Fixed
- **集市包文档**：发布包现在包含根目录 `README.md` 和 `README_zh-CN.md`。

---

## v2.6.3 (2026-07-05) — Cursor Submodule Split + Lifecycle Utility（稳定版）

项目进入稳定期后的内部清理小版本，对用户行为基本无影响：拆 cursor、统一延迟帧追踪、修潜在 popover 观察者残留。

### Added
- **`src/utils/lifecycle.ts`** — `requestDeferredFrame()` / `runLifecycleSteps()`：集中管理延迟帧（`requestAnimationFrame`）与生命周期步骤隔离（任一步抛错不影响后续），被 cursor（inputMode 触发、switchSettle reveal）、typewriter（click 居中、destroy 取消挂起帧）、ripple（popover 观察者自清理）等模块统一使用

### Changed
- **Cursor 模块拆分**：`src/modules/cursor.ts` 576 行 → `events.ts`（111）/ `popoverDrag.ts`（92）/ `resizeBindings.ts`（62）/ `scrollBindings.ts`（80）/ `switchSettle.ts`（127）/ `edgeArrow.ts`（92）六个聚焦子模块 + 集中 `src/modules/inputModeTriggers.ts`（63）；外部导入面（`cursor.ts` 主入口）不变
- **popover 拖动观察者自清理**：弹窗脱离 DOM 时自动拆绑；修复"旧弹窗关闭后绑定残留阻塞新弹窗"
- **ripple 块级 opacity 缓存按容器隔离**：`isSameBlockOpacityCacheTarget` 同时校验顶层容器 ID，避免跨块串台
- **siyuan 依赖锁版**：`devDeps` `siyuan: "^1.2.1"`；仓库行尾统一 LF；lockfile 收敛为 `pnpm-lock.yaml` 单一来源（移除 2421 行 `package-lock.json`）
- **文档**：`docs/DESIGN.md` + `docs/BROOKS_SWEEP_REPORT.md` 与当前架构同步；新增 `docs/superpowers/plans/2026-07-05-architecture-refactor-roadmap.md` 与 `2026-07-05-characterization-tests-proposal.md`（本次拆分工作的规划记录）
- **版本号**：`package.json` / `plugin.json` 2.6.2 → 2.6.3

### Removed
- `tests/` 目录（Node 测试运行器 + 7 个 lifecycle 集成测试 + siyuan 桩模块），项目稳定后迁移至参考文件夹；`package.json` 同步移除 `"test": "node tests/run.mjs"` 脚本

---

## v2.6.2 (2026-07-05) — Cursor Switch Polish + Focus Performance

### Added
- **顶栏银河图标**：替换原单圆环图标，开启态带星球旋转动画，并支持 `prefers-reduced-motion`。
- **切换标签页稳定淡入**：`switch-protyle` 时先隐藏旧位置光标，等待新坐标稳定后再无跳动淡入，减少主题切换动画导致的光标偏移。

### Changed
- **Typewriter FLIP 采样优化**：Enter / Backspace 块位移动画从全编辑器 `[data-node-id]` 扫描改为当前块起止位置附近 sibling + 祖先层级窗口，降低长文档下的布局读取量。
- **Ripple MutationObserver 缩域**：不再监听整个 `document.body`；仅在 focus active 时监听当前顶层块 subtree，并监听父容器一层 `childList` 捕获整块替换，mutation 刷新复用 rAF 队列。
- **cursor 常开兼容**：加载旧存储时强制 `enabled.cursor = true`，避免历史 `cursor=false` 阻断 cursor EventBus 回调。
- **版本号**：`package.json` / `plugin.json` 2.6.1 → 2.6.2。

---

## v2.6.1 (2026-07-03) — Typewriter Scroll Bugs + Ripple Opacity 残留修复

### Fixed
- **3a 首字不滚**：恢复 vertical-jump defer，defer 内清 `lastCheckRect=null` 让 deferred check 通过 equality check（根因：点击→`setBothOff` 使空块守卫未运行，`lastCheckRect` 保留陈旧 Y，首字被 defer 后又被 equality check 吞掉）
- **3b 连续键入不滚**：加 `input` 监听 + debounce gate（`TYPING_GAP_MS=400`），实现"连续键入不滚动，空隙时滚动"；空闲后首字立即滚（Option i `firstCharAfterIdle`）
- **3c IME 候选框卡顿**：加 `compositionstart`/`compositionend` 监听 + `composing` 门禁；compositionstart 取消 in-flight smoothScroll，避免 per-frame scrollTop 拖动 IME 候选框
- **Enter 不滚**：keydown handler 主动 `setBothOn()`（根因：SiYuan Enter preventDefault → 无 input 事件 → `typewriterActive` 不重置 → `checkAndScroll` 早退）
- **弹跳回归**：恢复 defer 防 t≈16ms selectionchange 路径的瞬态 Y 滚动
- **Ripple opacity 残留**：移除 `isConnected` 检查（detached 块漏清根因）；`clearAll`/`destroyRipple` 加 `querySelectorAll` 兜底清理；`clearAll` 清 `--zt-sentence-dim-color` CSS 变量

### Added
- **click 居中**（Option B）：仅当 caret 超出 `[0.25, 0.75]` 时主动居中，`easeInOutCubic` + 加长 40%
- **Enter/Backspace 区分**：Enter 绕空块守卫 + 立即滚；Backspace 块合并立即滚，字符删除走 debounce
- `TYPEWRITER_CONFIG.TYPING_GAP_MS` / `CLICK_CENTER_LOW` / `CLICK_CENTER_HIGH` 配置项

### Changed
- `input` handler 用 `InputEvent.inputType` 区分 insert/delete（Backspace delete 不绕过 debounce）
- `SENTENCE_DIM_ALPHA` 0.7→0.6

### Removed
- `pendingScrollTarget` 死变量（retargeting 设计未实现，`isScrolling()` 门禁丢弃新请求）
- `splitSentencesWithQuotes` 注释代码（22 行，标注"未启用"）

---

## v2.6.0 (2026-07-03) — Ripple Performance Optimization + Config Refactor

### Added
- **块级 opacity 缓存**（P0-3）：同一顶层块 + 无滚动 + 无块增删时跳过整个 `applyBlockOpacity`，减少 DOM 读
- **句级 dim 颜色 CSS 变量**：仅在 OFF→ON 或主题切换时设置 `--zt-sentence-dim-color`，避免每帧重写
- **块级 opacity 过渡动画**：`transition: opacity ${TRANSITION_SEC}s ease`（默认 0.4s）
- **`SENTENCE_DIM_ALPHA` 配置**：句级 dimming alpha 值（默认 0.7），替代硬编码
- **`TRANSITION_SEC` 配置**：块级过渡时长（默认 0.4s）
- **句级 same-sentence 短路缓存**：光标同句内移动跳过 Range/Highlight 重建

### Changed
- **RIPPLE_CONFIG 重构**：`SENTENCE_LEVELS` → `BLOCK_LEVELS`（新值 `[1.0, 0.4, 0.2, 0.15, 0.1, 0.05]`，参考 Obsidian focus）；`EMBED_MULTIPLIER`/`DEPTH_FACTOR` 移除
- **`buildTextNodeMap` + `resolveTextNodeAt`**：单次 TreeWalker + 二分查找替代线性扫描，复杂度 `O(S*T)` → `O(T + S log T)`
- **嵌套块 opacity 修复**：只设顶层块 opacity，嵌套块继承父级，避免叠加（父 0.5 × 子 0.5 = 0.25）
- **远块跳过**：`distance ≥ 2` 的块跳过 `getBoundingClientRect`，weightFactor 直接取 1.0
- **句子分割正则增强**：加省略号 `…` 支持 + 小数点保护 `(?<!\d)`
- **版本号**：`package.json`/`plugin.json` 2.5.0 → 2.6.0

### Removed
- `isRippleTargetBlock`/`depthOf`/`RIPPLE_TARGET_BLOCK_TYPES`/`RIPPLE_SKIP_BLOCK_TYPES`/`RIPPLE_SKIP_SELECTORS` 死代码
- `SENTENCE_LEVELS`/`EMBED_MULTIPLIER`/`DEPTH_FACTOR` 配置项

---

## v2.5.0 (2026-07-03) — Ripple CSS Custom Highlight API Rewrite

### Added
- **CSS Custom Highlight API**：涟漪句级 dimming 从 span 包裹重写为 `CSS.highlights.set()` + `::highlight()`，零 DOM 突变
- **数据丢失 BUG 修复**：旧 `extractContents()`+`insertNode(span)` 分裂文本节点破坏 SiYuan selection 语义 → 光标飘走 → 内容删除。Highlight API 不修改 DOM，彻底消除冲突
- **inputMode 订阅**：ripple 订阅 `focusActive→false` 时 `clearAll()`，修复 wheel/blur/click 后 opacity 残留（P1-1）
- **self-heal**：SiYuan `outerHTML` 交换使 Range 失效后，下次 `selectionchange` 自动用新文本节点重建

### Changed
- **Ripple 模块简化**：463 → 265 行。仅 `selectionchange` 事件 + inputMode 订阅
- **`--zt-sentence-dim-color`**：`::highlight` 不支持 opacity，用 `color: rgba()` 模拟（浅色 `rgba(0,0,0,0.88)` / 深色 `rgba(255,255,255,0.88)`）

### Removed
- span 包裹方案（`getSentences`/`wrapTextRange`/`wrapSentenceIntoHighlightSpan`）
- `ripple.recompute` 导出（selectionchange 自动重算，无需显式调用）
- mouse 模式代码（`onMouseMove`/`MOUSE_THROTTLE`/`IDLE_THRESHOLD`）
- `isEmbedBlock` 函数 + `EMBED_MULTIPLIER` 乘数应用（config 保留作文档）

### Code Review Fixes
- P1-1: ripple opacity 残留（wheel/blur/click 后）
- P2-3: smoothScroll 死合并路径
- P2-5: 死 `isEmbedBlock` + `EMBED_MULTIPLIER` 代码
- P3-7: FLIP 过渡 style 在被跳过元素上残留
- P3-8: 非 ripple-target 的 currentBlock opacity=1 泄漏

---

## v2.3.0 (2026-06-30) — Typewriter Range + Block Insertion + Ripple Sentence

### Added
- **打字机舒适区间** `TYPEWRITER_CONFIG.COMFORT_ZONE = [0.38, 0.50]` —— 38%-50% 区间内不触发滚动，避免累积漂移带来的跳跃感
- **smoothScroll 曲线原语** —— 重构为 `smoothScroll(el, {deltaY, duration, curve})`，方向由调用方算
- **块级插入动画**（Enter / 行首 Backspace / 多行粘贴）—— `markBlockInsertPending` + `animateNaturalReflow` FLIP 技术，参考 cursor.ts round 4 fix 模式
- **动画曲线配置** `TYPEWRITER_CONFIG.SCROLL_CURVE = 'cubic-bezier(0.25, 0.1, 0.25, 1)'` —— 与光标一致
- **距离分档时长移到 config** `TYPEWRITER_CONFIG.SCROLL_DURATION_TIERS = [180, 260, 360, 480, 600]`（用户可调）
- **涟漪句级 opacity 梯度** `RIPPLE_CONFIG.SENTENCE_LEVELS = [1.0, 0.88, 0.72, 0.55, 0.42]` —— 按 `.?!` 切句，当前句强制 1.0
- **嵌入块修正** `RIPPLE_CONFIG.EMBED_MULTIPLIER = 0.85`
- **列表块动态算法**（Q5 = C）—— `visualWeightOf` × `depthOf` × `depthFactor`，视觉权重匹配人眼感知
- **涟漪重新计算接口** `ripple.recompute(focusBlock)` —— 块级插入后由 typewriter §3.7 调用
- **顶栏图标重设计** —— 单圆环 + `feGaussianBlur` 雾边（stdDeviation=0.4）+ breathe 动画（3s ease-in-out infinite），hover 时停止呼吸
- **文档** `docs/DESIGN.md`（合并 7 个过时 doc）+ `docs/DESIGN_v2.3.0_delta.md`（v2.3.0 行为变化 / bug 修复 / 回归场景）

### Fixed
- **wheel / touchmove 退出 typewriter/focus 不生效** —— `cursor.ts:589-590` 的 `onWheelExit` 加 `{ capture: true }`（与 keydown/scroll/input 一致，commit `7a368db`）。原本早期设计就是带 capture 的（`docs/archive/plans/cursor-optimization-plan.md:607`），但 v2.2.0 focus-mode 重构时 capture 被无意遗漏——本次回归修复。

### Changed
- `smoothScroll(target, deltaY)` → `smoothScroll(target, {deltaY, duration, curve})`
- `durationForDistance()` 函数 → 读 config 表
- typewriter 滚动主循环：固定 38% → 区间 [38%, 50%]
- ripple 主循环：块级 + 视觉权重 + 深度系数 + 嵌入块修正
- 顶栏图标 SVG：笔形 → 单圆环 + 雾边

### 已知 TODO
- **区分不同的块类型**（嵌入网页 / 嵌入笔记 / PDF / video / 代码块 / HTML 块各不同）
- **视觉权重"理想值"标定**（不同窗口大小 / 字号下重新测试）
- **句级切分边界**（中英文标点混合 / `...` / `?!` 组合）

详见 `docs/DESIGN_v2.3.0_delta.md`。

---

## v2.3.1 (2026-07-02) — Code Review Fixes

### Fixed
- **typewriter rAF 合并器绕过** —— 垂直跳变检测改用 `scheduleCheck()` 代替 `requestAnimationFrame`，归入 `pendingCheck` 合并器，避免多帧排队
- **typewriter `cachedContainer` DOM 脱离** —— 缓存命中条件新增 `isConnected` 检查，主题切换 / tab 切换时自动重算容器
- **ZWSP-only 空块守卫** —— `isEmptyBlock` 归一化 `\u200B` / `\uFEFF` / `\u00A0` 等零宽字符
- **`prevCursorY!` 非空断言** —— 改为 `prevCursorX !== null && prevCursorY !== null` 双重检查
- **`isScrolling` 全局变量 → getter 去竞态** —— 移除独立 `isScrolling` 布尔和 100ms 延迟置 false 的定时器，改用 `pendingScroll !== null` 推断动画状态，消除 `checkAndScroll` 在动画结束到定时器触发间的竞态窗口（P1）
- **`boundary.ts` 嵌套回退路径 dead code** —— `isInScroll && isInEditor` 恒为 false（因为进入此分支时 `isInEditor` 恒为 false），改为仅基于 `isInScroll` 判定，使嵌套滚动容器内的光标能正常显示（P1）
- **`animateBlockShift` FLIP 防重入** —— 引入 `activeFLIPTimer` 跟踪当前 cleanup 定时器，新调用时取消前一轮，防止连续 Enter 时覆盖 transform 后又被旧 cleanup 清空（P2）
- **`bindScrollContainerEvents` 滚动容器泄漏修复** —— 新增已绑定容器的残留清理逻辑：将当前祖先链与 `scrollEventBindings` 对比，移除不再属于祖先链的容器和 handler（P2）
- **`popoverDragBinding` 陈旧绑定修复** —— 弹窗关闭后绑定残留导致新弹窗无法重新绑定；新增 `isConnected` 检测，旧弹窗脱离时自动拆绑（P2）
- **标题区域 typewriter 支持** —— `boundary.ts` 返回 `.protyle-title__input` 时附带最近的 `.protyle-content` rect 作为 `editorRect`，使 typewriter 对标题区域生效（P2）
- **`visualWeightOf` 性能优化** —— 接受可选的 `cachedEditorRect` 参数，避免每块两次 `getBoundingClientRect`（200 块场景从 400 次降为 1+N 次 DOM 读）（P3）
- **`applyRipple` 防排队** —— 引入 `rippleInProgress` 标志，与 `pendingFrame` 独立，防止 `getSentences` 在长段落上排队累积（P3）

### Changed
- **移除 typewriter debug 埋点** —— 删除 `dbg.setField` / `dbg.push` / `if (dbg.isEnabled())` 全部调用、`Debug` import 与 `src/utils/debug.ts`（无其他消费者）；改为按需提供控制台片段调试
- **移除 inputMode 死代码** —— 删除从未被调用的 5 个导出（`simulateFocusInput` / `simulateTypewriterInput` / `disableFocus` / `disableTypewriter` / `isEitherActive`，4 命令重构遗留）
- **删除实验性 typewriter 变体** —— `typewriter-a/b/c.ts` 三个未跟踪、未导入、未提交的副本

### 已知 TODO（待定）
- **`isScrolling` cooldown 移除的回归风险** —— 100ms cooldown 已移除，maxScroll 边界连续打字可能触发空转 rAF；待用户复现后决定是否加 clamp 检测短路或最小 cooldown

---

## v2.2.1 (2026-06-30) — Cursor Edge-Fade Fixes + Typewriter Rewrite

Branch: `fix/v2.2.0-cursor-optimization`（8 commits ahead of v2.2.0，尚未发 release）

### Fixed
- **TODO-1**: 插件加载时 cursor 从 (0,0) "whoosh" 到实际位置 → `createCursorElement` 在元素进 DOM 那一刻即加 `.no-transition`，首次 doUpdateCursor 写完真实位置后下一帧移除（`ba0bcea`）
- **TODO-2**: 边缘箭头指示器默认关闭 → `EDGE_ARROW.ENABLED: false` + 包裹箭头 if/else 块（`84193de`）
- **TODO-3**: 边缘定义太宽（60px 触发太早）→ `EDGE_FADE.ZONE: 60 → 30`，后续用户手动收到 20（`924c337`）
- **TODO-4**: 滚出顶部和底部动画不对称 → 把 squish/bounce 触发块提到边界早退前 + `!isOuterElement` 守门（`c168586`）
- **isReadMode 只读文档 / 标题修复**（`2808caa`）—— 检查 `cursor.isContentEditable` 而非 `.protyle-content.isContentEditable`，兼容思源"标题锁"模式

### Changed
- **顶部/底部边缘对齐到 editor rect**（`1ea9891`）—— 之前 `getEdgeProximity` 用 viewport 边、`isInAllowElements` 用 protyle-content rect（约 y=55），两套坐标系错位导致顶部永远进不了淡出区看着瞬切。现在 `getEdgeProximity(rect, editorRect?)` 接受可选 editor rect，顶部/底部对称淡出。
- **返回方向 instant jump 修复**（同 commit `1ea9891`）—— 新增 `wasOffScreen` 状态，case C 首帧 force-remove `.no-transition` + reflow，让回屏第一帧 opacity 也走 transition。
- **squish/bounce 动画下线**（`0ee73ed`）—— 用户测试反馈 scale 动画"显得像弹弓"，删除所有 scale 关键帧 + 触发函数 + `wasOffScreen`/`squishAnimTimer` state。
- **Q7 距离→时长**（`0ee73ed`）—— 从内联 `dist/1500` 公式搬到 `config.TRANSITION.TIERS` 分档表（用户已手动调到 `0.07/0.15/0.21/0.30`）。
- **(0,0) 跳修复**（`282a964`）—— SCSS keyframes 改用独立 `scale:` 属性（CSS Transform Module Level 2），不再覆盖 inline `transform: translate3d(x, y, 0)`。

### Typewriter Rewrite（v2.2.1 commits `fcfbf95` / `2f9c39a` / `1229f45` / `9fd31c2`）
- **使用 cursor 的 `isInAllowElements` 选择器**（`fcfbf95`）—— typewriter.ts 复用 cursor 模块已验证的 `.protyle:not(.fn__none) .protyle-content`，分屏正确
- **滚动锚点用 `editorRect` 而非裸 container rect**（`fcfbf95`）—— 祖先元素可能更大导致算错位置
- **rAF debounce `scheduleCheck`**（`fcfbf95`）—— 一次按键触发 4-5 个事件合并为 1 次 `checkAndScroll`
- **container 缓存 `cachedContainer`**（`fcfbf95`）—— 避免每次 DOM 遍历找滚动祖先
- **动画续接**（`fcfbf95`）—— 同一 target 追加 deltaY，连续输入不卡顿重启动画
- **距离分档时长**（`fcfbf95`）—— `180/260/360/480/600ms` 五档（v2.3.0 移到 config）
- **smoothScroll 改用 scrollable ancestor**（`2f9c39a`）—— 不再用 `getEditorContainer()`，找最近的滚动祖先
- **删除高亮条 DOM/CSS**（`1229f45`，Q1 永久下线）—— 用户偏好"纯滚动"，入口保留 `TYPEWRITER_HIGHLIGHT_RESERVED` 注释块
- **同步 typewriter 修复计划文档**（`9fd31c2`）—— 漂移后重新对齐

### Dev workflow
- 改用 `scripts/make_dev_link.js` 建 junction，`D:\SiYuan\data\plugins\siyuan-zen` → `dev/`，配合 `pnpm run dev` watch 实现"保存即热重载"。不再使用 `npx make-install` 硬同步（siyuan-plugin-cli 已从 devDependencies 移除）。

### Cleanup
- 删除 dead state `wasOffScreen` / `squishAnimTimer`（squish/bounce 下线后） + 删除 destroy 里的死引用 `.squishing/.bouncing` class
- 更新 `docs/TODO.md` / `CURSOR_ANIMATION_DECISIONS.md` / `TESTING_GUIDE_v2.2.0.md` 反映当前状态
- v2.3.0 cleanup：合并 7 个过时 doc 到 `docs/DESIGN.md`，归档 6 个旧 plan 到 `docs/archive/plans/`

---

## v2.2.0 (2026-06-29) — EventBus Migration + Code Cleanup

### Added
- `src/utils/scroll.ts` — 滚动检测工具（`hasScroll` / `findAllScrollableAncestors` / `findClosestScrollableElement`），统一去重 cursor.ts / boundary.ts 中的重复实现
- `src/index.ts` — 9 个 EventBus 订阅（`loaded-protyle-static/dynamic` / `destroy-protyle` / `switch-protyle` / `click-editorcontent` / `open-menu-content` / `ws-main` / `mobile-keyboard-show/hide`），统一 `eventBusOffFns` 数组管理生命周期

### Changed
- **全面迁移到官方 EventBus** — 替换手动 `selectionchange` / `keyup` / `addEventListener("message"...)` 监听
- **WS 监听迁移** — `window.siyuan.ws.ws.addEventListener("message"...)` → `EventBus.on("ws-main")`（自动 JSON.parse + 类型安全）
- **`firstProtyleIds` → `activeProtyleIds`** — 由 `click-editorcontent` 事件驱动（用户必须点击过编辑区才显示，避免切 Tab 时闪现）
- **`isMobile()` 改用 `getFrontend()`** — 替代 `document.getElementById("sidebar")` 思源内部实现
- **`isReadMode()` 改用 `getActiveEditor()`** — 修复分屏时只取第一个 `.protyle-content` 的 BUG
- **`typewriter.getEditorContainer()` 改用 `getActiveEditor()`** — 分屏时正确锁定活跃编辑器
- **`onunload()` 顺序调整** — 先退订 EventBus（`eventBusOffFns.forEach(off => off())`）再 destroy 模块，避免悬挂引用
- **删除 dead state `loadedProtyleIds`** — reviewer 发现从未被读（仅声明/add/delete/clear），按"不保留向后兼容"原则移除

### Fixed
- **分屏 split-screen isReadMode BUG** — 之前取文档中第一个 `.protyle-content` 会选错（左编辑/右只读场景下右边的状态判定不准）

### 已知限制
- **`__zentypeScrollBound` 在 `toggle()` off→on 循环中可能残留** — re-init 后仍跳过重新绑定。reviewer 判断为非阻塞：因 `bindScrollContainerEvents` 在每次 `doUpdateCursor` 中重新遍历绑定，不影响实际行为。后续若改成"绑定一次"再修复。
- `SMOOTH_ENABLED` / `BLINK_ENABLED` / `APPLY_TO_TITLE` / `USE_IN_MOBILE` 配置开关尚未接到 JS 逻辑（CSS 编译期锁死）

### Reviewer 状态
- ✅ 5 项 R-P2 风险说明全部 verified accurate
- ✅ 9 对 EventBus on/off 完全配对
- ✅ APPROVE WITH MINOR FIXES（F1/F2/F3 已全部处理）

---

## v2.1.0 (2026-06-29) — Cursor Optimization + Configurable Parameters

### Added
- 用户可配置参数文件 `src/config.ts`（光标高度比、闪烁延迟、打字机参数、涟漪参数）
- `src/utils/getEffectiveZIndex.ts` — 动态计算光标/高亮条的有效 z-index（向上遍历层叠上下文）
- `src/utils/isMobile.ts` — 移动端检测工具
- `src/utils/getLineHeight.ts` — 行高计算工具
- `src/modules/cursor/breathing.ts` — 呼吸动画状态机（idle 后自动恢复闪烁）
- `src/modules/cursor/boundary.ts` — 3 重边界检测（活动编辑器 + AV 排除 + AABB 碰撞）
- `src/types/siyuan.d.ts` — `window.siyuan` 全局类型声明（不再内联 declare global）

### Changed
- **光标改为直角矩形**（删除原 `border-radius: 2px`）
- **行为参数**集中到 `src/config.ts`（之前散落在 `getCursorRect.ts` / `cursor.ts` / `breathing.ts` / `typewriter.ts` / `ripple.ts`）
- **ZWSP marker** 全局复用 IIFE（不再每次 fallback 新建 DOM 节点）
- **throttle 移除**：删掉三阶段 200/400/600ms setTimeout，改为 `requestAnimationFrame(queueUpdate)` 包裹 keydown/input
- **transition 优化**：删除 `height` transition（动画抖动根因），删除 `animation-delay: 0.5s`
- **CSS 关键帧**：参考参考版 0/0.9/0/0/0.3 节奏感

### Fixed
- 顺滑光标 4 个 BUG（呼吸感、高度、移动动画、边界检测）
- P1（Round 3）：动态 z-index、ResizeObserver、悬浮窗拖动检测、滚动容器事件绑定

### 已知限制（已全部解决）
- ~~P2（EventBus 迁移、`getActiveEditor/getFrontend` 全面使用）暂未实施~~ → ✅ v2.2.0 已实施
- `SMOOTH_ENABLED` / `BLINK_ENABLED` / `APPLY_TO_TITLE` / `USE_IN_MOBILE` 配置开关尚未接到 JS 逻辑（CSS 编译期锁死）

---

## v2.0.0 (2026-06-27) — Major Rewrite

### Added
- 顺滑光标：自定义蓝色光标 + 闪烁动画
- 打字机模式：38% 高度居中 + 高亮条
- 涟漪聚焦：5 级渐变曲线
- 鼠标中心聚焦模式（自动切换）
- 嵌入块作为渐淡单位
- 顶栏图标 + 命令面板
- 模块化架构（每个功能独立 init/destroy）

### Changed
- 完全重构，使用 TypeScript + esbuild
- 移除 Svelte 模板代码
- 移除设置面板框架（v2+ 重做）

### Fixed
- 全屏模式高亮条层级问题
- 退格/回车时空行聚焦问题
