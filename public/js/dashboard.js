// public/js/dashboard.js

// 1. Durum Değişkenleri
let socket = null;
const peerConnections = {}; // { phoneSocketId: RTCPeerConnection }
let cameraCount = 0;

// WebRTC STUN Yapılandırması
const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

// 2. DOM Elemanları
const cameraGrid = document.getElementById('camera-grid');
const emptyState = document.getElementById('empty-state');
const cameraCountBadge = document.getElementById('camera-count');
const cameraUrlDisplay = document.getElementById('camera-url-display');

// 3. Başlangıç İşlemleri
window.addEventListener('DOMContentLoaded', () => {
  // Telefonların gireceği URL'leri sunucudan alıp göster
  fetch('/api/info')
    .then(res => res.json())
    .then(data => {
      cameraUrlDisplay.innerHTML = '';
      if (!data.ips || data.ips.length === 0) {
        cameraUrlDisplay.textContent = `${window.location.origin}/camera.html`;
        return;
      }
      data.ips.forEach(ip => {
        const url = `https://${ip}:${data.port}/camera.html`;
        cameraUrlDisplay.innerHTML += `<div><a href="${url}" target="_blank" style="color: var(--accent-cyan); text-decoration: underline;">${url}</a></div>`;
      });
    })
    .catch(err => {
      console.error('IP bilgileri alınamadı:', err);
      cameraUrlDisplay.textContent = `${window.location.origin}/camera.html`;
    });

  // Socket Sunucusuna Bağlan
  socket = io();

  socket.on('connect', () => {
    console.log('Dashboard sunucuya bağlandı. ID:', socket.id);
    // Kendini izleyici olarak kaydet
    socket.emit('register-receiver');
  });

  // Sistemdeki mevcut yayıncıları al (İlk girişte)
  socket.on('existing-senders', (senders) => {
    console.log('Mevcut aktif yayıncılar alındı:', senders);
    senders.forEach((sender) => {
      initiateWebRTCConnection(sender.id, sender.name);
    });
  });

  // Yeni bir yayıncı katıldığında
  socket.on('sender-joined', (sender) => {
    console.log(`Yeni yayıncı katıldı: ${sender.name} (${sender.id})`);
    initiateWebRTCConnection(sender.id, sender.name);
  });

  // Bir yayıncı ayrıldığında
  socket.on('sender-left', (data) => {
    console.log(`Yayıncı ayrıldı. ID: ${data.id}`);
    removeCameraStream(data.id);
  });

  // WebRTC Sinyalleşme Mesajı Geldiğinde (Answer veya ICE Candidate)
  socket.on('signal', async (data) => {
    const { from, type, sdp, candidate } = data;
    const pc = peerConnections[from];

    if (!pc) {
      console.warn(`Sinyal alındı ancak eşleşen PeerConnection bulunamadı: ${from}`);
      return;
    }

    if (type === 'answer') {
      console.log(`[${from}] tarafından görüntülü arama yanıtı (answer) alındı.`);
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      } catch (err) {
        console.error('Remote description ayarlanırken hata:', err);
      }
    } else if (type === 'candidate') {
      console.log(`[${from}] tarafından ICE adayı alındı.`);
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.error('ICE adayı eklenirken hata:', err);
      }
    }
  });
});

// 4. WebRTC Bağlantısını Başlatma (Dashboard Arayıcı / Offerer Rolündedir)
async function initiateWebRTCConnection(senderId, senderName) {
  // Eğer bu cihaz zaten ekliyse tekrar ekleme
  if (peerConnections[senderId]) return;

  // UI Kartını Oluştur
  createCameraCard(senderId, senderName);

  // RTCPeerConnection Oluştur
  const pc = new RTCPeerConnection(rtcConfig);
  peerConnections[senderId] = pc;

  // Kamera yayınını alıcı (recvonly) modunda dinleyeceğimizi belirt.
  // Dashboard stream göndermediği için bu transceivers'ı eklemek zorunludur,
  // aksi takdirde SDP Offer içerisinde video kanalı tanımlanmaz.
  pc.addTransceiver('video', { direction: 'recvonly' });

  // ICE adayı oluşturdukça sunucuya yolla
  pc.onicecandidate = (event) => {
    if (event.candidate && socket) {
      socket.emit('signal', {
        to: senderId,
        type: 'candidate',
        candidate: event.candidate
      });
    }
  };

  // Karşı taraftan görüntülü akış geldiğinde video elementine bağla
  pc.ontrack = (event) => {
    console.log(`[${senderName}] kamerasından video akışı alındı.`);
    const videoEl = document.getElementById(`video-${senderId}`);
    if (videoEl && event.streams && event.streams[0]) {
      videoEl.srcObject = event.streams[0];
    }
  };

  // WebRTC durum takibi
  pc.onconnectionstatechange = () => {
    console.log(`[${senderName}] WebRTC durumu:`, pc.connectionState);
    const statusDot = document.querySelector(`#card-${senderId} .status-dot`);
    const statusText = document.querySelector(`#card-${senderId} .status-text`);

    if (pc.connectionState === 'connected') {
      if (statusDot) statusDot.style.background = 'var(--success)';
      if (statusText) statusText.textContent = 'Canlı';
    } else if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
      if (statusDot) statusDot.style.background = 'var(--danger)';
      if (statusText) statusText.textContent = 'Bağlantı Kesildi';
      // Hata durumunda 5 saniye sonra tekrar bağlanmayı deneyebilir veya temizleyebiliriz
      setTimeout(() => {
        if (peerConnections[senderId] && ['disconnected', 'failed'].includes(peerConnections[senderId].connectionState)) {
          console.log(`[${senderName}] bağlantısı başarısız, kart kaldırılıyor...`);
          removeCameraStream(senderId);
        }
      }, 5000);
    } else if (pc.connectionState === 'connecting') {
      if (statusDot) statusDot.style.background = 'var(--warning)';
      if (statusText) statusText.textContent = 'Bağlanıyor...';
    }
  };

  try {
    // Sinyalleşme Teklifini (SDP Offer) Üret
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    // Teklifi sunucu üzerinden ilgili telefona yolla
    socket.emit('signal', {
      to: senderId,
      type: 'offer',
      sdp: pc.localDescription
    });
  } catch (err) {
    console.error('WebRTC bağlantısı başlatılırken offer üretilemedi:', err);
  }
}

// 5. Kamera Kartını Arayüze Ekleme (DOM İşlemleri)
function createCameraCard(id, name) {
  // Eğer ilk kameraysa boş durum şablonunu gizle
  if (cameraCount === 0) {
    emptyState.style.display = 'none';
  }

  const card = document.createElement('div');
  card.className = 'grid-card glass-card';
  card.id = `card-${id}`;

  card.innerHTML = `
    <div class="grid-card-header">
      <div class="camera-info">
        <span class="status-dot" style="width: 8px; height: 8px; border-radius: 50%; background: var(--warning);"></span>
        <span class="camera-name">${name}</span>
      </div>
      <span class="status-text" style="font-size: 0.8rem; color: var(--text-secondary);">Bağlanıyor...</span>
    </div>
    <div class="video-container">
      <video id="video-${id}" autoplay playsinline muted></video>
      <div class="video-actions">
        <button class="action-btn" title="Tam Ekran" onclick="toggleFullscreen('card-${id}')">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"></path>
          </svg>
        </button>
      </div>
    </div>
  `;

  cameraGrid.appendChild(card);
  
  cameraCount++;
  cameraCountBadge.textContent = cameraCount;
}

// 6. Kamera Yayınını Kaldırma
function removeCameraStream(id) {
  // WebRTC Nesnesini Kapat
  if (peerConnections[id]) {
    peerConnections[id].close();
    delete peerConnections[id];
  }

  // Kartı Arayüzden Kaldır
  const card = document.getElementById(`card-${id}`);
  if (card) {
    card.remove();
  }

  // Kamera Sayısını Güncelle
  if (cameraCount > 0) {
    cameraCount--;
    cameraCountBadge.textContent = cameraCount;
  }

  // Hiç kamera kalmadıysa boş durum şablonunu tekrar göster
  if (cameraCount === 0) {
    emptyState.style.display = 'flex';
  }
}

// 7. Yardımcı Fonksiyon: Tam Ekran Modu Giriş/Çıkış
window.toggleFullscreen = function(cardId) {
  const card = document.getElementById(cardId);
  if (!card) return;

  if (!document.fullscreenElement) {
    card.requestFullscreen().catch((err) => {
      console.error(`Tam ekran moduna geçiş hatası: ${err.message}`);
    });
  } else {
    document.exitFullscreen();
  }
};
