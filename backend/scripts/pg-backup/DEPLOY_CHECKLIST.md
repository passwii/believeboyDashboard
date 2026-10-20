# PostgreSQL 备份到 R2 - VPS 部署检查清单

## 环境信息

- **VPS**: 你的 VPS (Ubuntu/Debian)
- **数据库**: PostgreSQL
- **目标存储**: Cloudflare R2 (Bucket: `believeboy-private`，**私有桶** —— BLF-1418：
  备份含生产库全量数据，不能放在挂了自定义域名的公开桶 `believeboy-dash` 上)

---

## 阶段 1: 环境准备

### 1.1 安装依赖

- [ ] 连接 VPS
  ```bash
  ssh user@your-vps-ip
  ```

- [ ] 安装 pgBackRest
  ```bash
  sudo apt update
  sudo apt install pgbackrest -y
  ```

- [ ] 验证安装
  ```bash
  pgbackrest version
  ```

- [ ] 安装 rclone (可选，用于测试 R2 连接)
  ```bash
  curl https://rclone.org/install.sh | sudo bash
  ```

### 1.2 检查 PostgreSQL 版本

- [ ] 查看 PostgreSQL 版本
  ```bash
  psql --version
  ```

- [ ] 查看 PostgreSQL 配置路径
  ```bash
  sudo -u postgres psql -c "SHOW config_file;"
  ```

---

## 阶段 2: 配置 WAL 归档

### 2.1 修改 postgresql.conf

- [ ] 备份原始配置
  ```bash
  sudo cp /etc/postgresql/*/main/postgresql.conf /etc/postgresql/*/main/postgresql.conf.bak
  ```

- [ ] 编辑配置
  ```bash
  sudo nano /etc/postgresql/*/main/postgresql.conf
  ```

- [ ] 添加/修改以下配置项:
  ```ini
  wal_level = replica
  max_wal_senders = 3
  wal_keep_size = 1GB
  archive_mode = on
  archive_command = 'pgbackrest --stanza=blf archive-push %p'
  archive_timeout = 300
  ```

- [ ] 重启 PostgreSQL
  ```bash
  sudo systemctl restart postgresql
  ```

- [ ] 验证配置生效
  ```bash
  sudo -u postgres psql -c "SHOW archive_mode;"
  # 应输出: on
  ```

---

## 阶段 3: 配置 pgBackRest

### 3.1 创建目录

- [ ] 创建日志目录
  ```bash
  sudo mkdir -p /var/log/pgbackrest
  sudo chown postgres:postgres /var/log/pgbackrest
  ```

- [ ] 创建备份本地缓存目录
  ```bash
  sudo mkdir -p /var/lib/pgbackrest/backups
  sudo chown postgres:postgres /var/lib/pgbackrest
  sudo chmod 750 /var/lib/pgbackrest
  ```

### 3.2 部署配置文件

- [ ] 从本项目复制配置到 VPS
  ```bash
  # 方式 1: SCP
  scp backend/scripts/pg-backup/conf/pgbackrest.conf user@vps:/tmp/
  ```

- [ ] 移动到系统目录
  ```bash
  sudo mv /tmp/pgbackrest.conf /etc/pgbackrest.conf
  sudo chown postgres:postgres /etc/pgbackrest.conf
  sudo chmod 600 /etc/pgbackrest.conf
  ```

- [ ] **重要**: 确认配置文件中的 R2 凭证正确
  ```bash
  sudo nano /etc/pgbackrest.conf
  # 检查以下配置项:
  # repo1-s3-endpoint: 应该是 https://xxx.r2.cloudflarestorage.com
  # repo1-s3-key: 你的 access key
  # repo1-s3-key-secret: 你的 secret key
  ```

### 3.3 初始化 stanza

- [ ] 创建 stanza
  ```bash
  sudo -u postgres pgbackrest stanza-create --stanza=blf --log-level-console=info
  ```

- [ ] 验证配置
  ```bash
  sudo -u postgres pgbackrest check --stanza=blf
  ```

---

## 阶段 4: 部署备份脚本

### 4.1 创建脚本目录

- [ ] 创建脚本目录
  ```bash
  sudo mkdir -p /opt/postgresql/backup
  ```

### 4.2 复制脚本

- [ ] 从本项目复制脚本到 VPS
  ```bash
  scp backend/scripts/pg-backup/*.sh user@vps:/tmp/
  ```

- [ ] 移动并设置权限
  ```bash
  sudo mv /tmp/*.sh /opt/postgresql/backup/
  sudo chown postgres:postgres /opt/postgresql/backup/*.sh
  sudo chmod 755 /opt/postgresql/backup/*.sh
  ```

---

## 阶段 5: 首次测试

### 5.1 测试连接 R2

- [ ] 手动测试备份 (首次全量)
  ```bash
  sudo -u postgres pgbackrest backup --stanza=blf --type=full --log-level-console=info
  ```

- [ ] 查看备份列表
  ```bash
  sudo -u postgres pgbackrest info --stanza=blf
  ```

- [ ] 验证备份完整性
  ```bash
  sudo -u postgres pgbackrest backup-verify --stanza=blf
  ```

### 5.2 检查 R2

- [ ] 在 R2 Dashboard 查看是否有数据
  ```
  路径: backups/blf/repo/backup/
  ```

---

## 阶段 6: 配置定时任务

### 6.1 编辑 crontab

- [ ] 打开 crontab
  ```bash
  sudo -u postgres crontab -e
  ```

- [ ] 添加定时任务
  ```cron
  # PostgreSQL Daily Full Backup - 每天凌晨 3:00
  0 3 * * * /opt/postgresql/backup/daily-full-backup.sh >> /var/log/pgbackrest/cron.log 2>&1

  # WAL Archive Verification - 每 6 小时
  0 */6 * * * /opt/postgresql/backup/verify-wal-archive.sh >> /var/log/pgbackrest/wal_verify.log 2>&1
  ```

- [ ] 保存并退出

### 6.2 验证 crontab

- [ ] 查看 crontab
  ```bash
  sudo -u postgres crontab -l
  ```

---

## 阶段 7: 验证流程

### 7.1 功能验证清单

- [ ] pgBackRest 已安装: `pgbackrest version`
- [ ] PostgreSQL WAL 归档已启用: `sudo -u postgres psql -c "SHOW archive_mode;"`
- [ ] pgBackRest 配置已部署: `sudo test -f /etc/pgbackrest.conf`
- [ ] Stanza 已创建: `sudo -u postgres pgbackrest check --stanza=blf`
- [ ] 首次备份已完成
- [ ] R2 上有备份数据
- [ ] Crontab 已配置

### 7.2 备份状态脚本测试

- [ ] 测试查看备份状态
  ```bash
  /opt/postgresql/backup/backup-info.sh
  ```

- [ ] 测试 WAL 归档验证
  ```bash
  /opt/postgresql/backup/verify-wal-archive.sh
  ```

---

## 阶段 8: 恢复测试 (重要!)

### 8.1 准备测试环境

> ⚠️ **警告**: 以下测试会在生产数据库上执行！建议在低峰期进行。

- [ ] 确认要测试恢复的时间点
  ```bash
  sudo -u postgres pgbackrest info --stanza=blf
  ```

### 8.2 执行恢复测试

- [ ] 创建测试脚本 (可选，不实际恢复)
  ```bash
  # 记录测试信息
  echo "恢复测试时间: $(date)" >> /var/log/pgbackrest/restore_test.log
  ```

- [ ] **完整恢复测试** (可选，按需执行)
  ```bash
  # 先备份当前数据 (如果需要)
  sudo -u postgres pg_dump BLF > /tmp/pre_restore_backup.sql

  # 执行恢复
  sudo /opt/postgresql/backup/restore.sh

  # 验证数据
  sudo -u postgres psql -c "SELECT COUNT(*) FROM any_table;"

  # 恢复到恢复前状态
  sudo /opt/postgresql/backup/restore.sh  # 或恢复到测试前的时间点
  ```

---

## 阶段 9: 监控设置

### 9.1 日志检查

- [ ] 确认日志目录有写入权限
  ```bash
  ls -la /var/log/pgbackrest/
  ```

- [ ] 查看日志
  ```bash
  sudo tail -f /var/log/pgbackrest/daily_backup_*.log
  ```

### 9.2 邮件/通知配置 (可选)

- [ ] 如果需要邮件通知，配置 postfix 或使用外部 SMTP
  ```bash
  # 安装 postfix
  sudo apt install postfix
  ```

---

## 部署完成

完成以上所有步骤后，备份系统将自动运行：

| 时间 | 任务 | 状态 |
|------|------|------|
| 每天 03:00 | 每日全量备份 | 自动 |
| 每 6 小时 | WAL 归档验证 | 自动 |
| 实时 | WAL 归档 | 自动 |

---

## 常用命令速查

```bash
# 查看备份状态
/opt/postgresql/backup/backup-info.sh

# 手动执行备份
sudo -u postgres /opt/postgresql/backup/daily-full-backup.sh

# 恢复到最新备份
sudo /opt/postgresql/backup/restore.sh

# 恢复到指定时间点
sudo /opt/postgresql/backup/restore.sh "2024-01-15 14:30:00"

# 查看日志
sudo tail -f /var/log/pgbackrest/daily_backup_*.log

# 验证备份完整性
sudo -u postgres pgbackrest backup-verify --stanza=blf
```

---

## 故障排除

| 问题 | 可能原因 | 解决方式 |
|------|----------|----------|
| pgbackrest: command not found | 未安装 | `sudo apt install pgbackrest` |
| stanza not found | 未创建 stanza | `pgbackrest stanza-create --stanza=blf` |
| R2 连接失败 | Endpoint 错误 | 检查 `repo1-s3-endpoint` 配置 |
| WAL 归档失败 | PostgreSQL 配置错误 | 检查 `archive_mode` 和 `archive_command` |
| 恢复失败 | 服务未停止 | 确保 `sudo systemctl stop postgresql` |

---

## 签署确认

部署完成后，请在此签字确认:

- [ ] 部署完成日期: _______________
- [ ] 部署人员: _______________
- [ ] 首次备份时间: _______________
- [ ] 备注: _______________