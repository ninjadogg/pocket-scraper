// Python is only needed to build release ZIPs, not to run Pocket Scraper.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const script = fileURLToPath(new URL('./package-release.py', import.meta.url));
const candidates = process.platform === 'win32'
  ? [['py', '-3'], ['python'], ['python3']]
  : [['python3'], ['python']];
for (const [command, ...args] of candidates) {
  const probe = spawnSync(command, [...args, '-c', 'import sys; assert sys.version_info >= (3, 9)'], { stdio: 'ignore' });
  if (probe.error || probe.status !== 0) continue;
  const result = spawnSync(command, [...args, script], { stdio: 'inherit' });
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}
console.error('Packaging requires Python 3.9 or newer. Install Python, reopen your terminal, and retry.');
process.exit(1);
