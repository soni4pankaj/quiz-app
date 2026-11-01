const express = require('express');
const session = require('express-session');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');
const os = require('os'); // <--- Import OS module

const app = express();

// Session Middleware Configuration for Admin Authentication
app.use(session({
  secret: 'your_quiz_secret_key',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false }
}));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

//*****************PUBLIC URL*********************
// Add your Localtunnel URL at the top of the file or via an environment variable
// Replace this string whenever localtunnel gives you a new URL

const PUBLIC_URL = process.env.PUBLIC_URL || '';

//*****************PUBLIC URL SETTING END*********

// Middleware & Static Files
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

const questionsFilePath = path.join(__dirname, 'quiz-questions.json');
let questionTimer = null;
let questions = [];
const rooms = {};

// Helper: Read questions from JSON file
function readQuestionsFromFile() {
  if (!fs.existsSync(questionsFilePath)) {
    const defaultData = [
      { id: 1, question: "Which planet is known as the Red Planet?", options: ["Earth", "Mars", "Jupiter", "Venus"], answer: 1 }
    ];
    fs.writeFileSync(questionsFilePath, JSON.stringify(defaultData, null, 2));
    return defaultData;
  }
  const rawData = fs.readFileSync(questionsFilePath, 'utf8');
  return JSON.parse(rawData);
}

// Helper: Save questions to JSON file
function saveQuestionsToFile(questionsData) {
  fs.writeFileSync(questionsFilePath, JSON.stringify(questionsData, null, 2));
}

// Helper: Sort room leaderboard
function getSortedLeaderboard(room) {
  return Object.values(room.players).sort((a, b) => b.score - a.score);
}

// Helper: Dynamically get local network IP address
function getLocalIpAddress() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name]) {
      // Skip over non-IPv4 and internal/loopback addresses (127.0.0.1)
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return 'localhost';
}

// ==========================================
// VIEW ROUTES & ADMIN AUTHENTICATION
// ==========================================

// 1. Serve Login Page (index.html) from views folder
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

// 2. Handle Login Submission
app.post('/login', (req, res) => {
  const { password } = req.body;
  
  // Set your admin password here
  if (password === 'admin123') {
    req.session.isAdmin = true;
    res.redirect('/master.html');
  } else {
    res.send("<script>alert('Invalid Password!'); window.location.href='/';</script>");
  }
});

// 3. Protected Route for Master Dashboard
app.get('/master.html', (req, res) => {
  if (req.session && req.session.isAdmin) {
    res.sendFile(path.join(__dirname, 'views', 'master.html'));
  } else {
    res.redirect('/');
  }
});

// 4. Protected Route for Question Manager (admin.html)
app.get('/admin.html', (req, res) => {
  if (req.session && req.session.isAdmin) {
    res.sendFile(path.join(__dirname, 'views', 'admin.html'));
  } else {
    res.redirect('/');
  }
});

// 5. Participant Route
// 5. Secure Participant Route (Only allow if room parameter is present and active)
app.get('/participant.html', (req, res) => {
  const roomId = req.query.room;
  
  // If no room code is provided in the URL, reject access
  if (!roomId || !rooms[roomId]) {
    return res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <title>Access Denied</title>
        <style>
          body { font-family: Arial, sans-serif; background: #f8d7da; color: #721c24; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
          .error-card { background: white; padding: 30px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); text-align: center; max-width: 400px; }
          h2 { color: #dc3545; }
          p { color: #555; }
        </style>
      </head>
      <body>
        <div class="error-card">
          <h2>🚫 Access Denied</h2>
          <p>You cannot access this page directly. Please scan the QR code provided by the quiz master to join a valid session.</p>
        </div>
      </body>
      </html>
    `);
  }

  // If room is valid, send the participant page
  res.sendFile(path.join(__dirname, 'views', 'participant.html'));
});

// 6. Logout Route
app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/');
  });
});

// ==========================================
// REST API ENDPOINTS FOR ADMIN DASHBOARD
// ==========================================
app.get('/api/questions', (req, res) => {
  try {
    const questionsData = readQuestionsFromFile();
    res.json({ success: true, questions: questionsData });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to read questions file' });
  }
});

app.post('/api/questions', (req, res) => {
  try {
    const updatedQuestions = req.body;
    saveQuestionsToFile(updatedQuestions);
    res.json({ success: true, message: 'Questions updated successfully!' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to save questions' });
  }
});

// Load questions into memory at startup
questions = readQuestionsFromFile();

// ==========================================
// SOCKET.IO REAL-TIME GAME LOGIC
// ==========================================
io.on('connection', (socket) => {
  
  // 1. Master creates a room
// 1. Master creates a room
// 1. Master creates a room
  socket.on('create_room', async (data) => {
    const roomId = typeof data === 'object' ? data.roomId : data;
    const mode = typeof data === 'object' ? data.mode : 'manual';

    questions = readQuestionsFromFile();
    socket.join(roomId);

    let baseUrl;

    // 1. If an environment variable is set, use it
    if (process.env.PUBLIC_URL) {
      baseUrl = process.env.PUBLIC_URL;
    } else {
      // 2. Safely grab the public hostname from proxy headers (Render / cloud standard)
      const host = socket.handshake.headers['x-forwarded-host'] || socket.handshake.headers.host;
      const protocol = socket.handshake.headers['x-forwarded-proto'] || 'https';

      if (host && !host.includes('localhost') && !host.includes('127.0.0.1') && !host.startsWith('10.')) {
        baseUrl = `${protocol}://${host}`;
      } else {
        // Fallback for local testing only
        const localIP = getLocalIpAddress();
        baseUrl = `http://${localIP}:${PORT}`;
      }
    }

    const joinUrl = `${baseUrl}/participant.html?room=${roomId}`;
    const qrImage = await QRCode.toDataURL(joinUrl);

    rooms[roomId] = {
      currentQuestion: 0,
      players: {},
      answers: {},
      mode: mode
    };

    socket.emit('room_created', { roomId, qrCode: qrImage });
  });
  
  
  
  // 2. Participant joins a room
  socket.on('join_room', ({ roomId, name }) => {
    const room = rooms[roomId];
    if (!room) return socket.emit('error_msg', 'Room not found!');

    socket.join(roomId);
    room.players[socket.id] = { id: socket.id, name, score: 0 };

    socket.emit('joined_successfully', { roomId, name, mode: room.mode });
    io.to(roomId).emit('player_list_update', Object.values(room.players));
  });

  function loadQuestion(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    if (questionTimer) clearInterval(questionTimer);

    if (room.currentQuestion >= questions.length) {
      const finalLeaderboard = getSortedLeaderboard(room);
      io.to(roomId).emit('quiz_ended', finalLeaderboard);
      return;
    }

    const q = questions[room.currentQuestion];
    room.answers = {};
    room.questionStartTime = Date.now();

    io.to(roomId).emit('display_question', {
      questionNumber: room.currentQuestion + 1,
      question: q.question,
      options: q.options
    });

    room.currentQuestion += 1;

    let timeLeft = 15;
    io.to(roomId).emit('timer_tick', timeLeft);

    questionTimer = setInterval(() => {
      timeLeft -= 1;
      io.to(roomId).emit('timer_tick', timeLeft);

      if (timeLeft <= 0) {
        clearInterval(questionTimer);
        const leaderboard = getSortedLeaderboard(room);
        io.to(roomId).emit('time_up');
        io.to(roomId).emit('leaderboard_data', leaderboard);

        if (room.mode === 'auto') {
          setTimeout(() => {
            loadQuestion(roomId);
          }, 5000);
        }
      }
    }, 1000);
  }

  // 3. Master clicks 'Next Question'
  socket.on('next_question', (roomId) => {
    const room = rooms[roomId];
    if (!room) return;
    socket.join(roomId);

    loadQuestion(roomId);
  });

  // 4. Participant submits an answer
  socket.on('submit_answer', ({ roomId, selectedOption }) => {
    const room = rooms[roomId];
    if (!room || room.answers[socket.id] !== undefined) return;

    const startTime = room.questionStartTime || Date.now();
    const timeTaken = parseFloat(((Date.now() - startTime) / 1000).toFixed(2));

    room.answers[socket.id] = selectedOption;

    const currentQ = questions[room.currentQuestion - 1];
    let scoreGained = 0;
    let isCorrect = false;

    if (currentQ && selectedOption === currentQ.answer) {
      isCorrect = true;

      if (timeTaken <= 5) {
        scoreGained = 15;
      } else if (timeTaken <= 10) {
        scoreGained = 10;
      } else {
        scoreGained = 5;
      }

      room.players[socket.id].score += scoreGained;
    } else {
      scoreGained = -5;
      isCorrect = false;
      room.players[socket.id].score += scoreGained;
    }

    room.players[socket.id].lastRoundTime = timeTaken;
    room.players[socket.id].lastRoundScore = scoreGained;
    room.players[socket.id].totalTime = parseFloat(
      ((room.players[socket.id].totalTime || 0) + timeTaken).toFixed(2)
    );

    socket.emit('answer_confirmed', { timeTaken, scoreGained, isCorrect });

    const totalPlayers = Object.keys(room.players).length;
    const answeredPlayers = Object.keys(room.answers).length;

    if (answeredPlayers >= totalPlayers && totalPlayers > 0) {
      if (questionTimer) clearInterval(questionTimer);

      const leaderboard = getSortedLeaderboard(room);
      io.to(roomId).emit('time_up');
      io.to(roomId).emit('leaderboard_data', leaderboard);

      if (room.mode === 'auto') {
        setTimeout(() => {
          loadQuestion(roomId);
        }, 5000);
      }
    }
  });

  // 5. Master manually clicks 'Display Score' / Leaderboard
  socket.on('show_leaderboard', (roomId) => {
    if (questionTimer) clearInterval(questionTimer);

    const room = rooms[roomId];
    if (!room) return;

    const leaderboard = getSortedLeaderboard(room);

    io.to(roomId).emit('leaderboard_data', leaderboard);
    socket.emit('leaderboard_data', leaderboard);

    room.currentQuestion += 1;
  });
});

const PORT = process.env.PORT || 4000;
const HOST = '0.0.0.0';

server.listen(PORT, HOST, () => {
  const localIP = getLocalIpAddress();
  console.log('----------------------------------------------------');
  console.log(`Server running locally at: http://localhost:${PORT}`);
  console.log(`Network Join Link: http://${localIP}:${PORT}/participant.html`);
  console.log(`Master View: http://localhost:${PORT}/master.html`);
  console.log('----------------------------------------------------');
});
