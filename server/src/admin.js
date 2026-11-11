'use strict';
const { createWallet } = require('./wallet_backend');

const [action, id] = process.argv.slice(2);
if (!['grant', 'revoke'].includes(action) || !/^[0-9a-f-]{36}$/.test(id ?? '')) {
  console.error('Kullanım: npm run admin -- grant|revoke HESAP_KİMLİĞİ');
  process.exit(1);
}
async function main() {
  const wallet = await createWallet({ recoverPending: false });
  if (!wallet) throw new Error('Hesap veritabanı yapılandırılmamış.');
  try {
    if (!await wallet.setAdmin(id, action === 'grant')) {
      console.error('Hesap bulunamadı.');
      process.exitCode = 1;
    } else {
      console.log(action === 'grant' ? 'Yönetici yetkisi verildi.' : 'Yönetici yetkisi kaldırıldı.');
    }
  } finally {
    await wallet.db.close();
  }
}
main().catch(() => {
  console.error('Yönetici işlemi tamamlanamadı.');
  process.exitCode = 1;
});
