const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
 
// Express setup
const app = express();
const port = process.env.PORT || 3000;
app.use(express.static(path.join(__dirname, 'public')));
 
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
 
// Map to store clients
const clients = new Map();
 
wss.on('connection', (ws) => {
  const clientId = Date.now().toString(); // unique client ID
  clients.set(clientId, ws);
  console.log(`Client connected: ${clientId}`);
  console.log(`Total clients: ${clients.size}`);
 
  ws.send(JSON.stringify({ type: 'welcome', clientId, clients: Array.from(clients.keys()) }));
 
  ws.on('message', (msg) => {
    let data;
    try {
      data = JSON.parse(msg);
    } catch (err) {
      console.error('Invalid JSON', msg);
      return;
    }
 
    // Forward to specific client
    if (data.to && clients.has(data.to)) {
      clients.get(data.to).send(JSON.stringify({ from: clientId, ...data }));
    }
 
    // Broadcast
    if (data.broadcast) {
      clients.forEach((client, id) => {
        if (id !== clientId && client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ from: clientId, ...data }));
        }
      });
    }
  });
 
  ws.on('close', () => {
    clients.delete(clientId);
    console.log(`Client disconnected: ${clientId}`);
    console.log(`Total clients: ${clients.size}`);
  });
 
  ws.on('error', (err) => console.error('WebSocket error:', err));
});
 
server.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
 
