# zenType Agent Guide

> 代码与架构若诗篇般凝练优雅，交互与动画如温泉般温润舒适，而性能，则带来如风拂面般的畅快与极致。

zenType 追求的不是功能堆积，而是**简单、可靠、流畅、有质感**。

## 核心原则

1. **先读再改**

   * 修改运行时代码前，先读相关实现、`docs/DESIGN.md` 和相关测试。
   * 涉及 SiYuan DOM、Selection、IME、caret、scroll、重渲染等宿主行为时，以现有宿主证据为准，不凭经验猜测。

2. **保持架构简单**

   * `WritingSession` 负责协调、事件、调度和共享 frame。
   * Cursor、Typewriter、Ripple 保持独立，不互相直接调用。
   * 宿主事实集中读取，不允许每个效果各自重新解析 Selection、editor、caret。
   * 不为假想需求提前设计抽象层、状态机、兼容层或注册表。

3. **最小但完整的修改**

   * 只修改解决当前问题所需的代码。
   * 不顺手重构无关模块。
   * 优先修正已有模型，而不是在错误模型上继续叠 `if`、fallback 和特殊情况。
   * 新逻辑若取代旧逻辑，应尽量删除旧路径，而不是永久并存。

4. **警惕复杂度增长**

   * 新增 boolean、状态、timer、cache、Map、fallback 或 helper 前，先确认它确实代表一个独立且必要的概念。
   * helper 应有明确职责，不要为了缩短文件而制造无意义拆分。
   * 不把杂项代码不断丢进 `utils/`。
   * 文件长不是罪，职责混乱才是。

5. **动画永远服从编辑器**
   优先级始终是：

   `输入与编辑正确性 > Selection / IME > 宿主稳定性 > 性能 > 动画连续性 > 特效完整度`

   宁可少一个动画，也不要干扰输入、Selection、滚动或 SiYuan 自身行为。但优秀的动画与手感始终应该是我们追求的目标。

6. **性能是设计的一部分**

   * 避免输入热路径中的全量 DOM 扫描、频繁 `getComputedStyle()`、强制 layout、无界遍历。
   * 不建立永久 rAF 或轮询。
   * 空闲时应真正空闲。
   * 不用随意的 `setTimeout(100)` 猜测 SiYuan 什么时候完成更新。
   * 已有性能优化不能为了“代码更漂亮”而被悄悄退化。

7. **宿主兼容必须有证据**
   对 SiYuan 特殊处理，区分：

   * **Observed**：日志、源码、实测直接证明
   * **Inferred**：有证据支持，但未直接证明
   * **Not observed**：尚未覆盖

   不为“理论上可能发生”的情况加入兼容代码。

8. **一个 Session，一套业务时间轴**

   * 所有 duration、deadline、debounce、hold 和 recovery 运算都使用 `performance.now()`。Session 的 rAF callback 开始时只取一次该值，并把它传给 StructureGate、Cursor、Typewriter 和 Ripple。
   * rAF callback timestamp 只可作为 DebugKit/CDP 的 frame provenance；不得与事件或 MutationObserver 中的 `performance.now()` 做减法，也不得做 offset calibration。用户实机曾观测两者稳定相差约 134ms，但这个数值不是宿主常量。
   * `requestAnimationFrame` 在窗口非前台时可能严重降频，即使某次采样中 `document.hidden === false`。毫秒 deadline 服从 monotonic clock，不服从帧数；不能假定“下一帧很快就来”。

9. **宿主采样不等于视觉提交**

   * Session 可以读取 transient DOM、Selection 或 caret，但 StructureGate 未授权时，Cursor target、Typewriter scroll target 和 Ripple topology 都不得消费它。
   * MutationObserver 不读取 caret geometry，也不规划新 topology。唯一允许的同步 presentation write 是有界的 same-key owner rebind：把已经提交的 Ripple owner 交给同 `data-node-id` replacement，防止下一次 rAF 前出现无 owner 的亮帧。
   * SiYuan 会用相同 `data-node-id` 替换 DOM element；Element 对象身份不稳定，绑定在旧文本节点上的 CSS Highlight Range 会随旧 DOM 脱离。连续性应通过现有 BlockPainter 的数值/WAAPI owner 交接，不能写 inline opacity、复制 class，不能建立永久 identity registry。
   * StructureGate 的 intent、inputObserved、nonStructuralObserved、structural evidence、quiet/stable geometry 与 bounded deadline 是既有 authority policy。没有新证据时不要改 48ms/160ms，也不要加按键、坐标、空块或跳变阈值特判。

10. **生命周期与编辑器切换**

   * 正常 blur/focusout/菜单 suspension 应让 Ripple 从当前 presentation 平滑 retarget 到 neutral；disable、destroy、timeout、overflow 和 frame exception 才是同步 teardown。
   * 标签页/编辑器切换时，Cursor 先在隐藏状态提交稳定 geometry，再由同一个 Session rAF 在下一帧 reveal。不要为此增加第二个 rAF owner、timer 或 scheduler。
   * Shift+Tab 已验证的 marker mapping、Ripple `blockPlan` 与 structural authority 不得因其他动画问题被顺手重写。List 缩进的空间跳变是独立问题；没有完整证据和小而闭合的方案时，不恢复旧 structural FLIP。

11. **Bug 尽量留下测试**

   * 修复可复现 bug 时，尽量增加 regression / characterization test。
   * 测试是护栏，不是绝对真理。
   * 测试失败时，先判断是代码错误、测试过时，还是设计行为已经改变，不要为了绿测试破坏正确行为。

## 实机、CDP 与 DebugKit

* `docs/SIYUAN_HOST_CONTRACT.md` 是宿主事实账本。真实 SiYuan 结果写成 **Runtime-observed**，并注明版本、触发方式和适用范围；CDP synthetic event 不能冒充操作系统人工操作。
* 本地开发可让 packaged SiYuan 以 `--remote-debugging-port=9222 --remote-debugging-address=127.0.0.1` 启动，再通过 `/json/version`、`/json/list` 或 CDP websocket 检查 DOM、Console、Network、Runtime、Performance 和浏览器状态。只连接用户明确开启的 loopback 端口。
* CDP 验证前确认插件 dev link、build fingerprint、当前文档和 Selection。测试编辑必须使用可逆操作；结束时 Undo 或精确恢复，并复查块类型、文本和工作区状态。
* 用 MutationObserver 探针验证“下一帧之前”的事实时，先 `await` 探针安装完成，再触发按键；不要让异步工具调用与被测事件竞争。记录 mutation microtask、20/80ms、首 rAF 等不同阶段，区分 DOM 已变化、owner 已交接和 gate 已 commit。
* CDP 和 DebugKit 互补，不能互相替代：CDP 擅长当场查看浏览器外部事实和运行任意探针；DebugKit 记录用户自然复现中的 Session 私有决策、authority 原因、长事件序列、build/session identity，且可导出后离线分析。DebugKit 必须继续只存在于开发构建，production compile-time elimination 必须由 `verify:prod` 守护。

## 完成修改后

通常至少运行：

```bash
npm run typecheck
npm run typecheck:tests
npm test
npm run build
npm run verify:prod
git diff --check
```

涉及 SiYuan 宿主行为时，明确说明哪些内容已经自动验证，哪些仍需要真实 SiYuan 手测。

## 最后的判断标准

提交代码前问自己：

* 是否引入了不必要的新概念？
* 是否出现两个模块同时负责同一件事？
* 是否可以删除旧逻辑，而不是继续叠兼容层？
* 是否让系统比修改前更难理解？
* 这个复杂度真的值得它带来的体验提升吗？

如果答案不好看，继续简化。

给用户的报告中应有：
* Change summary：做了什么
* Responsibility：行为现在由哪个模块负责
* New concepts：新增了哪些状态 / abstraction / helper，如果没有，写 None
* Removed code：删除了哪些旧逻辑如果没有，解释为什么保留
* New branches / fallbacks：每一个新增 branch 对应什么 observed case
* Invariants：哪些系统 invariant 保持不变
* Tests：运行了什么，新增了什么 regression test
* Scope：是否存在与本任务无关的修改

**目标不是写更多代码，而是让 zenType 长期保持小而清晰、快而稳定、柔和而有生命力。**
