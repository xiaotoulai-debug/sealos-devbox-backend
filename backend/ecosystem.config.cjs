/**
 * PM2 进程配置 —— Sealos / 生产环境持久化运行
 * 使用方式：npm run pm2:start  （见 package.json）
 */
const path = require('path');

module.exports = {
  apps: [
    {
      name: 'emag-backend',
      cwd: __dirname,
      script: 'node',
      args: '-r ./scripts/preload-file-polyfill.js -r tsx/cjs src/index.ts',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
    },
  ],
};
