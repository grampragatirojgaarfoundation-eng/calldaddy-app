/**
 * app.js — Owner App Logic + WebRTC Client (combined)
 * Domain: calldaddy.in
 */
const socket = io({ withCredentials: true });
let me = null, myQRs = [], pendingCallSid = null, rtc = null;

// ── WebRTC helper (owner side) ──────────────────────────────
class RTCClient {
  constructor(sessionId, role) {
    this.sid = sessionId; this.role = role;
    this.pc = null; this.stream = null;
  }
  async _initPC(turnCreds) {
    const iceServers = [
      { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    ];
    if (turnCreds) {
      iceServers.push({
        urls: [turnCreds.servers[0], turnCreds.servers[1]].filter(Boolean),
        username: turnCreds.username,
        credential: turnCreds.credential,
      });
    }
    this.pc = new RTCPeerConnection({ iceServers, iceCandidatePoolSize: 10 });
    this.pc.ontrack = e => { const a = document.getElementById('remoteAudio'); if (a) { a.srcObject = e.streams[0]; a.play().catch(()=>{}); } };
    this.pc.onicecandidate = e => { if (e.candidate) socket.emit('webrtc:ice', { sessionId: this.sid, candidate: e.candidate, from: this.role }); };
    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState;
      if (['disconnected','failed','closed'].includes(s)) this.hangup();
    };
  }
  async handleOffer(offer) {
    const creds = await fetchTurnCreds();
    await this._initPC(creds);
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    this.stream.getTracks().forEach(t => this.pc.addTrack(t, this.stream));
    await this.pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    socket.emit('webrtc:answer', { sessionId: this.sid, answer });
  }
  async addIce(candidate) { try { if (this.pc && candidate) await this.pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch {} }
  hangup() { this.stream?.getTracks().forEach(t => t.stop()); this.pc?.close(); this.pc = null; }
}

async function fetchTurnCreds() {
  try { const r = await apiFetch('GET', '/api/scan/turn-credentials'); return r.success ? r : null; } catch { return null; }
}

// ── Init ──────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  if ('serviceWorker' in navigator) {
    const reg = await navigator.serviceWorker.register('/sw.js');
    // Listen for messages from SW (incoming call via push)
    navigator.serviceWorker.addEventListener('message', e => {
      if (e.data?.type === 'ACCEPT_CALL') { pendingCallSid = e.data.sessionId; acceptCall(); }
    });
  }
  try {
    const r = await apiFetch('GET', '/auth/me');
    if (!r?.success) throw new Error('unauth');
    me = r.user;
    socket.emit('owner:register', { userId: me.id });
    await reqNotifPerm();
    const view = new URLSearchParams(window.location.search).get('view');
    if (!me.isProfileComplete) showScr('setupScr');
    else { await loadHome(); showScr('homeScr'); }
    if (sessionStorage.getItem('termsAccepted')) {
      await apiFetch('POST', '/auth/accept-terms');
      sessionStorage.removeItem('termsAccepted');
    }
    if (view === 'call' && new URLSearchParams(window.location.search).get('call')) {
      pendingCallSid = new URLSearchParams(window.location.search).get('call');
      document.getElementById('callOv').classList.remove('hidden');
    }
  } catch { showScr('loginScr'); }
});

// ── Screen Router ─────────────────────────────────────────────
function showScr(id) {
  document.querySelectorAll('.scr').forEach(s => { s.classList.remove('active'); s.style.display = ''; });
  const t = document.getElementById(id);
  if (t) { t.style.display = 'block'; t.classList.add('active'); }
}

// ── Profile Setup ─────────────────────────────────────────────
async function saveProfile() {
  const btn = document.getElementById('saveBtn');
  const err = document.getElementById('setupErr');
  const name = document.getElementById('iName').value.trim();
  const mobile = document.getElementById('iMobile').value.trim();
  const em1 = document.getElementById('iEm1').value.trim();
  const em2 = document.getElementById('iEm2').value.trim();
  if (!name || !mobile || !em1) { err.textContent = 'Please fill all required fields.'; err.classList.remove('hidden'); return; }
  if (!/^[0-9]{7,15}$/.test(mobile)) { err.textContent = 'Enter a valid mobile number.'; err.classList.remove('hidden'); return; }
  btn.disabled = true; btn.textContent = 'Saving...'; err.classList.add('hidden');
  const r = await apiFetch('PUT', '/api/user/profile', { name, mobile, emergencyContact1: em1, emergencyContact2: em2 || undefined });
  btn.disabled = false; btn.textContent = 'Save & Continue';
  if (r?.success) { me = r.user; await loadHome(); showScr('homeScr'); }
  else { err.textContent = r?.message || 'Save failed.'; err.classList.remove('hidden'); }
}

// ── Home ──────────────────────────────────────────────────────
async function loadHome() {
  document.getElementById('hName').textContent = me.name || 'User';
  document.getElementById('hAvatar').textContent = (me.name || 'C').charAt(0).toUpperCase();
  document.getElementById('dndSw').checked = me.dndEnabled;
  document.getElementById('dndLbl').textContent = me.dndEnabled ? 'DND ON' : 'DND';
  await loadQRs();
}

async function loadQRs() {
  const r = await apiFetch('GET', '/api/qr/my-qrs'); myQRs = r?.qrs || [];
  const list = document.getElementById('qrList'); const empty = document.getElementById('qrEmpty');
  if (!myQRs.length) { empty.classList.remove('hidden'); list.innerHTML = ''; return; }
  empty.classList.add('hidden');
  list.innerHTML = myQRs.map(q => `
    <div class="qr-card" onclick="showDetail('${q.qrUniqueCode}')">
      <img class="qr-thumb" src="${q.qrImageUrl}" onerror="this.src='data:image/svg+xml,<svg/>'"/>
      <div class="qr-info">
        <div class="qr-code">${q.qrUniqueCode}</div>
        <span class="qr-badge ${q.qrType==='physical'?'badge-ph':'badge-di'}">${q.qrType==='physical'?'📦 Physical':'🎯 Digital'}</span>
        <div class="qr-cnt">Scanned ${q.scanCount||0}×</div>
      </div>
      <span style="color:var(--sub);font-size:20px">›</span>
    </div>`).join('');
}

// ── DND ───────────────────────────────────────────────────────
async function toggleDND() {
  const en = document.getElementById('dndSw').checked;
  document.getElementById('dndLbl').textContent = en ? 'DND ON' : 'DND';
  await apiFetch('PUT', '/api/user/dnd', { dndEnabled: en }); me.dndEnabled = en;
}

// ── Activate Physical QR ──────────────────────────────────────
function fmtQR(input) {
  let v = input.value.replace(/[^A-Za-z0-9]/g,'').toUpperCase().slice(0,8);
  if (v.length > 4) v = v.slice(0,4)+'-'+v.slice(4);
  input.value = 'SQ-'+v.replace(/^SQ-?/,'');
}

async function activateQR() {
  const code = document.getElementById('actCode').value.trim().toUpperCase();
  const msg = document.getElementById('actMsg');
  msg.className = 'hidden';
  const r = await apiFetch('POST', '/api/qr/activate', { qrCode: code });
  msg.className = r?.success ? 'form-ok' : 'form-err';
  msg.textContent = r?.message || (r?.success ? 'Activated!' : 'Failed');
  if (r?.success) { await loadQRs(); setTimeout(() => showScr('homeScr'), 2000); }
}

// ── Buy Digital QR (Razorpay) ─────────────────────────────────
async function buyDigitalQR() {
  const ord = await apiFetch('POST', '/api/qr/create-order');
  if (!ord?.success) return alert(ord?.message || 'Failed to start payment.');
  new Razorpay({
    key: ord.razorpayKeyId, amount: ord.amount, currency: ord.currency,
    name: 'CallDaddy', description: 'Permanent Digital QR', order_id: ord.orderId,
    handler: async resp => {
      const vr = await apiFetch('POST', '/api/qr/verify-payment', {
        razorpay_order_id: resp.razorpay_order_id,
        razorpay_payment_id: resp.razorpay_payment_id,
        razorpay_signature: resp.razorpay_signature,
      });
      if (vr?.success) { alert('🎉 QR Generated! Download it below.'); await loadQRs(); showDetail(vr.qr.qrUniqueCode); }
      else alert('Payment done but QR failed. Contact support.');
    },
    prefill: { name: me?.name || '' }, theme: { color: '#2563eb' },
  }).open();
}

// ── QR Detail ─────────────────────────────────────────────────
function showDetail(code) {
  const q = myQRs.find(x => x.qrUniqueCode === code); if (!q) return;
  document.getElementById('dImg').src  = q.qrImageUrl;
  document.getElementById('dCode').textContent = q.qrUniqueCode;
  document.getElementById('dCnt').textContent  = q.scanCount || 0;
  showScr('detailScr');
}

async function dlQR() {
  const code = document.getElementById('dCode').textContent;
  const r = await apiFetch('GET', `/api/qr/download/${code}`);
  if (r?.success) { const a = document.createElement('a'); a.href = r.qrDataUrl; a.download = `CallDaddy-${code}.png`; a.click(); }
}

// ── Incoming Call (Socket.io) ─────────────────────────────────
socket.on('incoming:call', ({ sessionId, label }) => {
  pendingCallSid = sessionId;
  document.getElementById('callLbl').textContent = label || 'Someone scanned your QR';
  document.getElementById('callOv').classList.remove('hidden');
  document.getElementById('ringtone').play().catch(()=>{});
});

async function acceptCall() {
  if (!pendingCallSid) return;
  document.getElementById('callOv').classList.add('hidden');
  document.getElementById('ringtone').pause(); document.getElementById('ringtone').currentTime = 0;
  socket.emit('owner:accept', { sessionId: pendingCallSid });
  rtc = new RTCClient(pendingCallSid, 'owner');
  rtc.hangupCb = () => { rtc = null; pendingCallSid = null; };
}

function declineCall() {
  if (!pendingCallSid) return;
  socket.emit('owner:decline', { sessionId: pendingCallSid });
  document.getElementById('callOv').classList.add('hidden');
  document.getElementById('ringtone').pause(); document.getElementById('ringtone').currentTime = 0;
  pendingCallSid = null;
}

socket.on('webrtc:offer',  async ({ sessionId, offer })    => { if (rtc?.sid === sessionId) await rtc.handleOffer(offer); });
socket.on('webrtc:ice',    async ({ candidate })            => { if (rtc) await rtc.addIce(candidate); });
socket.on('call:ended',    ()                               => { rtc?.hangup(); rtc = null; pendingCallSid = null; });

// ── Logout ────────────────────────────────────────────────────
function confirmLogout() {
  const c = confirm('Logout from CallDaddy?\n\nTo delete your account, contact support.');
  if (c) apiFetch('POST', '/auth/logout').then(() => window.location.href = '/');
}

// ── FCM Push Notification ─────────────────────────────────────
async function reqNotifPerm() {
  if (!('Notification' in window) || !('serviceWorker' in navigator)) return;
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: 'BOlLHyPGdnAYYp3xNuhdRGr3ni0m-sNCgNriFS2CI_-1Ixs9xWaaTrY-B3tgjERs80PC-Gs5s7Bnhzr1qJF7Wtw',
    });
    // Exchange push subscription for FCM token via service worker
    // FCM token is handled in SW's push event registration
  } catch {}
  // Also request FCM token via Firebase SDK in SW
}

// ── API Fetch (with auto-refresh) ─────────────────────────────
async function apiFetch(method, url, body) {
  try {
    const resp = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: body ? JSON.stringify(body) : undefined });
    if (resp.status === 401) {
      const rr = await fetch('/auth/refresh', { method: 'POST', credentials: 'include' });
      if (rr.ok) {
        const retry = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: body ? JSON.stringify(body) : undefined });
        return retry.json();
      }
      window.location.href = '/'; return;
    }
    return resp.json();
  } catch { return { success: false, message: 'Network error' }; }
}

window.apiFetch = apiFetch;
