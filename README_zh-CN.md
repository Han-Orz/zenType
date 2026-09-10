# zenType v2.9.0-remake.2.3-critical.3

顺滑光标、打字机滚动、涟漪聚焦。critical-motion 开发构建保留单一 WritingSession / rAF / observer，并让 Cursor、Typewriter 和句级 Ripple 使用统一的解析临界阻尼数学；生产构建继续编译期剔除开发诊断代码。

## 写作体验

- 蓝色光标从当前显示位置继续运动，跨正文 editable 转移时保留运动；停笔后呼吸，靠近裁剪边缘淡出。
- 中文 IME 使用当前组合选区的 focus 端点维持蓝色光标，组合期间暂停插件舒适区滚动，宿主仍可滚动。
- 几何暂不可读时按 160ms 预算保留并重新观测；空块与块边界按光标所在块恢复位置，而不是按整个 editable。预算用尽后，若仍在同一 editable、仍是带 Range 的折叠选区且冻结位置在屏幕内，则继续保留呈现而不交还原生 caret。160ms 是基线恢复预算，不是宿主事务完成时限。
- 打字机滚动以当前 scrollTop 建立独立的连续虚拟位置；浏览器像素量化不会冻结运动，快速反向输入可以接管，手动浏览会停止自动跟随。
- Ripple 从当前亮度接续，普通文本变化不会整组重置；当前句使用 CSS Highlight，保留文字自身颜色。
- 可能的结构编辑会暂缓 Cursor、Typewriter 与 Ripple 的新目标；input 本身不能否定结构意图。思源会在后续 task 做输入归一化，因此普通 mutation 需经过 48ms 无新增分类活动才确认，所有路径受 160ms deadline 约束。
- 鼠标选择、普通非折叠选区使用宿主选择呈现。系统减少动态效果时关闭位移动画与呼吸。

顶栏按钮或 Ctrl+Alt+Z 联合切换打字机与涟漪；命令面板支持单独切换。顺滑光标独立持续启用。设置沿用原来的 zenType 功能开关。

## 安装体验

构建命令：

```sh
npm run typecheck
npm run typecheck:tests
npm test
npm run build:dev
npm run build
npm run verify:prod
```

开发构建在 `dev/`，生产构建在 `dist/`，安装包为 `package.zip`。包内文件位于压缩包根目录。

停用现有 zenType，将现有插件目录备份到插件目录之外；把包内文件放入思源工作空间的 `data/plugins/zenType/`，再启用插件。不要同时运行两个 zenType 副本。顶栏提示包含 `v2.9.0-remake.2.3-critical.3`，插件 manifest 保持数字版本 `2.9.0`。

已有开发链接可以继续使用 `dev/`。创建新链接可运行 `node scripts/make_dev_link.js --workspace <思源工作空间路径>`，脚本拒绝覆盖已有插件目录。

建议首先连续写作，体验中文输入、快速反向移动、Enter/Backspace 和滚动。遇到问题时记录思源版本、主题、操作步骤，以及光标消失、跳动或亮度异常的具体时点；再按需要补充 DOM 或事件日志。

## 当前边界

宿主资料基线为 SiYuan v3.8.3。标题、数据库和嵌入查询区不接管。悬浮或分屏正文只有在官方 active editor、焦点和 Selection 归属一致时才接管。

不动画化宿主块布局，也不实现 FLIP 或第二套事务调度器；共享 gate 是 WritingSession 内部的有界决策策略。宿主替换同一 node-id 的节点时只交接数值亮度（局部基线与祖先 seed），没有身份注册表，也不做跨块身份追踪。

句级聚焦需要 CSS Highlight、相对颜色和 Intl.Segmenter。单 editable 超过 32,768 个 UTF-16 单元、2,048 个文本节点或 256 句时保留块级聚焦。块级处理限制在祖先路径两侧各 48 个内容兄弟，避免扫描整篇长文档。

自动化检查覆盖运动接管、滚动边界、局部句界、共享结构 ordering、有界恢复、WAAPI ownership 和光标呈现控制；仍不证明真实 IME、复杂主题、特殊 inline 或宿主替换时序全部正确。旧架构专用测试已删除，可在 v2.8.1 历史中查阅。

架构与宿主依据见 [设计文档](docs/DESIGN.md) 与 [思源宿主契约](docs/SIYUAN_HOST_CONTRACT.md)，参数集中在 `src/config.ts`。
