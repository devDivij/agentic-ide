/**
 * Where API keys live: ~/.agentzero/settings.json, written 0600.
 *
 * The settings screen exists so an evaluator can type in their own keys, so
 * they must persist somewhere the UI can write and the runtime can read —
 * user-global (not per-project) and outside version control. Resolution
 * order: the settings file first, then the environment (useful for CI).
 *
 * Keys are WRITE-ONLY over the wire: the API reports presence, never the key.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { PROVIDERS } from '../agent/providers.ts';

export interface StoredSettings {
  /** provider id → api key */
  keys: Record<string, string>;
  /** Last project opened, so the IDE can reopen it. */
  lastProjectRoot?: string;
}

const SETTINGS_PATH = join(homedir(), '.agentzero', 'settings.json');

export function settingsPath(): string {
  return SETTINGS_PATH;
}

export function loadSettings(): StoredSettings {
  if (!existsSync(SETTINGS_PATH)) return { keys: {} };
  try {
    const parsed = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8')) as StoredSettings;
    return {
      keys: parsed.keys ?? {},
      ...(parsed.lastProjectRoot ? { lastProjectRoot: parsed.lastProjectRoot } : {}),
    };
  } catch {
    return { keys: {} };   // a corrupt file must not stop the app; re-enter keys
  }
}

export function saveSettings(settings: StoredSettings): void {
  mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf8');
  try {
    chmodSync(SETTINGS_PATH, 0o600);
  } catch { /* best effort; some filesystems do not support it */ }
}

/** Set or clear one provider's key. An empty string removes it. */
export function setProviderKey(providerId: string, apiKey: string): void {
  const settings = loadSettings();
  if (apiKey.trim()) settings.keys[providerId] = apiKey.trim();
  else delete settings.keys[providerId];
  saveSettings(settings);
}

/** Effective keys for the runtime: settings file, environment filling gaps. */
export function effectiveKeys(env: NodeJS.ProcessEnv = process.env): Map<string, string> {
  const stored = loadSettings().keys;
  const keys = new Map<string, string>();
  for (const provider of PROVIDERS) {
    if (!provider.keyEnv) continue;
    const value = stored[provider.id] ?? env[provider.keyEnv];
    if (value?.trim()) keys.set(provider.id, value.trim());
  }
  return keys;
}

/** Whether a key is set, without ever returning the key itself. */
export function keyPresence(): Record<string, boolean> {
  const keys = effectiveKeys();
  const out: Record<string, boolean> = {};
  for (const provider of PROVIDERS) {
    out[provider.id] = provider.keyEnv === null || keys.has(provider.id);
  }
  return out;
}
