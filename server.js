const express = require('express');
const https = require('https');
const socketIO = require('socket.io');
const selfsigned = require('selfsigned');
const os = require('os');
const path = require('path');

// 1. SSL Sertifikası Üretimi (Self-Signed)
// Mobil cihazlarda kameraya erişim için HTTPS zorunludur.
console.log('Geçici SSL Sertifikası oluşturuluyor...');
const attrs = [{ name: 'commonName', value: 'phonecam-local' }];
const pems = selfsigned.generate(attrs, { days: 365 });
const credentials = {
  key: pems.private,
  cert: pems.cert
};

const app = express();
const server = https.createServer(credentials, app);

// Soket zaman aşımı sınırlarını kaldırarak uzun süreli canlı akışları güvenceye alıyoruz
server.timeout = 0; 
server.headersTimeout = 0;
server.requestTimeout = 0;
server.keepAliveTimeout = 0;

const io = socketIO(server, {
  pingTimeout: 60000,   // Bağlantı kopmasını algılamak için 60 saniye tolerans
  pingInterval: 25000,  // Her 25 saniyede bir ping atarak bağlantıyı canlı tut
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Statik dosyaları sun (HTML, CSS, JS)
app.use(express.static(path.join(__dirname, 'public')));

// Sunucu IP adreslerini dönen API
app.get('/api/info', (req, res) => {
  res.json({
    ips: getLocalIPs(),
    port: PORT
  });
});

// 2. Aktif Cihazları Takip Etme
const senders = {}; // { socketId: { name: string } }
const receivers = new Set(); // Dashboard socket ID'leri

io.on('connection', (socket) => {
  console.log(`Yeni bağlantı: ${socket.id}`);

  // Telefon kendini yayıncı (sender) olarak kaydeder
  socket.on('register-sender', (data) => {
    const name = data.name || `Cihaz-${socket.id.substring(0, 4)}`;
    senders[socket.id] = { name };
    console.log(`Yayıncı Kaydoldu: [${name}] (ID: ${socket.id})`);

    // Mevcut tüm dashboard'lara yeni yayıncıyı bildir
    receivers.forEach((receiverId) => {
      io.to(receiverId).emit('sender-joined', { id: socket.id, name });
    });
  });

  // Bilgisayar kendini izleyici (receiver/dashboard) olarak kaydeder
  socket.on('register-receiver', () => {
    receivers.add(socket.id);
    console.log(`İzleyici (Dashboard) bağlandı: ${socket.id}`);

    // Yeni bağlanan dashboard'a o an aktif olan tüm yayıncıları bildir
    const activeSenders = Object.keys(senders).map((id) => ({
      id,
      name: senders[id].name
    }));
    socket.emit('existing-senders', activeSenders);
  });

  // WebRTC Sinyalleşme Mesajlarının İletilmesi (Offer, Answer, ICE Candidate)
  socket.on('signal', (data) => {
    const { to, ...signalData } = data;
    // Gönderenin kim olduğunu hedefe bildirmek için 'from' ekliyoruz
    io.to(to).emit('signal', {
      from: socket.id,
      ...signalData
    });
  });

  // Bağlantı Koptuğunda
  socket.on('disconnect', () => {
    console.log(`Bağlantı koptu: ${socket.id}`);

    if (senders[socket.id]) {
      const name = senders[socket.id].name;
      delete senders[socket.id];
      console.log(`Yayıncı ayrıldı: [${name}] (ID: ${socket.id})`);

      // Tüm dashboard'lara bu yayıncının ayrıldığını bildir
      receivers.forEach((receiverId) => {
        io.to(receiverId).emit('sender-left', { id: socket.id });
      });
    }

    if (receivers.has(socket.id)) {
      receivers.delete(socket.id);
      console.log(`İzleyici ayrıldı: ${socket.id}`);
    }
  });
});

// Yerel IP Adreslerini Bulma (Telefondan kolay bağlanabilmek için)
function getLocalIPs() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const name in interfaces) {
    for (const net of interfaces[name]) {
      // Sadece IPv4 ve harici (internal olmayan) adresleri al
      if (net.family === 'IPv4' && !net.internal) {
        addresses.push(net.address);
      }
    }
  }
  return addresses;
}

const PORT = 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log('\n==================================================');
  console.log(`  Kamera Yayını Sunucusu HTTPS üzerinde çalışıyor!`);
  console.log(`  Port: ${PORT}`);
  console.log('==================================================\n');
  
  console.log('  Bilgisayarınızdan izlemek için tarayıcıda açın:');
  console.log(`  -> https://localhost:${PORT}/dashboard.html`);
  console.log('\n  Telefonunuzdan bağlanmak için şu adresleri kullanın:');
  
  const ips = getLocalIPs();
  ips.forEach((ip) => {
    console.log(`  -> https://${ip}:${PORT}/camera.html`);
  });
  console.log('\n  (Not: Telefonunuz ve bilgisayarınız aynı Wi-Fi ağına bağlı olmalıdır)');
  console.log('==================================================\n');
});
