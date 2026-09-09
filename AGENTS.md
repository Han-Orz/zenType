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

   宁可少一个动画，也不要干扰输入、Selection、滚动或 SiYuan 自身行为。但优秀的动画与手感是我们追求的目标。

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

8. **Bug 尽量留下测试**

   * 修复可复现 bug 时，尽量增加 regression / characterization test。
   * 测试是护栏，不是绝对真理。
   * 测试失败时，先判断是代码错误、测试过时，还是设计行为已经改变，不要为了绿测试破坏正确行为。

## 完成修改后

通常至少运行：

```bash
npm run typecheck
npm test
npm run build
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
