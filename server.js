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

io.on('connection', socket => {
  socket.on('join-room', roomId => {
    socket.join(roomId);
    // send list of other users in the room to the joining socket
    const clients = Array.from(io.sockets.adapter.rooms.get(roomId) || []);
    const otherClients = clients.filter(id => id !== socket.id);
    socket.emit('all-users', otherClients);
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

  socket.on('disconnecting', () => {
    const rooms = Array.from(socket.rooms).filter(r => r !== socket.id);
    rooms.forEach(roomId => socket.to(roomId).emit('user-disconnected', socket.id));
  });
});

server.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));
