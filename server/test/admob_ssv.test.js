'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync, sign } = require('node:crypto');
const { AdmobVerifier, createAdmobHandler, KEY_URL, SETUP_CHECK } = require('../src/admob_ssv');
const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const secondPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pem = pair.publicKey.export({ type: 'spki', format: 'pem' });
const pem2 = secondPair.publicKey.export({ type: 'spki', format: 'pem' });
const query = 'ad_network=123&ad_unit=1234567890&custom_data=' + 'a'.repeat(48) + '&reward_amount=1&reward_item=carrots&timestamp=1795672800000&transaction_id=abcdef&user_id=account%2Bbound';
const signed = (data = query, keyId = 1, key = pair.privateKey) => '/admob/ssv?' + data + '&signature=' + sign('sha256', Buffer.from(data), key).toString('base64url') + '&key_id=' + keyId;

test('AdMob checks exact raw ECDSA signature, duplicate fields and cached rotated Google keys', async () => {
  let requests = 0, now = 0, rotate = false;
  const verifier = new AdmobVerifier({ now: () => now, fetchKeys: async (url, options) => {
    assert.equal(url, KEY_URL); assert.equal(options.redirect, 'error'); requests++;
    return { ok: true, text: async () => JSON.stringify({ keys: rotate ? [{ keyId: 2, pem: pem2 }] : [{ keyId: 1, pem }] }) };
  } });
  const result = await verifier.verify(signed());
  assert.equal(result.offerId, 'a'.repeat(48));
  assert.equal(result.transactionId, 'abcdef');
  await verifier.verify(signed());
  assert.equal(requests, 1);
  const paddedSignature = sign('sha256', Buffer.from(query), pair.privateKey).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
  await verifier.verify('/admob/ssv?' + query + '&signature=' + encodeURIComponent(paddedSignature) + '&key_id=1');
  await assert.rejects(verifier.verify(signed().replace('ad_unit=1234567890', 'ad_unit=0000000000')));
  await assert.rejects(verifier.verify(signed().replace('account%2Bbound', 'account%2bbound')));
  await assert.rejects(verifier.verify(signed(query + '&transaction_id=other')));
  await assert.rejects(verifier.verify(signed() + '&extra=1'));
  await assert.rejects(verifier.verify(signed(query, 1, secondPair.privateKey)));
  rotate = true; now = 61000;
  assert.equal((await verifier.verify(signed(query, 2, secondPair.privateKey))).transactionId, 'abcdef');
  assert.equal(requests, 2);
  now += 6 * 3600000;
  await verifier.verify(signed(query, 2, secondPair.privateKey));
  assert.equal(requests, 3);
});

test('SSV HTTP handler fails closed and grants only a verified callback', async () => {
  let grants = 0;
  const market = { configured: true, applyVerified: async data => { grants++; assert.equal(data.offerId, 'a'.repeat(48)); return { ok: true }; } };
  const verifier = new AdmobVerifier({ fetchKeys: async () => ({ ok: true, text: async () => JSON.stringify({ keys: [{ keyId: 1, pem }] }) }) });
  const handler = createAdmobHandler(market, verifier);
  const request = async (url, method = 'GET', callback = handler) => {
    let status, body;
    const handled = await callback({ url, method }, { writeHead: code => { status = code; }, end: value => { body = value; } });
    return { handled, status, body };
  };
  assert.equal((await request(signed().replace('abcdef', 'tampered'))).status, 400);
  assert.equal(grants, 0);
  assert.equal((await request(signed())).status, 200);
  assert.equal(grants, 1);
  assert.equal((await request(signed(), 'POST')).status, 405);
  assert.equal((await request('/privacy')).handled, false);
  assert.equal((await request(signed(), 'GET', createAdmobHandler({ configured: false, applyVerified: market.applyVerified }))).status, 503);
  const down = new AdmobVerifier({ fetchKeys: async () => { throw Error('network'); } });
  assert.equal((await request(signed(), 'GET', createAdmobHandler(market, down))).status, 503);
  assert.equal(grants, 1);
});

test('signed AdMob console setup check is a no-op before and after unit setup', async () => {
  let grants = 0;
  const verifier = new AdmobVerifier({ fetchKeys: async () => ({ ok: true, text: async () => JSON.stringify({ keys: [{ keyId: 1, pem }] }) }) });
  const check = signed(query.replace('a'.repeat(48), SETUP_CHECK));
  const request = async (handler, url) => {
    let status, body;
    await handler({ url, method: 'GET' }, { writeHead: code => { status = code; }, end: value => { body = JSON.parse(value); } });
    return { status, body };
  };
  for (const market of [null, { configured: false, applyVerified: () => { grants++; } }, { configured: true, applyVerified: () => { grants++; return { ok: false }; } }]) {
    const handler = createAdmobHandler(market, verifier);
    assert.deepEqual(await request(handler, check), { status: 200, body: { ok: true, verificationOnly: true } });
    assert.equal((await request(handler, check.replace('reward_amount=1', 'reward_amount=9'))).status, 400);
    assert.equal((await request(handler, '/admob/ssv?custom_data=' + SETUP_CHECK)).status, 400);
  }
  assert.equal(grants, 0);
  const configured = createAdmobHandler({ configured: true, applyVerified: () => { grants++; return { ok: false }; } }, verifier);
  assert.equal((await request(configured, signed(query.replace('a'.repeat(48), SETUP_CHECK + '-other')))).status, 400);
  assert.equal(grants, 1);
});
