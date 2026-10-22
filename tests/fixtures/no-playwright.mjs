// Loaded with `node --import`: fails any import of Playwright, to prove a module does not need it.
import { register } from 'node:module';
register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(specifier, context, next) {
  if (specifier === 'playwright' || specifier.startsWith('playwright/')) throw new Error('Playwright was loaded');
  return next(specifier, context);
}`));
