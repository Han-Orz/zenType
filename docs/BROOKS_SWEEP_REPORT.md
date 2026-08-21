# Brooks Sweep 审查报告

日期：2026-07-05

## 概览

本次审查按 `brooks-sweep` 的 Full Sweep 思路执行，范围为整个仓库约 42 个已跟踪文件。由于项目当前没有自动化测试，实际自动修复严格限制在单文件、局部、行为不变的安全清理；涉及模块拆分、公共接口调整、状态机重排的内容均保留为后续人工确认项。

结论：当前实现整体可运行且关键性能热点已经做过优化，但架构上仍处于“稳定功能 + 历史修补层叠”的状态。后续最适合采用小步、保行为的重构，而不是一次性重写。

## 已应用的安全修复

| 文件 | 类型 | 内容 |
|---|---|---|
| `src/utils/getCursorRect.ts` | 死代码清理 | 移除未使用的 `getCursorElement` import；同步过时的 `lineHeight × 1.1` 注释 |
| `src/modules/ripple.ts` | 死代码清理 | 移除未调用的 `rangesEqual()` 和未使用的 `text` 局部变量；同步 ripple 默认状态注释 |
| `src/modules/cursor.ts` | 冗余清理 / 配置接线 | 移除未使用的 `mousedown` 事件参数；将 `EDGE_ARROW.OPACITY/SIZE/OFFSET/TRANSITION_MS` 接入 CSS 变量；修正旧 boundary 注释 |
| `src/config.ts` | 注释清理 | 移除已下线高亮条的 CSS 配置提示，去掉“早期迭代期”过时说明 |
| `README.md` / `README_zh-CN.md` | 文档同步 | 同步顶栏按钮语义：只切换打字机 + 涟漪，顺滑光标常开；同步 `BLINK_DELAY_MS = 1100` |

## 跟进重构记录

2026-07-05 已按”小步、保行为、理架构”的原则分步执行（Tasks 0-4）：

1. `src/modules/cursor/edgeArrow.ts`：接管边缘箭头的 DOM 创建、定位、显示、隐藏和销毁状态（此前已完成）。
2. `src/modules/cursor/scrollBindings.ts`：接管滚动祖先事件绑定（scroll/wheel，passive）。
3. `src/modules/cursor/switchSettle.ts`：接管切换 protyle 后的隐藏/稳定/淡入状态机。
4. `src/modules/cursor/events.ts`：接管全部 13 条 document 事件注册和释放。
5. `src/modules/cursor/resizeBindings.ts`：接管 protyle-content / protyle-wysiwyg 的 ResizeObserver。
6. `src/modules/cursor/popoverDrag.ts`：接管 block__popover 拖动手柄绑定。
7. `src/modules/inputModeTriggers.ts`：集中所有 `inputMode.setBothOn/Off()` 调用为 9 个语义函数。
8. `src/modules/cursor.ts`：只保留核心循环（`doUpdateCursor`）和 EventBus 适配，不再持有子模块状态。从 ~674 行降至 ~450 行。
9. `src/index.ts`：switch-protyle 回调改用 `inputModeTriggers.onSwitchProtyle()`。
10. `src/modules/typewriter.ts`：Enter/Backspace handler 改用 `inputModeTriggers.onEnterOrBackspaceEdit()`。

行为保持点：所有 scroll/wheel/passive 行为、capture 选项、键盘触发 round 4 fix（报告当时为 `pendingKeyboardUpdate` + 150ms cooldown；当前实现为 300ms）、FLIP 采样窗口、MutationObserver 范围均保持不变。

## 已验证

以下检查均通过：

```bash
tsc --noEmit
tsc --noEmit --noUnusedLocals --noUnusedParameters
npm run build
git diff --check
```

## 性能热点复查

### Typewriter FLIP

~~当前实现已经从全编辑器扫描改为围绕当前选区起止块采样前后 sibling 窗口~~ — 此项已在后续迭代中落地。当前 `typewriter.ts` 的 `animateBlockShift` 正常路径使用采样窗口（`FLIP_BLOCK_RADIUS = 30`），选择区容器异常时仍 fallback 到全量扫描。

判断：方向正确且已实现。后续如果仍出现长文档掉帧，可以把半径配置化，或在超大文档中跳过不可见块的 FLIP。

### Ripple MutationObserver

当前实现已不再监听 `document.body`，改为 focus active 时监听当前顶层块 subtree，并监听父容器一层 `childList` 捕获整块替换；mutation 刷新复用已有 rAF 队列。

判断：方向正确，保留了修复 SiYuan tokenizer 二次重渲染的能力，同时缩小了监听范围。暂不建议删除。

## 剩余风险

### 1. ~~`cursor.ts` 职责过重~~ ✅ 已修复（Tasks 0-4）

~~Symptom：`cursor.ts` 同时承担光标 DOM、边界淡出、呼吸状态、输入模式退出、全局事件、ResizeObserver、滚动容器绑定、悬浮窗拖动、EventBus 适配和边缘箭头入口。~~

已完成拆分（见上方”跟进重构记录”）。`cursor.ts` 现在只保留核心循环 + EventBus 适配，其余职责分配到 `cursor/` 子模块。

### 2. ~~`inputMode` 触发分散~~ ✅ 已修复（Task 4）

~~Symptom：`index.ts`、`cursor.ts`、`typewriter.ts` 都直接调用 `inputMode.setBothOn/Off()`。~~

已引入 `inputModeTriggers.ts` 适配层（9 个语义函数），业务模块不再直接调用 `setBothOn/Off`。

### 3. ~~文档事实源漂移~~ ✅ 已修复（Task 6）

~~Symptom：`docs/DESIGN.md` 仍保留旧默认状态、旧路径和旧 FLIP 扫描描述。~~

已更新 DESIGN.md：架构快照反映当前模块结构（cursor 子模块 + inputModeTriggers），删除失效行号引用，更新 FLIP 描述为采样窗口模式，更新版本至 v2.6.2。

### 4. 缺少 characterization tests

Symptom：仓库没有测试文件，关键行为依赖 selection、scroll、rAF、SiYuan DOM timing。

Source：Feathers - Working Effectively with Legacy Code。

Consequence：大规模拆分只能依赖人工体验验证，重构风险偏高。

Remedy：先给纯函数和独立 helper 建轻量测试；涉及浏览器 DOM 的行为用最少量 smoke/characterization 用例覆盖，不追求高覆盖率。

### 5. 未来入口与保留代码

Symptom：`RippleMode`、边缘箭头、已下线功能注释仍作为未来入口存在。

Source：Fowler - Speculative Generality。

Consequence：维护者需要反复判断哪些是正式功能，哪些只是历史保留。

Remedy：分两类处理：已经确定不会恢复的删掉；确实可能恢复的加清晰注释和单一入口，避免散落在主流程里。

## 建议的后续重构顺序

~~1. 清理事实源：确认 README 和源码注释先保持当前事实，暂不大改 DESIGN。~~ ✅ Task 6 完成
~~2. 拆 `cursor.ts` 的纯事件绑定和滚动绑定，保持导出接口不变。~~ ✅ Tasks 0-3 完成
~~3. 拆 `cursor.ts` 的 switch-settle 流程和 edge-arrow 入口。~~ ✅ Task 1 + edgeArrow 先前完成
~~4. 集中 `inputMode` 触发语义。~~ ✅ Task 4 完成
~~5. 在每次拆分后运行 `tsc --noEmit --noUnusedLocals --noUnusedParameters` 和 `npm run build`，并进行思源内手测。~~ ✅ 每步已验证

剩余建议（见 roadmap Task 5/7）：
- Task 5：为纯函数和独立 helper 建轻量 characterization tests
- Task 7：环境修复（pnpm-workspace.yaml / lockfile）

核心原则：每一步只改变结构，不改变行为；一旦某步需要改变行为，就单独开任务处理。
