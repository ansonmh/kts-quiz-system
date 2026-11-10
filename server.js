const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const GameState = {
  IDLE: 'IDLE',
  PREVIEW: 'PREVIEW',
  OPEN: 'OPEN',
  REVEAL: 'REVEAL',
  LEADERBOARD: 'LEADERBOARD'
};

let currentState = GameState.IDLE;
let questions = [];
let currentQIndex = -1;
let questionStartTime = 0;
let questionDuration = 20; // 預設 20 秒
let countdownTimer = null;
let remainingSeconds = 20;

let participants = {};
let currentAnswers = {};

function broadcastState() {
  const currentQ = questions[currentQIndex] || null;
  const sanitizedQ = currentQ ? {
    index: currentQIndex + 1,
    total: questions.length,
    question: currentQ.question,
    options: currentQ.options
  } : null;

  io.emit('state_update', {
    state: currentState,
    currentQuestion: sanitizedQ,
    activeCount: Object.keys(participants).length,
    answeredCount: Object.keys(currentAnswers).length,
    duration: questionDuration,
    remainingSeconds: remainingSeconds
  });
}

function getDistribution() {
  const counts = { A: 0, B: 0, C: 0, D: 0 };
  Object.values(currentAnswers).forEach(ans => {
    if (counts[ans.choice] !== undefined) counts[ans.choice]++;
  });
  return counts;
}

function evaluateCurrentQuestion() {
  const q = questions[currentQIndex];
  if (!q) return;

  Object.entries(currentAnswers).forEach(([uid, ans]) => {
    const user = participants[uid];
    if (!user) return;

    const isCorrect = ans.choice.trim().toUpperCase() === q.correct.trim().toUpperCase();
    const timeSpentMs = Math.max(0, ans.timestamp - questionStartTime);
    const timeSpentSec = Math.min(questionDuration, timeSpentMs / 1000);

    let roundScore = 0;
    if (isCorrect) {
      // 50分底分 + 最高50分競速獎勵
      const speedBonus = Math.round(50 * (1 - (timeSpentSec / questionDuration)));
      roundScore = 50 + Math.max(0, speedBonus);
      user.score += roundScore;
      user.totalTimeSpent += timeSpentMs;
    }

    user.answers[currentQIndex] = {
      choice: ans.choice,
      correct: isCorrect,
      timeSpentSec: timeSpentSec.toFixed(2),
      roundScore: roundScore
    };
  });
}

function getLeaderboardData() {
  const list = Object.values(participants);

  const individualRank = [...list].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.totalTimeSpent - b.totalTimeSpent;
  }).slice(0, 10);

  const tableStats = {};
  list.forEach(p => {
    if (!tableStats[p.tableNo]) tableStats[p.tableNo] = { totalScore: 0, members: 0 };
    tableStats[p.tableNo].totalScore += p.score;
    tableStats[p.tableNo].members += 1;
  });

  const tableRank = Object.entries(tableStats).map(([tableNo, stat]) => ({
    tableNo,
    avgScore: (stat.totalScore / stat.members).toFixed(1),
    members: stat.members
  })).sort((a, b) => b.avgScore - a.avgScore).slice(0, 5);

  return { individualRank, tableRank };
}

function endQuestion() {
  clearInterval(countdownTimer);
  countdownTimer = null;
  currentState = GameState.REVEAL;
  evaluateCurrentQuestion();
  const q = questions[currentQIndex];
  io.emit('reveal_result', {
    correct: q.correct,
    distribution: getDistribution(),
    answers: currentAnswers
  });
  broadcastState();
}

io.on('connection', (socket) => {
  socket.on('register', (data, callback) => {
    const { userId, name, gradYear, tableNo } = data;
    if (!userId || !name || !tableNo) {
      return callback({ success: false, message: '請填寫完整資訊' });
    }

    if (!participants[userId]) {
      participants[userId] = {
        id: userId,
        name,
        gradYear,
        tableNo,
        score: 0,
        totalTimeSpent: 0,
        answers: {}
      };
    }

    socket.userId = userId;
    socket.join('participants');
    callback({ success: true, user: participants[userId] });
    broadcastState();
  });

  socket.on('submit_answer', (choice) => {
    if (currentState !== GameState.OPEN) return;
    if (!socket.userId || !participants[socket.userId]) return;

    // 記錄精確作答時間戳
    currentAnswers[socket.userId] = {
      choice,
      timestamp: Date.now()
    };

    io.emit('answer_stats', {
      answeredCount: Object.keys(currentAnswers).length,
      activeCount: Object.keys(participants).length
    });
  });

  socket.on('admin_command', (cmd) => {
    switch (cmd.action) {
      case 'PREVIEW_QUESTION':
        clearInterval(countdownTimer);
        if (cmd.index >= 0 && cmd.index < questions.length) {
          currentQIndex = cmd.index;
          currentState = GameState.PREVIEW;
          currentAnswers = {};
          broadcastState();
        }
        break;

      case 'START_TIMER':
        if (currentState === GameState.PREVIEW || currentState === GameState.OPEN) {
          currentState = GameState.OPEN;
          questionDuration = cmd.duration || 20;
          remainingSeconds = questionDuration;
          questionStartTime = Date.now();
          currentAnswers = {};

          broadcastState();
          io.emit('timer_start', { duration: questionDuration });

          clearInterval(countdownTimer);
          countdownTimer = setInterval(() => {
            remainingSeconds--;
            io.emit('timer_tick', { remaining: remainingSeconds });

            if (remainingSeconds <= 0) {
              endQuestion();
            }
          }, 1000);
        }
        break;

      case 'FORCE_STOP':
        if (currentState === GameState.OPEN) {
          endQuestion();
        }
        break;

      case 'SHOW_LEADERBOARD':
        clearInterval(countdownTimer);
        currentState = GameState.LEADERBOARD;
        io.emit('show_leaderboard_data', getLeaderboardData());
        broadcastState();
        break;

      case 'RESET_GAME':
        clearInterval(countdownTimer);
        currentState = GameState.IDLE;
        currentQIndex = -1;
        currentAnswers = {};
        Object.values(participants).forEach(p => {
          p.score = 0;
          p.totalTimeSpent = 0;
          p.answers = {};
        });
        broadcastState();
        break;
    }
  });

  socket.on('import_questions', (list, callback) => {
    if (!Array.isArray(list) || list.length === 0) {
      return callback({ success: false, message: '題目格式錯誤' });
    }
    questions = list;
    currentQIndex = -1;
    currentState = GameState.IDLE;
    currentAnswers = {};
    broadcastState();
    callback({ success: true, count: questions.length });
  });

  socket.on('disconnect', () => {
    broadcastState();
  });
});

app.get('/api/export', (req, res) => {
  const users = Object.values(participants);
  users.sort((a, b) => b.score - a.score || a.totalTimeSpent - b.totalTimeSpent);

  let csv = '\uFEFF排名,姓名,畢業年份,枱號,總得分,總作答耗時(秒)\n';
  users.forEach((u, idx) => {
    csv += `${idx + 1},"${u.name}","${u.gradYear}","${u.tableNo}",${u.score},${(u.totalTimeSpent / 1000).toFixed(2)}\n`;
  });

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="KTS65_Quiz_Results.csv"');
  res.send(csv);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`KTS 65th Gala Quiz Server running on port ${PORT}`);
});