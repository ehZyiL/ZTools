#!/bin/sh
# 让 electron-builder 的 rpm 目标在 rpm 4.20+ 的主机上也能工作。
#
# 背景：electron-builder 通过 fpm 调用 rpmbuild，并依赖 `--define buildroot`
# 把预填好文件的目录当作 buildroot。rpm 4.20 起 rpmbuild 改为
# `%{_builddir}/%{name}-%{version}-build/BUILDROOT` 并忽略该定义，
# 构建会以 "File not found" 失败（Fedora 41+、Fedora 44 的 rpm 6 均命中）。
#
# 用法：
#   1) 构建入口：sh scripts/rpmbuild-container.sh <命令...>
#      临时创建名为 rpmbuild 的软链并前置到 PATH，再执行给定命令。
#   2) 被 fpm 调用：通过上面的软链以 rpmbuild 身份执行。
#      主机 rpm < 4.20 时直接转发给系统 rpmbuild，否则转发到容器内的 rpm 4.19。
#
# 可用环境变量：
#   ZTOOLS_RPMBUILD_IMAGE  覆盖容器镜像（默认 ztools-rpmbuild:40）

set -e

RPMBUILD_IMAGE="${ZTOOLS_RPMBUILD_IMAGE:-ztools-rpmbuild:40}"
CONTAINER_ENGINE=""

# 在候选路径中查找系统 rpmbuild，避免 command -v 命中本脚本自身造成递归调用。
find_host_rpmbuild() {
  for candidate in /usr/bin/rpmbuild /usr/local/bin/rpmbuild /opt/homebrew/bin/rpmbuild; do
    if [ -x "$candidate" ]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

# 判断给定 rpmbuild 是否仍遵循 fpm 依赖的 buildroot 定义语义（即 rpm < 4.20）。
host_rpmbuild_is_compatible() {
  rpmbuild_path="$1"
  version="$("$rpmbuild_path" --version 2>/dev/null | grep -oE '[0-9]+(\.[0-9]+)+' | head -n 1)"
  if [ -z "$version" ]; then
    return 1
  fi

  major="${version%%.*}"
  remainder="${version#*.}"
  minor="${remainder%%.*}"

  if [ "$major" -lt 4 ]; then
    return 0
  fi
  if [ "$major" -eq 4 ] && [ "$minor" -lt 20 ]; then
    return 0
  fi
  return 1
}

# 选择可用的容器引擎，docker 优先，其次 podman。
detect_container_engine() {
  if command -v docker >/dev/null 2>&1; then
    printf 'docker'
    return 0
  fi
  if command -v podman >/dev/null 2>&1; then
    printf 'podman'
    return 0
  fi
  return 1
}

# 镜像缺失时构建一个只带 rpmbuild 的最小镜像。
ensure_image() {
  engine="$1"
  if "$engine" image inspect "$RPMBUILD_IMAGE" >/dev/null 2>&1; then
    return 0
  fi

  echo "[rpmbuild-container] 镜像 $RPMBUILD_IMAGE 不存在，开始构建..." >&2
  "$engine" build -t "$RPMBUILD_IMAGE" - >/dev/null <<'DOCKERFILE'
FROM fedora:40
RUN dnf install -y rpm-build && dnf clean all
DOCKERFILE
}

# 以 rpmbuild 身份执行：优先用系统 rpmbuild，必要时转发到容器。
run_as_rpmbuild() {
  host_rpmbuild="$(find_host_rpmbuild || true)"
  if [ -n "$host_rpmbuild" ] && host_rpmbuild_is_compatible "$host_rpmbuild"; then
    exec "$host_rpmbuild" "$@"
  fi

  CONTAINER_ENGINE="$(detect_container_engine || true)"
  if [ -z "$CONTAINER_ENGINE" ]; then
    echo "[rpmbuild-container] 主机 rpmbuild 版本过旧或缺失，且未找到 docker/podman。" >&2
    echo "[rpmbuild-container] 请安装 docker 或 podman 后重试。" >&2
    exit 1
  fi

  ensure_image "$CONTAINER_ENGINE"

  # fpm 在 /tmp 下准备 spec 与 buildroot，容器需看到同一路径。
  exec "$CONTAINER_ENGINE" run --rm -i \
    --hostname ztools-build \
    --security-opt label=disable \
    --user "$(id -u):$(id -g)" \
    -e HOME=/tmp \
    -v /tmp:/tmp \
    "$RPMBUILD_IMAGE" rpmbuild "$@"
}

# 以入口身份执行：准备 rpmbuild 软链后执行给定命令。
run_as_launcher() {
  script_path="$(readlink -f "$0")"
  shim_dir="$(mktemp -d)"
  ln -s "$script_path" "$shim_dir/rpmbuild"

  # 退出时清理临时软链目录，不改变调用方的其余环境。
  status=0
  PATH="$shim_dir:$PATH" "$@" || status=$?
  rm -rf "$shim_dir"
  exit "$status"
}

case "$(basename "$0")" in
  rpmbuild)
    run_as_rpmbuild "$@"
    ;;
  *)
    run_as_launcher "$@"
    ;;
esac
