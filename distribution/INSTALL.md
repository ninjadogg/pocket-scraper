# Pocket Scraper 0.3.0

Pocket Scraper includes a Chrome extension and a local Node.js companion server.
The extension alone cannot save recipes, store results, or run schedules.

## Install the companion server

1. Install Node.js 20 or newer (with npm) from https://nodejs.org/.
2. Extract `pocket-scraper-server-0.3.0.zip` to a permanent folder.
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

1. Extract `pocket-scraper-extension-0.3.0.zip` to a permanent folder.
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

After upgrading to 0.3.0, reload the dashboard and extension and connect them once. Re-pick a record container and its fields for recipes using positional extraction.
