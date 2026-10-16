# Codex context: Pocket Scraper

This is a local-only, no-AI scraping MVP. Keep it lightweight and deterministic.

Architecture:
- `extension/`: Chrome Manifest V3 popup and DOM selector picker (no framework).
- `runner.js`: Playwright extraction and click/navigation replay.
- `server.js`: localhost API, dashboard, in-process interval scheduler.
- `store.js`: atomic JSON file persistence, unique-row deduplication.
- `mcp.js`: read-only, zero-dependency MCP over stdio for optional Claude access.

User requirements: click elements in browser instead of writing CSS selectors; record click or next-page targets; save named recipes; schedule manual or interval execution; preserve source/history; no AI in the collection path.

Workflow: run `npm test` after changes. Keep API bound to loopback. Don't add hosted services, API keys, databases or model calls unless explicitly requested. Next improvements should prioritize per-card extraction (avoid index-alignment), AJAX pagination, selector health checks, and macOS launchd support.
