#!/usr/bin/env bash
# ============================================================
# ECS 代理机内部诊断脚本 v1.0
# 用法：在 8.146.239.140 上直接 bash 执行此脚本
# 目标：定位 marketplace-api.emag.ro 连接超时根因
# ============================================================
set -euo pipefail

TARGET="marketplace-api.emag.ro"
TARGET_PORT=443
LOG_DIR="/tmp/proxy-diag-$(date +%Y%m%d_%H%M%S)"
mkdir -p "$LOG_DIR"
echo "诊断结果将保存到: $LOG_DIR"

echo ""
echo "=================================================="
echo "  第一步：本机直连 ${TARGET} 连通性测试（20次）"
echo "=================================================="
SUCCESS=0; FAIL=0
for i in $(seq 1 20); do
  START=$(date +%s%3N)
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
    --connect-timeout 8 --max-time 10 \
    "https://${TARGET}/" 2>/dev/null || echo "000")
  END=$(date +%s%3N)
  ELAPSED=$((END - START))
  if [ "$STATUS" != "000" ]; then
    SUCCESS=$((SUCCESS+1))
    echo "  [${i}/20] ✅ ${ELAPSED}ms  HTTP=${STATUS}"
  else
    FAIL=$((FAIL+1))
    echo "  [${i}/20] ❌ ${ELAPSED}ms  超时/失败"
  fi
  sleep 0.5
done
echo "  → 成功: ${SUCCESS}/20，失败: ${FAIL}/20"
echo "  → 结论: $([ $FAIL -eq 0 ] && echo '本机直连正常，问题在代理软件层' || echo '本机直连也失败 → IP 可能被 WAF 封禁')"

echo ""
echo "=================================================="
echo "  第二步：代理软件类型与进程状态"
echo "=================================================="
echo "--- 运行中的代理相关进程 ---"
ps aux | grep -E "squid|nginx|3proxy|tinyproxy|dante|ccproxy|v2ray|xray|clash" | grep -v grep || echo "  未发现常见代理进程，请手动确认"

echo ""
echo "--- 监听端口 3128 的进程 ---"
ss -tlnp | grep 3128 || netstat -tlnp 2>/dev/null | grep 3128 || echo "  无进程监听 3128"

echo "--- 系统服务状态 ---"
for svc in squid nginx tinyproxy 3proxy; do
  systemctl is-active "$svc" 2>/dev/null && echo "  ${svc}: ACTIVE" || true
done

echo ""
echo "=================================================="
echo "  第三步：Squid 错误日志（若使用 Squid）"
echo "=================================================="
SQUID_LOG_PATHS=(
  "/var/log/squid/access.log"
  "/var/log/squid/cache.log"
  "/var/log/squid3/access.log"
  "/var/log/squid3/cache.log"
  "/usr/local/squid/var/logs/access.log"
)
for LOG in "${SQUID_LOG_PATHS[@]}"; do
  if [ -f "$LOG" ]; then
    echo "  [找到] $LOG"
    echo "  --- 最近 30 条 CONNECT 记录 ---"
    grep -i "CONNECT\|TCP_TUNNEL\|ERR_\|DENIED\|emag" "$LOG" 2>/dev/null | tail -30 || echo "  (无匹配)"
    cp "$LOG" "$LOG_DIR/$(basename $LOG)" 2>/dev/null || true
  fi
done

echo ""
echo "=================================================="
echo "  第四步：系统资源瓶颈检测"
echo "=================================================="

echo "--- 内存状态 ---"
free -h

echo ""
echo "--- 当前连接数（ESTABLISHED/TIME_WAIT）---"
ss -s 2>/dev/null || netstat -s 2>/dev/null | grep -E "connections|failed|reset" | head -10

echo ""
echo "--- 文件描述符使用情况 ---"
TOTAL_FD=$(cat /proc/sys/fs/file-nr 2>/dev/null | awk '{print $1}')
MAX_FD=$(cat /proc/sys/fs/file-max 2>/dev/null)
echo "  已用: ${TOTAL_FD} / 最大: ${MAX_FD}"
PNAME_3128=$(ss -tlnp 2>/dev/null | grep 3128 | grep -oP 'pid=\K[0-9]+' | head -1)
if [ -n "$PNAME_3128" ]; then
  PID_FD=$(ls /proc/$PNAME_3128/fd 2>/dev/null | wc -l)
  ULIMIT_FD=$(cat /proc/$PNAME_3128/limits 2>/dev/null | grep "open files" | awk '{print $4}')
  echo "  代理进程 PID=$PNAME_3128 当前 fd=$PID_FD 上限=$ULIMIT_FD"
fi

echo ""
echo "--- 最近 OOM Killer 记录 ---"
dmesg 2>/dev/null | grep -i "oom\|out of memory\|killed process" | tail -5 || echo "  (无 OOM 记录)"

echo ""
echo "--- 出网流量（实时 5 秒采样）---"
IFACE=$(ip route get 8.8.8.8 2>/dev/null | awk '/dev/ {for(i=1;i<=NF;i++) if($i=="dev") {print $(i+1); exit}}')
if [ -n "$IFACE" ]; then
  RX1=$(cat /sys/class/net/$IFACE/statistics/rx_bytes 2>/dev/null)
  TX1=$(cat /sys/class/net/$IFACE/statistics/tx_bytes 2>/dev/null)
  sleep 5
  RX2=$(cat /sys/class/net/$IFACE/statistics/rx_bytes 2>/dev/null)
  TX2=$(cat /sys/class/net/$IFACE/statistics/tx_bytes 2>/dev/null)
  RX_RATE=$(( (RX2 - RX1) / 1024 / 5 ))
  TX_RATE=$(( (TX2 - TX1) / 1024 / 5 ))
  echo "  接口 $IFACE 过去5秒: 下行 ${RX_RATE} KB/s, 上行 ${TX_RATE} KB/s"
else
  echo "  无法检测网卡流量"
fi

echo ""
echo "=================================================="
echo "  第五步：Squid CONNECT 权限配置检查（若使用 Squid）"
echo "=================================================="
SQUID_CONF_PATHS=(
  "/etc/squid/squid.conf"
  "/etc/squid3/squid.conf"
  "/usr/local/squid/etc/squid.conf"
)
for CONF in "${SQUID_CONF_PATHS[@]}"; do
  if [ -f "$CONF" ]; then
    echo "  [找到配置] $CONF"
    echo "  --- CONNECT / SSL / ACL 相关配置 ---"
    grep -i "ssl_ports\|CONNECT\|acl CONNECT\|http_access.*CONNECT\|connect_timeout\|read_timeout\|request_timeout" "$CONF" 2>/dev/null | head -20
  fi
done

echo ""
echo "=================================================="
echo "  ✅ 诊断完成，请将此终端输出发给开发团队"
echo "  日志文件目录: $LOG_DIR"
echo "=================================================="
