'use strict';

const socket = io();
const params = window.location.pathname.split('/');
const roomId = params[params.length - 1];

document.getElementById('roomId').textContent = `Room: ${roomId}`;

let localStream;
const peers = {}; // peerId -> RTCPeerConnection
const remoteVideos = {};
const mediaConstraints = { audio: true, video: true };

async function initLocal() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia(mediaConstraints);
  } catch (e) {
    alert('Could not get camera/microphone: ' + e.message);
    return;
  }
  const videos = document.getElementById('videos');
  const myVideo = document.createElement('video');
  myVideo.id = 'localVideo';
  myVideo.autoplay = true;
  myVideo.muted = true;
  myVideo.playsInline = true;
  myVideo.srcObject = localStream;
  myVideo.className = 'videoTile';
  videos.appendChild(myVideo);
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

  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit('ice-candidate', { to: otherId, candidate: e.candidate });
    }
  };

  pc.ontrack = (e) => {
    if (!remoteVideos[otherId]) {
      const videos = document.getElementById('videos');
      const v = document.createElement('video');
      v.id = `remote_${otherId}`;
      v.autoplay = true;
      v.playsInline = true;
      v.srcObject = new MediaStream();
      v.className = 'videoTile';
      videos.appendChild(v);
      remoteVideos[otherId] = v;
    }
    // append all tracks to the video element's srcObject
    const stream = remoteVideos[otherId].srcObject;
    e.streams[0].getTracks().forEach(t => stream.addTrack(t));
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      if (remoteVideos[otherId]) {
        remoteVideos[otherId].remove();
        delete remoteVideos[otherId];
      }
      delete peers[otherId];
      updateParticipants();
    }
  };

  peers[otherId] = pc;
  updateParticipants();
  return pc;
}

socket.on('connect', async () => {
  await initLocal();
  socket.emit('join-room', roomId);
});

socket.on('all-users', async (users) => {
  // create offer for each existing user
  for (const id of users) {
    const pc = createPeerConnection(id, true);
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('offer', { to: id, sdp: offer });
    } catch (e) {
      console.error('Error creating offer', e);
    }
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
  } catch (e) {
    console.error('Error handling offer', e);
  }
});

socket.on('answer', async (payload) => {
  const from = payload.from;
  const pc = peers[from];
  if (!pc) return;
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
  } catch (e) {
    console.error('Error setting remote description for answer', e);
  }
});

socket.on('ice-candidate', async (payload) => {
  const from = payload.from;
  const pc = peers[from];
  if (!pc) return;
  try {
    await pc.addIceCandidate(new RTCIceCandidate(payload.candidate));
  } catch (e) {
    console.error('Error adding received ice candidate', e);
  }
});

socket.on('user-disconnected', id => {
  if (peers[id]) {
    try { peers[id].close(); } catch (e) {}
    delete peers[id];
  }
  if (remoteVideos[id]) {
    remoteVideos[id].remove();
    delete remoteVideos[id];
  }
  updateParticipants();
});

// Controls
const copyLinkBtn = document.getElementById('copyLink');
copyLinkBtn.onclick = () => {
  const url = window.location.href;
  navigator.clipboard.writeText(url).then(() => alert('Link copied to clipboard'));
};

const toggleAudioBtn = document.getElementById('toggleAudio');
const toggleVideoBtn = document.getElementById('toggleVideo');

toggleAudioBtn.onclick = () => {
  if (!localStream) return;
  const audioTrack = localStream.getAudioTracks()[0];
  if (!audioTrack) return;
  audioTrack.enabled = !audioTrack.enabled;
  toggleAudioBtn.textContent = audioTrack.enabled ? 'Mute' : 'Unmute';
};

toggleVideoBtn.onclick = () => {
  if (!localStream) return;
  const videoTrack = localStream.getVideoTracks()[0];
  if (!videoTrack) return;
  videoTrack.enabled = !videoTrack.enabled;
  toggleVideoBtn.textContent = videoTrack.enabled ? 'Stop Video' : 'Start Video';
};

// Recording (client-side composite of all visible videos)
let recorder;
let recordedChunks = [];
let recordingCanvas, canvasStream, audioContext, audioDestination, drawInterval;

async function startRecording() {
  // build canvas
  recordingCanvas = document.createElement('canvas');
  const videos = document.querySelectorAll('.videoTile');
  const cols = Math.ceil(Math.sqrt(videos.length));
  const rows = Math.ceil(videos.length / cols);
  const w = 640, h = 480;
  recordingCanvas.width = cols * w;
  recordingCanvas.height = rows * h;
  const ctx = recordingCanvas.getContext('2d');

  // audio mixing
  audioContext = new (window.AudioContext || window.webkitAudioContext)();
  audioDestination = audioContext.createMediaStreamDestination();

  // connect all video elements' audio to destination
  videos.forEach(v => {
    try {
      const src = audioContext.createMediaElementSource(v);
      src.connect(audioDestination);
    } catch (e) {
      // ignore if cannot connect
    }
  });
  // also connect local stream audio
  if (localStream && localStream.getAudioTracks().length) {
    const localAudio = audioContext.createMediaStreamSource(new MediaStream([localStream.getAudioTracks()[0]]));
    localAudio.connect(audioDestination);
  }

  // draw loop
  function draw() {
    const vids = Array.from(document.querySelectorAll('.videoTile'));
    const cols = Math.ceil(Math.sqrt(vids.length)) || 1;
    const rows = Math.ceil(vids.length / cols) || 1;
    const w = 640, h = 480;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, recordingCanvas.width, recordingCanvas.height);
    vids.forEach((v, i) => {
      const x = (i % cols) * w;
      const y = Math.floor(i / cols) * h;
      try { ctx.drawImage(v, x, y, w, h); } catch (e) {}
    });
    drawInterval = requestAnimationFrame(draw);
  }
  draw();

  canvasStream = recordingCanvas.captureStream(25);
  // combine canvas video track(s) and audioDestination tracks
  const mixedStream = new MediaStream();
  canvasStream.getVideoTracks().forEach(t => mixedStream.addTrack(t));
  audioDestination.stream.getAudioTracks().forEach(t => mixedStream.addTrack(t));

  recordedChunks = [];
  recorder = new MediaRecorder(mixedStream, { mimeType: 'video/webm;codecs=vp9,opus' });
  recorder.ondataavailable = e => { if (e.data.size) recordedChunks.push(e.data); };
  recorder.onstop = () => {
    const blob = new Blob(recordedChunks, { type: 'video/webm' });
    const url = URL.createObjectURL(blob);
    const dl = document.getElementById('downloadLink');
    dl.style.display = 'block';
    dl.href = url;
    dl.download = `recording-${roomId}-${Date.now()}.webm`;
  };
  recorder.start();
  document.getElementById('startRec').disabled = true;
  document.getElementById('stopRec').disabled = false;
}

function stopRecording() {
  if (recorder && recorder.state !== 'inactive') recorder.stop();
  if (drawInterval) cancelAnimationFrame(drawInterval);
  if (audioContext) audioContext.close();
  if (recordingCanvas) recordingCanvas.remove();
  document.getElementById('startRec').disabled = false;
  document.getElementById('stopRec').disabled = true;
}

document.getElementById('startRec').onclick = startRecording;
document.getElementById('stopRec').onclick = stopRecording;

// cleanup on unload
window.addEventListener('beforeunload', () => {
  try { socket.close(); } catch (e) {}
});
