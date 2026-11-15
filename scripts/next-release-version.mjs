#!/usr/bin/env node
// Decides the next release version from the Conventional Commit messages (https://www.conventionalcommits.org/en/v1.0.0/)
// since the last release: `feat` asks for a minor bump, `fix` for a patch bump, and `<type>!:` or a `BREAKING CHANGE:`
// or `BREAKING-CHANGE:` footer on any type for a major bump; the highest bump wins. Other types and messages whose
// header does not follow the format never release.
// The last release is the highest vX.Y.Z tag reachable from HEAD. Without one, the package.json version counts as the
// last release and every commit is scanned. With one, package.json must hold its version: only releases change it.
// Usage: node scripts/next-release-version.mjs [repo-dir]   (defaults to the current directory)
// Prints the next version, such as 0.4.0, on stdout, or nothing when no commit asks for a release; says why on stderr.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Bumps from lowest to highest. */
const BUMPS = ["none", "patch", "minor", "major"];
// A Map, not an object literal, so a type such as `constructor` cannot match an inherited property.
const BUMP_BY_TYPE = new Map([
  ["feat", "minor"],
  ["fix", "patch"],
]);
const HEADER = /^(?<type>[A-Za-z]+)(?:\([^()]*\))?(?<breaking>!)?: \S/;
const BREAKING_FOOTER = /^BREAKING[ -]CHANGE: /;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const TAG_PREFIX = "v";
const GIT_OUTPUT_LIMIT = 64 * 1024 * 1024;

const isCommandLine = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCommandLine) {
  const release = findNextRelease(process.argv[2] ?? ".");
  console.error(describeRelease(release));
  if (release.version !== "") console.log(release.version);
}

/** The bump one commit message asks for; only its first line names the type, so body lines that look like headers do not count. */
export function commitBump(message) {
  const [header, ...bodyLines] = message.split(/\r?\n/);
  const match = HEADER.exec(header);
  if (!match) return "none";

  const hasBreakingFooter = bodyLines.some((line) => BREAKING_FOOTER.test(line));
  if (match.groups.breaking || hasBreakingFooter) return "major";
  return BUMP_BY_TYPE.get(match.groups.type.toLowerCase()) ?? "none";
}

/** The highest bump any of the messages asks for; "none" for no messages. */
export function releaseBump(messages) {
  return messages
    .map(commitBump)
    .reduce((highest, bump) => (BUMPS.indexOf(bump) > BUMPS.indexOf(highest) ? bump : highest), "none");
}

/** `version` raised by `bump`; empty for "none". Throws when `version` is not plain X.Y.Z. */
export function bumpVersion(version, bump) {
  const [major, minor, patch] = parseVersion(version);
  switch (bump) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
    default:
      return "";
  }
}

/**
 * Reads the last release and the commits since it in `repoDir`; `version` is empty when nothing asks for a release.
 * Throws when package.json does not hold the last release tag's version, since only releases may change it.
 */
function findNextRelease(repoDir) {
  const lastTag = lastReleaseTag(repoDir);
  const currentVersion = packageVersion(repoDir);
  const baseVersion = lastTag === "" ? currentVersion : lastTag.slice(TAG_PREFIX.length);
  if (currentVersion !== baseVersion) {
    throw new Error(`package.json version ${currentVersion} differs from the last release tag ${lastTag}.`);
  }

  const messages = commitMessages(repoDir, lastTag === "" ? "HEAD" : `${lastTag}..HEAD`);
  const bump = releaseBump(messages);
  return { lastTag, baseVersion, commitCount: messages.length, bump, version: bumpVersion(baseVersion, bump) };
}

function describeRelease({ lastTag, baseVersion, commitCount, bump, version }) {
  const base = lastTag === "" ? `package.json version ${baseVersion} (no release tag)` : lastTag;
  if (version === "") {
    return `No release: none of the ${commitCount} commits since ${base} is a feat, fix or breaking change.`;
  }
  return `Next release ${TAG_PREFIX}${version}: ${bump} bump over ${base} from ${commitCount} commits.`;
}

/** The highest vX.Y.Z tag reachable from HEAD, or empty; tags such as `v1.0.0-rc.1` or `vnext` are not releases. */
function lastReleaseTag(repoDir) {
  const releaseTags = git(repoDir, "tag", "--list", `${TAG_PREFIX}*`, "--merged", "HEAD")
    .split("\n")
    .filter((tag) => VERSION.test(tag.slice(TAG_PREFIX.length)));
  const newestFirst = releaseTags.sort((left, right) =>
    compareVersions(right.slice(TAG_PREFIX.length), left.slice(TAG_PREFIX.length))
  );
  return newestFirst[0] ?? "";
}

/** Full messages of the commits in `range`, merge commits and the commits they merged included. */
function commitMessages(repoDir, range) {
  return git(repoDir, "log", "-z", "--format=%B", range)
    .split("\0")
    .filter((message) => message !== "");
}

function packageVersion(repoDir) {
  return JSON.parse(readFileSync(join(repoDir, "package.json"), "utf8")).version;
}

function compareVersions(left, right) {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  const differingIndex = leftParts.findIndex((part, index) => part !== rightParts[index]);
  return differingIndex === -1 ? 0 : leftParts[differingIndex] - rightParts[differingIndex];
}

function parseVersion(version) {
  const match = VERSION.exec(version);
  if (!match) throw new Error(`Version "${version}" is not plain X.Y.Z.`);

  return match.slice(1).map(Number);
}

function git(repoDir, ...args) {
  return execFileSync("git", args, { cwd: repoDir, encoding: "utf8", maxBuffer: GIT_OUTPUT_LIMIT }).trim();
}
