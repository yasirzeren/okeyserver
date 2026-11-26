'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PUBLISHER_ID, DEFAULT_UNITS, readAdmobUnits, validAdmobUnits, APP_ADS_TEXT } = require('../src/admob_config');
const { Market } = require('../src/market');
const { publicPage } = require('../src/public_pages');

test('public AdMob unit defaults, env overrides and explicit disable are validated', () => {
  assert.deepEqual(readAdmobUnits({}), {
    android: 'ca-app-pub-6003559032392528/9595839204',
    ios: 'ca-app-pub-6003559032392528/8446409063',
  });
  assert.equal(DEFAULT_UNITS.android.startsWith('ca-app-' + PUBLISHER_ID + '/'), true);
  const ios = 'ca-app-pub-6003559032392528/1234567890';
  assert.deepEqual(readAdmobUnits({ BUNNY_ADMOB_ANDROID_REWARDED_UNIT: '', BUNNY_ADMOB_IOS_REWARDED_UNIT: ios }), { ios });
  assert.deepEqual(readAdmobUnits({ BUNNY_ADMOB_ANDROID_REWARDED_UNIT: 'invalid' }), { ios: DEFAULT_UNITS.ios });
  assert.deepEqual(readAdmobUnits({ BUNNY_ADMOB_ANDROID_REWARDED_UNIT: 'ca-app-pub-3940256099942544/5224354917' }), { ios: DEFAULT_UNITS.ios });
  assert.deepEqual(readAdmobUnits({ BUNNY_ADMOB_ANDROID_REWARDED_UNIT: '', BUNNY_ADMOB_IOS_REWARDED_UNIT: '' }), {});
  assert.deepEqual(validAdmobUnits({ android: DEFAULT_UNITS.android, web: DEFAULT_UNITS.android, ios: '' }), { android: DEFAULT_UNITS.android });
  const wallet = { db: {} };
  assert.deepEqual(new Market(wallet).units, readAdmobUnits());
  assert.equal(new Market(wallet, { units: {} }).configured, false);
  assert.deepEqual(new Market(wallet, { units: { ios } }).units, { ios });
});

test('developer website serves the exact app-ads.txt seller record without HTML', async () => {
  const request = async (method, url = '/app-ads.txt') => {
    let status, headers, body;
    const handled = await publicPage({ method, url }, { writeHead: (code, value) => { status = code; headers = value; }, end: value => { body = value; } });
    return { handled, status, headers, body };
  };
  const get = await request('GET');
  assert.equal(get.handled, true);
  assert.equal(get.status, 200);
  assert.equal(get.headers['Content-Type'], 'text/plain; charset=utf-8');
  assert.equal(get.body, 'google.com, pub-6003559032392528, DIRECT, f08c47fec0942fa0\n');
  assert.equal(get.body, APP_ADS_TEXT);
  assert.equal((await request('GET', '/app-ads.txt?crawler=1')).body, get.body);
  const head = await request('HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.body, undefined);
  assert.equal((await request('POST')).status, 405);
  assert.equal((await request('GET', '/not-a-page')).handled, false);
});
