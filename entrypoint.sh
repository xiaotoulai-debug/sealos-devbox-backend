#!/bin/bash

app_env=${1:-development}

# Development environment commands (开发机运行的命令)
dev_commands() {
    echo "Running development environment commands..."
    # 进入后端目录并启动开发服务
    cd backend
    npm run dev
}

# Production environment commands (发版后正式服运行的命令)
prod_commands() {
    echo "Running production environment commands..."
    # 进入后端目录并启动正式服务
    cd backend
    npm run start
}

# Check environment variables to determine the running environment
if [ "$app_env" = "production" ] || [ "$app_env" = "prod" ] ; then
    echo "Production environment detected"
    prod_commands
else
    echo "Development environment detected"
    dev_commands
fi