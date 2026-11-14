#!/usr/bin/env bash
set +x
set -eo pipefail
umask 077
cd -- "$(dirname -- "$0")/.."

source scripts/dev-services.sh
[[ -r .data/dev.env ]] || fail '找不到可读的 .data/dev.env，请按 README 配置本地凭据。'
set -a
source .data/dev.env
set +a

for tool in docker node curl lsof; do
  command -v "$tool" >/dev/null || fail "缺少启动命令 ${tool}。"
done
[[ -n "$POSTGRES_PASSWORD" && -n "$APP_PAIRING_TOKEN" && -n "$CONNECTOR_TOKEN" ]] ||
  fail '请在 .data/dev.env 中设置 POSTGRES_PASSWORD、APP_PAIRING_TOKEN 和 CONNECTOR_TOKEN。'
[[ "$APP_PAIRING_TOKEN" != "$CONNECTOR_TOKEN" ]] || fail '配对令牌和连接器令牌需要分别配置。'

configure_dev_paths
export HOST PORT CONNECTOR_DB_PATH BFF_URL="http://$HOST:$PORT"
lock_dev_services

start_container() {
  local state
  state=$(docker inspect --format '{{.State.Running}}' "$1") || fail "无法检查容器 $1，请检查 Docker 和本地容器配置。"
  if [[ "$state" == true ]]; then
    printf '%s 已在运行，跳过启动。\n' "$1"
  else
    printf '正在启动 %s。\n' "$1"
    docker start "$1" >/dev/null || fail "无法启动容器 ${1}。"
  fi
}

postgres_ready() {
  docker exec hermes-mobile-postgres pg_isready -h 127.0.0.1 -U postgres -d hermes_mobile >/dev/null 2>&1
}

healthy() {
  local response
  response=$(curl -q -fsS --noproxy '*' --max-time 2 "$1/health" 2>/dev/null) &&
    [[ "$response" =~ \"status\"[[:space:]]*:[[:space:]]*\"ok\" ]]
}

hermes_ready() {
  node --input-type=module -e '
    const url = new URL("/api/webapp/socket-ticket?socket=gateway&profile=default", process.env.HERMES_WEBAPP_URL);
    const response = await fetch(url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(2000),
      headers: { authorization: "Bearer " + process.env.HERMES_DASHBOARD_SESSION_TOKEN } });
    if (!response.ok || !(await response.json()).ticket) process.exitCode = 1;
  ' >/dev/null 2>&1
}

launch() {
  local service=$1 entry=$2
  log="$PWD/.data/$service.log"
  (
    cd "services/$service"
    exec nohup node --import tsx "src/$entry.ts"
  ) </dev/null >"$log" 2>&1 9>&- &
  pid=$!
  trap 'kill "$pid" 2>/dev/null || true' EXIT
  printf '%s\n' "$pid" > ".data/$service.pid"
}

bff_ready() {
  kill -0 "$pid" 2>/dev/null || fail "BFF 进程已退出，请查看 ${log}。"
  healthy "$BFF_URL"
}

connector_ready() {
  kill -0 "$1" 2>/dev/null || fail "连接器进程已退出，请查看 .data/connector.log。"
  local sockets
  sockets=$(lsof -nP -a -p "$1" -iTCP -sTCP:ESTABLISHED -Fn 2>/dev/null) &&
    [[ "$sockets"$'\n' == *"->$HOST:$PORT"$'\n'* ]]
}

connector_started() {
  connector_ready "$pid" && grep -Fxq 'Hermes 连接器已连接 BFF' "$log"
}

start_container hermes-mobile-postgres
wait_until postgres_ready || fail 'PostgreSQL 未就绪，请查看 docker logs hermes-mobile-postgres。'

if [[ -n "$HERMES_WEBAPP_URL" ]]; then
  [[ -n "$HERMES_DASHBOARD_SESSION_TOKEN" ]] || fail '请设置 HERMES_DASHBOARD_SESSION_TOKEN。'
  wait_until hermes_ready || fail 'Hermes Webapp 未就绪，请检查地址、令牌及网关配置。'
else
  command -v "${HERMES_BIN:-hermes}" >/dev/null || fail '请安装 Hermes 或设置 HERMES_BIN。'
  wait_until "${HERMES_BIN:-hermes}" gateway attach --json >/dev/null 2>&1 ||
    fail 'Hermes 网关未就绪，请先启动支持 gateway attach 的原版 Hermes。'
fi

if healthy "$BFF_URL"; then
  printf 'BFF 已在运行，跳过启动。\n'
else
  if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    fail "端口 $PORT 已被监听，BFF 健康检查失败。"
  fi
  password=$(node -p 'encodeURIComponent(process.env.POSTGRES_PASSWORD)')
  export DATABASE_URL="postgresql://postgres:$password@127.0.0.1:55432/hermes_mobile"
  printf '正在启动 BFF。\n'
  launch bff main
  wait_until bff_ready || fail "BFF 未就绪，请查看 ${log}。"
  trap - EXIT
fi

if connector_pid=$(connector_pids); then
  printf '连接器已在运行，跳过启动。\n'
  # shortcut: 本地开发栈只有一个连接器，支持多连接器时改用 BFF 的连接状态查询。
  wait_until connector_ready "${connector_pid%%$'\n'*}" || fail '连接器正在运行，但未连上 BFF，请查看 .data/connector.log。'
else
  printf '正在启动连接器。\n'
  launch connector index
  wait_until connector_started || fail "连接器未连上 BFF，请查看 ${log}。"
  trap - EXIT
fi

printf '启动检查完成。BFF 地址 %s\n' "$BFF_URL"
