const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const { v4: uuidv4 } = require("uuid");
const path = require("path");
 
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
 
const PORT = process.env.PORT || 3000;
 
// Serve static files from /public
app.use(express.static(path.join(__dirname, "public")));
 
let clients = {}; // { id: ws }
 
wss.on("connection", (ws) => {
  const id = uuidv4();
  clients[id] = ws;
  console.log(`🟢 Client connected: ${id}`);
 
  ws.on("message", (msg) => {
    let data;
    try {
      data = JSON.parse(msg);
    } catch (err) {
      console.log("Invalid JSON:", msg);
      return;
    }
 
    switch (data.type) {
      case "join":
        broadcast({ type: "user-joined", id });
        break;
 
      case "offer":
        broadcastExcept(id, { type: "offer", id, offer: data.offer });
        break;
 
      case "answer":
        broadcastExcept(id, { type: "answer", id, answer: data.answer });
        break;
 
      case "ice":
        broadcastExcept(id, { type: "ice", id, candidate: data.candidate });
        break;
 
      case "chat":
        broadcast({ type: "chat", id, message: data.message });
        break;
    }
  });
 
  ws.on("close", () => {
    delete clients[id];
    broadcast({ type: "user-left", id });
    console.log(`🔴 Client disconnected: ${id}`);
  });
});
 
function broadcast(data) {
  Object.values(clients).forEach((client) => {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(data));
  });
}
 
function broadcastExcept(senderId, data) {
  Object.entries(clients).forEach(([id, client]) => {
    if (id !== senderId && client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}
 
server.listen(PORT, () => {
  console.log(`✅ SFU signaling server running on port ${PORT}`);
});
