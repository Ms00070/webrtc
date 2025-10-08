const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');

/**
 * Video Manager for handling server-side video storage and management
 */
class VideoManager {
  constructor() {
    this.videos = new Map(); // Maps videoId to video metadata
    this.videosDir = path.join(__dirname, 'videos');
    
    // Ensure videos directory exists
    if (!fs.existsSync(this.videosDir)) {
      fs.mkdirSync(this.videosDir);
    }
    
    // Configure multer for file uploads
    this.storage = multer.diskStorage({
      destination: (req, file, cb) => {
        cb(null, this.videosDir);
      },
      filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname);
        cb(null, file.fieldname + '-' + uniqueSuffix + ext);
      }
    });
    
    this.upload = multer({
      storage: this.storage,
      fileFilter: (req, file, cb) => {
        // Accept only video files
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
    
    // Load existing videos
    this.loadVideos();
  }
  
  /**
   * Load existing videos from the videos directory
   */
  loadVideos() {
    try {
      const files = fs.readdirSync(this.videosDir);
      
      files.filter(file => {
        const ext = path.extname(file).toLowerCase();
        return ['.mp4', '.webm', '.ogg'].includes(ext);
      }).forEach(file => {
        const videoId = uuidv4();
        const videoPath = path.join(this.videosDir, file);
        const stats = fs.statSync(videoPath);
        
        this.videos.set(videoId, {
          id: videoId,
          name: file,
          path: videoPath,
          type: `video/${path.extname(file).substring(1)}`,
          size: stats.size,
          created: stats.birthtime
        });
      });
      
      console.log(`Loaded ${this.videos.size} videos from disk`);
    } catch (err) {
      console.error('Error loading videos:', err);
    }
  }
  
  /**
   * Get a list of all available videos
   * @returns {Array} Array of video metadata objects
   */
  getVideos() {
    return Array.from(this.videos.values()).map(video => ({
      id: video.id,
      name: video.name,
      type: video.type,
      size: video.size,
      created: video.created
    }));
  }
  
  /**
   * Get a specific video by ID
   * @param {string} videoId - The video ID
   * @returns {Object|null} Video metadata or null if not found
   */
  getVideo(videoId) {
    return this.videos.has(videoId) ? this.videos.get(videoId) : null;
  }
  
  /**
   * Add a new video from an uploaded file
   * @param {Object} file - The uploaded file object from multer
   * @returns {Object} The newly added video metadata
   */
  addVideo(file) {
    const videoId = uuidv4();
    const videoPath = path.join(this.videosDir, file.filename);
    const stats = fs.statSync(videoPath);
    
    const videoData = {
      id: videoId,
      name: file.originalname,
      path: videoPath,
      type: file.mimetype,
      size: stats.size,
      created: new Date()
    };
    
    this.videos.set(videoId, videoData);
    console.log(`Added new video: ${file.originalname} (${videoId})`);
    
    return {
      id: videoId,
      name: file.originalname,
      type: file.mimetype,
      size: stats.size,
      created: videoData.created
    };
  }
  
  /**
   * Delete a video by ID
   * @param {string} videoId - The video ID to delete
   * @returns {boolean} Success or failure
   */
  deleteVideo(videoId) {
    if (!this.videos.has(videoId)) {
      return false;
    }
    
    const video = this.videos.get(videoId);
    
    try {
      fs.unlinkSync(video.path);
      this.videos.delete(videoId);
      console.log(`Deleted video: ${video.name} (${videoId})`);
      return true;
    } catch (err) {
      console.error(`Error deleting video ${videoId}:`, err);
      return false;
    }
  }
  
  /**
   * Get multer middleware for handling file uploads
   * @returns {Object} Multer middleware
   */
  getUploadMiddleware() {
    return this.upload;
  }
}

module.exports = VideoManager;
