#!/usr/bin/env bash
# Vomi / VO Manager 一键发布：本地权威源 → Git commit/push → CVM 部署 → 校验
# 用法：
#   bash release.sh "feat: 本次发布说明"
#   bash release.sh --dry-run
#   bash release.sh --include-new "feat: 同时纳入明确的新文件"
set -Eeuo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

# 让 Git Credential Manager 可在 WorkBuddy/无 TTY 终端里弹出浏览器授权。
export GIT_TERMINAL_PROMPT=1
export GCM_INTERACTIVE=always
unset GIT_ASKPASS SSH_ASKPASS

REMOTE_HOST="root@lycheelli-any1.devcloud.woa.com"
REMOTE_PORT="36000"
SSH_KEY="/c/Users/lycheelli/.ssh/codev_key_fixed"
REMOTE_DEPLOY_DIR="/root/deploy"
REMOTE_RUNNER="/tmp/vomi-remote-deploy.sh"
DRY_RUN=0
INCLUDE_NEW=0
MESSAGE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --include-new) INCLUDE_NEW=1; shift ;;
    -h|--help)
      sed -n '1,8p' "$0"
      exit 0
      ;;
    *) MESSAGE="${MESSAGE:+$MESSAGE }$1"; shift ;;
  esac
done
MESSAGE="${MESSAGE:-release: Vomi 同步 Git 与 CVM}"

SSH=(ssh -i "$SSH_KEY" -p "$REMOTE_PORT" -o StrictHostKeyChecking=no -o ConnectTimeout=25)
SCP=(scp -i "$SSH_KEY" -P "$REMOTE_PORT" -o StrictHostKeyChecking=no -o ConnectTimeout=25)
CANONICAL_PAGES=(
  vo-manager-refined.html
  preview-需求汇总-精修版.html
  preview-声优库-精修版.html
  preview-录制档期-精修版.html
  preview-版本节点-精修版.html
  preview-AI助手-精修版.html
)

die(){ echo "✗ $*" >&2; exit 1; }
step(){ echo; echo "════════════════════════════════════════════════════"; echo "▶ $*"; }

trap 'echo; echo "✗ 发布失败（第 $LINENO 行）。Git 未 push 成功时不会触碰服务器；服务器阶段失败时可用 /root/deploy/backups/release_* 回滚。" >&2' ERR

step "预检"
[[ -d .git ]] || die "当前目录不是 Git 仓库：$PROJECT_DIR"
[[ -f "$SSH_KEY" ]] || die "SSH key 不存在：$SSH_KEY"
for cmd in git ssh scp tar sha256sum; do command -v "$cmd" >/dev/null || die "缺少命令：$cmd"; done
[[ "$(git branch --show-current)" == "master" ]] || die "请在 master 分支发布"
[[ -f release/remote-deploy.sh ]] || die "缺少 release/remote-deploy.sh"
bash -n release.sh
bash -n release/remote-deploy.sh
# 阻止冲突标记混入发布；仅检查真正的 Git 冲突头/尾。
if grep -R -n -E '^(<<<<<<< |>>>>>>> )' -- \
  deploy/backend deploy/frontend *.html 2>/dev/null | head -1 | grep -q .; then
  die "发现未解决的 Git 冲突标记"
fi
NODE_BIN="$(command -v node || true)"
[[ -z "$NODE_BIN" && -x /c/Users/lycheelli/.workbuddy/binaries/node/versions/22.22.2/node.exe ]] \
  && NODE_BIN=/c/Users/lycheelli/.workbuddy/binaries/node/versions/22.22.2/node.exe
if [[ -n "$NODE_BIN" ]]; then
  while IFS= read -r js; do "$NODE_BIN" --check "$js" >/dev/null; done < <(find deploy/backend/src -maxdepth 1 -name '*.js' -type f | sort)
  echo "  ✓ 后端 JavaScript 语法通过"
fi

step "校验 GitHub 基线"
command -v gh >/dev/null || die "缺少 GitHub CLI（gh），请先安装"
if ! gh auth status >/dev/null 2>&1; then
  echo "首次使用需要 GitHub 授权，按终端提示在浏览器完成一次登录。"
  gh auth login --hostname github.com --git-protocol https --web
fi
gh auth setup-git >/dev/null
git fetch origin master
REMOTE_HEAD="$(git ls-remote origin refs/heads/master | cut -f1)"
[[ -n "$REMOTE_HEAD" ]] || die "无法读取 GitHub master"
if ! git merge-base --is-ancestor "$REMOTE_HEAD" HEAD; then
  if git merge-base --is-ancestor HEAD "$REMOTE_HEAD"; then
    die "本地落后 GitHub master，请先拉取并合并"
  fi
  die "本地 master 与 GitHub master 已分叉，请先解决合并；脚本不会强推"
fi
echo "  ✓ GitHub 基线可快进：${REMOTE_HEAD:0:7} → $(git rev-parse --short HEAD)"

# 根目录页面是设计/编辑权威源；deploy/frontend 是部署副本。
step "同步 6 个本地权威页面到 deploy/frontend"
for page in "${CANONICAL_PAGES[@]}"; do
  [[ -f "$page" ]] || die "缺少权威页面：$page"
  mkdir -p deploy/frontend
  if ! cmp -s "$page" "deploy/frontend/$page"; then
    cp "$page" "deploy/frontend/$page"
    echo "  ✓ 已同步 $page"
  else
    echo "  = 已一致 $page"
  fi
done

# 只有 iframe 子页实际变更时才 bump 缓存版本，避免 dry-run/空发布制造无意义提交。
SUBPAGES_CHANGED=0
for page in "${CANONICAL_PAGES[@]:1}"; do
  if ! git diff --quiet -- "$page" "deploy/frontend/$page" || ! git diff --cached --quiet -- "$page" "deploy/frontend/$page"; then
    SUBPAGES_CHANGED=1
    break
  fi
done
if [[ $SUBPAGES_CHANGED -eq 1 ]]; then
  BUILD="$(date +%Y%m%d%H%M)"
  for shell in vo-manager-refined.html deploy/frontend/vo-manager-refined.html; do
    sed -E -i "s/const __BUILD__ = '[^']+';/const __BUILD__ = '${BUILD}';/" "$shell"
  done
  echo "  ✓ 子页有改动，__BUILD__=${BUILD}"
else
  echo "  = 子页无改动，不 bump __BUILD__"
fi

step "检查未跟踪文件"
UNTRACKED="$(git ls-files --others --exclude-standard)"
if [[ -n "$UNTRACKED" && $INCLUDE_NEW -eq 0 ]]; then
  echo "以下新文件默认不会提交（符合 tracked-only 策略）："
  printf '  ? %s\n' $UNTRACKED
  echo "如这些是正式文件，请重新执行：bash release.sh --include-new \"$MESSAGE\""
fi

step "准备 Git 提交"
if [[ $INCLUDE_NEW -eq 1 ]]; then git add -A; else git add -u; fi
if git diff --cached --quiet; then
  echo "  没有新的 tracked 改动，沿用 HEAD=$(git rev-parse --short HEAD)"
else
  git commit -m "$MESSAGE"
fi
COMMIT="$(git rev-parse --short HEAD)"
echo "  ✓ COMMIT=$COMMIT"

if [[ $DRY_RUN -eq 1 ]]; then
  step "DRY RUN 完成"
  echo "将执行：git push origin master → 从 Git HEAD 打包 deploy/ → CVM 备份/部署 → 后端重建 → nginx 重启 → SHA256+HTTP 校验"
  exit 0
fi

step "推送 GitHub（失败即停止，不部署服务器）"
# 认证由前置 gh auth 保证；禁止 force push，远端分叉会在预检阶段直接停止。
git push origin master
REMOTE_HEAD="$(git ls-remote origin refs/heads/master | cut -f1)"
LOCAL_HEAD="$(git rev-parse HEAD)"
[[ "$REMOTE_HEAD" == "$LOCAL_HEAD" ]] || die "GitHub master 与本地 HEAD 不一致"
echo "  ✓ GitHub master=$COMMIT"

step "从 Git HEAD 制作部署包（不是直接拷贝工作区）"
TMPDIR="$PROJECT_DIR/.workbuddy/release-tmp/${COMMIT}-$$"
mkdir -p "$TMPDIR"
ARCHIVE="$TMPDIR/vomi-${COMMIT}.tar.gz"
MANIFEST="$TMPDIR/vomi-${COMMIT}.sha256"
git archive --format=tar.gz --output="$ARCHIVE" HEAD deploy
# manifest 直接对 Git HEAD 的 blob 计算，避免工作区路径/换行转换影响，也不依赖管道退出码。
: > "$MANIFEST"
while IFS= read -r f; do
  hash="$(git show "HEAD:$f" | sha256sum | cut -d' ' -f1)"
  printf '%s  %s\n' "$hash" "$f" >> "$MANIFEST"
done < <(git ls-tree -r --name-only HEAD deploy)
[[ -s "$ARCHIVE" && -s "$MANIFEST" ]] || die "部署包或校验清单为空"
echo "  ✓ archive=$(du -h "$ARCHIVE" | cut -f1), manifest=$(wc -l < "$MANIFEST") files"

step "上传并部署 CVM"
REMOTE_ARCHIVE="/tmp/vomi-${COMMIT}.tar.gz"
REMOTE_MANIFEST="/tmp/vomi-${COMMIT}.sha256"
"${SCP[@]}" "$ARCHIVE" "$REMOTE_HOST:$REMOTE_ARCHIVE"
"${SCP[@]}" "$MANIFEST" "$REMOTE_HOST:$REMOTE_MANIFEST"
"${SCP[@]}" release/remote-deploy.sh "$REMOTE_HOST:$REMOTE_RUNNER"
"${SSH[@]}" "$REMOTE_HOST" "bash '$REMOTE_RUNNER' '$REMOTE_ARCHIVE' '$REMOTE_MANIFEST' '$COMMIT'"
rm -rf "$TMPDIR"

step "发布完成"
echo "✓ GitHub: origin/master @ $COMMIT"
echo "✓ CVM:     http://21.130.252.59"
echo "✓ 备份:    /root/deploy/backups/release_${COMMIT}_*"
