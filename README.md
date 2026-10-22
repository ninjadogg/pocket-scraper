# Pocket Scraper

**Public beta · v0.3.1 · MIT licensed.** For local use and evaluation; not yet a production service.

[Download the beta](https://github.com/ninjadogg/pocket-scraper/releases/tag/v0.3.1) · [Install on Windows, macOS or Linux](distribution/INSTALL.md) · [Report a security issue privately](SECURITY.md)

A **local, non-AI visual web scraper**: pick data fields or navigation clicks in Chrome; save a recipe; run it on demand or on a schedule; keep historical results; optionally let Claude read the results through MCP.

## Setup (macOS, Homebrew Node)

```bash
brew install node
git clone https://github.com/ninjadogg/pocket-scraper.git
cd pocket-scraper
npm ci
npx playwright install chromium     # one-time browser download
npm start                           # keep this running for schedules
```

Open **http://127.0.0.1:3888** to see results. Expand **Connect the Chrome extension**, copy the connection key, and paste it into the extension’s **Connect to local server** section once. API clients must send `Authorization: Bearer <connection-key>`; keep the key private.

### Enable Chrome picker

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked**, then choose this project's **`extension/`** folder.
3. Open a website to collect. Click the Pocket Scraper extension icon (pin it for easy access).
4. Use **Pick record container** to select one repeated card, list item, or table row, then pick fields inside that container. Give the recipe a name. Type a field name, e.g. `title`, choose **Text** or **Link**, click **Pick field**, and then click the matching element on the actual webpage. Reopen the extension to add additional fields.
5. For navigation, **Record click** selects a button to click before extraction. **Pick Next** selects a next-page link or "Load more" button and defaults the cap to 5 pages (supports both URL-changing and in-place AJAX pagination, stopping automatically when no new records appear). Review or edit the generated CSS selectors in the popup.
6. Choose a schedule and click **Save & run now**. Check results in the dashboard.

**Record association:** With a record container, each matching container produces one row. Missing fields stay blank in that record; multiple matches within one field are joined with newlines. Field selectors are relative to the container. Legacy recipes without a container reject unequal field counts; equal counts produce a warning because they cannot guarantee correct association. Re-pick fields after changing the record container.

## Scheduling

Choose manual, 15 minutes, hourly, 6-hourly, daily, or weekly. The scheduler runs inside `npm start`, so keep it running. A job's next due time is persisted. If the app was closed, the next due job runs after restart. Schedules are approximate, not exact wall-clock cron expressions.

For unattended operation on macOS, install the user LaunchAgent with `npm run launchd -- --install` (inspect with `npm run launchd -- --status`, remove with `npm run launchd -- --uninstall`), or use another process manager. There's no cloud dependency.

## Data and APIs

Data is written to `data/store.json` (local file; not a database server). Keep this file backed up. Records include recipe ID, source URL, fields, first-observed timestamp, and run ID. Records with identical source URL + field values are deduplicated per recipe, while every run retains status/warnings/errors.

- `GET /api/recipes` — recipes
- `POST /api/recipes` — create/update a recipe as JSON
- `POST /api/run/:recipeId` — start an async run
- `GET /api/runs?recipeId=...` — run history
- `GET /api/records?recipeId=...&limit=100` — collected rows
- `GET /api/export/:recipeId.csv` — CSV output

Server listens only on `127.0.0.1:3888`. API access requires a local connection key; **don't bind it to a public interface**. The dashboard only exposes its connection key on same-site top-level navigation. Pairing authorizes the extension origin as well as its key. The extension has active-tab scripting permission and localhost access, not persistent access to every site.

### Claude MCP (read-only, optional)

No AI is involved in collecting anything. The MCP server only reads the saved evidence. From your terminal, in the project directory:

```bash
claude mcp add pocket-scraper -- node "$(pwd)/mcp.js"
```

Or use the MCP configuration in a Claude-compatible client, with `command: node` and `args: ["/absolute/path/to/pocket-scraper/mcp.js"]`.

Tools exposed: `list_scraper_recipes`, `read_scraped_records`, `read_scraper_runs`. MCP can read records even while the scraper server is stopped (provided data exists).

## Limitations / next step

- This MVP does not automatically solve CAPTCHAs or bot-blocking, and does not handle scrolling, infinite scroll, or `iframe` elements. In-place "Load more" / AJAX pagination via **Pick Next** stops automatically when a click adds no new records, and multi-step workflows can replay custom click/wait sequences.
- CSS selectors are deterministic but **fragile when websites redesign**. Watch per-field selector health warnings, zero-match warnings, and run failures in the dashboard.
- Runs use a fresh browser until you enable saved sessions through dashboard session setup. Saved sessions reuse a dedicated profile; your everyday Chrome profile is never used.
- Historical data is a simple JSON store; for hundreds of sources or millions of records, replace storage with SQLite/PostgreSQL and add per-site throttling/queues.
- Only collect data you are permitted to access and respect site rate limits and applicable restrictions.

## Testing

```bash
npm test
```

An integration test uses a local sample website (no network scraping required). You can also start the included `tests/fixture.html` from a local test HTTP server and visually test the picker.

## Multi-step recipes

In the extension, choose **Execution mode → Multi-step workflow** after choosing your data fields.

- **Record click** picks a page element and appends a click step. Picking records the target; it does not execute the click. Click through the page normally when you need to reach another target during configuration.
- **Add wait** pauses for a specified number of milliseconds (up to 30 seconds).
- **Add extract** collects all configured fields at that point in the sequence.
- **Move up**, **Move down**, and **Remove** arrange the sequence.
- **Repeat entire workflow** runs the sequence 1–30 times, continuing from the current page. The starting URL is opened only once per run.

For example, arrange **Extract → Click Next → Wait 1000 ms**, and repeat 3 times to collect three states of a list. This also works when Next updates content without changing the URL. Use a repeat count appropriate for the available pages; a missing or disabled click target fails the run with the repeat and step number. Results are saved after the full workflow succeeds.

Every Extract uses the same selected fields. Record containers associate fields within each card; legacy positional recipes are checked for mismatched counts. In workflow mode, the ordered steps replace the old pre-extraction clicks and automatic next-page loop; Maximum pages and Pick Next do not apply. Switching back to the original mode restores the original click/page configuration. Existing saved recipes continue to run as before.

After updating the extension, reload it from Chrome's extensions page and restart the local server to use the new workflow support.

## Collect from your open Chrome tab

For pages that work in Chrome but block automated browsers (such as security-verification pages):

1. Reload Pocket Scraper on Chrome's extensions page after updating, and start/restart the local server.
2. Open the source page in Chrome and finish any verification. Expand the content you want to collect.
3. Open Pocket Scraper, select your saved recipe, and click **Extract from current Chrome tab**.
4. Open Results. Captures are labeled **Chrome tab**, retain the actual page URL and timestamp, and deduplicate against previous records.

This button saves the recipe and takes one snapshot of the current page using its fields. It does not execute clicks, waits, repeats, or pagination. It requires a tab on the same origin as the recipe. Scheduled runs use a fresh automated browser unless you enable a saved session in the dashboard. Missing fields produce warnings; an entirely empty capture is recorded as an error. Captures are limited to 5000 rows and 2 MB per request.

## Read captured results in Claude

Tab captures and automated runs use the same local store, so the existing MCP tools expose both without a separate import. Claude can read source URLs, timestamps, fields, and run history. The run's `source: "chrome-tab"` identifies manual tab collection. No model is involved in extraction, and MCP access is read-only.

For Claude Code, from this project directory:

```bash
claude mcp add --scope project pocket-scraper -- node "$(pwd)/mcp.js"
```

For Claude Desktop, merge this entry into its `mcpServers` settings (preserving any other servers), then restart Claude Desktop:

```json
{
  "mcpServers": {
    "pocket-scraper": {
      "command": "node",
      "args": ["/absolute/path/to/pocket-scraper/mcp.js"]
    }
  }
}
```

Example Claude request: “Read the saved Action1 Release Notes in Pocket Scraper. Summarize the collected text and include its source URL and observation time. Check the latest run for warnings.” MCP can read saved data even when the localhost web server is stopped.

## Unattended runs with a saved browser session

In the dashboard, click **Open session setup** beside a saved recipe. This opens a
separate browser profile for that website. Sign in or complete verification there,
then click **Finish setup** in the dashboard, or simply close the setup window.
Either way the session is saved, including cookies without an expiry: while setup is
open, cookies are also saved after each page load and every 30 seconds, and closing
the last setup window saves them once more and releases the profile.
**Run now** and interval jobs now reuse that session in headless mode. The profile
survives server restarts; keep `npm start` running for scheduled collection.
Recipes on the same origin share a profile and cannot use it simultaneously.

If a saved-session run receives HTTP 401/403/429 or detects a verification page,
it is marked **needs_attention** and schedules using that session pause. Repeat
session setup and click Finish setup to resume. There is no automatic CAPTCHA
solver: a site may still reject automated access even with a valid session.

For an unattended server, install Chromium with `npx playwright install chromium`
(and its OS dependencies), use a persistent data directory, and run the service
under a process manager. Initial setup and later verification require a desktop
session on that host (for example, a remote desktop). Normal runs need no display
or user presence. This does not depend on the user's everyday Chrome being open.
On macOS, installed Chrome is used if the bundled Chromium is missing; an explicit
`SCRAPER_BROWSER_PATH` overrides browser selection.

Profiles and session cookies stay under `data/browser-profiles/` (or alongside
`POCKET_SCRAPER_DATA`). On Unix, profile directories and saved cookie files use owner-only permissions.
On Windows, keep the folder under your private user profile and restrict its
Windows folder permissions; Unix permission modes do not set Windows ACLs. Treat them as sign-in credentials: exclude them from
source control and sharing. They are not returned by the API or MCP; they leave the
data folder only when you run `npm run export-cookies` yourself (see below). No cookies are
read from the user's normal browser profile. Use the same browser installation
for setup and unattended execution.

### Browser compatibility for unattended runs

Both fresh runs and saved-session runs use the installed browser's current user
agent without the `HeadlessChrome` marker and suppress Chromium's automation
fingerprint flag. Session setup uses the same identity as unattended runs. This
requires no Python, external service, AI, or cookie export from everyday Chrome.
It improves compatibility with sites that reject the default automated-browser
identity, but does not solve interactive challenges or guarantee future access.

## Use a saved login in other tools

`npm run export-cookies` hands a login saved through session setup to another tool
as a Cookie header. It runs locally, needs no server, and never prints cookie values
to the terminal: values go only to the file named by `--out` (written atomically,
owner-only `600`) or to standard output when you pass `--stdout`. Its summary on
stderr lists cookie names, counts, the earliest expiry and warnings.

**ISTAR (.env / Easypanel)** — one command writes one `VAR=<Cookie header>` line per
variable. ISTAR's login-gated sources read `SCRAPER_CONNECTWISE_AUTHTOKEN` for
`docs.connectwise.com` and `RADAR_AUTH_<VENDOR>` for the rest: `RADAR_AUTH_CROWDSTRIKE`
(falcon.crowdstrike.com), `RADAR_AUTH_COHESITY` (docs.cohesity.com),
`RADAR_AUTH_FORTYTWOGEARS` (community.42gears.com), `RADAR_AUTH_MOSYLE`
(mybusiness.mosyle.com), `RADAR_AUTH_RUBRIK` (docs.rubrik.com).

```bash
npm run export-cookies -- \
  --env SCRAPER_CONNECTWISE_AUTHTOKEN=https://docs.connectwise.com@authtoken \
  --env RADAR_AUTH_MOSYLE=https://mybusiness.mosyle.com \
  --out radar.env
# Later, refresh just those variables inside an existing .env, keeping every other line:
npm run export-cookies -- --env RADAR_AUTH_MOSYLE=https://mybusiness.mosyle.com --out .env --merge
```

- `VAR=<url-or-host>@name1,name2` exports only those cookies (`--only name1,name2`
  with `--site`). If a named cookie is missing or expired, or any site has no
  cookies, **nothing is written** and the command exits 2, so a half-updated `.env`
  never ships.
- `SCRAPER_CONNECTWISE_AUTHTOKEN` always holds the bare `authtoken` value (the
  MindTouch JWT), because ISTAR's `scraper_worker` adds `authtoken=` itself. Every
  other variable holds a full header such as `RADAR_AUTH_MOSYLE=sid=abc; pref=1`.
- Lines are written unquoted. Docker compose `.env` rules, Node's and Python's dotenv
  parsers and `docker run --env-file` all read such a line back unchanged (tested);
  Easypanel's Environment box uses the same `KEY=value` format. A cookie value
  containing `#`, `$`, `"`, `'`, `` ` `` or `\` would be changed by some of those parsers,
  so the export refuses it (naming the cookie) rather than write a broken line.
- `--out` never replaces an existing file unless you pass `--merge` (env output:
  replace only the named variables in place, append missing ones, keep the file's
  mode but never looser than `600`) or `--force` (replace the whole file). It refuses
  symbolic links and files owned by another user.
- In docker compose, a project `.env` only fills `${VAR}` references; the service must
  list the variable under `environment:` (as ISTAR does for `SCRAPER_CONNECTWISE_AUTHTOKEN`)
  or load the file with `env_file:`. In Easypanel, paste the lines into the service's
  Environment settings.

**Release radar** — a raw header file (`a=b; c=d`, no `Cookie:` prefix) for
`safari_session.py fetch --cookie-header`:

```bash
npm run export-cookies -- --site https://docs.connectwise.com --out connectwise.cookie
python3 scripts/safari_session.py fetch --run 2026-10-19 --cookie-header connectwise.cookie \
  --url https://docs.connectwise.com/... --id cw_automate
```

**Playwright-based tools** — a storage state for `browser.newContext({ storageState })`:

```bash
npm run export-cookies -- --site https://docs.rubrik.com --format storage-state --out rubrik.storage-state.json
```

A single env line also works without `--env`:
`npm run export-cookies -- --site https://docs.rubrik.com --format env --var RADAR_AUTH_RUBRIK --out rubrik.cookies.env`.

**See what is saved** — `npm run export-cookies -- --list` shows each saved session:
the domains its cookies cover, cookie and expired counts, the earliest expiry,
whether session-only cookies are present and when it was saved. No values.

Selection follows browser rules: a cookie is exported when its domain is the host
(or a parent domain it was set on), its path is a prefix of the URL's path (default
`/`), it is not expired, and, if `Secure`, the URL is `https`. All saved sessions
are searched, since a single sign-on cookie may come from another recipe's login; if
the same cookie is saved in several, the most recently saved wins and the summary
says so. Exported files (`*.cookie`, `*.cookies.env`, `*.storage-state.json`,
`radar.env`, `.env`) are git-ignored here. Warnings flag expired cookies,
session-only cookies (they end when the site ends that login session) and exports wider than the site itself (cookies from
a parent domain such as `.connectwise.com`, or more than 10 cookies); use `--only`
to narrow those.

> **Risks.** An exported cookie is a live login: whoever holds it is signed in as
> that account, with no password or two-factor prompt, until it expires.
> Anyone who can read where you put it (a shared server's environment settings) can act as that account.
> For shared deployments, prefer a dedicated vendor account over your own.
> Store it as a secret and never commit it; re-export when the login expires.
> To revoke it, sign out of that session on the website or change the password.

## Distribution packages

Run `npm run package` with Python 3 installed to build versioned extension and
companion-server ZIPs in `dist/`, plus installation instructions, privacy
information, publishing notes and SHA-256 checksums. Packaging uses explicit
allowlists and excludes local records, sessions, credentials and dependencies.
The extension ZIP has its Manifest V3 manifest at the root. See
[installation instructions](distribution/INSTALL.md) and
[publishing notes](distribution/PUBLISHING.md) for trusted testing and the separate
Chrome Web Store publication process. Recipients need both the extension and the
local server; the ZIP is not a signed Chrome installer.

## Hardening in 0.3.0

- Pair the extension once using the local dashboard connection key. Requests must
  use the exact loopback host and port. Unpaired extension origins are rejected.
  The connection key is stored in an owner-only `.api-auth.json` alongside the
  store; never share it. Local CLI clients may read that file to authenticate.
- Pick a record container to keep related fields together. Invalid legacy
  alignment fails visibly. Existing historical records are retained unchanged;
  results collected before this fix may contain positional pairing errors.
- Empty runs fail; document HTTP errors reached through clicks or pagination
  fail instead of being saved as content. Workflow snapshots with no values are
  warned about when other snapshots in that run yielded records.
- CSV exports prefix formula-like cells with a tab for safer spreadsheet opening.
  This changes the CSV representation; API/MCP JSON preserves original values.
  Spreadsheet behavior varies, so retain JSON for lossless interchange.
- Storage errors are exposed through authenticated `/api/health`; run locks are
  released even when saving fails. On restart, unfinished runs become interrupted.
  Repair storage and retry failed work; a failed disk cannot retain new results.

## Security and compatibility

See [SECURITY.md](SECURITY.md) for private vulnerability reporting, supported
versions, and the local-machine security boundary.

Windows PowerShell setup and Task Scheduler instructions are in
[the installation guide](distribution/INSTALL.md#windows-powershell). The core
runner uses Playwright Chromium on Windows, macOS and Linux. CI runs tests and
packaging on all three; check the latest workflow results for verified platforms.
The suite covers headless sessions and popup logic, not a manual extension install
on every OS.

### Persistence in 0.3.1

If the final save fails, the run reports `storage_error`, unsaved rows are removed
from memory, and the dashboard shows a storage alert. Repair the storage issue
and rerun the recipe. A later successful save clears the alert; it does not
recover the discarded rows. A restart may show an interrupted run because the
failed write could not record its final status.

## Beta scope and feedback

The extension requires the local companion server; it is distributed as an
unpacked extension, not a Chrome Web Store listing. Keep the server running and
the machine awake for schedules. Saved sessions may still require interactive
verification when a website requests it.

The automated tests and packaging run on Windows, macOS and Linux. Manual
installation and startup configuration must still be checked on your own machine.
Concurrent runs default to 2 (`POCKET_SCRAPER_MAX_CONCURRENT`) with a 3-minute per-run
deadline (`POCKET_SCRAPER_RUN_TIMEOUT_MS`). This beta has no automatic data
retention or damaged-store recovery. Use a small number of trusted recipes and
back up your private data directory.

Report ordinary bugs through [GitHub issues](https://github.com/ninjadogg/pocket-scraper/issues),
including the version, OS, reproduction steps and sanitized logs. Use synthetic
examples; never attach connection keys, cookies, profiles or private records.
For vulnerabilities, follow [SECURITY.md](SECURITY.md).

Licensed under the [MIT License](LICENSE).
