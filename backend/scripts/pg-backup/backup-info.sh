#!/bin/bash
#
# PostgreSQL Backup Info Script
# Shows backup status from pgBackRest
#
# Usage: ./backup-info.sh [--json]
#

set -euo pipefind

PGBACKREST="${PGBACKREST:-pgbackrest}"
STANZA="blf"

show_usage() {
    cat <<USAGE
PostgreSQL Backup Info Script

Usage:
    $0           Show backup info in text format
    $0 --json    Show backup info in JSON format
    $0 --verify  Verify all backups

Environment:
    PGBACKREST   Path to pgbackrest binary (default: pgbackrest)
    STANZA       Stanza name (default: blf)
USAGE
}

main() {
    local output_format="text"

    case "${1:-}" in
        -h|--help)
            show_usage
            exit 0
            ;;
        --json)
            output_format="json"
            ;;
        --verify)
            echo "Verifying all backups..."
            "${PGBACKREST}" backup-verify --stanza="${STANZA}"
            exit $?
            ;;
    esac

    echo "========== PostgreSQL Backup Status =========="
    echo "Stanza: ${STANZA}"
    echo "pgBackRest version: $("${PGBACKREST}" version)"
    echo ""

    "${PGBACKREST}" info --stanza="${STANZA}" --output="${output_format}"
}

main "$@"