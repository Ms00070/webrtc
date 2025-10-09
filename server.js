// server.js
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

console.log(`WebSocket signaling server running on ws://localhost:${PORT} or deployed URL`);

const peers = new Map(); // key: peerId, value: ws connection

wss.on('connection', ws => {
  ws.on('message', message => {
    const msgStr = message.toString();
    // All messages are plain text in your format: TYPE|SENDER|RECEIVER|MSG|CONNECTION_COUNT|IS_VIDEO_AUDIO_SENDER
    const parts = msgStr.split('|');
    const type = parts[0];
    const senderId = parts[1];
    const receiverId = parts[2];

    if (type === 'NEWPEER') {
      peers.set(senderId, ws);
      console.log(`New peer connected: ${senderId}`);
      // Send NEWPEERACK to all other peers
      broadcast(`NEWPEERACK|Server|ALL|Peer ${senderId} joined|0|false`, senderId);
      return;
    }

    if (type === 'DISPOSE') {
      peers.delete(senderId);
      console.log(`Peer disconnected: ${senderId}`);
      broadcast(`DISPOSE|${senderId}|ALL|Peer disconnected|0|false`);
      return;
    }

    // Relay other messages to the intended receiver(s)
    if (receiverId === 'ALL') {
      broadcast(msgStr, senderId);
    } else {
      const dest = peers.get(receiverId);
      if (dest && dest.readyState === WebSocket.OPEN) {
        dest.send(msgStr);
      }
    }
  });

  ws.on('close', () => {
    // Remove from peers map if a connection closes unexpectedly
    for (const [id, socket] of peers.entries()) {
      if (socket === ws) {
        peers.delete(id);
        console.log(`Peer connection closed: ${id}`);
        broadcast(`DISPOSE|${id}|ALL|Peer disconnected|0|false`);
      }
    }
  });
});

// Broadcast to all peers except sender
function broadcast(message, senderId) {
  for (const [id, socket] of peers.entries()) {
    if (id !== senderId && socket.readyState === WebSocket.OPEN) {
      socket.send(message);
    }
  }
}
