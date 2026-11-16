#!/usr/bin/env bash
# Promotes GitHub Release vX.Y.Z to the VS Code Marketplace: after checking that the release and its installer exist and
# that the version is newer than every earlier promotion, creates annotated tag vscode-vX.Y.Z on the release commit and
# pushes only that tag. The push starts .github/workflows/publish-marketplace.yml, which publishes the release's VSIX.
# Usage: scripts/publish-marketplace.sh <X.Y.Z | vX.Y.Z>   (needs git with remote origin and an authenticated gh)
set -euo pipefail

readonly REPO="jwilenius/differ"
readonly ACTIONS_URL="https://github.com/$REPO/actions/workflows/publish-marketplace.yml"
readonly VERSION_PATTERN='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'

fail() {
  echo "publish-marketplace: $*" >&2
  exit 1
}

# Whether plain X.Y.Z version $1 is higher than $2.
version_greater() {
  local -a left right
  local i
  IFS=. read -r -a left <<<"$1"
  IFS=. read -r -a right <<<"$2"
  for i in 0 1 2; do
    ((left[i] > right[i])) && return 0
    ((left[i] < right[i])) && return 1
  done
  return 1
}

[[ $# -eq 1 ]] || fail "usage: scripts/publish-marketplace.sh <X.Y.Z | vX.Y.Z>"
version="${1#v}"
[[ "$version" =~ $VERSION_PATTERN ]] || fail "version must be X.Y.Z or vX.Y.Z, got '$1'"
release_tag="v$version"
marketplace_tag="vscode-v$version"
installer="jw-differ-$version.vsix"

command -v gh >/dev/null || fail "GitHub CLI 'gh' not found on PATH"
gh auth status >/dev/null 2>&1 || fail "gh is not authenticated; run 'gh auth login'"

# Fails rather than overwrite a local tag that differs from origin's, so the local tags below match origin's.
git fetch --quiet --tags origin ||
  fail "fetching tags from origin failed; a local tag that differs from origin's is never overwritten"
remote_tags="$(git ls-remote --tags --refs origin | cut -f 2)"

grep -Fxq "refs/tags/$release_tag" <<<"$remote_tags" || fail "release tag $release_tag not found on origin"
release_commit="$(git rev-parse "refs/tags/$release_tag^{commit}")"

if git rev-parse --quiet --verify "refs/tags/$marketplace_tag" >/dev/null ||
  grep -Fxq "refs/tags/$marketplace_tag" <<<"$remote_tags"; then
  fail "tag $marketplace_tag already exists"
fi

# The Marketplace accepts only versions above the latest one published.
while read -r tag; do
  published="${tag#refs/tags/vscode-v}"
  [[ "$published" =~ $VERSION_PATTERN ]] || continue
  version_greater "$version" "$published" ||
    fail "version $version is not higher than already promoted $published"
done < <(grep '^refs/tags/vscode-v' <<<"$remote_tags" || true)

assets="$(gh release view "$release_tag" --repo "$REPO" --json assets --jq '.assets[].name')" ||
  fail "cannot read GitHub Release $release_tag"
grep -Fxq "$installer" <<<"$assets" || fail "GitHub Release $release_tag has no asset $installer"

git tag -a "$marketplace_tag" -m "Publish $release_tag to the VS Code Marketplace" "$release_commit"
if ! git push origin "refs/tags/$marketplace_tag"; then
  git tag -d "$marketplace_tag" >/dev/null
  fail "push of $marketplace_tag failed; local tag removed"
fi
echo "publish-marketplace: pushed $marketplace_tag on $release_commit; follow the run at $ACTIONS_URL"
