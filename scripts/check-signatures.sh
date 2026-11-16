#!/usr/bin/env bash
# Runs the registry signature check (npm run check:signatures) against the default registry, registry.npmjs.org, and
# retries it once against registry.npmjs.com only when npm fails with EMISSINGSIGNATUREKEY: a Cloudflare edge of .org
# can serve a stale attestation document, cached right after publish, that holds the provenance but not npm's publish
# attestation, and anycast routing gives no way to avoid that edge. registry.npmjs.com is npm's alias for the same
# registry and Cloudflare does not cache it, so no stale edge copy can reach the retry. The alias is undocumented; if it
# ever stops working, the retry fails like the first attempt and the job fails, so nothing is weakened. The retry first
# clears npm's HTTP cache. Any other failure, and a missing key on the retry, ends the script with npm's exit status.
# Both attempts check with --prefer-online.
# Usage: scripts/check-signatures.sh   (from the repository root, after npm ci)
set -uo pipefail

readonly uncached_registry=https://registry.npmjs.com

output="$(mktemp)"
trap 'rm -f "$output"' EXIT

npm run check:signatures -- --prefer-online 2>&1 | tee "$output"
status=${PIPESTATUS[0]}
((status == 0)) && exit 0
grep -q 'code EMISSINGSIGNATUREKEY' "$output" || exit "$status"

# E.g. "npm error postcss@8.5.32 has attestations but no corresponding public key(s) can be found".
packages=$(sed -nE 's/.* (@?[^@ ]+@[^ ]+) has attestations but no corresponding .*/\1/p' "$output" | paste -sd ' ')
echo "::warning::Signature check found no public key for ${packages:-an unnamed package}, likely a stale registry CDN edge; clearing npm's cache and retrying against $uncached_registry."
npm cache clean --force
npm run check:signatures -- --registry="$uncached_registry" --prefer-online
