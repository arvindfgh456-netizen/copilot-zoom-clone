'use strict';

const socket = io();
const params = window.location.pathname.split('/');
const roomId = params[params.length - 1];

document.getElementById('roomId').textContent = `Room: ${roomId}`;

let localStream;
const peers = {}; // peerId -> RTCPeerConnection
const remoteVideos = {};
const mediaConstraints = { audio: true, video: true };

function showToast(msg, timeout = 2500) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.style.display = 'block';
  clearTimeout(t._to);
  t._to = setTimeout(() => t.style.display = 'none', timeout);
}

async function initLocal() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia(mediaConstraints);
  } catch (e) {
    showToast('Could not get camera/microphone: ' + e.message);
    return;
  }
  addLocalVideo();
}

function addLocalVideo(){
  const videos = document.getElementById('videos');
  const wrapper = document.createElement('div');
  wrapper.className = 'videoTile';
  wrapper.id = 'localWrapper';
  const myVideo = document.createElement('video');
  myVideo.id = 'localVideo';
  myVideo.autoplay = true;
  myVideo.muted = true;
  myVideo.playsInline = true;
  myVideo.srcObject = localStream;
  wrapper.appendChild(myVideo);
  videos.prepend(wrapper);
}

function updateParticipants() {
  const ul = document.getElementById('participants');
  ul.innerHTML = '';
  const keys = Object.keys(peers);
  keys.forEach(k => {
    const li = document.createElement('li');
    li.textContent = k;
    ul.appendChild(li);
  });
}

function createPeerConnection(otherId, isInitiator) {
  const pc = new RTCPeerConnection({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' }
    ]
  });

  if (localStream) localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit('ice-candidate', { to: otherId, candidate: e.candidate });
    }
  };

  pc.ontrack = (e) => {
    if (!remoteVideos[otherId]) {
      const videos = document.getElementById('videos');
      const wrapper = document.createElement('div');
      wrapper.className = 'videoTile';
      wrapper.id = `remote_${otherId}`;
      const v = document.createElement('video');
      v.autoplay = true;
      v.playsInline = true;
      v.srcObject = new MediaStream();
      wrapper.appendChild(v);
      videos.appendChild(wrapper);
      remoteVideos[otherId] = v;
    }
    // append tracks
    const stream = remoteVideos[otherId].srcObject;
    e.streams[0].getTracks().forEach(t => stream.addTrack(t));
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      const el = document.getElementById(`remote_${otherId}`);
      if (el) el.remove();
      if (remoteVideos[otherId]) delete remoteVideos[otherId];
      if (peers[otherId]) delete peers[otherId];
      updateParticipants();
    }
  };

  peers[otherId] = pc;
  updateParticipants();
  return pc;
}

// Chat helpers
const chatMessagesEl = document.getElementById('chatMessages');
const chatInput = document.getElementById('chatInput');
const chatSend = document.getElementById('chatSend');
const displayNameInput = document.getElementById('displayName');

let displayName = localStorage.getItem('displayName') || '';
if (displayNameInput) displayNameInput.value = displayName;

displayNameInput && displayNameInput.addEventListener('change', (e) => {
  displayName = e.target.value.trim().slice(0,50);
  try { localStorage.setItem('displayName', displayName); } catch (e) {}
});

function appendChatMessage(msg, me = false) {
  const div = document.createElement('div');
  div.className = 'chat-msg' + (me ? ' me' : '');
  const meta = document.createElement('div');
  meta.className = 'meta';
  const date = new Date(msg.ts || Date.now());
  const fromText = me ? 'You' : (msg.from || 'Anonymous');
  meta.textContent = `${fromText} • ${date.toLocaleTimeString()}`;
  const txt = document.createElement('div');
  txt.textContent = msg.text;
  div.appendChild(meta);
  div.appendChild(txt);
  chatMessagesEl.appendChild(div);
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}

chatSend.addEventListener('click', () => {
  const text = chatInput.value.trim();
  if (!text) return;
  socket.emit('chat-message', { roomId, text, name: displayName });
  appendChatMessage({ from: 'You', text, ts: Date.now() }, true);
  chatInput.value = '';
});

chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { chatSend.click(); }
});

socket.on('connect', async () => {
  await initLocal();
  socket.emit('join-room', roomId);
});

socket.on('chat-history', (hist) => {
  if (!hist || !hist.length) return;
  hist.forEach(m => {
    const me = (m.id === socket.id);
    // if a history message is from me, render as 'You'
    appendChatMessage(m, me);
  });
});

socket.on('chat-message', (msg) => {
  // ignore server echo of messages we already appended locally
  if (msg.id === socket.id) return;
  const me = (msg.id === socket.id);
  appendChatMessage(msg, me);
});

socket.on('all-users', async (users) => {
  for (const id of users) {
    const pc = createPeerConnection(id, true);
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('offer', { to: id, sdp: offer });
    } catch (e) { console.error(e); }
  }
});

socket.on('offer', async (payload) => {
  const from = payload.from;
  const pc = createPeerConnection(from, false);
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('answer', { to: from, sdp: answer });
  } catch (e) { console.error(e); }
});

socket.on('answer', async (payload) => {
  const from = payload.from;
  const pc = peers[from];
  if (!pc) return;
  try { await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp)); } catch (e) { console.error(e); }
});

socket.on('ice-candidate', async (payload) => {
  const from = payload.from;
  const pc = peers[from];
  if (!pc) return;
  try { await pc.addIceCandidate(new RTCIceCandidate(payload.candidate)); } catch (e) { console.error(e); }
});

socket.on('user-disconnected', id => {
  if (peers[id]) { try { peers[id].close(); } catch (e) {} delete peers[id]; }
  const el = document.getElementById(`remote_${id}`);
  if (el) el.remove();
  if (remoteVideos[id]) delete remoteVideos[id];
  updateParticipants();
});

// Controls (copy/share/toggles remain)
const copyLinkBtn = document.getElementById('copyLink');
copyLinkBtn.onclick = async () => {
  const url = window.location.href;
  try {
    await navigator.clipboard.writeText(url);
    showToast('Link copied to clipboard');
  } catch (e) { showToast('Could not copy link'); }
};

const shareBtn = document.getElementById('shareBtn');
shareBtn.onclick = async () => {
  const url = window.location.href;
  if (navigator.share) {
    try { await navigator.share({ title: 'Join my room', text: `Join my room: ${roomId}`, url }); } catch (e) { /* user cancelled */ }
  } else {
    try { await navigator.clipboard.writeText(url); showToast('Invite link copied'); } catch (e) { showToast('Could not share link'); }
  }
};

const toggleAudioBtn = document.getElementById('toggleAudio');
const toggleVideoBtn = document.getElementById('toggleVideo');

toggleAudioBtn.onclick = () => {
  if (!localStream) return;
  const audioTrack = localStream.getAudioTracks()[0];
  if (!audioTrack) return;
  audioTrack.enabled = !audioTrack.enabled;
  toggleAudioBtn.textContent = audioTrack.enabled ? '🔈' : '🔇';
};

toggleVideoBtn.onclick = () => {
  if (!localStream) return;
  const videoTrack = localStream.getVideoTracks()[0];
  if (!videoTrack) return;
  videoTrack.enabled = !videoTrack.enabled;
  toggleVideoBtn.textContent = videoTrack.enabled ? '🎥' : '📷';
};

// Recording (same as before) -- keep existing recording implementation
let recorder;
let recordedChunks = [];
let recordingCanvas, canvasStream, audioContext, audioDestination, drawRAF;

async function startRecording() {
  recordingCanvas = document.createElement('canvas');
  const vids = document.querySelectorAll('.videoTile video');
  const count = Math.max(1, vids.length);
  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  const w = 640, h = 360;
  recordingCanvas.width = cols * w;
  recordingCanvas.height = rows * h;
  const ctx = recordingCanvas.getContext('2d');

  audioContext = new (window.AudioContext || window.webkitAudioContext)();
  audioDestination = audioContext.createMediaStreamDestination();

  vids.forEach(v => {
    try { const src = audioContext.createMediaElementSource(v); src.connect(audioDestination); } catch (e) {}
  });
  if (localStream && localStream.getAudioTracks().length) {
    try { const localAudio = audioContext.createMediaStreamSource(new MediaStream([localStream.getAudioTracks()[0]])); localAudio.connect(audioDestination); } catch (e) {}
  }

  function draw() {
    const videoEls = Array.from(document.querySelectorAll('.videoTile video'));
    const cols = Math.ceil(Math.sqrt(videoEls.length)) || 1;
    const w = 640, h = 360;
    // resize canvas if layout changed
    recordingCanvas.width = cols * w;
    const rows = Math.ceil(videoEls.length / cols) || 1;
    recordingCanvas.height = rows * h;
    ctx.fillStyle = '#000'; ctx.fillRect(0,0,recordingCanvas.width,recordingCanvas.height);
    videoEls.forEach((v,i) => { const x = (i%cols)*w; const y = Math.floor(i/cols)*h; try { ctx.drawImage(v,x,y,w,h); } catch (e) {} });
    drawRAF = requestAnimationFrame(draw);
  }
  draw();

  canvasStream = recordingCanvas.captureStream(25);
  const mixedStream = new MediaStream();
  canvasStream.getVideoTracks().forEach(t => mixedStream.addTrack(t));
  audioDestination.stream.getAudioTracks().forEach(t => mixedStream.addTrack(t));

  recordedChunks = [];
  try {
    recorder = new MediaRecorder(mixedStream, { mimeType: 'video/webm;codecs=vp9,opus' });
  } catch (e) {
    recorder = new MediaRecorder(mixedStream);
  }

  recorder.ondataavailable = e => { if (e.data && e.data.size) recordedChunks.push(e.data); };
  recorder.onstop = () => {
    const blob = new Blob(recordedChunks, { type: 'video/webm' });
    const url = URL.createObjectURL(blob);
    const dl = document.getElementById('downloadLink');
    dl.style.display = 'block';
    dl.href = url;
    dl.download = `recording-${roomId}-${Date.now()}.webm`;
    showToast('Recording ready to download');
  };

  recorder.start();
  document.getElementById('startRec').disabled = true;
  document.getElementById('stopRec').disabled = false;
  showToast('Recording started');
}

function stopRecording() {
  if (recorder && recorder.state !== 'inactive') recorder.stop();
  if (drawRAF) cancelAnimationFrame(drawRAF);
  if (audioContext) audioContext.close();
  if (recordingCanvas) recordingCanvas.remove();
  document.getElementById('startRec').disabled = false;
  document.getElementById('stopRec').disabled = true;
  showToast('Recording stopped');
}

document.getElementById('startRec').onclick = startRecording;
document.getElementById('stopRec').onclick = stopRecording;

// cleanup on unload
window.addEventListener('beforeunload', () => {
  try { socket.close(); } catch (e) {}
});
