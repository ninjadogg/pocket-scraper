// Server settings read from the environment. Dependency-free so the launchd helper
// can share the same names and validation without loading the server.

/** Environment variables the server reads; the launchd helper copies these into its plist. */
export const SERVER_ENV = ['PORT', 'POCKET_SCRAPER_DATA', 'SCRAPER_BROWSER_PATH',
  'POCKET_SCRAPER_MAX_CONCURRENT', 'POCKET_SCRAPER_RUN_TIMEOUT_MS'];

// Unset or empty uses the default. Anything else must be a whole number in range;
// otherwise warn and use the default, so a typo never disables a limit and a
// KeepAlive service never crash-loops on bad config.
export function intSetting(env, name, fallback, { min, max = Number.MAX_SAFE_INTEGER }, warn = console.warn) {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const value = Number(raw);
  if (Number.isInteger(value) && value >= min && value <= max) return value;
  warn(`${name}=${raw} is not a whole number from ${min} to ${max}; using ${fallback}.`);
  return fallback;
}

export function readSettings(env = process.env, warn = console.warn) {
  return {
    port: intSetting(env, 'PORT', 3888, { min: 0, max: 65535 }, warn),
    maxConcurrentRuns: intSetting(env, 'POCKET_SCRAPER_MAX_CONCURRENT', 2, { min: 1 }, warn),
    runTimeoutMs: intSetting(env, 'POCKET_SCRAPER_RUN_TIMEOUT_MS', 180_000, { min: 500, max: 2_147_483_647 }, warn) // setTimeout's limit
  };
}
