//! tokio runtime 桥
//!
//! GPUI 自己的后台 executor 基于 smol，而 `reqwest` 需要 tokio reactor。
//! 应用级只建一个多线程 tokio runtime，网络调用统一在 GPUI 后台任务里
//! `block_on`（后台线程不阻塞 UI 主循环）。

use std::sync::OnceLock;
use tokio::runtime::Runtime;

/// 返回应用级 tokio runtime（懒加载，全局唯一）
pub fn runtime() -> &'static Runtime {
    static RT: OnceLock<Runtime> = OnceLock::new();
    RT.get_or_init(|| Runtime::new().expect("failed to build tokio runtime"))
}
