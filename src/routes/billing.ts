// v0.4 billing routes (restaurant portal): plan selection, card on file,
// Square subscription management, fee history. Portal users only ever act
// on their own location; staff-token callers pass location_id explicitly
// (same pattern as onboarding.ts).
import { FastifyInstance, FastifyRequest } from 'fastify';
import { requirePortalRole, staffOnly } from '../auth.js';
import { badRequest } from '../http.js';
import {
  billingHistory,
  getBillingState,
  getLocationTier,
  isLocationTier,
  platformCardConfig,
  saveCard,
  setLocationTier,
  switchPlan,
  type BillingPlan,
} from '../services/billing.js';
import { logAudit } from '../services/audit.js';
import { assertNotDemoLocation } from '../services/demo-guard.js';

function resolveLocationId(req: FastifyRequest, given?: unknown): string {
  const u = req.portalUser;
  if (u) {
    if (given !== undefined && given !== null && given !== u.location_id) throw badRequest('not your location');
    return u.location_id;
  }
  if (typeof given !== 'string' || !given) throw badRequest('location_id is required');
  return given;
}

function present(state: Awaited<ReturnType<typeof getBillingState>>) {
  const a = state.account;
  return {
    tier: state.tier,
    plan: a.plan,
    effective_plan: state.effective_plan,
    pending_plan: a.pending_plan,
    commission_bps: a.commission_bps,
    commission_percent: a.commission_bps / 100,
    subscription_price_cents: a.subscription_price_cents,
    currency: a.currency,
    has_card: state.has_card,
    card_brand: a.card_brand,
    card_last4: a.card_last4,
    subscription_status: a.subscription_status,
    subscription_paid_through: a.subscription_paid_through,
    accrued_cents: state.accrued_cents,
    collected_this_month_cents: state.collected_this_month_cents,
  };
}

export async function billingRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/portal/billing', staffOnly, async (req) => {
    const locationId = resolveLocationId(req, (req.query as Record<string, unknown>)?.location_id);
    return present(await getBillingState(locationId));
  });

  app.get('/api/portal/billing/card-config', staffOnly, async (req) => {
    resolveLocationId(req, (req.query as Record<string, unknown>)?.location_id);
    return platformCardConfig();
  });

  app.post('/api/portal/billing/card', staffOnly, async (req) => {
    // Card on file is an owner/manager action (C-10).
    requirePortalRole(req, 'owner', 'manager');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const locationId = resolveLocationId(req, body.location_id);
    // v0.8.12 (F9-3): a card saved on the demo location would be charged
    // on the platform's real Square account — refused for demo locations.
    await assertNotDemoLocation(locationId, 'Billing card changes');
    const sourceId = typeof body.source_id === 'string' ? body.source_id : '';
    const verificationToken =
      typeof body.verification_token === 'string' ? body.verification_token : undefined;
    // C3-2 Low: every other token surface is length-bounded (the card
    // source id is capped at 200 by regex in saveCardLocked); the
    // verification token was passed through unbounded.
    if (verificationToken && verificationToken.length > 512) {
      throw badRequest('verification_token is too long');
    }
    if (!sourceId) throw badRequest('source_id is required');
    await saveCard(locationId, { sourceId, verificationToken, email: req.portalUser?.email });
    return present(await getBillingState(locationId));
  });

  app.post('/api/portal/billing/plan', staffOnly, async (req) => {
    requirePortalRole(req, 'owner', 'manager');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const locationId = resolveLocationId(req, body.location_id);
    // v0.8.12 (F9-3): plan changes on the shared demo location are refused.
    await assertNotDemoLocation(locationId, 'Billing plan changes');
    const plan = body.plan;
    if (plan !== 'commission' && plan !== 'subscription') {
      throw badRequest('plan must be commission or subscription');
    }
    return present(await switchPlan(locationId, plan as BillingPlan));
  });

  // v0.9.0: service tier (starter/base) — settable during onboarding and
  // later from Billing settings. Switching applies the tier's default
  // price/commission pair to the billing account and flips the product
  // gates (device pairing + receipt printing follow locations.tier).
  app.post('/api/portal/billing/tier', staffOnly, async (req) => {
    requirePortalRole(req, 'owner', 'manager');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const locationId = resolveLocationId(req, body.location_id);
    await assertNotDemoLocation(locationId, 'Billing tier changes');
    if (!isLocationTier(body.tier)) {
      throw badRequest('tier must be starter or base');
    }
    // C3-2-4: an explicit reset_pricing asks setLocationTier to move the
    // account to the new tier's defaults even when its pricing was
    // customized; without it, negotiated pricing survives a tier change.
    // Tier changes are pricing events — audit them (C3-2-4(d)).
    const before = await getLocationTier(locationId);
    const state = await setLocationTier(locationId, body.tier, { resetPricing: body.reset_pricing === true });
    await logAudit({
      actorType: req.portalUser ? 'portal_user' : 'staff_token',
      actorId: req.portalUser?.id ?? null,
      role: req.portalUser?.role ?? null,
      ip: req.ip,
      action: 'billing.tier_changed',
      locationId,
      detail: `${before} -> ${body.tier}${body.reset_pricing === true ? ' (pricing reset to tier defaults)' : ''}`,
    });
    return present(state);
  });

  app.get('/api/portal/billing/history', staffOnly, async (req) => {
    const locationId = resolveLocationId(req, (req.query as Record<string, unknown>)?.location_id);
    return { entries: await billingHistory(locationId) };
  });
}
