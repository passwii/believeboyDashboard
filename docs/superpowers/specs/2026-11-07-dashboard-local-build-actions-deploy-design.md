# Dashboard 本地构建、Actions 部署与 VPS 空间回收设计

日期：2026-11-07

状态：用户已批准，按实施计划进行

## 背景

目前 `git deploy` 推送 `main` 后，在本机运行迁移检查、前端 lint 与测试，构建并推送 FastAPI、Go API、Web 三张 GHCR 镜像，最后由本机 SSH 连接 VPS 部署。镜像已经按 digest 固定，但本机 SSH 不稳定会影响最后的部署阶段。

现有 GitHub Actions 只能手动触发完整构建和部署，不能接收本地构建好的三张镜像 digest。因此若本地构建后再直接触发现有工作流，会在 GitHub 上重复构建。

2026-11-07 的一次部署因 VPS 根分区空间耗尽，在迁移阶段报 `No space left on device`，随后应用镜像回滚成功。按用户授权清理未使用镜像后，累计回收约 4.768 GB；再次部署成功，Web、FastAPI、Go API 和两个 Celery worker 均通过健康检查，最终根分区约有 3.1 GB 可用空间。此次全局镜像清理是一次性操作；后续自动清理必须限定在 Dashboard 自己的镜像范围内。

## 目标

- 本机继续负责代码检查、构建与推送三张镜像。
- 由 GitHub Actions 使用本机提供的不可变 digest，通过现有 SSH Secrets 连接 VPS 并部署，避免日常发布依赖本机到 VPS 的 SSH 连通性。
- 保留 Actions 完整构建流程作为手动备用方式，并保留本机 SSH 作为显式应急方式。
- 每次 VPS 部署前后回收过期的 Dashboard 镜像；读取部署分区总容量，要求可用空间严格大于 10%，空间不足时在数据库迁移前中止。
- 对部署暂存文件和临时密钥实行成功、失败路径清理，同时保留运行所需的环境文件与数据。

## 范围与边界

- 发布仍只针对 `main`，Web、FastAPI、Go API 始终作为同一版本镜像组部署和回滚。
- 本机 Actions 与 SSH 发布都使用三个固定 GHCR 仓库；Docker build context 含有未跟踪且未忽略的文件时，本机在构建前中止。
- VPS 继续使用现有统一 Compose；PostgreSQL、Redis、Caddy 仍为宿主机公共设施。
- 数据库 migration 不自动回滚，迁移继续保持向后兼容。
- Docker volume、`backend-storage`、`celerybeat`、数据库文件及其他应用的镜像不属于自动回收范围。
- `backend.env`、`web.env`、`go.env` 是运行配置，不作为临时文件删除。

## 发布流程

### 默认流程：本机构建，Actions 部署

1. `git deploy` 将 `main` 推送到 `origin`。
2. 本机确认 `HEAD` 与 `origin/main` 一致，执行 Alembic 图检查、前端 lint 与测试。
3. 本机按 `linux/amd64` 构建并推送 FastAPI、Go API、Web 镜像，读取 registry digest。
4. 本机用 `gh` 手动派发 `deploy-dashboard.yml`，传入 `source_sha` 和三张镜像的 digest。
5. Actions 校验输入与当前 `main` 运行对应，然后跳过依赖安装、测试和镜像构建，使用现有 SSH Secrets 将配置暂存到 VPS，并调用统一远端部署脚本。
6. 本机等待 Actions 完成，输出工作流运行链接和最终状态。失败时返回非零状态，方便直接定位 GitHub 日志。

发布参数只传 commit SHA 与 digest，不传运行密钥。Actions 继续从 GitHub Secrets 读取 VPS 地址、SSH key、known hosts 及 Go 可信代理密钥；VPS 上现有的 GHCR 拉取凭据继续负责拉取镜像。

预构建部署由远端脚本在持有部署锁时，从 VPS 现有 `web.env` 和 GitHub Secret 生成暂存 Web/Go 配置；不会把本机 `.env.local` 或 `deploy.env` 内容作为 workflow 输入。若一次发布同时需要更新本机运行期环境值，应走本机 SSH 应急路径，或先把该配置纳入专门的安全同步设计。

### 输入校验

- 工作流仍只允许在 `main` 上运行。
- `source_sha` 必须是完整 40 位 commit SHA，且与本次 Actions 的 `github.sha` 相同。
- 三张 digest 必须符合 `sha256:<64 位十六进制>` 格式。
- 镜像仓库名固定为 `ghcr.io/passwii/believeboydashboard-api`、`ghcr.io/passwii/believeboydashboard-go-api` 和 `ghcr.io/passwii/believeboydashboard-web`；调用者不能通过输入替换仓库地址。
- Actions 在连接 VPS 前校验 SHA 和 digest；远端拉取目标镜像后、数据库迁移前读取 `org.opencontainers.image.revision` 标签，确认三张镜像都来自 `source_sha`。不匹配时停止部署并清理新拉取且无容器引用的镜像。
- 保留现有 Actions concurrency，避免两个 Actions 部署同时改写 VPS 配置或 Compose 状态。

### 备用流程

- 不带本地 digest 输入手动运行 `gh workflow run deploy-dashboard.yml --ref main` 时，继续执行当前的 Actions 检查、构建、推送和部署。
- 提供明确的本机 SSH 应急选项。它复用本机刚构建的三张 digest，跳过 Actions，继续走当前的 SSH 暂存与远端部署路径。
- `PUSH_ONLY=1 git deploy` 仍只推代码，不构建或部署。

## VPS 镜像与空间生命周期

远端脚本只管理以下三个仓库中的镜像：

- `ghcr.io/passwii/believeboydashboard-api`
- `ghcr.io/passwii/believeboydashboard-go-api`
- `ghcr.io/passwii/believeboydashboard-web`

部署事务按以下顺序处理镜像和 VPS 运行状态：

1. 本机或 Actions runner 只创建唯一 `.deploy-staging.*` 暂存目录并上传本次文件；在取得远端锁前不修改活动 env、Compose、数据目录权限或运行服务。
2. 远端脚本取得部署锁；锁覆盖 VPS bootstrap、旧运行数据复制、env 生成或更新、数据目录权限变更、旧服务停止、镜像拉取、migration、健康检查、回滚与清理。
3. 记录根分区可用字节及 Docker 镜像占用；在拉取目标镜像前，只删除三个固定仓库中未被任何容器使用、也不属于当前 `.deploy-images` 的过期引用。不得运行无范围限制的 `docker image prune -a`、`docker system prune` 或 volume prune。
4. 读取部署分区总容量与可用字节，要求可用空间严格大于总容量的 10%；未达到时停止部署并报告磁盘状态，不得停止旧服务或开始数据库迁移。需要复制 legacy 数据时，先统计其已分配空间并预检剩余空间额外覆盖待复制数据估算值、估算值的 10% 和 512 MiB 缓冲；目标镜像拉取后、停机前再次执行该精确检查，未通过则不停止旧服务。
5. 拉取目标 digest 并验证 revision 标签后，停止旧写入方，再复制 legacy storage/celerybeat、调整目录权限并再次检查 10% 门槛，最后运行 migration 和启动新服务。若拉取、复制、迁移或健康检查失败，恢复原配置与镜像组；迁移后的应用回滚使用 `--no-deps` 明确启动业务服务、跳过旧 `migrate`，避免旧 Alembic 因数据库版本超前而阻塞。回滚成功后清理未被恢复中的容器或当前 manifest 引用的失败目标镜像。回滚失败时保留回滚目录且不回收镜像。
6. FastAPI、Go API、Web、两个 Celery worker、beat 与公网 Web/API 检查全部通过后，在锁内禁用旧 systemd 单元、更新 `.deploy-images`、删除回滚副本，再回收没有容器引用的旧 Dashboard 镜像。
7. 记录部署 SHA、三个 digest、删除引用数以及部署前后磁盘和镜像占用；若遗留容器仍引用旧版本则保留并报告。不触碰其他仓库或持久化数据。

空间检查应在迁移前完成。若新镜像拉取后空间不足，迁移尚未执行；部署失败处理仍会恢复旧容器，并清理未被容器引用的本次目标镜像。迁移已经成功而后续健康检查失败时，按现有语义回滚应用镜像与配置，不自动回滚数据库。

## 暂存文件与密钥清理

- 本机临时目录和 Actions runner 上的 SSH 私钥、临时 secret 文件通过退出 trap 清理。
- VPS 上唯一 `.deploy-staging.*` 目录内的 env、secret、Compose 与远端脚本，以及 `.deploy-images.next.*`、`.deploy-config.next.*` 等临时文件，在部署成功或回滚完成后删除。
- 远端部署脚本使用退出清理逻辑，Actions 增加带同一 `.deploy.lock` 的 `always()` 清理步骤。远端事务仍持锁时不得删除其暂存目录；下一次部署取得远端锁后，也会先清理上次留下的已知暂存文件。若 VPS 在 SSH 中断期间不可达，清理延至 VPS 再次可达时执行。
- 正常成功或回滚完成时删除 `.deploy-rollback.*`。若自动回滚失败，保留权限受限的回滚副本供人工恢复，并在日志中打印路径；密钥暂存文件仍需清理。
- 始终保留 `backend.env`、`web.env`、`go.env`、`.deploy-images`、`backend-storage` 与 `celerybeat`。

## 失败处理与可观测性

- 输入、SHA 或 digest 校验失败时，在接触 VPS 前终止；镜像 revision 不匹配时，在数据库迁移前终止。
- SSH 或传输失败时，Actions 显示失败步骤和运行链接；可用同一组 digest 重试或选择本机 SSH 应急方式。
- 磁盘不足或 legacy 数据复制预检不满足保留空间要求时，在停止旧服务和迁移前终止，并在日志中列出可用空间与 Docker 镜像占用摘要。
- 远端 bootstrap、env 更新、服务停机、migration 和 rollback 都必须在同一部署锁内执行；远端部署失败时恢复原配置、运行版本、数据迁移标记以及部署前处于活动状态的 legacy 写入方。自动回滚失败时保留最小必要恢复文件；若需要恢复 legacy 写入方，必须先停止失败的 Compose 写入服务，避免新旧 worker/beat 并行。
- 垃圾回收只删除没有容器引用的过期镜像；若旧 Dashboard 镜像仍被遗留容器引用，则保留并报告，避免为清空间而删除容器。
- 新版本健康后仍要逐个确认旧 systemd 单元已 disabled；任一单元仍 enabled 时不得报告部署成功，应保留 rollback 副本和旧镜像供人工处理。
- 部署日志记录源码 SHA、三个镜像 digest、部署阶段结果、清理数量及前后磁盘和 Docker 镜像占用，不记录密钥值。

## 验收标准

- 默认 `git deploy` 只在本机执行一次镜像构建；Actions 日志能证明预构建模式没有再次运行 Docker build。
- Actions 只部署与 `github.sha` 一致的三个固定仓库 digest；无效 SHA、digest、revision 或非 `main` ref 会在部署前失败。
- 本机不需要建立到 VPS 的 SSH 连接即可完成默认部署；Actions 成功后，本机能报告运行链接和最终结果。
- 手动完整构建备用流程、本机 SSH 应急流程和 `PUSH_ONLY=1` 均可使用。
- 镜像拉取前执行限定在 Dashboard 仓库的过期镜像回收；空间低于阈值时不运行 migration。
- 成功部署后没有容器引用的旧 Dashboard 镜像被回收；失败部署能恢复原镜像组，且不删除其他应用镜像、Docker volume、上传文件或数据库数据。
- 成功或回滚完成后清理临时密钥与环境暂存文件；若 SSH 中断使 VPS 暂时不可达，残留文件在下一次部署连接成功后清理。仅在自动回滚失败时保留受限权限的回滚副本。
- Actions 和 SSH fallback 都在远端部署锁内修改活动 VPS 状态，Actions 收尾清理也不得绕过该锁；失败回滚成功后回收失败版本且未被容器/manifest 引用的目标镜像。
- 本地 Actions 和 SSH 发布拒绝未跟踪且未忽略的 build context 文件，避免把未标记为 `source_sha` 的源码打入镜像。

## 方案取舍

- **推荐：本机构建并传 digest，Actions 只部署。** 不重复构建，最后一步由 GitHub runner 连接 VPS，直接解决本机到 VPS SSH 不稳定的问题，同时保留镜像 digest 的可追溯性。
- **Actions 每次重建后部署。** 沿用现状，流程简单，但本机先构建和推送后会重复消耗构建时间，且不满足“本机构建、Actions 部署”的目标。
- **继续由本机直接 SSH。** 改动最少，但没有消除目前的网络故障点；保留为显式应急路径。

## 待评审决策

1. 是否确认 `git deploy` 默认改为“本机构建与推送 → GitHub Actions 部署”。
2. 已确认部署前按分区总容量动态要求可用空间严格大于 10%。
3. 是否接受成功后只保留当前运行的三张 Dashboard 镜像，失败回滚成功前始终保留旧镜像组。
4. 是否接受镜像发布沿用 VPS 当前运行环境配置；本机运行期环境值更新继续使用 SSH 应急路径。
