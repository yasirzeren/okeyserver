'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { dirname, join } = require('node:path');
const { io: connect } = require(join(dirname(require.resolve('socket.io')), '../client-dist/socket.io.js'));
const { healthPayload } = require('../src/health');
const { publicPage } = require('../src/public_pages');

test('health only exposes a validated public commit identifier', () => {
  assert.deepEqual(healthPayload({}), { ok: true });
  assert.deepEqual(healthPayload({ RENDER_GIT_COMMIT: 'A'.repeat(40) }), { ok: true, buildRevision: 'a'.repeat(40) });
  for (const value of ['secret-token', 'a'.repeat(39), 'g'.repeat(40), 'a'.repeat(40) + '\n']) {
    assert.deepEqual(healthPayload({ RENDER_GIT_COMMIT: value, DATABASE_URL: 'private' }), { ok: true });
  }
});

test('public support route serves the approved contact, privacy and deletion links for GET and HEAD', async () => {
  for (const method of ['GET', 'HEAD']) {
    let status, headers, body;
    const response = { writeHead(code, fields) { status = code; headers = fields; }, end(text) { body = text; } };
    assert.equal(await publicPage({ url: '/support', method }, response, null), true);
    assert.equal(status, 200);
    assert.equal(headers['Cache-Control'], 'no-store');
    if (method === 'HEAD') assert.equal(body, '');
    else {
      assert.match(body, /mailto:a\.yasirzeren23@gmail\.com/);
      assert.match(body, /href="\/privacy"/);
      assert.match(body, /href="\/account-deletion"/);
    }
  }
});

test('actual local server exposes revision and throttles a real client burst without crashing', { timeout: 15000 }, async t => {
  const reserved = http.createServer();
  await new Promise(resolve => reserved.listen(0, '127.0.0.1', resolve));
  const port = reserved.address().port;
  await new Promise(resolve => reserved.close(resolve));
  const processUnderTest = spawn(process.execPath, [join(__dirname, '../src/index.js')], {
    env: { ...process.env, PORT: String(port), BUNNY_DATABASE_URL: '', BUNNY_DB_PATH: ':memory:',
      RENDER: '', RENDER_GIT_COMMIT: 'b'.repeat(40), BUNNY_BREVO_API_KEY: '', BUNNY_MAIL_FROM: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let diagnostics = '';
  processUnderTest.stdout.on('data', () => {});
  processUnderTest.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-2000); });
  let client;
  t.after(async () => {
    client?.disconnect();
    if (processUnderTest.exitCode === null) {
      const exited = new Promise(resolve => processUnderTest.once('exit', resolve));
      processUnderTest.kill(); await exited;
    }
  });
  const url = 'http://127.0.0.1:' + port;
  let response;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (processUnderTest.exitCode !== null) throw Error('Local server exited: ' + diagnostics);
    try { response = await fetch(url + '/health'); if (response.ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(response?.ok, diagnostics);
  assert.deepEqual(await response.json(), { ok: true, buildRevision: 'b'.repeat(40) });
  assert.equal((await fetch(url + '/support')).status, 200);
  client = connect(url, { transports: ['websocket'], reconnection: false, forceNew: true });
  await new Promise((resolve, reject) => { client.once('connect', resolve); client.once('connect_error', reject); });
  const replies = await Promise.all(Array.from({ length: 80 }, () => new Promise((resolve, reject) => {
    client.timeout(3000).emit('list_rooms', {}, (error, result) => error ? reject(error) : resolve(result));
  })));
  assert.equal(replies.some(result => result.ok), true);
  assert.equal(replies.some(result => !result.ok && /Çok hızlı/.test(result.message)), true);
  assert.equal((await fetch(url + '/health')).status, 200);
});
