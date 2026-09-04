//! 客户端 API 请求延迟埋点（BLF-797 Footer 延迟指标段）
//!
//! 纯客户端近似指标（不要求后端 APM）：[`Client`] 的 JSON 请求管线在响应体
//! 读完后把耗时毫秒数推进进程级滑动窗口，Footer 轮询时读 [`latency_snapshot`]
//! 取最近窗口的 P95。设计约束：
//!
//! - **滑动窗口**：固定容量环形（[`WINDOW_CAPACITY`]），写满后淘汰最旧样本——
//!   只反映「最近」的请求体验，历史毛刺自动衰减；
//! - **P95 近似**：nearest-rank（排序取 `ceil(0.95·n)-1` 位），小样本下偏保守；
//! - **成功与失败都记录**：超时 / 连接失败同样是用户可感知的延迟信号；
//!   SSE 流式端点（AI Chat）语义不同（分钟级长连接），不纳入埋点。

use std::collections::VecDeque;

/// 滑动窗口容量（最近 N 次请求）
pub const WINDOW_CAPACITY: usize = 128;

/// 延迟快照（Footer 渲染消费）
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LatencySnapshot {
    /// 当前窗口内样本数（0 = 尚无请求，P95 为 `None`）
    pub samples: usize,
    /// P95 延迟毫秒（nearest-rank；无样本时 `None` → Footer 显示「--」占位）
    pub p95_ms: Option<f64>,
}

/// 滑动窗口本体（纯结构便于单测；全局实例见 [`latency_window`]）
#[derive(Debug, Default)]
pub struct LatencyWindow {
    samples: VecDeque<f64>,
}

impl LatencyWindow {
    pub fn new() -> Self {
        Self::default()
    }

    /// 推入一个耗时样本（毫秒）；负值防御为 0，写满后淘汰最旧
    pub fn push(&mut self, duration_ms: f64) {
        let duration_ms = duration_ms.max(0.0);
        if self.samples.len() >= WINDOW_CAPACITY {
            self.samples.pop_front();
        }
        self.samples.push_back(duration_ms);
    }

    /// 当前快照（P95 nearest-rank：`ceil(0.95·n)` 位，1-based）
    pub fn snapshot(&self) -> LatencySnapshot {
        let n = self.samples.len();
        if n == 0 {
            return LatencySnapshot {
                samples: 0,
                p95_ms: None,
            };
        }
        let mut sorted: Vec<f64> = self.samples.iter().copied().collect();
        sorted.sort_by(|a, b| a.total_cmp(b));
        let rank = ((0.95 * n as f64).ceil() as usize).clamp(1, n);
        LatencySnapshot {
            samples: n,
            p95_ms: Some(sorted[rank - 1]),
        }
    }
}

use std::sync::Mutex;
use std::sync::OnceLock;

/// 进程级窗口单例（`Client` 是 cheap-clone 多实例共享 reqwest 池，
/// 埋点按进程聚合才反映真实体验；锁竞争仅每请求一次 f64 push，可忽略）
fn latency_window() -> &'static Mutex<LatencyWindow> {
    static WINDOW: OnceLock<Mutex<LatencyWindow>> = OnceLock::new();
    WINDOW.get_or_init(|| Mutex::new(LatencyWindow::new()))
}

/// 记录一次请求耗时（毫秒）。锁中毒 / 窗口不可用时静默丢弃样本——
/// 埋点是纯旁路，任何故障都不允许影响业务请求路径。
pub fn record_latency(duration_ms: f64) {
    if let Ok(mut window) = latency_window().lock() {
        window.push(duration_ms);
    }
}

/// 读取当前延迟快照（Footer 延迟指标段轮询消费）
pub fn latency_snapshot() -> LatencySnapshot {
    latency_window()
        .lock()
        .map(|window| window.snapshot())
        .unwrap_or(LatencySnapshot {
            samples: 0,
            p95_ms: None,
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 容量约束：超过 WINDOW_CAPACITY 后最旧样本被淘汰，总数不再增长
    #[test]
    fn window_capacity_evicts_oldest() {
        let mut window = LatencyWindow::new();
        for i in 0..(WINDOW_CAPACITY + 10) {
            window.push(i as f64);
        }
        let snapshot = window.snapshot();
        assert_eq!(snapshot.samples, WINDOW_CAPACITY);
        // 最旧的 0..9 已被淘汰，窗口内最小样本是 10
        assert!(snapshot.p95_ms.unwrap() >= 10.0);
    }

    /// P95 nearest-rank 口径：100 样本取第 95 位（0-based 94）
    #[test]
    fn p95_nearest_rank_matches_contract() {
        let mut window = LatencyWindow::new();
        // 1..=100 推入 → 升序即本身；P95 应为 95
        for ms in 1..=100 {
            window.push(ms as f64);
        }
        let snapshot = window.snapshot();
        assert_eq!(snapshot.samples, 100);
        assert_eq!(snapshot.p95_ms, Some(95.0));
    }

    /// 小样本向上取整：3 样本 ceil(2.85)=3 → 最大值位
    #[test]
    fn p95_small_sample_rounds_up() {
        let mut window = LatencyWindow::new();
        for ms in [10.0, 20.0, 30.0] {
            window.push(ms);
        }
        assert_eq!(window.snapshot().p95_ms, Some(30.0));
    }

    /// 空窗口：samples=0 且 P95 为 None（Footer 显示占位符的依据）
    #[test]
    fn empty_window_has_no_p95() {
        let snapshot = LatencyWindow::new().snapshot();
        assert_eq!(snapshot.samples, 0);
        assert_eq!(snapshot.p95_ms, None);
    }

    /// 负值防御：异常时钟回拨样本钳到 0，不污染排序
    #[test]
    fn negative_duration_clamped_to_zero() {
        let mut window = LatencyWindow::new();
        window.push(-5.0);
        window.push(50.0);
        assert_eq!(window.snapshot().p95_ms, Some(50.0));
        window.push(-1.0);
        window.push(-2.0);
        // 4 样本 [-2,-1,0,50]：ceil(3.8)=4 → 最大 50 不变；再补 96 个 0 后
        // P95 落在 0 段，验证负值没有混入正区间
        for _ in 0..96 {
            window.push(0.0);
        }
        assert_eq!(window.snapshot().p95_ms, Some(0.0));
    }
}
