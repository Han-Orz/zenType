# SiYuan DOM / 输入调试证据

> 这是一份从本机开发调试钩子日志整理出的脱敏记录。它用于后续规划和复现，不是对 SiYuan 内部实现的永久 API 承诺。
>
> 原始日志仍在项目根目录的 `.debug/`（`siyuan-hook.latest.json`、`siyuan-hook.ndjson` 及轮转文件），该目录已被 `.gitignore` 排除，不应提交到仓库。原始快照可能包含文档路径、块 ID 和本地环境信息；本文只保留结构和必要属性。

## 1. 数据来源与范围

- 调试协议：`zentype-debug/v1`。
- 快照文件：`.debug/siyuan-hook.latest.json`。
- 事件文件：`.debug/siyuan-hook.ndjson`。
- 采集器：`src/modules/debugHook.ts`。
- 桥接端：`scripts/debug-bridge.mjs`，只监听 `127.0.0.1`。
- 本次采集默认 `includeText=false`，正文只保留长度，不保留文本内容。
- 日志包含不止一次 hook 会话，以下事件计数用于了解观测能力，不是严格的单次性能基线。

## 2. 关键 DOM 结论

### 2.1 编辑器根节点

当时的编辑区域结构可以抽象为：

```html
<div class="fn__flex-1 protyle" data-node-id="<doc-id>">
  <div class="protyle-content protyle-content--transition">
    <div
      class="protyle-wysiwyg protyle-wysiwyg--attr"
      data-doc-type="NodeDocument"
      contenteditable="false"
      data-readonly="true"
      spellcheck="false"
    >
      ...
    </div>
  </div>
</div>
```

采集到的关键属性：

| 节点 | 观察到的属性/状态 |
|---|---|
| `.protyle` | `data-node-id`、`data-id`、`data-list-virtualization-scope`、`data-loading="finished"` |
| `.protyle-wysiwyg` | `data-doc-type="NodeDocument"`、`contenteditable="false"`、`data-readonly="true"`、`spellcheck="false"` |
| `.protyle-wysiwyg` computed style | `opacity=1`、`visibility=visible`、`overflow=clip visible`、`user-select=text` |
| 当前段落 | `data-type="NodeParagraph"`、`class="p"`、`contenteditable="false"` |
| 列表项 | `data-type="NodeListItem"`、`class="li"`、`data-marker="*"`、`data-subtype="u"` |
| 列表容器 | `data-type="NodeList"`、`class="list"`、`data-subtype="u"` |
| marker | `.protyle-action`，内部包含 `svg/use` |
| 块属性尾节点 | `.protyle-attr`，观察到 `contenteditable="false"` |

`contenteditable` 在这里是字符串属性，判断时应使用属性/DOM 状态的明确读取，不要只依赖视觉上是否出现光标。

### 2.2 实际嵌套列表结构

本次文档的脱敏结构如下：

```text
div.protyle-wysiwyg.protyle-wysiwyg--attr
└─ div[data-type="NodeList"].list                 # 外层列表，约 3 个直接子节点
   ├─ div[data-type="NodeListItem"].li            # 列表项 A
   │  ├─ div.protyle-action                        # marker
   │  ├─ div[data-type="NodeParagraph"].p         # 自身直接内容
   │  ├─ div[data-type="NodeList"].list           # A 的子列表
   │  │  └─ div[data-type="NodeListItem"].li ...
   │  └─ div.protyle-attr
   ├─ div[data-type="NodeListItem"].li            # 列表项 B
   │  ├─ div.protyle-action
   │  ├─ div[data-type="NodeParagraph"].p
   │  ├─ div[data-type="NodeList"].list           # B 的子列表，约 4 个列表项
   │  │  ├─ div[data-type="NodeListItem"].li
   │  │  ├─ div[data-type="NodeListItem"].li
   │  │  ├─ div[data-type="NodeListItem"].li
   │  │  └─ div[data-type="NodeListItem"].li       # 本次焦点所在分支
   │  └─ div.protyle-attr
   └─ div.protyle-attr
```

实际 DOM 中每个块都带 `data-node-id`，但 ID 是动态的。实现应依赖 `data-type`、直接子节点关系和当前 selection 祖先链，而不应把某次捕获的 ID 写入逻辑。

### 2.3 当前焦点的祖先链

一次有效的 collapsed selection 位于如下抽象路径：

```text
NodeDocument
└─ NodeList
   └─ NodeListItem       # 外层列表项 B
      └─ NodeList
         └─ NodeListItem # 内层列表项
            └─ NodeParagraph
               └─ div   # 文本编辑承载元素
```

采集到的 selection 信息包括：

- `inRoot=true`；
- `isCollapsed=true`；
- anchor/focus 位于同一个文本承载元素；
- `selectedTextLength=0`；
- 有一个 Range rect，可用于确认 caret 的实际位置；
- `currentBlock` 的 `data-type` 为 `NodeParagraph`。

当前块的 `blockChain` 按近到远依次包含：

```text
NodeParagraph → NodeListItem → NodeList → NodeListItem → NodeList → document root
```

这条链正好支持“焦点在子项时，父项自己的直接内容按距离淡化”的语义，但也说明不能简单把 `currentBlock.parentElement` 当作要变淡的目标：其中有 `NodeListItem`、`NodeList` 和 marker 等结构包装器。

### 2.4 多 Protyle 根

`observedRoots` 中同时出现过：

```text
div.protyle.fn__none   # 隐藏/非当前 Tab
div.protyle             # 当前可见 Tab
```

实现和调试工具必须按当前 active editor / Protyle ID 绑定，不应使用页面上第一个 `.protyle-wysiwyg`。切 Tab、虚拟化和 `fn__none` 都是需要覆盖的边界。

## 3. 输入问题的证据

### 3.1 支持“只读模式”的强证据

本次快照同时记录到：

```text
.protyle-wysiwyg[contenteditable="false"]
.protyle-wysiwyg[data-readonly="true"]
文本承载 div[contenteditable="false"]
.protyle-attr[contenteditable="false"]
```

此前一次界面观察中，还曾看到焦点落在 `data-type="readonly"` 的控制项上，标签为“解除锁定”。这条是 UI 观察证据，不应替代再次读取 DOM 属性；它与 `data-readonly=true` 是相互支持的信号。

### 3.2 “没有输入事件”的证据

现有 `.debug/siyuan-hook.ndjson` 中观察到的事件大致包括：

| 类型 | 次数 |
|---|---:|
| `mutation` | 520 |
| `ws-main` | 46 |
| `after-mutation` snapshot | 17 |
| `click` | 4 |
| `click-editorcontent` | 4 |
| `focusin` | 4 |
| `pointerdown` | 4 |
| `selectionchange` | 3 |

在这批日志中没有看到 `beforeinput`、`input`、`compositionstart`、`compositionupdate` 或 `compositionend`。但这不是一个纯净的 A/B 实验：日志还包含窗口失焦、设置界面输入框获得焦点和多个会话，不能仅凭缺少事件断言是 zenType 导致的。

### 3.3 其他上下文

- 某次 `hook-start` 快照的 `focus` 位于 `body`，且 body 带 `body--blur`；另一些快照的焦点位于思源设置面板的搜索 input。
- 这说明调试窗口/思源窗口之间发生过焦点切换；后续测试必须确保焦点确实在当前 Protyle 文本块。
- 观察到的 mutation 很多，但未建立“某次 printable 输入 → beforeinput → input → mutation”的完整链路。
- 因此目前结论是：只读/锁定是高概率原因，插件输入回归仍未被严格排除。

## 4. 历史样式观察

快照中可见当前顶层列表曾带有：

```text
--zt-ripple-opacity: 1
--zt-ripple-transition-duration: 0.4s
```

当前源码的旧模式本来就会给 `.protyle-wysiwyg` 的顶层块（此例中外层 `NodeList` 可能就是顶层块）写入私有 custom property，因此不能把这两个属性单独当成嵌套实现残留。真正需要验证的是：

1. 内层 `NodeListItem` / `NodeParagraph` 是否被额外写入 opacity 或 custom property；
2. 包含焦点后代的 `NodeListItem` 是否被写入 opacity；
3. 同一可视分支是否出现父级和后代同时写入导致叠乘；
4. `clearAll()` / unload 后是否恢复了原 inline style。

## 5. 可重复的只读 / 插件隔离测试

### Test A：思源只读门禁

1. 确认 zenType 处于停用状态。
2. 打开目标文档，确认当前编辑区是目标 Protyle。
3. 在思源界面点击“解除锁定”或等价只读控制。
4. 用一个临时字符测试，不要直接改重要正文。
5. 重新抓一次快照，检查：

   ```text
   .protyle-wysiwyg[data-readonly] 是否消失或改变
   .protyle-wysiwyg[contenteditable] 是否变为 true
   是否出现 beforeinput / input / composition 事件
   是否出现对应 characterData / childList mutation
   ```

如果插件停用且解除锁定后能输入，原问题优先归因于只读状态。

### Test B：插件关闭、文档可编辑

保持文档可编辑，在 zenType 停用状态下测试普通中文、英文和 Enter。若仍不能输入，优先检查 SiYuan 当前文档、窗口焦点或浏览器/应用状态，不要先改 ripple。

### Test C：原版插件开启、嵌套新模式未实现

在 Test B 通过后，开启当前已回滚的原版 zenType，再重复同一临时输入。若只有开启插件后失败，再比对：

- `beforeinput.defaultPrevented`；
- `input` 是否出现；
- typewriter 的 Enter/Backspace guard 是否命中；
- ripple 是否只改样式而没有改正文 DOM；
- unload/关闭插件后是否恢复。

### Test D：未来新模式 A/B

新嵌套算法必须有独立开关。先在原版模式和新模式之间对同一份固定测试文档重复 A/B，不允许同时变更“只读状态、插件模式、测试文档结构”三个变量。

## 6. 后续调试时应补充的字段

为了把输入故障和视觉算法故障彻底分开，建议 debug hook 增加或确认以下信息：

- active Protyle 的唯一 ID、可见性和 `data-readonly` 状态；
- `document.activeElement` 与 selection 是否属于同一个 Protyle；
- `beforeinput` / `input` 的 `inputType`、`defaultPrevented`、目标路径；
- composition 三个阶段的顺序和 `data` 长度；
- keydown 的 `key`、`defaultPrevented`、目标是否为正文；
- 触发本次 `applyRipple` 的原因；
- 本轮写入的目标元素数量、属性名、旧值/新值、缓存命中；
- mutation 是否来自正文 text node、块结构还是 zenType 自己的 style/class；
- 插件启用/停用和 `onload`/`onunload` 时间点。

正文采集仍应默认关闭；如确需打开，只使用临时测试文档，并在测试后清理本地日志。

## 7. 给实施规划的 DOM 约束

规划和实现必须明确回答：

1. `NodeList` 与 `NodeListItem` 哪些情况下是结构容器，哪些情况下可以作为非活动分支根；
2. 当前路径上的 `NodeListItem` 如何只淡化自己的 `NodeParagraph` / `NodeHeading`，不淡化当前子项；
3. marker `.protyle-action` 是否与自身直接内容共享距离档位；
4. `.protyle-attr` 是否永远排除在视觉目标之外；
5. 空项、嵌入块、多个直接内容块和多层子列表如何映射；
6. 多个 Protyle、隐藏 Tab、重渲染和虚拟化时如何重新取得节点；
7. 样式 ownership 如何保证不覆盖 SiYuan 或其他插件的 inline style。

这些问题与项目目标和实施阶段一起记录在 `NESTED_RIPPLE_PROJECT_BRIEF.md`。
