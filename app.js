// app.js — Owen's Defense Trainer
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

// Evaluation tracking (always in White's perspective, in pawns)
let sfLiveEval = 0;         // Updated live during Stockfish analysis
let evalBeforeUser = 0;     // Snapshot taken just before the user makes a move

let gameState = {
    moveNum: 1,             // White's move number
    isBotThinking: false,
    isGameOver: false,
    accuracies: []
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

    // Stockfish is called when it's Black's turn → score is from Black's perspective.
    // Negate to get White's perspective for display.
    if (idx === 1) {
        const whiteScore = -score;
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

// ── OWEN'S DEFENSE OPENING BOOK ───────────────────────────────────────────────
// 50+ accessible Owen's Defense variations for Black.
// Each line is a UCI half-move sequence.
// Matching requires the book line to follow the full move history exactly.
const OWENS_LINES = [
    // === vs 1.e4 ===
    ['e2e4','b7b6','d2d4','c8b7','b1c3','e7e6','g1f3','f8b4'],
    ['e2e4','b7b6','d2d4','c8b7','b1c3','e7e6','g1f3','g8f6'],
    ['e2e4','b7b6','d2d4','c8b7','b1c3','e7e6','f1d3','g8f6','g1f3','d7d5'],
    ['e2e4','b7b6','d2d4','c8b7','b1c3','g8f6','e4e5','f6d5','g1f3','e7e6'],
    ['e2e4','b7b6','d2d4','c8b7','f2f3','e7e6','b1c3','g8f6'],
    ['e2e4','b7b6','b1c3','c8b7','d2d4','e7e6','g1f3','g8f6'],
    ['e2e4','b7b6','g1f3','c8b7','b1c3','e7e6','d2d4','g8f6'],
    ['e2e4','b7b6','d2d3','c8b7','g2g3','e7e6','f1g2','d7d5'],
    ['e2e4','b7b6','d2d4','c8b7','c1e3','e7e6','b1c3','f8b4'],
    ['e2e4','b7b6','d2d4','c8b7','g1f3','e7e6','b1d2','g8f6'],
    ['e2e4','b7b6','d2d4','c8b7','b1c3','e7e6','g1f3','e7e6','f1d3','g8f6'],
    ['e2e4','b7b6','d2d4','c8b7','b1c3','e7e6','g1f3','f8b4'],
    ['e2e4','b7b6','d2d4','c8b7','b1c3','e7e6','f1e2','g8f6'],
    ['e2e4','b7b6','b1c3','c8b7','f2f3','e7e6','d2d4','g8f6'],
    ['e2e4','b7b6','g1f3','c8b7','b1c3','e7e6','d2d4','f8b4'],
    ['e2e4','b7b6','d2d4','c8b7','g1f3','e7e6','b1c3','d7d5'],
    ['e2e4','b7b6','d2d4','c8b7','g1f3','e7e6','b1c3','g8f6','f1d3','f8b4'],
    ['e2e4','b7b6','d2d4','c8b7','c1e3','g7g6','b1c3','e7e6'],
    ['e2e4','b7b6','d2d4','c8b7','f1d3','e7e6','b1c3','g8f6'],
    ['e2e4','b7b6','d2d4','c8b7','g1f3','e7e6','b1c3','b8c6'],
    ['e2e4','b7b6','d2d4','c8b7','b1c3','g8f6','g1f3','d7d5'],
    ['e2e4','b7b6','d2d4','c8b7','f2f3','g7g6','b1c3','e7e6'],
    ['e2e4','b7b6','d2d4','c8b7','b1c3','e7e6','g1f3','f8g7'],
    ['e2e4','b7b6','d2d4','c8b7','f1e2','e7e6','g1f3','g8f6'],
    ['e2e4','b7b6','d2d4','c8b7','b1c3','e7e6','f1d3','g8f6'],
    ['e2e4','b7b6','d2d4','c8b7','g1f3','e7e6','b1c3','e7e6','d2d4','g8f6'],
    ['d2d4','b7b6','e2e4','c8b7','b1c3','e7e6','g1f3','g8f6'],
    ['d2d4','b7b6','e2e4','c8b7','b1c3','g8f6','e4e5','f6d5'],
    ['d2d4','b7b6','c2c4','c8b7','b1c3','e7e6','g1f3','g8f6'],
    ['d2d4','b7b6','g1f3','c8b7','e2e4','e7e6','b1c3','g8f6'],
    ['d2d4','b7b6','g1f3','c8b7','e2e3','e7e6','f1d3','d7d5'],
    ['d2d4','b7b6','c2c4','c8b7','g1f3','e7e6','b1c3','g8f6'],
    ['d2d4','b7b6','c2c4','c8b7','e2e3','e7e6','g1f3','f8b4'],
    ['d2d4','b7b6','c2c4','c8b7','d2d4','g8f6','g1f3','e7e6'],
    ['d2d4','b7b6','g1f3','c8b7','d2d4','e7e6','b1c3','g8f6'],
    ['d2d4','b7b6','g1f3','c8b7','b1c3','e7e6','e2e4','g8f6'],
    ['d2d4','b7b6','g1f3','c8b7','f2f3','e7e6','b1c3','g8f6'],
    ['c2c4','b7b6','g1f3','c8b7','b1c3','e7e6','d2d4','g8f6'],
    ['c2c4','b7b6','g1f3','c8b7','d2d4','e7e6','b1c3','g8f6'],
    ['c2c4','b7b6','g1f3','c8b7','d2d4','g7g6','b1c3','e7e6'],
    ['c2c4','b7b6','g1f3','c8b7','d2d4','e7e6','g2g3','g8f6'],
    ['g1f3','b7b6','d2d4','c8b7','e2e4','e7e6','b1c3','g8f6'],
    ['g1f3','b7b6','d2d4','c8b7','g2g3','e7e6','b1c3','g8f6'],
    ['g1f3','b7b6','c2c4','c8b7','g2g3','e7e6','b1c3','g8f6'],
    ['g2g3','b7b6','f1g2','c8b7','d2d4','e7e6','g1f3','g8f6'],
    ['g2g3','b7b6','f1g2','c8b7','c2c4','e7e6','d2d4','g8f6'],
    ['g2g3','b7b6','f1g2','c8b7','d2d4','e7e6','b1c3','g8f6'],
    ['g2g3','b7b6','f1g2','c8b7','d2d4','e7e6','g1f3','g8f6'],
    ['g2g3','b7b6','c8b7','d2d4','e7e6','g1f3','f8g7'],
    ['g2g3','b7b6','c8b7','d2d4','e7e6','b1c3','g8f6'],
    ['g2g3','b7b6','c8b7','d2d4','e7e6','c1e3','g8f6'],
    ['g2g3','b7b6','c8b7','d2d4','e7e6','f1d3','g8f6'],
    ['g2g3','b7b6','c8b7','d2d4','e7e6','g1f3','f8b4'],
];

const OWENS_LINE_PRIORITY = {
    // Top theory lines for Owen's Defense
    'e2e4|b7b6|d2d4|c8b7|b1c3|e7e6|g1f3|g8f6': 10,
    'e2e4|b7b6|d2d4|c8b7|b1c3|e7e6|g1f3|f8b4': 12,
    'e2e4|b7b6|d2d4|c8b7|b1c3|g8f6|e4e5|f6d5': 14,
    'e2e4|b7b6|d2d4|c8b7|g1f3|e7e6|b1c3|g8f6': 16,
    'e2e4|b7b6|d2d4|c8b7|g1f3|e7e6|b1c3|f8b4': 18,
    'e2e4|b7b6|d2d4|c8b7|b1c3|e7e6|f1d3|g8f6': 20,
    'e2e4|b7b6|d2d4|c8b7|g1f3|e7e6|b1c3|e7e6': 22,
    'd2d4|b7b6|g1f3|c8b7|e2e4|e7e6|b1c3|g8f6': 24,
    'd2d4|b7b6|g1f3|c8b7|e2e4|e7e6|g1f3|f8g7': 26,
    'c2c4|b7b6|g1f3|c8b7|d2d4|e7e6|b1c3|g8f6': 28,
    'g2g3|b7b6|f1g2|c8b7|d2d4|e7e6|g1f3|g8f6': 30,
    'g2g3|b7b6|f1g2|c8b7|d2d4|e7e6|b1c3|g8f6': 32,
    'g2g3|b7b6|c8b7|d2d4|e7e6|g1f3|f8g7': 34,
    'e2e4|b7b6|d2d4|c8b7|c1e3|e7e6|b1c3|f8b4': 36,
    'e2e4|b7b6|d2d4|c8b7|f2f3|e7e6|b1c3|g8f6': 38,
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

    const candidates = OWENS_LINES.map(line => {
        const hash = line.join('|');
        const used = recentBookLines.filter(item => item === hash).length;
        const priority = OWENS_LINE_PRIORITY[hash] ?? 100;
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
    if (piece.startsWith('b')) return false;      // No black pieces
    if (chess.turn() !== 'w') return false;        // Only on White's turn
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

    if (gameState.moveNum === 1) {
        // ── Move 1: Always force b6 (Owen's Defense signature) ──
        const b6Result = chess.move('b6');
        board.position(chess.fen());
        // First move is always classified as Good (no prior eval to compare)
        completeTurn(userSan, b6Result ? b6Result.san : 'b6', 0);

    } else {
        // ── Moves 2+: Stockfish analysis ──
        // Run Stockfish on position AFTER user's move (Black to move).
        // This gives us: eval after user's move AND bot's candidate moves.
        const sfUCI = await getStockfishMove(chess.fen(), 1200);

        // sfLiveEval is now set = White's eval of position AFTER user's move
        const evalAfterUser = sfLiveEval;
        // CPL loss for White (positive = White lost centipawns = bad move)
        const cplLoss = evalBeforeUser - evalAfterUser;

        // Determine bot's move: opening book first, then Stockfish
        let botUCI = getBookMove() || sfUCI;
        let botSan = '?';

        if (botUCI && botUCI.length >= 4) {
            const from = botUCI.slice(0, 2);
            const to   = botUCI.slice(2, 4);
            const prom = botUCI.length > 4 ? botUCI[4] : undefined;
            const moveObj = prom ? { from, to, promotion: prom } : { from, to };

            let botResult = chess.move(moveObj);
            if (!botResult) {
                // Move rejected (shouldn't happen with book check) — play random
                const legals = chess.moves({ verbose: true });
                if (legals.length) botResult = chess.move(legals[Math.floor(Math.random() * legals.length)]);
            }
            if (botResult) botSan = botResult.san;
        }

        board.position(chess.fen());

        // Update evalBeforeUser for next round.
        // After bot plays best Black move, eval ≈ sfLiveEval (set before bot moved).
        evalBeforeUser = sfLiveEval;

        completeTurn(userSan, botSan, cplLoss);
    }
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
    'b6':  "Owen's Defense — controls c5.",
    'Bb7': "Fianchettoed bishop activates.",
    'e6':  "Solid pawn structure, opens Bb7.",
    'Nf6': "Develops and attacks the center.",
    'Bb4': "Pins Nc3, adds pressure.",
    'd5':  "Central counterattack!",
    'Be7': "Safe square, prepares castling.",
    'O-O': "King safety, connects rooks.",
    'd6':  "Supports center, flexible.",
    'Nc6': "Fights for the center.",
    'Na6': "Unusual but valid development.",
    'Nd5': "Central domination.",
    'Nxd4':'Recaptures, equalises.",',
    '—':   "Game finished."
};

function showFeedback(quality, userSan, botSan) {
    const descs = QUAL_DESC[quality.type] || QUAL_DESC['Good'];
    const desc  = descs[Math.floor(Math.random() * descs.length)];
    const botDesc = BOT_DESC[botSan] || `Owen's Defense: ${botSan}.`;

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
    if (gameState.moveNum <= 1 || gameState.isBotThinking || gameState.isGameOver) return;

    if (chess.turn() === 'w') {
        chess.undo(); // Undo Black's last move
        chess.undo(); // Undo White's last move
    } else {
        chess.undo(); // Desync state: only undo White's move
    }

    gameState.moveNum = Math.max(1, gameState.moveNum - 1);
    if (gameState.accuracies.length) gameState.accuracies.pop();

    const avgAcc = gameState.accuracies.length
        ? Math.round(gameState.accuracies.reduce((a, b) => a + b, 0) / gameState.accuracies.length)
        : 100;

    ui.accuracy.textContent = `${avgAcc}%`;
    ui.moveCounter.textContent = `${gameState.moveNum} / ${MAX_MOVES}`;
    ui.feedbackPanel.style.display = 'none';
    board.position(chess.fen());
    ui.undoBtn.disabled = gameState.moveNum <= 1;
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

    gameState = { ...gameState, moveNum: 1, isBotThinking: false, isGameOver: false, accuracies: [] };

    ui.gameOverPanel.style.display = 'none';
    ui.feedbackPanel.style.display = 'none';
    ui.moveCounter.textContent = `1 / ${MAX_MOVES}`;
    ui.accuracy.textContent = '100%';
    ui.evalScore.textContent = '+0.0';
    ui.undoBtn.disabled = true;
    ui.resignBtn.disabled = false;
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
