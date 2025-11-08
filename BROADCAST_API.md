# Broadcast Message API

Send messages to all connected clients from outside the application using simple HTTP requests!

---

## 🚀 Quick Start

### Send a Message via URL

**Local:**
```
http://localhost:3000/api/broadcast?message=Hello everyone!
```

**Production (Render):**
```
https://webrtc-9gdy.onrender.com/api/broadcast?message=Hello everyone!
```

Just paste the URL in your browser or use it in any HTTP client!

---

## 📡 API Endpoints

### 1. GET `/api/broadcast`

Send a broadcast message using URL parameters.

**URL Format:**
```
GET /api/broadcast?message=your_message_here
```

**Examples:**

```bash
# Simple message
https://webrtc-9gdy.onrender.com/api/broadcast?message=Hello

# Message with spaces (URL encoded)
https://webrtc-9gdy.onrender.com/api/broadcast?message=Hello%20World

# Emoji message
https://webrtc-9gdy.onrender.com/api/broadcast?message=🎉%20Party%20time!
```

**Response:**
```json
{
  "success": true,
  "message": "Hello everyone!",
  "sentTo": 3,
  "clients": ["Sender_abc123", "Receiver_xyz789", "Receiver_def456"]
}
```

**Error Response (missing message):**
```json
{
  "success": false,
  "error": "Missing message parameter",
  "usage": "/api/broadcast?message=your_message_here"
}
```

---

### 2. POST `/api/broadcast`

Send a broadcast message using JSON body (more secure for sensitive data).

**URL:**
```
POST /api/broadcast
Content-Type: application/json
```

**Request Body:**
```json
{
  "message": "Your message here"
}
```

**cURL Example:**
```bash
curl -X POST https://webrtc-9gdy.onrender.com/api/broadcast \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello from API!"}'
```

**JavaScript Fetch Example:**
```javascript
fetch('https://webrtc-9gdy.onrender.com/api/broadcast', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    message: 'Hello from JavaScript!'
  })
})
.then(res => res.json())
.then(data => console.log(data));
```

**Python Example:**
```python
import requests

response = requests.post(
    'https://webrtc-9gdy.onrender.com/api/broadcast',
    json={'message': 'Hello from Python!'}
)
print(response.json())
```

**Response:**
```json
{
  "success": true,
  "message": "Hello from API!",
  "sentTo": 3,
  "clients": ["Sender_abc123", "Receiver_xyz789", "Receiver_def456"]
}
```

---

## 🎯 Use Cases

### 1. Browser Bookmarklet
Create a bookmark with this URL:
```javascript
javascript:(function(){var msg=prompt('Enter message:');if(msg){window.open('https://webrtc-9gdy.onrender.com/api/broadcast?message='+encodeURIComponent(msg),'_blank');}})();
```

### 2. Automation Scripts
```bash
# Send notification every hour
while true; do
  curl "https://webrtc-9gdy.onrender.com/api/broadcast?message=Hourly%20reminder"
  sleep 3600
done
```

### 3. Webhook Integration
Use with services like Zapier, IFTTT, or GitHub Actions:
```yaml
# GitHub Action example
- name: Notify clients
  run: |
    curl "https://webrtc-9gdy.onrender.com/api/broadcast?message=Deployment%20complete"
```

### 4. IoT Devices
Send messages from Arduino, Raspberry Pi, etc:
```cpp
// Arduino example
HTTPClient http;
http.begin("https://webrtc-9gdy.onrender.com/api/broadcast?message=Sensor%20alert");
int httpCode = http.GET();
```

### 5. Mobile Apps
```swift
// iOS Swift example
let url = URL(string: "https://webrtc-9gdy.onrender.com/api/broadcast?message=Hello%20from%20iOS")!
URLSession.shared.dataTask(with: url).resume()
```

---

## 📱 How It Appears on Clients

When you send a broadcast message, all connected clients (both senders and receivers) will see:

**Message Display:**
- Yellow background with yellow border
- "📢 SERVER BROADCAST" label
- Timestamp
- Your message

**Activity Log:**
- `📢 Broadcast from SERVER: Your message`

---

## 🔧 Testing

### Test with Browser
1. Open chat-sender.html or chat-receiver.html
2. In another tab, visit:
   ```
   http://localhost:3000/api/broadcast?message=Test
   ```
3. Check the chat page - you should see the broadcast message!

### Test with cURL
```bash
# GET request
curl "http://localhost:3000/api/broadcast?message=Hello"

# POST request
curl -X POST http://localhost:3000/api/broadcast \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello"}'
```

### Test with Postman
1. Create new GET request
2. URL: `http://localhost:3000/api/broadcast`
3. Add query parameter: `message` = `Test message`
4. Send!

---

## 🌐 URL Encoding

Special characters need to be URL encoded:

| Character | Encoded |
|-----------|---------|
| Space | `%20` |
| ! | `%21` |
| # | `%23` |
| $ | `%24` |
| & | `%26` |
| ' | `%27` |
| ( | `%28` |
| ) | `%29` |
| * | `%2A` |
| + | `%2B` |
| , | `%2C` |
| / | `%2F` |
| : | `%3A` |
| ; | `%3B` |
| = | `%3D` |
| ? | `%3F` |
| @ | `%40` |

**Example:**
```
Original: Hello World! How are you?
Encoded:  Hello%20World%21%20How%20are%20you%3F
```

**JavaScript Encoding:**
```javascript
const message = "Hello World!";
const encoded = encodeURIComponent(message);
// Result: "Hello%20World%21"
```

---

## 🔒 Security Considerations

### Current Implementation
- ✅ No authentication required (open endpoint)
- ✅ Anyone can send messages
- ✅ Good for testing and internal networks

### For Production
Consider adding:
- API key authentication
- Rate limiting
- Message validation
- CORS restrictions
- Input sanitization

**Example with API Key:**
```javascript
// Add to server.js
app.get('/api/broadcast', (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  // ... rest of code
});
```

---

## 📊 Response Fields

| Field | Type | Description |
|-------|------|-------------|
| `success` | boolean | Whether the message was sent successfully |
| `message` | string | The message that was broadcast |
| `sentTo` | number | Number of clients that received the message |
| `clients` | array | List of client IDs that received the message |
| `error` | string | Error message (only if success is false) |

---

## 🎉 Examples

### Send Emoji
```
https://webrtc-9gdy.onrender.com/api/broadcast?message=🎉🎊🎈
```

### Send Alert
```
https://webrtc-9gdy.onrender.com/api/broadcast?message=⚠️%20ALERT:%20System%20maintenance%20in%2010%20minutes
```

### Send Update
```
https://webrtc-9gdy.onrender.com/api/broadcast?message=✅%20New%20feature%20deployed!
```

### Send Reminder
```
https://webrtc-9gdy.onrender.com/api/broadcast?message=⏰%20Meeting%20starts%20in%205%20minutes
```

---

## 🐛 Troubleshooting

### No clients received the message
- Check if any clients are connected: `/api/status`
- Verify clients are on chat-sender.html or chat-receiver.html
- Check server logs for errors

### Message not appearing on clients
- Refresh the chat pages
- Check browser console for errors
- Verify WebSocket connection is active (green dot)

### Special characters not working
- Make sure to URL encode the message
- Use `encodeURIComponent()` in JavaScript
- Test with simple messages first

---

## 🚀 Quick Commands

**Send from terminal:**
```bash
# Simple
curl "http://localhost:3000/api/broadcast?message=Hello"

# With emoji
curl "http://localhost:3000/api/broadcast?message=$(echo '🎉 Party!' | jq -sRr @uri)"

# Check status
curl "http://localhost:3000/api/status"
```

**Send from browser console:**
```javascript
fetch('/api/broadcast?message=Hello from console!')
  .then(r => r.json())
  .then(console.log);
```

---

## 📝 Summary

**Simple URL format:**
```
https://webrtc-9gdy.onrender.com/api/broadcast?message=YOUR_MESSAGE
```

**That's it!** Just replace `YOUR_MESSAGE` with your text and all connected clients will receive it instantly! 🎉
