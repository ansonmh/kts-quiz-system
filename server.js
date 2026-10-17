const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// 遊戲狀態機: IDLE -> PREVIEW -> OPEN -> COUNTDOWN -> REVEAL -> LEADERBOARD
const GameState = {
  IDLE: 'IDLE',
  PREVIEW: 'PREVIEW',
  OPEN: 'OPEN',
  COUNTDOWN: 'COUNTDOWN',
  REVEAL: 'REVEAL',
  LEADERBOARD: 'LEADERBOARD'
};

let currentState = GameState.IDLE;
let questions = [];
let currentQIndex = -1;
let questionStartTime = 0;
let countdownTimer = null;

// 資料存儲
// participants: { [userId]: { id, name, gradYear, tableNo, score, totalTimeSpent, answers: {} } }
let participants = {};
// currentAnswers: { [userId]: { choice: 'A', timestamp: 12345678 } }
let currentAnswers = {};

// 廣播最新全域遊戲狀態
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
    answeredCount: Object.keys(currentAnswers).length
  });
}

// 計算當前題目的選擇分佈 (A/B/C/D)
function getDistribution() {
  const counts = { A: 0, B: 0, C: 0, D: 0 };
  Object.values(currentAnswers).forEach(ans => {
    if (counts[ans.choice] !== undefined) counts[ans.choice]++;
  });
  return counts;
}

// 結算當前題目分數
function evaluateCurrentQuestion() {
  const q = questions[currentQIndex];
  if (!q) return;

  Object.entries(currentAnswers).forEach(([uid, ans]) => {
    const user = participants[uid];
    if (!user) return;

    const isCorrect = ans.choice.trim().toUpperCase() === q.correct.trim().toUpperCase();
    const timeSpent = Math.max(0, ans.timestamp - questionStartTime);

    user.answers[currentQIndex] = {
      choice: ans.choice,
      correct: isCorrect,
      timeSpent: timeSpent
    };

    if (isCorrect) {
      user.score += 10;
      user.totalTimeSpent += timeSpent;
    }
  });
}

// 產生個人前十名與枱號排行榜
function getLeaderboardData() {
  const list = Object.values(participants);

  // 個人排行榜（優先看分數，平手看總耗時（毫秒，越低越好））
  const individualRank = [...list].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.totalTimeSpent - b.totalTimeSpent;
  }).slice(0, 10);

  // 枱號平均分排行榜
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

io.on('connection', (socket) => {
  // 1. 參加者登記 / 恢復連線
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

  // 2. 參加者提交答案
  socket.on('submit_answer', (choice) => {
    if (currentState !== GameState.OPEN && currentState !== GameState.COUNTDOWN) return;
    if (!socket.userId || !participants[socket.userId]) return;

    currentAnswers[socket.userId] = {
      choice,
      timestamp: Date.now()
    };

    io.emit('answer_stats', {
      answeredCount: Object.keys(currentAnswers).length,
      activeCount: Object.keys(participants).length
    });
  });

  // 3. 後台操作指令
  socket.on('admin_command', (cmd) => {
    switch (cmd.action) {
      case 'PREVIEW_QUESTION':
        if (cmd.index >= 0 && cmd.index < questions.length) {
          currentQIndex = cmd.index;
          currentState = GameState.PREVIEW;
          currentAnswers = {};
          broadcastState();
        }
        break;

      case 'OPEN_ANSWER':
        if (currentState === GameState.PREVIEW) {
          currentState = GameState.OPEN;
          questionStartTime = Date.now();
          broadcastState();
        }
        break;

      case 'START_COUNTDOWN':
        if (currentState === GameState.OPEN) {
          currentState = GameState.COUNTDOWN;
          broadcastState();
          io.emit('start_countdown_timer', 5);

          let counter = 5;
          clearInterval(countdownTimer);
          countdownTimer = setInterval(() => {
            counter--;
            if (counter <= 0) {
              clearInterval(countdownTimer);
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
          }, 1000);
        }
        break;

      case 'SHOW_LEADERBOARD':
        currentState = GameState.LEADERBOARD;
        io.emit('show_leaderboard_data', getLeaderboardData());
        broadcastState();
        break;

      case 'RESET_GAME':
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

  // 4. 後台匯入題目
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

  // 斷線時更新連線人數
  socket.on('disconnect', () => {
    broadcastState();
  });
});

// CSV 導出端點
app.get('/api/export', (req, res) => {
  const users = Object.values(participants);
  users.sort((a, b) => b.score - a.score || a.totalTimeSpent - b.totalTimeSpent);

  let csv = '\uFEFF排名,姓名,畢業年份,枱號,總得分,總作答時間(秒)\n';
  users.forEach((u, idx) => {
    csv += `${idx + 1},"${u.name}","${u.gradYear}","${u.tableNo}",${u.score},${(u.totalTimeSpent / 1000).toFixed(2)}\n`;
  });

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="KTS65_Quiz_Results.csv"');
  res.send(csv);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`KTS 65th Gala Quiz Server running on http://localhost:${PORT}`);
});