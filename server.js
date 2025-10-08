const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');

// Express setup
const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ 
  server,
  // Allow WebSocket path selection
  path: '/' 
});

// Configure storage for video uploads
const videosDir = path.join(__dirname, 'videos');
if (!fs.existsSync(videosDir)) {
  fs.mkdirSync(videosDir);
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, videosDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, file.fieldname + '-' + uniqueSuffix + ext);
  }
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('video/')) {
      cb(null, true);
    } else {
      cb(new Error('Only video files are allowed'));
    }
  },
  limits: {
    fileSize: 100 * 1024 * 1024 // 100MB limit
  }
});

// Store available videos
const videos = new Map();

// Load existing videos
function loadVideos() {
  if (!fs.existsSync(videosDir)) return;
  
  const files = fs.readdirSync(videosDir);
  files.filter(file => {
    const ext = path.extname(file).toLowerCase();
    return ['.mp4', '.webm', '.ogg'].includes(ext);
  }).forEach(file => {
    const videoId = uuidv4();
    const videoPath = path.join(videosDir, file);
    const stats = fs.statSync(videoPath);
    
    videos.set(videoId, {
      id: videoId,
      name: file,
      path: videoPath,
      type: `video/${path.extname(file).substring(1)}`,
      size: stats.size,
      created: stats.birthtime
    });
  });
  
  console.log(`Loaded ${videos.size} videos from disk`);
}

loadVideos();

// Map to store client connections
const clients = new Map(); // clientId -> { ws, info, connectionTime }

// Configure routes for video API
app.get('/api/videos', (req, res) => {
  res.json(Array.from(videos.values()).map(video => ({
    id: video.id,
    name: video.name,
    type: video.type,
    size: video.size,
    created: video.created
  })));
});

app.post('/api/videos', upload.single('video'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No video file uploaded' });
  }
  
  const videoId = uuidv4();
  const videoPath = path.join(videosDir, req.file.filename);
  const stats = fs.statSync(videoPath);
  
  const videoData = {
    id: videoId,
    name: req.file.originalname,
    path: videoPath,
    type: req.file.mimetype,
    size: stats.size,
    created: new Date()
  };
  
  videos.set(videoId, videoData);
  console.log(`Added new video: ${req.file.originalname} (${videoId})`);
  
  // Notify admin clients of new video
  broadcastToAdmins({
    type: 'admin-video-added',
    video: {
      id: videoId,
      name: req.file.originalname,
      type: req.file.mimetype,
      size: stats.size,
      created: videoData.created
    }
  });
  
  res.status(201).json({
    id: videoId,
    name: req.file.originalname,
    type: req.file.mimetype,
    size: stats.size,
    created: videoData.created
  });
});

app.delete('/api/videos/:id', (req, res) => {
  const videoId = req.params.id;
  
  if (!videos.has(videoId)) {
    return res.status(404).json({ error: 'Video not found' });
  }
  
  const video = videos.get(videoId);
  
  try {
    fs.unlinkSync(video.path);
    videos.delete(videoId);
    console.log(`Deleted video: ${video.name} (${videoId})`);
    
    // Notify admin clients of deleted video
    broadcastToAdmins({
      type: 'admin-video-deleted',
      videoId
    });
    
    res.status(204).end();
  } catch (err) {
    console.error(`Error deleting video ${videoId}:`, err);
    res.status(500).json({ error: 'Failed to delete video' });
  }
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// WebSocket connection handler
wss.on('connection', (ws, req) => {
  // Generate a unique client ID if not provided
  let clientId;
  let isAdmin = false;
  let isUnityClient = false;
  
  // Check if this is an admin connection
  if (req.url && req.url.startsWith('/admin')) {
    clientId = `admin-${Date.now().toString()}`;
    isAdmin = true;
  } else {
    clientId = Date.now().toString();
  }
  
  // Store client connection
  clients.set(clientId, { 
    ws,
    info: { id: clientId, isAdmin, isUnityClient },
    connectionTime: new Date(),
    status: 'connected'
  });
  
  console.log(`Client connected: ${clientId} (Admin: ${isAdmin})`);
  console.log(`Total clients: ${clients.size}`);
  
  // Send welcome message
  ws.send(JSON.stringify({ 
    type: 'welcome', 
    clientId, 
    clients: Array.from(clients.keys())
  }));
  
  // Notify admin clients of new connection
  if (!isAdmin) {
    broadcastToAdmins({
      type: 'admin-client-connected',
      client: {
        id: clientId,
        connectedAt: new Date(),
        status: 'connected',
        isUnityClient
      }
    });
  }
  
  // Message handler
  ws.on('message', async (msg) => {
    try {
      // Try to parse as JSON
      let data;
      let isRawProtocol = false;
      
      try {
        const msgStr = msg.toString();
        data = JSON.parse(msgStr);
      } catch (err) {
        // Not valid JSON, check if it might be the Unity custom protocol
        // Format: TYPE|SENDER_ID|RECEIVER_ID|MESSAGE|CONNECTION_COUNT|IS_VIDEO_AUDIO_SENDER
        const text = msg.toString();
        const parts = text.split('|');
        
        if (parts.length >= 4) {
          isRawProtocol = true;
          const [type, senderId, receiverId, message, connectionCount, isVideoAudioSender] = parts;
          
          // If this is a NEWPEER message, extract the client ID from it
          if (type === 'NEWPEER' && senderId) {
            // This is a Unity client
            clientId = senderId;
            isUnityClient = true;
            
            // Update client info
            if (clients.has(clientId)) {
              clients.delete(clientId); // Delete the temporary entry
            }
            
            clients.set(clientId, { 
              ws,
              info: { id: clientId, isAdmin: false, isUnityClient: true },
              connectionTime: new Date(),
              status: 'connected'
            });
            
            console.log(`Unity client identified: ${clientId}`);
            
            // Notify admins
            broadcastToAdmins({
              type: 'admin-client-connected',
              client: {
                id: clientId,
                connectedAt: new Date(),
                status: 'connected',
                isUnityClient: true
              }
            });
          }
          
          // Convert to our standard format
          data = {
            type,
            from: senderId,
            to: receiverId,
            message
          };
          
          // Special handling for custom protocol types
          if (type === 'OFFER') {
            data.type = 'offer';
            data.sdp = message;
          } else if (type === 'ANSWER') {
            data.type = 'answer';
            data.sdp = message;
          } else if (type === 'CANDIDATE') {
            data.type = 'ice-candidate';
            try {
              data.candidate = JSON.parse(message);
            } catch (e) {
              console.error('Error parsing ICE candidate:', e);
            }
          }
        } else {
          console.error('Invalid message format:', text);
          return;
        }
      }
      
      // Handle admin requests
      if (isAdmin && data.type === 'admin-request') {
        handleAdminRequest(ws, data);
        return;
      }
      
      // Forward to specific client
      if (data.to && data.to !== 'ALL' && clients.has(data.to)) {
        const targetClient = clients.get(data.to);
        if (targetClient.ws.readyState === WebSocket.OPEN) {
          // Format depends on client type
          if (targetClient.info.isUnityClient && !isRawProtocol) {
            // Convert to Unity protocol format
            const unityMessage = formatMessageForUnity(data);
            targetClient.ws.send(unityMessage);
          } else {
            targetClient.ws.send(JSON.stringify({ from: clientId, ...data }));
          }
        }
      }
      
      // Broadcast
      if (data.broadcast || data.to === 'ALL') {
        clients.forEach((client, id) => {
          if (id !== clientId && client.ws.readyState === WebSocket.OPEN) {
            // Format depends on client type
            if (client.info.isUnityClient && !isRawProtocol) {
              // Convert to Unity protocol format
              const unityMessage = formatMessageForUnity(data);
              client.ws.send(unityMessage);
            } else {
              client.ws.send(JSON.stringify({ from: clientId, ...data }));
            }
          }
        });
      }
    } catch (err) {
      console.error('Error handling message:', err);
    }
  });
  
  // Client disconnection handler
  ws.on('close', () => {
    // Notify admins if this wasn't an admin
    if (!isAdmin && clients.has(clientId)) {
      broadcastToAdmins({
        type: 'admin-client-disconnected',
        clientId
      });
    }
    
    // Remove from clients map
    clients.delete(clientId);
    
    console.log(`Client disconnected: ${clientId}`);
    console.log(`Total clients: ${clients.size}`);
  });
  
  // Error handler
  ws.on('error', (err) => console.error(`WebSocket error for ${clientId}:`, err));
});

// Format a message for Unity clients using their protocol
function formatMessageForUnity(data) {
  let type = data.type.toUpperCase();
  let message = data.message || '';
  
  // Handle special message types
  if (type === 'OFFER') {
    message = data.sdp || '';
  } else if (type === 'ANSWER') {
    message = data.sdp || '';
  } else if (type === 'ICE-CANDIDATE') {
    type = 'CANDIDATE';
    message = JSON.stringify(data.candidate) || '{}';
  }
  
  // Format: TYPE|SENDER_ID|RECEIVER_ID|MESSAGE|CONNECTION_COUNT|IS_VIDEO_AUDIO_SENDER
  const sender = data.from || 'server';
  const receiver = data.to || 'ALL';
  const connectionCount = '0';
  const isVideoAudioSender = 'false';
  
  return `${type}|${sender}|${receiver}|${message}|${connectionCount}|${isVideoAudioSender}`;
}

// Handle admin requests
async function handleAdminRequest(ws, data) {
  switch (data.action) {
    case 'get-state':
      // Send current state to admin
      ws.send(JSON.stringify({
        type: 'admin-state',
        clients: Array.from(clients.values()).filter(c => !c.info.isAdmin).map(c => ({
          id: c.info.id,
          connectedAt: c.connectionTime,
          status: c.status,
          isUnityClient: c.info.isUnityClient
        })),
        videos: Array.from(videos.values()).map(v => ({
          id: v.id,
          name: v.name,
          type: v.type,
          size: v.size,
          created: v.created
        }))
      }));
      break;
      
    case 'delete-video':
      // Delete a video
      if (!data.videoId) {
        ws.send(JSON.stringify({
          type: 'admin-error',
          message: 'Missing videoId'
        }));
        return;
      }
      
      try {
        if (!videos.has(data.videoId)) {
          ws.send(JSON.stringify({
            type: 'admin-error',
            message: 'Video not found'
          }));
          return;
        }
        
        const video = videos.get(data.videoId);
        fs.unlinkSync(video.path);
        videos.delete(data.videoId);
        
        ws.send(JSON.stringify({
          type: 'admin-video-deleted',
          videoId: data.videoId
        }));
      } catch (err) {
        ws.send(JSON.stringify({
          type: 'admin-error',
          message: err.message
        }));
      }
      break;
  }
}

// Broadcast a message to all admin clients
function broadcastToAdmins(message) {
  clients.forEach((client, id) => {
    if (client.info.isAdmin && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(message));
    }
  });
}

// Start the server
server.listen(port, () => {
  console.log(`Server running on port ${port}`);
  console.log(`Admin interface available at http://localhost:${port}/admin`);
  console.log(`Client viewer available at http://localhost:${port}/client.html`);
});

// Clean up on server shutdown
process.on('SIGINT', () => {
  console.log('Shutting down server...');
  process.exit(0);
});