'use strict';
const { join } = require('node:path');
const { Wallet } = require('./wallet');

const [action, id] = process.argv.slice(2);
if (!['grant', 'revoke'].includes(action) || !/^[0-9a-f-]{36}$/.test(id ?? '')) {
  console.error('Kullanım: npm run admin -- grant|revoke HESAP_KİMLİĞİ');
  process.exit(1);
}
const path = process.env.BUNNY_DB_PATH || join(__dirname, '..', 'data', 'bunny.sqlite');
const wallet = new Wallet(path, { recoverPending: false });
try {
  if (!wallet.setAdmin(id, action === 'grant')) {
    console.error('Hesap bulunamadı.');
    process.exitCode = 1;
  } else {
    console.log(action === 'grant' ? 'Yönetici yetkisi verildi.' : 'Yönetici yetkisi kaldırıldı.');
  }
} finally {
  wallet.db.close();
}
