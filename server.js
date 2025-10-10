const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const mediasoup = require('mediasoup');
const { spawn } = require('child_process');
const path = require('path');

const app = express();
const server = http.createServer(app);
const port = 3000;

app.use(express.static(path.join(__dirname, 'public')));
const wss = new WebSocket.Server({ server });

let worker, router, plainTransport, producer;

// Create Mediasoup Worker + Router
(async () => {
  worker = await mediasoup.createWorker();
  router = await worker.createRouter({
    mediaCodecs: [
      {
        kind: 'video',
        mimeType: 'video/VP8',
        clockRate: 90000,
      },
    ],
  });

  console.log('Mediasoup worker & router ready ✅');

  // Start pulling from your mobile camera HTTP feed
  await createCameraProducer('http://192.0.0.04:8080/video'); // Replace with your local IP
})();

async function createCameraProducer(url) {
  plainTransport = await router.createPlainTransport({
    listenIp: { ip: '0.0.0.0' },
    rtcpMux: false,
    comedia: true,
  });

  console.log('PlainRTP listening on', plainTransport.tuple);

  // FFmpeg pulls the HTTP stream and sends RTP to the SFU
  const ffmpeg = spawn('ffmpeg', [
    '-re',
    '-i', url,
    '-an', // no audio
    '-c:v', 'libvpx', // encode to VP8
    '-f', 'rtp',
    `rtp://${plainTransport.tuple.localIp}:${plainTransport.tuple.localPort}`,
  ]);

  ffmpeg.stderr.on('data', (data) => console.log('FFmpeg:', data.toString()));

  // Wait a little before producing
  setTimeout(async () => {
    producer = await plainTransport.produce({
      kind: 'video',
      rtpParameters: {
        codecs: [
          {
            mimeType: 'video/VP8',
            payloadType: 96,
            clockRate: 90000,
            parameters: {},
          },
        ],
      },
    });

    console.log('Camera Producer created:', producer.id);
  }, 5000);
}

// Simple WebSocket signaling (for clients to consume video)
wss.on('connection', async (ws) => {
  console.log('New WebSocket client');

  ws.on('message', async (message) => {
    const msg = JSON.parse(message);

    switch (msg.action) {
      case 'getRouterRtpCapabilities':
        ws.send(JSON.stringify({
          action: 'routerRtpCapabilities',
          data: router.rtpCapabilities,
        }));
        break;

      default:
        console.log('Unknown message:', msg);
    }
  });
});

server.listen(port, () => console.log(`Server running on http://localhost:${port}`));
