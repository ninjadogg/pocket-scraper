// Zero-dependency read-only MCP server for Claude Code/Claude Desktop.
// STDIO JSON-RPC framing uses one JSON message per line. No browser or model needed.
import { createInterface } from 'node:readline';
import { loadStore } from './store.js';

const tools = [
  { name: 'list_scraper_recipes', description: 'List configured scraping sources, schedules and field names.', inputSchema: { type: 'object', properties: {} } },
  { name: 'read_scraped_records', description: 'Read recently collected unique records for one recipe or all recipes.', inputSchema: { type: 'object', properties: { recipe_id: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 500 } } } },
  { name: 'read_scraper_runs', description: 'Read latest scraper execution statuses, errors and warnings.', inputSchema: { type: 'object', properties: { recipe_id: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 } } } }
];
const result = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });
function rpc(method, params = {}) {
  const db = loadStore();
  if (method === 'initialize') return { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'pocket-scraper', version: '0.3.1' } };
  if (method === 'ping') return {};
  if (method === 'tools/list') return { tools };
  if (method === 'tools/call') {
    const { name, arguments: args = {} } = params;
    if (name === 'list_scraper_recipes') return result(db.recipes);
    const limit = Math.max(1, Math.min(Number(args.limit) || 50, name === 'read_scraper_runs' ? 100 : 500));
    const records = name === 'read_scraped_records' ? db.records : name === 'read_scraper_runs' ? db.runs : null;
    if (!records) throw new Error('Unknown tool: ' + name);
    return result(records.filter(r => !args.recipe_id || r.recipeId === args.recipe_id).slice(0, limit));
  }
  throw new Error('Unsupported MCP method: ' + method);
}
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  if (!line.trim()) continue;
  let request;
  try {
    request = JSON.parse(line);
    if (request.id === undefined) continue; // Notification (no response).
    const output = { jsonrpc: '2.0', id: request.id, result: rpc(request.method, request.params) };
    process.stdout.write(JSON.stringify(output) + '\n');
  } catch (error) {
    const output = { jsonrpc: '2.0', id: request?.id ?? null, error: { code: -32603, message: error.message } };
    process.stdout.write(JSON.stringify(output) + '\n');
  }
}
