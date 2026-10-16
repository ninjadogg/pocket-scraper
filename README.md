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
5. For navigation, **Record click** selects a button to click before extraction. **Pick Next** selects a next-page link and defaults the cap to 5 pages (requires URL-changing pagination). Review or edit the generated CSS selectors in the popup.
6. Choose a schedule and click **Save & run now**. Check results in the dashboard.

**Record association:** With a record container, each matching container produces one row. Missing fields stay blank in that record; multiple matches within one field are joined with newlines. Field selectors are relative to the container. Legacy recipes without a container reject unequal field counts; equal counts produce a warning because they cannot guarantee correct association. Re-pick fields after changing the record container.

## Scheduling

Choose manual, 15 minutes, hourly, 6-hourly, daily, or weekly. The scheduler runs inside `npm start`, so keep it running. A job's next due time is persisted. If the app was closed, the next due job runs after restart. Schedules are approximate, not exact wall-clock cron expressions.

For unattended operation on macOS, you can run `npm start` via `launchd`, a terminal multiplexer, or another process manager. There's no cloud dependency.

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

- This MVP does not automatically solve CAPTCHAs or bot-blocking, and does not handle scrolling, infinite scroll, `iframe` elements, automatic detection of the end of in-place pagination. Multi-step workflows can replay a fixed number of in-place updates.
- CSS selectors are deterministic but **fragile when websites redesign**. Watch zero-match warnings and run failures in the dashboard.
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
then click **Finish setup** in the dashboard before closing the browser yourself.
This closes the browser and saves its session, including cookies without an expiry.
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
source control and sharing. They are not returned by the API or MCP. No cookies are
read from the user's normal browser profile. Use the same browser installation
for setup and unattended execution.

### Browser compatibility for unattended runs

Both fresh runs and saved-session runs use the installed browser's current user
agent without the `HeadlessChrome` marker and suppress Chromium's automation
fingerprint flag. Session setup uses the same identity as unattended runs. This
requires no Python, external service, AI, or cookie export from everyday Chrome.
It improves compatibility with sites that reject the default automated-browser
identity, but does not solve interactive challenges or guarantee future access.

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
This beta has no global concurrency limit, overall run deadline, automatic data
retention or damaged-store recovery. Use a small number of trusted recipes and
back up your private data directory.

Report ordinary bugs through [GitHub issues](https://github.com/ninjadogg/pocket-scraper/issues),
including the version, OS, reproduction steps and sanitized logs. Use synthetic
examples; never attach connection keys, cookies, profiles or private records.
For vulnerabilities, follow [SECURITY.md](SECURITY.md).

Licensed under the [MIT License](LICENSE).
