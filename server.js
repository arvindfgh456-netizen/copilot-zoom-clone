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
const MAX_HISTORY = 200;

io.on('connection', socket => {
  socket.on('join-room', roomId => {
    socket.join(roomId);
    // send list of other users in the room to the joining socket
    const clients = Array.from(io.sockets.adapter.rooms.get(roomId) || []);
    const otherClients = clients.filter(id => id !== socket.id);
    socket.emit('all-users', otherClients);

    // send chat history to the joining client
    const hist = messageHistory.get(roomId) || [];
    socket.emit('chat-history', hist);
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
    rooms.forEach(roomId => socket.to(roomId).emit('user-disconnected', socket.id));
  });
});

server.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));
