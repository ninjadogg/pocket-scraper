# Release preparation

Run `npm test`, then `npm run package` (Python 3 is required only for packaging).
The packager uses explicit file lists and writes deterministic ZIPs with SHA-256
checksums under dist/. It never includes data/, node_modules/, profiles or cookies.
The extension manifest is at the ZIP root. Server dependencies are installed by
recipients with npm ci using the included lockfile.

The ZIPs are ready for trusted testing/internal review. They have not been
submitted to or approved by the Chrome Web Store. Before public publication:

- Use your publisher account and choose visibility/distribution regions.
- Supply listing screenshots, description, support contact and a hosted privacy
  policy URL based on PRIVACY.md. Clearly disclose the companion-server requirement.
- Complete Chrome's privacy and permissions declarations accurately.
- Choose the project's licensing terms before granting public redistribution rights.
- Upload the extension ZIP, review it, and submit through the publisher dashboard.
- Increment package, lockfile and manifest versions for subsequent releases.

Official instructions:
https://developer.chrome.com/docs/webstore/prepare
https://developer.chrome.com/docs/extensions/how-to/distribute
