# Simple Chat Application Guide

## New Pages Created

Two simple chat pages with **NO VIDEO** - just pure messaging:

1. **chat-sender.html** - Send messages to receivers
2. **chat-receiver.html** - Receive messages from senders

---

## How to Use

### Step 1: Start Server
```bash
npm start
```

### Step 2: Open Chat Pages

**Local:**
- Sender: http://localhost:3000/chat-sender.html
- Receiver: http://localhost:3000/chat-receiver.html

**Production (Render):**
- Sender: https://webrtc-9gdy.onrender.com/chat-sender.html
- Receiver: https://webrtc-9gdy.onrender.com/chat-receiver.html

### Step 3: Test Messaging

1. **Open Receiver page first**
   - Should show "Connected Senders: 0"
   
2. **Open Sender page**
   - Sender should show "Connected Receivers: 1"
   - Receiver should show "Connected Senders: 1"
   
3. **Send a message from Sender**
   - Type message and click "Send" (or press Enter)
   - Message appears on Receiver page
   
4. **Reply from Receiver**
   - Type message and click "Send"
   - Message appears on Sender page

---

## Features

### Sender Page (Blue theme)
- ✅ Shows number of connected receivers
- ✅ Send messages to all receivers at once
- ✅ See sent messages (blue)
- ✅ See replies from receivers (green)
- ✅ Activity log for debugging

### Receiver Page (Purple theme)
- ✅ Shows number of connected senders
- ✅ Receive messages from senders
- ✅ Reply to all senders at once
- ✅ See received messages (blue)
- ✅ See your replies (purple)
- ✅ Activity log for debugging

---

## How It Works

### Simple WebSocket Messaging

**No WebRTC, No Peer Connections, No Video!**

Just pure WebSocket messages:

1. **Sender announces:** `NEWPEER|Sender_xxx|ALL|...|0|true`
2. **Receiver announces:** `NEWPEER|Receiver_xxx|ALL|...|0|false`
3. **Sender sends message:** `MESSAGE|Sender_xxx|Receiver_xxx|Hello!|0|true`
4. **Server forwards message to receiver**
5. **Receiver replies:** `MESSAGE|Receiver_xxx|Sender_xxx|Hi back!|0|false`

---

## Message Protocol

Format: `TYPE|SENDER_ID|RECEIVER_ID|CONTENT|COUNT|IS_SENDER`

**NEWPEER** - Announce presence
- Sender: `isVideoSender = true`
- Receiver: `isVideoSender = false`

**MESSAGE** - Send text message
- Content: The actual message text

**DISPOSE** - Peer disconnected
- Automatically sent by server

---

## Testing Multiple Users

### Test with Multiple Receivers:
1. Open 3 tabs:
   - Tab 1: chat-sender.html
   - Tab 2: chat-receiver.html
   - Tab 3: chat-receiver.html
2. Sender shows "Connected Receivers: 2"
3. Send message from sender → Both receivers get it
4. Reply from any receiver → Sender gets it

### Test with Multiple Senders:
1. Open 3 tabs:
   - Tab 1: chat-receiver.html
   - Tab 2: chat-sender.html
   - Tab 3: chat-sender.html
2. Receiver shows "Connected Senders: 2"
3. Send from any sender → Receiver gets it
4. Reply from receiver → All senders get it

---

## Troubleshooting

### "Connected Receivers: 0" on Sender
- Make sure receiver page is open
- Check Activity Log for "Receiver joined" message
- Refresh both pages

### "Connected Senders: 0" on Receiver
- Make sure sender page is open
- Check Activity Log for "Sender joined" message
- Refresh both pages

### Messages not sending
- Check that counter shows > 0
- Make sure WebSocket status is "Connected" (green dot)
- Check browser console for errors

### Connection keeps dropping
- Server might be restarting
- Check if server is running: `npm start`
- Network issues - try localhost first

---

## Differences from sender.html/receiver.html

| Feature | Old Pages | New Chat Pages |
|---------|-----------|----------------|
| Video streaming | ✅ Yes | ❌ No |
| WebRTC | ✅ Yes | ❌ No |
| Peer connections | ✅ Yes | ❌ No |
| Data channels | ✅ Yes | ❌ No |
| Messaging | ✅ Complex | ✅ Simple |
| Camera access | ✅ Required | ❌ Not needed |
| Connection setup | Complex | Simple |

---

## Quick Start Commands

```bash
# Start server
npm start

# Open sender (in browser)
http://localhost:3000/chat-sender.html

# Open receiver (in browser)
http://localhost:3000/chat-receiver.html

# Type message and press Enter!
```

---

## Expected Behavior

**Sender Activity Log:**
```
[Time] Connecting to ws://localhost:3000...
[Time] ✅ Connected to server
[Time] Announced as sender
[Time] ✅ Receiver joined: Receiver_abc123
[Time] 📤 Sent to 1 receiver(s): "Hello!"
[Time] 📨 Message from Receiver_abc123: Hi back!
```

**Receiver Activity Log:**
```
[Time] Connecting to ws://localhost:3000...
[Time] ✅ Connected to server
[Time] Announced as receiver
[Time] ✅ Sender joined: Sender_xyz789
[Time] 📨 Message from Sender_xyz789: Hello!
[Time] 📤 Sent to 1 sender(s): "Hi back!"
```

---

## That's It!

No video, no WebRTC complexity - just simple messaging! 🎉
