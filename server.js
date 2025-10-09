// server.js
const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const mediasoup = require('mediasoup');

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

const port = process.env.PORT || 3000;

// Serve static files
app.use(express.static('public'));

// Mediasoup server variables
let worker, router;
const peers = {}; // { socketId: { transports: [], producers: [], consumers: [] } }

// Initialize Mediasoup Worker
async function initMediasoup() {
  worker = await mediasoup.createWorker({
    logLevel: 'warn',
    rtcMinPort: 10000,
    rtcMaxPort: 10100,
  });
  router = await worker.createRouter({ mediaCodecs: [
    {
      kind: 'audio',
      mimeType: 'audio/opus',
      clockRate: 48000,
      channels: 2
    },
    {
      kind: 'video',
      mimeType: 'video/VP8',
      clockRate: 90000,
      parameters: {}
    }
  ]});
  console.log('Mediasoup worker and router initialized');
}

initMediasoup();

// Socket.io connection
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  peers[socket.id] = { transports: [], producers: [], consumers: [] };

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    const peer = peers[socket.id];
    if (peer) {
      peer.transports.forEach(t => t.close());
      peer.producers.forEach(p => p.close());
      peer.consumers.forEach(c => c.close());
    }
    delete peers[socket.id];
  });

  // Create WebRTC Transport
  socket.on('createTransport', async (callback) => {
    const transport = await router.createWebRtcTransport({
      listenIps: [{ ip: '0.0.0.0', announcedIp: null }],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true
    });
    peers[socket.id].transports.push(transport);

    callback({
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters
    });
  });

  // Connect transport
  socket.on('connectTransport', async ({ transportId, dtlsParameters }, callback) => {
    const transport = peers[socket.id].transports.find(t => t.id === transportId);
    if (!transport) return;
    await transport.connect({ dtlsParameters });
    callback('ok');
  });

  // Produce (send) media
  socket.on('produce', async ({ transportId, kind, rtpParameters }, callback) => {
    const transport = peers[socket.id].transports.find(t => t.id === transportId);
    if (!transport) return;
    const producer = await transport.produce({ kind, rtpParameters });
    peers[socket.id].producers.push(producer);

    // Notify all other peers to consume this producer
    for (const otherId in peers) {
      if (otherId !== socket.id) {
        io.to(otherId).emit('newProducer', { producerId: producer.id, producerSocketId: socket.id, kind });
      }
    }

    callback({ id: producer.id });
  });

  // Consume media
  socket.on('consume', async ({ transportId, producerId }, callback) => {
    const transport = peers[socket.id].transports.find(t => t.id === transportId);
    if (!transport) return;

    const producerSocketId = Object.keys(peers).find(id => peers[id].producers.find(p => p.id === producerId));
    if (!producerSocketId) return;

    const consumer = await transport.consume({
      producerId,
      rtpCapabilities: router.rtpCapabilities,
      paused: false
    });

    peers[socket.id].consumers.push(consumer);

    callback({
      id: consumer.id,
      producerId,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters
    });
  });
});

// Start server
server.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
