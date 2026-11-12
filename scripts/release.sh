#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ $# -ne 1 || ! "$1" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
  echo 'Usage: npm run release -- <version> (for example, 0.1.1)' >&2
  exit 1
fi

version="$1"
tag="v$version"

if [[ "$(git branch --show-current)" != main || -n "$(git status --porcelain)" ]]; then
  echo 'Release requires a clean working tree on main. Commit and push your changes first.' >&2
  exit 1
fi

git fetch origin main --tags
if [[ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]]; then
  echo 'Local main must match origin/main. Synchronize the branch before releasing.' >&2
  exit 1
fi
if git show-ref --verify --quiet "refs/tags/$tag"; then
  echo "Tag $tag already exists." >&2
  exit 1
fi

node - "$version" <<'NODE'
const current = require('./package.json').version.split('.').map(BigInt);
const next = process.argv[2].split('.').map(BigInt);
const changed = next.findIndex((value, index) => value !== current[index]);
if (changed === -1 || next[changed] < current[changed]) {
  console.error('Release version must be greater than the current package version.');
  process.exit(1);
}
NODE

npm ci
npm run typecheck
npm test
npm version "$version" --no-git-tag-version
npm run package
git add package.json package-lock.json
git commit -m "chore: release $tag"
git tag -a "$tag" -m "Release $tag"
# Publish the commit and tag together; neither remote ref changes if either fails.
git push --atomic origin main "refs/tags/$tag"

echo "Pushed $tag. GitHub Actions will publish the VSIX under Releases."
