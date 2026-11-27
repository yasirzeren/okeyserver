'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { RoomManager } = require('../src/rooms');
const { privacyPage, deletionPage } = require('../src/public_pages');
test('public privacy and deletion describe retained pseudonymous ledger accurately', () => {
  for (const page of [privacyPage(), deletionPage()]) {
    assert.match(page, /tamamen anonim/);
    assert.match(page, /otomatik süreli silme/);
    assert.doesNotMatch(page, /Kimliksizleştirilmiş işlem kayıtları/);
  }
});
test('inappropriate room names are rejected before any room or wallet hold exists', async (t) => {
  const manager = new RoomManager({ to: () => ({ emit() {} }) }, {
    authenticate: async () => 'user', profile: async () => ({ id: 'user', name: 'Oyuncu', carrots: 1000 }),
    hold: async () => { throw Error('Must not debit'); }, settle: async () => true,
  });
  t.after(() => clearInterval(manager.sweeper));
  const reply = await manager.createRoom({ id:'socket', data:{} }, { accountToken:'token', roomName:'siktir', password:'password' });
  assert.equal(reply.ok, false);
  assert.match(reply.message, /topluluk/);
  assert.equal(manager.rooms.size, 0);
});
