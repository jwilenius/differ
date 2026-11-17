#!/usr/bin/env node
// Prints each high or critical npm audit advisory in package-lock.json as a GitHub `::warning::` annotation, without
// failing. `npm run check:deps` runs it after the blocking production audit (`npm audit --omit=dev`), so what it
// reports is in development tools only: they run in CI but are not bundled into the VSIX, so an ordinary vulnerability
// in them cannot reach users. Malware and tampering in them still block, through the OSV malware and registry signature
// checks. Fails when npm audit itself fails, such as on a registry or network error, so a broken audit never reads as
// a clean one.
// Usage: node scripts/warn-dev-advisories.mjs [project-dir]   (defaults to the current directory)
import { spawnSync } from "node:child_process";

// --include=dev keeps dev tools in the audit even where NODE_ENV=production or an npmrc omits them.
const AUDIT_ARGS = ["audit", "--json", "--include=dev", "--audit-level=high"];
const AUDIT_OUTPUT_LIMIT = 64 * 1024 * 1024;
const WARNED_SEVERITIES = new Set(["high", "critical"]);

const projectDir = process.argv[2] ?? ".";
const audit = spawnSync("npm", AUDIT_ARGS, { cwd: projectDir, encoding: "utf8", maxBuffer: AUDIT_OUTPUT_LIMIT });
const report = parseReport(audit.stdout);
if (report === undefined) failAudit(audit, "npm audit returned no vulnerability report.");

const advisories = warnedAdvisories(report);
// npm exits non-zero exactly when the report holds a high or critical advisory; any other mismatch is its own failure.
const isStatusExplained = (audit.status === 0) === (advisories.length === 0);
if (!isStatusExplained) failAudit(audit, `npm audit exited ${audit.status} with ${advisories.length} high advisories.`);

console.log(`npm audit: ${advisories.length} high or critical advisories in development tools, which are not shipped.`);
for (const { name, title, severity, range, url } of advisories) {
  const message = `${name}: ${title} (${severity}, ${range}) ${url}`;
  console.log(`::warning title=Dev tool advisory (not shipped)::${escapeAnnotation(message)}`);
}

/** The parsed `npm audit --json` report, or `undefined` when npm printed an error or no JSON. */
function parseReport(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    return parsed.vulnerabilities === undefined ? undefined : parsed;
  } catch {
    return undefined;
  }
}

/** Unique high and critical advisories; `via` holds an advisory object where the package itself is vulnerable. */
function warnedAdvisories(auditReport) {
  const byUrl = new Map();
  for (const vulnerability of Object.values(auditReport.vulnerabilities)) {
    for (const via of vulnerability.via) {
      const isWarnedAdvisory = typeof via === "object" && WARNED_SEVERITIES.has(via.severity);
      if (isWarnedAdvisory) byUrl.set(via.url, via);
    }
  }
  return [...byUrl.values()];
}

/** Escapes registry text so a line break in it cannot start another workflow command. */
function escapeAnnotation(text) {
  return text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

function failAudit(result, reason) {
  process.stderr.write(result.stderr ?? "");
  process.stderr.write(result.stdout ?? "");
  if (result.error) console.error(result.error.message);
  console.error(reason);
  process.exit(1);
}
