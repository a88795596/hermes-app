fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

configure_dev_paths() {
  HOST=127.0.0.1
  PORT=${PORT:-4317}
  [[ "$PORT" =~ ^[1-9][0-9]{0,4}$ ]] && (( PORT <= 65535 )) || fail 'PORT 必须是 1 至 65535 的端口号。'
  CONNECTOR_DB_PATH="$PWD/.data/connector.sqlite"
}

lock_dev_services() {
  # 与原有启动脚本共用锁。后台服务启动时需关闭描述符 9。
  exec 9>>.data/start.lock
  if command -v lockf >/dev/null; then
    lockf -s -t 0 9 || fail '已有服务启动或停止任务正在运行。'
  else
    command -v flock >/dev/null || fail '缺少服务锁命令 lockf 或 flock。'
    flock -n 9 || fail '已有服务启动或停止任务正在运行。'
  fi
}

wait_until() {
  local deadline=$((SECONDS + 30))
  until "$@"; do
    (( SECONDS < deadline )) || return 1
    sleep 1
  done
}

connector_pids() {
  [[ -f "$CONNECTOR_DB_PATH" ]] && lsof -nP -a -c node -t -- "$CONNECTOR_DB_PATH" 2>/dev/null
}
