import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

// Railway mounts persistent storage at /data. Locally, this remains ./data.
const file = resolve(process.env.DATA_DIR ?? 'data', 'watchers.json');
let state = { watchers: [] };

export async function loadStore() {
  try { state = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  state.watchers ??= [];
}

export function watchers() { return state.watchers; }
export function isActiveWatcher(id, guildId, channelId) {
  return state.watchers.some(w => w.id === id && w.guildId === guildId && w.channelId === channelId);
}

export async function saveStore() {
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  await writeFile(temp, JSON.stringify(state, null, 2));
  await rename(temp, file);
}

export async function addWatcher(watcher) { state.watchers.push(watcher); await saveStore(); }
export async function removeWatcher(id, guildId) {
  const index = state.watchers.findIndex(w => w.id === id && w.guildId === guildId);
  if (index < 0) return false;
  state.watchers.splice(index, 1); await saveStore(); return true;
}
