#!/bin/bash
#
# PostgreSQL WAL Archive Verification Script
# Verifies that WAL archiving is working correctly
#
# Usage: ./verify-wal-archive.sh
#

set -euo pipefind

PGBACKREST="${PGBACKREST:-pgbackrest}"
STANZA="blf"

main() {
    echo "========== WAL Archive Verification =========="

    # Check pgBackRest configuration
    echo "Checking pgBackRest configuration..."
    if "${PGBACKREST}" check --stanza="${STANZA}"; then
        echo "Configuration check: PASSED"
    else
        echo "Configuration check: FAILED"
        exit 1
    fi

    echo ""
    echo "========== Recent Backups =========="
    "${PGBACKREST}" info --stanza="${STANZA}" --output=text

    echo ""
    echo "========== WAL Archive Status =========="
    "${PGBACKREST}" info --stanza="${STANZA}" --output=text | grep -A 100 "archive" || echo "No archive info available"

    echo ""
    echo "Verification completed."
}

main "$@"