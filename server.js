const express = require('express');
const session = require('express-session');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');
const os = require('os');

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

// Helper: Sort room leaderboard (Supports both Individual & Group Modes)
	function getSortedLeaderboard(room) {
  if (!room) return [];
  
  if (room.mode === 'group') {
    return room.scores.map((score, idx) => {
      // Check if a custom name was registered for this group, otherwise fallback to "Group X"
      const customName = room.groupNames && room.groupNames[idx] ? room.groupNames[idx] : `Group ${idx + 1}`;
      return {
        id: `group_${idx}`,
        name: customName,
        score: score
      };
    }).sort((a, b) => b.score - a.score);
  }

  if (!room.players) return [];
  return Object.values(room.players).sort((a, b) => b.score - a.score);
}

// Helper: Dynamically get local network IP address
function getLocalIpAddress() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name]) {
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

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

app.post('/login', (req, res) => {
  const { password, quizMode, groupCount } = req.body;
  
  if (password === 'admin123') {
    req.session.isAdmin = true;
    req.session.quizMode = quizMode || 'manual';
    req.session.groupCount = parseInt(groupCount) || 2;

    res.redirect('/master.html');
  } else {
    res.send("<script>alert('Invalid Password!'); window.location.href='/';</script>");
  }
});

app.get('/api/session-mode', (req, res) => {
  if (req.session && req.session.isAdmin) {
    res.json({ 
      success: true, 
      quizMode: req.session.quizMode, 
      groupCount: req.session.groupCount 
    });
  } else {
    res.status(401).json({ success: false, message: 'Unauthorized' });
  }
});

app.get('/master.html', (req, res) => {
  if (req.session && req.session.isAdmin) {
    res.sendFile(path.join(__dirname, 'views', 'master.html'));
  } else {
    res.redirect('/');
  }
});

app.get('/admin.html', (req, res) => {
  if (req.session && req.session.isAdmin) {
    res.sendFile(path.join(__dirname, 'views', 'admin.html'));
  } else {
    res.redirect('/');
  }
});

app.get('/participant.html', (req, res) => {
  const roomId = req.query.room;
  if (!roomId || !rooms[roomId]) {
    return res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head><meta charset="UTF-8"><title>Access Denied</title></head>
      <body style="font-family: Arial; display: flex; justify-content: center; align-items: center; height: 100vh;">
        <div style="background: #f8d7da; padding: 30px; border-radius: 8px; text-align: center;">
          <h2 style="color: #dc3545;">?? Access Denied</h2>
          <p>Please scan the valid QR code or use the join link provided by the quiz master.</p>
        </div>
      </body>
      </html>
    `);
  }
  res.sendFile(path.join(__dirname, 'views', 'participant.html'));
});

app.get('/group-participant.html', (req, res) => {
  const roomId = req.query.room;
  if (!roomId) {
    return res.send('<h3>Access Denied: Invalid Room</h3>');
  }
  res.sendFile(path.join(__dirname, 'views', 'group-participant.html'));
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/');
  });
});

// ==========================================
// REST API ENDPOINTS FOR QUESTIONS
// ==========================================
app.get('/api/questions', (req, res) => {
  try {
    res.json({ success: true, questions: readQuestionsFromFile() });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to read questions' });
  }
});

app.post('/api/questions', (req, res) => {
  try {
    saveQuestionsToFile(req.body);
    res.json({ success: true, message: 'Questions updated successfully!' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to save questions' });
  }
});

questions = readQuestionsFromFile();

// ==========================================
// SOCKET.IO REAL-TIME GAME LOGIC
// ==========================================
io.on('connection', (socket) => {
  
  // 1. Master creates a room (Unified for Manual, Auto, and Group modes)
  socket.on('create_room', async (data) => {
    const roomId = typeof data === 'object' ? data.roomId : data;
    const mode = typeof data === 'object' ? (data.mode || 'manual') : 'manual';
    const groupCount = typeof data === 'object' ? (parseInt(data.groupCount) || 2) : 2;

    questions = readQuestionsFromFile();
    socket.join(roomId);

    let baseUrl;
    const host = socket.handshake.headers['x-forwarded-host'] || socket.handshake.headers.host;
    const protocol = socket.handshake.headers['x-forwarded-proto'] || 'https';

    if (host && !host.includes('localhost') && !host.includes('127.0.0.1') && !host.startsWith('10.')) {
      baseUrl = `${protocol}://${host}`;
    } else {
      baseUrl = `http://${getLocalIpAddress()}:${PORT}`;
    }

    const participantPage = (mode === 'group') ? 'group-participant.html' : 'participant.html';
    const joinUrl = `${baseUrl}/${participantPage}?room=${roomId}`;
    const qrImage = await QRCode.toDataURL(joinUrl);

    if (mode === 'group') {
      rooms[roomId] = {
        mode: 'group',
        currentQuestion: 0,
        activeGroup: 0,
        groupCount: groupCount,
        scores: Array(groupCount).fill(0),
        groupSockets: {},
        players: {},
        questions: questions
      };
      for (let i = 0; i < groupCount; i++) {
        rooms[roomId].groupSockets[i] = [];
      }
    } else {
      rooms[roomId] = {
        currentQuestion: 0,
        players: {},
        answers: {},
        mode: mode // 'manual' or 'auto'
      };
    }

    socket.emit('room_created', { roomId, qrCode: qrImage, mode, joinUrl });
  });

  // 2. Individual Participant Joins
  socket.on('join_room', ({ roomId, name }) => {
    const room = rooms[roomId];
    if (!room) return socket.emit('error_msg', 'Room not found!');

    socket.join(roomId);
    room.players[socket.id] = { id: socket.id, name, score: 0 };

    socket.emit('joined_successfully', { roomId, name, mode: room.mode });
    io.to(roomId).emit('player_list_update', Object.values(room.players));
  });
  

  // Helper: Load Question for Individual Modes
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
          setTimeout(() => { loadQuestion(roomId); }, 5000);
        }
      }
    }, 1000);
  }

	// 4. Master clicks 'Next Question' (Handles both Individual and Group modes)
	socket.on('next_question', (roomId) => {
    const room = rooms[roomId];
    if (!room) return;

    if (room.mode === 'group') {
      // If it's the first time or advancing turns in group mode
      if (room.currentQuestion === undefined) room.currentQuestion = 0;
      if (room.activeGroup === undefined) room.activeGroup = 0;
      
      startGroupTurnTimer(roomId, io);
    } else {
      loadQuestion(roomId);
    }
  });

  // 5. Start Group Game (Automated Rapid Fire Turn Rotation)
  socket.on('start_group_game', ({ roomId }) => {
    const room = rooms[roomId];
    if (room && room.mode === 'group') {
      room.currentQuestion = 0;
      room.activeGroup = 0;
      startGroupTurnTimer(roomId, io);
    }
  });

  // 6. Submit Group Answer (Instant score update and auto-advances to next group turn)
  socket.on('submit_group_answer', ({ roomId, groupIndex, selectedOption }) => {
    const room = rooms[roomId];
    if (!room || room.mode !== 'group' || groupIndex !== room.activeGroup) return;

    if (room.timer) clearInterval(room.timer);

    const currentQ = room.questions[room.currentQuestion];
    
    if (currentQ && selectedOption === currentQ.answer) {
      room.scores[groupIndex] += 10; 
    }

	room.currentQuestion += 1;

    if (room.currentQuestion >= room.questions.length) {
      // ---> UPDATE HERE: Include groupNames in the emission
      io.to(roomId).emit('group_quiz_ended', { 
        scores: room.scores, 
        groupNames: room.groupNames || {} 
      });
      io.to(roomId).emit('quiz_ended', getSortedLeaderboard(room));
    } else {
      room.activeGroup = room.currentQuestion % room.groupCount;
      startGroupTurnTimer(roomId, io);
    }
	
  });

  // Helper: Automated Rapid Fire Turn Timer for Groups
  function startGroupTurnTimer(roomId, ioServer) {
    const room = rooms[roomId];
    if (!room) return;

    if (room.timer) clearInterval(room.timer);

    const currentQ = room.questions[room.currentQuestion];
    
    ioServer.to(roomId).emit('group_game_state_update', {
      activeGroup: room.activeGroup,
      scores: room.scores,
      currentQuestionText: currentQ ? currentQ.question : 'Quiz Finished'
    });

    for (let i = 0; i < room.groupCount; i++) {
      if (i === room.activeGroup) {
        ioServer.to(`${roomId}-group-${i}`).emit('group_turn_active', {
          questionNumber: room.currentQuestion + 1,
          question: currentQ.question,
          options: currentQ.options
        });
      } else {
        ioServer.to(`${roomId}-group-${i}`).emit('group_turn_waiting', {
          activeGroup: room.activeGroup
        });
      }
    }

    let timeLeft = 10; // 10 seconds per rapid fire turn
    ioServer.to(roomId).emit('timer_tick', timeLeft);

    room.timer = setInterval(() => {
      timeLeft -= 1;
      ioServer.to(roomId).emit('timer_tick', timeLeft);

		if (timeLeft <= 0) {
        clearInterval(room.timer);
        
        // Time's up! Auto-advance to the next group turn
        room.currentQuestion += 1;

        if (room.currentQuestion >= room.questions.length) {
          // ---> UPDATE HERE: Include groupNames in the emission here as well
          ioServer.to(roomId).emit('group_quiz_ended', { 
            scores: room.scores, 
            groupNames: room.groupNames || {} 
          });
          ioServer.to(roomId).emit('quiz_ended', getSortedLeaderboard(room));
        } else {
          room.activeGroup = room.currentQuestion % room.groupCount;
          startGroupTurnTimer(roomId, ioServer);
        }
      }
    }, 1000);
  }

  // 7. Individual Answer Submission
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
      if (timeTaken <= 5) scoreGained = 15;
      else if (timeTaken <= 10) scoreGained = 10;
      else scoreGained = 5;

      room.players[socket.id].score += scoreGained;
    } else {
      scoreGained = -5;
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
        setTimeout(() => { loadQuestion(roomId); }, 5000);
      }
    }
  });

  // 8. Show Leaderboard Manually
  socket.on('show_leaderboard', (roomId) => {
    if (questionTimer) clearInterval(questionTimer);

    const room = rooms[roomId];
    if (!room) return;

    const leaderboard = getSortedLeaderboard(room);
    io.to(roomId).emit('leaderboard_data', leaderboard);
    socket.emit('leaderboard_data', leaderboard);

    room.currentQuestion += 1;
  });
  
 // Get room group info (groupCount and already taken groups)
  socket.on('get_group_room_info', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || room.mode !== 'group') {
      return socket.emit('error_msg', 'Room not found!');
    }
    socket.emit('group_room_info', {
      groupCount: room.groupCount,
      groupNames: room.groupNames || {}
    });
  });

  // Update Group Participant Join to block duplicate group selection
  socket.on('join_group_participant', ({ roomId, name, groupIndex }) => {
    const room = rooms[roomId];
    if (!room) return;

    // Check if the group is already taken
    if (!room.groupNames) room.groupNames = {};
    if (room.groupNames[groupIndex]) {
      return socket.emit('error_msg', 'This group has already been selected by another team!');
    }

    socket.join(roomId);
    socket.join(`${roomId}-group-${groupIndex}`);

    room.groupNames[groupIndex] = name;

    if (!room.players) room.players = {};
    room.players[socket.id] = { 
      id: socket.id, 
      name: `${name} (Group ${parseInt(groupIndex) + 1})`, 
      group: groupIndex,
      score: room.scores[groupIndex] || 0 
    };

    if (room.groupSockets[groupIndex]) {
      room.groupSockets[groupIndex].push(socket.id);
    }

    socket.emit('group_joined_success', { name, groupIndex });
    
    // Broadcast updated player list to master
    io.to(roomId).emit('player_list_update', Object.values(room.players));

    // Broadcast updated taken groups to all waiting participant screens so dropdowns update live
    io.to(roomId).emit('update_available_groups', {
      groupCount: room.groupCount,
      groupNames: room.groupNames
    });
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
