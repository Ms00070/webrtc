const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const path = require("path");

const app = express();
const port = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const clients = new Map();

wss.on("connection", (ws) => {
  console.log("Client connected");
  let clientId = null;

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === "hello") {
        clientId = "peer_" + Date.now();
        clients.set(clientId, ws);
        console.log("Registered:", clientId);
        return;
      }

      // relay to specific peer
      if (msg.to && clients.has(msg.to)) {
        clients.get(msg.to).send(JSON.stringify({ ...msg, from: clientId }));
      }

      // broadcast
      if (msg.type === "broadcast") {
        clients.forEach((client, id) => {
          if (client !== ws && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ ...msg, from: clientId }));
          }
        });
      }
    } catch (err) {
      console.error("Message error:", err);
    }
  });

  ws.on("close", () => {
    console.log("Disconnected:", clientId);
    if (clientId) clients.delete(clientId);
  });
});

server.listen(port, () => console.log(`Server running on port ${port}`));
