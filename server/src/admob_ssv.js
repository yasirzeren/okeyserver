'use strict';
const { createPublicKey, verify } = require('node:crypto');

// Fixed HTTPS trust source. Tests inject a transport on an individual verifier;
// no environment option can replace Google's production signing keys.
const KEY_URL = 'https://www.gstatic.com/admob/reward/verifier-keys.json';
const CACHE_MS = 6 * 3600000;
class VerificationError extends Error {}
class KeyServiceError extends Error {}

class AdmobVerifier {
  constructor({ fetchKeys = fetch, now = Date.now } = {}) {
    this.fetchKeys = fetchKeys;
    this.now = now;
    this.keys = new Map();
    this.fetchedAt = -Infinity;
    this.loading = null;
  }
  async refresh() {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        const response = await this.fetchKeys(KEY_URL, { redirect: 'error', signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw new Error('key response');
        const raw = await response.text();
        if (Buffer.byteLength(raw) > 256000) throw new Error('key size');
        const body = JSON.parse(raw), keys = new Map();
        if (!Array.isArray(body.keys) || body.keys.length > 100) throw new Error('key format');
        for (const row of body.keys) {
          if (!/^\d{1,20}$/.test(String(row.keyId))) throw new Error('key id');
          const key = createPublicKey(row.pem);
          if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('key type');
          keys.set(String(row.keyId), key);
        }
        if (!keys.size) throw new Error('empty keys');
        this.keys = keys;
        this.fetchedAt = this.now();
      } catch { throw new KeyServiceError('Signing keys unavailable'); }
    })();
    try { await this.loading; } finally { this.loading = null; }
  }
  async verify(rawUrl) {
    if (typeof rawUrl !== 'string' || rawUrl.length > 16384) throw new VerificationError('Invalid callback');
    const query = rawUrl.slice(rawUrl.indexOf('?') + 1);
    // Verify the untouched query prefix. Decoding and re-encoding before checking
    // would change the bytes signed by AdMob (including percent escapes/order).
    const match = /^(.*)&signature=([^&]+)&key_id=(\d{1,20})$/.exec(query);
    if (!match || !match[1]) throw new VerificationError('Invalid signature parameters');
    const params = new URLSearchParams(query), seen = new Set();
    for (const [name] of params) {
      if (seen.has(name)) throw new VerificationError('Duplicate parameter');
      seen.add(name);
    }
    const signature = params.get('signature');
    if (!/^[A-Za-z0-9_-]+={0,2}$/.test(signature ?? '')) throw new VerificationError('Invalid signature encoding');
    if (this.now() - this.fetchedAt >= CACHE_MS) await this.refresh();
    if (!this.keys.has(match[3]) && this.now() - this.fetchedAt >= 60000) await this.refresh();
    const key = this.keys.get(match[3]);
    if (!key || !verify('sha256', Buffer.from(match[1], 'utf8'), key, Buffer.from(signature, 'base64url'))) throw new VerificationError('Invalid signature');
    const timestamp = Number(params.get('timestamp'));
    if (!/^\d+$/.test(params.get('timestamp') ?? '') || !Number.isSafeInteger(timestamp)) throw new VerificationError('Invalid timestamp');
    return { offerId: params.get('custom_data'), transactionId: params.get('transaction_id'), adUnit: params.get('ad_unit'), timestamp };
  }
}

function createAdmobHandler(market, verifier = new AdmobVerifier()) {
  return async (req, res) => {
    if (req.url?.split('?')[0] !== '/admob/ssv') return false;
    const reply = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'GET') { reply(405, { ok: false }); return true; }
    if (!market?.configured) { reply(503, { ok: false }); return true; }
    try {
      const signed = await verifier.verify(req.url);
      const result = await market.applyVerified(signed);
      reply(result.ok ? 200 : 400, { ok: !!result.ok });
    } catch (error) {
      reply(error instanceof VerificationError ? 400 : 503, { ok: false });
    }
    return true;
  };
}

module.exports = { AdmobVerifier, createAdmobHandler, VerificationError, KeyServiceError, KEY_URL };
