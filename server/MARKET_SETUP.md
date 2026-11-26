# Market ve ödüllü reklam ayarları

Android ve iOS için AdMob'da oluşturulan üretim ödüllü birimleri `src/admob_config.js`
içinde varsayılan olarak tanımlıdır. Bu kimlikler herkese açık entegrasyon
bilgileridir, şifre veya gizli API anahtarı değildir. İstemci geri çağrısı tek başına havuç veya emoji
kazandırmaz; Google SSV doğrulaması gerekir. Emoji satın alma ve 72 saatlik
kullanım açıktır.

Flutter'da aynı hesaba ait Android uygulama kimliği
`ca-app-pub-6003559032392528~3194936019`, ödüllü birim kimliği
`ca-app-pub-6003559032392528/9595839204` kullanılmalıdır.
iOS uygulama kimliği `ca-app-pub-6003559032392528~5273450819`, ödüllü birimi
`ca-app-pub-6003559032392528/8446409063` olmalıdır.
Sunucu ortam değişkenleri, dosyadaki varsayılanları geçersiz kılar:

- `BUNNY_ADMOB_ANDROID_REWARDED_UNIT=ca-app-pub-…/…`
- `BUNNY_ADMOB_IOS_REWARDED_UNIT=ca-app-pub-…/…`

Bir ortam değişkenini açıkça boş metne ayarlamak o platformdaki reklamları
kapatır. Geçersiz veya Google örnek birim kimlikleri de platformu etkinleştirmez.
Varsayılanı kullanmak için ilgili ortam değişkenini tanımlama.

Sunucu Google'ın örnek reklam yayıncısını (`3940256099942544`) kabul etmez.
AdMob'daki ödüllü birimlerin sunucu doğrulama URL'sini uygulama sunucusunun
HTTPS adresine `/admob/ssv` ekleyerek ayarla. Canlı sunucu için örnek adres:
`https://okeyserver-erdi.onrender.com/admob/ssv`.

Geliştirici sitesi `https://okeyserver-erdi.onrender.com` için
`/app-ads.txt` düz metin olarak şu satırı sunar:

```text
google.com, pub-6003559032392528, DIRECT, f08c47fec0942fa0
```

Mağaza kaydı hazırlanırken geliştirici web sitesi olarak bu alan adını ekle.
Google'ın dosyayı taraması/doğrulaması ve uygulama hazırlık incelemesi ayrıca
tamamlanmalıdır; birim oluşturmak tek başına tam reklam yayını anlamına gelmez.
Yayıncı hesabı değiştirilirse `src/admob_config.js` içindeki yayıncı kimliğini
ve istemcideki uygulama/birim kimliklerini birlikte güncelle.
Resmi biçim: https://developers.google.com/admob/android/app-ads

İstemci önce `market_ad_offer` ile hesaba, amaca ve reklam birimine bağlı bir
işlem açar. Yanıttaki `customData` reklam gösterilmeden önce SDK'nın SSV
ayarlarına yazılır. Doğrulama sunucusu Google'ın HTTPS anahtarlarını altı saat
önbellekler ve Google'ın Tink referansı gibi sorgu metnindeki yüzde kodlarını
bir kez çözerek ECDSA SHA256 imzasını doğrular. Parametre sırası ve gerçek
`+` karakterleri korunur; sorgu yeniden oluşturulmaz.
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

AdMob panelindeki URL doğrulamasında Özel veriler alanına
`bunny101-admob-setup-check` yaz. Bu işaretçi yalnızca Google'ın üretim veya
resmi test anahtarlarıyla doğrulanır ve cüzdana erişmeden bağlantıyı kontrol
eder. Gerçek reklam teklifleri yalnızca üretim anahtarlarıyla kabul edilir.

SDK veri açıklaması: https://developers.google.com/admob/android/privacy/play-data-disclosure

Hesap silme market envanterini, satın alma anahtarlarını, reklam tekliflerini
ve reklam işlem kayıtlarını temizler. Üretim reklamları açılmadan önce mağaza
veri güvenliği beyanı, uygulama gizlilik sayfası ve gerekiyorsa UMP izin akışı
kurulan SDK ve yayın bölgeleriyle tutarlı olmalıdır.
