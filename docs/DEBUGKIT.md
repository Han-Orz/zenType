# zenType DebugKit

DebugKit 是**开发构建专用**的本地取证工具。生产构建会把它替换为 noop，不会注册命令、监听器、MutationObserver 或网络请求。

完整取证可能记录正文片段、选区和 DOM 信息。导出的 JSON 只会下载到本机；请按包含敏感内容处理，不要直接公开分享。

## 日常工作流：两个命令

先一次性建立开发插件链接，并在修改源码时保持 watch：

```bash
npm run link
npm run dev
```

没有源码变更时，可以无限次重复下面的录制流程，**不需要**控制台、bridge 或重新构建：

1. 在思源命令面板执行“`zenType：开始完整 Debug`”。
2. 回到同一文档，复现一个明确的问题；一次录制只关注一个问题。
3. 执行“`zenType：结束并导出 Debug`”。浏览器会下载一个文件，例如 `zentype-debug-20260907-143000-a1b2c3d4.json`。
4. 将这个 JSON 交给 Codex 分析。若下载被浏览器阻止，再次执行结束命令即可重试；已停止的会话会保留。

开始命令不会覆盖活动会话。若已经在录制，先结束并导出，再开始下一次。开始和结束各会留下一个完整上下文快照。

## 完整 Debug 采集的内容

`full` 是命令使用的默认 profile，同时包含两条本地通道：

- `timeline`：输入、光标提交、句子更新、滚动的标量时间线。它原先叫 `performance`；这里的名称不等同 Chromium DevTools 的 Performance trace。
- `forensic`：详细输入/DOM 事件、正文片段、选区、DOM 身份、几何、计算样式、Mutation 和开始/结束快照。

完整会话不连接也不探测 bridge。所有内容在当前页面会话的本地定长缓冲中保存，详细 forensic 缓冲独立于 Console 预览的 500 条 recent events。每个通道的容量、保留数、覆盖数和是否截断都写在导出 JSON 的 `loss` 中；达到硬上限时覆盖最早数据，不会静默丢失。

导出格式为 `zentype-debug-bundle/v1`：

- `session`：会话 ID、时间、Git SHA、源码指纹和 profile。
- `host`：宿主浏览器身份与页面地址。
- `timeline`：标量事件和环形缓冲状态。
- `forensic`：详细事件与采集计数。
- `loss`：timeline、forensic 与 Console 预览的容量、保留数和覆盖数。

`inputContextId` 是最近观察到的输入，不是严格因果；`queuedInputContextId` 是光标排队/合并时的上下文。滚动的 `motionId` 标识同一动画，`generation` 区分代次，取消事件包含原因。
光标坐标是**提交目标**，不是浏览器已完成绘制的位置；句子的 `durationMs` 只覆盖呈现引擎，不包含整个 Ripple 路径。

完整取证的耗时用于关联事件，不能直接当作正式插件的生产成本。

## 高级专项工具

内部 API 仍保留给专项调试和 Marker 逐帧命令使用：`mark()` 添加关联标签，`capture()` 额外创建快照，`watch()` 增加受限观察目标。它们不是日常录制所需步骤。

`timeline` profile 只采集标量事件；不会读取 DOM、正文、布局或计算样式，也不会启动 MutationObserver 或 bridge。`forensic` profile 保留给内部专项工具，可能使用 bridge；日常完整取证应使用命令启动 `full`。

Chromium DevTools 的 **Performance** 面板是另一种工具，用于判断脚本、布局、绘制、合成和掉帧。它不是 Network 抓包，也不会包含在 DebugKit bundle 中。只有需要区分浏览器帧活动与插件事件时，再在同一开发构建、同一文档、同一复现动作下单独录制 trace；网页端结果不能直接代表思源桌面端。
