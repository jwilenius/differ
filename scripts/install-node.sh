#!/usr/bin/env bash
# Installs the Node.js version pinned in .node-version into <repo>/.node/, after checking the release's SHASUMS256.txt
# signature against the active Node.js release keyring (github.com/nodejs/release-keys, pinned commit and sha256) and
# the tarball's sha256 against it. Works in a temporary <repo>/.node.XXXXXX directory, which it removes.
# Usage: scripts/install-node.sh, then export PATH="$PWD/.node/bin:$PATH"
set -euo pipefail

# Update both together: a new release-keys commit changes the keyring's sha256.
readonly KEYRING_URL="https://raw.githubusercontent.com/nodejs/release-keys/481637f813e912c4aa3622d7964ab426c97b8e8d/gpg-only-active-keys/pubring.kbx"
readonly KEYRING_SHA256="140f2ad5260fd62773b6243ce8e1d3009645d558f121b8262c55e383dc285932"

fail() {
  echo "install-node: $*" >&2
  exit 1
}

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dest="$repo/.node"

version="$(tr -d '[:space:]' <"$repo/.node-version")"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail ".node-version must be X.Y.Z, got '$version'"

if [[ -x "$dest/bin/node" && "$("$dest/bin/node" --version)" == "v$version" ]]; then
  echo "install-node: Node.js v$version already installed in $dest"
  exit 0
fi

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) fail "unsupported OS $(uname -s)" ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) fail "unsupported architecture $(uname -m)" ;;
esac

if command -v sha256sum >/dev/null; then
  sha256_tool=(sha256sum)
else
  sha256_tool=(shasum -a 256)
fi
for tool in curl gpgv tar xz "${sha256_tool[0]}"; do
  command -v "$tool" >/dev/null || fail "required tool '$tool' not found on PATH"
done

sha256_of() {
  "${sha256_tool[@]}" "$1" | cut -d ' ' -f 1
}

download() {
  curl --proto '=https' --proto-redir '=https' --tlsv1.2 -fsSL -o "$work/$2" "$1"
}

tarball="node-v$version-$os-$arch.tar.xz"
dist_url="https://nodejs.org/dist/v$version"
# Inside the repository, so the final moves stay on one filesystem.
work="$(mktemp -d "$repo/.node.XXXXXX")"
# Restores the previous install if the swap below was interrupted between its two moves.
cleanup() {
  if [[ ! -e "$dest" && -e "$work/previous" ]]; then
    mv "$work/previous" "$dest"
  fi
  rm -rf "$work"
}
trap cleanup EXIT

download "$KEYRING_URL" nodejs-keyring.kbx
[[ "$(sha256_of "$work/nodejs-keyring.kbx")" == "$KEYRING_SHA256" ]] || fail "release keyring sha256 mismatch"
download "$dist_url/SHASUMS256.txt" SHASUMS256.txt
download "$dist_url/SHASUMS256.txt.sig" SHASUMS256.txt.sig
download "$dist_url/$tarball" "$tarball"

# A throwaway GNUPGHOME keeps gpgv away from the user's ~/.gnupg.
mkdir -m 700 "$work/gnupg"
GNUPGHOME="$work/gnupg" gpgv --keyring "$work/nodejs-keyring.kbx" \
  "$work/SHASUMS256.txt.sig" "$work/SHASUMS256.txt"

expected="$(awk -v name="$tarball" '$2 == name { print $1 }' "$work/SHASUMS256.txt")"
actual="$(sha256_of "$work/$tarball")"
[[ -n "$expected" && "$actual" == "$expected" ]] ||
  fail "sha256 mismatch for $tarball (expected '$expected', got '$actual')"

mkdir "$work/node"
tar -xf "$work/$tarball" -C "$work/node" --strip-components=1
# The old install moves aside rather than being deleted first, so cleanup can restore it.
if [[ -e "$dest" ]]; then
  mv "$dest" "$work/previous"
fi
mv "$work/node" "$dest"
echo "install-node: installed Node.js $("$dest/bin/node" --version) in $dest"
