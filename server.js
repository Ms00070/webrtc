// Simple WebSocket signaling server
const WebSocket = require("ws");

const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });
const clients = {};

wss.on("connection", (ws) => {
  console.log("New WebSocket connection");

  ws.on("message", (msg) => {
    const message = msg.toString();

    // Registration
    if (message.startsWith("{")) {
      try {
        const parsed = JSON.parse(message);
        if (parsed.type === "register") {
          clients[parsed.id] = ws;
          console.log(`Client registered: ${parsed.id}`);

          // Broadcast JOINED
          Object.values(clients).forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(`JOINED|${parsed.id}`);
            }
          });
          return;
        }
      } catch (err) {
        console.error("Bad JSON:", err);
      }
    }

    // Signaling relay (OFFER, ANSWER, CANDIDATE)
    const parts = message.split("|", 4);
    if (parts.length === 4) {
      const [type, sender, target, payload] = parts;
      if (clients[target] && clients[target].readyState === WebSocket.OPEN) {
        clients[target].send(message);
      }
    }
  });

  ws.on("close", () => {
    for (const id in clients) {
      if (clients[id] === ws) {
        console.log(`Client disconnected: ${id}`);
        delete clients[id];
        // Broadcast DISCONNECTED
        Object.values(clients).forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(`DISCONNECTED|${id}`);
          }
        });
      }
    }
  });
});

console.log(`Signaling server running on ws://localhost:${PORT}`);
