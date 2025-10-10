// server.js
const express = require("express");
const http = require("http");
const { Server } = require("ws");
const { RTCPeerConnection } = require("wrtc");
const path = require("path");

const app = express();
const server = http.createServer(app);
const wss = new Server({ server });

app.use(express.static(path.join(__dirname, "public")));

let broadcaster = null;
const viewers = new Map();

wss.on("connection", (ws) => {
  console.log("New WebSocket connection");

  ws.on("message", async (message) => {
    const msg = JSON.parse(message);

    if (msg.type === "broadcaster") {
      console.log("Broadcaster connected");
      broadcaster = { ws, pc: new RTCPeerConnection() };

      broadcaster.pc.onicecandidate = ({ candidate }) => {
        if (candidate) ws.send(JSON.stringify({ type: "candidate", candidate }));
      };

      await broadcaster.pc.setRemoteDescription(msg.offer);
      const answer = await broadcaster.pc.createAnswer();
      await broadcaster.pc.setLocalDescription(answer);
      ws.send(JSON.stringify({ type: "answer", answer }));
    }

    if (msg.type === "viewer") {
      console.log("Viewer connected");
      const viewerPC = new RTCPeerConnection();
      viewers.set(ws, viewerPC);

      // Forward all broadcaster tracks to viewer
      broadcaster.pc.getSenders().forEach((sender) => {
        if (sender.track) viewerPC.addTrack(sender.track);
      });

      viewerPC.onicecandidate = ({ candidate }) => {
        if (candidate) ws.send(JSON.stringify({ type: "candidate", candidate }));
      };

      await viewerPC.setRemoteDescription(msg.offer);
      const answer = await viewerPC.createAnswer();
      await viewerPC.setLocalDescription(answer);
      ws.send(JSON.stringify({ type: "answer", answer }));
    }

    if (msg.type === "candidate") {
      const candidate = new RTCIceCandidate(msg.candidate);
      if (broadcaster && ws === broadcaster.ws)
        broadcaster.pc.addIceCandidate(candidate);
      else if (viewers.has(ws))
        viewers.get(ws).addIceCandidate(candidate);
    }
  });

  ws.on("close", () => {
    console.log("Client disconnected");
    if (broadcaster && ws === broadcaster.ws) broadcaster = null;
    viewers.delete(ws);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`SFU running on port ${PORT}`));
