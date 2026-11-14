#!/usr/bin/env bash
set +x
set -eo pipefail
umask 077
cd -- "$(dirname -- "$0")/.."

source scripts/dev-services.sh
if [[ -e .data/dev.env ]]; then
  source .data/dev.env
fi
configure_dev_paths
mkdir -p .data
lock_dev_services

for tool in docker lsof; do
  command -v "$tool" >/dev/null || fail "缺少停止命令 ${tool}。"
done
repo_git=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)

in_service_checkout() {
  local directory=$1 service=$2 common_git prefix
  [[ "$directory" == "$PWD/services/$service" ]] && return 0
  [[ -n "$repo_git" && "$directory" == */services/"$service" ]] || return 1
  common_git=$(git -C "$directory" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || return 1
  prefix=$(git -C "$directory" rev-parse --show-prefix 2>/dev/null) &&
    [[ "$common_git" == "$repo_git" && "$prefix" == "services/$service/" ]]
}

service_process() {
  local candidate=$1 service=$2 entry=$3 args directory executable
  # PID 文件可能过期。先核对入口和工作树，再发送信号。
  executable=$(ps -p "$candidate" -ww -o comm=) || return 1
  [[ "${executable##*/}" == node ]] || return 1
  args=$(ps -p "$candidate" -ww -o args=) || return 1
  [[ "$args" == *" src/$entry.ts" ]] || return 1
  directory=$(lsof -nP -a -p "$candidate" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')
  in_service_checkout "$directory" "$service"
}

process_exited() {
  local state
  state=$(ps -p "$1" -o stat=) || return 0
  [[ "$state" == Z* ]]
}

stop_process() {
  local label=$1 service=$2 entry=$3 candidates=$4 candidate parent args target
  if [[ -f ".data/$service.pid" && -r ".data/$service.pid" ]]; then
    candidate=$(<".data/$service.pid")
    if [[ "$candidate" =~ ^[1-9][0-9]*$ ]]; then
      candidates="$candidate $candidates"
    fi
  fi

  for candidate in $candidates; do
    service_process "$candidate" "$service" "$entry" || continue
    target=$candidate
    parent=$(ps -p "$candidate" -o ppid= | tr -d ' ')
    args=$(ps -p "${parent:-1}" -ww -o args= || true)
    # tsx 的 watch 模式会重启子进程，由父进程负责转发退出信号。
    if [[ "$args" == *'/tsx/dist/cli.mjs watch src/'"$entry.ts" ]]; then
      target=$parent
    fi
    printf '正在停止 %s。\n' "$label"
    kill -TERM "$target" 2>/dev/null || process_exited "$target" || fail "无法停止 ${label}。"
    wait_until process_exited "$candidate" || fail "${label} 未退出，请查看 .data/${service}.log。"
    wait_until process_exited "$target" || fail "${label} 的监视进程未退出。"
  done
  rm -f -- ".data/$service.pid"
  if [[ -z "$target" ]]; then
    printf '%s 未运行，跳过停止。\n' "$label"
  fi
}

stop_container() {
  local container
  container=$(docker ps -q --filter "name=^/?$1\$") || fail "无法检查容器 $1，请检查 Docker。"
  if [[ -n "$container" ]]; then
    printf '正在停止 %s。\n' "$1"
    docker stop "$container" >/dev/null || fail "无法停止容器 ${1}。"
  else
    printf '%s 未运行，跳过停止。\n' "$1"
  fi
}

stop_process 连接器 connector index "$(connector_pids || true)"
stop_process BFF bff main "$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null || true)"
stop_container hermes-mobile-postgres
printf '停止检查完成。\n'
