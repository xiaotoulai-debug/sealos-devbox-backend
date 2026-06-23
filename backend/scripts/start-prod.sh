#!/usr/bin/env bash
# Sealos / 生产环境：使用 PM2 拉起后端并写入持久化列表（配合 pm2 resurrect / startup）
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v pm2 >/dev/null 2>&1; then
  echo "pm2 未安装，请执行: cd backend && npm ci && npm run pm2:start"
  exit 1
fi

pm2 start ecosystem.config.cjs
pm2 save
echo "PM2 已启动并执行 pm2 save。进程名: emag-backend"
