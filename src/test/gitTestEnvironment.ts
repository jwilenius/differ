import * as path from "node:path";

/**
 * Vitest setup file: every Git a test starts, directly, through a fixture or script, or in the code under test, reads
 * `fixtures/gitconfig` instead of the machine's configuration, so neither a CI runner's `safe.directory = *` nor a
 * developer's default branch, line-ending conversion or commit signing changes results. `GIT_*` variables inherited
 * from the shell, such as `GIT_DIR` when tests run from a Git hook, are dropped for the same reason.
 *
 * Assigned directly rather than with `vi.stubEnv`, so `vi.unstubAllEnvs` in a test restores these values.
 */
const inheritedGitVariables = Object.keys(process.env).filter((name) => name.toUpperCase().startsWith("GIT_"));
for (const name of inheritedGitVariables) {
  delete process.env[name];
}

process.env["GIT_CONFIG_GLOBAL"] = path.join(__dirname, "fixtures", "gitconfig");
process.env["GIT_CONFIG_NOSYSTEM"] = "1";
process.env["GIT_ATTR_NOSYSTEM"] = "1";
