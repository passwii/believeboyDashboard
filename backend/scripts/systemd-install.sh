#!/usr/bin/env bash
set -euo pipefail

sudo cp deploy/systemd/believeboy-api.service /etc/systemd/system/
sudo cp deploy/systemd/believeboy-celery.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now believeboy-api.service
sudo systemctl enable --now believeboy-celery.service
sudo systemctl status believeboy-api.service --no-pager
sudo systemctl status believeboy-celery.service --no-pager
