#!/usr/bin/env bash
# Runs the registry signature check (npm run check:signatures) and retries it only when npm fails with
# EMISSINGSIGNATUREKEY: a registry CDN edge can serve a stale attestation document, cached right after publish, that
# holds the provenance but not npm's publish attestation, while other edges and later requests serve it complete. Each
# retry first clears npm's HTTP cache, which would otherwise return the same stale document. Any other failure, and the
# last missing-key failure, ends the script with npm's exit status. Every attempt checks with --prefer-online.
# Usage: scripts/check-signatures.sh   (from the repository root, after npm ci)
set -uo pipefail

# Pauses before each retry: 3.5 minutes in all, within every calling job's timeout, and growing so that later attempts
# give a stale edge more time to revalidate. CHECK_SIGNATURES_RETRY_DELAYS overrides them for tests only.
read -r -a retry_delays <<<"${CHECK_SIGNATURES_RETRY_DELAYS:-30 60 120}"
readonly retry_delays
readonly attempts=$((${#retry_delays[@]} + 1))

output="$(mktemp)"
trap 'rm -f "$output"' EXIT

for ((attempt = 1; ; attempt++)); do
  npm run check:signatures -- --prefer-online 2>&1 | tee "$output"
  status=${PIPESTATUS[0]}
  ((status == 0)) && exit 0
  grep -q 'code EMISSINGSIGNATUREKEY' "$output" || exit "$status"
  ((attempt < attempts)) || exit "$status"

  # E.g. "npm error postcss@8.5.32 has attestations but no corresponding public key(s) can be found".
  packages=$(sed -nE 's/.* (@?[^@ ]+@[^ ]+) has attestations but no corresponding .*/\1/p' "$output" | paste -sd ' ')
  delay=${retry_delays[attempt - 1]}
  echo "::warning::Signature check attempt $attempt of $attempts found no public key for ${packages:-an unnamed package}; clearing npm's cache and retrying in ${delay}s."
  npm cache clean --force
  sleep "$delay"
done
