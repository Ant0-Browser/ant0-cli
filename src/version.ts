/**
 * The release version, defined by the bundler when the CLI is packaged with a release. Undefined
 * in every other build.
 */
declare const __ANT0_VERSION__: string | undefined;

/** What `ant0 --version` prints: the Ant0 release this CLI belongs to, else the package version. */
export const CLI_VERSION: string =
  typeof __ANT0_VERSION__ === "string" ? __ANT0_VERSION__ : "0.3.22-beta.3";

function majorMinor(version: string): string | undefined {
  return /^(\d+)\.(\d+)(?:\.|-|$)/.exec(version)?.slice(1, 3).join(".");
}

/**
 * A warning when the daemon and the CLI differ in major.minor (the local API is not versioned
 * separately), else undefined. Unparseable versions never warn.
 */
export function versionSkewWarning(
  daemonVersion: string,
  cliVersion = CLI_VERSION,
): string | undefined {
  const daemon = majorMinor(daemonVersion);
  const cli = majorMinor(cliVersion);
  if (daemon === undefined || cli === undefined || daemon === cli) return undefined;
  return (
    `warning: the daemon is version ${daemonVersion} but this CLI is ${cliVersion}; ` +
    "commands may fail until both are on the same release"
  );
}
