# DebugKit

DebugKit 是 zenType 的本地调试记录器，用来回答“事件发生了什么、Session 读到了什么、Cursor/Ripple 做了什么”。它不是性能基准工具，也不改变编辑器的 Selection、输入或 DOM 结构。

## 默认模式

开发构建默认自动启动 `full` 会话：

```bash
npm run build:dev
```

正式构建不是运行时 noop。esbuild 会删除所有 `ZENTYPE_DEBUG:` 标记的诊断语句，并把只在开发分支调用的 installer、controller、recorder、snapshot、serialization 和 export 模块整体 tree-shake 掉：

```bash
npm run build
npm run verify:prod
```

`verify:prod` 同时构建 production/development，检查 `dist/index.js` 和 `package.zip` 内的脚本，禁止 DebugKit implementation/event marker，并证明 development 仍保留完整 DebugKit。production 不生成会保留 `sourcesContent` 的 source map；development 保留完整 map。业务源码里的 label 只标记可完全删除的诊断 statement；正确性逻辑不得藏在 label 中。

Full 会话同时保留两类有界记录：

- timeline：最多 4096 个事件；
- forensic：最多 8192 个事件；
- recent：最多 500 个事件预览；
- DOM 树最多 1200 个节点、12 层；
- 单段文本最多 2000 个字符，单个属性最多 300 个字符；
- 单个 Mutation 批次最多序列化 80 条记录。

“有界”是为了防止长时间运行无限占用内存，不代表使用轻量字段。Full 默认包含文本、Selection、DOM 路径、几何和相关 computed style。导出的 JSON 应按敏感数据处理。

## 采集边界

WritingSession 已经拥有文档事件、MutationObserver、ResizeObserver、唯一 rAF、共享 wake timer 和 `EditorFrame`。DebugKit 复用这些边界：

- Session 记录事件、dirty flags、frame、scroll 写入和生命周期；
- Cursor 记录现有渲染路径中的位置、目标、alpha、owner、呼吸和 release 状态；
- Ripple 记录 target / owner 数量、replacement carry、ownership commit 和 sentence render 状态；
- DebugKit 只在 session start/stop、手动 capture 或事件记录时做有界快照；
- DebugKit 不建立第二套 host observer、rAF 或 timer；
- DebugKit 异常被隔离，不应进入 Session 的 presentation failure 路径。

## 使用

开发构建加载后，全局 API 可用：

```js
const debug = globalThis.__zentypeDebug;
await debug.stop();
const json = debug.exportRecording();
```

也可以使用开发命令：

- `zenType：切换 DebugKit`
- `zenType：导出 DebugKit`

`切换 DebugKit` 会明确提示“已开始”或“已结束”。开发构建加载时会自动开始一次全量会话，也会显示开始提示。

导出发生在会话结束之后：如果当前仍在采集，`导出 DebugKit` 会先结束会话、提示“已结束，正在导出”，再导出这次已结束的记录；导出完成后不会自动重新开始，需要再次执行切换命令。

## 诊断限制

### v2.9.0-remake.2.6 Ripple Focused Owner Playback

Session 的 `structure-*` 事件来自共享 gate，不增加 snapshot、observer 或 scheduler：

- `structure-intent`：输入可能编辑结构，尚无宿主证据；若可得，同时记录 `fromBlockKey`。
- `structure-generation-superseded`：新的明确结构输入替换同一 editor 的旧 pending generation；presentation 保持不变。
- `structure-begin` / `structure-evidence`：mutation classifier 发现结构变化或观察预算溢出。
- `structure-activity`：input、Selection 或 mutation 打断了安静窗口。
- `structure-sample`：intent 阶段记录 input/non-structural observation 与等待/ordinary 原因；evidence 阶段记录 caret、quiet、stableFrames、`geometryReady`、`semanticReady` 与等待/geometry/commit 原因。
- `structure-geometry-ready`：同一 generation 的连续可信 caret geometry 首次达到两次稳定采样；只授权 Cursor，不代表 Ripple/Typewriter 已获得 semantic commit。结构样本带有 `topologyChanged`、`fromBlockKey`、`toBlockKey`、`geometryReady` 和 `semanticReady`。
- `ordinary-delete-admitted`：严格的 characterData-only、折叠且位于文本节点安全删除方向的 Backspace/Delete 直接通过 ordinary admission；Backspace 要求左侧有字符，Delete 要求右侧有字符。
- `structure-stable` / `structure-commit`：安静窗口和连续几何采样通过，允许统一提交。
- `structure-timeout` / `structure-release`：没有证明稳定，释放效果；不能把它当成成功提交。
- `structure-cancel`：ordinary 已经通过 strict fast admission 或 quiet confirmation，或用户抢占、生命周期取消。

Cursor 的 `render` 事件记录 `intent`（`typing` / `navigation` / `structural`）以及 `currentX/currentY`、`targetX/targetY`、`xVelocity/yVelocity/heightVelocity`，用于区分错误的 typing response、陈旧 target 和 velocity carry。`targetAuthority` 为 `fresh` 或 `carry`：fresh 表示 Session 已授予新的 Host caret target，此帧会先重置 transport baseline；carry 表示仍在承载旧 target，此帧保留现有 origin/scroll/nested-scroll transport。`transportDx/transportDy` 与 `transportApplied` 只描述该次 presentation transport。这里的 `intent` 是当前 authoritative target 的 provenance，不是长期 Session mode；同一 structural target 到 semantic commit 仍保持 `structural`。开发构建激活时的提示包含 build label 与 short SHA；production 不保留该提示或 DebugKit。Ripple 的 `presentation-hold`、`focused-handoff`、`replacement-carry`、`ownership-commit`、`stale-recovery` 与 `ownership-limit` 解释暂停、geometry-ready 的单 owner 提升、旧 owner 接管、最终计划、低频异常生命周期回收和有界退让；`focused-handoff` 记录 `fromBlockKey`、`toBlockKey`、`hadOwner`、`previousValue`、`previousTarget`、`newTarget`、`playStateBefore` 与 `playStateAfter`。`ownership-commit` 额外提供 changed-only 的 `changes`，包含 `key`、`previousValue`、`startValue`、`target` 和 `hadPreviousKey`，最多保留 16 条，并用 `changedCount` / `truncated` 表示截断。`blockCount` 表示内存中持有的 WAAPI effects；正常 block 绘制不再生成 `.zentype-ripple-block` 或 inline opacity。动画 id 为 `zentype-ripple`，仅用于精确识别插件所有权，不是 DOM 属性或持久 registry。

仓库未包含此次用户提到的原始 DebugKit JSON；不能把人工序列或代码推断标成 trace-derived evidence。deterministic ordering 已自动测试；当前环境没有 Docker、本地思源进程或 Chromium binary，因此没有把 marker/布局连续性标成真实宿主观测。

Full 快照可能读取 `getBoundingClientRect()`、`getComputedStyle()`、Selection 和有限 DOM 树，因此会改变极端时序。它适合定位事件顺序、结构替换和视觉 ownership 问题，不适合直接作为性能基线。

性能基线应使用关闭 DebugKit 的构建，并结合浏览器 Performance 面板；DebugKit 中的 `computedStyleReads`、`domNodesSerialized` 和 Mutation 计数只用于解释采集本身及问题关联。
