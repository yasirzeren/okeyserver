'use strict';
const http = require('http');
const { Server } = require('socket.io');
const { RoomManager } = require('./rooms');
const { createWallet } = require('./wallet_backend');

const PORT = Number(process.env.PORT) || 3000;

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 1e5,
});
const walletUnavailable = { ok: false, message: 'Hesap servisi henüz yapılandırılmadı.' };
const resetSecret = process.env.BUNNY_RESET_SECRET;
const mailKey = process.env.BUNNY_BREVO_API_KEY;
const mailFrom = process.env.BUNNY_MAIL_FROM;
const resetUnavailable = { ok: false, message: 'Şifre sıfırlama e-postası henüz yapılandırılmadı.' };

async function sendResetEmail(email, code) {
  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': mailKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sender: { name: 'Bunny 101', email: mailFrom },
      to: [{ email }],
      subject: 'Bunny 101 şifre sıfırlama kodu',
      htmlContent: 'Şifre sıfırlama kodun: ' + code + '. Kod 10 dakika geçerli.',
    }),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error('Mail delivery failed');
}

let wallet;
let manager;
const authAttempts = new Map();
const clearAttempts = setInterval(() => authAttempts.clear(), 60000);
clearAttempts.unref();

function auth(socket, action) {
  const key = socket.handshake.address;
  const attempts = authAttempts.get(key) || 0;
  if (attempts >= 12 || (!authAttempts.has(key) && authAttempts.size >= 5000)) {
    return { ok: false, message: 'Çok fazla giriş denemesi. Bir dakika bekle.' };
  }
  authAttempts.set(key, attempts + 1);
  return action();
}

io.on('connection', (socket) => {
  // Basit hız sınırı: saniyede en fazla ~20 istek (30'luk kova).
  const bucket = { tokens: 30, last: Date.now() };
  const allow = () => {
    const now = Date.now();
    bucket.tokens = Math.min(30, bucket.tokens + ((now - bucket.last) / 1000) * 20);
    bucket.last = now;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  };

  const on = (event, handler) => {
    socket.on(event, async (data, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      if (!allow()) return reply({ ok: false, message: 'Çok hızlı işlem yapıyorsun.' });
      try {
        const body = data && typeof data === 'object' ? data : {};
        reply((await handler(body)) || { ok: true, message: '' });
      } catch (e) {
        console.error(`'${event}' işlenirken hata:`, e);
        reply({ ok: false, message: 'Sunucu hatası.' });
      }
    });
  };

  on('account_register', (d) => wallet ? auth(socket, () => wallet.register(d)) : walletUnavailable);
  on('account_login', (d) => wallet ? auth(socket, () => wallet.login(d)) : walletUnavailable);
  on('account_reset_send', (d) => wallet?.sendResetCode && resetSecret?.length >= 32 && mailKey && mailFrom
    ? auth(socket, () => wallet.sendResetCode(d, { secret: resetSecret, send: sendResetEmail }))
    : resetUnavailable);
  on('account_reset_confirm', (d) => wallet?.resetPassword && resetSecret?.length >= 32 && mailKey && mailFrom
    ? auth(socket, () => wallet.resetPassword(d, resetSecret))
    : resetUnavailable);
  on('account_profile', (d) => wallet?.account(d.token) ?? walletUnavailable);
  on('account_logout', (d) => wallet?.logout(d.token) ?? walletUnavailable);

  on('admin_lookup', (d) => wallet?.adminLookup(d.token, d.email) ?? walletUnavailable);
  on('admin_adjust', (d) => wallet?.adminAdjust(d.token, d) ?? walletUnavailable);

  on('list_rooms', () => manager.listRooms());
  on('create_room', (d) => manager.createRoom(socket, d));
  on('quick_play', (d) => manager.quickPlay(socket, d));
  on('join_room', (d) => manager.joinRoom(socket, d));
  on('resume', (d) => manager.resume(socket, d));
  on('set_ready', (d) => manager.setReady(socket, d));
  on('update_settings', (d) => manager.updateSettings(socket, d));
  on('start_game', () => manager.startGame(socket));
  on('leave_room', () => manager.leaveRoom(socket));
  on('chat', (d) => manager.chat(socket, d));
  on('draw', () => manager.draw(socket));
  on('take_side', () => manager.takeSide(socket));
  on('return_side', () => manager.returnSide(socket));
  on('preview_open', (d) => manager.previewOpen(socket, d));
  on('open_groups', (d) => manager.openGroups(socket, d));
  on('process_tile', (d) => manager.processTile(socket, d));
  on('return_processed_tile', (d) => manager.returnProcessedTile(socket, d));
  on('auto_process', () => manager.autoProcess(socket));
  on('process_pair', (d) => manager.processPair(socket, d));
  on('swap_okey', (d) => manager.swapOkey(socket, d));
  on('gather_open', () => manager.gatherOpen(socket));
  on('gather_tiles', () => manager.gatherTiles(socket));
  on('discard', (d) => manager.discard(socket, d));
  on('show_indicator', (d) => manager.showIndicator(socket, d));
  on('place_indicator', () => manager.placeIndicator(socket));
  on('return_lobby', () => manager.returnLobby(socket));
  on('ready_next', () => manager.readyNext(socket));

  socket.on('disconnect', () => manager.onDisconnect(socket));
});

async function start() {
  wallet = await createWallet();
  manager = new RoomManager(io, wallet);
  await manager.maintainWallet();
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Bunny 101 sunucusu ${PORT} portunda çalışıyor.`);
  });
}

start().catch((error) => {
  console.error('Bunny 101 başlatılamadı:', error.code || error.name);
  process.exit(1);
});
