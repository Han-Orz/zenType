# zenType DebugKit

DebugKit 只在开发构建中工作。先在仓库根目录启动 bridge：

```bash
pnpm run debug:bridge
```

## Forensic session

```js
const d = globalThis.__zentypeDebug;

await d.start("backspace", { profile: "forensic" });

// reproduce once

d.mark("observed");
await d.stop();
```

forensic 会记录截断后的正文、输入数据、选区文本、Text node 文本、DOM identity 和视觉样式。

## Timing session

```js
await d.start("scroll-jank", { profile: "timing" });
```

timing 保持低扰动，不记录正文，也不生成完整 DOM tree。

## Watch

```js
const id = d.watch(
  ".protyle-action, .protyle-action svg, .protyle-action use",
  "marker",
);

// Watch samples are captured on control keydown, mutation batches,
// structural-edit finish, mark(), and capture().
d.unwatch(id);
```

最多 8 个 watch；每个 selector 每次最多记录 12 个匹配节点。

## 输出

`.debug/latest-session.json` 指向最近 session。对应目录位于：

```text
.debug/sessions/<label>__<sessionId>/
  meta.json
  events.ndjson
  summary.ndjson
  report.json
  latest-snapshot.json
```

bridge 离线时 session 仍会保存在内存 ring 中且不会持续刷请求；bridge 恢复后可显式执行 `await d.reconnect()`。
