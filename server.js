const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

// Express setup
const app = express();
const port = process.env.PORT || 3000;
app.use(express.static(path.join(__dirname, 'public')));

// Add CORS headers for WebRTC connections
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Map to store clients and peer connections
const clients = new Map();
const peerConnections = new Map();

// Store local streams for each broadcasting client
const localStreams = new Map();
const videoSources = new Set();

// Standard WebRTC configuration
const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { 
      urls: 'turn:openrelay.metered.ca:80',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    }
  ]
};

wss.on('connection', (ws) => {
  const clientId = Date.now().toString(); // unique client ID
  clients.set(clientId, ws);
  console.log(`Client connected: ${clientId}`);
  console.log(`Total clients: ${clients.size}`);

  // Send welcome message with active clients and video sources
  ws.send(JSON.stringify({ 
    type: 'welcome', 
    clientId, 
    clients: Array.from(clients.keys()),
    videoSources: Array.from(videoSources)
  }));

  ws.on('message', (msg) => {
    let data;
    try {
      data = JSON.parse(msg);
      console.log(`Received message type: ${data.type} from: ${data.from || clientId}`);
    } catch (err) {
      console.error('Invalid JSON', msg);
      return;
    }

    // Add sender ID if not present
    if (!data.from) {
      data.from = clientId;
    }

    // Handle specific message types
    switch (data.type) {
      case 'NEWPEER':
        // Track this as a potential video source
        console.log(`New peer connected: ${data.from}`);
        break;

      case 'sender-ready':
        // Client is ready to send video
        console.log(`${data.from} is ready to send video`);
        videoSources.add(data.from);
        
        // Broadcast to all clients that a video sender is available
        clients.forEach((client, id) => {
          if (id !== data.from && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
              type: 'sender-ready',
              from: data.from,
              to: id
            }));
          }
        });
        break;

      case 'video-request':
        // Client is requesting video from this server
        console.log(`Video requested by ${data.from}, creating offer`);
        handleVideoRequest(data);
        break;

      case 'offer':
        // Handle incoming WebRTC offer
        console.log(`Received offer from ${data.from} to ${data.to}`);
        if (data.to && clients.has(data.to)) {
          clients.get(data.to).send(JSON.stringify(data));
        }
        break;

      case 'answer':
        // Handle incoming WebRTC answer
        console.log(`Received answer from ${data.from} to ${data.to}`);
        if (data.to && clients.has(data.to)) {
          clients.get(data.to).send(JSON.stringify(data));
        }
        
        // If this server is the recipient, set remote description
        if (data.to === clientId && peerConnections.has(data.from)) {
          const pc = peerConnections.get(data.from);
          const desc = { type: 'answer', sdp: data.sdp };
          pc.setRemoteDescription(desc)
            .then(() => console.log(`Set remote description from ${data.from}`))
            .catch(err => console.error("Error setting remote description:", err));
        }
        break;

      case 'ice-candidate':
        // Handle ICE candidate exchange
        console.log(`Received ICE candidate from ${data.from} to ${data.to}`);
        if (data.to && clients.has(data.to)) {
          clients.get(data.to).send(JSON.stringify(data));
        }
        
        // If this server is the recipient, add ICE candidate
        if (data.to === clientId && peerConnections.has(data.from)) {
          const pc = peerConnections.get(data.from);
          pc.addIceCandidate(data.candidate)
            .catch(e => console.error('Error adding received ice candidate', e));
        }
        break;

      default:
        // Forward to specific client
        if (data.to && clients.has(data.to)) {
          clients.get(data.to).send(JSON.stringify(data));
        }
        
        // Broadcast if requested
        if (data.broadcast) {
          clients.forEach((client, id) => {
            if (id !== data.from && client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify(data));
            }
          });
        }
    }
  });

  ws.on('close', () => {
    // Clean up resources for this client
    cleanupClient(clientId);
    
    console.log(`Client disconnected: ${clientId}`);
    console.log(`Total clients: ${clients.size}`);
  });

  ws.on('error', (err) => console.error('WebSocket error:', err));
});

// Function to handle video requests
function handleVideoRequest(data) {
  // Verify the request is valid
  if (!data.from) return;
  
  // Get the requesting client's websocket
  const requestingClient = clients.get(data.from);
  if (!requestingClient || requestingClient.readyState !== WebSocket.OPEN) return;
  
  // Check if we have a stream to send
  if (!hasLocalStream()) {
    console.log("No local stream available to send");
    setupDummyStream();
  }
  
  // Create a new peer connection for this client if needed
  if (!peerConnections.has(data.from)) {
    console.log(`Creating new peer connection for ${data.from}`);
    const peerConnection = new RTCPeerConnection(rtcConfig);
    peerConnections.set(data.from, peerConnection);
    
    // Add local media tracks to the connection
    const stream = getLocalStream();
    if (stream) {
      stream.getTracks().forEach(track => {
        peerConnection.addTrack(track, stream);
        console.log(`Added ${track.kind} track to peer connection`);
      });
    }
    
    // Handle ICE candidates
    peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        console.log(`Sending ICE candidate to ${data.from}`);
        requestingClient.send(JSON.stringify({
          type: 'ice-candidate',
          from: clientId,
          to: data.from,
          candidate: event.candidate
        }));
      }
    };
    
    // Connection state monitoring
    peerConnection.onconnectionstatechange = (event) => {
      console.log(`Connection state for ${data.from}: ${peerConnection.connectionState}`);
      if (peerConnection.connectionState === 'disconnected' || 
          peerConnection.connectionState === 'failed') {
        console.log(`Cleaning up failed connection to ${data.from}`);
        cleanupPeerConnection(data.from);
      }
    };
    
    // Create and send the offer
    peerConnection.createOffer()
      .then(offer => {
        console.log(`Setting local description for ${data.from}`);
        return peerConnection.setLocalDescription(offer);
      })
      .then(() => {
        console.log(`Sending offer to ${data.from}`);
        requestingClient.send(JSON.stringify({
          type: 'offer',
          from: clientId,
          to: data.from,
          sdp: peerConnection.localDescription.sdp
        }));
      })
      .catch(err => console.error("Error creating offer:", err));
  }
}

// Function to check if we have a local stream
function hasLocalStream() {
  return localStreams.has(clientId) && localStreams.get(clientId).getTracks().length > 0;
}

// Function to get the local stream, creating it if needed
function getLocalStream() {
  if (hasLocalStream()) {
    return localStreams.get(clientId);
  }
  return null;
}

// Function to setup a dummy video stream if needed
function setupDummyStream() {
  try {
    // Check if we're in a browser environment
    if (typeof navigator !== 'undefined' && navigator.mediaDevices) {
      console.log("Video loaded and playing");
      navigator.mediaDevices.getUserMedia({ video: true, audio: true })
        .then(stream => {
          localStreams.set(clientId, stream);
          videoSources.add(clientId);
          console.log("Captured stream from video");
          
          // Broadcast that we're ready to send video
          clients.forEach((client, id) => {
            if (id !== clientId && client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({
                type: 'sender-ready',
                from: clientId,
                to: id
              }));
            }
          });
          console.log("Broadcasted sender-ready message");
        })
        .catch(err => {
          console.error("Error getting media stream:", err);
          setupCanvasStream(); // Fallback to canvas
        });
    } else {
      console.log("No media devices available, using canvas stream");
      setupCanvasStream();
    }
  } catch (err) {
    console.error("Error setting up stream:", err);
  }
}

// Setup a canvas stream as fallback
function setupCanvasStream() {
  console.log("Creating canvas video stream");
  
  // This would need proper implementation in a browser environment
  // For now, just log that we would create one
  console.log("Canvas stream setup would happen here in browser");
}

// Clean up resources when a client disconnects
function cleanupClient(clientId) {
  // Remove from clients map
  clients.delete(clientId);
  
  // Clean up any peer connections
  cleanupPeerConnection(clientId);
  
  // Remove from video sources
  videoSources.delete(clientId);
  
  // Clean up local stream if this was a broadcaster
  if (localStreams.has(clientId)) {
    const stream = localStreams.get(clientId);
    if (stream) {
      stream.getTracks().forEach(track => track.stop());
    }
    localStreams.delete(clientId);
  }
  
  // Notify other clients that this source is gone
  clients.forEach((client, id) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({
        type: 'peer-disconnected',
        from: clientId,
        to: id
      }));
    }
  });
}

// Clean up a specific peer connection
function cleanupPeerConnection(peerId) {
  if (peerConnections.has(peerId)) {
    const pc = peerConnections.get(peerId);
    if (pc) {
      pc.onicecandidate = null;
      pc.ontrack = null;
      pc.onconnectionstatechange = null;
      
      // Close the connection
      pc.close();
    }
    peerConnections.delete(peerId);
  }
}

// If in browser environment, setup the stream immediately
if (typeof window !== 'undefined') {
  setupDummyStream();
}

server.listen(port, () => {
  console.log(`Server running on port ${port}`);
  console.log('WebRTC video streaming enabled');
});
