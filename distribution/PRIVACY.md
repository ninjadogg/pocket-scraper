# Pocket Scraper privacy information

Pocket Scraper has no analytics, hosted collection service, or AI/model calls in
the collection path. The extension reads fields you choose from the active page
when you use its picker or capture controls. It stores recipe drafts in Chrome's
local extension storage and sends recipes/captured rows to the companion server
at http://127.0.0.1:3888 on your computer.

The server visits the websites in your recipes, saves collected fields, source
URLs, timestamps and run history in its local data folder, and keeps dedicated
browser profiles and session cookies there when session reuse is enabled.
Website requests are subject to those websites' privacy practices. Captured
fields may contain personal information depending on your selected page.

Permissions: activeTab permits access to the tab you invoke the extension on;
scripting runs the picker and extraction code; storage saves local drafts;
localhost host permissions communicate with the companion server. It does not
request global website access, Chrome's cookies API, or access to your everyday
Chrome profile. Session setup uses a separate browser profile.

The optional read-only MCP server exposes saved results to a client you configure;
that client may transmit data according to its own settings and policies. CSV
exports and files you share can also disclose collected content.

To delete stored data, stop the server and remove its data folder (or the folder
configured with POCKET_SCRAPER_DATA). Remove the extension to delete its local
drafts. Deleting a recipe in the dashboard retains historical records. Removing
only the extension does not delete the server's records or session profiles.

Do not distribute your data folder, browser profiles, or session cookie files.
