# Market ve ödüllü reklam ayarları

Reklamlar varsayılan olarak kapalıdır. Yapılandırma olmadan reklam izleme ve
ödül kaydetme işlemleri sunucuda reddedilir; istemci geri çağrısı tek başına
havuç veya emoji kazandırmaz. Emoji satın alma ve 72 saatlik kullanım açıktır.

AdMob hesabı ve uygulamalar oluşturulduğunda Android/iOS uygulama kimlikleri
Flutter derlemesinde ayarlanır. Üretim ödüllü reklam birimi kimliklerini ilgili
sunucu ortam değişkenlerine ekle:

- `BUNNY_ADMOB_ANDROID_REWARDED_UNIT=ca-app-pub-…/…`
- `BUNNY_ADMOB_IOS_REWARDED_UNIT=ca-app-pub-…/…`

Sunucu Google'ın örnek reklam yayıncısını (`3940256099942544`) kabul etmez.
AdMob'daki ödüllü birimlerin sunucu doğrulama URL'sini uygulama sunucusunun
HTTPS adresine `/admob/ssv` ekleyerek ayarla. Canlı sunucu için örnek adres:
`https://okeyserver-erdi.onrender.com/admob/ssv`.

İstemci önce `market_ad_offer` ile hesaba, amaca ve reklam birimine bağlı bir
işlem açar. Yanıttaki `customData` reklam gösterilmeden önce SDK'nın SSV
ayarlarına yazılır. Doğrulama sunucusu Google'ın HTTPS anahtarlarını altı saat
önbellekler ve değiştirilmemiş sorgu metninin ECDSA SHA256 imzasını doğrular.
Geçerli imza, işlem kimliği, reklam birimi, süre ve günlük hak eşleştiğinde
ödül atomik kaydedilir. Aynı callback yeniden geldiğinde ödül tekrarlanmaz.

Reklam yüklenemez/gösterilemezse `market_ad_cancel` işlemi günlük hak harcamadan
kapatır. SDK ödül sinyalinden sonra istemci `market_ad_status` ile
`completed` sonucunu bekler; SDK sinyalini para olarak kabul etmez.
Tamamlanmış işlemi iptal etmek kazanılmış ödülü kaldırmaz. İşlemler en çok
10 dakika ve günün Türkiye saatiyle 12.00 sınırına kadar geçerlidir.

Havuç ve emoji reklamları aynı günlük beş hakkı paylaşır. Havuç seçilen hakkın
sırasına göre 200/250/300/350/400 verir; beşini havuç için kullanan 1500 alır.
Emoji, aynı günlük dönem içinde iki doğrulanmış gösterim gerektirir.
İlk gösterim havuç harcatmaz; ikinci gösterim 72 saatlik emojiyi açar.
Başlangıç hediyesi 1000, günlük hediye 500 havuçtur.

SSV doğrulaması: https://developers.google.com/admob/android/ssv

SDK veri açıklaması: https://developers.google.com/admob/android/privacy/play-data-disclosure

Hesap silme market envanterini, satın alma anahtarlarını, reklam tekliflerini
ve reklam işlem kayıtlarını temizler. Üretim reklamları açılmadan önce mağaza
veri güvenliği beyanı, uygulama gizlilik sayfası ve gerekiyorsa UMP izin akışı
kurulan SDK ve yayın bölgeleriyle tutarlı olmalıdır.
