import os
import subprocess
import tempfile
import unittest
from pathlib import Path


DEPLOY_SCRIPT = Path(__file__).resolve().parents[1] / "deploy-remote.sh"


class DeployRemoteTests(unittest.TestCase):
    def prepare_runtime(self, *, previous_compose):
        temp = tempfile.TemporaryDirectory(prefix="deploy-remote-test-")
        root = Path(temp.name)
        deploy_path = root / "runtime"
        bin_path = root / "bin"
        deploy_path.mkdir()
        bin_path.mkdir()

        (deploy_path / "backend.env").write_text("API_KEY=test\n")
        (deploy_path / "web.env.next").write_text("BACKEND_INTERNAL_URL=http://127.0.0.1:8200\n")
        (deploy_path / "go.env.next").write_text("GO_API_ADDR=127.0.0.1:8200\n")
        (deploy_path / "docker-compose.yml.next").write_text(
            "services:\n  go-api:\n    image: ${GO_API_IMAGE}\n"
        )
        if previous_compose:
            (deploy_path / "docker-compose.yml").write_text(
                "services:\n  go-api:\n    image: ${GO_API_IMAGE}\n"
            )
            (deploy_path / "web.env").write_text("BACKEND_INTERNAL_URL=http://127.0.0.1:8100\n")
            (deploy_path / "go.env").write_text("GO_API_ADDR=127.0.0.1:8200\n")
            (deploy_path / ".deploy-images").write_text(
                "API_IMAGE=local/api:previous\n"
                "GO_API_IMAGE=local/go-api:previous\n"
                "WEB_IMAGE=local/web:previous\n"
            )

        docker_log = root / "docker.log"
        docker = bin_path / "docker"
        docker.write_text(
            "#!/bin/sh\n"
            "printf 'command=%s api=%s go=%s web=%s\\n' "
            "\"$*\" \"${API_IMAGE:-}\" \"${GO_API_IMAGE:-}\" \"${WEB_IMAGE:-}\" >> \"$DOCKER_LOG\"\n"
            "if [ \"$1\" = inspect ]; then\n"
            "  case \"${4:-}\" in\n"
            "    believeboy-dashboard-api) [ -n \"${PREVIOUS_API_IMAGE:-}\" ] && echo \"$PREVIOUS_API_IMAGE\" || exit 1 ;;\n"
            "    believeboy-dashboard-go-api) [ -n \"${PREVIOUS_GO_API_IMAGE:-}\" ] && echo \"$PREVIOUS_GO_API_IMAGE\" || exit 1 ;;\n"
            "    believeboy-dashboard-web) [ -n \"${PREVIOUS_WEB_IMAGE:-}\" ] && echo \"$PREVIOUS_WEB_IMAGE\" || exit 1 ;;\n"
            "    believeboy-dashboard-beat) echo true ;;\n"
            "  esac\n"
            "fi\n"
            "exit 0\n"
        )
        docker.chmod(0o755)

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

        sleep = bin_path / "sleep"
        sleep.write_text("#!/bin/sh\nexit 0\n")
        sleep.chmod(0o755)

        env = os.environ.copy()
        env.update(
            {
                "API_IMAGE": "local/api:next",
                "GO_API_IMAGE": "local/go-api:next",
                "WEB_IMAGE": "local/web:next",
                "DEPLOY_PATH": str(deploy_path),
                "PUBLIC_WEB_HEALTH_URL": "https://dash.example.test/healthz",
                "PUBLIC_API_HEALTH_URL": "https://dash-api.example.test/api/v1/health/live",
                "DOCKER_LOG": str(docker_log),
                "FAIL_CURL_MARKER": str(root / "curl-failed-once"),
                "HEALTH_ATTEMPTS": "1",
                "PREVIOUS_API_IMAGE": "local/api:previous" if previous_compose else "",
                "PREVIOUS_GO_API_IMAGE": "",
                "PREVIOUS_WEB_IMAGE": "local/web:previous" if previous_compose else "",
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
                "API_IMAGE=local/api:next\n"
                "GO_API_IMAGE=local/go-api:next\n"
                "WEB_IMAGE=local/web:next\n",
            )

    def test_rollback_uses_saved_go_image_when_container_is_missing(self):
        temp, _, docker_log, env = self.prepare_runtime(previous_compose=True)
        with temp:
            env["FAIL_CURL_URL"] = "http://127.0.0.1:8200/api/v1/health/live"
            result = self.run_deploy(env)

            compose_up = [
                line for line in docker_log.read_text().splitlines()
                if "command=compose up " in line
            ]
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(len(compose_up), 2, docker_log.read_text())
            self.assertIn("go=local/go-api:previous", compose_up[-1])

    def test_rollback_refuses_to_reuse_new_go_image_without_saved_previous_image(self):
        temp, deploy_path, docker_log, env = self.prepare_runtime(previous_compose=True)
        with temp:
            (deploy_path / ".deploy-images").unlink()
            env["FAIL_CURL_URL"] = "http://127.0.0.1:8200/api/v1/health/live"
            result = self.run_deploy(env)

            compose_up = [
                line for line in docker_log.read_text().splitlines()
                if "command=compose up " in line
            ]
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(len(compose_up), 1, docker_log.read_text())
            self.assertIn("refusing an incomplete rollback", result.stderr)

    def test_external_health_failure_rolls_back_before_backup_cleanup(self):
        temp, _, docker_log, env = self.prepare_runtime(previous_compose=True)
        with temp:
            public_api_url = "https://dash-api.example.test/api/v1/health/live"
            env["PUBLIC_API_HEALTH_URL"] = public_api_url
            env["FAIL_CURL_URL"] = public_api_url
            result = self.run_deploy(env)

            compose_up = [
                line for line in docker_log.read_text().splitlines()
                if "command=compose up " in line
            ]
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(len(compose_up), 2, docker_log.read_text())
            self.assertIn("go=local/go-api:previous", compose_up[-1])
            self.assertEqual(
                (Path(env["DEPLOY_PATH"]) / ".deploy-images").read_text(),
                "API_IMAGE=local/api:previous\n"
                "GO_API_IMAGE=local/go-api:previous\n"
                "WEB_IMAGE=local/web:previous\n",
            )


if __name__ == "__main__":
    unittest.main()
