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
DEPLOY_MIN_FREE_BYTES="${DEPLOY_MIN_FREE_BYTES:-3221225472}"

API_REPOSITORY="ghcr.io/passwii/believeboydashboard-api"
GO_API_REPOSITORY="ghcr.io/passwii/believeboydashboard-go-api"
WEB_REPOSITORY="ghcr.io/passwii/believeboydashboard-web"

CONTAINER_API="believeboy-dashboard-api"
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
    fi
  fi

  for temporary_file in "${CONFIG_TEMP_FILES[@]}"; do
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

  exit "$status"
}

trap cleanup_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

for staged_file in docker-compose.yml web.env go.env deploy-remote.sh; do
  if [[ ! -f "$STAGING_DIR/$staged_file" || -L "$STAGING_DIR/$staged_file" ]]; then
    die "Missing regular staged file: $STAGING_DIR/$staged_file"
  fi
done

if [[ ! "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  die "SOURCE_SHA must be a full 40-character lowercase Git commit SHA."
fi
if [[ ! "$API_IMAGE" =~ ^ghcr\.io/passwii/believeboydashboard-api@sha256:[0-9a-f]{64}$ ]]; then
  die "API_IMAGE must be a digest reference for $API_REPOSITORY."
fi
if [[ ! "$GO_API_IMAGE" =~ ^ghcr\.io/passwii/believeboydashboard-go-api@sha256:[0-9a-f]{64}$ ]]; then
  die "GO_API_IMAGE must be a digest reference for $GO_API_REPOSITORY."
fi
if [[ ! "$WEB_IMAGE" =~ ^ghcr\.io/passwii/believeboydashboard-web@sha256:[0-9a-f]{64}$ ]]; then
  die "WEB_IMAGE must be a digest reference for $WEB_REPOSITORY."
fi
if [[ ! "$PUBLIC_WEB_HEALTH_URL" =~ ^https://[^[:space:]]+$ ]]; then
  die "PUBLIC_WEB_HEALTH_URL must be a public HTTPS URL."
fi
if [[ ! "$PUBLIC_API_HEALTH_URL" =~ ^https://[^[:space:]]+$ ]]; then
  die "PUBLIC_API_HEALTH_URL must be a public HTTPS URL."
fi
if [[ ! "$DEPLOY_MIN_FREE_BYTES" =~ ^[0-9]+$ ]]; then
  die "DEPLOY_MIN_FREE_BYTES must be a non-negative integer."
fi
if [[ ! "$HEALTH_ATTEMPTS" =~ ^[1-9][0-9]*$ ]]; then
  die "HEALTH_ATTEMPTS must be a positive integer."
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

  if DF_SUMMARY="$(df -B1 --output=avail "$DEPLOY_PATH" 2>&1)"; then
    :
  else
    df_status=$?
  fi
  if DOCKER_DF_SUMMARY="$(docker system df 2>&1)"; then
    :
  else
    docker_df_status=$?
  fi

  AVAILABLE_BYTES="$(printf '%s\n' "$DF_SUMMARY" |
    awk 'NR == 2 { gsub(/[[:space:]]/, ""); print; exit }')"
  if (( df_status != 0 || docker_df_status != 0 )) ||
    [[ ! "$AVAILABLE_BYTES" =~ ^[0-9]+$ ]]; then
    echo "Could not collect valid deployment disk and image usage summaries." >&2
    report_space_summaries
    return 1
  fi

  AVAILABLE_BYTES="$(decimal_normalize "$AVAILABLE_BYTES")"
  DEPLOY_MIN_FREE_BYTES_NORMALIZED="$(decimal_normalize "$DEPLOY_MIN_FREE_BYTES")"
  echo "Available disk bytes: $AVAILABLE_BYTES"
  echo "Docker image occupancy summary:"
  printf '%s\n' "$DOCKER_DF_SUMMARY"
}

is_protected_ref() {
  local candidate="$1"
  local reference
  for reference in "${PROTECTED_REFS[@]}"; do
    [[ "$reference" == "$candidate" ]] && return 0
  done
  return 1
}

is_protected_image_id() {
  local candidate="$1"
  local image_id
  for image_id in "${PROTECTED_IMAGE_IDS[@]}"; do
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

  PROTECTED_IMAGE_IDS=()
  PROTECTED_REFS=("$API_IMAGE" "$GO_API_IMAGE" "$WEB_IMAGE")

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

restore_config() {
  local file
  local backup_file
  local temporary_file

  for file in docker-compose.yml web.env go.env .deploy-images; do
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
      if [[ "$file" == "web.env" || "$file" == "go.env" ]] &&
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

  if [[ -z "$previous_api_image" || -z "$previous_web_image" ]]; then
    echo "No previous FastAPI/Web image set exists; restoring the empty deployment state." >&2
    if ! API_IMAGE="$API_IMAGE" GO_API_IMAGE="$GO_API_IMAGE" WEB_IMAGE="$WEB_IMAGE" \
      docker compose down --remove-orphans; then
      echo "Could not stop the failed first deployment." >&2
      return 1
    fi
    restore_config || return 1
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
  if ! API_IMAGE="$previous_api_image" GO_API_IMAGE="$rollback_go_api_image" WEB_IMAGE="$previous_web_image" \
    docker compose up -d --no-build --remove-orphans; then
    echo "Previous application image set could not be restarted." >&2
    return 1
  fi

  wait_for_url "API rollback" "http://127.0.0.1:8100/api/v1/health/live" || return 1
  if [[ -n "$previous_go_api_image" ]]; then
    wait_for_url "Go API rollback" "http://127.0.0.1:8200/api/v1/health/live" || return 1
  fi
  wait_for_url "Web rollback" "http://127.0.0.1:3200/healthz"
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

prune_dashboard_images

if ! collect_disk_usage; then
  exit 1
fi
if decimal_is_less "$AVAILABLE_BYTES" "$DEPLOY_MIN_FREE_BYTES_NORMALIZED"; then
  echo "Available disk space ($AVAILABLE_BYTES bytes) is below DEPLOY_MIN_FREE_BYTES ($DEPLOY_MIN_FREE_BYTES_NORMALIZED bytes); refusing deployment before migration." >&2
  report_space_summaries
  exit 1
fi

previous_api_image="$(saved_image API_IMAGE)"
previous_go_api_image="$(saved_image GO_API_IMAGE)"
previous_web_image="$(saved_image WEB_IMAGE)"
previous_api_image="${previous_api_image:-$(docker inspect --format '{{.Config.Image}}' "$CONTAINER_API" 2>/dev/null || true)}"
previous_go_api_image="${previous_go_api_image:-$(docker inspect --format '{{.Config.Image}}' "$CONTAINER_GO_API" 2>/dev/null || true)}"
previous_web_image="${previous_web_image:-$(docker inspect --format '{{.Config.Image}}' "$CONTAINER_WEB" 2>/dev/null || true)}"

ROLLBACK_DIR="$(mktemp -d "$DEPLOY_PATH/.deploy-rollback.XXXXXX")" ||
  die "Could not create deployment rollback directory."
chmod 700 "$ROLLBACK_DIR" || die "Could not secure rollback directory $ROLLBACK_DIR."
ROLLBACK_STATE="cleanup"
for file in docker-compose.yml web.env go.env .deploy-images; do
  if [[ -f "$DEPLOY_PATH/$file" ]]; then
    cp -p -- "$DEPLOY_PATH/$file" "$ROLLBACK_DIR/$file" ||
      die "Could not back up active deployment file $file."
  fi
done

prepare_config_file "$STAGING_DIR/docker-compose.yml" public ||
  die "Could not prepare staged Compose config."
COMPOSE_CONFIG_TMP="$PREPARED_CONFIG_FILE"
prepare_config_file "$STAGING_DIR/web.env" secret ||
  die "Could not prepare staged Web environment."
WEB_CONFIG_TMP="$PREPARED_CONFIG_FILE"
prepare_config_file "$STAGING_DIR/go.env" secret ||
  die "Could not prepare staged Go environment."
GO_CONFIG_TMP="$PREPARED_CONFIG_FILE"

ROLLBACK_ARMED=1
ROLLBACK_STATE="armed"
mv -f -- "$COMPOSE_CONFIG_TMP" "$DEPLOY_PATH/docker-compose.yml" ||
  die "Could not activate staged Compose config."
mv -f -- "$WEB_CONFIG_TMP" "$DEPLOY_PATH/web.env" ||
  die "Could not activate staged Web environment."
mv -f -- "$GO_CONFIG_TMP" "$DEPLOY_PATH/go.env" ||
  die "Could not activate staged Go environment."

echo "Pulling FastAPI, Go API, and Web images..."
if ! docker compose pull migrate api go-api celery celery-scheduled beat web; then
  die "Could not pull the target Dashboard image set."
fi

check_image_revision "FastAPI" "$API_IMAGE" ||
  die "Target FastAPI image does not match SOURCE_SHA; migration was not run."
check_image_revision "Go API" "$GO_API_IMAGE" ||
  die "Target Go API image does not match SOURCE_SHA; migration was not run."
check_image_revision "Web" "$WEB_IMAGE" ||
  die "Target Web image does not match SOURCE_SHA; migration was not run."

echo "Running database migrations..."
if ! docker compose run --rm -T migrate < /dev/null; then
  die "Database migration failed."
fi

if ! docker compose up -d --no-build --remove-orphans; then
  die "Could not start the new Dashboard image set."
fi

if ! wait_for_url "FastAPI fallback" "http://127.0.0.1:8100/api/v1/health/live"; then
  die "FastAPI fallback health check failed."
fi
if ! wait_for_url "Go API gateway" "http://127.0.0.1:8200/api/v1/health/live"; then
  die "Go API gateway health check failed."
fi
if ! wait_for_url "Web" "http://127.0.0.1:3200/healthz"; then
  die "Web health check failed."
fi

echo "Checking Celery workers..."
if ! docker compose exec -T celery sh -c \
  'celery -A app.tasks.celery_app inspect ping -d "celery@$(hostname)" --timeout=10'; then
  die "Celery worker health check failed."
fi
if ! docker compose exec -T celery-scheduled sh -c \
  'celery -A app.tasks.celery_app inspect ping -d "celery@$(hostname)" --timeout=10'; then
  die "Scheduled Celery worker health check failed."
fi

echo "Checking Celery beat..."
if [[ "$(docker inspect --format '{{.State.Running}}' believeboy-dashboard-beat)" != "true" ]]; then
  die "Celery beat is not running."
fi

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
ROLLBACK_STATE="resolved"
if ! rm -rf -- "$ROLLBACK_DIR"; then
  echo "Warning: could not remove rollback directory $ROLLBACK_DIR." >&2
else
  ROLLBACK_DIR=""
fi

if ! prune_dashboard_images; then
  echo "Warning: post-deployment Dashboard image enumeration failed; the healthy deployment remains active." >&2
fi
docker compose ps || true
