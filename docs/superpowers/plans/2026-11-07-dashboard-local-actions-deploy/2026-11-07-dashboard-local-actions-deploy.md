# Dashboard 本地构建与 Actions 部署实施计划

> **For agentic workers:** 按本计划逐项实施，并在每项完成后复核对应 diff。

**目标：** 本地构建并推送三张 Dashboard 镜像，由 GitHub Actions 部署到 VPS，同时安全回收过期镜像与部署暂存文件。

**架构：** `deploy/deploy-local.sh` 默认在本机完成检查、构建和 GHCR 推送，然后通过 `gh workflow run` 将完整 commit SHA 与三个 digest 交给手动触发的 GitHub Actions。Actions 保留完整构建备用模式；预构建模式验证输入后暂存 VPS 运行配置并执行同一远端部署事务。本机 SSH 路径通过显式 `DEPLOY_METHOD=ssh` 保留。

**技术栈：** Bash、GitHub Actions `workflow_dispatch`、GitHub CLI、GHCR、Docker Buildx、Docker Compose、VPS `flock`。

## 全局约束

- 只允许部署 `main`，预构建模式的 `source_sha` 必须等于本次 Actions 的 `github.sha`。
- 三个镜像仓库固定为 `ghcr.io/passwii/believeboydashboard-api`、`ghcr.io/passwii/believeboydashboard-go-api`、`ghcr.io/passwii/believeboydashboard-web`，部署引用使用 digest。
- 镜像 OCI revision 标签在 VPS 拉取镜像后、数据库迁移前校验。
- VPS 最低可用空间默认是 `3221225472` 字节（3 GiB），由 `DEPLOY_MIN_FREE_BYTES` 覆盖。
- 每次本地 Actions 派发生成唯一 32 位小写十六进制 `dispatch_id`；工作流 run name 包含它，fallback 只能按精确 ID 定位 run。
- 垃圾回收只处理三个 Dashboard 仓库中未被任何容器、当前镜像清单或目标 digest 使用的镜像引用；不运行全局 image/system/volume prune。
- 不删除 Docker volumes、`backend-storage`、`celerybeat`、数据库文件或其他应用镜像。
- Actions 预构建部署使用 VPS 当前运行环境配置；本机运行期环境变更使用 `DEPLOY_METHOD=ssh`。
- 遵循仓库 AGENTS.md：本次不新增或运行自动化测试；完成 shell/YAML 静态检查和 diff 检查。

## 文件职责

| 文件 | 变更 |
| --- | --- |
| `deploy/deploy-local.sh` | 默认改为本机构建后派发 Actions；保留直接 SSH 应急模式；等待 Actions 并报告 URL 与结果。 |
| `.github/workflows/deploy-dashboard.yml` | 增加完整构建与预构建部署两种手动模式；校验输入；清理临时 SSH 与 VPS 暂存文件。 |
| `deploy/deploy-remote.sh` | 加远端锁、镜像 revision 校验、空间预检、限定仓库的镜像回收和退出清理。 |
| `productEnvAgent/deploy.sh` | 更新 `git deploy` 使用说明和 SSH 应急命令。 |
| `docs/deployment/dashboard-vps-compose.md` | 更新本地发布、Actions 备用发布、VPS 回收和空间失败说明。 |
| `AGENTS.md` | 更新仓库内发布权威规则，避免后续 agent 继续假设默认由本机 SSH 部署。 |
| `docs/superpowers/specs/2026-11-07-dashboard-local-build-actions-deploy-design.md` | 明确 revision 标签在远端拉取后、迁移前校验。 |

## 实施任务

### Task 1: 实现远端部署事务、空间检查与镜像回收

**文件：** `deploy/deploy-remote.sh`、`deploy/deploy-local.sh`

- [x] 校验 `SOURCE_SHA`、三张镜像 digest、`DEPLOY_PATH`、`STAGING_DIR` 与公网健康 URL；确认 `STAGING_DIR` 是 `$DEPLOY_PATH/.deploy-staging.*` 下的目录。
- [x] 同步改造现有本机 SSH 调用：在远端创建唯一暂存目录，把 Compose、Web/Go env 和远端脚本放入其中，并传入 `STAGING_DIR` 与 `SOURCE_SHA`；退出 trap 尽力删除尚未被远端脚本清除的目录。此步只适配新接口，不改变本机当前默认发布方式。
- [x] 在修改活动配置前，通过 `flock -n` 获取 `$DEPLOY_PATH/.deploy.lock`；锁已占用时明确失败。
- [x] 在锁内清理超过 24 小时的 `.deploy-staging.*` 目录和遗留 `.deploy-images.next.*` 文件，保留本次 `STAGING_DIR`。
- [x] 用 `df -B1 --output=avail "$DEPLOY_PATH"` 读取可用字节；用 `docker system df` 记录镜像占用。失败日志输出两项摘要。
- [x] 实现 `prune_dashboard_images`：只枚举三个固定 GHCR 仓库的 tags 与 repo digests；保护所有容器引用的 image ID、当前 `.deploy-images` 中的 refs 和传入的目标 refs；对其他 refs 按完整 `repo:tag` 或 `repo@digest` 执行 `docker image rm`，不按 image ID 删除。
- [x] 拉取前运行镜像回收，再检查 `DEPLOY_MIN_FREE_BYTES`；可用空间低于默认 `3221225472` 字节时，在迁移前退出。
- [x] 从 `STAGING_DIR` 提升 Compose 与运行环境文件，创建权限为 `0700` 的回滚目录，备份现有 Compose、Web/Go env 和 `.deploy-images`。
- [x] 拉取三张目标镜像后，逐一读取 `org.opencontainers.image.revision`；任一标签不等于 `SOURCE_SHA` 时走回滚与清理，不运行 migration。
- [x] 保持现有 migration、容器健康、Celery、beat 和公网健康检查顺序。全部通过后原子更新 `.deploy-images`，关闭 rollback trap 并删除回滚副本，再尽力回收没有引用的旧 Dashboard 镜像。镜像删除失败只报告 warning，不回滚已健康的新版本。
- [x] 添加退出 trap：总是删除本次暂存目录与临时 manifest；成功或回滚成功时删除回滚目录；回滚失败时保留回滚目录并报告路径。

### Task 2: 让 GitHub Actions 接收本地 digest

**文件：** `.github/workflows/deploy-dashboard.yml`

- [x] 为 `workflow_dispatch` 增加 `deploy_mode`（默认 `build_and_deploy`，另一个值为 `prebuilt`）、`source_sha`、`api_digest`、`go_api_digest`、`web_digest` 五个输入。
- [x] 在任何 SSH 步骤之前校验 ref 为 `main`。预构建模式校验完整 40 位 SHA、三个 `sha256:` digest 格式，并要求 `source_sha == github.sha`。
- [x] 将 Python/Alembic 图检查保留在两种模式；只在 `build_and_deploy` 模式运行 pnpm 安装、lint、测试、Buildx 和三个构建步骤。
- [x] 给完整构建的三个镜像都添加 `org.opencontainers.image.revision=${{ github.sha }}` 标签。
- [x] 为两种模式生成统一的 `API_IMAGE`、`GO_API_IMAGE`、`WEB_IMAGE`、`SOURCE_SHA`。预构建值只能与 workflow 顶层固定仓库名拼接，不能接受可变仓库输入。
- [x] 远端用 `mktemp -d "$DEPLOY_PATH/.deploy-staging.XXXXXX"` 创建唯一的 `0700` 暂存目录；复制现有 VPS `web.env` 到暂存目录，按现有行为写入 Go env 和 Go 代理密钥，所有密钥文件设为 `0600`。
- [x] 将 Compose、远端脚本和暂存文件传入唯一目录；调用远端脚本时传递 `STAGING_DIR`、`SOURCE_SHA`、三张 digest 与健康 URL。
- [x] 添加 `if: always()` 收尾步骤，尝试删除本次暂存目录和 runner 私钥目录；VPS 暂不可达时只报告清理失败，由下一次远端部署清理过期暂存目录。
- [x] 保持完整构建模式的人工备用方式和现有 concurrency group；预构建模式不下载三张镜像到 GitHub runner。

### Task 3: 调整本地默认发布与应急 SSH 路径

**文件：** `deploy/deploy-local.sh`、`productEnvAgent/deploy.sh`、`.github/workflows/deploy-dashboard.yml`

- [x] 增加 `DEPLOY_METHOD="${DEPLOY_METHOD:-actions}"`，只接受 `actions` 或 `ssh`；`DEPLOY_HOST`、`ssh`、`scp` 仅在 `ssh` 模式必需，`gh` 仅在 `actions` 模式必需。
- [x] 两种模式都要求前端 env 文件中的 `NEXTAUTH_SECRET` 供本机构建 Web 镜像；只有 `ssh` 模式要求 `BACKEND_API_KEY`、`BACKEND_API_BASE_URL` 和本机 `GO_API_TRUSTED_PROXY_SECRET`。
- [x] 默认平台设为 `linux/amd64`，不再为默认发布 SSH 查询 VPS 架构。
- [x] 两种模式都执行现有 main SHA 检查、Alembic 检查、前端 lint/test 与本地镜像构建/推送，并从 metadata 读取 digest。
- [x] `actions` 模式通过 Python 生成唯一 32 位小写十六进制 `dispatch_id`，传入 `deploy_mode=prebuilt`、完整 SHA 和三个 digest；从命令返回的 Actions URL 提取 run ID。若没有 URL，则最多重试 15 次查询 `gh run list --workflow deploy-dashboard.yml --commit "$SHA" --event workflow_dispatch --limit 20 --json databaseId,url,displayTitle`，只选择 `displayTitle` 精确匹配该 `dispatch_id` 的 run。定位到后调用 `gh run watch "$run_id" --compact --exit-status` 等待并报告 URL 与最终状态；超时后明确失败，不接管其他 run。
- [x] `ssh` 模式保留当前本机运行环境文件生成和统一 Compose 部署；复用 Task 1 已接入的唯一 `.deploy-staging.*` 目录和 `STAGING_DIR`/`SOURCE_SHA` 调用接口，不重复实现暂存流程。
- [x] 用 EXIT trap 删除本机 BuildKit secret 与临时 metadata；不要将运行密钥放入 `gh workflow run` 输入。
- [x] 更新 `productEnvAgent/deploy.sh` 注释，明确 `git deploy` 默认走 Actions，`DEPLOY_METHOD=ssh git deploy` 是应急路径，`PUSH_ONLY=1 git deploy` 语义不变。
- [x] 在 workflow 中增加可选 `dispatch_id` 输入，预构建模式校验其格式，并设置包含该 ID 的 `run-name`；人工完整构建不传该输入时仍能运行。

### Task 4: 同步运行手册与仓库约定

**文件：** `docs/deployment/dashboard-vps-compose.md`、`AGENTS.md`、设计 spec

- [x] 在部署手册写明默认发布命令、预构建输入、Actions run 查看命令、完整构建备用命令和本机 SSH 应急命令。
- [x] 记录 `DEPLOY_MIN_FREE_BYTES` 默认值、Dashboard 仓库清理范围、引用保护规则、3 GiB 未达标时迁移前终止，以及不触碰持久化数据的边界。
- [x] 说明 Actions 预构建模式使用 VPS 当前 Web 运行环境；运行期环境变量更新走 SSH 应急模式。
- [x] 更新 `AGENTS.md` 的本地主发布与 Actions 备用规则，包含 `DEPLOY_METHOD=ssh` 和空间回收限制。
- [x] 修正文档：Actions 先校验 SHA/digest，VPS 拉取后、迁移前校验 OCI revision。

### Task 5: 静态核对与交付

- [ ] 逐个执行 `bash -n deploy/deploy-local.sh`、`bash -n deploy/deploy-remote.sh`、`bash -n productEnvAgent/deploy.sh`，确认 shell 语法通过。
- [ ] 若 `actionlint` 已安装，执行 `actionlint .github/workflows/deploy-dashboard.yml`；若未安装，记录未运行，不为此安装依赖。
- [ ] 执行 `git diff --check` 并逐项复核：无全局 prune、无 volume/上传数据删除、失败回滚前不清理旧镜像、预构建模式没有 build/test 步骤。
- [ ] 不从隔离 worktree 推送 `main` 或触发生产部署；交付本地变更与静态核对结果，待后续按仓库发布规则集成。

## 覆盖对照

| 设计要求 | 对应任务 |
| --- | --- |
| 本机构建、push digest，Actions 只部署 | 任务 2、任务 3 |
| 主动完整构建备用与本机 SSH 应急 | 任务 2、任务 3 |
| SHA、digest、镜像 revision 校验 | 任务 1、任务 2 |
| 3 GiB 空间预检且 migration 前失败 | 任务 1、任务 4 |
| 仅清理 Dashboard 旧镜像 | 任务 1、任务 4 |
| 保留 rollback、运行 env 与持久化数据 | 任务 1、任务 2 |
| 暂存密钥和 SSH 中断后的清理 | 任务 1、任务 2、任务 3 |
| 本机运行环境变更仍可通过 SSH 发布 | 任务 3、任务 4 |
