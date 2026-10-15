// Adapter registry: pos_type string -> PosAdapter implementation.
// Routes resolve the adapter from the location's pos_type column so the
// portal never imports a POS client directly.
import { assertPosType, PosAdapter, PosType } from './types.js';
import { squareAdapter } from './square.js';
import { cloverAdapter } from './clover.js';
import { touchbistroAdapter } from './touchbistro.js';
import { shopifyAdapter } from './shopify.js';
import { helcimAdapter } from './helcim.js';

const REGISTRY: Record<PosType, () => PosAdapter> = {
  square: () => squareAdapter,
  clover: () => cloverAdapter,
  lightspeed: () => {
    throw new Error('lightspeed adapter not implemented yet (v0.3 roadmap)');
  },
  toast: () => {
    throw new Error('toast adapter not implemented yet (v0.3 roadmap)');
  },
  touchbistro: () => touchbistroAdapter,
  shopify: () => shopifyAdapter,
  helcim: () => helcimAdapter,
};

export function getAdapter(posType: string): PosAdapter {
  return REGISTRY[assertPosType(posType)]();
}
