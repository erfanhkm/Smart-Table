// TouchBistro adapter scaffold (v0.3).
//
// Status 2026-10-15: SCAFFOLD ONLY — not verified, not usable.
// TouchBistro exposes a private, partner-only integration API: no public
// docs, no self-serve sandbox, no way to mint keys. Partner email sent
// 2026-10-15 to integratedpartners@touchbistro.com; approval + commercial
// terms + provisioned (monitored) API keys are required before any call can
// work. Every method below throws until partner access is granted.
//
// Research notes for the real implementation (unverified until approval):
// - Partner API reportedly uses OAuth 2.0 client-credentials per venue
//   (client id + secret -> Bearer token); claimed base
//   https://api.touchbistro.com/ — CONFIRM at integration time.
// - Reported entities: Venue / Order (Check) / Selection (line item) /
//   Payment with read/write; webhook availability "varies by partner tier"
//   (assume polling fallback until confirmed).
// - Legacy read-only Cloud API (2016, reporting only, closed bills):
//   https://cloud.touchbistro.com/api/v1/ with ?authentication_token=
//   — NOT sufficient for Smart Table (no open checks, no payment writes).
//
// When keys arrive: implement listOpenChecks/getCheckDetail/
// recordExternalPayment against the provisioned endpoints, add webhook
// verification per TouchBistro's spec, then verify with a live sandbox
// venue the same way Clover was verified (scripts/verify-clover.ts pattern).
import {
  PosAdapter,
  PosCheckDetail,
  PosCredentials,
  PosEvent,
  PosOpenCheckSummary,
  PosPaymentResult,
} from './types.js';

const NOT_READY =
  'TouchBistro adapter is not available yet: integration-partner approval pending ' +
  '(request sent 2026-10-15 to integratedpartners@touchbistro.com).';

function notReady(): never {
  throw new Error(NOT_READY);
}

export const touchbistroAdapter: PosAdapter = {
  posType: 'touchbistro',

  async listOpenChecks(_locationRef: string, _token?: string): Promise<PosOpenCheckSummary[]> {
    return notReady();
  },

  async getCheckDetail(_checkId: string, _token?: string): Promise<PosCheckDetail> {
    return notReady();
  },

  async recordExternalPayment(
    _checkId: string,
    _amountCents: number,
    _currency: string,
    _method: string,
    _idempotencyKey: string,
    _token?: string,
  ): Promise<PosPaymentResult> {
    return notReady();
  },

  async registerWebhooks(_locationRef: string, _webhookUrl: string, _token?: string): Promise<void> {
    return notReady();
  },

  async parseWebhookEvent(_args: {
    headers: Record<string, string | string[] | undefined>;
    rawBody: string;
    body: unknown;
    notificationUrl: string;
  }): Promise<PosEvent[]> {
    return notReady();
  },

  getOAuthConnectUrl(_state: string): string {
    return notReady();
  },

  async handleOAuthCallback(_args: { code: string; merchantRef?: string }): Promise<PosCredentials> {
    return notReady();
  },
};
