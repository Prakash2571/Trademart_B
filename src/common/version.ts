/**
 * Application version identity.
 *
 * Exists to answer "is the container running the code I think it is?". When a
 * Compose stack is built locally from a working tree, the package version alone
 * cannot distinguish two images, so the git SHA and build time are injected at
 * image build time and surfaced here.
 *
 * Values are read from the environment rather than by shelling out to git,
 * because the runtime image contains no .git directory.
 */

export interface VersionInfo {
  /** Semantic version from package.json, injected at build time. */
  version: string;
  /** Commit the image was built from. 'unknown' outside a proper build. */
  gitSha: string;
  /** Short form, for display. */
  gitShaShort: string;
  /** ISO timestamp of the image build. */
  buildTime: string | null;
  nodeVersion: string;
  /** Seconds since this process started. */
  uptimeSeconds: number;
  startedAt: string;
}

const UNKNOWN = 'unknown';

/** Captured once at module load so uptime is measured from process start. */
const startedAt = new Date();

function readEnv(key: string): string | null {
  const value = process.env[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function getVersionInfo(): VersionInfo {
  const gitSha = readEnv('GIT_SHA') ?? readEnv('SOURCE_COMMIT') ?? UNKNOWN;

  return {
    version: readEnv('APP_VERSION') ?? UNKNOWN,
    gitSha,
    gitShaShort: gitSha === UNKNOWN ? UNKNOWN : gitSha.slice(0, 12),
    buildTime: readEnv('BUILD_TIME'),
    nodeVersion: process.version,
    uptimeSeconds: Math.round(process.uptime()),
    startedAt: startedAt.toISOString(),
  };
}
