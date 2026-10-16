export const API = 'http://127.0.0.1:3888';
export async function api(path, options = {}) {
  const { connectionKey } = await chrome.storage.local.get('connectionKey');
  if (!connectionKey) throw new Error('Copy the connection key from the local dashboard and connect this extension first.');
  const response = await fetch(API + path, { ...options, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + connectionKey, ...options.headers } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}
