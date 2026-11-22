'use strict';
const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const shell=(title,body)=>'<!doctype html><html lang="tr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+escape(title)+' · Bunny 101</title><style>body{font:17px system-ui;background:#10392e;color:#fff;margin:0;padding:24px}main{max-width:680px;margin:24px auto}a{color:#e6c475}label{display:block;margin:14px 0}input{box-sizing:border-box;width:100%;font:inherit;padding:12px;border:1px solid #c6a25c;border-radius:8px}button{font:inherit;padding:12px 20px;background:#c6a25c;color:#10392e;border:0;border-radius:8px}h1{font-size:28px}p{line-height:1.5}</style><main><h1>'+escape(title)+'</h1>'+body+'</main></html>';
function send(res,status,html) {
  res.writeHead(status,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"});res.end(html);
}
function deletionPage(message='') {
  return shell('Bunny 101 hesabını sil',`<p>Hesabın, giriş bilgilerin ve arkadaş bağlantıların kaldırılır. Havuç bakiyene erişim sona erer. Kimliksizleştirilmiş işlem kayıtları denetim ve tutarlılık için korunur.</p>${message?'<p role="alert">'+escape(message)+'</p>':''}<form method="post" action="/account-deletion"><label>E-posta<input name="email" type="email" required maxlength="254" autocomplete="username"></label><label>Şifre<input name="password" type="password" required maxlength="128" autocomplete="current-password"></label><label>Onaylamak için SİL yaz<input name="confirmation" required autocomplete="off" pattern="SİL"></label><button type="submit">Hesabımı kalıcı olarak sil</button></form><p><a href="/privacy">Gizlilik bilgileri</a></p>`);
}
function privacyPage() {
  const contact=process.env.BUNNY_SUPPORT_EMAIL || 'a.yasirzeren23@gmail.com';
  return shell('Bunny 101 gizlilik bilgileri',`<p>Bunny 101 hesap açarken e-posta adresini ve oyuncu adını, giriş için ise tek yönlü türetilmiş şifre doğrulama bilgisini tutar. Şifreler düz metin olarak saklanmaz.</p><p>Online oyun için masa, puan, havuç hareketleri, arkadaşlık ve davet bilgileri işlenir. Sohbet yalnız oyun hizmeti için kullanılır. Cihazda oturum, tema, ses ve son oyun tercihleri saklanır.</p><p>Sunucu Render, hesap veritabanı Neon üzerinde çalışır. Şifre sıfırlama e-postaları Brevo üzerinden gönderilir. Bu hizmetler bağlantı ve işletim kayıtları da işleyebilir. Oyunda reklam veya analiz SDK'sı bulunmaz.</p><p>Havuçlar oyun içi sanal birimdir. Bu sürümde satın alma, gerçek paraya çevirme ve para çekme özelliği yoktur.</p><p>Hesabını uygulamadaki Hesap bölümünden veya <a href="/account-deletion">bu sayfadan</a> silebilirsin. Hesap silinince iletişim ve giriş bilgileri kaldırılır, oturumlar kapatılır, arkadaş bağlantıları silinir. İşlem geçmişindeki kimliksizleştirilmiş kayıtlar korunur.</p>${contact?'<p>İletişim: <a href="mailto:'+escape(contact)+'">'+escape(contact)+'</a></p>':'<p>Yayın öncesinde geliştirici iletişim bilgisi ve veri saklama süreleri tamamlanmalıdır. Bu metin henüz mağaza gönderimi için onaylanmamış teknik taslaktır.</p>'}`);
}
const attempts=new Map();
const interval=setInterval(()=>attempts.clear(),60000);interval.unref();
async function publicPage(req,res,lifecycle) {
  const path=req.url?.split('?')[0];
  if(path==='/privacy' && req.method==='GET') {send(res,200,privacyPage());return true;}
  if(path!=='/account-deletion') return false;
  if(req.method==='GET') {send(res,200,deletionPage());return true;}
  if(req.method!=='POST') {res.writeHead(405,{'Allow':'GET, POST'});res.end();return true;}
  const address=req.socket.remoteAddress??'unknown';const count=attempts.get(address)??0;
  if(count>=8 || (!attempts.has(address)&&attempts.size>=5000)) {send(res,429,deletionPage('Çok fazla deneme. Bir dakika sonra tekrar dene.'));return true;}
  attempts.set(address,count+1);
  if(!req.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) {send(res,415,deletionPage('Geçersiz istek.'));return true;}
  const chunks=[];let length=0;
  for await(const chunk of req) {length+=chunk.length;if(length>4096) {send(res,413,deletionPage('İstek çok büyük.'));return true;}chunks.push(chunk);}
  const form=new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  const result=lifecycle ? await lifecycle.removeWithCredentials(form.get('email'),form.get('password'),form.get('confirmation')) : {ok:false,message:'Hesap hizmeti kullanılamıyor.'};
  send(res,result.ok?200:400,result.ok?shell('Hesabın silindi','<p>Hesabına ait giriş ve iletişim bilgileri kaldırıldı.</p>'):deletionPage(result.message));return true;
}
module.exports={publicPage,deletionPage,privacyPage};
