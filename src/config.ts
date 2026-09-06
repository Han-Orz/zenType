/**
 * zenType 用户可配置参数。
 *
 * 改完保存即可，开发模式会自动重新构建（pnpm run dev）。
 *
 * ┌─────────────────────────────────────────────────────────────────┐
 * │  CSS 侧参数（颜色、宽度、移动曲线、关键帧）：                     │
 * │  编辑 `src/styles/index.scss` 中 `#zentype-cursor` 块             │
 * │  - 宽度：width                                                     │
 * │  - 颜色：background + --zt-cursor-color                            │
 * │  - 兜底移动曲线：transition（正常态由 cursor.ts 写入）              │
 * │  - 关键帧：@keyframes zentype-breathe                              │
 * │  - 动画时长：animation (3s 1.5s ...)                              │
 * └─────────────────────────────────────────────────────────────────┘
 *
 * ┌─────────────────────────────────────────────────────────────────┐
 * │  行为侧参数（光标高度比、闪烁延迟等）→ 本文件。                    │
 * └─────────────────────────────────────────────────────────────────┘
 *
 * 本文件只放"已稳定且用户可能想调节"的参数。
 * ⚠️ `as const` 保证值不被意外修改；如需运行时调整请改 union type。
 */

export const CURSOR_CONFIG = {
  /** 光标高度 = 所在行 lineHeight × 此倍数。参考版用 0.88；当前值 1.05 略高，增强对行高的覆盖。 */
  HEIGHT_RATIO: 1.05,

  /** 光标停止活动后多少毫秒恢复呼吸闪烁（Phase 1 → Phase 2 的间隔）。 */
  BLINK_DELAY_MS: 1100,
} as const;

/** 打字机参数（光标在外层触发区外时回到内层稳定区）。 */
export const TYPEWRITER_CONFIG = {
  /** 自动跟随的外层触发区 [低, 高]；区间内不触发滚动。 */
  SCROLL_TRIGGER_ZONE: [0.34, 0.54],
  /** 自动跟随的内层稳定区 [低, 高]；越过触发区后回到对应边缘。 */
  SCROLL_SETTLE_ZONE: [0.40, 0.48],
  /** 滚动距离→时长分档（ms）。 */
  SCROLL_DURATION_TIERS: [180, 260, 360, 480, 600],
  /** 块级 FLIP 过渡动画曲线。 */
  SCROLL_CURVE: 'cubic-bezier(0.25, 0.1, 0.25, 1)',
  /** 连续键入停顿阈值（ms）：超过视为"停顿"触发一次舒适区对齐，小于则视为"连续键入"延后。
   *  实现"连续键入不滚动，空隙时滚动"的 debounce 行为。空闲超过 2× 此值的首次输入立即滚。 */
  TYPING_GAP_MS: 400,
  /** 点击居中阈值下界：仅当 caret 垂直位置 < 此值才主动居中，避免破坏附近点击的滚动定位。 */
  CLICK_CENTER_LOW: 0.25,
  /** 点击居中阈值上界：仅当 caret 垂直位置 > 此值才主动居中。 */
  CLICK_CENTER_HIGH: 0.75,
} as const;

/* ---------------------------------------------------------------------------
 * 高亮条 (highlight bar) — 已下线。恢复步骤见 git 历史 v2.2 之前。
 * ------------------------------------------------------------------------- */

/** 涟漪聚焦参数（按块距离衰减 opacity）。 */
export const RIPPLE_CONFIG = {
  /** 块级 opacity 梯度（按距离衰减）。distance 0=当前块, 1=相邻, 2+=远处。
   *  参考 obsidian focus 模式：1 → 0.4 → 0.2 → 0.15 → 0.1 → 0.05。 */
  BLOCK_LEVELS: [1.0, 0.4, 0.2, 0.15, 0.1, 0.05] as const,
  /** 句级 dimming 强度（当前块内非当前句的 color alpha，0-1）。
   *  ::highlight 不支持 opacity，用 rgba color 模拟。当前句=1（无 highlight）。 */
  SENTENCE_DIM_ALPHA: 0.6,
  /** 块级 opacity 过渡时长（秒），让 dimming 变化自然。0 = 无过渡。 */
  TRANSITION_SEC: 0.4,
  /** 视觉权重下限（lerp 起点）。视口外的块额外 dim 到此倍数。 */
  WEIGHT_MIN: 0.85,
} as const;

/** 边缘交互：光标接近视口边缘时的淡出 + 缩放。 */
export const EDGE_FADE = {
  /** 距编辑器内容区边缘的距离（px），淡出 + 缩放在此范围内完成。 */
  ZONE: 20,
  /** 光标完全离开视口时的最小缩放系数。 */
  MIN_SCALE: 0.6,
} as const;

/**
 * 光标移动距离 → 过渡时长映射。距离越大，时长越长（避免长距离瞬移感）。
 *
 * 当前光标离屏时不播放边缘动画（squish/bounce 已回滚），所以此处只影响
 * 在视口内移动的情况：typing / click 选行 / Enter 跳块 等。
 *
 * 用法：在数组中调整 `{ maxDist, duration }`。距离 ≤ maxDist 时使用对应 duration。
 * 最后一个的 maxDist 用 Infinity 表示"超过所有前面阈值的距离"。
 *
 * 调整建议：
 *   - 想 typing 更干脆：把第一个 duration 调小（0.04 ~ 0.06）
 *   - 想长跳转更顺滑：把最后一个 duration 调大（0.5 ~ 1.0）
 *   - 想中间档位更细分：往数组里加元素
 */
export const TRANSITION = {
  TIERS: [
    { maxDist: 30, duration: 0.07 },       // 极短距离（typing 1~3px）：snappy
    { maxDist: 150, duration: 0.15 },     // 短距离（行内跳转）：顺滑
    { maxDist: 500, duration: 0.21 },     // 中距离（跨段）：明显顺滑
    { maxDist: Infinity, duration: 0.30 }, // 长距离（跨屏）：长缓动
  ] as const,
} as const;

/** 边缘交互：视口边缘方向箭头指示器。 */
export const EDGE_ARROW = {
  /** 总开关：关闭后箭头永不显示；当前默认关闭。 */
  ENABLED: false,
  /** 箭头显示时的透明度（0–1）。 */
  OPACITY: 0.6,
  /** 三角形大小（px），即箭头指针高度。 */
  SIZE: 12,
  /** 距视口边缘的距离（px），箭头与边缘留此间距。 */
  OFFSET: 8,
  /** 淡入淡出过渡时长（ms），对应 CSS transition。 */
  TRANSITION_MS: 200,
} as const;

/* ---------------------------------------------------------------------------
 * 尚未开放的行为开关（hooks for P2+）：
 *   - CURSOR_SMOOTH_ENABLED       （关闭后光标瞬移，需同时删 SCSS transition）
 *   - CURSOR_BLINK_ENABLED        （关闭后光标常亮，需同时删 SCSS animation）
 *   - CURSOR_APPLY_TO_TITLE       （标题区域是否显示，需 cursor.ts 加判断）
 *   - CURSOR_USE_IN_MOBILE        （移动端总开关）
 *
 * 这些需要 SCSS 编译策略 / cursor.ts 逻辑共同配合，目前还没接好。
 * 临时调节：直接编辑 src/styles/index.scss 和 src/modules/cursor.ts。
 * ------------------------------------------------------------------------- */
