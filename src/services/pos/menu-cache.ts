// Shared POS menu cache (45s per location).
//
// Lives in its own module so ADAPTERS can use it too (D-10: Clover's
// createCheck validated orders against a fresh getMenu() call, bypassing
// the cache that protects the merchant's POS API quota). context.ts
// re-exports the context-shaped helpers for existing callers.
import { PosAdapter, PosMenuItem, PosType } from './types.js';

const MENU_TTL_MS = 45_000;
const menuCache = new Map<string, { items: PosMenuItem[]; expiresAt: number }>();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of menuCache) if (v.expiresAt <= now) menuCache.delete(k);
}, 60_000).unref();

/** Get a location's menu through the shared cache. */
export async function getMenuCached(
  adapter: PosAdapter,
  posType: PosType,
  locationRef: string,
  token: string | undefined,
): Promise<PosMenuItem[]> {
  if (!adapter.getMenu) throw new Error(`ordering is not supported for ${posType} locations yet`);
  const key = `${posType}:${locationRef}`;
  const hit = menuCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.items;
  const items = await adapter.getMenu(locationRef, token);
  menuCache.set(key, { items, expiresAt: Date.now() + MENU_TTL_MS });
  return items;
}

/** Invalidate the cached menu for a location (call after catalog changes). */
export function invalidateMenuCache(posType: string, locationRef: string): void {
  menuCache.delete(`${posType}:${locationRef}`);
}
