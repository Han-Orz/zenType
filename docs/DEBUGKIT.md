# DebugKit

DebugKit 是 zenType 的本地调试记录器，用来回答“事件发生了什么、Session 读到了什么、Cursor/Ripple 做了什么”。它不是性能基准工具，也不改变编辑器的 Selection、输入或 DOM 结构。

## 默认模式

开发构建默认自动启动 `full` 会话：

```bash
npm run build:dev
```

正式构建通过 `debugHook.noop.ts` 替换 DebugKit，不注册监听器、不读取 DOM、不创建 observer、timer 或 rAF：

```bash
npm run build
```

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
- Ripple 记录 target 数量、ownership handoff、release/transfer 计数和 sentence render 状态；
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

Full 快照可能读取 `getBoundingClientRect()`、`getComputedStyle()`、Selection 和有限 DOM 树，因此会改变极端时序。它适合定位事件顺序、结构替换和视觉 ownership 问题，不适合直接作为性能基线。

性能基线应使用关闭 DebugKit 的构建，并结合浏览器 Performance 面板；DebugKit 中的 `computedStyleReads`、`domNodesSerialized` 和 Mutation 计数只用于解释采集本身及问题关联。
