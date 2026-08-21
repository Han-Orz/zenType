# zenType 设计文档（v2.6.5）

> **本文件合并自 `docs/FOCUS_TYPEWRITER_DESIGN.md`（已删除）+ 早期 `TODO.md`（已删除）的设计段。**
> **代码即真相，本文档跟随代码，不是反过来。**
> **当前行为优先引用文件/函数/配置名；历史决策引用对应 commit。**

---

## 0. 概览

**zenType（思源集市显示名"焦点写作"）** 是思源笔记（SiYuan Note）的写作增强插件。三个独立可开关的模式：

| 模式 | 一句话 | 默认 |
|---|---|---|
| **顺滑光标** (Smooth Cursor) | 自定义蓝色光标替换系统竖线，移动时丝滑过渡 + 边缘淡出 | ✅ ON |
| **打字机模式** (Typewriter Mode) | 输入时光标保持在屏幕 38%～50% 的舒适区间内 | ✅ 默认 ON（初始化时立即启用共享状态） |
| **涟漪聚焦** (Ripple Focus) | 当前块最亮，周围块按距离渐淡 | ✅ 默认 ON（与打字机共享初始化状态） |

**核心价值**：让用户进入"心流"状态 —— 不用低头找光标、不被周围段落干扰。
**设计哲学**：聚焦服务于主动写作；默认启用以减少进入心流状态的额外操作，仍可通过命令切换。
**当前版本**：v2.6.5（`package.json` / `plugin.json`）。

---

## 1. 架构总览

### 1.1 模块依赖图

```
                    ┌─────────────────────────────────────────┐
                    │         src/index.ts (Plugin)           │
                    │   - onload: 注册命令 / EventBus / 模块  │
                    │   - onunload: 统一清理 (eventBusOffFns) │
                    └────────────────┬────────────────────────┘
                                     │
            ┌────────────────────────┼────────────────────────┐
            │                        │                        │
            ▼                        ▼                        ▼
    ┌───────────────┐        ┌───────────────┐        ┌───────────────┐
    │ cursor.ts     │        │ typewriter.ts │        │ ripple.ts     │
    │ (核心循环 +   │        │ (滚动 + FLIP +│        │ (块级 opacity │
    │  EventBus适配)│        │  暂停场景)    │        │  + 句级 dim)  │
    └───────┬───────┘        └───────┬───────┘        └───────┬───────┘
            │                        │                        │
            │ cursor/* 子模块        │                        │
            ▼                        ▼                        ▼
      ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
      │ inputMode.ts    │  │ utils/scroll.ts │  │ utils/          │
      │ + inputMode     │  │ 滚动容器检测    │  │ edgeProximity.ts│
      │   Triggers.ts   │  └─────────────────┘  └─────────────────┘
      │ 状态 + 触发适配 │
      └─────────────────┘
```

> **架构原则（v2.6.2 重构后）**：`cursor.ts` 不再单文件承担所有职责。事件注册、滚动绑定、ResizeObserver、悬浮窗拖动、switch-settle 流程、边缘箭头、呼吸动画都拆到 `cursor/` 子模块；`cursor.ts` 只保留核心循环（`doUpdateCursor`）和 EventBus 适配。`inputMode` 的 setter 调用集中在 `inputModeTriggers.ts`，业务模块（`cursor/events.ts`、`typewriter.ts`、`index.ts`）通过语义函数（`onTextInput` / `onWheelOrTouchMove` 等）触发，不再直接调 `setBothOn/Off`。

### 1.2 文件结构

```
src/
├── index.ts                      # Plugin 入口 + EventBus 订阅 + 命令注册
├── config.ts                     # 用户可配置参数
├── modules/
│   ├── cursor.ts                 # 顺滑光标主模块（DOM 创建 + 核心循环 + EventBus 回调）
│   ├── cursor/
│   │   ├── breathing.ts          # 呼吸动画状态机
│   │   ├── edgeArrow.ts          # 边缘箭头 DOM/定位/显隐（默认禁用）
│   │   ├── events.ts             # document 事件注册 + 释放（13 条 handler）
│   │   ├── scrollBindings.ts     # 滚动祖先事件绑定（scroll/wheel）
│   │   ├── switchSettle.ts       # 切换 protyle 后的隐藏/稳定/淡入状态机
│   │   ├── resizeBindings.ts     # protyle-content / protyle-wysiwyg 的 ResizeObserver
│   │   └── popoverDrag.ts        # block__popover 拖动手柄绑定
│   ├── typewriter.ts             # 打字机模式（舒适区间滚动 + 块级 FLIP）
│   ├── ripple.ts                 # 涟漪聚焦（块级 opacity + 句级 Highlight dim/fade）
│   ├── inputMode.ts              # 聚焦/打字机 ON/OFF 状态 + 订阅
│   └── inputModeTriggers.ts      # 触发适配层（语义事件 → setBothOn/Off）
├── utils/
│   ├── boundary.ts               # 3 重边界检测 + 嵌套滚动容器回退
│   ├── getCursorRect.ts          # 光标显示矩形
│   ├── getCursorElement.ts       # 当前选区所在 DOM
│   ├── getLineHeight.ts          # 所在行 computed lineHeight
│   ├── getEffectiveZIndex.ts     # 沿祖先链找层叠上下文
│   ├── edgeProximity.ts          # 光标到视口各边的距离 + 淡出系数
│   ├── edgeCases.ts              # 暂停场景判定（shouldPause* / isReadMode）
│   ├── scroll.ts                 # 滚动容器检测（hasScroll / find*）
│   ├── isMobile.ts               # 移动端检测（getFrontend）
│   ├── lifecycle.ts              # 生命周期步骤执行 + 错误隔离
│   └── styleManager.ts           # 共享样式注入/清理
├── styles/index.scss             # 全局 CSS（光标 + 箭头 + 主题变量）
└── types/index.ts                # 共享类型（RippleMode / CursorRect / ModuleEnabled）
```

### 1.3 EventBus 订阅关系（index.ts）

`src/index.ts` 在 onload 订阅思源官方 EventBus，**8 个事件统一管理生命周期**（`eventBusOffFns` 数组 + onunload 统一释放）：

| 事件 | 触发场景 | 处理函数 |
|---|---|---|
| `loaded-protyle-static` | 新编辑器加载（首次打开文档 / 静态分屏） | `onProtyleLoaded` |
| `loaded-protyle-dynamic` | 动态编辑器（悬浮窗 / 嵌入块 / 链接跳转） | `onProtyleLoaded` |
| `switch-protyle` | 切 Tab | `inputModeTriggers.onSwitchProtyle()` + `onProtyleSwitched` |
| `click-editorcontent` | 用户点击编辑器内容 | `onEditorContentClicked` |
| `open-menu-content` | 右键菜单弹出 | `onMenuOpened` |
| `ws-main` | 思源 WS 推送（自动 JSON.parse） | `onWsMain`（监听 `transactions` cmd） |
| `mobile-keyboard-show` | 移动端键盘弹出 | `onMobileKeyboardShow` |
| `mobile-keyboard-hide` | 移动端键盘收起 | `onMobileKeyboardHide` |

**已知限制**：`__zentypeScrollBound` 在 `toggle()` off→on 循环中可能残留（reviewer F3 评估为非阻塞，因为 `bindScrollContainerEvents` 在每次 `doUpdateCursor` 中重新遍历绑定）。

---

## 2. 顺滑光标 (Smooth Cursor)

### 2.1 想要的效果

- 思源默认系统竖线光标 → 自定义蓝色光标替换（亮色 `#5d8cd7` / 暗色 `#8ab4f8`）
- 移动时按 `TRANSITION.TIERS` 分档平滑过渡：≤30px 为 0.07s、≤150px 为 0.15s、≤500px 为 0.21s、再远为 0.30s；曲线为 cubic-bezier
- 停止活动 **1.1s 后**进入呼吸闪烁（5 个关键帧，3s 一周期）
- 接近视口边缘（**顶/底对称，20px 范围内**）→ 平滑淡出 + 缩小（scale 0.6-1.0）
- 离开视口 → 停在最后可见位置 + 完全淡出
- 返回视口 → 平滑淡入（case C 强制 remove `.no-transition` + reflow）
- **直角矩形**（v2.1.0 删除 `border-radius: 2px`）
- 鼠标拖蓝 / 选中时 → 跳过过渡，立即移动到选区末尾

### 2.2 关键决策

| 决策 | 值 | 代码引用 | 理由 |
|---|---|---|---|
| 高度 | `lineHeight × 1.05` | `config.ts` `CURSOR_CONFIG.HEIGHT_RATIO` | 参考版 0.88 太矮覆盖少，用户偏好 1.05 |
| 颜色 | `#5d8cd7` / `#8ab4f8` | `styles/index.scss` `#zentype-cursor` / dark theme | 验证过的搭配，亮/暗主题各一 |
| 移动曲线 | `cubic-bezier(0.25, 0.1, 0.25, 1)` | `cursor.ts` `transitionDurationForDistance()` + `styles/index.scss` | 时长由距离分档，曲线保持一致 |
| 长距离时长 | `TRANSITION.TIERS` 分档表 | `config.ts` `TRANSITION.TIERS` | Q7：短 0.07 / 中短 0.15 / 中 0.21 / 长 0.30 |
| 呼吸动画 | `3s 1.5s ease-in-out infinite` | `styles/index.scss` `zentype-breathe` | 操作空闲后恢复呼吸动画 |
| 边缘淡出区 | `EDGE_FADE.ZONE = 20` | `config.ts` `EDGE_FADE.ZONE` | 60 太早 → 30 → 20（用户逐步收紧） |
| 离屏缩放 | `MIN_SCALE = 0.6` | `config.ts` `EDGE_FADE.MIN_SCALE` | 视觉提示但不消失 |
| 边缘对齐 | 用 `editorRect` 不用裸视口 | `cursor.ts` `doUpdateCursor()` `edgeProximity.ts` | 顶部 ~55px 是 toolbar/breadcrumb，用视口会"顶部永不到淡出区看着瞬切" |
| 直角矩形 | 删 `border-radius: 2px` | v2.1.0 commit | 用户偏好 |

### 2.3 代码实现逻辑

#### 2.3.1 DOM 创建 + 生命周期（`cursor.ts` `createCursorElement()`）

`createCursorElement()` 创建 `#zentype-cursor` 元素，整个插件生命周期内只创建一次（id 选择器查重）。**关键处理**：元素进 DOM 那一刻即加 `.no-transition` class + `transform: translate3d(-9999px, -9999px, 0)`，避免 init 末端 `queueUpdate()` → 首次 `doUpdateCursor()` 之间约 16ms 窗口内光标在视口左上角闪现。

#### 2.3.2 位置更新主循环（`cursor.ts` `doUpdateCursor()`）

**rAF 节流**：`queueUpdate()` 用 `pendingFrame` 标志保证每帧最多一次 `doUpdateCursor()`。

**`doUpdateCursor()` 核心视觉时序**：
1. **暂停呼吸**（操作中不需要）
2. **读取光标矩形**（`getCursorRect()` lineHeight × 1.05，垂直居中）
3. **计算边缘距离**（`getEdgeProximity(rect, editorRect)`）
4. **边界检测**（`isInAllowElements`）→ 不通过则按 `isOuterElement` 分支处理
5. **计算 z-index**（沿祖先链找层叠上下文 + 1）
6. **写 transform / height / z-index**（边缘态走 `applyFadeAndScale`，正常态走原生 transform）
7. **强制布局同步**（`void cursorEl.offsetHeight` 让 no-transition 立即生效）
8. **下一帧 rAF 移除 `.no-transition`** + 1.1s 后恢复呼吸（边缘附近不恢复）

以上步骤后还会绑定/刷新当前编辑器的 ResizeObserver、滚动容器监听和悬浮窗拖动监听；键盘驱动的滚动标志由 300ms 冷却计时器清零。

#### 2.3.3 边界检测 3 重 + 嵌套滚动容器回退（`utils/boundary.ts`）

```
1) getActiveEditor() 校验
   └ 选区不在活跃编辑器内 → isOuterElement=true（思源内部多编辑器场景）

2) AV 数据库块排除
   └ .av / .av__mask / .av__cursor → isOuterElement=true

3) AABB 碰撞（核心）
   └ 拿 .protyle:not(.fn__none) .protyle-content 的 bounding rect
     检查光标坐标是否在其内
   └ 不在 → 嵌套滚动容器回退（findClosestScrollableElement + rect 检查）
```

返回 `AllowResult { allowed, cursorElement, isOuterElement, editorRect, reason? }`。

#### 2.3.4 边缘交互（`cursor.ts` `doUpdateCursor()` + `edgeProximity.ts` + `styles/index.scss`）

```
if (edge.isOffScreen):
  → applyFadeAndScale(opacity=0, scale=0.6, pos, yOffset=2)
elif (edge.distance < EDGE_FADE.ZONE):
  → applyFadeAndScale(opacity=edge.factor, scale=lerp(0.6, 1, factor), pos, yOffset)
else:
  → 写原生 transform（不带 scale），transition 走 TRANSITION.TIERS 查表
  → 清 inline opacity，让 CSS / 呼吸动画接管
```

**`applyFadeAndScale` 写 inline `opacity` + `transform: translate3d(x, y-yOffset, 0) scale(s)` + `height`**（commit 1，离屏/边缘淡出专用路径，正常态继续走原生 transform 不带 scale）。

**`yOffset = 2`**：光标上移 2px，让视觉重心偏到行中线之上（用户偏好，抵消 HEIGHT_RATIO > 1 时光标下沿超出 lineHeight 看起来偏下的问题）。

#### 2.3.5 边缘 arrow 指示器（默认禁用）

`EDGE_ARROW.ENABLED = false`（`config.ts`）。代码保留作为 opt-in 入口。完整功能：`#zentype-edge-arrow` 三角形（CSS border-trick），光标离屏时按 nearest edge 上下方向显示在视口边缘。**风险**：用户测试后认为不需要，默认关闭。

### 2.4 squish / bounce 动画（已下线）

v2.2.x 实施过"光标跨边界时 squish/bounce 关键帧动画"（CSS Transform Level 2 独立 `scale:` 属性），但用户测试反馈"像弹弓"——整个边缘缩放动画路线已下线（`0ee73ed` commit）。**保留 case B 的平滑 opacity 淡出**。SCSS 关键帧和触发函数全部删除，注释指向 git 历史以便将来恢复。

### 2.5 配置入口

`config.ts` `CURSOR_CONFIG`：

```typescript
HEIGHT_RATIO: 1.05      // 光标高度 = lineHeight × 此倍数
BLINK_DELAY_MS: 1100     // 停止活动后多少毫秒恢复呼吸
```

**未开放的开关**（CSS 编译期锁死）：
- `SMOOTH_ENABLED` / `BLINK_ENABLED` / `APPLY_TO_TITLE` / `USE_IN_MOBILE` —— 见 `config.ts` 文件末尾注释

---

## 3. 打字机模式 (Typewriter Mode)

### 3.1 想要的效果

- 输入时光标停在**舒适区间 `[38%, 50%]`**（38% 黄金分割偏上 / 50% 中线）—— 不强制固定目标位
- **区间内不触发滚动**：光标在 38%-50% 范围内自由输入，避免累积漂移带来的"跳跃感"
- **区间外触发滚动**：低于 38% 或高于 50% 时，smoothScroll 把光标带回最近边界
- 平滑滚动动画，**距离分档时长**（<20px → 180ms / <60px → 260ms / <150px → 360ms / <400px → 480ms / ≥400px → 600ms）
- **动画曲线**：`cubic-bezier(0.25, 0.1, 0.25, 1)`（与顺滑光标一致，自然、顺滑）
- **滚动中请求重同步**：连续输入时不接管当前动画，动画结束后按最新光标位置重新检查
- **1px 阈值**：即使光标只偏离 1px 也立即触发滚动
- **块级插入动画**：按 Enter 新建块时，新块被自然带入舒适区；上方块跟视窗让位（位移 = smoothScroll 的 deltaY）；下方块用 FLIP 平滑补位（位移幅度 = 自然 reflow delta）；**全部是位移，无 opacity 渐变**
- **smoothScroll 是曲线原语**：方向（deltaY）由调用方算，调用方决定"该不该滚 + 滚多少"；smoothScroll 只管曲线和时长
- **暂停场景不滚动**：悬浮窗 / 只读 / 嵌入块（iframe/video/PDF）
- **暂停渐隐**：多行选中时优雅暂停（光标本身不变）

### 3.2 关键决策

| 决策 | 值 | 代码引用 | 理由 |
|---|---|---|---|
| **舒适区间** | `[0.38, 0.50]` | `config.ts` `TYPEWRITER_CONFIG.COMFORT_ZONE` | 38%-50% 都接受，不强制固定目标；区间内不滚 |
| **阈值** | 1px | `typewriter.ts` `Math.abs(deltaY) >= 1` | 避免无意义的小幅滚动 |
| **时长分档** | 180/260/360/480/600 ms | `config.ts` `TYPEWRITER_CONFIG.SCROLL_DURATION_TIERS` | `durationForDistance()` 按距离选择时长 |
| **FLIP 动画曲线** | `cubic-bezier(0.25, 0.1, 0.25, 1)` | `config.ts` `TYPEWRITER_CONFIG.SCROLL_CURVE` | 用于块位移 FLIP 的 CSS transition |
| **滚动中请求处理** | 新请求标记重同步，不合并到当前动画 | `typewriter.ts` `isScrolling()` / `scrollResyncPending` | 避免连续输入导致滚动动画和边界 clamp 竞态 |
| **rAF debounce** | `scheduleCheck()` 包裹 | `typewriter.ts` `scheduleCheck()` | 合并同一帧内的 selection/input/resize 等触发 |
| **container 缓存** | `cachedContainer` 按 cursorElement 缓存 | `typewriter.ts` `checkAndScroll()` | 避免每次 DOM 遍历寻找滚动祖先 |
| **滚动锚点** | `editorRect`（protyle-content rect） | `typewriter.ts` `checkAndScroll()` | 用裸 container rect 会算错位置（祖先元素可能更大） |
| **选择器** | 复用 `isInAllowElements` | `typewriter.ts` `checkAndScroll()` | 与 cursor 共用活跃编辑器和边界判断 |
| **smoothScroll API** | `smoothScroll(el, { deltaY, duration?, easing? })` | `typewriter.ts` `smoothScroll()` | 调用方计算方向和距离；默认使用 `easeOutCubic` |
| **块级插入动画** | FLIP | `typewriter.ts` `animateBlockShift()` | capture 阶段采样，延迟两帧等布局稳定；键盘标志窗口为 300ms |
| **Q1 决策：高亮条** | **永久下线** | `config.ts` 高亮条注释块 | 用户偏好"纯滚动"，删除 DOM/CSS 减小维护面。入口保留以备未来恢复 |

### 3.3 代码实现逻辑

#### 3.3.1 初始化（`typewriter.ts` `initTypewriter()`）

```typescript
initTypewriter():
  监听 selectionchange / resize / input / compositionstart / compositionend / click / keydown
  selectionchange / resize 等检查类事件通过 scheduleCheck() 合并
  inputModeTriggers.onTextInput()  // 初始化时立即激活共享状态（幂等）
```

#### 3.3.2 主循环（`typewriter.ts` `checkAndScroll()`，v2.3.0 更新）

```
checkAndScroll():
  1) inputMode.isTypewriterActive() === false? return
  2) shouldPauseTypewriter()? return  // popup/read-mode/embed
  3) rect = getCursorRect()
  4) result = isInAllowElements({x: rect.x, y: rect.y})
      - 使用 cursor 模块验证过的选择器 .protyle:not(.fn__none) .protyle-content
      - editorRect 提供滚动锚点
  5) container = findClosestScrollableElement(result.cursorElement)  // 带缓存
  6) editorHeight = editorRect.bottom - editorRect.top
     cursorPct = (rect.y - editorRect.top) / editorHeight  // 0~1
     // v2.3.0：舒适区间 [COMFORT_ZONE[0], COMFORT_ZONE[1]]
      if cursorPct < COMFORT_ZONE[0]:
        deltaY = (cursorPct - COMFORT_ZONE[0]) × editorHeight  // 向上滚，让光标下移到 38%
      elif cursorPct > COMFORT_ZONE[1]:
        deltaY = (cursorPct - COMFORT_ZONE[1]) × editorHeight  // 向下滚，让光标上移到 50%
      else:
        deltaY = 0  // 区间内，不滚
  7) abs(deltaY) >= 1? smoothScroll(container, { deltaY })
```

**v2.3.0 行为变化**：
- 原 `TARGET_RATIO = 0.38` 单点目标 → 改为 `[0.38, 0.50]` 区间
- 区间内不滚（之前任何 1px 偏离都滚，现在区间内 0 滚）
- 调用方算 deltaY，smoothScroll 只接 `deltaY` 不接 `targetRatio`

**性能硬指标**：每帧 < 1ms。优化手段：
- rAF debounce 合并多事件
- `cachedContainer` 缓存滚动容器（仅 cursorElement 变化时失效）
- `smoothScroll` 内部 rAF，不阻塞主线程

#### 3.3.3 滚动动画门禁与重同步（`typewriter.ts` `smoothScroll()`）

```typescript
checkAndScroll():
  if (pendingScroll !== null):
    scrollResyncPending = true
    return

smoothScroll(target, { deltaY, duration?, easing? }):
  pendingScrollEnd = target.scrollTop + deltaY
  startTime = performance.now()
  duration = duration ?? durationForDistance(abs(deltaY))
  step() rAF 循环 → 插值到 pendingScrollEnd
  动画结束后若 scrollResyncPending=true，则清理坐标缓存并重新 scheduleCheck()
```

**效果**：滚动动画期间的新检查不会直接接管当前动画，而是记录一次重同步请求；当前动画结束后再按最新光标位置检查，避免连续输入造成滚动动画竞态。

#### 3.3.4 距离分档时长（v2.3.0 移到 `config.ts`）

**v2.2.1**：写在 `typewriter.ts` 的 `durationForDistance()` 函数中。
**当前实现**：时长数组位于 `config.ts` 的 `TYPEWRITER_CONFIG.SCROLL_DURATION_TIERS`，用户可直接调。

```typescript
// config.ts
SCROLL_DURATION_TIERS: [180, 260, 360, 480, 600]
// typewriter.ts 的 durationForDistance() 使用以下距离档位：
// <20 → 180，<60 → 260，<150 → 360，<400 → 480，≥400 → 600（ms）
```

`typewriter.ts` 改为读取 config 中的时长数组；距离阈值仍由 `durationForDistance()` 固定为 `<20 / <60 / <150 / <400 / ≥400`。

### 3.4 暂停场景（`utils/edgeCases.ts`）

```typescript
shouldPauseFocusAndTypewriter():  // ripple 也用
  hasSelection() || isInPopup()

shouldPauseTypewriter():  // 仅 typewriter
  isInPopup() || isReadMode() || isInEmbedBlock()
```

**`isReadMode()` 修复**（`edgeCases.ts`）：检查 `cursor.isContentEditable`（不是 `.protyle-content.isContentEditable`），兼容只读文档/标题。原 bug 修复 commit `2808caa`。

**`isInEmbedBlock()`**：`cursor.closest("iframe, video, [data-type='NodeIFrame'], [data-type='NodeVideo'], [data-type='NodePDF']")`。

### 3.5 Q1 高亮条 — 永久下线 + 入口保留

**决策**（2026-06-30 commit `1229f45`）：删除 v1/v2.0/v2.2.x 早期使用的 `#zentype-highlight-line` DOM/CSS。

**理由**：
- v1 时代高亮条是"伪打字机"效果（光标位置 + 一条细横线）
- 真打字机只需要舒适区间内的稳定滚动，高亮条视觉冗余
- Neo-Plus 等参考实现也不靠它
- 删除后 `typewriter.ts` 从 ~220 行减到 160 行，维护面更小

**未来恢复路径**（`config.ts` 中的高亮条注释块）：
1. `typewriter.ts` 重新引入 `createHighlightElement()` + `updateHighlight()`
2. `initTypewriter()` 创建 div，`destroyTypewriter()` 清理
3. `checkAndScroll()` 在每条 early-return 路径清 `.visible`
4. `styles/index.scss` 恢复 `#zentype-highlight-line + .visible` 块（参见 git 历史 v2.2 之前）

### 3.6 配置入口（v2.3.0 更新）

`config.ts` `TYPEWRITER_CONFIG`：

```typescript
COMFORT_ZONE: [0.38, 0.50]                        // 舒适区间（v2.3.0 新增，替换 TARGET_RATIO）
SCROLL_DURATION_TIERS: [180, 260, 360, 480, 600]  // 距离分档 ms（v2.3.0 从 typewriter.ts 移入）
SCROLL_CURVE: 'cubic-bezier(0.25, 0.1, 0.25, 1)' // 动画曲线（v2.3.0 新增，与光标一致）
```

### 3.7 块级插入动画（v2.3.0 新增）

**触发条件**：
- Enter 在行尾 / 行中（新建空块，光标移入新块）
- Backspace 在行首（当前块合并到上一块）

**问题**：之前的实现里，按 Enter 后新块凭空出现，下方块瞬间跳到新位置（编辑器原生 reflow），视觉突兀。

**目标**：让 Enter 触发的"块级变化"视觉上不突兀。所有动画都是**位移**，没有 opacity 渐变。

#### 3.7.1 实现

`animateBlockShift` 直接处理 FLIP 三阶段批处理（Invert → Commit → Play），无需独立 `markBlockInsertPending` 状态标记（`markBlockInsertPending` 已在 c5bfdc9 删除）。参考 cursor.ts round 4 fix 模式，keydown Enter/Backspace 的 capture handler 触发 `animateBlockShift` 快照，然后延迟两帧重新对齐舒适区。

注册点（`typewriter.ts` 事件 handler）：
```typescript
keydown Enter / 行首 Backspace:
  animateBlockShift(editor, selectionRange);  // FLIP 入口
  // 延迟两帧等 SiYuan 布局收敛后再触发滚动对齐
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      lastCheckRect = null;
      checkAndScroll();
    });
  });
```

#### 3.7.2 FLIP 平滑 reflow（`animateBlockShift`）

让"下方块被自然推下去"的瞬间不突兀 —— 用 FLIP（First-Last-Invert-Play）技术。当前实现正常路径会**围绕当前选区起止块采样前后 sibling 窗口 + 沿祖先层级采样**（默认半径 `FLIP_BLOCK_RADIUS = 30`），避免长文档全量扫描；选择区容器异常时保留全量查询作为 fallback：

```typescript
function animateBlockShift(editor: HTMLElement, range: Range): void {
  // First：DOM 变更前快照采样窗口内块位置（围绕选区 sibling + 祖先层级）
  // 下一帧：DOM 变更后读新位置
  // Invert：把块"反推"到旧位置（视觉上看起来没动）
  // Play：下一帧取消 transform，CSS transition 平滑过渡
  // 详见 typewriter.ts animateBlockShift 实现
}
```

**核心**：位移幅度 = 块**实际被推的距离**（由编辑器自身 reflow 决定），不是硬编码的固定 px。

#### 3.7.3 三类块的动画类型

| 块 | 位移来源 | 动画类型 |
|---|---|---|
| **上方块** | smoothScroll（视窗向下滚 → 上方块向上滑出视窗） | 位移（自然让位） |
| **下方块** | smoothScroll（向上滑）+ FLIP（向下补 reflow delta） | 位移（双源合成） |
| **新块** | smoothScroll（被带到舒适区），opacity 默认 1 | 位移（无淡入） |

**没有 opacity 渐变**。新块默认 opacity 1，直接出现，靠 smoothScroll 把它带到舒适区。

#### 3.7.4 触发范围与暂停条件

- 仅 Enter，以及 Backspace 位于块首或跨块选区时进入 FLIP 快照
- `isReadMode()` / `isInPopup()` 等暂停条件会阻止后续 typewriter 滚动对齐
- 连续 FLIP 调用会取消上一轮 cleanup，避免旧定时器清除新一轮的 transform

#### 3.7.5 与 ripple 的协作

块级插入动画跑完后，ripple 模块通过事件自动接管——typewriter 不再显式调用 ripple（v2.5.0 移除了 `ripple.recompute`，§4.3.6）：
- Enter / Backspace 后光标移入新块 → 触发 `selectionchange` → `applyRipple` 重算
- 当前句稳定态保持原文字色；当前块 opacity 固定为 1.0；邻近顶层块按块级梯度 + 视觉权重计算

§3 typewriter **不直接设 opacity**，opacity 完全交给 §4 ripple。

---

## 4. 涟漪聚焦 (Ripple Focus)

### 4.1 想要的效果（v2.6.1 更新：CSS Custom Highlight API + 句级 fade）

- **当前输入句**稳定态保持默认文字色（最亮）；当前块的**其它句**用 `::highlight(zt-sentence-dim)` 染色为 `color: rgba(0,0,0,0.6)`（浅色）/ `rgba(255,255,255,0.6)`（深色）——按 `.`、`?`、`!`、`。`、`？`、`！`、`…` 切句，**句级**而非仅块级
- **句级切换动画**：旧当前句用 `zt-sentence-fade-out` 从原文字色插值到 dim 色；新当前句用 `zt-sentence-fade-in` 从 dim 色插值到原文字色；动画由 `requestAnimationFrame` + `easeInOutCubic` 驱动，不依赖 CSS transition
- 当前块 opacity = 1.0，不参与视觉权重衰减；相邻 ±1 块 opacity ≈ 0.4 × 视觉权重
- 相邻 ±2 块 opacity ≈ 0.2；更远按 `[0.15, 0.1, 0.05]` 继续衰减
- **块级** dimming 仍用 JS `style.opacity`；**句级** dimming / fade 用 CSS Custom Highlight API（零 DOM 突变，§4.3.3）
- **嵌套块**继承顶层块 opacity；v2.6.0 起不再按块类型递归处理，也不再使用 `EMBED_MULTIPLIER` / 深度系数
- **默认 ON** —— 初始化时立即启用共享的打字机/涟漪状态
- **暂停场景**：选中 / 悬浮窗 → `clearAll()` 清除所有块级 opacity 覆盖 + `CSS.highlights.delete`，恢复默认

### 4.2 关键决策

| 决策 | 值 | 代码引用 | 理由 |
|---|---|---|---|
| **默认 ON** | 初始化时启用共享的打字机/涟漪状态 | `typewriter.ts:599-601` | 与模块默认启用状态一致 |
| **句级粒度**（v2.5.0 改 Highlight API） | 按 `.?!。？！…` 切句，小数点保护 | `ripple.ts` `splitSentences` / `applySentenceHighlight` | 用户偏好"看清整句"，不只是块；v2.5.0 废弃 `getSentences`/span 包裹 |
| **块级 opacity 梯度** | `[1.0, 0.4, 0.2, 0.15, 0.1, 0.05]` | `config.ts` `BLOCK_LEVELS` | v2.6.0 参考 Obsidian focus，增强聚焦对比 |
| **句级 dim alpha** | `SENTENCE_DIM_ALPHA = 0.6` | `config.ts` `SENTENCE_DIM_ALPHA` | v2.6.1 调低非当前句亮度，当前句稳定态保持原色 |
| **句级切换动画** | `zt-sentence-fade-out` + `zt-sentence-fade-in`，rAF 颜色插值 | `ripple.ts` `startSentenceFade` | `::highlight` 不支持 transition，用 JS 驱动颜色插值且保持零 DOM 突变 |
| **当前块 opacity** | `distance === 0` 强制 `1.0` | `ripple.ts` `applyBlockOpacity` | 防止当前块因 `visualWeightOf` 小于 1 导致当前句比非聚焦模式淡 |
| **视觉权重** | 仅 distance=1 的相邻块参与；distance≥2 跳过布局回读 | `ripple.ts` `visualWeightOf` / `applyBlockOpacity` | 相邻块过渡更自然，远块差异不可感知 |
| **应用方式** | 块级 `style.opacity`；句级 CSS Custom Highlight API | `ripple.ts` / `styles/index.scss` | 块级简单直接；句级零 DOM 突变（v2.5.0，避免数据丢失） |
| **渐淡单位** | `.protyle-wysiwyg` 的顶层 `container.children` | `ripple.ts` `getTopLevelBlock` / `applyBlockOpacity` | 嵌套块继承父级 opacity，避免父子叠乘 |
| **重新计算接口** | ~~`ripple.recompute`~~（v2.5.0 移除） | — | 块级插入后光标移入新块 → `selectionchange` → `applyRipple` 自动重算，无需显式调用（§4.3.6） |
| **mouse 模式** | **已移除**（v2.5.0 重写时清理） | — | Q3：用户暂未决定应用场景。旧 `onMouseMove` / `MOUSE_THROTTLE` / `IDLE_THRESHOLD` / 滚动条缓冲随重写删除；未来恢复需重建（§4.4） |

### 4.3 代码实现逻辑

#### 4.3.1 模式状态（`ripple.ts`）

```typescript
let active = false;
let initialized = false;
let pendingFrame: number | null = null;
```

当前 Ripple 通过 `active`、`initialized` 和 `inputMode.focusActive` 控制生命周期与是否应用效果；不再维护独立的 `text/mouse/paused` 模式状态。`RippleMode` 类型仍保留在 `types/index.ts`，仅作为历史/未来扩展占位，当前实现不使用它。

#### 4.3.2 主循环（`applyRipple` + `applyBlockOpacity` + `applySentenceHighlight`，v2.6.1 更新）

```
applyRipple():  // rAF 节流（pendingFrame 标志）
  if (!inputMode.isFocusActive() || shouldPauseFocusAndTypewriter()):
    clearAll()  // 清块级 opacity + CSS.highlights.delete("zt-sentence-dim")
    return

  currentBlock = getCurrentBlock()  // 找到光标所在 [data-node-id]
  if (!currentBlock) return

  container = currentBlock.closest(".protyle-wysiwyg")
  if (!container) return

  // v2.5.0：块级 opacity + 句级 Highlight 分两步
  // 1) 块级 opacity（style.opacity）—— applyBlockOpacity(container, currentBlock)
  //    v2.6.0 简化：只遍历 container.children（顶层块），不遍历嵌套块
  //    嵌套块继承父级 opacity，避免叠加
  //    块级缓存：同一顶层块 + 无滚动 + 无块增删时跳过
  //    distance≥2 的远块跳过 getBoundingClientRect
  siblings = container.children
  fromIndex = siblings.indexOf(currentBlock 的顶层祖先)
  siblings.forEach(block => {
    if (!block.hasAttribute("data-node-id")) return
    distance = abs(fromIndex - i)
    baseOpacity = BLOCK_LEVELS[min(distance, len(BLOCK_LEVELS)-1)]
    weightFactor =
      distance === 0 ? 1.0 :
      distance >= 2 ? 1.0 :
      WEIGHT_MIN + visualWeightOf(block, editorRect) * (1 - WEIGHT_MIN)
    block.style.transition = `opacity ${TRANSITION_SEC}s ease`
    block.style.opacity = String(baseOpacity * weightFactor)
  })

  // 2) 句级 dimming / fade（CSS Custom Highlight API，零 DOM 突变，§4.3.3）
  textNodeMap = buildTextNodeMap(currentBlock)  // 单次 TreeWalker
  caretOffset = getCaretOffset(currentBlock, textNodeMap)
  if (caretOffset !== null):
    applySentenceHighlight(currentBlock, caretOffset, textNodeMap)  // 给非当前句染色；跨句时启动 fade
  else:
    CSS.highlights.delete("zt-sentence-dim")
    CSS.highlights.delete("zt-sentence-fade-in")
    CSS.highlights.delete("zt-sentence-fade-out")
```

#### 4.3.3 句级 dimming / fade（CSS Custom Highlight API，v2.6.1 更新）

v2.5.0 废弃 span 包裹，改用 [CSS Custom Highlight API](https://developer.mozilla.org/en-US/docs/Web/API/CSS_Custom_Highlight_API) 标记非当前句。**零 DOM 突变**——只在已有文本节点上构造 `Range` 对象，注册到 `CSS.highlights`，由 `::highlight(...)` 染色。

v2.6.1 在同一套 Highlight API 上增加跨句切换动画：稳定态只保留 `zt-sentence-dim`；光标从旧句移到新句时，临时排除旧句和新句的稳定 dim，高亮旧句为 `zt-sentence-fade-out`、新句为 `zt-sentence-fade-in`，用 rAF 修改 CSS 变量完成颜色插值。动画结束后删除两个临时 highlight，恢复只排除当前句的稳定 dim。

```typescript
const SENTENCE_DIM_HIGHLIGHT = "zt-sentence-dim";
const SENTENCE_FADE_IN_HIGHLIGHT = "zt-sentence-fade-in";
const SENTENCE_FADE_OUT_HIGHLIGHT = "zt-sentence-fade-out";

// applySentenceHighlight(block, caretOffset)
//   1. textContent 按正则 /(?<!\d)[.?!。？！…]+(?!\d)/g 切句
//   2. 为"不含光标"的每句构造 Range
//   3. CSS.highlights.set("zt-sentence-dim", new Highlight(...dimRanges))
//   4. 若当前句 start 与上次不同：
//      - stable dim 临时排除旧当前句 + 新当前句
//      - fade-out: textColor → dimColor
//      - fade-in: dimColor → textColor
//      - requestAnimationFrame + easeInOutCubic 驱动 CSS 变量
```

样式（`styles/index.scss`）：

```scss
:root {
  --zt-sentence-dim-color: rgba(0, 0, 0, 0.6);
  --zt-sentence-fade-in-color: rgba(0, 0, 0, 1);
  --zt-sentence-fade-out-color: rgba(0, 0, 0, 0.6);
}
::highlight(zt-sentence-dim) { color: var(--zt-sentence-dim-color); }
::highlight(zt-sentence-fade-in) { color: var(--zt-sentence-fade-in-color); }
::highlight(zt-sentence-fade-out) { color: var(--zt-sentence-fade-out-color); }
```

`styles/index.scss` 的变量是兜底值；运行时 `ripple.ts` 会按主题和 `SENTENCE_DIM_ALPHA` 写入实际颜色。当前代码中 `SENTENCE_DIM_ALPHA = 0.6`。

**为什么不用 opacity**：`::highlight()` 伪元素只支持 `color` / `background-color` / `text-decoration` / `text-shadow`（[css-pseudo-4 §3.2](https://drafts.csswg.org/css-pseudo-4/#highlight-styling) 规范明列），**不支持 `opacity`、也不支持厂商前缀属性（如 `-webkit-text-fill-color`）或 `transition`**。句级 dimming 用 `color: rgba(…,0.6)` 模拟；句级 fade 用 rAF 插值 `color`，不走 CSS transition。块级 dimming 仍用 `style.opacity`（见 §4.3.2）。

**为什么废弃 span 包裹**（数据丢失 BUG 根因）：旧 `wrapTextRange` 用 `range.extractContents()` + `range.insertNode(span)` 把文本节点分裂到 `<span>` 内。SiYuan 的 input/keydown 处理器在 DOM 突变后重新查询选区，选区跨越 `<span>` 边界时语义改变 → 光标飘走 → 在 `。/？/！` 后继续打字会删除已有内容。Highlight API 不修改 DOM，彻底消除此冲突。

**自愈**：SiYuan 的 `outerHTML` / `innerHTML` 交换会使 `Range` 对象失效（文本节点被替换），但 `CSS.highlights` 注册表本身不受影响。下一次 `selectionchange` → `applyRipple` → `applySentenceHighlight` 用新文本节点重建 Range，无需手动清理旧 span。

> **v2.6.0 移除**：`isRippleTargetBlock`/`depthOf`/`RIPPLE_TARGET_BLOCK_TYPES`/`RIPPLE_SKIP_BLOCK_TYPES`/`RIPPLE_SKIP_SELECTORS` 全部删除。块级 opacity 现在直接作用于 `container.children`（所有带 `data-node-id` 的顶层块），不再区分 block type。

**性能**：`applySentenceHighlight` 只在 focus 激活后由 `selectionchange`、`input` 或当前块 mutation 触发（被 `pendingFrame` rAF 节流），不每帧扫。`TreeWalker` 遍历文本节点 + 正则切句，开销与旧 span 方案同级，但省掉了 `extractContents`/`insertNode` 的 DOM 读写 + 选区保存/恢复。

#### 4.3.4 相邻块视觉权重（v2.6.0 简化）

```typescript
// 视觉权重：块在视窗中可见高度 / 视窗高度
function visualWeightOf(block: HTMLElement, editorRect: DOMRect): number {
  const rect = block.getBoundingClientRect();
  const visibleTop = Math.max(rect.top, editorRect.top);
  const visibleBottom = Math.min(rect.bottom, editorRect.bottom);
  const visible = Math.max(0, visibleBottom - visibleTop);
  return Math.max(0, Math.min(1, visible / (editorRect.height || 1)));
}
```

当前实现只对 distance=1 的相邻顶层块计算视觉权重；distance≥2 的块直接使用 1.0，避免远块的布局读取。列表深度和块类型系数已移除；嵌套块继承其顶层块的 opacity。

#### 4.3.5 块距离计算（v2.6.0 简化）

> **v2.6.0 更新**：`calculateBlockDistance`/`indexMap` 已移除。现在直接比较 `container.children` 的 index 计算 distance。嵌套块遵循 v1 简化方案（只处理顶层块，嵌套块继承父级 opacity，不递归）。

#### 4.3.6 重新计算接口（v2.5.0 移除）

v2.5.0 重写时删除了 `ripple.recompute` 导出。块级插入（Enter / Backspace）后光标移入新块 → 触发 `selectionchange` → `applyRipple` 自动重算，无需 typewriter 显式调用。typewriter 的 `animateBlockShift` 只负责 FLIP 位移 + 延迟两帧 `checkAndScroll` 对齐舒适区，不再 import ripple（见 §3.7.5）。

#### 4.3.7 触发链（`ripple.ts` `initRipple()`）

```typescript
onSelectionChange():
  applyRipple()       // rAF 节流；内部按 inputMode + shouldPause 决定 apply/clearAll

onInput():
  applyRippleNow()    // 先立即刷新，再排队一次 rAF 刷新
  applyRipple()
```

**注册的事件**：`selectionchange` 和 `input`。两者都通过已有的 rAF 队列合并刷新；`input` 额外先立即刷新一次，以缩短 SiYuan inline tokenizer 重渲染后的空窗。退出场景（wheel / blur / click 关闭 focus）由 inputMode 订阅触发 `clearAll()`。

### 4.4 Q3 mouse 模式 — 已移除（入口可恢复）

**设计意图**（v2.0 时代）：只读模式 / 空闲 2s / 鼠标移到其他块时 → 涟漪从"跟随光标"切到"跟随鼠标"。

**决策历史**：2026-06-30 暂停（代码注释 + 配置保留）；**v2.5.0 重写时彻底移除**——`onMouseMove` / `MOUSE_THROTTLE` / `IDLE_THRESHOLD` / 滚动条缓冲随 ripple.ts 重写删除，config.ts 的 `MOUSE_THROTTLE` / `IDLE_THRESHOLD` 也一并清理。`RippleMode` 类型仍保留在共享类型文件中，但当前 Ripple 不使用它；ripple.ts 现注册 `selectionchange` + `input`，并订阅 inputMode。

**未来恢复路径**（需重建，非取消注释）：
  1. `ripple.ts` 重新实现 `onMouseMove`（视觉权重 + throttle）
  2. `initRipple()` 加 `["mousemove", onMouseMove, { passive: true }]` 注册
  3. `getCurrentBlock()` 加 mouse 模式分支
  4. `config.ts` 重新加 `MOUSE_THROTTLE` / `IDLE_THRESHOLD`
  5. 决定触发条件（只读 / idle / 鼠标进其他块）后启用

**理由**（与高亮条同款）：用户偏好"纯 text 模式"，mouse 模式引入"模式切换"的认知负担，权衡后下线。

### 4.5 配置入口（v2.6.0 更新）

`config.ts` `RIPPLE_CONFIG`：

```typescript
BLOCK_LEVELS: [1.0, 0.4, 0.2, 0.15, 0.1, 0.05]  // 块级 opacity 梯度（按距离衰减，v2.6.0 替换 SENTENCE_LEVELS）
SENTENCE_DIM_ALPHA: 0.6                           // 句级 dimming alpha（v2.6.1 调整）
TRANSITION_SEC: 0.4                               // 块级 opacity 过渡 + 句级 fade 插值时长（秒）
WEIGHT_MIN: 0.85                                  // 视觉权重下限（lerp 起点）
```

> v2.6.0 重构：`SENTENCE_LEVELS`/`EMBED_MULTIPLIER`/`DEPTH_FACTOR` → `BLOCK_LEVELS`/`SENTENCE_DIM_ALPHA`/`TRANSITION_SEC`。句级 dimming 的 alpha 由 `SENTENCE_DIM_ALPHA` 统一控制（之前为硬编码 0.88）。v2.6.1 复用 `TRANSITION_SEC` 作为句级 fade-in/fade-out 的 rAF 插值时长。

### 4.6 TODO

| TODO | 内容 |
|---|---|
| **区分不同的块类型** | `EMBED_MULTIPLIER` 已移除（v2.6.0）。嵌套块继承父级 opacity，不再单独乘系数。若要让特定块类型有不同 dimming 系数，需重新设计 |
| **句级切分边界** | 现按 `[.?!。？！…]+` 切句（v2.6.0 加小数点保护 `(?<!\d)`）；`?!` 组合、中英文标点混合等场景可能需要更精细规则 |
| **块级缓存边界** | 当前缓存依赖 `containerTop/scrollTop/childCount` 三个变量；若 SiYuan 排版变更不改变这些值但影响布局时，缓存可能返回陈旧结果 |

---

## 5. 状态机 (inputMode.ts)

### 5.1 两个 flag + 绑定关系

**Q2 决策（2026-06-30 锁定）**：focus + typewriter **绑定**（不是设计 §2.4 写的"独立"）。

```typescript
let focusActive = false;         // inputMode.ts:15
let typewriterActive = false;    // inputMode.ts:16

// 两个 setter
setBothOn()     // 开启两者
setBothOff()    // 关闭两者
```

> **v2.3.1 移除**：`simulateFocusInput`/`simulateTypewriterInput`/`disableFocus`/`disableTypewriter` 四个命令 setter 已删除（对应命令入口保留但直接调用 `setBothOn`/`setBothOff`）。

**为什么是绑定**：触发规则 90% 共享（keydown/IME 开，wheel/arrows/click 关）→ 解耦成本（80-120 行代码 + 全部测试场景重测）相对收益（"只用打字机不用聚焦"是边缘场景）不划算。**未来如需解耦**：`inputMode.ts` 重构为 8 个独立 setter + cursor.ts click handler 拆分 + typewriter.ts init 不再触发 focus。

### 5.2 触发器全表

| 触发事件 | ON | OFF | Keep ON |
|---|---|---|---|
| keyboard input (`input` event) | ✅ | | |
| IME `compositionend` | ✅ | | |
| 粘贴 (`paste` event) | — | — | — |
| 滚轮 (`wheel`) | | ✅ | | capture 阶段（v2.3.0 修复：`commit 7a368db`） |
| 触屏拖动 (`touchmove`) | | ✅ | | capture 阶段（同 wheel） |
| ↑ 方向键 (`ArrowUp`) | | ✅ | |
| ↓ 方向键 (`ArrowDown`) | | ✅ | |
| Page Up / Page Down | | ✅ | |
| Home / End | | | ✅ |
| ← / → 方向键 | | | ✅ |
| Escape | | | ✅ |
| 鼠标点击 (`click`) | | ✅ | |
| 鼠标拖蓝（mousedown→mouseup 比对 selection） | | ✅ | |
| 切 Tab (`switch-protyle`) | | ✅ | |
| 失焦 (`blur`) | | ✅ | |

> **v2.6.2**：所有 `inputMode.setBothOn/Off()` 调用已集中到 `inputModeTriggers.ts`，业务模块通过语义函数触发（`onTextInput`、`onCompositionEnd`、`onVerticalNavigationKey`、`onWheelOrTouchMove`、`onMouseClick`、`onDragSelection`、`onSwitchProtyle`、`onBlur`、`onEnterOrBackspaceEdit`）。

**Keep ON 触发器**：横向导航（←/→）/ 边界导航（Home/End）/ 取消（Esc）—— 不改变用户"主动编辑"意图。

**v2.3.0 修复历史**：
- ✅ **wheel / touchmove 退出 typewriter/focus 不生效**（commit `7a368db`）：handler 加 `{ capture: true }`（与 keydown/scroll/input 一致）。这本来是早期设计意图（见已归档的 cursor 优化计划），但在 v2.2.0 focus-mode 重构时 capture 被无意遗漏——本次回归修复。剩余两条（嵌套 iframe 排查、暂停 debounce）暂未观察到，可作为后续优化项。

### 5.3 默认值 + 持久化

| 配置 | 值 | 理由 |
|---|---|---|
| 默认状态 | **cursor / typewriter / ripple 均 ON** | `index.ts` 默认配置均为 `true`；初始化 typewriter 时立即开启共享状态 |
| 持久化 | **插件数据持久化** | `index.ts` 通过 `loadData/saveData` 保存 `zentype-enabled`；用户手动切换后的状态会跨会话保留 |
| 空闲超时 | **无** | 设计 §2.3 "No idle timeout" —— typewriter 自然停止（光标不动就不滚） |
| UI 反馈 | **有** | 顶栏银河图标通过 `zentype-topbar-icon--on/off` 反映 typewriter + ripple 是否同时开启 |

### 5.4 订阅机制

```typescript
subscribe(cb) → unsubscribe  // inputMode.ts:30-34
```

订阅时立即收到当前状态。`cursor.ts` 在 `initCursor()` 中订阅用于呼吸恢复同步；每个 subscriber 独立 try/catch（`5a0251d` commit），一个抛错不影响其他。

### 5.5 重置（onunload）

`index.ts` 的生命周期清理调用 `inputMode.reset()` —— focusActive/typewriterActive 清零 + subscribers 清空。

---

## 6. 命令面板

当前提供 3 个命令（v2.6.5）：

| 命令 langKey | 回调 | 效果 |
|---|---|---|
| `toggle-typewriter` | `toggle("typewriter")` | 切换打字机模式 on/off |
| `toggle-ripple` | `toggle("ripple")` | 切换涟漪聚焦 on/off |
| `toggle-type` | `toggleType()` | 联合切换打字机 + 涟漪（cursor 始终启用） |

> **历史**：v2.3.0 前曾有 4 个 enable/disable 命令（`enable-focus-mode`、`enable-typewriter-mode`、`disable-focus-mode`、`disable-typewriter-mode`），在 Q2 绑定决策后简化为 toggle。

**入口**：
- 思源 → 设置 → 插件 → zenType → 命令面板（Ctrl+Shift+P）
- 顶栏图标（银河系 SVG，`index.ts`）：一键 `toggleType()` 联合切换打字机 + 涟漪（cursor 常开）
- 思源 → 设置 → 插件 → zenType → 关闭/启用插件（触发 onunload+onload 重载）

**顶栏图标设计**（当前实现）：
- `index.ts` 内联一个银河系 SVG，容器通过 `zentype-topbar-icon--on/off` 表示联合状态
- 开启态让行星组以 9s / 13s 两档旋转；关闭态只降低饱和度和透明度
- 点击图标调用 `toggleType()`，只联合切换打字机 + 涟漪，顺滑光标始终开启

**为什么是 3 个 toggle 命令**：
- `toggle-typewriter` 和 `toggle-ripple` 支持单独切换
- `toggle-type` 提供顶栏图标使用的联合切换
- 光标不参与联合开关，始终由插件初始化

---

## 7. 边界场景

| 场景 | 顺滑光标 | 打字机 | 涟漪 | 实现 |
|---|---|---|---|---|
| 打开文档，不输入 | ✅ 显示（最后位置 + 静态） | ✅ 已激活，越界时在后续检查中对齐 | ✅ 已激活（有有效光标/当前块时应用） | `initTypewriter()` 调 `onTextInput()`；`initRipple()` 启用模块 |
| 多行选中 | ✅ 瞬跳到选区末尾 | ❌ 暂停 | ❌ 暂停 | `shouldPauseFocusAndTypewriter()` returns true |
| 悬浮窗编辑 | ✅ 显示 | ❌ 暂停 | ❌ 暂停 | `isInPopup()` 检测 `.block__popover--open` |
| 只读模式 | ❌ 不显示 | ❌ 暂停 | ⚠️ 不主动应用只读门禁 | `isReadMode()` 只在 typewriter 路径检查；Ripple 主要按 focus 状态、选区和悬浮窗清理 |
| 嵌入块（iframe/video/PDF） | ❌ 不显示 | ❌ 跳过 | ✅ 作为 1 个渐淡单位 | `isInEmbedBlock()`；Ripple 按当前块的顶层 block 处理 |
| 嵌套块（v1 简化） | ✅ 显示 | ✅ 滚到舒适区间 | ⚠️ 只按顶层块渐淡，嵌套块继承 | `container.children` 距离计算，不递归 |
| 切 Tab | ✅ 切换光标 | ❌ 退出 | ❌ 退出 | `index.ts` `switch-protyle` handler → `onSwitchProtyle()` |
| 失焦 | ✅ 停在最后位置 | ❌ 退出 | ❌ 退出 | `cursor/events.ts` `blur → inputModeTriggers.onBlur()` |
| 滚轮 / 触屏拖动 | ✅ 跟随 + 暂停呼吸 | ❌ 退出 | ❌ 退出 | `cursor/events.ts` wheel/touchmove → `inputModeTriggers.onWheelOrTouchMove()` |
| ↑ / ↓ / PageUp / PageDown | ✅ 移动 | ❌ 退出 | ❌ 退出 | `cursor/events.ts` keydown → `inputModeTriggers.onVerticalNavigationKey()` |
| ← / → / Home / End / Esc | ✅ 移动 | ✅ 保持 | ✅ 保持 | 不调 setBothOff |
| 粘贴 | ✅ 移动 | ❌ 不触发开 | ❌ 不触发开 | `cursor/events.ts` `isPasting=true` → input handler 跳过 |
| 方向键 ↑ 后再 ← | ✅ 移动 | ❌ 保持 OFF | ❌ 保持 OFF | 状态机单调退出 |
| 鼠标拖蓝选文本 | ✅ 瞬跳 | ❌ 退出 | ❌ 退出 | `cursor/events.ts` mouseDown 记录 → mouseup 比对 → `inputModeTriggers.onDragSelection()` |
| 右键菜单 | ✅ 停在最后位置（静态） | ✅ 不影响 | ✅ 不影响 | `cursor.ts` `onMenuOpened → pauseBreathe()` |
| 移动端标题编辑 | ❌ 不显示 | ⚠️ 走通用边界 fallback，未单独处理 | ❌ 不参与 | `cursor.ts` 有移动端标题 guard；`boundary.ts` 标题分支提供 `editorRect`；ripple 仍要求 `.protyle-wysiwyg` 当前块 |
| 移动端键盘弹出/收起 | ✅ 重定位 | ✅ 重定位 | ✅ 重定位 | `mobile-keyboard-show/hide` EventBus |
| 分屏（split-screen） | ✅ 锁定活跃编辑器 | ✅ 锁定活跃编辑器 | ✅ 锁定活跃编辑器 | `isInAllowElements` 第一重 `getActiveEditor()` |
| AV 数据库块 | ❌ 不显示 | ❌ 不滚 | ❌ 不参与 | `boundary.ts` 排除 `.av/.av__mask/.av__cursor` |

---

## 8. 配置参数（`src/config.ts`）

### 8.1 完整参数表（v2.6.5 更新）

| 模块 | 配置块 | 参数 | 默认 | 说明 |
|---|---|---|---|---|
| 顺滑光标 | `CURSOR_CONFIG` | `HEIGHT_RATIO` | `1.05` | 光标高度 = 行高 × 此倍数 |
| 顺滑光标 | `CURSOR_CONFIG` | `BLINK_DELAY_MS` | `1100` | 停止活动后多少毫秒恢复呼吸 |
| 顺滑光标 | `EDGE_FADE` | `ZONE` | `20` | 距编辑器顶/底多少像素内淡出 |
| 顺滑光标 | `EDGE_FADE` | `MIN_SCALE` | `0.6` | 完全离屏时最小缩放 |
| 顺滑光标 | `TRANSITION` | `TIERS` | `≤30→0.07s, ≤150→0.15s, ≤500→0.21s, >500→0.30s` | 距离分档过渡时长 |
| 顺滑光标 | `EDGE_ARROW` | `ENABLED` | `false` | 边缘箭头总开关（当前默认关闭） |
| 顺滑光标 | `EDGE_ARROW` | `OPACITY` | `0.6` | 箭头透明度 |
| 顺滑光标 | `EDGE_ARROW` | `SIZE` | `12` | 三角形大小（px） |
| 顺滑光标 | `EDGE_ARROW` | `OFFSET` | `8` | 距视口边缘距离（px） |
| 顺滑光标 | `EDGE_ARROW` | `TRANSITION_MS` | `200` | 淡入淡出过渡时长 |
| 打字机 | `TYPEWRITER_CONFIG` | **`COMFORT_ZONE`** | **`[0.38, 0.50]`** | **v2.3.0：舒适区间 [低, 高]；区间内不触发滚动** |
| 打字机 | `TYPEWRITER_CONFIG` | **`SCROLL_DURATION_TIERS`** | **`[180, 260, 360, 480, 600]` ms** | **v2.3.0：距离分档时长（从 typewriter.ts 移入 config）** |
| 打字机 | `TYPEWRITER_CONFIG` | **`SCROLL_CURVE`** | **`cubic-bezier(0.25, 0.1, 0.25, 1)`** | **v2.3.0：动画曲线（与光标一致）** |
| 打字机 | `TYPEWRITER_CONFIG` | `TYPING_GAP_MS` | `400` | 连续键入与停顿的 debounce 阈值 |
| 打字机 | `TYPEWRITER_CONFIG` | `CLICK_CENTER_LOW` / `CLICK_CENTER_HIGH` | `0.25` / `0.75` | 点击后超出此区间才主动居中到 0.5 |
| 涟漪 | `RIPPLE_CONFIG` | **`BLOCK_LEVELS`** | **`[1.0, 0.4, 0.2, 0.15, 0.1, 0.05]`** | **v2.6.0：块级 opacity 梯度（替换 SENTENCE_LEVELS）** |
| 涟漪 | `RIPPLE_CONFIG` | **`SENTENCE_DIM_ALPHA`** | **`0.6`** | **v2.6.1 调整：句级 dimming alpha** |
| 涟漪 | `RIPPLE_CONFIG` | **`TRANSITION_SEC`** | **`0.4`** | **v2.6.1 复用：块级 opacity 过渡 + 句级 fade 插值时长（秒）** |
| 涟漪 | `RIPPLE_CONFIG` | `WEIGHT_MIN` | `0.85` | 视觉权重 lerp 下限 |

### 8.2 "暂停功能"入口

| 入口位置 | 状态 | 未来恢复路径 |
|---|---|---|
| `config.ts` 中的高亮条注释块 | 永久下线 | 4 步：typewriter.ts 重写 + index.scss 加 CSS + 测试场景重跑 |
| ~~`MOUSE_THROTTLE` + `IDLE_THRESHOLD`~~ | v2.5.0 移除 | 需重建：ripple.ts 重写 `onMouseMove` + `initRipple` 注册事件 + `config.ts` 重新加配置 + 决定触发条件（§4.4） |
| squish/bounce 触发函数（已从代码中删除） | 永久下线 | git history `0ee73ed` 之前恢复 + SCSS keyframes |
| `config.ts` 文件末尾的 SCSS 锁死开关注释 | 暂未开放 | 待 SCSS 编译策略改造 |

---

## 9. 决策历史

### 9.1 三大模式的设计阶段

| 阶段 | 时间 | 关键决策 |
|---|---|---|
| v1 (ZenType) | 2024 之前 | 单文件 + 模板技术栈；思源早期 API；无设置面板 |
| **v2.0 (推倒重做)** | 2026-06-27 | TS + esbuild + sass；3 模块独立；高亮条 + 鼠标中心聚焦作为 v1 附带特性 |
| **v2.1.0 (Cursor 优化)** | 2026-06-29 | 4 个 cursor P0 BUG 修复；6 项架构决策；新增 5 文件 |
| **v2.2.0 (P2 EventBus)** | 2026-06-29 | 全面迁移到官方 EventBus；getActiveEditor/getFrontend 替代 DOM 遍历 |
| **v2.2.1 (Cursor Edge + Typewriter)** | 2026-06-30 | Plan 6 cursor 边缘交互 + typewriter 重写（isInAllowElements + editorRect） |
| **v2.3.0 (Typewriter Range + Block Insertion + Ripple Sentence)** | 2026-06-30 | 舒适区间 + 曲线原语 + 块级插入 FLIP + 涟漪句级 + 列表动态算法 + 雾边圆环图标 + wheel exit 修复 |
| **v2.5.0 (Ripple Highlight API + CR 收尾)** | 2026-07-03 | ripple 句级从 span 包裹重写为 CSS Custom Highlight API（零 DOM 突变，修复数据丢失 bug）；P1-1/P2-3/P2-5/P3-7/P3-8 代码审查修复；TODO-6 首字滚动修复 |
| **v2.6.0 (Ripple 性能优化 + 配置重构)** | 2026-07-03 | buildTextNodeMap 单次 TreeWalker + 二分查找；块级缓存 + 远块跳过；BLOCK_LEVELS/SENTENCE_DIM_ALPHA/TRANSITION_SEC 替换旧配置；嵌套块 opacity 继承；删除 isRippleTargetBlock 等死代码 |
| **v2.6.1 (Typewriter 修复 + Ripple 句级 fade)** | 2026-07-03 | typewriter 连续输入/点击居中修复；ripple 句级 fade-in/fade-out；当前块 opacity 强制 1.0，避免当前句稳定态偏淡 |
| **v2.6.5 (非空块尾部光标定位修复)** | 2026-08-21 | 非空块中的空 Text 节点使用相邻真实文本节点边界 Range 回退，修复 ArrowDown 后视觉光标与实际输入位置不一致 |

### 9.2 cursor 模块决策（Round 5 → Round 11）

| Round | 内容 | commit |
|---|---|---|
| Round 5 | 4 个原始 cursor BUG（呼吸 / 高度 / 移动动画 / 边界检测） | — |
| Round 7 | P0 完整重构（6 决策 + 5 新文件） | — |
| Round 8 | 兼容性 refactor（删双函数） | — |
| Round 9 | P1 + 动画 + A1-A9 兼容性 | — |
| Round 10 | 直角矩形 + 参数可配置 | — |
| Round 11 | P2 EventBus 迁移 + Reviewer 批准 | — |

### 9.3 Plan 6 cursor 边缘交互（2026-06-30）

| TODO | 内容 | commit |
|---|---|---|
| TODO-1 | 初始 cursor "whoosh" 修复（`.no-transition` 元素进 DOM 即加） | `ba0bcea` |
| TODO-2 | 边缘箭头默认关闭（`EDGE_ARROW.ENABLED = false`） | `84193de` |
| TODO-3 | 边缘定义收紧（`EDGE_FADE.ZONE: 60 → 30`，后续用户手动 → 20） | `924c337` |
| TODO-4 | 滚出顶部和底部动画对称 | `c168586` |
| Q-return | 返回方向 instant jump 修复（`wasOffScreen` + force-remove `.no-transition`） | `1ea9891` |
| (0,0) 跳 | SCSS keyframes 用独立 `scale:` 属性 | `282a964` |
| Q7 | 距离→时长搬到 `TRANSITION.TIERS` 分档表 | `0ee73ed` |
| squish/bounce | 用户测试反馈"像弹弓"删除 | `0ee73ed` |

### 9.4 typewriter 模块决策（v2.2.1）

| commit | 决策 |
|---|---|
| `fcfbf95` | 重构滚动逻辑：用 `isInAllowElements` + `editorRect` + `setBothOn()` 解决 3 大根因；rAF debounce + container cache + 动画续接 + 距离分档时长 |
| `2f9c39a` | smoothScroll 改用 scrollable 祖先（不再用 `getEditorContainer()`） |
| `1229f45` | 删除高亮条 DOM/CSS（**Q1 永久下线**） |
| `9fd31c2` | 同步 typewriter 修复计划文档 |
| `2808caa` | `isReadMode` 检查 `cursor.isContentEditable` 而非 `.protyle-content.isContentEditable`（修复只读文档/标题兼容性） |

### 9.5 focus/typewriter 设计（2026-06-30）

| commit | 决策 |
|---|---|
| `63ab96b` | 初始实施 Option A（全局 inputMode 状态 + 订阅） |
| `5a0251d` | 订阅立即收到当前状态 + per-subscriber try/catch |
| `48e7e9d` | breathing 与 focus 模式解耦（光标始终呼吸，仅 focus ON 触发 scheduleResumeBreathe） |
| `53dfb55` | 重命名 toggle-focus/toggle-typewriter → enable-/disable-，4 个命令代替 2 个 toggle |

### 9.6 本次文档合并（2026-06-30）

| 决策 | 来源 |
|---|---|
| **Q1 高亮条永久下线** | 实施已下线 + 用户偏好"纯滚动" |
| **Q2 focus/typewriter 绑定** | 设计文档原本说"独立"，但实施后绑定；本次决定"代码即真相"，设计跟随 |
| **Q3 涟漪自动启用 + mouse 模式暂停** | 与当前初始化行为一致；mouse 模式入口保留 |
| **Q4 命令 4 个** | enable/disable × 2，Q2 绑定下 toggle 不够 |
| **DESIGN.md 合并** | 散落文档（CONTINUATION/FOCUS_TYPEWRITER/CURSOR_ANIMATION_DECISIONS 等）已过时且重复 |

### 9.7 v2.3.0 决策（2026-06-30）

| 决策 | 内容 | 来源 |
|---|---|---|
| **舒适区间 [38%, 50%]** | typewriter 目标位置改为区间，区间内不滚 | 用户测试：38-50 都接受 |
| **smoothScroll 曲线原语** | `smoothScroll(el, {deltaY, duration, curve})`，不规定方向 | 块级插入动画需要"指定 deltaY"的版本 |
| **动画曲线配置化** | `SCROLL_CURVE = cubic-bezier(0.25, 0.1, 0.25, 1)`，与光标一致 | 用户偏好"自然、有曲线、顺滑" |
| **块级插入动画** | FLIP + animateBlockShift | 参考 cursor.ts round 4 fix；`markBlockInsertPending` 已在 c5bfdc9 删除 |
| **块级插入无 opacity 渐变** | 上块让位 = smoothScroll 视窗滚；下块补位 = FLIP；新块 = 1.0 直接出现 | 用户反问"新块默认不就是 1 吗" |
| **位移幅度 = reflow delta** | FLIP 位移 = 块实际被推的距离，非硬编码 px | 用户纠正"不是固定 ±4px" |
| **涟漪句级 opacity** | `[1.0, 0.88, 0.72, 0.55, 0.42]` 5 档（句级 + 块级） | 用户偏好"看清整句"，不只是块 |
| **涟漪嵌入块 ×0.85** | `EMBED_MULTIPLIER` 修正视觉权重 | 嵌入内容视觉权重低 |
| **涟漪列表块动态算法** | Q5 = C：视觉权重 × 深度系数 | 列表项高度差异大，siblings 距离不够准 |
| **TODO: 区分不同块类型** | 嵌入网页 / 嵌入笔记 / PDF / video / 代码块 / HTML 块各不同 | 用户要求；当前统一 ×0.85 太粗 |
| **顶栏图标单圆环雾边** | `feGaussianBlur stdDeviation=0.4` 雾边 + breathe 动画，**不是同心圆** | 用户明确"单圆环 + 雾蒙蒙边缘" |
| **wheel exit bug 修复** ✅ | wheel handler 加 `{ capture: true }`（commit `7a368db`）—— 与 keydown/scroll/input 一致 | 用户报告"滚轮退出 typewriter/focus 没有实现" |
| **清理文档** | 删 5 个过时 doc；CHANGELOG 移到 docs/；归档 6 个旧 plan | 文档漂移严重 |

### 9.8 v2.5.0 决策（Ripple Highlight API 重写）

| 项 | 决策 | 理由 |
|---|---|---|
| Ripple 句级 dimming | span 包裹 → CSS Custom Highlight API | span 的 `extractContents`+`insertNode` 分裂文本节点，破坏 SiYuan selection 语义 → 光标跳位 → 内容删除（数据丢失 bug） |
| `::highlight` 不支持 opacity | 用 `color: rgba()` 模拟（`--zt-sentence-dim-color`） | 块级 opacity 保留（SiYuan 不动块本身），句级用颜色 |
| ripple 订阅 inputMode | `focusActive→false` 时 `clearAll()` | wheel/blur/click 不触发 `selectionchange`，旧路径漏清导致透明度残留（P1-1） |
| FLIP transition 泄漏 | `lastFLIPElements` 跟踪 + 新 FLIP 入口清理 | `|delta|<2` 跳过的元素残留 `transition: transform 250ms`（P3-7） |
| EMBED_MULTIPLIER 死代码 | 删 `isEmbedBlock` 函数 + 乘数；config 保留作文档 | `isRippleTargetBlock` 已排除 embed 类型，乘数不可达（P2-5） |
| smoothScroll 合并路径 | 删除死代码，保留 drop 策略 | `isScrolling()` guard 使合并路径不可达（P2-3，TODO-5 设计） |

### 9.9 v2.6.0 决策（2026-07-03）— Ripple 性能优化 + Config 重构

| 决策 | 内容 | 理由 |
|---|---|---|
| BLOCK_LEVELS 替换 SENTENCE_LEVELS | 块级 opacity 梯度从 `[1.0, 0.88, 0.72, 0.55, 0.42]` → `[1.0, 0.4, 0.2, 0.15, 0.1, 0.05]` | 参考 Obsidian focus 模式，更明显的聚焦效果 |
| SENTENCE_DIM_ALPHA 新增 | 句级 dimming alpha 统一为 0.7（v2.6.1 调整为 0.6） | 替代 EMBED_MULTIPLIER/DEPTH_FACTOR 组合，简化配置 |
| TRANSITION_SEC | 块级 opacity 过渡 0.4s | 让 dimming 变化自然 |
| buildTextNodeMap + resolveTextNodeAt | 单次 TreeWalker + 二分查找 | 复杂度 O(S*T) → O(T+S log T) |
| 块级缓存 | 同一块 + 无滚动 + 无改动时跳过 | 减少 DOM 读，优化帧率 |
| 嵌套块继承 | 只设顶层块 opacity，嵌套块继承 | 避免 opacity 叠加（父 0.5 × 子 0.5 = 0.25） |
| 远块跳过 | distance≥2 跳过 getBoundingClientRect | 不可感知的差异不回读布局 |
| 删除死代码 | isRippleTargetBlock/depthOf 等全部删除 | 简化维护面 |
| 句子分割加省略号 | 正则加 `…` + 小数点保护 `(?<!\d)` | 用户有省略号分段需求 |

### 9.10 v2.6.1 决策（2026-07-03）— Typewriter 修复 + Ripple 句级 fade

| 决策 | 内容 | 理由 |
|---|---|---|
| 句级 fade-in/fade-out | 新当前句 `dimColor → textColor`，旧当前句 `textColor → dimColor`，由 `requestAnimationFrame` + `easeInOutCubic` 驱动 | CSS Custom Highlight API 不支持 transition；多 highlight 名称能在零 DOM 突变下表达两个临时动画层 |
| fade 复用缓存 | 基于 `lastCaretSentenceRange` 判断当前句 start 是否变化 | 光标在同一句内移动不重建动画，只有跨句切换才启动 fade |
| 稳定 dim 排除动画两端 | 动画期间 `zt-sentence-dim` 同时排除旧当前句和新当前句 | 避免稳定 dim 与 fade 临时 highlight 重叠导致颜色优先级不确定 |
| 当前块 opacity 固定 1.0 | `distance === 0` 不再乘 `visualWeightOf` | 修复当前块在视窗边缘时整体 opacity 小于 1，导致当前句比非聚焦模式淡 |
| SENTENCE_DIM_ALPHA 调整 | `0.7 → 0.6` | 拉开当前句与非当前句的可见对比 |

### 9.11 v2.6.2 决策（2026-07-05）— 保行为架构重构（Tasks 0-4）

| 决策 | 内容 | 理由 |
|---|---|---|
| cursor.ts 子模块拆分 | 事件注册→`events.ts`、滚动绑定→`scrollBindings.ts`、switch-settle→`switchSettle.ts`、ResizeObserver→`resizeBindings.ts`、popover 拖动→`popoverDrag.ts`、边缘箭头→`edgeArrow.ts`（此前已完成） | cursor.ts 从 674 行降到 ~450 行，职责集中为核心循环 + EventBus 适配，降低后续修改跨行为风险 |
| inputModeTriggers 适配层 | 所有 `inputMode.setBothOn/Off()` 调用集中到 `inputModeTriggers.ts` 的 9 个语义函数；`cursor/events.ts`、`typewriter.ts`、`index.ts` 通过语义函数触发 | 消除 Shotgun Surgery：修改"什么时候开启/退出聚焦和打字机"时只需改一处（Brooks sweep #2 修复） |
| 上下文注入模式 | 子模块接收 context 对象（如 `getCursorElement`、`queueUpdate`、`pauseBreathe`、`isKeyboardUpdatePending`），不直接闭包捕获父模块状态 | 子模块可独立理解/测试，与 cursor.ts 保持松耦合 |
| FLIP 采样优化 | 从全编辑器扫描改为围绕选区 sibling 窗口 + 祖先层级采样（`FLIP_BLOCK_RADIUS = 30`） | 减少长文档 DOM 遍历开销，保留 fallback 到全量扫描 |

### 9.12 明确推迟项

| 项 | 状态 | 来源 |
|---|---|---|
| 软链接决策（#1） | 推迟，3 个选项未选 | 跨 Windows 管理员权限问题 |
| P2-4 SCSS → JS 字符串 | 推迟 | 与现有 ESBuild sass plugin 架构冲突 |
| P2-5 breathing.ts 改 rAF | 推迟 | setTimeout 500ms 是 idle 超时检测语义，rAF 16ms 无法替代 |
| focus/typewriter 解耦 | 推迟到 v2.3+（Q2 = A） | 触发规则 90% 共享，解耦 ROI 低 |
| `__zentypeScrollBound` toggle 残留 | known limitation | reviewer F3 评估为非阻塞 |
| `SMOOTH_ENABLED` / `BLINK_ENABLED` / `APPLY_TO_TITLE` / `USE_IN_MOBILE` 开关 | 未开放（CSS 编译期锁死） | 待 SCSS 编译策略改造 |
| 嵌套块递归渐淡 | 推迟到 v2+ | 暂未收到用户反馈 |
| 高亮条（永久下线） | 仅保留 `config.ts` 注释说明 | 见 §3.5 |
| mouse 涟漪（暂停） | 入口保留 `RippleMode` + config | 见 §4.4 |
| squish/bounce 边缘动画（永久下线） | 入口保留注释 | 见 §2.4 |
| 边缘箭头指示器 | 入口保留（`EDGE_ARROW.ENABLED = false`） | 见 §2.3.5 |

---

## 附录 A：跨平台说明

**Workspace 路径冲突**：作者在两台电脑开发，思源工作区路径不同：
- `D:\SiYuan\data\plugins\siyuan-zen\`
- `F:\Documents\九畴\data\plugins\siyuan-zen\`

`scripts/make_dev_link.js` 自动按以下顺序查找：
1. 环境变量 `SIYUAN_WORKSPACE`
2. 命令行 `--workspace <path>`
3. 默认值 `~/Documents/SiYuan/`

任何路径均可，两台电脑任一。

## 附录 B：版本号

| 文件 | 当前 | 备注 |
|---|---|---|
| `package.json` `version` | `2.6.5` | v2.6.5 当前版本 |
| `plugin.json` `version` | `2.6.5` | 同上 |
| `docs/CHANGELOG.md` | ✅ 已维护 | 位于 docs/CHANGELOG.md，覆盖 v2.0~v2.6.5 |

> 当前发布版本为 v2.6.5；v2.6.2 为保行为架构重构里程碑，v2.6.4 修复集市包文档打包，v2.6.5 修复非空块尾部光标回退定位。`version` 字段从 v2.3.0 → v2.5.0（跳过 2.4，Highlight API 重写）→ v2.6.0 → v2.6.1 → v2.6.2 → v2.6.3 → v2.6.4 → v2.6.5。

---

**最后更新**：2026-08-21（v2.6.5 非空块尾部光标定位修复）
