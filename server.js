const express = require('express');
const session = require('express-session');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();

const PORT = process.env.PORT || 4000;
const HOST = '0.0.0.0';

// Session Middleware Configuration for Admin Authentication
app.use(session({
  secret: process.env.SESSION_SECRET || 'your_quiz_secret_key',
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

const ASSESSMENT_DIR = path.join(__dirname, 'assessment');

const MODE_QUESTION_FILES = {
  manual: 'manual.json',
  auto: 'rapid.json',
  rapid: 'rapid.json',
  group: 'group.json',
  default: 'default.json'
};

const rooms = {};

// Helper: Resolve question file path inside ./assessment for a given mode
function resolveQuestionFile(mode = 'manual') {
  const key = String(mode || 'manual').toLowerCase();
  const fileName = MODE_QUESTION_FILES[key] || MODE_QUESTION_FILES.default;
  const jsonPath = path.join(ASSESSMENT_DIR, fileName);

  if (fs.existsSync(jsonPath)) {
    return jsonPath;
  }

  // Fallback if files were saved without .json extension
  const extensionlessName = fileName.replace(/\.json$/i, '');
  const noExtPath = path.join(ASSESSMENT_DIR, extensionlessName);
  if (fs.existsSync(noExtPath)) {
    return noExtPath;
  }

  return jsonPath;
}

// Helper: Read questions for a specific mode from ./assessment
function readQuestionsFromFile(mode = 'manual') {
  const targetPath = resolveQuestionFile(mode);

  if (!fs.existsSync(targetPath)) {
    fs.mkdirSync(ASSESSMENT_DIR, { recursive: true });
    const defaultData = [
      { id: 1, question: "Which planet is known as the Red Planet?", options: ["Earth", "Mars", "Jupiter", "Venus"], answer: 1 }
    ];
    fs.writeFileSync(targetPath, JSON.stringify(defaultData, null, 2));
    return defaultData;
  }

  const rawData = fs.readFileSync(targetPath, 'utf8');
  const parsed = JSON.parse(rawData);
  return Array.isArray(parsed) ? parsed : (parsed.questions || []);
}

// Helper: Save questions for a specific mode to ./assessment
function saveQuestionsToFile(questionsData, mode = 'manual') {
  fs.mkdirSync(ASSESSMENT_DIR, { recursive: true });
  const targetPath = resolveQuestionFile(mode);
  fs.writeFileSync(targetPath, JSON.stringify(questionsData, null, 2));
}

// Helper: Clear all active timers/timeouts on a room safely
function clearRoomTimers(room) {
  if (!room) return;
  if (room.timer) {
    clearInterval(room.timer);
    room.timer = null;
  }
  if (room.nextTimeout) {
    clearTimeout(room.nextTimeout);
    room.nextTimeout = null;
  }
}

// Helper: Sort room leaderboard (Supports both Individual & Group Modes)
function getSortedLeaderboard(room) {
  if (!room) return [];

  if (room.mode === 'group') {
    const count = room.groupCount || (room.scores ? room.scores.length : 0);
    const list = [];
    for (let idx = 0; idx < count; idx++) {
      const customName = room.groupNames && room.groupNames[idx] ? room.groupNames[idx] : `Group ${idx + 1}`;
      list.push({
        id: `group_${idx}`,
        name: `${customName} (Group ${idx + 1})`,
        score: (room.scores && room.scores[idx]) || 0
      });
    }
    return list.sort((a, b) => b.score - a.score);
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
    req.session.groupCount = parseInt(groupCount, 10) || 2;

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
          <h2 style="color: #dc3545;">⚠️ Access Denied</h2>
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
  if (!roomId || !rooms[roomId]) {
    return res.send('<h3>Access Denied: Invalid or Expired Room</h3>');
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
    const mode = req.query.mode || 'manual';
    res.json({ success: true, mode, questions: readQuestionsFromFile(mode) });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to read questions' });
  }
});

app.post('/api/questions', (req, res) => {
  try {
    const mode = req.query.mode || (req.body && !Array.isArray(req.body) ? req.body.mode : null) || 'manual';
    const payload = Array.isArray(req.body) ? req.body : req.body.questions;
    if (!Array.isArray(payload)) {
      return res.status(400).json({ success: false, message: 'Questions must be an array' });
    }
    saveQuestionsToFile(payload, mode);
    res.json({ success: true, mode, message: 'Questions updated successfully!' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to save questions' });
  }
});

// ==========================================
// SOCKET.IO REAL-TIME GAME LOGIC
// ==========================================
io.on('connection', (socket) => {

  // 1. Master creates a room (Unified for Manual, Auto Rapid Fire, and Group modes)
  socket.on('create_room', async (data) => {
    try {
      const roomId = typeof data === 'object' ? data.roomId : data;
      const mode = typeof data === 'object' ? (data.mode || 'manual') : 'manual';
      const groupCount = typeof data === 'object' ? (parseInt(data.groupCount, 10) || 2) : 2;

      if (!roomId) return;

      if (rooms[roomId]) {
        clearRoomTimers(rooms[roomId]);
      }

      const modeQuestions = readQuestionsFromFile(mode);
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
          started: false,
          ended: false,
          currentQuestion: 0,
          activeQuestionIndex: 0,
          activeGroup: 0,
          groupCount,
          scores: Array(groupCount).fill(0),
          groupNames: {},
          groupSockets: {},
          players: {},
          questions: Array.isArray(modeQuestions) ? modeQuestions : [],
          timer: null,
          nextTimeout: null
        };
        for (let i = 0; i < groupCount; i++) {
          rooms[roomId].groupSockets[i] = [];
        }
      } else {
        rooms[roomId] = {
          mode, // 'manual' or 'auto'
          ended: false,
          currentQuestion: 0,
          activeQuestionIndex: 0,
          players: {},
          answers: {},
          questions: Array.isArray(modeQuestions) ? modeQuestions : [],
          timer: null,
          nextTimeout: null
        };
      }

      socket.emit('room_created', { roomId, qrCode: qrImage, mode, joinUrl });
    } catch (err) {
      console.error('Error in create_room:', err);
      socket.emit('error_msg', 'Failed to create room.');
    }
  });

  // 2. Individual Participant Joins (Supports Rejoin After Phone Call / Disconnect)
  socket.on('join_room', ({ roomId, name }) => {
    const room = rooms[roomId];
    if (!room) return socket.emit('error_msg', 'Room not found!');

    const cleanName = String(name || '').trim();
    if (!cleanName) return socket.emit('error_msg', 'Please enter a valid name!');

    socket.join(roomId);

    const existingEntry = Object.entries(room.players).find(
      ([, p]) => String(p.name || '').trim().toLowerCase() === cleanName.toLowerCase()
    );

    if (existingEntry) {
      const [oldSocketId, oldPlayer] = existingEntry;
      delete room.players[oldSocketId];

      // Transfer active-question answer tracking to the new socket ID
      if (room.answers && Object.prototype.hasOwnProperty.call(room.answers, oldSocketId)) {
        room.answers[socket.id] = room.answers[oldSocketId];
        delete room.answers[oldSocketId];
      }

      room.players[socket.id] = {
        ...oldPlayer,
        id: socket.id,
        name: cleanName,
        disconnected: false
      };
    } else {
      room.players[socket.id] = {
        id: socket.id,
        name: cleanName,
        score: 0,
        lastRoundTime: null,
        lastRoundScore: 0,
        totalTime: 0,
        disconnected: false
      };
    }

    socket.emit('joined_successfully', { roomId, name: cleanName, mode: room.mode });
    io.to(roomId).emit('player_list_update', Object.values(room.players));

    // Sync participant screen if they rejoin mid-quiz or after the quiz ends
    const totalQuestions = room.questions ? room.questions.length : 0;
    if (room.ended || (totalQuestions > 0 && room.currentQuestion >= totalQuestions && room.timer === null)) {
      const finalLeaderboard = getSortedLeaderboard(room);
      socket.emit('leaderboard_data', finalLeaderboard);
      socket.emit('quiz_ended', finalLeaderboard);
    } else if (room.currentQuestion > 0 && room.activeQuestionIndex !== undefined && room.questions[room.activeQuestionIndex]) {
      const q = room.questions[room.activeQuestionIndex];
      socket.emit('display_question', {
        questionNumber: room.activeQuestionIndex + 1,
        question: q.question,
        options: q.options
      });

      const alreadyAnswered = room.answers && Object.prototype.hasOwnProperty.call(room.answers, socket.id);
      if (alreadyAnswered) {
        const playerObj = room.players[socket.id];
        socket.emit('answer_confirmed', {
          timeTaken: playerObj.lastRoundTime ?? 0,
          scoreGained: playerObj.lastRoundScore ?? 0,
          isCorrect: (playerObj.lastRoundScore ?? 0) > 0
        });
      }
    }
  });

  // Helper: Load Question for Individual Modes ('manual' and 'auto')
  function loadQuestion(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    clearRoomTimers(room);

    const totalQuestions = room.questions ? room.questions.length : 0;
    if (room.currentQuestion >= totalQuestions) {
      room.ended = true;
      const finalLeaderboard = getSortedLeaderboard(room);
      io.to(roomId).emit('quiz_ended', finalLeaderboard);
      io.to(roomId).emit('leaderboard_data', finalLeaderboard);
      return;
    }

    const qIndex = room.currentQuestion;
    const q = room.questions[qIndex];
    room.activeQuestionIndex = qIndex;
    room.answers = {};
    room.questionStartTime = Date.now();
    room.currentQuestion += 1;

    io.to(roomId).emit('display_question', {
      questionNumber: qIndex + 1,
      question: q.question,
      options: q.options
    });

    let timeLeft = 15;
    io.to(roomId).emit('timer_tick', timeLeft);

    room.timer = setInterval(() => {
      const activeRoom = rooms[roomId];
      if (!activeRoom) {
        clearInterval(room.timer);
        return;
      }

      timeLeft -= 1;
      io.to(roomId).emit('timer_tick', timeLeft);

      if (timeLeft <= 0) {
        clearRoomTimers(activeRoom);
        const leaderboard = getSortedLeaderboard(activeRoom);
        io.to(roomId).emit('time_up');
        io.to(roomId).emit('leaderboard_data', leaderboard);

        if (activeRoom.mode === 'auto') {
          activeRoom.nextTimeout = setTimeout(() => {
            loadQuestion(roomId);
          }, 5000);
        }
      }
    }, 1000);
  }

  // 4. Master clicks 'Next Question' (Handles Individual and Group modes)
  socket.on('next_question', (roomId) => {
    const room = rooms[roomId];
    if (!room) return;

    clearRoomTimers(room);

    if (room.mode === 'group') {
      if (!room.started) {
        room.started = true;
        room.ended = false;
        room.currentQuestion = 0;
        room.activeGroup = 0;
        startGroupTurnTimer(roomId, io);
      } else {
        advanceGroupQuiz(roomId, io);
      }
    } else {
      loadQuestion(roomId);
    }
  });

  // 5. Start Group Game (Automated Turn Rotation)
  socket.on('start_group_game', ({ roomId }) => {
    const room = rooms[roomId];
    if (room && room.mode === 'group') {
      clearRoomTimers(room);
      room.started = true;
      room.ended = false;
      room.currentQuestion = 0;
      room.activeGroup = 0;
      startGroupTurnTimer(roomId, io);
    }
  });

  // Helper: Safe Group Turn Progression
  function advanceGroupQuiz(roomId, ioServer) {
    const room = rooms[roomId];
    if (!room) return;

    clearRoomTimers(room);

    room.currentQuestion += 1;
    const totalQuestions = room.questions ? room.questions.length : 0;

    if (room.currentQuestion >= totalQuestions) {
      room.started = false;
      room.ended = true;
      const finalLeaderboard = getSortedLeaderboard(room);
      ioServer.to(roomId).emit('group_quiz_ended', {
        scores: room.scores,
        groupNames: room.groupNames || {}
      });
      ioServer.to(roomId).emit('quiz_ended', finalLeaderboard);
      ioServer.to(roomId).emit('leaderboard_data', finalLeaderboard);
    } else {
      room.activeGroup = room.currentQuestion % room.groupCount;
      ioServer.to(roomId).emit('leaderboard_data', getSortedLeaderboard(room));
      startGroupTurnTimer(roomId, ioServer);
    }
  }

  // 6. Submit Group Answer
  socket.on('submit_group_answer', ({ roomId, groupIndex, selectedOption }) => {
    const room = rooms[roomId];
    const gIdx = parseInt(groupIndex, 10);
    if (!room || room.mode !== 'group' || Number.isNaN(gIdx) || gIdx !== room.activeGroup) return;

    clearRoomTimers(room);

    const currentQ = room.questions && room.questions[room.currentQuestion];
    const isCorrect = Boolean(currentQ && selectedOption === currentQ.answer);
    const scoreGained = isCorrect ? 10 : 0;

    if (isCorrect) {
      room.scores[gIdx] = (room.scores[gIdx] || 0) + scoreGained;
    }

    io.to(`${roomId}-group-${gIdx}`).emit('group_answer_confirmed', {
      isCorrect,
      scoreGained,
      scores: room.scores
    });

    advanceGroupQuiz(roomId, io);
  });

  // Helper: Turn Timer for Groups (1 player per group across 2/3/4 groups)
  function startGroupTurnTimer(roomId, ioServer) {
    const room = rooms[roomId];
    if (!room) return;

    clearRoomTimers(room);

    const totalQuestions = room.questions ? room.questions.length : 0;
    if (room.currentQuestion >= totalQuestions) {
      advanceGroupQuiz(roomId, ioServer);
      return;
    }

    room.activeQuestionIndex = room.currentQuestion;
    const currentQ = room.questions[room.currentQuestion];

    ioServer.to(roomId).emit('group_game_state_update', {
      questionNumber: room.currentQuestion + 1,
      activeGroup: room.activeGroup,
      scores: room.scores,
      groupNames: room.groupNames || {},
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

    let timeLeft = 10;
    ioServer.to(roomId).emit('timer_tick', timeLeft);

    room.timer = setInterval(() => {
      const activeRoom = rooms[roomId];
      if (!activeRoom) {
        clearInterval(room.timer);
        return;
      }

      timeLeft -= 1;
      ioServer.to(roomId).emit('timer_tick', timeLeft);

      if (timeLeft <= 0) {
        clearRoomTimers(activeRoom);
        advanceGroupQuiz(roomId, ioServer);
      }
    }, 1000);
  }

  // 7. Individual Answer Submission
  socket.on('submit_answer', ({ roomId, selectedOption }) => {
    const room = rooms[roomId];
    if (!room || !room.players[socket.id] || room.answers[socket.id] !== undefined) return;

    const startTime = room.questionStartTime || Date.now();
    const timeTaken = parseFloat(((Date.now() - startTime) / 1000).toFixed(2));

    room.answers[socket.id] = selectedOption;

    const qIdx = room.activeQuestionIndex !== undefined
      ? room.activeQuestionIndex
      : Math.max(0, room.currentQuestion - 1);
    const currentQ = room.questions && room.questions[qIdx];

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

    // Count connected players so a player on a phone call doesn't permanently block auto-advance
    const connectedPlayers = Object.values(room.players).filter((p) => !p.disconnected);
    const totalPlayers = connectedPlayers.length;
    const answeredPlayers = connectedPlayers.filter(
      (p) => room.answers[p.id] !== undefined
    ).length;

    if (answeredPlayers >= totalPlayers && totalPlayers > 0) {
      clearRoomTimers(room);

      const leaderboard = getSortedLeaderboard(room);
      io.to(roomId).emit('time_up');
      io.to(roomId).emit('leaderboard_data', leaderboard);

      if (room.mode === 'auto') {
        room.nextTimeout = setTimeout(() => {
          loadQuestion(roomId);
        }, 5000);
      }
    }
  });

  // 8. Show Leaderboard Manually (Does NOT increment currentQuestion)
  socket.on('show_leaderboard', (roomId) => {
    const room = rooms[roomId];
    if (!room) return;

    clearRoomTimers(room);

    const leaderboard = getSortedLeaderboard(room);
    io.to(roomId).emit('leaderboard_data', leaderboard);
  });

  // Get room group info
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

  // Join Group Participant (Supports Rejoin After Call & Re-syncs Active Turn or Final Standings)
  socket.on('join_group_participant', ({ roomId, name, groupIndex }) => {
    const room = rooms[roomId];
    const gIdx = parseInt(groupIndex, 10);
    const cleanName = String(name || '').trim();

    if (!room || room.mode !== 'group' || Number.isNaN(gIdx) || gIdx < 0 || gIdx >= room.groupCount) {
      return socket.emit('error_msg', 'Invalid group or room!');
    }
    if (!cleanName) {
      return socket.emit('error_msg', 'Please enter your name!');
    }

    if (!room.groupNames) room.groupNames = {};
    if (!room.groupSockets) room.groupSockets = {};
    if (!room.groupSockets[gIdx]) room.groupSockets[gIdx] = [];
    if (!room.players) room.players = {};

    // Prune disconnected sockets for this group
    room.groupSockets[gIdx] = room.groupSockets[gIdx].filter((id) => {
      const connected = Boolean(io.sockets.sockets.get(id));
      if (!connected && room.players[id] && room.players[id].group === gIdx) {
        delete room.players[id];
      }
      return connected;
    });

    const activeSocketIds = room.groupSockets[gIdx];
    const existingGroupName = String(room.groupNames[gIdx] || '').trim();
    const isReturningSamePlayer =
      existingGroupName.toLowerCase() === cleanName.toLowerCase();

    // Reject only if a different live user already took this group
    if (existingGroupName && activeSocketIds.length > 0 && !isReturningSamePlayer) {
      socket.emit('update_available_groups', {
        groupCount: room.groupCount,
        groupNames: room.groupNames
      });
      return socket.emit('error_msg', `Group ${gIdx + 1} is already taken by ${existingGroupName}!`);
    }

    socket.join(roomId);
    socket.join(`${roomId}-group-${gIdx}`);

    room.groupNames[gIdx] = cleanName;
    if (!room.groupSockets[gIdx].includes(socket.id)) {
      room.groupSockets[gIdx].push(socket.id);
    }

    room.players[socket.id] = {
      id: socket.id,
      name: `${cleanName} (Group ${gIdx + 1})`,
      group: gIdx,
      score: (room.scores && room.scores[gIdx]) || 0
    };

    socket.emit('group_joined_success', { name: cleanName, groupIndex: gIdx });

    io.to(roomId).emit('player_list_update', Object.values(room.players));
    io.to(roomId).emit('update_available_groups', {
      groupCount: room.groupCount,
      groupNames: room.groupNames
    });

    const totalQuestions = room.questions ? room.questions.length : 0;

    if (room.ended) {
      const finalLeaderboard = getSortedLeaderboard(room);
      socket.emit('group_quiz_ended', {
        scores: room.scores,
        groupNames: room.groupNames || {}
      });
      socket.emit('quiz_ended', finalLeaderboard);
      socket.emit('leaderboard_data', finalLeaderboard);
      return;
    }

    // Sync mid-game turn state if already started
    if (room.started && room.currentQuestion < totalQuestions) {
      const currentQ = room.questions[room.currentQuestion];
      socket.emit('group_game_state_update', {
        questionNumber: room.currentQuestion + 1,
        activeGroup: room.activeGroup,
        scores: room.scores,
        groupNames: room.groupNames,
        currentQuestionText: currentQ ? currentQ.question : 'Quiz Finished'
      });

      if (gIdx === room.activeGroup && currentQ) {
        socket.emit('group_turn_active', {
          questionNumber: room.currentQuestion + 1,
          question: currentQ.question,
          options: currentQ.options
        });
      } else {
        socket.emit('group_turn_waiting', { activeGroup: room.activeGroup });
      }
    }
  });

  // Clean up disconnected player entries without breaking group scores or individual leaderboard history
  socket.on('disconnect', () => {
    for (const roomId of Object.keys(rooms)) {
      const room = rooms[roomId];
      if (!room || !room.players || !room.players[socket.id]) continue;

      const player = room.players[socket.id];

      if (room.mode === 'group') {
        delete room.players[socket.id];
        if (player.group !== undefined && room.groupSockets && room.groupSockets[player.group]) {
          room.groupSockets[player.group] = room.groupSockets[player.group].filter((id) => id !== socket.id);
        }
      } else {
        // Keep individual participant in room.players so their score stays on the final leaderboard
        player.disconnected = true;
      }

      io.to(roomId).emit('player_list_update', Object.values(room.players));
    }
  });
});

server.listen(PORT, HOST, () => {
  const localIP = getLocalIpAddress();
  console.log('----------------------------------------------------');
  console.log(`Server running locally at: http://localhost:${PORT}`);
  console.log(`Network Join Link: http://${localIP}:${PORT}/participant.html`);
  console.log(`Master View: http://localhost:${PORT}/master.html`);
  console.log('----------------------------------------------------');
});
