'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync, sign } = require('node:crypto');
const { AdmobVerifier, createAdmobHandler, KEY_URL, SETUP_KEY_URL, SETUP_CHECK } = require('../src/admob_ssv');
const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const secondPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pem = pair.publicKey.export({ type: 'spki', format: 'pem' });
const pem2 = secondPair.publicKey.export({ type: 'spki', format: 'pem' });
const query = 'ad_network=123&ad_unit=1234567890&custom_data=' + 'a'.repeat(48) + '&reward_amount=1&reward_item=carrots&timestamp=1795672800000&transaction_id=abcdef&user_id=account%2Bbound';
const signed = (data = query, keyId = 1, key = pair.privateKey) => '/admob/ssv?' + data + '&signature=' + sign('sha256', Buffer.from(decodeURIComponent(data)), key).toString('base64url') + '&key_id=' + keyId;

test('AdMob checks canonical ECDSA content, duplicate fields and cached rotated Google keys', async () => {
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
  const paddedSignature = sign('sha256', Buffer.from(decodeURIComponent(query)), pair.privateKey).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
  await verifier.verify('/admob/ssv?' + query + '&signature=' + encodeURIComponent(paddedSignature) + '&key_id=1');
  await assert.rejects(verifier.verify(signed().replace('ad_unit=1234567890', 'ad_unit=0000000000')));
  assert.equal((await verifier.verify(signed().replace('account%2Bbound', 'account%2bbound'))).offerId, 'a'.repeat(48));
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

test('AdMob percent decoding matches the official Tink encoded-URL fixture and preserves plus', async () => {
  // Official fixture: testShouldVerifyWithEncodedUrl signs decoded UTF-8:
  // https://github.com/tink-crypto/tink-java-apps/blob/main/rewardedads/src/test/java/com/google/crypto/tink/apps/rewardedads/RewardedAdsVerifierTest.java
  const verifier = new AdmobVerifier({ fetchKeys: async () => ({ ok: true, text: async () => JSON.stringify({ keys: [{ keyId: 1, pem }] }) }) });
  const encoded = query + '&foo=hello%20world&bar=user%40gmail.com';
  assert.equal((await verifier.verify(signed(encoded))).offerId, 'a'.repeat(48));
  const turkish = query.replace('reward_item=carrots', 'reward_item=' + encodeURIComponent('ödül hakkı'));
  assert.equal((await verifier.verify(signed(turkish))).offerId, 'a'.repeat(48));
  const plus = query + '&foo=hello+world';
  await verifier.verify(signed(plus));
  await assert.rejects(verifier.verify(signed(plus).replace('hello+world', 'hello%20world')));
  // Encoding aliases are the same signed content; a second decode is forbidden.
  await assert.rejects(verifier.verify(signed(encoded).replace('hello%20world', 'hello%2520world')));
  await assert.rejects(verifier.verify(signed(encoded).replace('hello%20world', 'hello%ZZworld')));
  // The previous raw-escaped signing interpretation must not be accepted.
  const rawSignature = sign('sha256', Buffer.from(encoded), pair.privateKey).toString('base64url');
  await assert.rejects(verifier.verify('/admob/ssv?' + encoded + '&signature=' + rawSignature + '&key_id=1'));
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
  assert.equal((await request(signed(), 'GET', createAdmobHandler({ configured: false, applyVerified: market.applyVerified }, verifier))).status, 503);
  const down = new AdmobVerifier({ fetchKeys: async () => { throw Error('network'); } });
  assert.equal((await request(signed(), 'GET', createAdmobHandler(market, down))).status, 503);
  assert.equal(grants, 1);
});

test('signed AdMob console setup check is a no-op before and after unit setup', async (t) => {
  t.mock.method(console, 'warn', () => {});
  let grants = 0;
  const verifier = new AdmobVerifier({ fetchKeys: async () => ({ ok: true, text: async () => JSON.stringify({ keys: [{ keyId: 1, pem }] }) }) });
  const check = signed(query.replace('a'.repeat(48), SETUP_CHECK));
  const request = async (handler, url) => {
    let status, body;
    await handler({ url, method: 'GET' }, { writeHead: code => { status = code; }, end: value => { body = JSON.parse(value); } });
    return { status, body };
  };
  for (const market of [null, { configured: false, applyVerified: () => { grants++; } }, { configured: true, applyVerified: () => { grants++; return { ok: false }; } }]) {
    const handler = createAdmobHandler(market, verifier, verifier);
    assert.deepEqual(await request(handler, check), { status: 200, body: { ok: true, verificationOnly: true } });
    assert.equal((await request(handler, check.replace('reward_amount=1', 'reward_amount=9'))).status, 400);
    assert.equal((await request(handler, '/admob/ssv?custom_data=' + SETUP_CHECK)).status, 400);
  }
  assert.equal(grants, 0);
  const configured = createAdmobHandler({ configured: true, applyVerified: () => { grants++; return { ok: false }; } }, verifier);
  assert.equal((await request(configured, signed(query.replace('a'.repeat(48), SETUP_CHECK + '-other')))).status, 400);
  assert.equal(grants, 1);
});

test('SSV setup success logs are signature-gated, bounded and contain no callback identifiers', async t => {
  const success = t.mock.method(console, 'info', () => {});
  t.mock.method(console, 'warn', () => {});
  const verifier = new AdmobVerifier({ fetchKeys: async () => ({ ok: true, text: async () => JSON.stringify({ keys: [{ keyId: 1, pem }] }) }) });
  const handler = createAdmobHandler(null, verifier, verifier);
  const check = signed(query.replace('a'.repeat(48), SETUP_CHECK));
  const request = url => handler({ url, method: 'GET' }, { writeHead() {}, end() {} });
  await request(check.replace('transaction_id=', 'transaction_id=tampered'));
  assert.equal(success.mock.calls.length, 0);
  await request(check);
  await request(check);
  assert.equal(success.mock.calls.length, 1);
  assert.deepEqual(success.mock.calls[0].arguments, ['AdMob SSV setup verified']);
});

test('official test key source can only acknowledge setup marker and cannot grant offers', async (t) => {
  const warnings = t.mock.method(console, 'warn', () => {});
  let testFetches = 0, grants = 0;
  const prod = new AdmobVerifier({ fetchKeys: async url => {
    assert.equal(url, KEY_URL);
    return { ok: true, text: async () => JSON.stringify({ keys: [{ keyId: 1, pem }] }) };
  } });
  const setup = new AdmobVerifier({ setup: true, fetchKeys: async url => {
    assert.equal(url, SETUP_KEY_URL); testFetches++;
    return { ok: true, text: async () => JSON.stringify({ keys: [{ keyId: 2, pem: pem2 }] }) };
  } });
  const handler = createAdmobHandler({ configured: true, applyVerified: () => { grants++; return { ok: true }; } }, prod, setup);
  const request = async url => {
    let status, body;
    await handler({ url, method: 'GET' }, { writeHead: code => { status = code; }, end: value => { body = JSON.parse(value); } });
    return { status, body };
  };
  // An otherwise real offer signed with Google's test key must not even fetch
  // the test keys, much less reach the market or grant a balance change.
  assert.equal((await request(signed(query, 2, secondPair.privateKey))).status, 400);
  assert.equal(testFetches, 0);
  const probe = signed(query.replace('a'.repeat(48), SETUP_CHECK), 2, secondPair.privateKey);
  assert.deepEqual(await request(probe), { status: 200, body: { ok: true, verificationOnly: true } });
  assert.equal(testFetches, 1);
  assert.equal((await request(probe.replace('reward_amount=1', 'reward_amount=9'))).status, 400);
  assert.equal((await request(signed(query.replace('a'.repeat(48), SETUP_CHECK + '-other'), 2, secondPair.privateKey))).status, 400);
  assert.equal(grants, 0);
  assert.equal(warnings.mock.calls.length, 1);
  assert.deepEqual(warnings.mock.calls[0].arguments, ['AdMob setup verification:', 'Invalid signature']);
  assert.equal((await request(signed())).status, 200);
  assert.equal(grants, 1);
});
