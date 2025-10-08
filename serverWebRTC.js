const { RTCPeerConnection, RTCSessionDescription, nonstandard } = require('wrtc');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// Enable optional functionality
const { RTCVideoSource } = nonstandard;

/**
 * Manages server-side WebRTC connections and video streaming
 */
class ServerWebRTC {
  constructor() {
    this.peerConnections = new Map(); // Maps clientId to RTCPeerConnection
    this.videoSources = new Map(); // Maps videoId to RTCVideoSource
    this.activeStreams = new Map(); // Maps clientId to { videoId, intervalId }
    this.availableVideos = []; // List of available videos in the videos directory
    
    // STUN servers for ICE candidates
    this.rtcConfig = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' }
      ]
    };
    
    // Load available videos
    this.loadAvailableVideos();
  }
  
  /**
   * Scan the videos directory for available videos
   */
  loadAvailableVideos() {
    const videosDir = path.join(__dirname, 'videos');
    
    if (!fs.existsSync(videosDir)) {
      fs.mkdirSync(videosDir);
    }
    
    try {
      const files = fs.readdirSync(videosDir);
      this.availableVideos = files.filter(file => {
        const ext = path.extname(file).toLowerCase();
        return ['.mp4', '.webm', '.ogg'].includes(ext);
      }).map(file => ({
        id: uuidv4(),
        name: file,
        path: path.join(videosDir, file),
        type: `video/${path.extname(file).substring(1)}`
      }));
      
      console.log(`Loaded ${this.availableVideos.length} videos`);
    } catch (err) {
      console.error('Error loading videos:', err);
    }
  }
  
  /**
   * Get the list of available videos
   */
  getAvailableVideos() {
    return this.availableVideos.map(v => ({ id: v.id, name: v.name }));
  }
  
  /**
   * Handle an incoming offer from a client
   * @param {string} clientId - The client ID
   * @param {string} sdp - SDP offer
   * @param {function} sendAnswer - Function to send answer back to client
   */
  async handleOffer(clientId, sdp, sendAnswer) {
    console.log(`Handling offer from ${clientId}`);
    
    // Clean up any existing connection
    if (this.peerConnections.has(clientId)) {
      await this.closeConnection(clientId);
    }
    
    // Create a new peer connection
    const pc = new RTCPeerConnection(this.rtcConfig);
    this.peerConnections.set(clientId, pc);
    
    // Set up ICE candidate handler
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        const candidateMsg = {
          type: 'ice-candidate',
          from: 'server',
          to: clientId,
          candidate: {
            candidate: event.candidate.candidate,
            sdpMid: event.candidate.sdpMid,
            sdpMLineIndex: event.candidate.sdpMLineIndex
          }
        };
        
        sendAnswer(JSON.stringify(candidateMsg));
      }
    };
    
    // Handle connection state changes
    pc.onconnectionstatechange = () => {
      console.log(`Connection state with ${clientId}: ${pc.connectionState}`);
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this.closeConnection(clientId);
      }
    };
    
    // Handle ICE connection state changes
    pc.oniceconnectionstatechange = () => {
      console.log(`ICE connection state with ${clientId}: ${pc.iceConnectionState}`);
    };
    
    // Set remote description from offer
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp });
      
      // Create answer
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      
      // Send answer to client
      const answerMsg = {
        type: 'answer',
        from: 'server',
        to: clientId,
        sdp: pc.localDescription.sdp
      };
      
      sendAnswer(JSON.stringify(answerMsg));
    } catch (error) {
      console.error(`Error handling offer from ${clientId}:`, error);
    }
    
    return pc;
  }
  
  /**
   * Start streaming a video to a specific client
   * @param {string} clientId - The client ID
   * @param {string} videoId - The video ID to stream
   */
  async startStreaming(clientId, videoId) {
    console.log(`Starting streaming video ${videoId} to client ${clientId}`);
    
    const video = this.availableVideos.find(v => v.id === videoId);
    if (!video) {
      console.error(`Video ${videoId} not found`);
      return false;
    }
    
    const pc = this.peerConnections.get(clientId);
    if (!pc) {
      console.error(`No connection for client ${clientId}`);
      return false;
    }
    
    // Create a video source
    let videoSource = this.videoSources.get(videoId);
    if (!videoSource) {
      videoSource = new RTCVideoSource();
      this.videoSources.set(videoId, videoSource);
    }
    
    // Create a video track from the source
    const track = videoSource.createTrack();
    
    // Add the track to the peer connection
    const stream = new MediaStream([track]);
    pc.addTrack(track, stream);
    
    // Simulate video frames (in real implementation, you would read from video file)
    // For now, we'll just send colored frames
    const fps = 24;
    const width = 640;
    const height = 480;
    
    // Stop any existing stream for this client
    if (this.activeStreams.has(clientId)) {
      clearInterval(this.activeStreams.get(clientId).intervalId);
    }
    
    // Create a new interval for streaming
    const colors = [
      { r: 255, g: 0, b: 0 },    // Red
      { r: 0, g: 255, b: 0 },    // Green
      { r: 0, g: 0, b: 255 },    // Blue
      { r: 255, g: 255, b: 0 },  // Yellow
      { r: 0, g: 255, b: 255 },  // Cyan
      { r: 255, g: 0, b: 255 },  // Magenta
    ];
    
    let colorIndex = 0;
    
    const intervalId = setInterval(() => {
      // Create a frame with the current color
      const color = colors[colorIndex];
      const data = new Uint8Array(width * height * 4);
      
      for (let i = 0; i < width * height; i++) {
        data[i * 4] = color.r;     // R
        data[i * 4 + 1] = color.g; // G
        data[i * 4 + 2] = color.b; // B
        data[i * 4 + 3] = 255;     // A
      }
      
      // Send the frame
      videoSource.onFrame({
        width,
        height,
        data
      });
      
      // Change color for next frame
      colorIndex = (colorIndex + 1) % colors.length;
    }, 1000 / fps);
    
    this.activeStreams.set(clientId, { videoId, intervalId });
    
    return true;
  }
  
  /**
   * Close a client connection and clean up resources
   * @param {string} clientId - The client ID
   */
  async closeConnection(clientId) {
    console.log(`Closing connection with ${clientId}`);
    
    // Stop streaming if active
    if (this.activeStreams.has(clientId)) {
      clearInterval(this.activeStreams.get(clientId).intervalId);
      this.activeStreams.delete(clientId);
    }
    
    // Close peer connection
    const pc = this.peerConnections.get(clientId);
    if (pc) {
      pc.close();
      this.peerConnections.delete(clientId);
    }
  }
  
  /**
   * Close all connections and clean up resources
   */
  closeAllConnections() {
    console.log('Closing all connections');
    
    // Stop all active streams
    this.activeStreams.forEach((stream, clientId) => {
      clearInterval(stream.intervalId);
    });
    this.activeStreams.clear();
    
    // Close all peer connections
    this.peerConnections.forEach((pc, clientId) => {
      pc.close();
    });
    this.peerConnections.clear();
  }
  
  /**
   * Upload a new video to the server
   * @param {Object} file - The uploaded file object
   */
  async addVideo(file) {
    try {
      const videoId = uuidv4();
      const videoPath = path.join(__dirname, 'videos', file.filename);
      
      // Add to available videos
      this.availableVideos.push({
        id: videoId,
        name: file.originalname,
        path: videoPath,
        type: file.mimetype
      });
      
      console.log(`Added new video: ${file.originalname} (${videoId})`);
      return { id: videoId, name: file.originalname };
    } catch (err) {
      console.error('Error adding video:', err);
      return null;
    }
  }
}

module.exports = ServerWebRTC;
