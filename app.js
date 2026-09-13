/* ============================================================
   app.js — CallDaddy Owner PWA — Complete Frontend Logic
   Handles: Auth, Profile, QR Activate, DND, FCM, WebRTC Call, Chat
   ============================================================ */

'use strict';

// ── Firebase Config (same as sw.js) ────────────────────────
const FIREBASE_CONFIG = {
  apiKey:            'AIzaSyD1IglO0fuaIh9TYZLqAm4LDUJsCYN9h5Q',
  authDomain:        'calldaddy-63149.firebaseapp.com',
  projectId:         'calldaddy-63149',
  storageBucket:     'calldaddy-63149.firebasestorage.app',
  messagingSenderId: '154336897139',
  appId:             '1:154336897139:web:bc27a1a50bc7d8c5a4a206',
};

// ⚠️ VAPID key from Firebase
const VAPID_KEY = 'BOlLHyPGdnAYYp3xNuhdRGr3ni0m-sNCgNriFS2CI_-1Ixs9xWaaTrY-B3tgjERs80PC-Gs5s7Bnhzr1qJF7Wtw';

// ── App State ────────────────────────────────────────────────
let STATE = {
  accessToken:   null,
  refreshToken:  null,
  user:          null,
  socket:        null,
  peerConn:      null,
  localStream:   null,
  sessionId:     null,
  callTimer:     null,
  callSeconds:   0,
  isMuted:       false,
  firebaseApp:   null,
  messaging:     null,
};

// ── Helpers ─────────────────────────────────────────────────
const $  = (id) => document.getElementById(id);
const el = (sel) => document.querySelector(sel);

function showToast(msg, type = '') {
  const t = el('.toast') || (() => { const d = document.createElement('div'); d.className = 'toast'; document.body.appendChild(d); return d; })();
  t.textContent = msg;
  t.className = `toast ${type} show`;
  clearTimeout(t._tid);
  t._tid = setTimeout(() => t.classList.remove('show'), 3500);
}

function showScreen(name) {
  document.querySelectorAll('.screen, #screen-incoming, #screen-active-call, #screen-chat').forEach(s => s.classList.remove('active'));
  const s = $(name);
  if (s) s.classList.add('active');
}

// ── Token Management ─────────────────────────────────────────
function saveTokens(access, refresh) {
  STATE.accessToken  = access;
  STATE.refreshToken = refresh;
  localStorage.setItem('cd_access',  access);
  localStorage.setItem('cd_refresh', refresh);
}

function loadTokens() {
  STATE.accessToken  = localStorage.getItem('cd_access');
  STATE.refreshToken = localStorage.getItem('cd_refresh');
}

async function refreshAccessToken() {
  if (!STATE.refreshToken) return false;
  try {
    const res  = await fetch('/auth/refresh', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: STATE.refreshToken }),
    });
    if (!res.ok) { clearAuth(); return false; }
    const data = await res.json();
    saveTokens(data.accessToken, data.refreshToken);
    return true;
  } catch { return false; }
}

async function api(url, opts = {}) {
  const go = async (token) => fetch(url, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

  let res = await go(STATE.accessToken);
  if (res.status === 401) {
    const ok = await refreshAccessToken();
    if (!ok) { clearAuth(); return null; }
    res = await go(STATE.accessToken);
  }
  return res;
}

function clearAuth() {
  localStorage.removeItem('cd_access');
  localStorage.removeItem('cd_refresh');
  STATE.accessToken = STATE.refreshToken = STATE.user = null;
  showScreen('screen-login');
}

// ── Firebase + FCM Setup ─────────────────────────────────────
async function initFirebase() {
  if (typeof firebase === 'undefined') return;
  try {
    if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
    STATE.messaging = firebase.messaging();

    // Foreground message handler (app is open)
    STATE.messaging.onMessage((payload) => {
      const data = payload.data || {};
      if (data.type === 'CALL') {
        handleIncomingCall(data.sessionId, data.type);
      } else {
        showToast('💬 New message via your QR!', 'success');
        if (data.sessionId) openChat(data.sessionId, 'owner');
      }
    });
  } catch (err) {
    console.warn('Firebase init error:', err.message);
  }
}

async function requestPushPermission() {
  if (!STATE.messaging) return;
  if (VAPID_KEY === 'YOUR_VAPID_KEY_FROM_FIREBASE_CONSOLE') {
    console.warn('⚠️  VAPID key not set. Push notifications disabled.');
    return;
  }
  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return;
    const token = await STATE.messaging.getToken({ vapidKey: VAPID_KEY });
    if (token) {
      await api('/api/user/fcm-token', { method: 'POST', body: { fcmToken: token } });
    }
  } catch (err) {
    console.warn('FCM token error:', err.message);
  }
}

// ── Service Worker Registration ──────────────────────────────
async function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    console.log('✅ Service Worker registered');
    return reg;
  } catch (err) {
    console.warn('SW registration failed:', err.message);
  }
}

// ── Profile ──────────────────────────────────────────────────
async function loadProfile() {
  const res  = await api('/api/user/profile');
  if (!res?.ok) return null;
  const user = await res.json();
  STATE.user = user;
  return user;
}

function renderDashboard(user) {
  // User info
  if ($('dash-avatar') && user.photoUrl) $('dash-avatar').src = user.photoUrl;
  if ($('dash-name'))  $('dash-name').textContent  = user.name || user.displayName;
  if ($('dash-email')) $('dash-email').textContent = user.email;

  // DND toggle
  const dndToggle = $('dnd-toggle');
  const dndCard   = $('dnd-card');
  if (dndToggle) {
    dndToggle.checked = user.dndMode;
    updateDNDCard(user.dndMode);
    dndToggle.onchange = async () => {
      const res = await api('/api/user/dnd', { method: 'PATCH' });
      if (res?.ok) {
        const d = await res.json();
        updateDNDCard(d.dndMode);
        showToast(d.dndMode ? '🔕 DND Enabled' : '🔔 DND Disabled', d.dndMode ? 'error' : 'success');
      }
    };
  }

  // Load QR codes
  loadUserQRs();
}

function updateDNDCard(isDND) {
  const card  = $('dnd-card');
  const label = $('dnd-label');
  const desc  = $('dnd-desc');
  if (card)  { card.className  = isDND ? 'dnd-card dnd-on' : 'dnd-card dnd-off'; }
  if (label) { label.textContent = isDND ? '🔕 DND is ON'  : '🔔 Available'; }
  if (desc)  { desc.textContent  = isDND ? 'Scanners will see "Not available"' : 'Scanners can call/message you'; }
}

async function loadUserQRs() {
  const res = await api('/api/user/qrs');
  if (!res?.ok) return;
  const qrs = await res.json();
  const wrap = $('qr-list');
  if (!wrap) return;

  if (qrs.length === 0) {
    wrap.innerHTML = `<div class="card text-center">
      <p class="text-muted">No QR codes activated yet.</p>
      <button class="btn btn-primary mt-16" onclick="showScreen('screen-activate')">+ Activate QR Code</button>
    </div>`;
    return;
  }

  wrap.innerHTML = qrs.map(qr => `
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <span class="qr-code-text">${qr.code}</span>
        <span class="badge ${qr.status === 'ACTIVATED' ? 'badge-success' : 'badge-danger'}">${qr.status}</span>
      </div>
      <div class="stats" style="margin-top:12px;margin-bottom:0;">
        <div class="stat-box"><div class="val">${qr.totalScans||0}</div><div class="lbl">Scans</div></div>
        <div class="stat-box"><div class="val">${qr.totalCalls||0}</div><div class="lbl">Calls</div></div>
        <div class="stat-box"><div class="val">${qr.totalMessages||0}</div><div class="lbl">Messages</div></div>
      </div>
    </div>
  `).join('');
}

// ── QR Activation ────────────────────────────────────────────
async function activateQR() {
  const code  = $('qr-code-input')?.value.trim().toUpperCase();
  const errEl = $('qr-error');
  if (!code) { if (errEl) { errEl.textContent = 'Please enter a code'; errEl.style.display = 'block'; } return; }

  const btn = $('activate-btn');
  if (btn) { btn.textContent = 'Activating...'; btn.disabled = true; }

  const res = await api('/api/qr/activate', { method: 'POST', body: { code } });
  if (!res) { if (btn) { btn.textContent = 'Activate'; btn.disabled = false; } return; }

  const data = await res.json();
  if (res.ok) {
    showToast('✅ ' + data.message, 'success');
    if ($('qr-code-input')) $('qr-code-input').value = '';
    showScreen('screen-dashboard');
    loadUserQRs();
  } else {
    if (errEl) { errEl.textContent = data.error || 'Error activating QR'; errEl.style.display = 'block'; }
  }

  if (btn) { btn.textContent = 'Activate'; btn.disabled = false; }
}

// ── Incoming Call / Chat Handler ─────────────────────────────
function handleIncomingCall(sessionId, type) {
  STATE.sessionId = sessionId;
  if ($('incoming-type')) $('incoming-type').textContent = type === 'CALL' ? '📞 Incoming Call' : '💬 Incoming Message';
  if ($('incoming-sub'))  $('incoming-sub').textContent  = type === 'CALL'
    ? 'Someone is calling via your QR sticker'
    : 'Someone sent a message via your QR sticker';
  showScreen('screen-incoming');

  if (type === 'CALL') {
    $('accept-btn').style.display = 'flex';
    $('reject-btn').style.display = 'flex';
    $('msg-accept-btn').style.display = 'none';
  } else {
    $('accept-btn').style.display = 'none';
    $('reject-btn').style.display = 'flex';
    $('msg-accept-btn').style.display = 'flex';
  }
}

// Accept call
window.acceptCall = async function() {
  if (!STATE.sessionId) return;
  showScreen('screen-active-call');
  const socket = initSocket();
  socket.emit('join-session', { sessionId: STATE.sessionId, role: 'owner' });
  socket.emit('call-response', { sessionId: STATE.sessionId, accepted: true });
  await startWebRTCAsOwner();
};

// Reject call
window.rejectCall = function() {
  if (!STATE.sessionId || !STATE.socket) return;
  STATE.socket.emit('call-response', { sessionId: STATE.sessionId, accepted: false });
  STATE.socket.emit('leave-session', { sessionId: STATE.sessionId });
  STATE.sessionId = null;
  showScreen('screen-dashboard');
};

// Accept message (open chat)
window.acceptMessage = function() {
  if (!STATE.sessionId) return;
  openChat(STATE.sessionId, 'owner');
};

// ── Socket.io ────────────────────────────────────────────────
function initSocket() {
  if (STATE.socket?.connected) return STATE.socket;
  STATE.socket = io({ transports: ['websocket', 'polling'] });

  STATE.socket.on('webrtc-offer',    ({ offer })  => handleOffer(offer));
  STATE.socket.on('webrtc-answer',   ({ answer }) => STATE.peerConn?.setRemoteDescription(answer));
  STATE.socket.on('ice-candidate',   ({ candidate }) => STATE.peerConn?.addIceCandidate(new RTCIceCandidate(candidate)));
  STATE.socket.on('call-ended',      () => endCall(false));
  STATE.socket.on('peer-disconnected', () => { showToast('Call ended by other side', 'error'); endCall(false); });

  return STATE.socket;
}

// ── WebRTC ──────────────────────────────────────────────────
async function getIceServers() {
  try {
    const res = await api('/api/turn-credentials');
    if (res?.ok) return (await res.json()).iceServers;
  } catch {}
  return [{ urls: 'stun:stun.l.google.com:19302' }];
}

async function startWebRTCAsOwner() {
  try {
    STATE.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    const iceServers  = await getIceServers();
    STATE.peerConn    = new RTCPeerConnection({ iceServers });

    STATE.localStream.getTracks().forEach(t => STATE.peerConn.addTrack(t, STATE.localStream));
    STATE.peerConn.onicecandidate = ({ candidate }) => {
      if (candidate) STATE.socket.emit('ice-candidate', { sessionId: STATE.sessionId, candidate });
    };
    STATE.peerConn.ontrack = ({ streams }) => {
      const audio = document.createElement('audio');
      audio.srcObject = streams[0];
      audio.autoplay = true;
      document.body.appendChild(audio);
    };
    startCallTimer(60);
  } catch (err) {
    showToast('Microphone error: ' + err.message, 'error');
    endCall(true);
  }
}

async function handleOffer(offer) {
  if (!STATE.peerConn) return;
  await STATE.peerConn.setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await STATE.peerConn.createAnswer();
  await STATE.peerConn.setLocalDescription(answer);
  STATE.socket.emit('webrtc-answer', { sessionId: STATE.sessionId, answer });
}

function startCallTimer(maxSec) {
  STATE.callSeconds = maxSec;
  if ($('call-timer')) $('call-timer').textContent = formatTime(STATE.callSeconds);
  STATE.callTimer = setInterval(() => {
    STATE.callSeconds--;
    if ($('call-timer')) $('call-timer').textContent = formatTime(STATE.callSeconds);
    if (STATE.callSeconds <= 0) endCall(true);
  }, 1000);
}

function formatTime(s) {
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

window.toggleMute = function() {
  if (!STATE.localStream) return;
  STATE.isMuted = !STATE.isMuted;
  STATE.localStream.getAudioTracks().forEach(t => { t.enabled = !STATE.isMuted; });
  const btn = $('mute-btn');
  if (btn) { btn.textContent = STATE.isMuted ? '🔇' : '🎤'; btn.className = `ctrl-btn mute ${STATE.isMuted ? 'on' : ''}`; }
};

window.endCall = function(notify = true) {
  clearInterval(STATE.callTimer);
  const dur = 60 - STATE.callSeconds;
  if (notify && STATE.socket && STATE.sessionId) {
    STATE.socket.emit('call-ended', { sessionId: STATE.sessionId, duration: dur });
  }
  STATE.peerConn?.close();
  STATE.localStream?.getTracks().forEach(t => t.stop());
  STATE.peerConn   = null;
  STATE.localStream = null;
  STATE.sessionId   = null;
  document.querySelectorAll('audio').forEach(a => a.remove());
  showScreen('screen-dashboard');
};

window.reportAbuse = async function() {
  if (!STATE.sessionId) return;
  const res = await api('/api/session/report', { method: 'POST', body: { sessionId: STATE.sessionId, reason: 'ABUSE' } });
  if (res?.ok) showToast('Reported. User may be blocked.', 'success');
  endCall(true);
};

// ── Chat ─────────────────────────────────────────────────────
function openChat(sessionId, role) {
  STATE.sessionId = sessionId;
  showScreen('screen-chat');

  const socket = initSocket();
  socket.emit('join-session', { sessionId, role });

  let chatSec = 600;
  const chatTimer = setInterval(() => {
    chatSec--;
    if ($('chat-timer')) $('chat-timer').textContent = `${formatTime(chatSec)} left`;
    if (chatSec <= 0) { clearInterval(chatTimer); closeChat(); }
  }, 1000);

  socket.on('chat-message', ({ message, from }) => appendMsg(message, from === role ? 'me' : 'them'));
  socket.on('peer-disconnected', () => { appendMsg('— Session ended —', 'them'); });

  $('send-msg-btn')?.addEventListener('click', sendChatMessage);
  $('chat-input')?.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatMessage(); } });
}

function sendChatMessage() {
  const input = $('chat-input');
  if (!input || !STATE.socket) return;
  const msg = input.value.replace(/[^a-zA-Z0-9 .,!?]/g, '').substring(0, 500).trim();
  if (!msg) return;
  STATE.socket.emit('chat-message', { sessionId: STATE.sessionId, message: msg });
  appendMsg(msg, 'me');
  input.value = '';
}

function appendMsg(text, side) {
  const wrap = $('chat-msgs');
  if (!wrap) return;
  const d = document.createElement('div');
  d.className = `msg-bubble ${side}`;
  d.textContent = text;
  wrap.appendChild(d);
  wrap.scrollTop = wrap.scrollHeight;
}

window.closeChat = function() {
  STATE.socket?.emit('leave-session', { sessionId: STATE.sessionId });
  STATE.sessionId = null;
  showScreen('screen-dashboard');
};

// ── Terms ─────────────────────────────────────────────────────
window.acceptTerms = async function() {
  const res = await api('/api/user/terms-accept', { method: 'POST' });
  if (res?.ok) {
    STATE.user.termsAccepted = { accepted: true };
    showScreen('screen-profile');
  }
};

// ── Profile Save ─────────────────────────────────────────────
window.saveProfile = async function() {
  const name   = $('inp-name')?.value.trim();
  const mobile = $('inp-mobile')?.value.trim();
  const e1     = $('inp-e1')?.value.trim();
  const e2     = $('inp-e2')?.value.trim();

  // Client-side validation
  if (!name || !/^[a-zA-Z\s]{2,50}$/.test(name))  { showToast('Name: English letters only (2-50 chars)', 'error'); return; }
  if (!mobile || !/^\d{7,15}$/.test(mobile))       { showToast('Mobile: digits only (7-15 digits)', 'error'); return; }
  if (!e1 || !/^\d{7,15}$/.test(e1))               { showToast('Emergency 1: digits only (7-15)', 'error'); return; }
  if (e2 && !/^\d{7,15}$/.test(e2))                { showToast('Emergency 2: digits only (7-15)', 'error'); return; }

  const btn = $('save-profile-btn');
  if (btn) { btn.textContent = 'Saving...'; btn.disabled = true; }

  const res = await api('/api/user/profile', { method: 'PUT', body: { name, mobile, emergency1: e1, emergency2: e2 || null } });
  if (res?.ok) {
    STATE.user = await res.json();
    showToast('Profile saved!', 'success');
    showScreen('screen-dashboard');
    renderDashboard(STATE.user);
    await requestPushPermission();
  } else {
    const err = await res?.json();
    showToast(err?.error || err?.errors?.[0]?.msg || 'Save failed', 'error');
  }

  if (btn) { btn.textContent = 'Save Profile'; btn.disabled = false; }
};

// ── App Init ──────────────────────────────────────────────────
async function init() {
  // Register service worker
  await registerSW();

  // Init Firebase for foreground messages
  await initFirebase();

  // Check URL params (from OAuth redirect or FCM notification click)
  const params  = new URLSearchParams(window.location.search);
  const token   = params.get('token');
  const refresh = params.get('refresh');
  const isNew   = params.get('new') === 'true';
  const sessionId = params.get('sessionId');
  const action  = params.get('action');
  const type    = params.get('type');

  // Clean URL
  window.history.replaceState({}, '', '/');

  if (token && refresh) {
    saveTokens(token, refresh);
  } else {
    loadTokens();
  }

  // If opened from FCM notification with a session
  if (sessionId && action === 'incoming') {
    // Need to auth first, then show incoming
    if (STATE.accessToken) {
      const user = await loadProfile();
      if (user) {
        renderDashboard(user);
        handleIncomingCall(sessionId, type || 'CALL');
        return;
      }
    }
  }

  if (!STATE.accessToken) {
    showScreen('screen-login');
    return;
  }

  // Load user profile
  const user = await loadProfile();
  if (!user) { showScreen('screen-login'); return; }

  // Navigate to correct screen
  if (!user.termsAccepted?.accepted) {
    showScreen('screen-terms');
  } else if (!user.profileComplete) {
    showScreen('screen-profile');
  } else {
    renderDashboard(user);
    showScreen('screen-dashboard');
    await requestPushPermission();
  }
}

// Start app when DOM ready
document.addEventListener('DOMContentLoaded', init);