#!/bin/bash
#
# PostgreSQL Daily Full Backup Script
# Backups to Cloudflare R2 via pgBackRest
#
# Usage: ./daily-full-backup.sh
# Cron: 0 3 * * * /opt/postgresql/backup/daily-full-backup.sh >> /var/log/pgbackrest/cron.log 2>&1
#

set -euo pipefail

# =============================================================================
# Configuration - Update these values for your environment
# =============================================================================
STANZA="blf"
LOG_DIR="/var/log/pgbackrest"
RETENTION_FULL="7"

# pgBackRest binary (full path if not in PATH)
PGBACKREST="${PGBACKREST:-pgbackrest}"

# =============================================================================
# Logging Functions
# =============================================================================
LOG_DATE=$(date '+%Y%m%d')
LOG_FILE="${LOG_DIR}/daily_backup_${LOG_DATE}.log"

log() {
    local msg="[$(date '+%Y-%m-%d %H:%M:%S')] $1"
    echo "$msg" | tee -a "${LOG_FILE}"
}

log_error() {
    local msg="[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: $1"
    echo "$msg" | tee -a "${LOG_FILE}" >&2
}

log_success() {
    log "SUCCESS: $1"
}

log_warn() {
    log "WARNING: $1"
}

# =============================================================================
# Main
# =============================================================================
main() {
    local start_time end_time duration

    log "========== Daily Full Backup Started =========="
    log "Stanza: ${STANZA}"
    log "Log file: ${LOG_FILE}"

    # Ensure log directory exists
    mkdir -p "${LOG_DIR}"

    # Record start time
    start_time=$(date +%s)

    # Check if pgbackrest is available
    if ! command -v "${PGBACKREST}" &> /dev/null; then
        log_error "pgbackrest not found. Please install it first: sudo apt install pgbackrest"
        exit 1
    fi

    # Check pgbackrest version
    log "pgBackRest version: $("${PGBACKREST}" version)"

    # Verify stanza configuration
    log "Checking stanza configuration..."
    if ! "${PGBACKREST}" stanza-show --log-level-console=error; then
        log_error "Stanza configuration error. Run 'pgbackrest stanza-create --stanza=${STANZA}' first."
        exit 1
    fi

    # Execute full backup
    log "Starting full backup..."
    if "${PGBACKREST}" backup \
        --stanza="${STANZA}" \
        --type=full \
        --log-level-console=info \
        --log-path="${LOG_DIR}" \
        --repo1-retention-full="${RETENTION_FULL}"; then

        log_success "Full backup completed"

    else
        log_error "Backup failed!"
        exit 1
    fi

    # Verify backup integrity
    log "Verifying backup..."
    if "${PGBACKREST}" backup-verify --stanza="${STANZA}" --log-level-console=info --log-path="${LOG_DIR}"; then
        log_success "Backup verification passed"
    else
        log_warn "Backup verification reported warnings (check log for details)"
    fi

    # Calculate duration
    end_time=$(date +%s)
    duration=$((end_time - start_time))
    log "Backup duration: ${duration} seconds"

    # Show backup info
    log "========== Backup Info =========="
    "${PGBACKREST}" info --stanza="${STANZA}" --output=text | while IFS= read -r line; do
        log "$line"
    done

    # Cleanup old logs (keep 30 days)
    log "Cleaning up old logs (keeping 30 days)..."
    find "${LOG_DIR}" -name "daily_backup_*.log" -mtime +30 -delete 2>/dev/null || true

    log "========== Daily Full Backup Completed =========="
    exit 0
}

# =============================================================================
# Entry Point
# =============================================================================
main "$@"