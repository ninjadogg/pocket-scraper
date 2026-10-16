# Pocket Scraper 0.3.1

Pocket Scraper includes a Chrome extension and a local Node.js companion server.
The extension alone cannot save recipes, store results, or run schedules.

## Install the companion server

1. Install Node.js 20 or newer (with npm) from https://nodejs.org/.
2. Extract `pocket-scraper-server-0.3.1.zip` to a permanent folder.
3. In a terminal in that folder, run:

   ```sh
   npm ci
   npx playwright install chromium
   npm start
   ```

   Linux may also need browser system packages: `npx playwright install --with-deps chromium`.
4. Open http://127.0.0.1:3888/. Keep the server running and the machine awake.
   Use the default port 3888; the extension is configured for that port.

## Install the extension for testing or internal review

1. Extract `pocket-scraper-extension-0.3.1.zip` to a permanent folder.
2. Open `chrome://extensions` in Chrome and enable Developer mode.
3. Click **Load unpacked** and select the extracted folder containing `manifest.json`.
4. Pin Pocket Scraper from Chrome's Extensions menu.
5. In the dashboard, expand **Connect the Chrome extension** and copy the connection key. In the extension, expand **Connect to local server**, paste the key, and click **Connect**.
6. Open a website, use the extension to pick fields, name the recipe, and save it.
7. Use **Save & run now**, or **Extract from current Chrome tab** for a manual snapshot.

Do not drag the ZIP into Chrome as an installer. The ZIP is an unpacked-extension
bundle and Chrome Web Store upload artifact, not a signed installer. General
consumer distribution requires publishing through the Chrome Web Store; managed
enterprise distribution has separate Chrome policy requirements.

## Sessions and unattended runs

In the dashboard, **Open session setup** opens a separate browser for the site.
Complete any sign-in or verification, then click **Finish setup** in the dashboard.
Select an interval in the extension and save the recipe for scheduled collection.
Runs execute headlessly with the saved session. A server needs initial interactive
setup for sites requiring sign-in, but normal scheduled runs need no user presence.
A fresh verification demand pauses affected schedules and requires attention.
The server remains bound to loopback; do not expose it publicly.

## Updates

Stop the server before replacing its code. Keep your existing `data/` folder;
release ZIPs do not include or overwrite it. Run `npm ci`, install the matching
Playwright browser, and restart. Replace extension files in the same extracted
folder, then click **Reload** on its Chrome extensions page. Reopen the popup.
Using the same folder preserves the unpacked extension's identity and local draft.

If capture reports no response from its background worker, reload the extension.
If the dashboard is unavailable, start the companion server. If a site returns
403, follow its session-setup flow; successful access is not guaranteed for every site.

After upgrading to 0.3.1, reload the dashboard and extension and connect them once. Re-pick a record container and its fields for recipes using positional extraction.

## Windows PowerShell

1. Install Node.js 22 LTS or newer and Google Chrome, then reopen PowerShell.
2. Extract the server ZIP into a permanent folder under your user profile, for
   example `C:\Users\YOUR_NAME\PocketScraper`. Avoid shared or cloud-synced folders
   because the data directory holds website sessions and collected records.
3. In PowerShell, run (adjust the folder if needed):

   ```powershell
   Set-Location "$env:USERPROFILE\PocketScraper"
   node --version
   npm.cmd ci
   npx.cmd playwright install chromium
   npm.cmd start
   ```

   The `.cmd` commands avoid PowerShell's `npm.ps1` execution-policy error;
   changing your system execution policy is unnecessary. Chromium is a separate
   download used by the runner. It does not reuse your everyday Chrome profile.
4. Open `http://127.0.0.1:3888/`, load the extension in Chrome using **Load unpacked**,
   and pair it using the dashboard connection key as described above.
5. For sites needing login, open and finish session setup while signed into your
   Windows desktop. Test **Run now** before enabling unattended execution.

To use a specific compatible browser, set its executable before starting:

```powershell
$env:SCRAPER_BROWSER_PATH = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
npm.cmd start
```

The default Playwright Chromium installation is recommended. The automatic
installed-Chrome fallback is currently macOS-only. Set environment overrides in
both interactive and scheduled environments if you choose to use them.

### Run unattended with Windows Task Scheduler

Keep the machine powered on and awake. Closing Chrome or locking the desktop
is fine after session setup; sleep and shutdown prevent collection.

1. Stop the manually started server with **Ctrl+C**. Run
   `(Get-Command node.exe).Source` to find the full Node executable path.
2. Open **Task Scheduler → Create Task**. Use the same Windows account that
   installed Chromium and completed session setup. Choose **Run whether user is
   logged on or not** for background operation. Administrator privileges are not
   required. Windows may ask for that account's password when saving the task.
3. Add an **At startup** trigger. Add a **Start a program** action:
   - **Program/script:** the full path from step 1, typically
     `C:\Program Files\nodejs\node.exe`.
   - **Add arguments:** `"C:\Users\YOUR_NAME\PocketScraper\server.js"`.
   - **Start in:** `C:\Users\YOUR_NAME\PocketScraper` (without quotes).
4. Under Settings, select **Do not start a new instance** if the task is already
   running, enable restart on failure, and disable the automatic time-limit stop
   for this long-running task. Review power conditions to match your needs.
5. Run the task manually once, open the local dashboard, and verify a scheduled
   run. Then test again after a restart. Do not also run `npm.cmd start` while the
   task is active: both would contend for port 3888 and the same data files.

If a website asks for fresh interactive verification, stop the scheduled task,
start the server in PowerShell under the same account, complete **Open session
setup → Finish setup**, stop that server, and restart the task. A background
Windows task cannot display an interactive setup window on your desktop.

Keep the data directory restricted to your Windows account using folder
**Properties → Security**. Unix permission modes used by the code do not create
Windows access-control lists. Keep the same data folder and OS account across
updates, and stop the scheduled task before replacing files.

### Build and test on Windows

Install Python 3.9 or newer only if you want to build distribution ZIPs. The
packaging command detects the Windows `py -3` launcher or a Python executable.

```powershell
npm.cmd test
npm.cmd run package
```

The test command uses Node's test discovery, so it does not depend on Unix shell
wildcard expansion. The CI workflow runs on Windows, macOS and Linux. Passing CI
covers automated tests; installation, folder permissions and Task Scheduler still
need validation on the target Windows machine.
