# Security policy

Pocket Scraper is experimental software for a single user's local machine.
Security fixes target the latest release on `main`; older versions are not
maintained separately. Update both the companion server and extension.

## Report a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/ninjadogg/pocket-scraper/security/advisories/new)
when the repository offers **Report a vulnerability**. Do not post exploit details,
connection keys, cookies, browser profiles, or private scraped data in public issues.
If private reporting is unavailable, open an issue requesting a private reporting
channel without including vulnerability details, and wait for the maintainer to
provide one. There is no guaranteed response time or bug bounty.

Include the affected version/commit, OS and Node/browser versions, reproduction
steps using synthetic data, expected and actual behavior, and the potential impact.
Only test systems and accounts you control or have permission to test. Coordinate
public disclosure with the maintainer while a fix is prepared.

## Security boundaries

- Keep the API bound to `127.0.0.1`. Remote exposure, reverse proxies and multi-user
  hosting are unsupported. The connection key protects local API requests; it is
  not a substitute for securing the machine or its OS account.
- Treat recipes as trusted automation: they visit URLs and click page elements
  using the configured browser session. Review imported selectors and actions.
- Keep the data directory, `.api-auth.json`, browser profiles and cookies private.
  They can contain account sessions and private records. Unix permission modes
  are applied where supported; on Windows, use a private user directory and
  Windows folder permissions (ACLs). Node's Unix modes do not establish Windows ACLs.
- `npm run export-cookies` copies a saved login out of the data directory, only when
  you run it. Its output (`--out` files are written owner-only, `600`) is a live
  login: store it as a secret, never commit or attach it, and prefer a dedicated
  website account when the export goes to a shared server.
- Grant MCP access only to trusted clients. It reads local results directly and
  relies on filesystem access rather than the HTTP connection key.
- Scraped pages and values are untrusted content. JSON preserves source values;
  CSV applies formula protection, but spreadsheet behavior can vary.

If a connection key is exposed, stop the server, remove `.api-auth.json` beside
its data store, restart, and pair the extension with the new key. Remove or rotate
any `POCKET_SCRAPER_TOKEN` environment override as well. If a website session or an
exported cookie file is exposed, revoke it with that website (sign out of that session
or change the password) and remove the corresponding saved profile while the server
is stopped. Never attach those files to a report.
