// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const peers = {}; // Store peer connections

io.on('connection', socket => {
  console.log(`Peer connected: ${socket.id}`);

  socket.on('join', ({ peerId }) => {
    peers[peerId] = socket.id;
    console.log(`${peerId} joined`);
  });

  socket.on('offer', ({ to, sdp }) => {
    if (peers[to]) io.to(peers[to]).emit('offer', { from: socket.id, sdp });
  });

  socket.on('answer', ({ to, sdp }) => {
    if (peers[to]) io.to(peers[to]).emit('answer', { from: socket.id, sdp });
  });

  socket.on('candidate', ({ to, candidate }) => {
    if (peers[to]) io.to(peers[to]).emit('candidate', { from: socket.id, candidate });
  });

  socket.on('leave', ({ peerId }) => {
    delete peers[peerId];
    console.log(`${peerId} left`);
  });

  socket.on('disconnect', () => {
    for (const [id, sid] of Object.entries(peers)) {
      if (sid === socket.id) delete peers[id];
    }
    console.log(`Peer disconnected: ${socket.id}`);
  });
});

server.listen(3000, () => console.log('SFU server running on port 3000'));
