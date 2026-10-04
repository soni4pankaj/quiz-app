const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');
const os = require('os'); // <--- Import OS module


const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

//*****************PUBLIC URL*********************
// Add your Localtunnel URL at the top of the file or via an environment variable
// Replace this string whenever localtunnel gives you a new URL

const PUBLIC_URL = process.env.PUBLIC_URL || '';

//*****************PUBLIC URL SETTING END*********


// Middleware & Static Files
app.use(express.json());
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

// REST API ENDPOINTS FOR ADMIN DASHBOARD
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




// SOCKET.IO REAL-TIME GAME LOGIC
io.on('connection', (socket) => {
  
  // 1. Master creates a room
	// server.js
	socket.on('create_room', async (data) => {
  // Support both object payload { roomId, mode } and legacy string roomId
  const roomId = typeof data === 'object' ? data.roomId : data;
  const mode = typeof data === 'object' ? data.mode : 'manual';

  questions = readQuestionsFromFile();
  socket.join(roomId);

 
//*******************LOCAL SETTING START ******************
 // const localIP = getLocalIpAddress();
  //const baseUrl = PUBLIC_URL ? PUBLIC_URL : `http://${localIP}:${PORT}`;
//*********************LOCAL SETTING END **************


//************GLABAL SETTING START ******************

// Automatically derive the host from Render, Environment Variable, or Local IP
  const reqHost = socket.handshake.headers.host;
  let baseUrl;

  if (process.env.PUBLIC_URL) {
    baseUrl = process.env.PUBLIC_URL;
  } else if (reqHost && !reqHost.includes('localhost') && !reqHost.includes('127.0.0.1')) {
    // Protocol defaults to https on Render
    const protocol = socket.handshake.headers['x-forwarded-proto'] || 'https';
    baseUrl = `${protocol}://${reqHost}`;
  } else {
    const localIP = getLocalIpAddress();
    baseUrl = `http://${localIP}:${PORT}`;
  }

//************GLOBAL SETTING END *******************



 const joinUrl = `${baseUrl}/participant.html?room=${roomId}`;
  const qrImage = await QRCode.toDataURL(joinUrl);

  rooms[roomId] = {
    currentQuestion: 0,
    players: {},
    answers: {},
    mode: mode // Save room mode ('auto' or 'manual')
  };

  socket.emit('room_created', { roomId, qrCode: qrImage });
});



  // 2. Participant joins a room
// Inside socket.on('join_room') in server.js
socket.on('join_room', ({ roomId, name }) => {
  const room = rooms[roomId];
  if (!room) return socket.emit('error_msg', 'Room not found!');

  socket.join(roomId);
  room.players[socket.id] = { id: socket.id, name, score: 0 };

  // Send the room's mode back to the joining participant
  socket.emit('joined_successfully', { roomId, name, mode: room.mode });

  // Update master and everyone with current player list
  io.to(roomId).emit('player_list_update', Object.values(room.players));
});

// server.js helper function
function loadQuestion(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  if (questionTimer) clearInterval(questionTimer);

  // Check if all questions are finished
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

      // NON-STOP MODE: Wait 5 seconds on leaderboard, then load next question
      if (room.mode === 'auto') {
        setTimeout(() => {
          loadQuestion(roomId);
        }, 5000);
      }
    }
  }, 1000);
}


// 3. Master clicks 'Next Question'
// server.js
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

    // Fallback safeguard: if questionStartTime is missing, default to current time
    const startTime = room.questionStartTime || Date.now();
    const timeTaken = parseFloat(((Date.now() - startTime) / 1000).toFixed(2));

    room.answers[socket.id] = selectedOption;

    const currentQ = questions[room.currentQuestion - 1];
    let scoreGained = 0;
    let isCorrect = false;

    if (currentQ && selectedOption === currentQ.answer) {
      isCorrect = true;

      // Tiered Scoring Based on Response Time
      if (timeTaken <= 5) {
        scoreGained = 15; // Answered in 0 - 5 seconds
      } else if (timeTaken <= 10) {
        scoreGained = 10; // Answered in 5.01 - 10 seconds
      } else {
        scoreGained = 5;  // Answered in 10.01 - 15 seconds
      }

      room.players[socket.id].score += scoreGained;
    } else {
      scoreGained = -5; // Penalty for incorrect answer
      isCorrect = false;
      room.players[socket.id].score += scoreGained;
    }

    room.players[socket.id].lastRoundTime = timeTaken;
    room.players[socket.id].lastRoundScore = scoreGained;
    room.players[socket.id].totalTime = parseFloat(
      ((room.players[socket.id].totalTime || 0) + timeTaken).toFixed(2)
    );

    // Pass results back to participant
    socket.emit('answer_confirmed', { timeTaken, scoreGained, isCorrect });

    // Check if all players in the room have answered
// Check if all players in the room have answered
const totalPlayers = Object.keys(room.players).length;
const answeredPlayers = Object.keys(room.answers).length;

if (answeredPlayers >= totalPlayers && totalPlayers > 0) {
  if (questionTimer) clearInterval(questionTimer);

  const leaderboard = getSortedLeaderboard(room);
  io.to(roomId).emit('time_up');
  io.to(roomId).emit('leaderboard_data', leaderboard);

  // NON-STOP MODE: Wait 5 seconds on leaderboard when everyone answers early
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

    // Broadcast to room (participants) AND send directly to Master socket
    io.to(roomId).emit('leaderboard_data', leaderboard);
    socket.emit('leaderboard_data', leaderboard);

    // Move to next question index
    room.currentQuestion += 1;
  });
});

// ... update server.listen ...
const PORT = process.env.PORT || 4000;	// FOR ANY NETWORK connection
//const PORT = 4000;		// FOR PUBLIC TESTING
const HOST = '0.0.0.0'; // Bind to all network interfaces

server.listen(PORT, HOST, () => {
  const localIP = getLocalIpAddress();
  console.log('----------------------------------------------------');
  console.log(`Server running locally at: http://localhost:${PORT}`);
  console.log(`Network Join Link: http://${localIP}:${PORT}/participant.html`);
  console.log(`Master View: http://localhost:${PORT}/master.html`);
  console.log('----------------------------------------------------');});