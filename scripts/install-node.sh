#!/usr/bin/env bash
# Installs the Node.js version pinned in .node-version into <repo>/.node/, after checking the release's SHASUMS256.txt
# signature against the Node.js release keyring (github.com/nodejs/release-keys) and the tarball's sha256 against it.
# Touches nothing outside the repository except a temporary directory, which it removes.
# Usage: scripts/install-node.sh, then export PATH="$PWD/.node/bin:$PATH"
set -euo pipefail

readonly KEYRING_URL="https://github.com/nodejs/release-keys/raw/HEAD/gpg/pubring.kbx"

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dest="$repo/.node"
staging="$repo/.node.partial"

version="$(tr -d '[:space:]' <"$repo/.node-version")"
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "install-node: .node-version must be X.Y.Z, got '$version'" >&2
  exit 1
fi

if [[ -x "$dest/bin/node" && "$("$dest/bin/node" --version)" == "v$version" ]]; then
  echo "install-node: Node.js v$version already installed in $dest"
  exit 0
fi

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) echo "install-node: unsupported OS $(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) echo "install-node: unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac

tarball="node-v$version-$os-$arch.tar.xz"
dist_url="https://nodejs.org/dist/v$version"
work="$(mktemp -d "${TMPDIR:-/tmp}/install-node.XXXXXX")"
trap 'rm -rf "$work" "$staging"' EXIT

download() {
  curl --proto '=https' --tlsv1.2 -fsSL -o "$work/$2" "$1"
}

download "$KEYRING_URL" nodejs-keyring.kbx
download "$dist_url/SHASUMS256.txt" SHASUMS256.txt
download "$dist_url/SHASUMS256.txt.sig" SHASUMS256.txt.sig
download "$dist_url/$tarball" "$tarball"

# A throwaway GNUPGHOME keeps gpgv away from the user's ~/.gnupg.
mkdir -m 700 "$work/gnupg"
GNUPGHOME="$work/gnupg" gpgv --keyring "$work/nodejs-keyring.kbx" \
  "$work/SHASUMS256.txt.sig" "$work/SHASUMS256.txt"

expected="$(awk -v name="$tarball" '$2 == name { print $1 }' "$work/SHASUMS256.txt")"
if command -v sha256sum >/dev/null; then
  actual="$(sha256sum "$work/$tarball" | cut -d ' ' -f 1)"
else
  actual="$(shasum -a 256 "$work/$tarball" | cut -d ' ' -f 1)"
fi
if [[ -z "$expected" || "$actual" != "$expected" ]]; then
  echo "install-node: sha256 mismatch for $tarball (expected '$expected', got '$actual')" >&2
  exit 1
fi

rm -rf "$staging"
mkdir "$staging"
tar -xf "$work/$tarball" -C "$staging" --strip-components=1
rm -rf "$dest"
mv "$staging" "$dest"
echo "install-node: installed Node.js $("$dest/bin/node" --version) in $dest"
