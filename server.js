const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

app.get('/create', (req, res) => {
  const id = uuidv4();
  res.redirect(`/room/${id}`);
});

app.get('/room/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'room.html'));
});

// In-memory chat history per room (not persisted). Keep small to avoid memory bloat.
const messageHistory = new Map(); // roomId -> [{id, from, text, ts}]
const roomIPs = new Map(); // roomId -> IP address (from first user)
const roomParticipants = new Map(); // roomId -> Map(socketId -> {name})
const roomAdmin = new Map(); // roomId -> socketId
const MAX_HISTORY = 200;

// Helper: Extract client IP address
function getClientIP(socket) {
  return (
    socket.handshake.headers['x-forwarded-for']?.split(',')[0].trim() ||
    socket.handshake.address ||
    socket.conn.remoteAddress ||
    'unknown'
  );
}

io.on('connection', socket => {
  socket.on('join-room', payload => {
    // payload can be string roomId (legacy) or { roomId, name }
    let roomId, name;
    if (typeof payload === 'string') {
      roomId = payload;
      name = '';
    } else {
      roomId = payload && payload.roomId;
      name = payload && payload.name || '';
    }
    if (!roomId) return;

    const clientIP = getClientIP(socket);

    // Check if room exists and if IPs match
    if (roomIPs.has(roomId)) {
      const roomIP = roomIPs.get(roomId);
      if (clientIP !== roomIP) {
        socket.emit('ip-mismatch', {
          error: 'You cannot join this room. Different IP address detected.',
          yourIP: clientIP,
          roomIP: roomIP
        });
        return;
      }
    } else {
      // First user in the room: store their IP
      roomIPs.set(roomId, clientIP);
    }

    // add to participants map
    let parts = roomParticipants.get(roomId);
    if (!parts) {
      parts = new Map();
      roomParticipants.set(roomId, parts);
    }
    parts.set(socket.id, { name: String(name || '').slice(0,50) });

    // set admin if none
    if (!roomAdmin.has(roomId)) {
      roomAdmin.set(roomId, socket.id);
    }

    socket.join(roomId);

    // send list of other users in the room to the joining socket (legacy)
    const clients = Array.from(io.sockets.adapter.rooms.get(roomId) || []);
    const otherClients = clients.filter(id => id !== socket.id);
    socket.emit('all-users', otherClients);

    // send chat history to the joining client
    const hist = messageHistory.get(roomId) || [];
    socket.emit('chat-history', hist);

    // emit updated participants list to everyone in room
    const adminId = roomAdmin.get(roomId);
    const arr = [];
    let unnamedCount = 1;
    for (const [id, info] of parts.entries()) {
      // prefer the provided name; fallback to 'Admin' for admin or 'PersonX' for unnamed
      if (id === adminId) {
        const display = info.name && info.name.length ? info.name : 'Admin';
        arr.push({ id, name: display, role: 'admin' });
      } else {
        const display = (info.name && info.name.length) ? info.name : `Person${unnamedCount}`;
        if (!info.name || !info.name.length) unnamedCount++;
        arr.push({ id, name: display, role: 'person' });
      }
    }
    io.to(roomId).emit('participants', arr);
  });

  socket.on('offer', payload => {
    io.to(payload.to).emit('offer', { from: socket.id, sdp: payload.sdp });
  });

  socket.on('answer', payload => {
    io.to(payload.to).emit('answer', { from: socket.id, sdp: payload.sdp });
  });

  socket.on('ice-candidate', payload => {
    io.to(payload.to).emit('ice-candidate', { from: socket.id, candidate: payload.candidate });
  });

  // Chat messages: broadcast to everyone in the room and save to history
  socket.on('chat-message', ({ roomId, text, name }) => {
    if (!roomId || !text) return;
    const cleanText = String(text).slice(0, 2000);
    const msg = { id: socket.id, from: (name && String(name).slice(0,50)) || socket.id, text: cleanText, ts: Date.now() };
    // save
    const arr = messageHistory.get(roomId) || [];
    arr.push(msg);
    if (arr.length > MAX_HISTORY) arr.shift();
    messageHistory.set(roomId, arr);
    // broadcast
    io.to(roomId).emit('chat-message', msg);
  });

  socket.on('disconnecting', () => {
    const rooms = Array.from(socket.rooms).filter(r => r !== socket.id);
    rooms.forEach(roomId => {
      // notify others
      socket.to(roomId).emit('user-disconnected', socket.id);

      // remove from participants
      const parts = roomParticipants.get(roomId);
      if (parts) {
        parts.delete(socket.id);
        // if admin left, choose a new admin
        const adminId = roomAdmin.get(roomId);
        if (adminId === socket.id) {
          const first = parts && Array.from(parts.keys())[0];
          if (first) roomAdmin.set(roomId, first);
          else {
            roomAdmin.delete(roomId);
            roomIPs.delete(roomId);
            roomParticipants.delete(roomId);
          }
        }

        // emit updated participants
        const newAdmin = roomAdmin.get(roomId);
        const arr = [];
        let personCount = 1;
        if (parts) {
          for (const [id, info] of parts.entries()) {
            if (id === newAdmin) arr.push({ id, name: info.name || 'Admin', role: 'admin' });
            else { arr.push({ id, name: `Person${personCount}`, role: 'person' }); personCount++; }
          }
        }
        io.to(roomId).emit('participants', arr);
      }
    });
  });

  // File send: receive a data URL or small file payload and broadcast to room
  socket.on('file-send', (payload) => {
    try {
      const { roomId, filename, type, dataUrl, size, name } = payload || {};
      if (!roomId || !filename || !dataUrl) return;
      const fileMsg = {
        fileId: uuidv4(),
        id: socket.id,
        from: (name && String(name).slice(0,50)) || socket.id,
        filename: String(filename).slice(0,200),
        type: String(type || ''),
        size: Number(size) || (dataUrl.length || 0),
        dataUrl,
        ts: Date.now()
      };
      io.to(roomId).emit('file-received', fileMsg);
    } catch (e) { console.error('file-send error', e); }
  });
});

server.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));
