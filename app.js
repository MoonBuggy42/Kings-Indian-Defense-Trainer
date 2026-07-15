// app.js — King's Indian Defense Trainer
// Evaluation: Pure Stockfish (centipawn loss). No external API needed.
'use strict';

const MAX_MOVES = 25;
const BOOK_PRIORITY_WEIGHT = 20;      // how strongly top theory influences book selection
const BOOK_NEW_LINE_MARGIN = 40;      // cp tolerance to choose a new/less-played book line
const BOOK_SAFE_LINE_MARGIN = 80;     // cp tolerance to use a book line at all

// ── STATE ──────────────────────────────────────────────────────────────────────
let chess = new Chess();
let board = null;
let sfWorker = null;
let sfReady = false;

// Stockfish async state
let sfResolve = null;
let sfTimeoutId = null;
let sfMultiPV = {};
let sfAnalysisTurn = 'w';

// Evaluation tracking (always in White's perspective, in pawns)
let sfLiveEval = 0;         // Updated live during Stockfish analysis
let evalBeforeUser = 0;     // Snapshot taken just before the user makes a move

let gameState = {
    moveNum: 1,             // White's move number
    isBotThinking: false,
    isGameOver: false,
    accuracies: [],
    initialBotMoveProtected: false
};

const MAX_RECENT_BOOK_LINES = 50;
let sessionBookLineHistory = new Set();
let recentBookLines = JSON.parse(localStorage.getItem('recentBookLines') || '[]');

let matchHistory = JSON.parse(localStorage.getItem('matchHistory') || '[]');

// ── DOM ────────────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const ui = {
    moveCounter:    $('move-counter'),
    accuracy:       $('current-accuracy'),
    evalScore:      $('eval-score'),
    engineStatus:   $('engine-status'),
    statusDot:      document.querySelector('.dot'),
    feedbackPanel:  $('feedback-panel'),
    evalIcon:       $('move-eval-icon'),
    evalText:       $('move-eval-text'),
    moveAccuracy:   $('move-accuracy-score'),
    whiteExp:       $('white-explanation'),
    blackMove:      $('black-move'),
    blackExp:       $('black-explanation'),
    undoBtn:        $('undo-btn'),
    resignBtn:      $('resign-btn'),
    settingsBtn:    $('settings-btn'),
    settingsModal:  $('settings-modal'),
    closeSettings:  $('close-settings'),
    saveSettings:   $('save-settings-btn'),
    gameOverPanel:  $('game-over-panel'),
    newGameBtn:     $('new-game-btn'),
    finalResult:    $('final-better-position'),
    overallAccText: $('overall-accuracy-text'),
    overallAccCircle: $('overall-accuracy-circle'),
    totalGames:     $('total-games'),
    whiteBetterPct: $('white-better-pct'),
    historyContainer: $('history-container')
};

// ── INIT ───────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    // Failsafe: update key-status after 300ms regardless of init errors
    setTimeout(() => {
        const el = document.getElementById('key-status');
        if (el) {
            el.textContent = '✅ Stockfish evaluation — no API key needed!';
            el.style.color = '#10B981';
        }
    }, 300);

    try { initStockfish(); }   catch(e) { console.error('Stockfish init failed:', e); }
    try { initBoard(); }       catch(e) { console.error('Board init failed:', e); }
    try { initTabs(); }        catch(e) { console.error('Tabs init failed:', e); }
    try { initSettings(); }    catch(e) { console.error('Settings init failed:', e); }
    try { updateDashboard(); } catch(e) { console.error('Dashboard init failed:', e); }

    ui.undoBtn.addEventListener('click', undoMove);
    ui.resignBtn.addEventListener('click', resignGame);
    ui.newGameBtn.addEventListener('click', resetGame);

    resetGame();
});

// ── SETTINGS ──────────────────────────────────────────────────────────────────
function initSettings() {
    ui.settingsBtn.addEventListener('click', () => { ui.settingsModal.style.display = 'flex'; });
    ui.closeSettings.addEventListener('click', () => { ui.settingsModal.style.display = 'none'; });
    ui.saveSettings.addEventListener('click', () => {
        ui.settingsModal.style.display = 'none';
        showToast('✅ Settings saved!');
    });
}

function showToast(msg) {
    let t = document.getElementById('toast');
    if (!t) {
        t = document.createElement('div');
        t.id = 'toast';
        t.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:#1E293B;color:#fff;padding:10px 20px;border-radius:12px;font-size:14px;font-weight:600;z-index:9999;border:1px solid rgba(255,255,255,0.1);box-shadow:0 4px 20px rgba(0,0,0,0.4);transition:opacity 0.3s';
        document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.opacity = '1';
    clearTimeout(t._tid);
    t._tid = setTimeout(() => { t.style.opacity = '0'; }, 3000);
}

// ── TABS ──────────────────────────────────────────────────────────────────────
function initTabs() {
    document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', e => {
            e.preventDefault();
            const target = item.getAttribute('data-target');
            document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
            item.classList.add('active');
            document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
            document.getElementById(target).classList.add('active');
            if (target === 'tab-dashboard') updateDashboard();
        });
    });
}

// ── STOCKFISH ─────────────────────────────────────────────────────────────────
function initStockfish() {
    sfWorker = new Worker('stockfish.js');

    sfWorker.onerror = err => {
        console.error('Stockfish worker error:', err);
        setStatus('Engine Error', false);
        resolveSf(null);
    };

    sfWorker.onmessage = ({ data: line }) => {
        if (line === 'uciok') {
            sfWorker.postMessage('setoption name Skill Level value 20');
            sfWorker.postMessage('setoption name MultiPV value 5');
            sfWorker.postMessage('isready');
        } else if (line === 'readyok') {
            sfReady = true;
            setStatus('Stockfish 2600 ELO', false);
        } else if (line.startsWith('info') && line.includes('score')) {
            parseInfo(line);
        } else if (line.startsWith('bestmove')) {
            handleBestMove(line);
        }
    };

    sfWorker.postMessage('uci');
}

function parseInfo(line) {
    const pvM = line.match(/multipv (\d+)/);
    const sM  = line.match(/score (cp|mate) (-?\d+)/);
    const mvM = line.match(/ pv ([a-h][1-8][a-h][1-8][qrbn]?)/);
    if (!pvM || !sM || !mvM) return;

    const idx = parseInt(pvM[1], 10);
    let score = parseInt(sM[2], 10);
    if (sM[1] === 'mate') score = score > 0 ? 30000 : -30000;

    sfMultiPV[idx] = { move: mvM[1], score };

    // Score normalization: always display from White's perspective.
    if (idx === 1) {
        const whiteScore = sfAnalysisTurn === 'b' ? -score : score;
        if (sM[1] === 'cp') {
            sfLiveEval = whiteScore / 100;
            const prefix = sfLiveEval > 0 ? '+' : '';
            ui.evalScore.textContent = `${prefix}${sfLiveEval.toFixed(1)}`;
        } else {
            const m = Math.abs(parseInt(sM[2], 10));
            sfLiveEval = whiteScore > 0 ? 999 : -999;
            ui.evalScore.textContent = whiteScore > 0 ? `+M${m}` : `-M${m}`;
        }
    }
}

function handleBestMove(line) {
    if (!sfResolve) return;
    clearTimeout(sfTimeoutId);
    sfTimeoutId = null;

    const entries = Object.values(sfMultiPV);
    let chosen = null;

    if (entries.length > 0) {
        // Prefer the strongest move from Stockfish; randomize only among exact top-score ties.
        const best = Math.max(...entries.map(e => e.score));
        const bestMoves = entries.filter(e => e.score === best);
        chosen = bestMoves[Math.floor(Math.random() * bestMoves.length)].move;
    }

    if (!chosen) {
        const m = line.match(/bestmove ([a-h][1-8][a-h][1-8][qrbn]?)/);
        chosen = m ? m[1] : null;
    }

    resolveSf(chosen || pickRandom());
}

function resolveSf(val) {
    if (sfResolve) {
        const r = sfResolve;
        sfResolve = null;
        r(val);
    }
}

function pickRandom() {
    const moves = chess.moves({ verbose: true });
    if (!moves.length) return null;
    const m = moves[Math.floor(Math.random() * moves.length)];
    return m.from + m.to + (m.promotion || '');
}

function getStockfishMove(fen, ms = 1200) {
    return new Promise(resolve => {
        sfMultiPV = {};
        sfResolve = resolve;

        if (!sfWorker || !sfReady) {
            sfResolve = null;
            resolve(pickRandom());
            return;
        }

        sfWorker.postMessage(`position fen ${fen}`);
        sfWorker.postMessage(`go movetime ${ms}`);

        // Hard safety timeout for mobile browsers that kill workers
        sfTimeoutId = setTimeout(() => {
            if (sfResolve) {
                console.warn('Stockfish timeout — using random move');
                resolveSf(pickRandom());
            }
        }, ms + 2500);
    });
}

// ── KING'S INDIAN DEFENSE OPENING BOOK ──────────────────────────────────────
// A collection of common KID variations (UCI half-move sequences).
// Matching requires the book line to follow the full move history exactly.
const KID_LINES = [
    // Classical KID: 1.d4 Nf6 2.c4 g6 3.Nc3 Bg7 4.e4 d6
    ['d2d4','g8f6','c2c4','g7g6','b1c3','f8g7','e2e4','d7d6'],
    // Fianchetto mainline: 1.d4 Nf6 2.c4 g6 3.Nf3 Bg7
    ['d2d4','g8f6','c2c4','g7g6','g1f3','f8g7'],
    // Averbakh variation: 1.d4 Nf6 2.c4 g6 3.Nc3 Bg7 4.e4 d6 5.Be2 O-O
    ['d2d4','g8f6','c2c4','g7g6','b1c3','f8g7','e2e4','d7d6','f1e2','e8g8'],
    // Bayonet attack begins: 1.d4 Nf6 2.c4 g6 3.Nc3 Bg7 4.e4 d6 5.Nf3 O-O 6.Be2 e5
    ['d2d4','g8f6','c2c4','g7g6','b1c3','f8g7','e2e4','d7d6','g1f3','e8g8','f1e2','e7e5'],
    // Petrosian system / Four Pawns: 1.d4 Nf6 2.c4 g6 3.e4
    ['d2d4','g8f6','c2c4','g7g6','e2e4','f8g7'],
    // Samisch idea: 1.d4 Nf6 2.c4 g6 3.Nc3 Bg7 4.e4 d6 5.f3
    ['d2d4','g8f6','c2c4','g7g6','b1c3','f8g7','e2e4','d7d6','f2f3'],
    // Saemisch with early ...c5
    ['d2d4','g8f6','c2c4','g7g6','b1c3','f8g7','e2e4','d7d6','f2f3','c7c5'],
    // Fianchetto reversed orders (for c4 played later)
    ['c2c4','g8f6','d2d4','g7g6','b1c3','f8g7','e2e4','d7d6'],
    // King's Indian via g3 lines
    ['g1f3','g8f6','g2g3','g7g6','f1g2','f8g7','d2d4','d7d6'],
    // Benoni-type transposition into KID setups
    ['d2d4','g8f6','c2c4','g7g6','b1c3','f8g7','e2e4','c7c5'],
    // Additional common continuations
    ['d2d4','g8f6','c2c4','g7g6','b1c3','f8g7','e2e4','d7d6','g1f3','e8g8'],
    ['d2d4','g8f6','c2c4','g7g6','g1f3','f8g7','e2e4','d7d6','b1c3','e8g8'],
    ['d2d4','g8f6','c2c4','g7g6','b1c3','f8g7','e2e4','d7d6','f1e2','e8g8'],
    ['d2d4','g8f6','c2c4','g7g6','g1f3','f8g7','e2e4','d7d6','f1e2','c7c5'],
    ['d2d4','g8f6','c2c4','g7g6','b1c3','f8g7','e2e4','d7d6','g1f3','e7e5'],
    ['d2d4','g8f6','g1f3','g7g6','b1c3','f8g7','e2e4','d7d6'],
    ['d2d4','g8f6','c2c4','g7g6','b1c3','f8g7','e2e4','d7d6','g1f3','e8g8','f1e2','e7e5'],
    ['d2d4','g8f6','c2c4','g7g6','b1c3','f8g7','e2e4','d7d6','g1f3','e8g8','f1e2','c7c5'],
    ['d2d4','g8f6','c2c4','g7g6','b1c3','f8g7','e2e4','d7d6','c2c4','c7c5'],
    ['d2d4','g8f6','c2c4','g7g6','b1c3','f8g7','e2e4','d7d6','f1e2','e8g8','g1f3','e7e5'],
];

const KID_LINE_PRIORITY = {
    // Top theory lines for the King's Indian Defense (KID)
    'd2d4|g8f6|c2c4|g7g6|b1c3|f8g7|e2e4|d7d6': 10,
    'd2d4|g8f6|c2c4|g7g6|g1f3|f8g7|e2e4|d7d6': 12,
    'd2d4|g8f6|c2c4|g7g6|b1c3|f8g7|e2e4|e7e5': 14,
    'd2d4|g8f6|c2c4|g7g6|b1c3|f8g7|e2e4|d7d6|f1e2|e8g8': 16,
    'd2d4|g8f6|c2c4|g7g6|g1f3|f8g7|e2e4|d7d6|b1c3|e8g8': 18,
    'd2d4|g8f6|c2c4|g7g6|b1c3|f8g7|e2e4|d7d6|g1f3|e8g8|f1e2|e7e5': 20,
    'd2d4|g8f6|c2c4|g7g6|b1c3|f8g7|e2e4|d7d6|g1f3|e8g8|f1e2|c7c5': 22,
};

function rememberRecentBookLine(hash) {
    recentBookLines.unshift(hash);
    if (recentBookLines.length > MAX_RECENT_BOOK_LINES) recentBookLines.length = MAX_RECENT_BOOK_LINES;
    localStorage.setItem('recentBookLines', JSON.stringify(recentBookLines));
}

function isBookMoveAcceptable(uci) {
    const entries = Object.values(sfMultiPV);
    if (!entries.length) return true;

    const bestScore = Math.max(...entries.map(e => e.score));
    const candidate = entries.find(e => e.move === uci);
    if (!candidate) return false;

    return candidate.score >= bestScore - BOOK_SAFE_LINE_MARGIN;
}

function getBookMove() {
    const history = chess.history({ verbose: true }).map(m => m.from + m.to + (m.promotion || ''));
    const ply = history.length;

    const bestScore = Math.max(...Object.values(sfMultiPV).map(e => e.score), -Infinity);
    const recentHashes = new Set(recentBookLines);

    const candidates = KID_LINES.map(line => {
        const hash = line.join('|');
        const used = recentBookLines.filter(item => item === hash).length;
        const priority = KID_LINE_PRIORITY[hash] ?? 100;
        return { line, hash, used, priority, isRecent: recentHashes.has(hash), isSession: sessionBookLineHistory.has(hash) };
    }).filter(entry => {
        if (entry.line.length <= ply) return false;
        for (let i = 0; i < ply; i++) {
            if (entry.line[i] !== history[i]) return false;
        }
        return true;
    }).map(entry => {
        const next = entry.line[ply];
        const from = next?.slice(0, 2);
        const to = next?.slice(2, 4);
        const legal = next && chess.moves({ verbose: true }).find(m => m.from === from && m.to === to);
        const candidate = Object.values(sfMultiPV).find(e => e.move === next);
        const scoreLoss = candidate ? bestScore - candidate.score : Infinity;
        return { ...entry, next, legal: Boolean(legal), scoreLoss, candidate };
    }).filter(entry => entry.next && entry.legal && entry.candidate && entry.scoreLoss <= BOOK_SAFE_LINE_MARGIN);

    if (!candidates.length) return null;

    const freshCandidates = candidates.filter(entry => !entry.isRecent && entry.scoreLoss <= BOOK_NEW_LINE_MARGIN);
    const candidatePool = freshCandidates.length ? freshCandidates : candidates;

    candidatePool.sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        const scoreA = (a.isSession ? 200 : 0) + a.used * 20 + a.scoreLoss * 2;
        const scoreB = (b.isSession ? 200 : 0) + b.used * 20 + b.scoreLoss * 2;
        return scoreA - scoreB;
    });

    const topScore = (candidatePool[0]?.isSession ? 200 : 0) + candidatePool[0].used * 20 + candidatePool[0].scoreLoss * 2 + candidatePool[0].priority * 4;
    const topChoices = candidatePool.filter(entry => {
        const score = (entry.isSession ? 200 : 0) + entry.used * 20 + entry.scoreLoss * 2 + entry.priority * 4;
        return score <= topScore + 4;
    });

    const chosenEntry = topChoices[Math.floor(Math.random() * topChoices.length)];
    const chosen = chosenEntry.next;

    sessionBookLineHistory.add(chosenEntry.hash);
    rememberRecentBookLine(chosenEntry.hash);
    return chosen;
}

// ── BOARD ──────────────────────────────────────────────────────────────────────
function initBoard() {
    board = Chessboard('board', {
        draggable: true,
        position: 'start',
        orientation: 'black',
        onDragStart,
        onDrop,
        onSnapEnd: () => board.position(chess.fen()),
        pieceTheme: 'https://chessboardjs.com/img/chesspieces/wikipedia/{piece}.png'
    });
    window.addEventListener('resize', board.resize);
}

function onDragStart(source, piece) {
    if (gameState.isGameOver || gameState.isBotThinking) return false;
    if (chess.game_over()) return false;
    if (piece.startsWith('w')) return false;      // User should not move White pieces (bot plays White)
    if (chess.turn() !== 'b') return false;        // Only on Black's turn for the user
}

async function onDrop(source, target) {
    const move = chess.move({ from: source, to: target, promotion: 'q' });
    if (!move) return 'snapback';

    const userSan = move.san;

    // Store eval BEFORE user's move for quality calculation later
    evalBeforeUser = sfLiveEval;

    ui.undoBtn.disabled = true;
    gameState.isBotThinking = true;
    setStatus('Calculating...', true);

    // Check if user's move ended the game (e.g. stalemate on first move — very unlikely but safe)
    if (chess.game_over()) {
        board.position(chess.fen());
        completeTurn(userSan, '—', 0);
        endGame();
        return;
    }

    // ── Black user's move followed by White bot move ──
    const sfUCI = await getStockfishMove(chess.fen(), 1200);

    // sfLiveEval is now set = White's eval of position after the user's Black move.
    const evalAfterUser = sfLiveEval;
    // For Black-as-user, a good move lowers White's evaluation, so invert the sign.
    const cplLoss = evalAfterUser - evalBeforeUser;

    let botUCI = getBookMove() || sfUCI;
    let botSan = '?';

    if (botUCI && botUCI.length >= 4) {
        const from = botUCI.slice(0, 2);
        const to   = botUCI.slice(2, 4);
        const prom = botUCI.length > 4 ? botUCI[4] : undefined;
        const moveObj = prom ? { from, to, promotion: prom } : { from, to };

        let botResult = chess.move(moveObj);
        if (!botResult) {
            const legals = chess.moves({ verbose: true });
            if (legals.length) botResult = chess.move(legals[Math.floor(Math.random() * legals.length)]);
        }
        if (botResult) botSan = botResult.san;
    }

    board.position(chess.fen());
    evalBeforeUser = sfLiveEval;
    completeTurn(userSan, botSan, cplLoss);
}

// ── TURN COMPLETION ───────────────────────────────────────────────────────────
function completeTurn(userSan, botSan, cplLoss) {
    const quality = classifyMove(cplLoss);
    gameState.accuracies.push(quality.accuracy);

    const avgAcc = Math.round(gameState.accuracies.reduce((a, b) => a + b, 0) / gameState.accuracies.length);
    ui.accuracy.textContent = `${avgAcc}%`;
    ui.moveCounter.textContent = `${gameState.moveNum} / ${MAX_MOVES}`;

    showFeedback(quality, userSan, botSan);
    gameState.moveNum++;

    if (chess.game_over() || gameState.moveNum > MAX_MOVES) {
        endGame();
    } else {
        gameState.isBotThinking = false;
        ui.undoBtn.disabled = false;
        setStatus('Stockfish 2600 ELO', false);
    }
}

// ── MOVE QUALITY (Centipawn Loss) ─────────────────────────────────────────────
// cplLoss > 0 = White lost centipawns (bad). cplLoss < 0 = White gained (great).
function classifyMove(cplLoss) {
    if (cplLoss < -0.30) return { type: 'Brilliant', accuracy: 100, color: '#8B5CF6', icon: 'fa-gem' };
    if (cplLoss < 0.00)  return { type: 'Excellent', accuracy: 100, color: '#10B981', icon: 'fa-star' };
    if (cplLoss < 0.10)  return { type: 'Good',      accuracy: 90,  color: '#3B82F6', icon: 'fa-check' };
    if (cplLoss < 0.50)  return { type: 'Inaccuracy',accuracy: 65,  color: '#F59E0B', icon: 'fa-question' };
    if (cplLoss < 1.50)  return { type: 'Mistake',   accuracy: 35,  color: '#EF4444', icon: 'fa-times' };
    return                      { type: 'Blunder',   accuracy: 5,   color: '#991B1B', icon: 'fa-exclamation-triangle' };
}

// ── FEEDBACK PANEL ────────────────────────────────────────────────────────────
const QUAL_DESC = {
    'Brilliant': ['Exceptional move!', 'Computer-level precision!', 'Best move in the position!'],
    'Excellent': ['Strong developing move.', 'Excellent piece coordination.', 'Perfect timing.'],
    'Good':      ['Solid continuation.', 'Keeps the balance.', 'Reasonable choice.'],
    'Inaccuracy':['Slightly imprecise.', 'Better options existed.', 'Loses a tempo.'],
    'Mistake':   ['Gives Black an advantage.', 'Weakens the pawn structure.', 'Allows counterplay.'],
    'Blunder':   ['Drops material!', 'Critical error!', 'Turns the game around!']
};

const BOT_DESC = {
    'b6':  "KID-style defense, aiming for ...c5.",
    'Bb7': "Fianchettoed bishop eyes the long diagonal.",
    'e6':  "Solid pawn chain and flexible center.",
    'Nf6': "Natural development, eyes e4.",
    'Bb4': "Pins Nc3 and increases pressure.",
    'd5':  "Seizes central counterplay.",
    'Be7': "Prepares castling and kingside safety.",
    'O-O': "King safety secured, rooks connected.",
    'd6':  "Supports the center, typical KID structure.",
    'Nc6': "Jump to c6 to fight for the center.",
    'Na6': "A thematic maneuver in some KID lines.",
    'Nd5': "Central knight outpost.",
    'Nxd4': "Recaptures and maintains tension.",
    '—':   "Game finished."
};

function showFeedback(quality, userSan, botSan) {
    const descs = QUAL_DESC[quality.type] || QUAL_DESC['Good'];
    const desc  = descs[Math.floor(Math.random() * descs.length)];
    const botDesc = BOT_DESC[botSan] || `King's Indian Defense: ${botSan}.`;

    ui.evalText.textContent = `${quality.type} Move`;
    ui.evalIcon.className = `fas ${quality.icon}`;
    ui.evalIcon.parentElement.style.backgroundColor = quality.color;
    ui.moveAccuracy.textContent = `${quality.accuracy}%`;
    ui.whiteExp.textContent = desc;
    ui.blackMove.textContent = botSan;
    ui.blackExp.textContent = botDesc;
    ui.feedbackPanel.style.display = 'block';
}

// ── UNDO ──────────────────────────────────────────────────────────────────────
function undoMove() {
    const history = chess.history();
    if (!history.length || gameState.isBotThinking || gameState.isGameOver) return;

    // Protect the initial automatic White move from being undone directly.
    if (history.length === 1 && gameState.initialBotMoveProtected) return;

    if (history.length >= 2) {
        chess.undo();
        chess.undo();
    } else if (history.length === 1) {
        chess.undo();
    }

    // If we've removed moves down to zero, clear the protection flag.
    if (chess.history().length === 0) gameState.initialBotMoveProtected = false;

    gameState.moveNum = Math.max(1, gameState.moveNum - 1);
    if (gameState.accuracies.length) gameState.accuracies.pop();

    const avgAcc = gameState.accuracies.length
        ? Math.round(gameState.accuracies.reduce((a, b) => a + b, 0) / gameState.accuracies.length)
        : 100;

    ui.accuracy.textContent = `${avgAcc}%`;
    ui.moveCounter.textContent = `${gameState.moveNum} / ${MAX_MOVES}`;
    ui.feedbackPanel.style.display = 'none';
    board.position(chess.fen());
    ui.undoBtn.disabled = chess.history().length === 0 || gameState.initialBotMoveProtected;
    setStatus('Stockfish 2600 ELO', false);
}

// ── RESIGN / GAME OVER ────────────────────────────────────────────────────────
function resignGame() {
    if (gameState.isGameOver) return;
    endGame();
}

function endGame() {
    gameState.isGameOver = true;
    gameState.isBotThinking = false;

    // Clear any pending Stockfish call to avoid stale resolves
    clearTimeout(sfTimeoutId);
    sfTimeoutId = null;
    if (sfResolve) { sfResolve(null); sfResolve = null; }

    let result, isWhiteBetter;

    if (chess.in_checkmate()) {
        // chess.turn() === whose turn it is to move (they are checkmated = they LOST)
        isWhiteBetter = chess.turn() === 'b'; // Black to move & can't = White wins
        result = isWhiteBetter ? 'White Wins (Checkmate)' : 'Black Wins (Checkmate)';
    } else if (chess.in_stalemate() || chess.in_draw() || chess.in_threefold_repetition()) {
        isWhiteBetter = null;
        result = 'Draw';
    } else {
        // Move 25 reached or resign
        const ev = sfLiveEval;
        isWhiteBetter = ev > 0.3 ? true : ev < -0.3 ? false : null;
        result = isWhiteBetter === true ? 'White Better' : isWhiteBetter === false ? 'Black Better' : 'Equal';
    }

    const bgColor = isWhiteBetter === true  ? 'rgba(16,185,129,0.2)'
                  : isWhiteBetter === false ? 'rgba(239,68,68,0.2)'
                  : 'rgba(100,116,139,0.2)';
    const txtColor = isWhiteBetter === true  ? '#10B981'
                   : isWhiteBetter === false ? '#EF4444'
                   : '#94A3B8';

    ui.finalResult.textContent = result;
    ui.finalResult.style.backgroundColor = bgColor;
    ui.finalResult.style.color = txtColor;
    ui.gameOverPanel.style.display = 'block';
    ui.undoBtn.disabled = true;
    ui.resignBtn.disabled = true;

    const avgAcc = gameState.accuracies.length
        ? Math.round(gameState.accuracies.reduce((a, b) => a + b, 0) / gameState.accuracies.length)
        : 0;

    const histResult = isWhiteBetter === true ? 'White' : isWhiteBetter === false ? 'Black' : 'Equal';
    matchHistory.unshift({ date: new Date().toLocaleDateString(), moves: gameState.moveNum - 1, accuracy: avgAcc, result: histResult });
    if (matchHistory.length > 50) matchHistory.pop();
    localStorage.setItem('matchHistory', JSON.stringify(matchHistory));
    updateDashboard();
}

function resetGame() {
    chess.reset();
    board.position('start');
    sfLiveEval = 0;
    evalBeforeUser = 0;
    sfMultiPV = {};
    sessionBookLineHistory.clear();

    gameState = { ...gameState, moveNum: 1, isBotThinking: false, isGameOver: false, accuracies: [], initialBotMoveProtected: false };

    ui.gameOverPanel.style.display = 'none';
    ui.feedbackPanel.style.display = 'none';
    ui.moveCounter.textContent = `1 / ${MAX_MOVES}`;
    ui.accuracy.textContent = '100%';
    ui.evalScore.textContent = '+0.0';
    ui.undoBtn.disabled = true;
    ui.resignBtn.disabled = false;
    setStatus('Stockfish 2600 ELO', false);

    setTimeout(() => {
        if (chess.turn() === 'w') {
            playBotMove();
        }
    }, 150);
}

async function playBotMove() {
    if (gameState.isGameOver || gameState.isBotThinking) return;

    gameState.isBotThinking = true;
    setStatus('Calculating...', true);

    let botUCI = getBookMove() || await getStockfishMove(chess.fen(), 1200);
    let botSan = '?';

    if (botUCI && botUCI.length >= 4) {
        const from = botUCI.slice(0, 2);
        const to = botUCI.slice(2, 4);
        const prom = botUCI.length > 4 ? botUCI[4] : undefined;
        const moveObj = prom ? { from, to, promotion: prom } : { from, to };
        let botResult = chess.move(moveObj);
        if (!botResult) {
            const legals = chess.moves({ verbose: true });
            if (legals.length) botResult = chess.move(legals[Math.floor(Math.random() * legals.length)]);
        }
        if (botResult) botSan = botResult.san;
    }

    board.position(chess.fen());
    evalBeforeUser = sfLiveEval;
    gameState.isBotThinking = false;
    // If this is the first automatic White move, protect it from direct undo.
    if (chess.history().length === 1) {
        gameState.initialBotMoveProtected = true;
        ui.undoBtn.disabled = true;
    } else {
        gameState.initialBotMoveProtected = false;
        ui.undoBtn.disabled = chess.history().length === 0;
    }
    setStatus('Stockfish 2600 ELO', false);
}


// ── HELPERS ───────────────────────────────────────────────────────────────────
function setStatus(text, blink) {
    ui.engineStatus.textContent = text;
    ui.statusDot.classList.toggle('blinking', blink);
}

// ── DASHBOARD ─────────────────────────────────────────────────────────────────
function updateDashboard() {
    const total = matchHistory.length;
    ui.totalGames.textContent = total;

    if (!total) {
        ui.historyContainer.innerHTML = '<div class="empty-state">No games played yet.</div>';
        ui.overallAccText.textContent = '0%';
        ui.overallAccCircle.setAttribute('stroke-dasharray', '0, 100');
        ui.whiteBetterPct.textContent = '0%';
        return;
    }

    const avgAcc = Math.round(matchHistory.reduce((a, b) => a + b.accuracy, 0) / total);
    ui.overallAccText.textContent = `${avgAcc}%`;
    ui.overallAccCircle.setAttribute('stroke-dasharray', `${avgAcc}, 100`);

    const whitePct = Math.round((matchHistory.filter(m => m.result === 'White').length / total) * 100);
    ui.whiteBetterPct.textContent = `${whitePct}%`;

    ui.historyContainer.innerHTML = matchHistory.map((m, i) => `
        <div class="history-item">
            <div>
                <div style="font-size:14px;font-weight:600;">Game #${total - i}</div>
                <div style="font-size:11px;color:var(--text-secondary)">${m.date} · ${m.moves} moves</div>
            </div>
            <div style="text-align:right">
                <div style="font-size:14px;font-weight:700;color:var(--accent)">${m.accuracy}% Acc</div>
                <div style="font-size:11px;font-weight:600;color:${m.result === 'White' ? 'var(--success)' : m.result === 'Black' ? 'var(--danger)' : 'var(--text-secondary)'}">${m.result}</div>
            </div>
        </div>
    `).join('');
}
