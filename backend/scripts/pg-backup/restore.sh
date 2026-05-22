#!/bin/bash
#
# PostgreSQL Restore Script
# Restores from R2 backup via pgBackRest
#
# Usage:
#   ./restore.sh                 # Restore to latest backup
#   ./restore.sh latest          # Restore to latest backup (explicit)
#   ./restore.sh 2024-01-15      # Restore to specific date
#   ./restore.sh "2024-01-15 14:30:00"  # Restore to specific time (PITR)
#

set -euo pipefail

# =============================================================================
# Configuration - Update these values for your environment
# =============================================================================
STANZA="blf"
PGDATA="/var/lib/postgresql/15/main"  # Adjust to your PostgreSQL data directory
PGBACKREST="${PGBACKREST:-pgbackrest}"
SERVICE_NAME="postgresql"  # systemd service name (postgresql, postgresql-15, etc.)

# =============================================================================
# Logging Functions
# =============================================================================
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
}

log_error() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: $1" >&2
}

# =============================================================================
# Functions
# =============================================================================
show_usage() {
    cat <<USAGE
PostgreSQL Restore Script

Usage:
    $0                 Restore to latest backup
    $0 latest          Restore to latest backup (explicit)
    $0 YYYY-MM-DD      Restore to specific date
    $0 "YYYY-MM-DD HH:MM:SS"  Restore to specific time (PITR)

Examples:
    $0                           # Latest backup
    $0 2024-01-15                # By date
    $0 "2024-01-15 14:30:00"     # Point-in-time recovery

WARNING: This script will stop PostgreSQL before restore!
USAGE
}

stop_postgresql() {
    log "Stopping PostgreSQL (${SERVICE_NAME})..."
    if systemctl is-active --quiet "${SERVICE_NAME}"; then
        systemctl stop "${SERVICE_NAME}"
        log "PostgreSQL stopped"
    else
        log "PostgreSQL already stopped"
    fi
}

start_postgresql() {
    log "Starting PostgreSQL (${SERVICE_NAME})..."
    systemctl start "${SERVICE_NAME}"
    log "PostgreSQL started"
}

restore_latest() {
    log "Restoring to latest backup..."
    "${PGBACKREST}" restore \
        --stanza="${STANZA}" \
        --type=latest \
        --log-level-console=info
}

restore_to_time() {
    local target_time="$1"
    log "Performing Point-in-Time Recovery to: ${target_time}..."

    "${PGBACKREST}" restore \
        --stanza="${STANZA}" \
        --type=time \
        --target="${target_time}" \
        --target-action=promote \
        --log-level-console=info
}

verify_restore() {
    log "Verifying restore..."
    if sudo -u postgres psql -c "SELECT version();" &>/dev/null; then
        log "Restore verification: OK"
    else
        log_error "Restore verification failed!"
        return 1
    fi
}

# =============================================================================
# Main
# =============================================================================
main() {
    local target="${1:-}"

    # Show usage if requested
    if [[ "${target}" == "-h" ]] || [[ "${target}" == "--help" ]]; then
        show_usage
        exit 0
    fi

    # Check if pgbackrest is available
    if ! command -v "${PGBACKREST}" &> /dev/null; then
        log_error "pgbackrest not found"
        exit 1
    fi

    log "========== PostgreSQL Restore Started =========="
    log "Stanza: ${STANZA}"
    log "pgBackRest version: $("${PGBACKREST}" version)"

    # Check for existing backups
    log "Checking available backups..."
    "${PGBACKREST}" info --stanza="${STANZA}"

    # Stop PostgreSQL
    stop_postgresql

    # Perform restore based on target
    if [[ -z "${target}" ]] || [[ "${target}" == "latest" ]]; then
        restore_latest
    else
        restore_to_time "${target}"
    fi

    # Start PostgreSQL
    start_postgresql

    # Verify
    verify_restore

    log "========== Restore Completed =========="
    log "NOTE: After restore, PostgreSQL may create a new timeline."
    log "      Check logs with: sudo journalctl -u ${SERVICE_NAME} -n 50"
}

# =============================================================================
# Entry Point
# =============================================================================
main "$@"