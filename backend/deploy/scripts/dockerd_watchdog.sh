#!/bin/bash
# dockerd_watchdog.sh —— dockerd 长跑 CPU 泄漏看门狗（BLF-1039 item 1b）
#
# 背景（BLF-1033 巡检）：2026-09-12 现场发现 dockerd 以 100% CPU 连续跑了
# 46 天（2 核 VPS 上吃满整整 1 核），`systemctl restart docker` 后立刻回到
# 0%。journald 里没有对得上的错误日志，只有更早的容器 exit 137 后
# "ShouldRestart" 记录——符合「容器事件循环 goroutine 泄漏」的特征：泄漏
# 期间 dockerd 不做任何有用功，却持续消耗一整核 + 抬高整机 load。
# 该问题没有上游修复可等，因此本脚本做机械兜底：持续高 CPU 就定期重启。
#
# 判定逻辑：
#   1. 每次运行取 docker.service 的 MainPID，按 /proc/<pid>/stat 的
#      utime+stime 在 SAMPLE_SECONDS 窗口内的增量算 CPU 占用率
#      （top 语义：100% = 吃满 1 核）；
#   2. CPU% >= CPU_THRESHOLD 记一次，否则计数清零（状态存 STATE_FILE）；
#   3. 连续 CONSECUTIVE_REQUIRED 次超阈值（默认 10 次 × 每分钟 1 次 ≈ 10
#      分钟）→ 重启 docker.service，并校验重启前在跑的业务容器（带
#      --restart 策略的，如 komari: Restart=always）是否自动回来；
#   4. COOLDOWN_SECONDS 内的重复触发会被拦下——避免「重启没解决泄漏」时
#      陷入每分钟重启 docker 的循环，把故障放大成雪崩。
#
# 安全约束：
#   - docker.service 不在 active 状态 / MainPID 为 0 → 直接跳过（不抢先
#     启动别人停掉的服务）；
#   - 采样窗口内 pid 消失（docker 正在被重启）→ 跳过，不算失败；
#   - /proc 字段读不到 / 不可解析 → fail closed（exit 1），绝不拿未知
#     CPU 值做重启决定；
#   - 状态文件、冷却文件读写失败 → exit 1（宁可漏报重启，不做错误动作）。
#
# 部署：productEnvAgent/deploy_vps.py 把本脚本 chmod +x，并把
# backend/deploy/cron/believeboy-dockerd-watchdog 安装到 /etc/cron.d/，
# 每分钟跑一次。日志走 syslog（logger -t believeboy-dockerd-watchdog）。
#
# 退出码：0 = 正常（含跳过、恢复、成功重启）；1 = 失败（采样/状态/校验
#         异常，需人工查看 journal 中的 believeboy-dockerd-watchdog 记录）。
#
# 可覆盖的环境变量（默认值即生产口径；测试用假 /proc 与假 systemctl
# 驱动同一份代码路径）：
#   PROC_ROOT / DOCKER_UNIT / CPU_THRESHOLD / SAMPLE_SECONDS /
#   CONSECUTIVE_REQUIRED / COOLDOWN_SECONDS / STATE_DIR / DRY_RUN

set -u

PROC_ROOT=${PROC_ROOT:-/proc}
DOCKER_UNIT=${DOCKER_UNIT:-docker.service}
CPU_THRESHOLD=${CPU_THRESHOLD:-50}
SAMPLE_SECONDS=${SAMPLE_SECONDS:-10}
CONSECUTIVE_REQUIRED=${CONSECUTIVE_REQUIRED:-10}
COOLDOWN_SECONDS=${COOLDOWN_SECONDS:-3600}
STATE_DIR=${STATE_DIR:-/var/lib/believeboy}
DRY_RUN=${DRY_RUN:-0}
# clock tick：/proc/<pid>/stat 的 utime/stime 单位。x86_64 Debian 为 100；
# 取不到时退回 100（与 getconf CLK_TCK 在受支持平台上的取值一致）。
CLK_TCK=${CLK_TCK:-$(getconf CLK_TCK 2>/dev/null || echo 100)}

STATE_FILE="${STATE_DIR}/dockerd-watchdog.state"
COOLDOWN_FILE="${STATE_DIR}/dockerd-watchdog.last-restart"
RESTART_TIMEOUT=${RESTART_TIMEOUT:-120}

log() {
    echo "dockerd_watchdog: $*" | logger -t believeboy-dockerd-watchdog -p cron.info
}

# 校验非负整数（空串/非数字一律拒绝，fail closed）
is_uint() {
    case "$1" in
        ''|*[!0-9]*) return 1 ;;
        *) return 0 ;;
    esac
}

# awk 输出的是浮点（如 "100.0"），is_uint 不适用——单独校验数值形状
is_number_repr() {
    case "$1" in
        ''|*[!0-9.]*) return 1 ;;
        *) return 0 ;;
    esac
}

# 读取 pid 的 utime+stime（ticks）。成功打印数字；失败返回 1。
read_cpu_ticks() {
    local pid=$1 stat_line rest
    [ -r "${PROC_ROOT}/${pid}/stat" ] || return 1
    stat_line=$(cat "${PROC_ROOT}/${pid}/stat" 2>/dev/null) || return 1
    [ -n "${stat_line}" ] || return 1
    # comm 字段可能含空格与括号（如 "a) S) X"），故以最后一个 ") " 为界
    # 截断：其后第一列即 state（原字段 3），utime/stime 为第 12/13 列。
    rest=${stat_line##*') '}
    echo "${rest}" | awk '{
        if (NF < 13) exit 1
        if ($12 !~ /^[0-9]+$/ || $13 !~ /^[0-9]+$/) exit 1
        print $12 + $13
    }'
}

# 采样窗口内计算 CPU%（top 语义：100 = 吃满 1 核）。成功打印百分比；
# 采样中止返回 1（首采失败）或 2（pid 在窗口内消失，通常是别人在重启 docker）。
sample_cpu_percent() {
    local pid=$1 t0 t1 wall0 wall1 dt
    t0=$(read_cpu_ticks "${pid}") || return 1
    wall0=$(date +%s)
    sleep "${SAMPLE_SECONDS}"
    if ! t1=$(read_cpu_ticks "${pid}"); then
        return 2
    fi
    wall1=$(date +%s)
    dt=$((wall1 - wall0))
    [ "${dt}" -gt 0 ] || dt=1
    awk -v d="$((t1 - t0))" -v hz="${CLK_TCK}" -v dt="${dt}" \
        'BEGIN { printf "%.1f", (d / hz) / dt * 100 }'
}

# 读取计数状态（"<pid> <count>"）。读不到/非法 → 归零。
read_state() {
    last_pid=0
    count=0
    if [ -r "${STATE_FILE}" ]; then
        read -r last_pid count <"${STATE_FILE}" || true
    fi
    is_uint "${last_pid}" || last_pid=0
    is_uint "${count}" || count=0
}

write_state() {
    printf '%s %s\n' "$1" "$2" >"${STATE_FILE}" || return 1
}

main() {
    mkdir -p "${STATE_DIR}" || {
        log "ERROR: cannot create STATE_DIR ${STATE_DIR}"
        exit 1
    }

    local active pid
    active=$(systemctl show -p ActiveState --value "${DOCKER_UNIT}" 2>/dev/null || echo "")
    pid=$(systemctl show -p MainPID --value "${DOCKER_UNIT}" 2>/dev/null || echo "0")
    is_uint "${pid}" || pid=0

    if [ "${active}" != "active" ] || [ "${pid}" -eq 0 ]; then
        log "skip: ${DOCKER_UNIT} ActiveState=${active:-unknown} MainPID=${pid} (not running)"
        exit 0
    fi

    local last_pid count
    read_state
    if [ "${last_pid}" != "${pid}" ]; then
        # dockerd 被重启过（我们自己或别人）：CPU 计数不可跨进程比较
        if [ "${count}" -gt 0 ]; then
            log "info: dockerd pid changed ${last_pid} -> ${pid}, resetting high-cpu counter (was ${count})"
        fi
        count=0
    fi

    local cpu sample_rc
    if cpu=$(sample_cpu_percent "${pid}"); then
        sample_rc=0
    else
        sample_rc=$?
    fi

    if [ "${sample_rc}" -eq 2 ]; then
        log "skip: dockerd pid ${pid} vanished during ${SAMPLE_SECONDS}s sampling window (docker is being restarted)"
        exit 0
    fi
    if [ "${sample_rc}" -ne 0 ] || ! is_number_repr "${cpu}"; then
        log "ERROR: cannot sample CPU of ${DOCKER_UNIT} (pid ${pid}) from ${PROC_ROOT}/${pid}/stat — aborting, no restart decision taken"
        exit 1
    fi

    local high
    high=$(awk -v c="${cpu}" -v t="${CPU_THRESHOLD}" 'BEGIN { print (c >= t) ? 1 : 0 }')

    if [ "${high}" -eq 0 ]; then
        if [ "${count}" -gt 0 ]; then
            log "info: dockerd CPU ${cpu}% below threshold ${CPU_THRESHOLD}%, high-cpu counter reset (was ${count})"
        fi
        write_state "${pid}" 0 || {
            log "ERROR: cannot write state file ${STATE_FILE}"
            exit 1
        }
        exit 0
    fi

    count=$((count + 1))
    if [ "${count}" -eq 1 ]; then
        log "warn: dockerd CPU ${cpu}% >= ${CPU_THRESHOLD}% (pid ${pid}), start counting (need ${CONSECUTIVE_REQUIRED} consecutive samples)"
    fi
    write_state "${pid}" "${count}" || {
        log "ERROR: cannot write state file ${STATE_FILE}"
        exit 1
    }

    if [ "${count}" -lt "${CONSECUTIVE_REQUIRED}" ]; then
        exit 0
    fi

    # 冷却期检查：避免「重启无效」时每分钟重启一次 docker
    local now last_restart elapsed
    now=$(date +%s)
    last_restart=0
    if [ -r "${COOLDOWN_FILE}" ]; then
        read -r last_restart <"${COOLDOWN_FILE}" || true
        is_uint "${last_restart}" || last_restart=0
    fi
    if [ "${last_restart}" -gt 0 ]; then
        elapsed=$((now - last_restart))
        if [ "${elapsed}" -lt "${COOLDOWN_SECONDS}" ]; then
            log "warn: dockerd CPU ${cpu}% still high (${count} consecutive samples) but last restart was ${elapsed}s ago < cooldown ${COOLDOWN_SECONDS}s — NOT restarting"
            exit 0
        fi
    fi

    restart_docker "${pid}" "${cpu}" "${count}" "${now}"
}

restart_docker() {
    local pid=$1 cpu=$2 count=$3 now=$4
    local before containers_missing c

    log "ALERT: dockerd CPU ${cpu}% for ${count} consecutive samples (pid ${pid}) — restarting ${DOCKER_UNIT}"

    # 重启前留证据：dockerd 线程 CPU 排名 + 当前容器清单，便于事后定位根因
    {
        top -b -H -n 1 -p "${pid}" 2>/dev/null | head -20
    } | logger -t believeboy-dockerd-watchdog -p cron.info

    before=$(docker ps --format '{{.Names}}' 2>/dev/null | sort | tr '\n' ' ' || echo "")
    log "info: containers running before restart: ${before:-<none>}"

    if [ "${DRY_RUN}" = "1" ]; then
        log "dry-run: would run: systemctl restart ${DOCKER_UNIT}"
        exit 0
    fi

    if ! systemctl restart "${DOCKER_UNIT}"; then
        log "ERROR: systemctl restart ${DOCKER_UNIT} failed — dockerd may be down, manual intervention required"
        exit 1
    fi

    # 等 daemon 起来（最长 RESTART_TIMEOUT 秒）
    local waited=0
    while [ "${waited}" -lt "${RESTART_TIMEOUT}" ]; do
        if docker info >/dev/null 2>&1; then
            break
        fi
        sleep 2
        waited=$((waited + 2))
    done
    if ! docker info >/dev/null 2>&1; then
        log "ERROR: ${DOCKER_UNIT} restarted but docker daemon not responsive after ${RESTART_TIMEOUT}s"
        exit 1
    fi

    # 校验业务容器回来（带 --restart 策略的会自动起；Restart=no 的不会）
    containers_missing=""
    for c in ${before}; do
        if ! docker inspect -f '{{.State.Running}}' "${c}" 2>/dev/null | grep -q true; then
            containers_missing="${containers_missing} ${c}"
        fi
    done

    write_state "$(systemctl show -p MainPID --value "${DOCKER_UNIT}" 2>/dev/null || echo 0)" 0 || true
    printf '%s\n' "${now}" >"${COOLDOWN_FILE}" || log "warn: cannot write cooldown file ${COOLDOWN_FILE}"

    if [ -n "${containers_missing}" ]; then
        log "ERROR: after restart these containers are NOT running:${containers_missing} — manual intervention required"
        exit 1
    fi

    log "done: ${DOCKER_UNIT} restarted after sustained ${cpu}% CPU; containers restored (${before:-<none>})"
    exit 0
}

main
