#!/bin/bash
# macOS 的安装包服务入口；launchctl 托管已安装版本，开发目录不参与运行。
set -euo pipefail

if [ "$(uname -s)" != Darwin ]; then
  echo "此脚本仅用于 macOS 的 launchctl 服务。" >&2
  exit 1
fi

RUNTIME_ROOT="${PI_WEB_RUNTIME_ROOT:-$HOME/.local/share/pi-web-runtime}"
SERVICE_LABEL=com.agegr.pi-web
SERVICE_PORT=8081
SERVICE_LOG="$RUNTIME_ROOT/prod.log"
SERVICE_CONFIG="$RUNTIME_ROOT/service.env"
PACKAGE_ROOT=$(cd "$(dirname "$0")/.." && pwd -P)
ACTION="${1:-}"

listener_pids() {
  # FUSE 上 lsof 的退出码可能与输出不一致，以实际 PID 输出判断端口占用。
  lsof -nP -tiTCP:"$SERVICE_PORT" -sTCP:LISTEN 2>/dev/null || true
}

stop_service() {
  if launchctl list "$SERVICE_LABEL" >/dev/null 2>&1; then
    launchctl remove "$SERVICE_LABEL"
  fi
  for ((attempt=0; attempt<30; attempt++)); do
    if ! launchctl list "$SERVICE_LABEL" >/dev/null 2>&1 && [ -z "$(listener_pids)" ]; then
      echo "pi-web 已停止。"
      return 0
    fi
    sleep 1
  done
  echo "作业或 $SERVICE_PORT 端口未释放；未对未知进程执行 kill。请核对：" >&2
  lsof -nP -iTCP:"$SERVICE_PORT" -sTCP:LISTEN >&2 || true
  return 1
}

start_service() {
  [ -f "$PACKAGE_ROOT/.next/BUILD_ID" ] || { echo "安装包缺少构建产物。" >&2; return 1; }
  [ -f "$SERVICE_CONFIG" ] || { echo "请先创建 ${SERVICE_CONFIG}。" >&2; return 1; }
  if launchctl list "$SERVICE_LABEL" >/dev/null 2>&1; then
    echo "pi-web 作业已存在；需要重新加载版本或配置时请使用 restart。" >&2
    return 1
  fi
  if [ -n "$(listener_pids)" ]; then
    echo "$SERVICE_PORT 已被占用；未停止未知进程：" >&2
    lsof -nP -iTCP:"$SERVICE_PORT" -sTCP:LISTEN >&2 || true
    return 1
  fi

  # 配置来自用户自己的私有文件；保持登录密码、代理与允许域名在运行时设置。
  set -a
  source "$SERVICE_CONFIG"
  set +a
  [ -n "${PI_WEB_PASSWORD:-}" ] || { echo "service.env 中 PI_WEB_PASSWORD 不能为空。" >&2; return 1; }
  local node_binary
  node_binary=$(command -v node)
  mkdir -p "$RUNTIME_ROOT"
  if [ -s "$SERVICE_LOG" ]; then mv -f "$SERVICE_LOG" "$SERVICE_LOG.1"; fi

  # 固定为本版本的真实安装路径，切换 current 不会改变在运行实例读取的 chunk。
  {
    printf '#!/bin/bash\nset -euo pipefail\n'
    printf 'export PATH=%q\n' "$HOME/.local/bin:$PATH"
    printf 'set -a\nsource %q\nset +a\n' "$SERVICE_CONFIG"
    printf 'cd %q\n' "$PACKAGE_ROOT"
    printf 'exec %q %q -H 0.0.0.0 -p %q --no-open\n' "$node_binary" "$PACKAGE_ROOT/bin/pi-web.js" "$SERVICE_PORT"
  } > "$RUNTIME_ROOT/run.sh"
  chmod 700 "$RUNTIME_ROOT/run.sh"
  launchctl submit -l "$SERVICE_LABEL" -o "$SERVICE_LOG" -e "$SERVICE_LOG" -- /bin/bash "$RUNTIME_ROOT/run.sh"

  local service_pid health_host
  health_host="${PI_WEB_ALLOWED_HOSTS:-127.0.0.1}"
  health_host="${health_host%%,*}"
  for ((attempt=0; attempt<30; attempt++)); do
    service_pid=$(listener_pids | head -1)
    if [ -n "$service_pid" ] && curl --noproxy '*' -fsS -m 3 -o /dev/null \
      -H "Host: $health_host" "http://127.0.0.1:$SERVICE_PORT/login"; then
      printf '%s\n' "$service_pid" > "$RUNTIME_ROOT/prod.pid"
      echo "pi-web 已启动，监听 PID：${service_pid}，端口：${SERVICE_PORT}"
      "$node_binary" -p "require(process.argv[1]).version" "$PACKAGE_ROOT/package.json"
      echo "日志：$SERVICE_LOG"
      return 0
    fi
    sleep 1
  done
  echo "服务健康检查失败，请查看 ${SERVICE_LOG}。" >&2
  tail -n 30 "$SERVICE_LOG" >&2
  return 1
}

case "$ACTION" in
  start) start_service ;;
  stop) stop_service ;;
  restart) stop_service; start_service ;;
  status)
    if launchctl list "$SERVICE_LABEL" >/dev/null 2>&1; then
      echo "launchctl 作业已注册。"
    else
      echo "launchctl 作业未注册。"
    fi
    lsof -nP -iTCP:"$SERVICE_PORT" -sTCP:LISTEN || true
    ;;
  *) echo "用法：bash $0 start|stop|restart|status" >&2; exit 2 ;;
esac
