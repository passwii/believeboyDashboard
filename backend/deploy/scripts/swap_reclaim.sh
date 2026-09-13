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
# 退出码：0 = 回收完成或安全跳过（驻留少/内存余量不足）；
#          1 = 失败——/proc/meminfo 字段缺失/非法、swapoff 非全成功、
#              或 swapon 恢复失败（swap 状态需人工介入）。

set -u

log() {
    echo "swap_reclaim: $*" | logger -t believeboy-swap-reclaim -p cron.info
}

# 读取 /proc/meminfo 的指定字段（kB），返回纯数字；字段缺失/非数字输出空串
read_meminfo_kb() {
    awk -v key="$1" '$1 == key ":" {print $2; exit}' /proc/meminfo
}

# 校验非负整数（空串/非数字一律拒绝，fail closed —— 不能在内存余量
# 未知时继续 swapoff，否则 MemAvailable 安全阀形同虚设）
is_uint() {
    case "$1" in
        ''|*[!0-9]*) return 1 ;;
        *) return 0 ;;
    esac
}

swap_total=$(read_meminfo_kb SwapTotal)
swap_free=$(read_meminfo_kb SwapFree)
mem_available=$(read_meminfo_kb MemAvailable)

for name_value in "SwapTotal:${swap_total}" "SwapFree:${swap_free}" "MemAvailable:${mem_available}"; do
    name=${name_value%%:*}
    value=${name_value#*:}
    if ! is_uint "${value}"; then
        log "ERROR: /proc/meminfo field ${name} is missing or not a non-negative integer ('${value}') — aborting (fail closed), swap NOT touched"
        exit 1
    fi
done

swap_used=$((swap_total - swap_free))

if [ "${swap_used}" -le 102400 ]; then
    # ≤100MB 驻留：回收收益小，跳过（避免每日无谓 swapoff 抖动）
    log "skip: swap used ${swap_used}kB <= 100MB threshold"
    exit 0
fi

sync

# MemAvailable 需覆盖 swap 已用 + 30% 余量
if [ "${mem_available}" -lt $((swap_used * 13 / 10)) ]; then
    log "skip: MemAvailable ${mem_available}kB < swap_used ${swap_used}kB * 1.3 (insufficient headroom)"
    exit 0
fi

log "reclaiming ${swap_used}kB (MemAvailable ${mem_available}kB)"

# cron 环境默认 PATH=/usr/bin:/bin，不含 /usr/sbin；swapoff/swapon 实际
# 位于 /usr/sbin（cron.d 文件与脚本均不设置 PATH），用绝对路径避免 exit 127
SWAPOFF=/usr/sbin/swapoff
SWAPON=/usr/sbin/swapon

swapoff_rc=0
"${SWAPOFF}" -a || swapoff_rc=$?

# util-linux 2.41+：swapoff -a 返回 64 = 部分 swap 关闭成功、部分失败。
# 任何非全成功（含 64）都可能已关掉部分 swap，必须先尝试 swapon -a 恢复
# 到全开状态再判定结果，绝不能把"部分关闭"报告为安全成功。
if [ "${swapoff_rc}" -eq 0 ]; then
    swapoff_full=1
else
    log "swapoff -a rc=${swapoff_rc} (non-zero; partial success rc=64 means some swaps are already off)"
    swapoff_full=0
fi

# 无论 swapoff 全成功还是部分成功，都执行 swapon -a 恢复全部 swap 设备
swapon_rc=0
"${SWAPON}" -a || swapon_rc=$?

if [ "${swapon_rc}" -ne 0 ]; then
    log "ERROR: swapon -a rc=${swapon_rc} after swapoff (rc=${swapoff_rc}) — swap NOT fully re-enabled, manual intervention required"
    exit 1
fi

if [ "${swapoff_full}" -eq 0 ]; then
    # swapoff 未全成功：swap 已由上面的 swapon -a 恢复全开，未完成回收，
    # 以失败退出让监控/journal 可见（明日 cron 会重试）
    log "ERROR: swapoff -a did not succeed fully (rc=${swapoff_rc}); swap re-enabled via swapon -a, reclaim NOT completed"
    exit 1
fi

swap_free_after=$(read_meminfo_kb SwapFree)
if ! is_uint "${swap_free_after}"; then
    log "done: swapoff+swapon succeeded (SwapFree field unreadable after reclaim)"
    exit 0
fi
swap_used_after=$((swap_total - swap_free_after))
log "done: swap used ${swap_used}kB -> ${swap_used_after}kB"
exit 0
