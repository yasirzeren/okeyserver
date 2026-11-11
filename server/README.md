# Bunny 101 sunucusu

Yerelde Node.js 22.13+ ve SQLite ile çalışır. Oyun sunucusunu başlatmak için
server klasöründe npm ci ve npm start çalıştır.

## Ücretsiz Render + Neon

1. Neon'da ücretsiz PostgreSQL projesi aç.
2. Render servisinde planı Free bırak. Ortam değişkenlerine BUNNY_DATABASE_URL
   ekle ve Neon bağlantı adresini bu gizli değişkene gir. Bağlantı adresini
   GitHub'a, Flutter derlemesine veya sohbete koyma.
3. Güncel kodu dağıt. Sunucu tablo ve indeksleri ilk açılışta oluşturur.
4. Flutter istemcisini BUNNY_ACCOUNT_SERVER olarak
   https://okeyserver-erdi.onrender.com seçerek derle.
5. Oyundan hesap oluştur. Yönetici yetkisi için, aynı BUNNY_DATABASE_URL
   değişkeni yerel terminalde güvenli biçimde ayarlandıktan sonra server
   klasöründe npm run admin -- grant HESAP_KIMLIGI çalıştır. Bu komut
   Render'a SSH erişimi gerektirmez.

SQLite ve PostgreSQL ayrı veritabanlarıdır. Boş bir PostgreSQL projesinde
canlı hesaplar ilk kayıtla oluşur. Maçlar oyun sunucusunun belleğinde
tutulur. Yarım kalan PostgreSQL maçlarının giriş ücreti, maçın geçerlilik
süresi dolup sunucu bakım işlemini çalıştırınca iade edilir.