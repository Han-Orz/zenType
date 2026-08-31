# zenType 嵌套涟漪聚焦：项目 Brief 与规划输入

> 状态：仅整理目标与实施输入，尚未重新实现嵌套渐淡。
>
> 当前源码已经回到 v2.6.6 的原有涟漪行为：只对 `.protyle-wysiwyg` 的顶层块做块级渐淡，嵌套块继承父级效果。开发调试钩子仍保留，但 zenType 当前在本地思源中处于停用状态。

## 0. 给规划模型的结论

这是一个需要先建模、再实现的较大改动，不应直接在 `ripple.ts` 里继续堆选择器和特殊分支。请规划模型先输出：

1. DOM 语义树/视觉单元模型，以及距离公式；
2. 对当前路径、父项、同级兄弟、非活动子树的具体处理；
3. 与 SiYuan Protyle 重渲染、虚拟化、块增删和 IME 输入的交互边界；
4. 缓存、失效和布局读取策略；
5. 分阶段实现、测试矩阵、回滚开关和性能验收指标。

规划阶段不要直接恢复或重写实现。先比较候选方案，明确决策后再编码。

## 1. 产品目标

在焦点位于嵌套列表的任意子项时，让整个列表按照“距离焦点的远近”依次调整透明度：

- 当前焦点子项的 marker 与自身直接内容最清晰；
- 当前子项的父项只对自己的直接内容块（段落、标题等）按距离变淡，不把透明度写到包含当前子项的父包装器上；
- 同一个 `NodeList` 内的兄弟项按同级距离变淡；
- 有子列表的非活动分支只在合适的分支根设置一次，后代继承，避免父子透明度叠乘；
- `NodeList` 等结构容器保持中性，不因容器本身的透明度把焦点内容一起变淡；
- 距离档位和动画参数继续从配置统一读取，不在算法中写死数值；
- 不修改笔记正文 DOM，不插入 span，不改变 SiYuan 的块数据和输入语义。

目标不是单纯“把所有后代逐层变淡”，而是让用户能用视觉快速判断：当前编辑位置、父级上下文、同级替代项和远处内容之间的层次关系。

## 2. 已经讨论并认可的交互语义

### 2.1 视觉单元边界

| DOM/语义对象 | 计划中的处理 |
|---|---|
| 当前 `NodeListItem` 的 `.protyle-action` marker | 与当前项自身直接内容同档，距离为 0 |
| 当前项自己的 `NodeParagraph` / `NodeHeading` 等直接内容 | 距离为 0 |
| 当前项的 `NodeList` 结构容器 | 不直接写 opacity，保持中性 |
| 当前项的 `NodeListItem` 包装器 | 不在包含当前焦点子项的祖先包装器上写 opacity |
| 父项自己的直接内容块 | 按向上路径距离调整；直接父项通常为 1，再向上递增 |
| 同级兄弟项 | 按同一个列表中的 index 距离调整；有子树时以兄弟分支根一次处理 |
| 当前项下的非活动子分支 | 在分支根一次设置距离档位，后代继承，不再递归叠乘 |
| 普通顶层块 | 保持现有顶层块距离逻辑 |

这里的“父项”指父 `NodeListItem` 的自身内容，不是整个父 `NodeListItem` 元素。整个父元素若设置 opacity，会把当前正在编辑的子项一起变淡，这是要避免的。

### 2.2 典型焦点关系

抽象结构如下（不使用真实块 ID）：

```text
NodeList
├─ Item A
│  └─ NodeList
│     ├─ Item A.1
│     └─ Item A.2
└─ Item B
   └─ NodeList
      ├─ Item B.1
      │  └─ NodeList
      │     └─ Item B.1.a   ← 焦点
      ├─ Item B.2
      └─ Item B.3
```

期望的相对关系：

```text
焦点 Item B.1.a 自身内容/marker       distance 0
Item B.1 自身内容                      distance 1
Item B.2、Item B.3                     按同级距离递增
Item B.1 的父级 Item B 自身内容        按祖先路径距离递增
Item B.1.a 之外的子分支                根节点一次设值，后代继承
NodeList / 包含焦点的祖先包装器        不直接承担焦点子项的 opacity
```

上表确定了视觉意图；“跨列表边界时到底按树边数、同级 index，还是混合距离计分”仍需规划阶段给出一个可测试的正式公式。

### 2.3 透明度必须配置化

现有配置入口是 `src/config.ts` 的 `RIPPLE_CONFIG`：

```ts
BLOCK_LEVELS: [1.0, 0.4, 0.2, 0.15, 0.1, 0.05]
SENTENCE_DIM_ALPHA: 0.6
TRANSITION_SEC: 0.4
WEIGHT_MIN: 0.85
```

其中：

- `BLOCK_LEVELS` 是块/视觉单元距离到基础 opacity 的统一梯度；
- `SENTENCE_DIM_ALPHA` 控制当前块内非当前句的句级 dimming；
- `TRANSITION_SEC` 同时用于块级过渡和句级 fade 插值时长；
- `WEIGHT_MIN` 是相邻块的视觉权重下限。

嵌套列表实现可以增加“距离公式”或“目标类型”配置，但不能在 `ripple.ts` 内直接写死另一套透明度数组。新增配置必须说明默认值、兼容性和迁移方式。

## 3. 当前实现基线

### 3.1 现有涟漪

`src/modules/ripple.ts` 当前的块级逻辑：

1. 找到当前块在 `.protyle-wysiwyg` 下的顶层祖先；
2. 只遍历 `container.children`，不递归扫描嵌套块；
3. 用顶层 index 差计算距离；
4. 用 `BLOCK_LEVELS` 和相邻块视觉权重生成 opacity；
5. 通过私有 CSS custom property 和 class 映射到 opacity；
6. 使用 inline style ownership 恢复外部样式；
7. 通过当前块、容器位置、scrollTop、childCount 做缓存。

句级 dimming 使用 CSS Custom Highlight API，不改写正文 DOM。暂停场景会清除块级覆盖和 highlights。

### 3.2 已回滚的实验代码

此前曾在工作树中试做 `rippleHierarchy.ts` 和 `collectRippleTargetPlan`，后来因输入问题先回滚。该实验代码没有提交到 Git，也没有 stash 或可见备份；当前精确旧版本不能直接切回。现在应把它视为已经验证过方向、但尚未保留为实现的设计草稿。

### 3.3 当前调试基础设施

开发构建通过 `build.js` 注入 `src/modules/debugHook.ts`；正式构建替换为 `debugHook.noop.ts`。调试钩子可以记录：

- 当前/目标 Protyle、文档路径、块上下文和 DOM 结构树；
- focus、selection、Range 矩形、当前块及祖先链；
- `beforeinput`、`input`、IME composition、键盘、粘贴、拖放、点击和 focus 事件；
- MutationObserver 的 childList、characterData、class/style/data-type 等变化；
- 相关 EventBus 事件。

默认只记录文本长度，不记录正文；本地桥接端写入 `.debug/`，该目录已被 `.gitignore` 排除。

## 4. 建议的候选架构

下面是规划输入，不是最终实现。规划模型应评估是否采用，或提出更好的拆分。

### Phase 0：冻结基线与观测

- 保持当前顶层涟漪行为不变；
- 保留 debug hook，补充结构签名、焦点语义单元和写样式前后对比；
- 记录输入事件是否出现、是否被 `preventDefault`、是否出现对应 mutation；
- 建立一份不包含正文的固定嵌套列表测试文档。

### Phase 1：纯数据模型

新增无 DOM 副作用的模型层（名称待定），把捕获的 Protyle DOM 映射成：

```ts
type RippleSemanticNode = {
  id: string;
  kind: "document" | "list" | "list-item" | "content" | "branch";
  parentId: string | null;
  siblingIndex: number | null;
  directContentIds: string[];
  markerId: string | null;
};

type RippleDistancePlan = {
  focusId: string;
  distances: Map<string, number>;
  targets: Array<{
    id: string;
    elements: HTMLElement[];
    distance: number;
    writesAsBranchRoot: boolean;
  }>;
};
```

模型层必须能用普通对象/最小 fake DOM 测试，不依赖 `getBoundingClientRect()`、selection 或真实 SiYuan API。

### Phase 2：DOM adapter

- 只识别稳定的 `data-type`、`data-node-id`、`data-marker`、`class` 和直接子节点关系；
- 将 `NodeList`、`NodeListItem`、直接内容块、marker、嵌套列表分开；
- 明确处理 `.protyle-attr`、`.protyle-action`、空段落、嵌入块和非块包装元素；
- 对当前焦点祖先链建立 semantic path；
- 不把 `.protyle-wysiwyg` 或包含焦点后代的祖先包装器作为可变淡目标。

### Phase 3：应用与恢复

- 保持现有 inline style ownership 机制；
- 一个语义目标只写一次；分支根写过后，后代不再额外叠乘；
- `NodeList` 结构容器默认 opacity 为 1；
- 由 `BLOCK_LEVELS[distance]` 统一算基础档位；
- 视觉权重只在必要的近邻目标上读取布局，远处目标不反复触发 `getBoundingClientRect()`；
- 结构变化、焦点变化、滚动和外部 style 变化要正确失效缓存；
- `clearAll()` / `destroyRipple()` 必须精确恢复原 inline style。

### Phase 4：开关、对比与回滚

建议先增加开发期 feature flag 或仅在 debug 命令中启用的新模式：

- 旧模式：当前 v2.6.6 顶层块渐淡；
- 新模式：嵌套语义距离渐淡；
- 快速切换后不应残留旧模式写入的 style/class/highlight；
- 任何输入异常都能一键回到旧模式或停用插件。

正式发布前再决定是否删除旧模式和开关。

## 5. 性能问题清单

规划模型需要给出数量级估算和测量方法，而不是只写“用缓存优化”：

1. `selectionchange` 高频触发时，语义树重建是否能被结构签名缓存；
2. Protyle 重渲染时如何识别旧节点失效，避免使用断开的 DOM 引用；
3. 一次输入造成的 MutationObserver 批次如何合并；
4. 列表深度很大、兄弟很多、多个嵌套列表同时可见时的最坏复杂度；
5. `getBoundingClientRect()` 是否只对 distance=1 的近邻进行；
6. style 写入是否按“值未变化则不写”处理；
7. 滚动过程中 rAF 节流与块级缓存是否会造成视觉滞后；
8. 桌面、移动端、只读/锁定文档和虚拟化列表的差异。

建议至少采集：一次 apply 的耗时、DOM 节点扫描数、布局读取次数、style 写入数、缓存命中率、Mutation 批次数，以及输入事件到 mutation 的延迟。

## 6. 输入安全与生命周期约束

此前出现过“完全输入不了字符”的现象。无论最终原因是什么，新实现必须满足：

- 不拦截普通 printable key、`beforeinput`、`input` 或 composition 事件；
- Enter、Backspace 等已有 typewriter 逻辑的 guard 不能被 ripple 扩大影响；
- 不改正文 text node、HTML 结构或 selection Range；
- 只读状态必须先识别并记录，不能把它误判成插件输入故障；
- `onload`、`onunload`、Protyle 切换、销毁、重载后监听器和 observer 都能清理；
- plugin disabled、ripple off、focus 离开和 popup 场景都能恢复原样。

## 7. 测试矩阵

### 7.1 语义正确性

- 普通段落和标题的顶层渐淡保持不变；
- 一级列表焦点在父项、第一项、中间项、末项；
- 二级列表焦点在子项，父项自己的直接内容变淡而焦点子项不变淡；
- 子项的同级兄弟按距离递增；
- 父项有多个子列表时，焦点路径之外的分支根只写一次；
- 三级及更深列表的祖先、兄弟、子分支；
- 空列表项、空段落、列表项内标题/引用/代码块/嵌入块；
- 展开、折叠、拖动、移动、合并、拆分列表项后重新计算；
- 多个 Protyle Tab 和一个隐藏的 `fn__none` Protyle 同时存在。

### 7.2 输入与生命周期

- 插件关闭时正常输入；
- 插件开启但新模式关闭时正常输入；
- 新模式开启时普通中文、英文、数字、标点输入；
- 中文 IME compositionstart/update/end；
- Enter、Backspace、撤销/重做、粘贴、拖放；
- 快速连续输入、selectionchange 高频变化、滚轮/触屏滚动；
- popup、只读文档、锁定文档、失焦和切换文档；
- plugin reload / unload 后再次加载。

### 7.3 视觉与样式

- 浅色、深色、移动端；
- 原有 inline opacity、transition、custom property 被外部代码占用时不覆盖；
- `clearAll()` 后没有残留 opacity、class、CSS Highlight；
- 当前焦点始终保持配置定义的最亮档；
- 透明度改变不会改变布局、光标位置或 selection。

## 8. 验收标准

实现被接受前至少需要满足：

1. 语义距离关系能用纯单元测试覆盖，距离公式不依赖真实 DOM 布局；
2. 当前子项清晰，父项直接内容和同级兄弟按预期递减；
3. 不对包含焦点后代的父包装器写 opacity，不发生父子叠乘；
4. 所有透明度/动画档位由配置统一控制；
5. 输入、IME、selection、块数据和原有 typewriter 行为无回归；
6. DOM 重渲染、块增删、滚动和 Tab 切换后无残留样式；
7. 有对比测试或可切回旧模式的回滚路径；
8. 规划中给出实际性能基线和目标，而不是只凭主观判断。

## 9. 请 5.6 sol / Claude 4.8 重点回答

1. “父项直接内容距离 1、同级兄弟按 index 距离、非活动子树根一次设值”如何统一成一个无歧义的距离公式？
2. 哪些元素应该直接写 opacity，哪些必须保持中性？请给出 DOM 角色到 target 的完整映射表。
3. 对当前路径上的祖先 `NodeListItem`，如何只淡化自己的内容而不淡化当前后代？
4. 对有嵌套子列表的兄弟项，分支根继承一次与后代局部渐淡是否需要区分？
5. 现有 CSS custom property + inline style ownership 是否继续使用，还是应该改为 CSS class / custom highlight？
6. 如何在不每次全树扫描、不大量读取布局的情况下处理 Protyle 重渲染和虚拟化？
7. 哪些单元测试、最小 fake DOM 测试和真实 SiYuan 手工测试必须先完成？
8. 如何设计开发期 feature flag 和日志，使输入回归可以快速归因到只读状态、SiYuan 本身或 zenType？

## 10. 相关文件

- 当前涟漪实现：`src/modules/ripple.ts`
- 统一配置：`src/config.ts`
- 调试采集器：`src/modules/debugHook.ts`
- 正式构建替代模块：`src/modules/debugHook.noop.ts`
- 本地日志桥接：`scripts/debug-bridge.mjs`
- DOM/事件证据：`SIYUAN_DOM_EVIDENCE.md`
- 现有设计文档：`docs/DESIGN.md`
- 回滚后的构建命令：`pnpm run build:dev`、`pnpm run build`
