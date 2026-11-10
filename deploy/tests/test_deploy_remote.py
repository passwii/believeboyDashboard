import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


DEPLOY_SCRIPT = Path(__file__).resolve().parents[1] / "deploy-remote.sh"
WORKFLOW = Path(__file__).resolve().parents[2] / ".github" / "workflows" / "deploy-dashboard.yml"

SOURCE_SHA = "a" * 40
API_REPOSITORY = "ghcr.io/passwii/believeboydashboard-api"
GO_API_REPOSITORY = "ghcr.io/passwii/believeboydashboard-go-api"
WEB_REPOSITORY = "ghcr.io/passwii/believeboydashboard-web"
API_IMAGE = f"{API_REPOSITORY}@sha256:{'1' * 64}"
GO_API_IMAGE = f"{GO_API_REPOSITORY}@sha256:{'2' * 64}"
WEB_IMAGE = f"{WEB_REPOSITORY}@sha256:{'3' * 64}"
PREVIOUS_API_IMAGE = f"{API_REPOSITORY}@sha256:{'4' * 64}"
PREVIOUS_GO_API_IMAGE = f"{GO_API_REPOSITORY}@sha256:{'5' * 64}"
PREVIOUS_WEB_IMAGE = f"{WEB_REPOSITORY}@sha256:{'6' * 64}"


class DeployRemoteTests(unittest.TestCase):
    def prepare_runtime(
        self,
        *,
        previous_compose,
        previous_go=True,
        total_bytes=10 * 1024**3,
        available_bytes=8 * 1024**3,
        legacy_storage=False,
        legacy_celerybeat=False,
    ):
        temp = tempfile.TemporaryDirectory(prefix="deploy-remote-test-")
        root = Path(temp.name)
        deploy_path = root / "runtime"
        bin_path = root / "bin"
        staging_dir = deploy_path / ".deploy-staging.test"
        deploy_path.mkdir()
        bin_path.mkdir()
        staging_dir.mkdir(mode=0o700)
        legacy_storage_dir = root / "legacy-storage"
        legacy_celerybeat_dir = root / "legacy-celerybeat"

        (deploy_path / "backend.env").write_text("API_KEY=test\n")
        (deploy_path / "app.env").write_text(
            "BACKEND_API_BASE_URL=https://dash-api.example.test\n"
        )
        (staging_dir / ".go-api-secret").write_text(
            f"GO_API_TRUSTED_PROXY_SECRET={'f' * 64}\n"
        )
        (staging_dir / "docker-compose.yml").write_text(
            "services:\n"
            "  migrate:\n"
            "    image: ${API_IMAGE}\n"
            "  api:\n"
            "    image: ${API_IMAGE}\n"
            "  go-api:\n"
            "    image: ${GO_API_IMAGE}\n"
            "  celery:\n"
            "    image: ${API_IMAGE}\n"
            "  celery-scheduled:\n"
            "    image: ${API_IMAGE}\n"
            "  beat:\n"
            "    image: ${API_IMAGE}\n"
            "  web:\n"
            "    image: ${WEB_IMAGE}\n"
        )
        shutil.copy2(DEPLOY_SCRIPT, staging_dir / "deploy-remote.sh")

        if previous_compose:
            (deploy_path / "docker-compose.yml").write_text(
                "services:\n"
                "  migrate:\n"
                "    image: ${API_IMAGE}\n"
                "  api:\n"
                "    image: ${API_IMAGE}\n"
                "  go-api:\n"
                "    image: ${GO_API_IMAGE}\n"
                "  celery:\n"
                "    image: ${API_IMAGE}\n"
                "  celery-scheduled:\n"
                "    image: ${API_IMAGE}\n"
                "  beat:\n"
                "    image: ${API_IMAGE}\n"
                "  web:\n"
                "    image: ${WEB_IMAGE}\n"
            )
            (deploy_path / "web.env").write_text(
                "BACKEND_INTERNAL_URL=http://127.0.0.1:8100\n"
                "BACKEND_API_BASE_URL=https://dash-api.example.test\n"
            )
            (deploy_path / "go.env").write_text("GO_API_ADDR=127.0.0.1:8200\n")
            manifest = (
                f"API_IMAGE={PREVIOUS_API_IMAGE}\n"
                f"WEB_IMAGE={PREVIOUS_WEB_IMAGE}\n"
            )
            if previous_go:
                manifest += f"GO_API_IMAGE={PREVIOUS_GO_API_IMAGE}\n"
            (deploy_path / ".deploy-images").write_text(manifest)

        if legacy_storage:
            legacy_storage_dir.mkdir()
            (legacy_storage_dir / "upload.txt").write_text("legacy-data\n")
        if legacy_celerybeat:
            legacy_celerybeat_dir.mkdir()
            (legacy_celerybeat_dir / "celerybeat-schedule").write_text("beat-state\n")

        docker_log = root / "docker.log"
        operation_log = root / "operations.log"
        docker = bin_path / "docker"
        docker.write_text(
            "#!/bin/sh\n"
            "printf 'docker=%s\\n' \"$*\" >> \"$OPERATION_LOG\"\n"
            "printf 'command=%s api=%s go=%s web=%s\\n' "
            "\"$*\" \"${API_IMAGE:-}\" \"${GO_API_IMAGE:-}\" \"${WEB_IMAGE:-}\" >> \"$DOCKER_LOG\"\n"
            "\n"
            "if [ \"$1\" = system ] && [ \"$2\" = df ]; then\n"
            "  echo 'TYPE TOTAL ACTIVE SIZE RECLAIMABLE'\n"
            "  exit 0\n"
            "fi\n"
            "\n"
            "if [ \"$1\" = ps ]; then\n"
            "  exit 0\n"
            "fi\n"
            "\n"
            "if [ \"$1\" = compose ] && [ \"$2\" = pull ]; then\n"
            "  : > \"$TARGET_IMAGES_PULLED_MARKER\"\n"
            "fi\n"
            "\n"
            "if [ \"$1\" = compose ] && [ \"$2\" = up ]; then\n"
            "  compose_up_count=0\n"
            "  if [ -f \"$COMPOSE_UP_COUNT_FILE\" ]; then\n"
            "    compose_up_count=\"$(cat \"$COMPOSE_UP_COUNT_FILE\")\"\n"
            "  fi\n"
            "  compose_up_count=$((compose_up_count + 1))\n"
            "  printf '%s\\n' \"$compose_up_count\" > \"$COMPOSE_UP_COUNT_FILE\"\n"
            "  if [ \"$compose_up_count\" = \"${FAIL_COMPOSE_UP_CALL:-}\" ]; then\n"
            "    exit 1\n"
            "  fi\n"
            "fi\n"
            "\n"
            "if [ \"$1\" = image ]; then\n"
            "  case \"$2\" in\n"
            "    ls|rm) exit 0 ;;\n"
            "    inspect)\n"
            "      case \"$*\" in\n"
            "        *org.opencontainers.image.revision*) printf '%s\\n' \"$SOURCE_SHA\" ;;\n"
            "        *) echo sha256:0000000000000000000000000000000000000000000000000000000000000000 ;;\n"
            "      esac\n"
            "      exit 0\n"
            "      ;;\n"
            "  esac\n"
            "fi\n"
            "\n"
            "if [ \"$1\" = inspect ]; then\n"
            "  format=''\n"
            "  target=''\n"
            "  shift\n"
            "  while [ $# -gt 0 ]; do\n"
            "    case \"$1\" in\n"
            "      --format) format=\"$2\"; shift 2 ;;\n"
            "      *) target=\"$1\"; shift ;;\n"
            "    esac\n"
            "  done\n"
            "  case \"$format\" in\n"
            "    *State.Running*)\n"
            "      if [ \"$target\" = believeboy-dashboard-beat ]; then\n"
            "        printf '%s\\n' \"${BEAT_RUNNING:-true}\"\n"
            "      else\n"
            "        printf '%s\\n' \"${LEGACY_CONTAINER_RUNNING:-false}\"\n"
            "      fi\n"
            "      ;;\n"
            "    *Config.Image*)\n"
            "      case \"$target\" in\n"
            "        believeboy-dashboard-api) [ -n \"${PREVIOUS_API_IMAGE:-}\" ] && echo \"$PREVIOUS_API_IMAGE\" || exit 1 ;;\n"
            "        believeboy-dashboard-go-api) [ -n \"${PREVIOUS_GO_API_IMAGE:-}\" ] && echo \"$PREVIOUS_GO_API_IMAGE\" || exit 1 ;;\n"
            "        believeboy-dashboard-web) [ -n \"${PREVIOUS_WEB_IMAGE:-}\" ] && echo \"$PREVIOUS_WEB_IMAGE\" || exit 1 ;;\n"
            "        *) exit 1 ;;\n"
            "      esac\n"
            "      ;;\n"
            "    *Image*) echo sha256:0000000000000000000000000000000000000000000000000000000000000000 ;;\n"
            "    *) exit 1 ;;\n"
            "  esac\n"
            "  exit 0\n"
            "fi\n"
            "\n"
            "exit 0\n"
        )
        docker.chmod(0o755)

        df = bin_path / "df"
        df.write_text(
            "#!/bin/sh\n"
            "available=\"$DF_AVAILABLE_BYTES\"\n"
            "if [ -e \"$TARGET_IMAGES_PULLED_MARKER\" ] && "
            "[ -n \"${DF_AVAILABLE_AFTER_PULL:-}\" ]; then\n"
            "  available=\"$DF_AVAILABLE_AFTER_PULL\"\n"
            "fi\n"
            "case \"$*\" in\n"
            "  *--output=size,avail*)\n"
            "    printf '       Size       Avail\\n%s %s\\n' \"$DF_TOTAL_BYTES\" \"$available\"\n"
            "    ;;\n"
            "  *) exit 2 ;;\n"
            "esac\n"
        )
        df.chmod(0o755)

        du = bin_path / "du"
        du.write_text(
            "#!/bin/sh\n"
            "for arg do last=\"$arg\"; done\n"
            "printf '%s\\t%s\\n' \"${LEGACY_COPY_BYTES:-1048576}\" \"$last\"\n"
        )
        du.chmod(0o755)

        cp = bin_path / "cp"
        cp.write_text(
            "#!/bin/sh\n"
            "printf 'cp=%s\\n' \"$*\" >> \"$OPERATION_LOG\"\n"
            "exec /bin/cp \"$@\"\n"
        )
        cp.chmod(0o755)

        curl = bin_path / "curl"
        curl.write_text(
            "#!/bin/sh\n"
            "for arg do last=\"$arg\"; done\n"
            "if [ -n \"${FAIL_CURL_URL:-}\" ] && [ \"$last\" = \"$FAIL_CURL_URL\" ] && "
            "[ ! -e \"$FAIL_CURL_MARKER\" ]; then\n"
            "  : > \"$FAIL_CURL_MARKER\"\n"
            "  exit 22\n"
            "fi\n"
            "exit 0\n"
        )
        curl.chmod(0o755)

        for command, content in {
            "chown": "#!/bin/sh\nexit 0\n",
            "flock": "#!/bin/sh\nexit 0\n",
            "sleep": "#!/bin/sh\nexit 0\n",
            "systemctl": (
                "#!/bin/sh\n"
                "printf 'systemctl=%s\\n' \"$*\" >> \"$OPERATION_LOG\"\n"
                "if [ \"$1\" = is-active ]; then\n"
                "  [ -n \"${ACTIVE_SYSTEMD_SERVICE:-}\" ] && "
                "[ \"$3\" = \"$ACTIVE_SYSTEMD_SERVICE\" ] && exit 0\n"
                "  exit 1\n"
                "fi\n"
                "if [ \"$1\" = is-enabled ]; then\n"
                "  [ -n \"${ENABLED_SYSTEMD_SERVICE:-}\" ] && "
                "[ \"$3\" = \"$ENABLED_SYSTEMD_SERVICE\" ] && exit 0\n"
                "  exit 1\n"
                "fi\n"
                "exit 0\n"
            ),
        }.items():
            executable = bin_path / command
            executable.write_text(content)
            executable.chmod(0o755)

        env = os.environ.copy()
        env.update(
            {
                "SOURCE_SHA": SOURCE_SHA,
                "API_IMAGE": API_IMAGE,
                "GO_API_IMAGE": GO_API_IMAGE,
                "WEB_IMAGE": WEB_IMAGE,
                "DEPLOY_PATH": str(deploy_path),
                "STAGING_DIR": str(staging_dir),
                "PUBLIC_WEB_HEALTH_URL": "https://dash.believeboy.com/healthz",
                "PUBLIC_API_HEALTH_URL": "https://dash-api.believeboy.com/api/v1/health/ready",
                "DOCKER_LOG": str(docker_log),
                "DF_TOTAL_BYTES": str(total_bytes),
                "DF_AVAILABLE_BYTES": str(available_bytes),
                "TARGET_IMAGES_PULLED_MARKER": str(root / "target-images-pulled"),
                "COMPOSE_UP_COUNT_FILE": str(root / "compose-up-count"),
                "LEGACY_REPO": str(root / "legacy-repo"),
                "LEGACY_STORAGE_DIR": (
                    str(legacy_storage_dir)
                    if legacy_storage
                    else str(root / "missing-storage")
                ),
                "LEGACY_CELERYBEAT_DIR": (
                    str(legacy_celerybeat_dir)
                    if legacy_celerybeat
                    else str(root / "missing-celerybeat")
                ),
                "FAIL_CURL_MARKER": str(root / "curl-failed-once"),
                "OPERATION_LOG": str(operation_log),
                "HEALTH_ATTEMPTS": "1",
                "PREVIOUS_API_IMAGE": PREVIOUS_API_IMAGE if previous_compose else "",
                "PREVIOUS_GO_API_IMAGE": (
                    PREVIOUS_GO_API_IMAGE
                    if previous_compose and previous_go
                    else ""
                ),
                "PREVIOUS_WEB_IMAGE": PREVIOUS_WEB_IMAGE if previous_compose else "",
                "PATH": f"{bin_path}:{env['PATH']}",
            }
        )
        return temp, deploy_path, docker_log, env

    def run_deploy(self, env):
        return subprocess.run(
            ["bash", str(DEPLOY_SCRIPT)],
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )

    def compose_up_lines(self, docker_log):
        return [
            line
            for line in docker_log.read_text().splitlines()
            if "command=compose up " in line
        ]

    def test_first_install_does_not_require_previous_compose_or_web_env(self):
        temp, deploy_path, _, env = self.prepare_runtime(previous_compose=False)
        with temp:
            result = self.run_deploy(env)

            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertTrue((deploy_path / "docker-compose.yml").exists())
            self.assertTrue((deploy_path / "web.env").exists())
            self.assertTrue((deploy_path / "go.env").exists())
            self.assertEqual(
                (deploy_path / ".deploy-images").read_text(),
                f"API_IMAGE={API_IMAGE}\n"
                f"GO_API_IMAGE={GO_API_IMAGE}\n"
                f"WEB_IMAGE={WEB_IMAGE}\n",
            )

    def test_enabled_legacy_unit_fails_deployment_finalization(self):
        temp, deploy_path, _, env = self.prepare_runtime(previous_compose=True)
        with temp:
            env["ENABLED_SYSTEMD_SERVICE"] = "believeboy-api.service"
            result = self.run_deploy(env)

            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("Legacy systemd unit remains enabled", result.stderr)
            self.assertIn("finalization is incomplete", result.stderr)
            self.assertEqual(
                (deploy_path / ".deploy-images").read_text(),
                f"API_IMAGE={API_IMAGE}\n"
                f"GO_API_IMAGE={GO_API_IMAGE}\n"
                f"WEB_IMAGE={WEB_IMAGE}\n",
            )
            self.assertTrue(list(deploy_path.glob(".deploy-rollback.*")))

    def test_legacy_data_copy_runs_after_legacy_writer_stop(self):
        temp, deploy_path, _, env = self.prepare_runtime(
            previous_compose=False,
            legacy_storage=True,
        )
        with temp:
            env["LEGACY_CONTAINER_RUNNING"] = "true"
            result = self.run_deploy(env)

            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertTrue((deploy_path / "backend-storage" / "upload.txt").exists())
            self.assertTrue((deploy_path / ".storage-migrated").exists())

            operations = Path(env["OPERATION_LOG"]).read_text().splitlines()
            stop_index = next(
                index
                for index, line in enumerate(operations)
                if "docker=stop believeboy-dashboard" in line
            )
            copy_index = next(
                index
                for index, line in enumerate(operations)
                if line.startswith("cp=-a -- ")
                and env["LEGACY_STORAGE_DIR"] in line
            )
            self.assertLess(stop_index, copy_index)

    def test_legacy_copy_space_margin_fails_before_copy(self):
        # General floors now pass (1.2 GiB > 1 GiB) so this exercises the copy
        # safety margin itself, not the pre-pull space gate.
        temp, deploy_path, docker_log, env = self.prepare_runtime(
            previous_compose=False,
            total_bytes=10_000_000_000,
            available_bytes=1_200_000_000,
            legacy_storage=True,
        )
        with temp:
            env["LEGACY_CONTAINER_RUNNING"] = "true"
            result = self.run_deploy(env)

            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertFalse((deploy_path / "backend-storage" / "upload.txt").exists())
            self.assertIn("below the safe legacy copy requirement", result.stderr)
            self.assertNotIn("command=compose pull ", docker_log.read_text())
            self.assertNotIn(
                "docker=stop believeboy-dashboard",
                Path(env["OPERATION_LOG"]).read_text(),
            )

    def test_copy_space_is_rechecked_after_target_pull_before_stop(self):
        temp, deploy_path, docker_log, env = self.prepare_runtime(
            previous_compose=False,
            total_bytes=10_000_000_000,
            available_bytes=2_000_000_000,
            legacy_storage=True,
        )
        with temp:
            env["DF_AVAILABLE_AFTER_PULL"] = "1100000000"
            env["LEGACY_CONTAINER_RUNNING"] = "true"
            result = self.run_deploy(env)

            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("Insufficient disk space for legacy data copy", result.stderr)
            self.assertIn("command=compose pull ", docker_log.read_text())
            self.assertFalse((deploy_path / "backend-storage" / "upload.txt").exists())
            self.assertNotIn(
                "docker=stop believeboy-dashboard",
                Path(env["OPERATION_LOG"]).read_text(),
            )

    def test_space_policy_uses_absolute_floor(self):
        temp, _, _, env = self.prepare_runtime(
            previous_compose=False,
            total_bytes=15_000_000_000,
            available_bytes=1_100_000_000,
        )
        with temp:
            result = self.run_deploy(env)

            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("partition total: 15000000000 bytes", result.stdout)
            self.assertIn("general floor=1073741824 bytes", result.stdout)

    def test_space_policy_rejects_below_absolute_floor(self):
        temp, _, _, env = self.prepare_runtime(
            previous_compose=False,
            total_bytes=15_000_000_000,
            available_bytes=1_000_000_000,
        )
        with temp:
            result = self.run_deploy(env)

            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("strictly greater than the required 1073741824 bytes", result.stderr)

    def test_space_policy_percentage_floor_is_opt_in(self):
        temp, _, _, env = self.prepare_runtime(
            previous_compose=False,
            total_bytes=15_000_000_000,
            available_bytes=1_400_000_000,
        )
        with temp:
            env["DEPLOY_FREE_SPACE_PERCENT"] = "10"
            result = self.run_deploy(env)

            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("strictly greater than the required 1500000000 bytes", result.stderr)

    def test_space_policy_enforces_post_pull_floor_before_stop(self):
        temp, deploy_path, docker_log, env = self.prepare_runtime(
            previous_compose=False,
            total_bytes=15_000_000_000,
            available_bytes=1_600_000_000,
        )
        with temp:
            env["DF_AVAILABLE_AFTER_PULL"] = "500000000"
            result = self.run_deploy(env)

            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("target image pull", result.stderr)
            self.assertIn("strictly greater than the required 536870912 bytes", result.stderr)
            self.assertIn("command=compose pull ", docker_log.read_text())
            self.assertFalse((deploy_path / ".deploy-images").exists())

    def test_rollback_skips_migrate_and_uses_saved_go_image(self):
        temp, _, docker_log, env = self.prepare_runtime(previous_compose=True)
        with temp:
            env["FAIL_CURL_URL"] = "http://127.0.0.1:8200/api/v1/health/ready"
            result = self.run_deploy(env)

            compose_up = self.compose_up_lines(docker_log)
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(len(compose_up), 2, docker_log.read_text())
            rollback_up = compose_up[-1]
            rollback_command = rollback_up.split(" api=", maxsplit=1)[0]
            self.assertIn("--no-deps", rollback_up)
            self.assertIn(f"api={PREVIOUS_API_IMAGE}", rollback_up)
            self.assertIn(f"go={PREVIOUS_GO_API_IMAGE}", rollback_up)
            self.assertIn(f"web={PREVIOUS_WEB_IMAGE}", rollback_up)
            for service in ("api", "go-api", "celery", "celery-scheduled", "beat", "web"):
                self.assertIn(f" {service}", rollback_command)
            self.assertNotIn(" migrate", rollback_command)

    def test_rollback_restarts_legacy_systemd_writers(self):
        temp, _, _, env = self.prepare_runtime(previous_compose=True)
        with temp:
            active_service = "believeboy-api.service"
            env["ACTIVE_SYSTEMD_SERVICE"] = active_service
            env["FAIL_CURL_URL"] = "http://127.0.0.1:8200/api/v1/health/ready"
            result = self.run_deploy(env)

            operations = Path(env["OPERATION_LOG"]).read_text().splitlines()
            stop_index = next(
                index
                for index, line in enumerate(operations)
                if line == f"systemctl=stop {active_service}"
            )
            start_index = next(
                index
                for index, line in enumerate(operations)
                if line == f"systemctl=start {active_service}"
            )
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertLess(stop_index, start_index)
            inactive = (
                "believeboy-celery.service",
                "believeboy-celery-scheduled.service",
                "believeboy-beat.service",
            )
            for service in inactive:
                self.assertNotIn(f"systemctl=start {service}", operations)

    def test_incomplete_rollback_attempts_legacy_writer_restore(self):
        temp, _, _, env = self.prepare_runtime(previous_compose=True)
        with temp:
            active_service = "believeboy-api.service"
            env["ACTIVE_SYSTEMD_SERVICE"] = active_service
            env["FAIL_COMPOSE_UP_CALL"] = "2"
            env["FAIL_CURL_URL"] = "http://127.0.0.1:8200/api/v1/health/ready"
            result = self.run_deploy(env)

            operations = Path(env["OPERATION_LOG"]).read_text().splitlines()
            down_index = next(
                index
                for index, line in enumerate(operations)
                if line.startswith("docker=compose -f ")
                and line.endswith(" down")
            )
            start_index = next(
                index
                for index, line in enumerate(operations)
                if line == f"systemctl=start {active_service}"
            )
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("Automatic rollback was incomplete", result.stderr)
            self.assertIn(f"systemctl=start {active_service}", operations)
            self.assertLess(down_index, start_index)

    def test_rollback_refuses_to_reuse_new_go_image_without_saved_previous_image(self):
        temp, deploy_path, docker_log, env = self.prepare_runtime(
            previous_compose=True,
            previous_go=False,
        )
        with temp:
            env["FAIL_CURL_URL"] = "http://127.0.0.1:8200/api/v1/health/ready"
            result = self.run_deploy(env)

            compose_up = self.compose_up_lines(docker_log)
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(len(compose_up), 1, docker_log.read_text())
            self.assertIn("refusing an incomplete rollback", result.stderr)
            self.assertTrue((deploy_path / ".deploy-images").exists())

    def test_external_health_failure_rolls_back_before_manifest_update(self):
        temp, deploy_path, docker_log, env = self.prepare_runtime(previous_compose=True)
        with temp:
            public_api_url = "https://dash-api.believeboy.com/api/v1/health/ready"
            env["FAIL_CURL_URL"] = public_api_url
            result = self.run_deploy(env)

            compose_up = self.compose_up_lines(docker_log)
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(len(compose_up), 2, docker_log.read_text())
            self.assertIn("--no-deps", compose_up[-1])
            self.assertEqual(
                (deploy_path / ".deploy-images").read_text(),
                f"API_IMAGE={PREVIOUS_API_IMAGE}\n"
                f"WEB_IMAGE={PREVIOUS_WEB_IMAGE}\n"
                f"GO_API_IMAGE={PREVIOUS_GO_API_IMAGE}\n",
            )

    def test_first_install_failure_restarts_legacy_runtime(self):
        temp, deploy_path, docker_log, env = self.prepare_runtime(
            previous_compose=False,
            legacy_storage=True,
            legacy_celerybeat=True,
        )
        with temp:
            env["LEGACY_CONTAINER_RUNNING"] = "true"
            env["FAIL_CURL_URL"] = "http://127.0.0.1:8100/api/v1/health/ready"
            result = self.run_deploy(env)

            docker_commands = docker_log.read_text()
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("command=compose down --remove-orphans", docker_commands)
            self.assertIn("command=start believeboy-dashboard", docker_commands)
            self.assertTrue((deploy_path / "backend-storage" / "upload.txt").exists())
            self.assertTrue((deploy_path / "celerybeat" / "celerybeat-schedule").exists())
            self.assertFalse((deploy_path / ".storage-migrated").exists())
            self.assertFalse((deploy_path / ".celerybeat-migrated").exists())

    def test_actions_cleanup_acquires_deploy_lock(self):
        workflow = WORKFLOW.read_text()
        cleanup_section = workflow.split(
            "- name: Cleanup deployment staging and runner SSH keys",
            maxsplit=1,
        )[1]

        lock_index = cleanup_section.find("flock -n 9")
        delete_index = cleanup_section.find("rm -rf -- $remote_staging_dir")
        self.assertGreaterEqual(lock_index, 0)
        self.assertGreaterEqual(delete_index, 0)
        self.assertLess(lock_index, delete_index)
        self.assertIn("deferring staging cleanup", cleanup_section)


if __name__ == "__main__":
    unittest.main()
