const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

// Create Express app
const app = express();
const port = process.env.PORT || 3000;

// Middleware for JSON parsing
app.use(express.json());

// Serve static files from the "public" directory
app.use(express.static(path.join(__dirname, 'public')));

// Add status endpoint for debugging
app.get('/api/status', (req, res) => {
  const status = {
    clients: Array.from(clients.keys()),
    videoSenders: Array.from(videoSenders.keys()),
    pendingMessages: Object.fromEntries(
      Array.from(pendingMessages.entries()).map(([key, messages]) => [
        key,
        {
          count: messages.length,
          types: messages.reduce((acc, msg) => {
            const type = msg.split('|')[0];
            acc[type] = (acc[type] || 0) + 1;
            return acc;
          }, {})
        }
      ])
    )
  };

  res.json(status);
});

// Add endpoint for Unity to check if server is ready
app.get('/api/ready', (req, res) => {
  const videoSendersCount = videoSenders.size;
  res.json({
    ready: videoSendersCount > 0,
    videoSenders: Array.from(videoSenders.keys()),
    message: videoSendersCount > 0 ?
      `Server ready with ${videoSendersCount} video senders` :
      'Server running but no video senders connected yet'
  });
});

// Add endpoint to broadcast message to all connected clients
app.get('/api/broadcast', (req, res) => {
  const message = req.query.message;
  
  if (!message) {
    return res.status(400).json({
      success: false,
      error: 'Missing message parameter',
      usage: '/api/broadcast?message=your_message_here'
    });
  }

  // Format the broadcast message with timestamp
  const timestamp = Date.now();
  let sentCount = 0;
  const sentToClients = [];

  // Send as DATA type so Unity's WebRTCManager forwards it to DataChannel event
  clients.forEach((ws, clientId) => {
    if (ws.readyState === WebSocket.OPEN) {
      // Format: DATA|SENDER_ID|RECEIVER_ID|MESSAGE_CONTENT
      const dataMessage = `DATA|SERVER|${clientId}|BROADCAST:${message}:${timestamp}`;
      ws.send(dataMessage);
      sentCount++;
      sentToClients.push(clientId);
      console.log(`✓ Sent to ${clientId}: ${dataMessage}`);
    } else {
      console.log(`✗ Skipped ${clientId}: WebSocket not open (state: ${ws.readyState})`);
    }
  });

  console.log(`📢 Broadcast DATA message to ${sentCount}/${clients.size} clients: "${message}"`);

  res.json({
    success: true,
    message: message,
    messageFormat: `BROADCAST:${message}:${timestamp}`,
    sentTo: sentCount,
    totalClients: clients.size,
    clients: sentToClients,
    timestamp: timestamp
  });
});

// POST endpoint for sending messages (more secure for sensitive data)
app.post('/api/broadcast', (req, res) => {
  const message = req.body.message;
  
  if (!message) {
    return res.status(400).json({
      success: false,
      error: 'Missing message in request body',
      usage: 'POST with JSON body: { "message": "your_message_here" }'
    });
  }

  // Format the broadcast message with timestamp
  const timestamp = Date.now();
  let sentCount = 0;
  const sentToClients = [];

  // Send as DATA type so Unity's WebRTCManager forwards it to DataChannel event
  clients.forEach((ws, clientId) => {
    if (ws.readyState === WebSocket.OPEN) {
      // Format: DATA|SENDER_ID|RECEIVER_ID|MESSAGE_CONTENT
      const dataMessage = `DATA|SERVER|${clientId}|BROADCAST:${message}:${timestamp}`;
      ws.send(dataMessage);
      sentCount++;
      sentToClients.push(clientId);
      console.log(`✓ Sent to ${clientId}: ${dataMessage}`);
    } else {
      console.log(`✗ Skipped ${clientId}: WebSocket not open (state: ${ws.readyState})`);
    }
  });

  console.log(`📢 Broadcast DATA message to ${sentCount}/${clients.size} clients: "${message}"`);

  res.json({
    success: true,
    message: message,
    messageFormat: `BROADCAST:${message}:${timestamp}`,
    sentTo: sentCount,
    totalClients: clients.size,
    clients: sentToClients,
    timestamp: timestamp
  });
});

// Create HTTP server
const server = http.createServer(app);

// Create WebSocket server
const wss = new WebSocket.Server({ server });

// Store connected clients with their peer IDs
const clients = new Map();

// Store video senders for quick reconnection when new clients join
const videoSenders = new Map();

// Store pending messages for late-joining clients (with TTL)
const pendingMessages = new Map();

// Clean up old pending messages periodically
setInterval(() => {
  const now = Date.now();
  const MAX_AGE = 60000; // 60 seconds
  
  pendingMessages.forEach((messages, peerId) => {
    const filtered = messages.filter(msg => (now - msg.timestamp) < MAX_AGE);
    if (filtered.length === 0) {
      pendingMessages.delete(peerId);
      console.log(`Cleared expired pending messages for ${peerId}`);
    } else if (filtered.length < messages.length) {
      pendingMessages.set(peerId, filtered);
      console.log(`Removed ${messages.length - filtered.length} expired messages for ${peerId}`);
    }
  });
}, 30000); // Run every 30 seconds

// Handle WebSocket connections
wss.on('connection', (ws) => {
  console.log('Client connected');
  let clientPeerId = null;

  // Handle messages from clients
  ws.on('message', (message) => {
    const messageStr = message.toString();
    console.log(`Received message: ${messageStr}`);
    
    try {
      // Parse message format: TYPE|SENDER_ID|RECEIVER_ID|MESSAGE|CONNECTION_COUNT|IS_VIDEO_AUDIO_SENDER
      const parts = messageStr.split('|');
      const type = parts[0];
      const senderId = parts[1];
      const receiverId = parts[2];
      const msgContent = parts[3];
      const connectionCount = parts[4] || '0';
      const isVideoAudioSender = parts[5] || 'false';
      
      // Register client with its ID when it announces itself
      if (type === 'NEWPEER') {
        clientPeerId = senderId;
        
        // Clean up old connection if it exists
        if (clients.has(senderId)) {
          console.log(`Client ${senderId} reconnecting, cleaning up old connection`);
          const oldWs = clients.get(senderId);
          if (oldWs !== ws && oldWs.readyState === WebSocket.OPEN) {
            oldWs.close();
          }
        }
        
        clients.set(senderId, ws);
        console.log(`Registered client with ID: ${senderId}`);
        
        // Check if this is a video sender
        const isVideoSender = isVideoAudioSender === 'true';
        if (isVideoSender) {
          console.log(`Client ${senderId} registered as video sender`);
          videoSenders.set(senderId, { ws, timestamp: Date.now() });
        }
        
        // Broadcast to all clients
        broadcastMessage(messageStr, ws);
        
        // If this is a new client (not a video sender), inform them about existing video senders
        if (!isVideoSender) {
          console.log(`New client ${senderId} joined. Notifying existing video senders.`);
          videoSenders.forEach((sender, senderPeerId) => {
            if (sender.ws.readyState === WebSocket.OPEN) {
              // Notify the *video sender* about the *new client*
              const newClientAnnouncement = `NEWPEER|${senderId}|${senderPeerId}|New client joined|0|false`;
              sender.ws.send(newClientAnnouncement);
              console.log(`Notified video sender ${senderPeerId} about new client ${senderId}`);
            }
          });
        } else {
          // If a new video sender joins, notify all existing non-sender clients
          console.log(`New video sender ${senderId} joined. Notifying existing clients.`);
          clients.forEach((client, clientId) => {
            if (clientId !== senderId && !videoSenders.has(clientId)) {
              if (client.readyState === WebSocket.OPEN) {
                const senderAnnouncement = `NEWPEER|${senderId}|${clientId}|New video sender available|0|true`;
                client.send(senderAnnouncement);
                console.log(`Notified client ${clientId} about new video sender ${senderId}`);
              }
            }
          });
        }
        
        // Send any pending messages for this client
        if (pendingMessages.has(senderId)) {
          const pending = pendingMessages.get(senderId);
          console.log(`Delivering ${pending.length} pending messages to ${senderId}`);
          pending.forEach(item => {
            ws.send(item.message);
          });
          pendingMessages.delete(senderId);
        }
      }
      // Handle peer-to-peer messages
      else if (receiverId && receiverId !== 'ALL') {
        // Ensure message has complete format
        let completeMessage = messageStr;
        const parts = messageStr.split('|');
        if (parts.length < 6) {
          // Add missing parts with default values
          while (parts.length < 4) {
            parts.push('');
          }
          if (parts.length === 4) {
            parts.push('0');
          }
          if (parts.length === 5) {
            parts.push('false');
          }
          completeMessage = parts.join('|');
        }
        
        // Send to specific client
        const targetClient = clients.get(receiverId);
        if (targetClient && targetClient.readyState === WebSocket.OPEN) {
          console.log(`Sending ${type} from ${senderId} to ${receiverId}`);
          targetClient.send(completeMessage);
        } else {
          console.log(`Target client ${receiverId} not found or not connected - storing message`);
          
          // Store important messages (OFFER and CANDIDATE) for clients who haven't connected yet
          if (type === 'OFFER' || type === 'CANDIDATE') {
            if (!pendingMessages.has(receiverId)) {
              pendingMessages.set(receiverId, []);
            }
            
            // Store the message with timestamp
            pendingMessages.get(receiverId).push({
              message: completeMessage,
              timestamp: Date.now()
            });
            
            const pending = pendingMessages.get(receiverId);
            console.log(`Stored ${type} message for ${receiverId} (total pending: ${pending.length})`);
            
            // Limit pending messages to prevent memory issues
            if (pending.length > 50) {
              // Keep the most recent OFFER and last 20 CANDIDATEs
              const offers = pending.filter(item => item.message.startsWith('OFFER'));
              const candidates = pending.filter(item => item.message.startsWith('CANDIDATE')).slice(-20);
              
              const filteredMessages = [...offers.slice(-1), ...candidates];
              pendingMessages.set(receiverId, filteredMessages);
              console.log(`Trimmed pending messages for ${receiverId} to ${filteredMessages.length} messages`);
            }
          }
        }
      }
      // Handle broadcast messages
      else if (receiverId === 'ALL') {
        // Broadcast to all clients except sender
        broadcastMessage(messageStr, ws);
      }
    } catch (err) {
      console.error('Error processing message:', err);
    }
  });

  // Handle client disconnections
  ws.on('close', () => {
    if (clientPeerId) {
      console.log(`Client ${clientPeerId} disconnected`);
      
      // Remove from clients map
      clients.delete(clientPeerId);
      
      // If it was a video sender, remove from video senders map
      if (videoSenders.has(clientPeerId)) {
        console.log(`Video sender ${clientPeerId} disconnected`);
        videoSenders.delete(clientPeerId);
      }
      
      // Don't immediately clear pending messages - they might reconnect
      // The periodic cleanup will handle old messages
      
      // Notify other clients about disconnection
      const disconnectMsg = `DISPOSE|${clientPeerId}|ALL|Remove peerConnection for ${clientPeerId}.|0|false`;
      broadcastMessage(disconnectMsg, null);
    } else {
      console.log('Unknown client disconnected');
    }
  });

  // Handle errors
  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

// Function to broadcast a message to all clients except the sender
function broadcastMessage(message, excludeClient) {
  // Ensure message has all 6 parts required by SimpleWebRTC
  const parts = message.split('|');
  if (parts.length < 6) {
    while (parts.length < 4) {
      parts.push('');
    }
    if (parts.length === 4) {
      parts.push('0');
    }
    if (parts.length === 5) {
      parts.push('false');
    }
    message = parts.join('|');
  }

  wss.clients.forEach((client) => {
    if (client !== excludeClient && client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

// Send periodic reminders about video senders (reduced frequency)
function sendVideoSenderReminders() {
  const unityClients = new Map([...clients.entries()].filter(([id]) => id.includes('Unity')));

  if (videoSenders.size > 0 && unityClients.size > 0) {
    console.log(`Sending video sender reminders to ${unityClients.size} Unity clients`);
    
    videoSenders.forEach((sender, senderPeerId) => {
      if (sender.ws.readyState === WebSocket.OPEN) {
        unityClients.forEach((unityClient, unityClientId) => {
          if (unityClient.readyState === WebSocket.OPEN) {
            const reminderMsg = `NEWPEER|${senderPeerId}|${unityClientId}|Video sender reminder|0|true`;
            unityClient.send(reminderMsg);
          }
        });
      }
    });
  }
}

// Reduced reminder frequency to every 30 seconds (was 10)
setInterval(sendVideoSenderReminders, 30000);

// Start the server
server.listen(port, () => {
  console.log(`Server is running on port ${port}`);
  console.log(`WebSocket server ready for connections`);
});
