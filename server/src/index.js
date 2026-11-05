'use strict';
const http = require('http');
const { Server } = require('socket.io');
const { RoomManager } = require('./rooms');

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
const manager = new RoomManager(io);

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
    socket.on(event, (data, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      if (!allow()) return reply({ ok: false, message: 'Çok hızlı işlem yapıyorsun.' });
      try {
        const body = data && typeof data === 'object' ? data : {};
        reply(handler(body) || { ok: true, message: '' });
      } catch (e) {
        console.error(`'${event}' işlenirken hata:`, e);
        reply({ ok: false, message: 'Sunucu hatası.' });
      }
    });
  };

  on('create_room', (d) => manager.createRoom(socket, d));
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
  on('auto_process', () => manager.autoProcess(socket));
  on('process_pair', (d) => manager.processPair(socket, d));
  on('swap_okey', (d) => manager.swapOkey(socket, d));
  on('gather_open', () => manager.gatherOpen(socket));
  on('gather_tiles', () => manager.gatherTiles(socket));
  on('discard', (d) => manager.discard(socket, d));
  on('show_indicator', (d) => manager.showIndicator(socket, d));
  on('place_indicator', () => manager.placeIndicator(socket));
  on('ready_next', () => manager.readyNext(socket));

  socket.on('disconnect', () => manager.onDisconnect(socket));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Bunny 101 sunucusu ${PORT} portunda çalışıyor.`);
});