#!/bin/bash
# swap_reclaim.sh —— 每日清除 stale swap 驻留（BLF-1035）
#
# 背景（BLF-1033 巡检）：2C/1.9G VPS 长期 swap 占满（516MB/1GB used），
# believeboy 各单元累计 ~190MB 冷页驻留（API 134MB、scheduled worker
# 132-158MB、beat 150MB）。这些页基本不再被访问，却让 kswapd 持续做
# 无谓的换页 IO（实测 vmstat si=484-512 kB/s），白耗 CPU 与磁盘带宽。
#
# 做法：swapoff -a && swapon -a —— kernel 把 swap 中的页全部拉回内存，
# 随后 swap 重新挂载为空，冷驻留被释放/挤回 file cache，kswapd 安静。
#
# 安全前置检查（避免 OOM）：
#   1. sync 先落盘；
#   2. MemAvailable 必须 > SwapUsed × 1.3（30% 余量），否则跳过并记日志
#      —— swapoff 期间 swap 里的页要暂时全部装进内存，余量不足会 OOM。
#
# 部署：productEnvAgent/deploy_vps.py 安装到 /etc/cron.d/believeboy-swap-reclaim，
# 每日 04:30（Asia/Shanghai）执行。日志走 syslog（cron.d 的 CRON 设施）。
#
# 退出码：0 = 回收完成或安全跳过；1 = swapon 失败（swap 未恢复，需人工介入）。

set -u

log() {
    echo "swap_reclaim: $*" | logger -t believeboy-swap-reclaim -p cron.info
}

# swap 已用 = SwapTotal - SwapFree（kB，/proc/meminfo；无 SwapUsed 字段）
swap_total=$(awk '/^SwapTotal:/ {print $2}' /proc/meminfo)
swap_free=$(awk '/^SwapFree:/ {print $2}' /proc/meminfo)
swap_used=$((swap_total - swap_free))

if [ "${swap_used}" -le 102400 ]; then
    # ≤100MB 驻留：回收收益小，跳过（避免每日无谓 swapoff 抖动）
    log "skip: swap used ${swap_used}kB <= 100MB threshold"
    exit 0
fi

sync

mem_available=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)

# MemAvailable 需覆盖 swap 已用 + 30% 余量
if [ "${mem_available}" -lt $((swap_used * 13 / 10)) ]; then
    log "skip: MemAvailable ${mem_available}kB < swap_used ${swap_used}kB * 1.3 (insufficient headroom)"
    exit 0
fi

log "reclaiming ${swap_used}kB (MemAvailable ${mem_available}kB)"

if swapoff -a; then
    if swapon -a; then
        swap_free_after=$(awk '/^SwapFree:/ {print $2}' /proc/meminfo)
        swap_used_after=$((swap_total - swap_free_after))
        log "done: swap used ${swap_used}kB -> ${swap_used_after}kB"
        exit 0
    else
        log "ERROR: swapon -a failed after swapoff — swap is DOWN, manual intervention required"
        exit 1
    fi
else
    log "skip: swapoff -a failed (possibly another swapoff in progress)"
    # swapoff 失败不等于 swap 被关闭（失败即放弃时 swap 仍在），无需恢复
    exit 0
fi
