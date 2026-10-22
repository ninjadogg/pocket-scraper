// Where saved website sessions live. Dependency-free so export-cookies can find
// them without loading Playwright.
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

/** One profile folder per website origin. */
export const sessionKey = recipe => createHash('sha256').update(new URL(recipe.url).origin).digest('hex');
/** Cookie snapshot inside each profile folder. */
export const COOKIE_FILE = 'pocket-cookies.json';
export const profileRootFor = dataPath => join(dirname(dataPath), 'browser-profiles');
