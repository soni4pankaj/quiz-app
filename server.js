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
  socket.on('create_room', async (roomId) => {
    // Reload questions dynamically when a new room starts
    questions = readQuestionsFromFile();

    socket.join(roomId);





    // Join URL for participants

// Automatically detect incoming protocol & host from socket handshake header, or fallback to local IP
    const hostHeader = socket.handshake.headers.host;
    const protocol = socket.handshake.headers['x-forwarded-proto'] || 'http';
    const localIP = getLocalIpAddress();

    const baseUrl = PUBLIC_URL 
      ? PUBLIC_URL 
      : (hostHeader ? `${protocol}://${hostHeader}` : `http://${localIP}:${PORT}`);

    const joinUrl = `${baseUrl}/participant.html?room=${roomId}`;



    const qrImage = await QRCode.toDataURL(joinUrl);

    rooms[roomId] = {
      currentQuestion: 0,
      players: {},
      answers: {}
    };

    socket.emit('room_created', { roomId, qrCode: qrImage });
  });

  // 2. Participant joins a room
  socket.on('join_room', ({ roomId, name }) => {
    const room = rooms[roomId];
    if (!room) return socket.emit('error_msg', 'Room not found!');

    socket.join(roomId);
    room.players[socket.id] = { id: socket.id, name, score: 0 };

    socket.emit('joined_successfully', { roomId, name });

    // Update master and everyone with current player list
    io.to(roomId).emit('player_list_update', Object.values(room.players));
  });

  // 3. Master clicks 'Next Question'
// 3. Master clicks 'Next Question'
  socket.on('next_question', (roomId) => {
    const room = rooms[roomId];
    if (!room) return;

    socket.join(roomId);

    if (questionTimer) clearInterval(questionTimer);

    if (room.currentQuestion >= questions.length) {
      const finalLeaderboard = getSortedLeaderboard(room);
      io.to(roomId).emit('quiz_ended', finalLeaderboard);
      return;
    }

    const q = questions[room.currentQuestion];
    room.answers = {}; // Reset round answers

    // RECORD QUESTION START TIME INSIDE THE ROOM OBJECT
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
      }
    }, 1000);
  });

// 4. Participant submits an answer
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
    const totalPlayers = Object.keys(room.players).length;
    const answeredPlayers = Object.keys(room.answers).length;

    if (answeredPlayers >= totalPlayers && totalPlayers > 0) {
      if (questionTimer) clearInterval(questionTimer);
      const leaderboard = getSortedLeaderboard(room);
      io.to(roomId).emit('leaderboard_data', leaderboard);
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
// Dynamic Port Configuration for Render / Cloud Hosting
const PORT = process.env.PORT || 4000;

server.listen(PORT, () => {
  console.log('----------------------------------------------------');
  console.log(`Quiz Server is running on port: ${PORT}`);
  console.log('----------------------------------------------------');
});