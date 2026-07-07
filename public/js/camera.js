// public/js/camera.js

// 1. Durum Değişkenleri
let localStream = null;
let socket = null;
const peerConnections = {}; // { dashboardSocketId: RTCPeerConnection }
let facingMode = 'environment'; // Varsayılan: Arka Kamera
let isStreaming = false;
let wakeLock = null;

// WebRTC için Ücretsiz STUN Sunucusu Yapılandırması
const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

// 2. DOM Elemanları
const videoElement = document.getElementById('camera-video');
const statusBadge = document.getElementById('status-badge');
const statusText = document.getElementById('status-text');
const deviceNameInput = document.getElementById('device-name');
const toggleCameraBtn = document.getElementById('toggle-camera-btn');
const startBtn = document.getElementById('start-btn');

// 3. Başlangıç İsmi Üretme
window.addEventListener('DOMContentLoaded', () => {
  let savedName = localStorage.getItem('phonecam-device-name');
  if (!savedName) {
    savedName = `Cihaz-${Math.floor(Math.random() * 9000 + 1000)}`;
    localStorage.setItem('phonecam-device-name', savedName);
  }
  deviceNameInput.value = savedName;

  // İsmin değiştiğinde yerel hafızaya kaydedilmesi
  deviceNameInput.addEventListener('input', () => {
    localStorage.setItem('phonecam-device-name', deviceNameInput.value.trim());
  });

  // Kamerayı ilk açışta çalıştır
  startLocalCamera();
});

// 4. Telefon Kamerasını Başlatma
async function startLocalCamera() {
  updateStatus('connecting', 'Kamera Başlatılıyor...');
  
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
  }

  // Ayna görüntüsü kontrolü: Ön kamerada video ters çevrilir, arka kamerada düz bırakılır.
  if (facingMode === 'user') {
    videoElement.style.transform = 'scaleX(-1)';
  } else {
    videoElement.style.transform = 'none';
  }

  try {
    const constraints = {
      video: {
        facingMode: facingMode,
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30 }
      },
      audio: false // Kamera sesini göndermek istemiyoruz
    };

    localStream = await navigator.mediaDevices.getUserMedia(constraints);
    videoElement.srcObject = localStream;
    
    // Eğer halihazırda aktif bir yayın varsa, yeni kamera görüntüsünü var olan WebRTC bağlantılarına enjekte et
    if (isStreaming) {
      updateActiveConnectionsStream();
    }

    toggleCameraBtn.disabled = false;
    
    if (isStreaming) {
      updateStatus('connected', 'Yayında');
    } else {
      updateStatus('idle', 'Kamera Hazır');
    }
  } catch (error) {
    console.error('Kamera erişim hatası:', error);
    updateStatus('error', 'Kameraya Erişilemedi');
    alert('Kamera izni verilmedi veya cihazda uyumlu kamera bulunamadı.');
  }
}

// 5. Durum Göstergesi Güncelleme
function updateStatus(state, message) {
  statusBadge.className = 'status-overlay';
  statusText.textContent = message;
  
  if (state === 'connected') {
    statusBadge.classList.add('connected');
  } else if (state === 'connecting') {
    statusBadge.classList.add('connecting');
  } else if (state === 'error') {
    statusBadge.classList.add('error');
  }
}

// 6. Ön/Arka Kamera Geçişi
toggleCameraBtn.addEventListener('click', () => {
  facingMode = (facingMode === 'environment') ? 'user' : 'environment';
  startLocalCamera();
});

// 7. Yayını Başlatma (Socket Bağlantısı)
startBtn.addEventListener('click', () => {
  if (isStreaming) return;

  const name = deviceNameInput.value.trim();
  if (!name) {
    alert('Lütfen geçerli bir kamera adı girin.');
    return;
  }

  isStreaming = true;
  startBtn.disabled = true;
  deviceNameInput.disabled = true;
  startBtn.textContent = 'Bağlanıyor...';
  
  updateStatus('connecting', 'Sunucuya Bağlanıyor...');

  // Socket.io sunucusuna bağlan
  socket = io();

  socket.on('connect', () => {
    console.log('Sunucuya bağlanıldı. ID:', socket.id);
    updateStatus('connected', 'Yayında');
    startBtn.textContent = 'Yayın Yapılıyor';
    startBtn.style.background = 'linear-gradient(135deg, var(--success), #059669)';
    
    // Kendini yayıncı olarak kaydet
    socket.emit('register-sender', { name });

    // Ekranın uyanık kalmasını sağla
    requestWakeLock();
  });

  socket.on('disconnect', () => {
    console.warn('Sunucu bağlantısı koptu.');
    updateStatus('error', 'Sunucu Bağlantısı Koptu');
    resetStreamUI();
  });

  // Karşı taraftan (Dashboard) gelen sinyalleşme mesajlarını dinle
  socket.on('signal', async (data) => {
    const { from, type, sdp, candidate } = data;

    if (type === 'offer') {
      console.log(`Dashboard (${from}) için bağlantı teklifi (offer) alındı.`);
      await handleOffer(from, sdp);
    } else if (type === 'candidate') {
      console.log(`Dashboard (${from}) için ICE adayı (candidate) alındı.`);
      handleCandidate(from, candidate);
    }
  });
});

// UI Sıfırlama
function resetStreamUI() {
  isStreaming = false;
  startBtn.disabled = false;
  deviceNameInput.disabled = false;
  startBtn.textContent = 'Yayını Başlat';
  startBtn.style.background = 'linear-gradient(135deg, var(--accent-cyan), #0891b2)';
  
  // Ekran kilidini kaldır
  releaseWakeLock();

  // Tüm WebRTC bağlantılarını kapat
  Object.keys(peerConnections).forEach((id) => {
    peerConnections[id].close();
    delete peerConnections[id];
  });
}

// 8. WebRTC Teklifi (Offer) İşleme ve Yanıt Gönderme
async function handleOffer(dashboardId, sdp) {
  // Eğer bu dashboard için önceden açılmış bir bağlantı varsa kapat
  if (peerConnections[dashboardId]) {
    peerConnections[dashboardId].close();
    delete peerConnections[dashboardId];
  }

  const pc = new RTCPeerConnection(rtcConfig);
  peerConnections[dashboardId] = pc;

  // Kamera akışındaki track'leri bağlantıya ekle
  if (localStream) {
    localStream.getTracks().forEach((track) => {
      pc.addTrack(track, localStream);
    });
  }

  // ICE adayları üretildikçe sunucuya yolla
  pc.onicecandidate = (event) => {
    if (event.candidate && socket) {
      socket.emit('signal', {
        to: dashboardId,
        type: 'candidate',
        candidate: event.candidate
      });
    }
  };

  // Bağlantı durumundaki değişiklikleri izle
  pc.onconnectionstatechange = () => {
    console.log(`WebRTC Bağlantı Durumu (${dashboardId}):`, pc.connectionState);
    if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
      pc.close();
      delete peerConnections[dashboardId];
      console.log(`WebRTC Bağlantısı Sonlandırıldı: ${dashboardId}`);
    }
  };

  try {
    // Uzak SDP'yi (Offer) ayarla
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    
    // Yanıt (Answer) üret
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    // Yanıtı sunucu üzerinden Dashboard'a yolla
    socket.emit('signal', {
      to: dashboardId,
      type: 'answer',
      sdp: pc.localDescription
    });
  } catch (err) {
    console.error('WebRTC offer işlenirken hata oluştu:', err);
  }
}

// 9. ICE Adayını Ekleme
function handleCandidate(dashboardId, candidate) {
  const pc = peerConnections[dashboardId];
  if (pc) {
    pc.addIceCandidate(new RTCIceCandidate(candidate))
      .catch((err) => console.error('ICE adayı eklenirken hata:', err));
  }
}

// 10. Kamera Değişince Aktif Yayınlardaki Akışı Değiştirme
function updateActiveConnectionsStream() {
  const videoTrack = localStream.getVideoTracks()[0];
  if (!videoTrack) return;

  Object.keys(peerConnections).forEach((dashboardId) => {
    const pc = peerConnections[dashboardId];
    const senders = pc.getSenders();
    // Video sender'ını bulup track'i değiştir
    const videoSender = senders.find(s => s.track && s.track.kind === 'video');
    if (videoSender) {
      videoSender.replaceTrack(videoTrack)
        .then(() => console.log(`[${dashboardId}] için yayınlanan kamera track'i güncellendi.`))
        .catch(err => console.error('Track değiştirilirken hata oluştu:', err));
    }
  });
}

// 11. Ekranın Kapanmasını Engelleme (Wake Lock)
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      console.log('Ekran Uyanık Kalma Kilidi (Wake Lock) Aktif!');
    }
  } catch (err) {
    console.warn(`Wake Lock etkinleştirilemedi: ${err.name}, ${err.message}`);
  }
}

function releaseWakeLock() {
  if (wakeLock !== null) {
    wakeLock.release()
      .then(() => {
        wakeLock = null;
        console.log('Wake Lock serbest bırakıldı.');
      });
  }
}

// Uygulama arka plana alınıp tekrar açıldığında kilidi tazele
document.addEventListener('visibilitychange', async () => {
  if (isStreaming && document.visibilityState === 'visible') {
    await requestWakeLock();
  }
});
