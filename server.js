import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import { fileURLToPath } from "url";
 
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
 
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 3000;
 
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
      console.log("Invalid JSON", msg);
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
    if (client.readyState === 1) client.send(JSON.stringify(data));
  });
}
 
function broadcastExcept(senderId, data) {
  Object.entries(clients).forEach(([id, client]) => {
    if (id !== senderId && client.readyState === 1)
      client.send(JSON.stringify(data));
  });
}
 
server.listen(PORT, () => {
  console.log(`✅ SFU server running on port ${PORT}`);
});
 
