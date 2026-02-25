#!/usr/bin/env bash
set -euo pipefail

sudo cp deploy/systemd/believeboy-api.service /etc/systemd/system/
sudo cp deploy/systemd/believeboy-worker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now believeboy-api.service
sudo systemctl enable --now believeboy-worker.service
sudo systemctl status believeboy-api.service --no-pager
sudo systemctl status believeboy-worker.service --no-pager
