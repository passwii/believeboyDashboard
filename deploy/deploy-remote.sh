#!/usr/bin/env bash
set -euo pipefail

export LC_ALL=C
umask 077

API_IMAGE="${API_IMAGE-}"
GO_API_IMAGE="${GO_API_IMAGE-}"
WEB_IMAGE="${WEB_IMAGE-}"
SOURCE_SHA="${SOURCE_SHA-}"
DEPLOY_PATH="${DEPLOY_PATH-}"
STAGING_DIR="${STAGING_DIR-}"
PUBLIC_WEB_HEALTH_URL="${PUBLIC_WEB_HEALTH_URL-}"
PUBLIC_API_HEALTH_URL="${PUBLIC_API_HEALTH_URL-}"
GO_API_OWNED_MODULES="${GO_API_OWNED_MODULES-all}"
GO_API_INTERNAL_URL="${GO_API_INTERNAL_URL:-http://127.0.0.1:8200}"
# The Python stack (FastAPI + Celery) is retired: the Compose file has no api,
# celery, celery-scheduled or beat service. The array is kept empty so every
# call site stays unchanged and a profile can be reintroduced in one place.
COMPOSE_PROFILE_ARGS=()
# Space policy: absolute floors are the primary guard (a hard 10% rule is
# unreachable on a 15 GiB VPS once the running and target image sets coexist).
DEPLOY_FREE_SPACE_PERCENT="${DEPLOY_FREE_SPACE_PERCENT:-0}"       # optional stricter floor, 0 = disabled
DEPLOY_FREE_SPACE_MIN_BYTES="${DEPLOY_FREE_SPACE_MIN_BYTES:-1073741824}"           # 1 GiB general floor
DEPLOY_FREE_SPACE_POST_PULL_MIN_BYTES="${DEPLOY_FREE_SPACE_POST_PULL_MIN_BYTES:-536870912}"  # 512 MiB after pulling target images
DEPLOY_PARTITION_TOTAL_BYTES=""
DEPLOY_MIN_FREE_BYTES=""
DEPLOY_MIN_FREE_POST_PULL_BYTES=""
INTERNAL_AI_PROVIDER_BASE_URL="${INTERNAL_AI_PROVIDER_BASE_URL:-http://127.0.0.1:3100/v1}"
BOOTSTRAP_COPY_FIXED_MARGIN_BYTES=536870912
LEGACY_REPO="${LEGACY_REPO:-/root/believeboyDashboard}"
LEGACY_STORAGE_DIR="${LEGACY_STORAGE_DIR:-$LEGACY_REPO/backend/storage}"
LEGACY_CELERYBEAT_DIR="${LEGACY_CELERYBEAT_DIR:-/var/lib/believeboy}"

API_REPOSITORY="ghcr.io/passwii/believeboydashboard-api"
GO_API_REPOSITORY="ghcr.io/passwii/believeboydashboard-go-api"
WEB_REPOSITORY="ghcr.io/passwii/believeboydashboard-web"

CONTAINER_GO_API="believeboy-dashboard-go-api"
CONTAINER_WEB="believeboy-dashboard-web"
HEALTH_ATTEMPTS="${HEALTH_ATTEMPTS:-30}"
ROLLBACK_DIR=""
ROLLBACK_ARMED=0
ROLLBACK_ATTEMPTED=0
ROLLBACK_STATE="none"
MANIFEST_TMP=""
CONFIG_TEMP_FILES=()
DF_SUMMARY=""
DOCKER_DF_SUMMARY=""
AVAILABLE_BYTES=""
TOTAL_IMAGE_REFS_REMOVED=0
USAGE_HELPERS_READY=0
DEPLOY_FINALIZATION_FAILED=0
TARGET_CONFIG_ACTIVE=0
LEGACY_RUNTIME_STOPPED=0
LEGACY_CONTAINER_EXISTS=0
LEGACY_CONTAINER_WAS_RUNNING=0
LEGACY_ACTIVE_SERVICES=()
LEGACY_SYSTEMD_SERVICES=(
  believeboy-api.service
  believeboy-celery.service
  believeboy-celery-scheduled.service
  believeboy-beat.service
)

die() {
  echo "$*" >&2
  exit 1
}

if [[ -z "$DEPLOY_PATH" ]]; then
  die "DEPLOY_PATH is required."
fi
if [[ "$DEPLOY_PATH" != /* || ! -d "$DEPLOY_PATH" ]]; then
  die "DEPLOY_PATH must be an existing absolute directory."
fi
DEPLOY_PATH="$(cd -- "$DEPLOY_PATH" && pwd -P)" ||
  die "Could not resolve DEPLOY_PATH."

if [[ -z "$STAGING_DIR" ]]; then
  die "STAGING_DIR is required."
fi
if [[ "$STAGING_DIR" != /* ]]; then
  die "STAGING_DIR must be an absolute path under DEPLOY_PATH."
fi
while [[ "$STAGING_DIR" == */ && "$STAGING_DIR" != "/" ]]; do
  STAGING_DIR="${STAGING_DIR%/}"
done

STAGING_NAME="${STAGING_DIR##*/}"
STAGING_PARENT="${STAGING_DIR%/*}"
STAGING_PARENT="${STAGING_PARENT:-/}"
if [[ "$STAGING_NAME" != .deploy-staging.* ||
  "$STAGING_NAME" == ".deploy-staging." ]]; then
  die "STAGING_DIR must be a .deploy-staging.* directory directly under DEPLOY_PATH."
fi
if [[ ! -d "$STAGING_DIR" || -L "$STAGING_DIR" ]]; then
  die "STAGING_DIR must be an existing directory and must not be a symlink."
fi
STAGING_PARENT="$(cd -- "$STAGING_PARENT" && pwd -P)" ||
  die "Could not resolve STAGING_DIR parent."
if [[ "$STAGING_PARENT" != "$DEPLOY_PATH" ]]; then
  die "STAGING_DIR must be directly under DEPLOY_PATH."
fi
STAGING_REAL="$(cd -- "$STAGING_DIR" && pwd -P)" ||
  die "Could not resolve STAGING_DIR."
if [[ "$STAGING_REAL" != "$DEPLOY_PATH/$STAGING_NAME" ]]; then
  die "STAGING_DIR resolves outside DEPLOY_PATH."
fi
STAGING_DIR="$STAGING_REAL"

trap cleanup_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

cleanup_exit() {
  local status=$?
  local temporary_file
  trap - EXIT INT TERM
  set +e

  if (( status != 0 && ROLLBACK_ARMED == 1 && ROLLBACK_ATTEMPTED == 0 )); then
    ROLLBACK_ATTEMPTED=1
    echo "Deployment failed; collecting Compose diagnostics and attempting rollback." >&2
    docker compose ps >&2 || true
    docker compose logs --tail=150 >&2 || true
    if rollback; then
      ROLLBACK_ARMED=0
      ROLLBACK_STATE="resolved"
      echo "Rollback completed." >&2
    else
      ROLLBACK_STATE="preserve"
      echo "Automatic rollback was incomplete; restore files from $ROLLBACK_DIR." >&2
      if legacy_runtime_was_active; then
        if ! stop_failed_compose; then
          echo "Warning: could not stop the failed Compose runtime; legacy writers were not restarted to avoid running both app sets." >&2
        elif ! restart_legacy_runtime; then
          echo "Warning: could not restore legacy writers that were active before deployment." >&2
        fi
      fi
    fi
  fi

  for temporary_file in "${CONFIG_TEMP_FILES[@]+"${CONFIG_TEMP_FILES[@]}"}"; do
    [[ -n "$temporary_file" ]] && rm -f -- "$temporary_file"
  done
  if [[ -n "$MANIFEST_TMP" ]]; then
    rm -f -- "$MANIFEST_TMP"
  fi
  rm -rf -- "$STAGING_DIR"

  if [[ -n "$ROLLBACK_DIR" && -d "$ROLLBACK_DIR" ]]; then
    if [[ "$ROLLBACK_STATE" == "preserve" ]]; then
      echo "Rollback files retained at $ROLLBACK_DIR." >&2
    elif ! rm -rf -- "$ROLLBACK_DIR"; then
      echo "Warning: could not remove rollback directory $ROLLBACK_DIR." >&2
    fi
  fi

  if (( USAGE_HELPERS_READY == 1 )); then
    if ! log_disk_usage "transaction end"; then
      echo "Could not collect final disk and Docker usage." >&2
    fi
  else
    if [[ -n "$SOURCE_SHA" ]]; then
      echo "Deployment source SHA: $SOURCE_SHA"
      echo "Deployment image digests: Go API=${GO_API_IMAGE##*@} Web=${WEB_IMAGE##*@}"
    fi
    echo "Successfully removed Dashboard image refs: $TOTAL_IMAGE_REFS_REMOVED"
  fi

  exit "$status"
}

for staged_file in docker-compose.yml deploy-remote.sh; do
  if [[ ! -f "$STAGING_DIR/$staged_file" || -L "$STAGING_DIR/$staged_file" ]]; then
    die "Missing regular staged file: $STAGING_DIR/$staged_file"
  fi
done
for staged_file in web.env go.env .go-api-secret; do
  if [[ -e "$STAGING_DIR/$staged_file" || -L "$STAGING_DIR/$staged_file" ]]; then
    if [[ ! -f "$STAGING_DIR/$staged_file" || -L "$STAGING_DIR/$staged_file" ]]; then
      die "Staged file must be a regular file: $STAGING_DIR/$staged_file"
    fi
  fi
done
if [[ -f "$STAGING_DIR/web.env" && -f "$STAGING_DIR/go.env" &&
  ! -e "$STAGING_DIR/.go-api-secret" ]]; then
  STAGING_MODE="ssh"
elif [[ ! -e "$STAGING_DIR/web.env" && ! -e "$STAGING_DIR/go.env" &&
  -f "$STAGING_DIR/.go-api-secret" ]]; then
  STAGING_MODE="actions"
else
  die "Staging must contain either web.env and go.env, or only .go-api-secret, alongside Compose and the remote script."
fi

if [[ ! "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  die "SOURCE_SHA must be a full 40-character lowercase Git commit SHA."
fi
if [[ ! "$GO_API_IMAGE" =~ ^ghcr\.io/passwii/believeboydashboard-go-api@sha256:[0-9a-f]{64}$ ]]; then
  die "GO_API_IMAGE must be a digest reference for $GO_API_REPOSITORY."
fi
if [[ ! "$WEB_IMAGE" =~ ^ghcr\.io/passwii/believeboydashboard-web@sha256:[0-9a-f]{64}$ ]]; then
  die "WEB_IMAGE must be a digest reference for $WEB_REPOSITORY."
fi
if [[ "$PUBLIC_WEB_HEALTH_URL" != "https://dash.believeboy.com/healthz" ]]; then
  die "PUBLIC_WEB_HEALTH_URL must be exactly https://dash.believeboy.com/healthz."
fi
if [[ "$PUBLIC_API_HEALTH_URL" != "https://dash-api.believeboy.com/api/v1/health/ready" ]]; then
  die "PUBLIC_API_HEALTH_URL must be exactly https://dash-api.believeboy.com/api/v1/health/ready."
fi
if [[ ! "$GO_API_OWNED_MODULES" =~ ^([a-z_]+(,[a-z_]+)*)?$ ]]; then
  die "GO_API_OWNED_MODULES must be empty or a comma-separated list of lowercase module names."
fi
if [[ "$GO_API_INTERNAL_URL" != "http://127.0.0.1:8200" ]]; then
  die "GO_API_INTERNAL_URL must be http://127.0.0.1:8200 (Go gateway); FastAPI is retired."
fi
if [[ ! "$HEALTH_ATTEMPTS" =~ ^[1-9][0-9]*$ ]]; then
  die "HEALTH_ATTEMPTS must be a positive integer."
fi
if [[ "$INTERNAL_AI_PROVIDER_BASE_URL" == *$'\n'* ]]; then
  die "INTERNAL_AI_PROVIDER_BASE_URL must be a single-line value."
fi
for name in DEPLOY_FREE_SPACE_MIN_BYTES DEPLOY_FREE_SPACE_POST_PULL_MIN_BYTES; do
  if [[ ! "${!name}" =~ ^[0-9]+$ ]]; then
    die "$name must be a byte count (digits only)."
  fi
  if (( ${!name} < 104857600 )); then
    die "$name must be at least 104857600 bytes (100 MiB)."
  fi
done
if [[ ! "$DEPLOY_FREE_SPACE_PERCENT" =~ ^[0-9]+$ ]] ||
  (( DEPLOY_FREE_SPACE_PERCENT > 50 )); then
  die "DEPLOY_FREE_SPACE_PERCENT must be an integer between 0 and 50 (0 disables the percentage floor)."
fi

DEPLOY_LOCK="$DEPLOY_PATH/.deploy.lock"
if ! command -v flock >/dev/null 2>&1; then
  die "flock is required to serialize remote deployments."
fi
exec 9>"$DEPLOY_LOCK" || die "Could not open deployment lock: $DEPLOY_LOCK"
chmod 600 "$DEPLOY_LOCK" || die "Could not secure deployment lock: $DEPLOY_LOCK"
if ! flock -n 9; then
  die "Another deployment holds $DEPLOY_LOCK; refusing to change the active deployment."
fi

cd -- "$DEPLOY_PATH"

find "$DEPLOY_PATH" -mindepth 1 -maxdepth 1 -type d \
  -name '.deploy-staging.*' ! -path "$STAGING_DIR" -mmin +1440 \
  -exec rm -rf -- {} + ||
  die "Could not remove stale deployment staging directories."
find "$DEPLOY_PATH" -mindepth 1 -maxdepth 1 -type f \
  -name '.deploy-images.next.*' -delete ||
  die "Could not remove stale image manifest files."

decimal_normalize() {
  local value="$1"
  while [[ ${#value} -gt 1 && "${value:0:1}" == "0" ]]; do
    value="${value:1}"
  done
  printf '%s' "$value"
}

decimal_add() {
  local left
  local right
  local carry=0
  local digit_left
  local digit_right
  local sum
  local result=""

  left="$(decimal_normalize "$1")"
  right="$(decimal_normalize "$2")"
  while [[ -n "$left" || -n "$right" || "$carry" -gt 0 ]]; do
    digit_left=0
    digit_right=0
    if [[ -n "$left" ]]; then
      digit_left="${left: -1}"
      left="${left%?}"
    fi
    if [[ -n "$right" ]]; then
      digit_right="${right: -1}"
      right="${right%?}"
    fi
    sum=$((digit_left + digit_right + carry))
    result="$((sum % 10))$result"
    carry=$((sum / 10))
  done
  printf '%s' "$result"
}

decimal_divide_by_ten() {
  local value

  value="$(decimal_normalize "$1")"
  if (( ${#value} <= 1 )); then
    printf '0'
    return 0
  fi
  printf '%s' "${value%?}"
}

decimal_is_less() {
  local left="$1"
  local right="$2"
  if (( ${#left} < ${#right} )); then
    return 0
  fi
  if (( ${#left} > ${#right} )); then
    return 1
  fi
  [[ "$left" < "$right" ]]
}

decimal_is_greater() {
  local left="$1"
  local right="$2"
  if (( ${#left} > ${#right} )); then
    return 0
  fi
  if (( ${#left} < ${#right} )); then
    return 1
  fi
  [[ "$left" > "$right" ]]
}

report_space_summaries() {
  echo "df summary:" >&2
  if [[ -n "$DF_SUMMARY" ]]; then
    printf '%s\n' "$DF_SUMMARY" >&2
  else
    echo "(unavailable)" >&2
  fi
  echo "docker system df summary:" >&2
  if [[ -n "$DOCKER_DF_SUMMARY" ]]; then
    printf '%s\n' "$DOCKER_DF_SUMMARY" >&2
  else
    echo "(unavailable)" >&2
  fi
}

collect_disk_usage() {
  local df_status=0
  local docker_df_status=0

  if DF_SUMMARY="$(df -B1 --output=size,avail "$DEPLOY_PATH" 2>&1)"; then
    :
  else
    df_status=$?
  fi
  if DOCKER_DF_SUMMARY="$(docker system df 2>&1)"; then
    :
  else
    docker_df_status=$?
  fi

  DEPLOY_PARTITION_TOTAL_BYTES="$(printf '%s\n' "$DF_SUMMARY" |
    awk 'NR == 2 { print $1; exit }')"
  AVAILABLE_BYTES="$(printf '%s\n' "$DF_SUMMARY" |
    awk 'NR == 2 { print $2; exit }')"
  if (( df_status != 0 || docker_df_status != 0 )) ||
    [[ ! "$DEPLOY_PARTITION_TOTAL_BYTES" =~ ^[0-9]+$ ]] ||
    [[ ! "$AVAILABLE_BYTES" =~ ^[0-9]+$ ]]; then
    echo "Could not collect valid deployment disk and image usage summaries." >&2
    report_space_summaries
    return 1
  fi

  DEPLOY_PARTITION_TOTAL_BYTES="$(decimal_normalize "$DEPLOY_PARTITION_TOTAL_BYTES")"
  AVAILABLE_BYTES="$(decimal_normalize "$AVAILABLE_BYTES")"
  DEPLOY_MIN_FREE_BYTES="$(free_space_requirement "$DEPLOY_FREE_SPACE_MIN_BYTES")"
  DEPLOY_MIN_FREE_POST_PULL_BYTES="$(free_space_requirement "$DEPLOY_FREE_SPACE_POST_PULL_MIN_BYTES")"
  echo "Deployment partition total: $DEPLOY_PARTITION_TOTAL_BYTES bytes"
  echo "Free space policy: general floor=$DEPLOY_MIN_FREE_BYTES bytes; after target pull floor=$DEPLOY_MIN_FREE_POST_PULL_BYTES bytes; percentage floor=${DEPLOY_FREE_SPACE_PERCENT}% (0 = disabled)"
  echo "Available disk bytes: $AVAILABLE_BYTES"
  echo "Docker image occupancy summary:"
  printf '%s\n' "$DOCKER_DF_SUMMARY"
}

log_disk_usage() {
  local phase="$1"
  echo "Disk and Docker usage [$phase]:"
  echo "Deployment source SHA: $SOURCE_SHA"
  echo "Deployment image digests: Go API=${GO_API_IMAGE##*@} Web=${WEB_IMAGE##*@}"
  echo "Successfully removed Dashboard image refs: $TOTAL_IMAGE_REFS_REMOVED"
  collect_disk_usage
}

free_space_requirement() {
  local base_bytes="$1"
  local required="$base_bytes"
  if (( DEPLOY_FREE_SPACE_PERCENT > 0 )); then
    local percentage_required
    percentage_required="$(( DEPLOY_PARTITION_TOTAL_BYTES * DEPLOY_FREE_SPACE_PERCENT / 100 ))"
    if (( percentage_required > required )); then
      required="$percentage_required"
    fi
  fi
  printf '%s' "$required"
}

require_free_space() {
  local phase="$1"
  local required="${2:-$DEPLOY_MIN_FREE_BYTES}"
  if ! decimal_is_greater "$AVAILABLE_BYTES" "$required"; then
    echo "Available disk space after $phase ($AVAILABLE_BYTES bytes) must be strictly greater than the required $required bytes (partition total $DEPLOY_PARTITION_TOTAL_BYTES bytes; general floor $DEPLOY_FREE_SPACE_MIN_BYTES, post-pull floor $DEPLOY_FREE_SPACE_POST_PULL_MIN_BYTES, percentage floor ${DEPLOY_FREE_SPACE_PERCENT}%); refusing to stop legacy services or run migrations." >&2
    echo "Hint: the deploy only prunes unreferenced images from the three Dashboard GHCR repositories; free space manually (legacy repo/cache) or raise DEPLOY_FREE_SPACE_* only if the disk can take it." >&2
    report_space_summaries
    return 1
  fi
}

directory_allocated_bytes() {
  local directory="$1"
  local du_output
  local size

  if ! du_output="$(du -s -B1L -- "$directory" 2>&1)"; then
    echo "Could not estimate legacy data size for $directory: $du_output" >&2
    return 1
  fi
  size="$(printf '%s\n' "$du_output" | awk 'NR == 1 { print $1 }')"
  if [[ ! "$size" =~ ^[0-9]+$ ]]; then
    echo "Could not parse allocated bytes for $directory: $du_output" >&2
    return 1
  fi
  decimal_normalize "$size"
}

legacy_data_copy_bytes() {
  local total=0
  local size

  if [[ -d "$LEGACY_STORAGE_DIR" && ! -f "$DEPLOY_PATH/.storage-migrated" ]]; then
    size="$(directory_allocated_bytes "$LEGACY_STORAGE_DIR")" || return 1
    total="$(decimal_add "$total" "$size")"
  fi
  if [[ -d "$LEGACY_CELERYBEAT_DIR" &&
    ! -f "$DEPLOY_PATH/.celerybeat-migrated" ]]; then
    size="$(directory_allocated_bytes "$LEGACY_CELERYBEAT_DIR")" || return 1
    total="$(decimal_add "$total" "$size")"
  fi
  printf '%s' "$total"
}

require_bootstrap_copy_space() {
  local copy_bytes
  local percentage_margin
  local safety_margin
  local required_bytes

  copy_bytes="$(legacy_data_copy_bytes)" || return 1
  if [[ "$copy_bytes" == "0" ]]; then
    echo "No legacy data copy is required."
    return 0
  fi

  if ! log_disk_usage "before legacy data copy"; then
    return 1
  fi
  percentage_margin="$(decimal_divide_by_ten "$copy_bytes")"
  safety_margin="$(decimal_add "$percentage_margin" "$BOOTSTRAP_COPY_FIXED_MARGIN_BYTES")"
  required_bytes="$(decimal_add "$DEPLOY_MIN_FREE_BYTES" "$copy_bytes")"
  required_bytes="$(decimal_add "$required_bytes" "$safety_margin")"

  echo "Estimated legacy data copy: $copy_bytes bytes."
  echo "Bootstrap copy safety margin: $safety_margin bytes (10% plus 512 MiB)."
  echo "Required free space before legacy data copy: $required_bytes bytes."
  if decimal_is_less "$AVAILABLE_BYTES" "$required_bytes"; then
    echo "Available disk space ($AVAILABLE_BYTES bytes) is below the safe legacy copy requirement ($required_bytes bytes); refusing to copy legacy data." >&2
    report_space_summaries
    return 1
  fi
}

is_protected_ref() {
  local candidate="$1"
  local reference
  for reference in "${PROTECTED_REFS[@]+"${PROTECTED_REFS[@]}"}"; do
    [[ "$reference" == "$candidate" ]] && return 0
  done
  return 1
}

is_protected_image_id() {
  local candidate="$1"
  local image_id
  for image_id in "${PROTECTED_IMAGE_IDS[@]+"${PROTECTED_IMAGE_IDS[@]}"}"; do
    [[ "$image_id" == "$candidate" ]] && return 0
  done
  return 1
}

prune_ref() {
  local reference="$1"
  local image_id="$2"
  local output

  if is_protected_ref "$reference"; then
    return 0
  fi
  if is_protected_image_id "$image_id"; then
    return 0
  fi
  if output="$(docker image rm "$reference" 2>&1)"; then
    TOTAL_IMAGE_REFS_REMOVED=$((TOTAL_IMAGE_REFS_REMOVED + 1))
    echo "Removed unused Dashboard image reference $reference."
  else
    echo "Warning: could not remove Dashboard image reference $reference: $output" >&2
  fi
}

prune_dashboard_images() {
  local repository
  local container_ids
  local container_id
  local image_id
  local manifest_key
  local manifest_ref
  local image_rows
  local row_repository
  local tag
  local digest
  local protect_target_refs="${1:-1}"

  PROTECTED_IMAGE_IDS=()
  PROTECTED_REFS=()
  if [[ "$protect_target_refs" == "1" ]]; then
    PROTECTED_REFS+=("$GO_API_IMAGE" "$WEB_IMAGE")
  fi

  if ! container_ids="$(docker ps -aq --no-trunc 2>&1)"; then
    echo "Could not enumerate container image references; refusing image cleanup: $container_ids" >&2
    return 1
  fi
  while IFS= read -r container_id; do
    [[ -n "$container_id" ]] || continue
    if ! image_id="$(docker inspect --format '{{.Image}}' "$container_id" 2>&1)"; then
      echo "Could not inspect container $container_id; refusing image cleanup: $image_id" >&2
      return 1
    fi
    [[ -n "$image_id" ]] && PROTECTED_IMAGE_IDS+=("$image_id")
  done <<< "$container_ids"

  if [[ -f "$DEPLOY_PATH/.deploy-images" ]]; then
    while IFS='=' read -r manifest_key manifest_ref; do
      case "$manifest_key" in
        API_IMAGE|GO_API_IMAGE|WEB_IMAGE)
          [[ -n "$manifest_ref" ]] && PROTECTED_REFS+=("$manifest_ref")
          ;;
      esac
    done < "$DEPLOY_PATH/.deploy-images"
  fi

  for repository in "$API_REPOSITORY" "$GO_API_REPOSITORY" "$WEB_REPOSITORY"; do
    if ! image_rows="$(docker image ls --no-trunc --digests \
      --format '{{.Repository}}|{{.Tag}}|{{.Digest}}|{{.ID}}' "$repository" 2>&1)"; then
      echo "Could not enumerate image references for $repository; refusing image cleanup: $image_rows" >&2
      return 1
    fi

    while IFS='|' read -r row_repository tag digest image_id; do
      [[ "$row_repository" == "$repository" && -n "$image_id" ]] || continue
      if [[ -n "$tag" && "$tag" != "<none>" ]]; then
        prune_ref "$repository:$tag" "$image_id"
      fi
      if [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
        prune_ref "$repository@$digest" "$image_id"
      fi
    done <<< "$image_rows"
  done
}

saved_image() {
  local key="$1"
  local manifest="$DEPLOY_PATH/.deploy-images"
  [[ -f "$manifest" ]] || return 0
  awk -F= -v wanted="$key" '$1 == wanted { print substr($0, index($0, "=") + 1); exit }' \
    "$manifest"
}

wait_for_url() {
  local label="$1"
  local url="$2"
  local attempt

  for ((attempt = 1; attempt <= HEALTH_ATTEMPTS; attempt++)); do
    if curl -fsS --max-time 5 "$url" >/dev/null; then
      echo "$label healthy after $attempt attempt(s)."
      return 0
    fi
    sleep 2
  done
  return 1
}

# Owned-route smoke check. /health/live is not enough when the gateway owns
# modules: on 2026-11-10 the alpine runtime image missed tzdata, so every
# DB-backed owned route returned 500 while liveness stayed green. Only run
# this when the deployment actually enables a Go ownership list.
verify_owned_routes() {
  local owned="${GO_API_OWNED_MODULES-}"
  local api_key
  local proxy_secret
  local health_body

  if [[ -z "$owned" ]]; then
    echo "Go gateway owns no modules (GO_API_OWNED is empty); skipping owned-route smoke checks."
    return 0
  fi

  api_key="$(sed -n 's/^API_KEY=//p' "$DEPLOY_PATH/backend.env" | head -n 1)"
  proxy_secret="$(sed -n 's/^GO_API_TRUSTED_PROXY_SECRET=//p' "$DEPLOY_PATH/go.env" | head -n 1)"
  if [[ -z "$api_key" || -z "$proxy_secret" ]]; then
    die "Go gateway owns modules ($owned) but API_KEY / GO_API_TRUSTED_PROXY_SECRET is missing; refusing to keep the cutover."
  fi

  if ! health_body="$(curl -fsS --max-time 10 \
    -H "X-API-Key: $api_key" \
    -H "X-Trusted-Proxy-Secret: $proxy_secret" \
    http://127.0.0.1:8200/api/v1/health)"; then
    die "Go API gateway DB health request failed while GO_API_OWNED=$owned."
  fi
  if [[ "$health_body" != *'"status":"ok"'* ]]; then
    die "Go API gateway reports degraded health while GO_API_OWNED=$owned: $health_body"
  fi

  if ! curl -fsS --max-time 10 -o /dev/null \
    -H "X-API-Key: $api_key" \
    -H "X-Trusted-Proxy-Secret: $proxy_secret" \
    "http://127.0.0.1:8200/api/v1/exchange-rates?page=1&page_size=1"; then
    die "Go API gateway owned-route smoke check failed (/api/v1/exchange-rates) while GO_API_OWNED=$owned."
  fi
  echo "Go API owned-route smoke checks passed for: $owned"
}

prepare_config_file() {
  local source="$1"
  local mode="$2"
  local temporary_file

  temporary_file="$(mktemp "$DEPLOY_PATH/.deploy-config.next.XXXXXX")" || return 1
  CONFIG_TEMP_FILES+=("$temporary_file")
  if ! cp -p -- "$source" "$temporary_file"; then
    echo "Could not stage active config from $source." >&2
    return 1
  fi
  if [[ "$mode" == "secret" ]] && ! chmod 600 "$temporary_file"; then
    echo "Could not secure staged runtime config from $source." >&2
    return 1
  fi
  PREPARED_CONFIG_FILE="$temporary_file"
}

update_env_value() {
  local file="$1"
  local key="$2"
  local value="$3"
  local escaped_value="$value"
  local temporary_file

  escaped_value="${escaped_value//\\/\\\\}"
  escaped_value="${escaped_value//&/\\&}"
  escaped_value="${escaped_value//|/\\|}"
  temporary_file="$(mktemp "${file}.next.XXXXXX")" || return 1
  if grep -q "^${key}=" "$file"; then
    if ! sed "s|^${key}=.*|${key}=${escaped_value}|" "$file" > "$temporary_file"; then
      rm -f -- "$temporary_file"
      return 1
    fi
  else
    if ! cp -- "$file" "$temporary_file"; then
      rm -f -- "$temporary_file"
      return 1
    fi
    printf '%s=%s\n' "$key" "$value" >> "$temporary_file"
  fi
  if ! mv -f -- "$temporary_file" "$file"; then
    rm -f -- "$temporary_file"
    return 1
  fi
}

bootstrap_runtime() {
  install -d -m 755 "$DEPLOY_PATH/legacy" \
    "$DEPLOY_PATH/backend-storage" "$DEPLOY_PATH/celerybeat"
  if [[ -f "$DEPLOY_PATH/docker-compose.yml" &&
    ! -f "$DEPLOY_PATH/legacy/docker-compose.yml" ]]; then
    cp -p -- "$DEPLOY_PATH/docker-compose.yml" "$DEPLOY_PATH/legacy/docker-compose.yml"
  fi
  if [[ -f "$DEPLOY_PATH/app.env" && ! -f "$DEPLOY_PATH/legacy/app.env" ]]; then
    cp -p -- "$DEPLOY_PATH/app.env" "$DEPLOY_PATH/legacy/app.env"
  fi

  if [[ ! -f "$DEPLOY_PATH/backend.env" ]]; then
    if [[ ! -f "$LEGACY_REPO/backend/.env" ]]; then
      die "backend.env is missing and no legacy backend environment exists at $LEGACY_REPO/backend/.env."
    fi
    install -m 600 "$LEGACY_REPO/backend/.env" "$DEPLOY_PATH/backend.env"
  fi
  update_env_value "$DEPLOY_PATH/backend.env" \
    AI_CHAT_PROVIDER_BASE_URL "$INTERNAL_AI_PROVIDER_BASE_URL"
  chmod 600 "$DEPLOY_PATH/backend.env"

  if [[ ! -f "$DEPLOY_PATH/web.env" ]]; then
    if [[ ! -f "$DEPLOY_PATH/app.env" ]]; then
      die "web.env is missing and no legacy app.env exists at $DEPLOY_PATH/app.env."
    fi
    install -m 600 "$DEPLOY_PATH/app.env" "$DEPLOY_PATH/web.env"
  fi
  chmod 600 "$DEPLOY_PATH/web.env"

  require_bootstrap_copy_space ||
    die "Could not verify sufficient disk space for legacy data copy."
}

copy_legacy_runtime_data() {
  if [[ -d "$LEGACY_STORAGE_DIR" &&
    ! -f "$DEPLOY_PATH/.storage-migrated" ]]; then
    require_bootstrap_copy_space ||
      die "Could not verify sufficient disk space for the legacy storage copy."
    cp -a -- "$LEGACY_STORAGE_DIR/." "$DEPLOY_PATH/backend-storage/"
    touch "$DEPLOY_PATH/.storage-migrated"
  fi
  if [[ -d "$LEGACY_CELERYBEAT_DIR" &&
    ! -f "$DEPLOY_PATH/.celerybeat-migrated" ]]; then
    require_bootstrap_copy_space ||
      die "Could not verify sufficient disk space for the legacy Celery beat copy."
    cp -a -- "$LEGACY_CELERYBEAT_DIR/." "$DEPLOY_PATH/celerybeat/"
    touch "$DEPLOY_PATH/.celerybeat-migrated"
  fi
  chown -R 10001:10001 "$DEPLOY_PATH/backend-storage" "$DEPLOY_PATH/celerybeat"
  if ! log_disk_usage "after legacy data copy"; then
    die "Could not collect disk usage after legacy data copy."
  fi
  require_free_space "legacy data copy" ||
    die "Insufficient disk space after legacy data copy; migration was not run."
}

derive_actions_environment() {
  local secret_file="$STAGING_DIR/.go-api-secret"
  local secret_line
  local secret_value
  local secret_line_count
  local public_api
  local web_env_tmp
  local go_owned="${GO_API_OWNED_MODULES-}"
  local internal_url="${GO_API_INTERNAL_URL:-http://127.0.0.1:8200}"

  chmod 600 "$secret_file"
  secret_line_count="$(awk 'END { print NR }' "$secret_file")"
  IFS= read -r secret_line < "$secret_file" || true
  if [[ "$secret_line_count" != "1" ]] ||
    [[ ! "$secret_line" =~ ^GO_API_TRUSTED_PROXY_SECRET=([0-9a-fA-F]{64})$ ]]; then
    die "The staged Go API secret must contain one 64-character hexadecimal value."
  fi
  secret_value="${BASH_REMATCH[1]}"

  cp -p -- "$DEPLOY_PATH/web.env" "$STAGING_DIR/web.env"
  update_env_value "$STAGING_DIR/web.env" \
    BACKEND_INTERNAL_URL "$internal_url"
  if ! grep -q '^BACKEND_PUBLIC_API_BASE_URL=' "$STAGING_DIR/web.env"; then
    public_api="$(sed -n 's/^BACKEND_API_BASE_URL=//p' "$STAGING_DIR/web.env" | head -1)"
    if [[ -z "$public_api" ]]; then
      die "Could not derive BACKEND_PUBLIC_API_BASE_URL from the current VPS web.env."
    fi
    update_env_value "$STAGING_DIR/web.env" BACKEND_PUBLIC_API_BASE_URL "$public_api"
  fi
  web_env_tmp="$(mktemp "$STAGING_DIR/.web-env.next.XXXXXX")"
  sed '/^GO_API_TRUSTED_PROXY_SECRET=/d' "$STAGING_DIR/web.env" > "$web_env_tmp"
  mv -f -- "$web_env_tmp" "$STAGING_DIR/web.env"
  printf '%s\n' "$secret_line" >> "$STAGING_DIR/web.env"

  {
    printf 'GO_API_ADDR=127.0.0.1:8200\n'
    printf 'FASTAPI_ORIGIN=http://127.0.0.1:8100\n'
    printf 'GO_API_OWNED=%s\n' "$go_owned"
    printf 'GO_API_TRUSTED_PROXY_SECRET=%s\n' "$secret_value"
  } > "$STAGING_DIR/go.env"
  chmod 600 "$STAGING_DIR/web.env" "$STAGING_DIR/go.env"
  rm -f -- "$secret_file"
}

restore_config() {
  local file
  local backup_file
  local temporary_file

  for file in docker-compose.yml backend.env web.env go.env .deploy-images \
    .storage-migrated .celerybeat-migrated; do
    backup_file="$ROLLBACK_DIR/$file"
    if [[ -f "$backup_file" ]]; then
      temporary_file="$(mktemp "$DEPLOY_PATH/.deploy-config.restore.XXXXXX")" || {
        echo "Could not create a temporary file while restoring $file." >&2
        return 1
      }
      CONFIG_TEMP_FILES+=("$temporary_file")
      if ! cp -p -- "$backup_file" "$temporary_file"; then
        echo "Could not restore backup for $file." >&2
        return 1
      fi
      if [[ "$file" == "backend.env" || "$file" == "web.env" ||
        "$file" == "go.env" ]] &&
        ! chmod 600 "$temporary_file"; then
        echo "Could not secure restored runtime config $file." >&2
        return 1
      fi
      if ! mv -f -- "$temporary_file" "$DEPLOY_PATH/$file"; then
        echo "Could not activate restored backup for $file." >&2
        return 1
      fi
    elif ! rm -f -- "$DEPLOY_PATH/$file"; then
      echo "Could not remove newly introduced config $file during rollback." >&2
      return 1
    fi
  done
}

rollback() {
  local rollback_go_api_image
  local rollback_ok=0
  local -a rollback_services=(web)

  if (( TARGET_CONFIG_ACTIVE == 0 )); then
    echo "Restoring runtime config changed during bootstrap..."
    restore_config || rollback_ok=1
    if [[ -z "$previous_web_image" ]] &&
      (( LEGACY_RUNTIME_STOPPED == 1 )); then
      restart_legacy_runtime || rollback_ok=1
    fi
    if (( rollback_ok != 0 )); then
      return 1
    fi
    if ! prune_dashboard_images 0; then
      echo "Warning: Dashboard image cleanup after rollback was incomplete." >&2
    fi
    return 0
  fi

  if [[ -z "$previous_web_image" ]]; then
    echo "No previous FastAPI/Web image set exists; restoring the empty deployment state." >&2
    if ! GO_API_IMAGE="$GO_API_IMAGE" WEB_IMAGE="$WEB_IMAGE" \
      docker compose "${COMPOSE_PROFILE_ARGS[@]}" down --remove-orphans; then
      echo "Could not stop the failed first deployment." >&2
      rollback_ok=1
    fi
    restore_config || rollback_ok=1
    if (( rollback_ok == 0 )); then
      restart_legacy_runtime || rollback_ok=1
    fi
    if (( rollback_ok != 0 )); then
      return 1
    fi
    if ! prune_dashboard_images 0; then
      echo "Warning: Dashboard image cleanup after rollback was incomplete." >&2
    fi
    return 0
  fi

  if [[ -f "$ROLLBACK_DIR/docker-compose.yml" ]] &&
    grep -Eq '^[[:space:]]+go-api:' "$ROLLBACK_DIR/docker-compose.yml" &&
    [[ -z "$previous_go_api_image" ]]; then
    echo "Previous Compose includes Go API, but its image reference is unavailable; refusing an incomplete rollback." >&2
    docker stop "$CONTAINER_GO_API" 2>/dev/null || true
    restore_config || return 1
    return 1
  fi

  echo "Restoring previous Compose and runtime config..."
  restore_config || return 1
  rollback_go_api_image="${previous_go_api_image:-$GO_API_IMAGE}"
  if grep -Eq '^[[:space:]]+go-api:' "$DEPLOY_PATH/docker-compose.yml"; then
    rollback_services+=(go-api)
  fi
  if grep -Eq '^[[:space:]]+go-worker:' "$DEPLOY_PATH/docker-compose.yml"; then
    rollback_services+=(go-worker)
  fi
  if grep -Eq '^[[:space:]]+go-scheduler:' "$DEPLOY_PATH/docker-compose.yml"; then
    rollback_services+=(go-scheduler)
  fi
  if ! GO_API_IMAGE="$rollback_go_api_image" WEB_IMAGE="$previous_web_image" \
    docker compose "${COMPOSE_PROFILE_ARGS[@]}" up -d --no-build --no-deps --remove-orphans "${rollback_services[@]}"; then
    echo "Previous application image set could not be restarted." >&2
    return 1
  fi
  if ! restart_legacy_runtime; then
    echo "Could not restart legacy writers that were active before deployment." >&2
    return 1
  fi

  if [[ -n "$previous_go_api_image" ]]; then
    wait_for_url "Go API rollback" "http://127.0.0.1:8200/api/v1/health/live" || return 1
  fi
  wait_for_url "Web rollback" "http://127.0.0.1:3200/healthz" || return 1
  if ! prune_dashboard_images 0; then
    echo "Warning: Dashboard image cleanup after rollback was incomplete." >&2
  fi
  return 0
}

stop_legacy_runtime() {
  local service
  local container_state

  LEGACY_ACTIVE_SERVICES=()
  for service in "${LEGACY_SYSTEMD_SERVICES[@]}"; do
    if systemctl is-active --quiet "$service"; then
      LEGACY_ACTIVE_SERVICES+=("$service")
    fi
  done

  LEGACY_CONTAINER_EXISTS=0
  LEGACY_CONTAINER_WAS_RUNNING=0
  if container_state="$(docker inspect --format '{{.State.Running}}' believeboy-dashboard 2>/dev/null)"; then
    LEGACY_CONTAINER_EXISTS=1
    [[ "$container_state" == "true" ]] && LEGACY_CONTAINER_WAS_RUNNING=1
  fi

  LEGACY_RUNTIME_STOPPED=1
  for service in "${LEGACY_ACTIVE_SERVICES[@]+"${LEGACY_ACTIVE_SERVICES[@]}"}"; do
    if ! systemctl stop "$service"; then
      echo "Could not stop legacy systemd service $service." >&2
      return 1
    fi
  done
  if (( LEGACY_CONTAINER_WAS_RUNNING == 1 )) &&
    ! docker stop believeboy-dashboard >/dev/null; then
    echo "Could not stop the legacy believeboy-dashboard container." >&2
    return 1
  fi
}

restart_legacy_runtime() {
  local service
  local restart_failed=0

  (( LEGACY_RUNTIME_STOPPED == 1 )) || return 0
  for service in "${LEGACY_ACTIVE_SERVICES[@]+"${LEGACY_ACTIVE_SERVICES[@]}"}"; do
    if ! systemctl start "$service"; then
      echo "Could not restart legacy systemd service $service." >&2
      restart_failed=1
    fi
  done
  if (( LEGACY_CONTAINER_WAS_RUNNING == 1 )) &&
    ! docker start believeboy-dashboard >/dev/null; then
    echo "Could not restart the legacy believeboy-dashboard container." >&2
    restart_failed=1
  fi
  return "$restart_failed"
}

legacy_runtime_was_active() {
  local service

  (( LEGACY_CONTAINER_WAS_RUNNING == 1 )) && return 0
  for service in "${LEGACY_ACTIVE_SERVICES[@]+"${LEGACY_ACTIVE_SERVICES[@]}"}"; do
    [[ -n "$service" ]] && return 0
  done
  return 1
}

stop_failed_compose() {
  local compose_file="$STAGING_DIR/docker-compose.yml"

  if [[ ! -f "$compose_file" && -f "$DEPLOY_PATH/docker-compose.yml" ]]; then
    compose_file="$DEPLOY_PATH/docker-compose.yml"
  fi
  if [[ ! -f "$compose_file" ]]; then
    echo "No Compose configuration is available to stop the failed runtime." >&2
    return 1
  fi
  API_IMAGE="$API_IMAGE" GO_API_IMAGE="$GO_API_IMAGE" WEB_IMAGE="$WEB_IMAGE" \
    docker compose -f "$compose_file" "${COMPOSE_PROFILE_ARGS[@]}" down
}

check_image_revision() {
  local label="$1"
  local image="$2"
  local revision

  if ! revision="$(docker image inspect \
    --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' \
    "$image" 2>&1)"; then
    echo "Could not read the source revision label for $label image $image: $revision" >&2
    return 1
  fi
  if [[ "$revision" != "$SOURCE_SHA" ]]; then
    echo "$label image revision mismatch: expected $SOURCE_SHA, found $revision." >&2
    return 1
  fi
  echo "$label image source revision verified."
}

USAGE_HELPERS_READY=1
if ! log_disk_usage "before pre-pull cleanup"; then
  exit 1
fi

prune_dashboard_images ||
  die "Could not safely prune Dashboard images before deployment."
if ! log_disk_usage "after pre-pull cleanup"; then
  exit 1
fi
require_free_space "pre-pull cleanup" ||
  die "Insufficient disk space after pre-pull image cleanup."

previous_go_api_image="$(saved_image GO_API_IMAGE)"
previous_web_image="$(saved_image WEB_IMAGE)"
previous_go_api_image="${previous_go_api_image:-$(docker inspect --format '{{.Config.Image}}' "$CONTAINER_GO_API" 2>/dev/null || true)}"
previous_web_image="${previous_web_image:-$(docker inspect --format '{{.Config.Image}}' "$CONTAINER_WEB" 2>/dev/null || true)}"

ROLLBACK_DIR="$(mktemp -d "$DEPLOY_PATH/.deploy-rollback.XXXXXX")" ||
  die "Could not create deployment rollback directory."
chmod 700 "$ROLLBACK_DIR" || die "Could not secure rollback directory $ROLLBACK_DIR."
ROLLBACK_STATE="cleanup"
for file in docker-compose.yml backend.env web.env go.env .deploy-images \
  .storage-migrated .celerybeat-migrated; do
  if [[ -f "$DEPLOY_PATH/$file" ]]; then
    cp -p -- "$DEPLOY_PATH/$file" "$ROLLBACK_DIR/$file" ||
      die "Could not back up active deployment file $file."
  fi
done
ROLLBACK_ARMED=1
ROLLBACK_STATE="armed"

bootstrap_runtime
if [[ "$STAGING_MODE" == "actions" ]]; then
  derive_actions_environment
fi
if ! log_disk_usage "after bootstrap"; then
  die "Could not collect disk usage after bootstrap."
fi
require_free_space "bootstrap data copy" ||
  die "Insufficient disk space after bootstrap; legacy services remain untouched."

prepare_config_file "$STAGING_DIR/docker-compose.yml" public ||
  die "Could not prepare staged Compose config."
COMPOSE_CONFIG_TMP="$PREPARED_CONFIG_FILE"
prepare_config_file "$STAGING_DIR/web.env" secret ||
  die "Could not prepare staged Web environment."
WEB_CONFIG_TMP="$PREPARED_CONFIG_FILE"
prepare_config_file "$STAGING_DIR/go.env" secret ||
  die "Could not prepare staged Go environment."
GO_CONFIG_TMP="$PREPARED_CONFIG_FILE"

mv -f -- "$COMPOSE_CONFIG_TMP" "$DEPLOY_PATH/docker-compose.yml" ||
  die "Could not activate staged Compose config."
mv -f -- "$WEB_CONFIG_TMP" "$DEPLOY_PATH/web.env" ||
  die "Could not activate staged Web environment."
mv -f -- "$GO_CONFIG_TMP" "$DEPLOY_PATH/go.env" ||
  die "Could not activate staged Go environment."
TARGET_CONFIG_ACTIVE=1

echo "Pulling Go API and Web images..."
if ! docker compose "${COMPOSE_PROFILE_ARGS[@]}" pull migrate go-api go-worker go-scheduler web; then
  die "Could not pull the target Dashboard image set."
fi

check_image_revision "Go API" "$GO_API_IMAGE" ||
  die "Target Go API image does not match SOURCE_SHA; migration was not run."
check_image_revision "Web" "$WEB_IMAGE" ||
  die "Target Web image does not match SOURCE_SHA; migration was not run."

if ! log_disk_usage "after target image pull"; then
  die "Could not collect disk usage after pulling target images."
fi
require_free_space "target image pull" "$DEPLOY_MIN_FREE_POST_PULL_BYTES" ||
  die "Insufficient disk space after pulling target images; migration was not run."
require_bootstrap_copy_space ||
  die "Insufficient disk space for legacy data copy after pulling target images; legacy services remain untouched."

stop_legacy_runtime ||
  die "Could not stop the legacy runtime before migration."

copy_legacy_runtime_data

echo "Running database migrations..."
if ! docker compose run --rm -T migrate < /dev/null; then
  die "Database migration failed."
fi

if ! docker compose "${COMPOSE_PROFILE_ARGS[@]}" up -d --no-build --remove-orphans; then
  die "Could not start the new Dashboard image set."
fi

if ! wait_for_url "Go API gateway readiness" "http://127.0.0.1:8200/api/v1/health/ready"; then
  die "Go API gateway readiness check failed (database unreachable)."
fi
if ! wait_for_url "Web" "http://127.0.0.1:3200/healthz"; then
  die "Web health check failed."
fi
verify_owned_routes

if ! wait_for_url "Public Web" "$PUBLIC_WEB_HEALTH_URL"; then
  die "Public Web health check failed."
fi
if ! wait_for_url "Public API" "$PUBLIC_API_HEALTH_URL"; then
  die "Public API health check failed."
fi

MANIFEST_TMP="$(mktemp "$DEPLOY_PATH/.deploy-images.next.XXXXXX")" ||
  die "Could not create the next image manifest."
printf 'API_IMAGE=%s\nGO_API_IMAGE=%s\nWEB_IMAGE=%s\n' \
  "$API_IMAGE" "$GO_API_IMAGE" "$WEB_IMAGE" > "$MANIFEST_TMP" ||
  die "Could not write the next image manifest."
chmod 600 "$MANIFEST_TMP" || die "Could not secure the next image manifest."
mv -f -- "$MANIFEST_TMP" "$DEPLOY_PATH/.deploy-images" ||
  die "Could not atomically activate the target image manifest."
MANIFEST_TMP=""

ROLLBACK_ARMED=0
if systemctl disable "${LEGACY_SYSTEMD_SERVICES[@]}" >/dev/null 2>&1; then
  echo "Disabled legacy systemd units."
else
  echo "Warning: could not disable every legacy systemd unit." >&2
fi
for service in "${LEGACY_SYSTEMD_SERVICES[@]}"; do
  if systemctl is-enabled --quiet "$service"; then
    echo "Legacy systemd unit remains enabled: $service" >&2
    DEPLOY_FINALIZATION_FAILED=1
  fi
done

if (( DEPLOY_FINALIZATION_FAILED != 0 )); then
  ROLLBACK_STATE="preserve"
  echo "Deployment is healthy, but legacy systemd finalization is incomplete; rollback files and old images were retained." >&2
else
  ROLLBACK_STATE="resolved"
  if (( LEGACY_CONTAINER_EXISTS == 1 )); then
    if docker rm believeboy-dashboard >/dev/null; then
      echo "Removed the stopped legacy believeboy-dashboard container."
    else
      echo "Warning: could not remove the legacy believeboy-dashboard container." >&2
    fi
  fi
  if ! rm -rf -- "$ROLLBACK_DIR"; then
    echo "Warning: could not remove rollback directory $ROLLBACK_DIR." >&2
  else
    ROLLBACK_DIR=""
  fi

  if ! prune_dashboard_images; then
    echo "Warning: post-deployment Dashboard image enumeration failed; the healthy deployment remains active." >&2
  fi
fi
if ! log_disk_usage "after deployment finalization"; then
  echo "Warning: could not collect disk usage after deployment finalization." >&2
fi
docker compose ps || true
if (( DEPLOY_FINALIZATION_FAILED != 0 )); then
  exit 1
fi
