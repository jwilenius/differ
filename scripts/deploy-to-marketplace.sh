#!/usr/bin/env bash
# Releases main and publishes it to the VS Code Marketplace in one go: pushes main when the push makes a release, waits
# for .github/workflows/build-vsix.yml to commit and tag release vX.Y.Z, pulls that release commit, promotes it with
# scripts/publish-marketplace.sh and waits for .github/workflows/publish-marketplace.yml to publish it.
# Resumes after an interruption: with main already pushed it waits for the pending release of HEAD, pulls a release
# commit that is not yet local, and promotes or keeps watching the newest release reachable from HEAD until it is on
# the Marketplace.
# Usage: scripts/deploy-to-marketplace.sh [--yes]   (--yes pushes without asking; needs git, node and an authenticated gh)
set -euo pipefail

readonly REPO="jwilenius/differ"
readonly MARKETPLACE_URL="https://marketplace.visualstudio.com/items?itemName=jwilenius.jw-differ"
readonly VERSION_PATTERN='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
readonly RELEASE_SUBJECT_PATTERN='^chore: release v((0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*))$'
readonly RUN_APPEAR_TIMEOUT_SECONDS=120
readonly RUN_POLL_SECONDS=5

fail() {
  echo "deploy-to-marketplace: $*" >&2
  exit 1
}

say() {
  echo "deploy-to-marketplace: $*"
}

check_preconditions() {
  command -v node >/dev/null || fail "node not found on PATH"
  command -v gh >/dev/null || fail "GitHub CLI 'gh' not found on PATH"
  gh auth status >/dev/null 2>&1 || fail "gh is not authenticated; run 'gh auth login'"

  local branch
  branch="$(git symbolic-ref --quiet --short HEAD)" || fail "HEAD is detached; check out main"
  [[ "$branch" == main ]] || fail "on branch '$branch'; check out main"
  [[ -z "$(git status --porcelain)" ]] || fail "working tree is not clean; commit or remove the changes first"
}

# The version that pushing HEAD releases, or empty; next-release-version.mjs explains its decision on stderr.
next_release_version() {
  local version
  version="$(node scripts/next-release-version.mjs)" || fail "scripts/next-release-version.mjs failed"
  echo "$version"
}

# The version of release vX.Y.Z when HEAD is its release commit, or empty.
head_release_version() {
  local subject version tag_commit
  subject="$(git log -1 --format=%s)"
  [[ "$subject" =~ $RELEASE_SUBJECT_PATTERN ]] || return 0
  version="${BASH_REMATCH[1]}"
  tag_commit="$(git rev-parse --quiet --verify "refs/tags/v$version^{commit}")" || return 0
  [[ "$tag_commit" == "$(git rev-parse HEAD)" ]] && echo "$version"
  return 0
}

# The version of the highest release tag vX.Y.Z reachable from HEAD, or empty.
latest_release_version() {
  local tag
  while read -r tag; do
    if [[ "${tag#v}" =~ $VERSION_PATTERN ]]; then
      echo "${tag#v}"
      return 0
    fi
  done < <(git tag --list 'v*' --merged HEAD --sort=-version:refname)
}

# Asks before pushing unless --yes was given; any answer but y or yes stops without pushing.
confirm_push() {
  local version="$1" answer=""
  [[ "$assume_yes" == true ]] && return 0
  read -r -p "Push to origin/main and release v$version? [y/N] " answer || true
  [[ "$answer" =~ ^([yY]|[yY][eE][sS])$ ]] || fail "stopped; nothing pushed"
}

push_main() {
  local version="$1"
  say "commits to push:"
  git log --oneline origin/main..main
  confirm_push "$version"
  git push origin main || fail "push of main failed"
}

# Polls until workflow $1 has a run matching the gh run list filters that follow and prints the newest one's id.
find_run() {
  local workflow="$1" run_id waited=0
  shift
  while true; do
    run_id="$(gh run list --repo "$REPO" --workflow "$workflow" "$@" --limit 1 \
      --json databaseId --jq '.[0].databaseId // empty')" || fail "cannot list $workflow runs"
    [[ -n "$run_id" ]] && break
    ((waited < RUN_APPEAR_TIMEOUT_SECONDS)) ||
      fail "no $workflow run for $* after ${RUN_APPEAR_TIMEOUT_SECONDS}s ([skip ci] in a pushed head commit starts" \
        "no build run); see https://github.com/$REPO/actions"
    sleep "$RUN_POLL_SECONDS"
    waited=$((waited + RUN_POLL_SECONDS))
  done
  echo "$run_id"
}

watch_run() {
  local run_id="$1" run_url="https://github.com/$REPO/actions/runs/$1"
  say "watching $run_url"
  gh run watch "$run_id" --repo "$REPO" --exit-status --compact || fail "run failed or could not be watched: $run_url"
}

run_succeeded() {
  local conclusion
  conclusion="$(gh run view "$1" --repo "$REPO" --json conclusion --jq .conclusion)" || fail "cannot read run $1"
  [[ "$conclusion" == success ]]
}

# Waits for the build-vsix run of HEAD, then pulls its release commit and checks it is release v$1.
await_release() {
  local version="$1" head_commit run_id
  head_commit="$(git rev-parse HEAD)"
  say "waiting for the build-vsix.yml run of $head_commit"
  run_id="$(find_run build-vsix.yml --branch main --commit "$head_commit")"
  watch_run "$run_id"

  git pull --ff-only --quiet origin main || fail "git pull --ff-only failed"
  git fetch --quiet --tags origin || fail "fetching tags from origin failed"
  [[ "$(head_release_version)" == "$version" ]] ||
    fail "HEAD is not release commit 'chore: release v$version' with tag v$version: $(git log -1 --oneline);" \
      "once origin has tag v$version, promote it with scripts/publish-marketplace.sh $version or rerun this script"
}

# Publishes release v$1 unless its vscode-vX.Y.Z tag is already pushed, then waits for that tag's run.
promote() {
  local version="$1" marketplace_tag="vscode-v$1" run_id
  if [[ -z "$(git ls-remote --tags --refs origin "refs/tags/$marketplace_tag")" ]]; then
    say "promoting v$version; GitHub may report 'Bypassed rule violations' for the tag push, which is harmless"
    scripts/publish-marketplace.sh "$version"
    run_id="$(find_run publish-marketplace.yml --branch "$marketplace_tag")"
  else
    run_id="$(find_run publish-marketplace.yml --branch "$marketplace_tag")"
    if run_succeeded "$run_id"; then
      say "v$version is already on the Marketplace; nothing to do"
      return 0
    fi
    say "$marketplace_tag is already pushed; following its run"
  fi
  watch_run "$run_id"
  say "published v$version: $MARKETPLACE_URL"
}

assume_yes=false
case "${1-}" in
  "") ;;
  --yes) assume_yes=true ;;
  *) fail "usage: scripts/deploy-to-marketplace.sh [--yes]" ;;
esac
[[ $# -le 1 ]] || fail "usage: scripts/deploy-to-marketplace.sh [--yes]"

cd "$(dirname "$0")/.."
check_preconditions

# Fails rather than overwrite a local tag that differs from origin's.
git fetch --quiet --tags origin || fail "fetching from origin failed"
counts="$(git rev-list --left-right --count main...origin/main)" || fail "cannot compare main with origin/main"
read -r ahead behind <<<"$counts"
((ahead == 0 || behind == 0)) || fail "main and origin/main have diverged; rebase main onto origin/main first"
if ((behind > 0)); then
  say "pulling new commits from origin/main"
  git pull --ff-only --quiet origin main || fail "git pull --ff-only failed"
fi

version="$(next_release_version)"
if ((ahead > 0)); then
  [[ -n "$version" ]] ||
    fail "HEAD would not make a release (no feat, fix or breaking commit since the last release); use git push instead"
  push_main "$version"
  await_release "$version"
elif [[ -n "$version" ]]; then
  say "main is already pushed; release v$version is pending"
  await_release "$version"
else
  version="$(latest_release_version)"
  if [[ -z "$version" ]]; then
    say "nothing to push and no release yet; nothing to do"
    exit 0
  fi
fi
promote "$version"
