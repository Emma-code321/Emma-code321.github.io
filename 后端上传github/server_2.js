const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// 存储房间和游戏状态
const rooms = {};

// ---------- 辅助函数 ----------
function createDeck() {
    const ranks = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
    const suits = ['♠','♥','♦','♣'];
    const deck = [];
    for (const suit of suits) {
        for (const rank of ranks) {
            deck.push({ rank, suit });
        }
    }
    return deck.sort(() => Math.random() - 0.5);
}

// 牌点转换
function rankToValue(rank) {
    const map = { 'A':14, 'K':13, 'Q':12, 'J':11, '10':10, '9':9, '8':8, '7':7, '6':6, '5':5, '4':4, '3':3, '2':2 };
    return map[rank];
}

// 评估最佳牌型 (返回 { type, compare })
function evaluateHand(cards) {
    const hand = cards.map(c => ({ ...c, value: rankToValue(c.rank) }));
    hand.sort((a, b) => b.value - a.value);

    const isFlush = () => hand.every(c => c.suit === hand[0].suit);

    const isStraight = (cards) => {
        let values = [...new Set(cards.map(c => c.value))].sort((a, b) => b - a);
        for (let i = 0; i <= values.length - 5; i++) {
            if (values[i] - values[i+4] === 4) return values[i];
        }
        // 特殊 A-5-4-3-2
        if (values.includes(14) && values.includes(5) && values.includes(4) && values.includes(3) && values.includes(2))
            return 5;
        return null;
    };

    const countByValue = {};
    hand.forEach(c => { countByValue[c.value] = (countByValue[c.value] || 0) + 1; });

    const flush = isFlush();
    const straight = isStraight(hand);

    // 皇家同花顺
    if (flush && straight === 14) return { type: 1, compare: [14] };
    // 同花顺
    if (flush && straight) return { type: 2, compare: [straight] };

    // 四条
    const four = Object.entries(countByValue).find(([_, count]) => count === 4);
    if (four) {
        const fourVal = parseInt(four[0]);
        const kicker = hand.find(c => c.value !== fourVal).value;
        return { type: 3, compare: [fourVal, kicker] };
    }

    const three = Object.entries(countByValue).find(([_, count]) => count === 3);
    const pairs = Object.entries(countByValue).filter(([_, count]) => count === 2).map(([v]) => parseInt(v)).sort((a,b) => b - a);

    // 葫芦
    if (three && pairs.length >= 1) {
        return { type: 4, compare: [parseInt(three[0]), pairs[0]] };
    }

    // 同花
    if (flush) {
        return { type: 5, compare: hand.slice(0,5).map(c => c.value) };
    }

    // 顺子
    if (straight) {
        return { type: 6, compare: [straight] };
    }

    // 三条
    if (three) {
        const threeVal = parseInt(three[0]);
        const kickers = hand.filter(c => c.value !== threeVal).map(c => c.value).sort((a,b) => b - a).slice(0,2);
        return { type: 7, compare: [threeVal, ...kickers] };
    }

    // 两对
    if (pairs.length >= 2) {
        const highPair = pairs[0];
        const lowPair = pairs[1];
        const kicker = hand.find(c => c.value !== highPair && c.value !== lowPair).value;
        return { type: 8, compare: [highPair, lowPair, kicker] };
    }

    // 一对
    if (pairs.length === 1) {
        const pairVal = pairs[0];
        const kickers = hand.filter(c => c.value !== pairVal).map(c => c.value).sort((a,b) => b - a).slice(0,3);
        return { type: 9, compare: [pairVal, ...kickers] };
    }

    // 高牌
    return { type: 10, compare: hand.slice(0,5).map(c => c.value) };
}

function compareHands(hand1, hand2) {
    const r1 = evaluateHand(hand1);
    const r2 = evaluateHand(hand2);
    if (r1.type < r2.type) return 1;
    if (r1.type > r2.type) return 2;
    for (let i = 0; i < r1.compare.length; i++) {
        if (r1.compare[i] > r2.compare[i]) return 1;
        if (r1.compare[i] < r2.compare[i]) return 2;
    }
    return 0;
}

// ---------- 房间初始化 ----------
function initRoom(roomId) {
    rooms[roomId] = {
        players: {
            1: { id: null, chips: 1000, cards: [], folded: false, currentBet: 0 },
            2: { id: null, chips: 1000, cards: [], folded: false, currentBet: 0 }
        },
        deck: [],
        communityCards: [],
        pot: 0,
        currentPlayer: 1,
        round: 'pre-flop',
        gameStarted: false,
        winner: null
    };
}

// ---------- 广播状态 ----------
function broadcastState(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    const p1 = room.players[1];
    const p2 = room.players[2];

    // 发给玩家1
    io.to(p1.id).emit('gameState', {
        yourCards: p1.cards,
        opponentCards: (!room.gameStarted || p2.folded || room.round === 'showdown') ? p2.cards : [],
        communityCards: room.communityCards,
        pot: room.pot,
        currentPlayer: room.currentPlayer,
        round: room.round,
        yourChips: p1.chips,
        opponentChips: p2.chips,
        yourBet: p1.currentBet,
        opponentBet: p2.currentBet,
        gameStarted: room.gameStarted,
        winner: room.winner
    });

    // 发给玩家2
    io.to(p2.id).emit('gameState', {
        yourCards: p2.cards,
        opponentCards: (!room.gameStarted || p1.folded || room.round === 'showdown') ? p1.cards : [],
        communityCards: room.communityCards,
        pot: room.pot,
        currentPlayer: room.currentPlayer,
        round: room.round,
        yourChips: p2.chips,
        opponentChips: p1.chips,
        yourBet: p2.currentBet,
        opponentBet: p1.currentBet,
        gameStarted: room.gameStarted,
        winner: room.winner
    });
}

// ---------- 游戏流程 ----------
function startGame(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    room.deck = createDeck();
    room.players[1].cards = [room.deck.pop(), room.deck.pop()];
    room.players[2].cards = [room.deck.pop(), room.deck.pop()];
    room.communityCards = [];
    room.pot = 0;
    room.currentPlayer = 1;
    room.round = 'pre-flop';
    room.gameStarted = true;
    room.players[1].folded = false;
    room.players[2].folded = false;
    room.players[1].currentBet = 0;
    room.players[2].currentBet = 0;
    room.winner = null;

    broadcastState(roomId);
}

function nextTurn(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    // 检查是否有玩家弃牌
    if (room.players[1].folded || room.players[2].folded) {
        return;
    }

    // 如果双方下注相等，进入下一轮
    if (room.players[1].currentBet === room.players[2].currentBet) {
        proceedToNextRound(roomId);
        return;
    }

    // 否则切换玩家
    room.currentPlayer = room.currentPlayer === 1 ? 2 : 1;
    broadcastState(roomId);
}

function proceedToNextRound(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    // 重置 currentBet
    room.players[1].currentBet = 0;
    room.players[2].currentBet = 0;

    // 发牌
    switch (room.round) {
        case 'pre-flop':
            room.communityCards.push(room.deck.pop(), room.deck.pop(), room.deck.pop());
            room.round = 'flop';
            break;
        case 'flop':
            room.communityCards.push(room.deck.pop());
            room.round = 'turn';
            break;
        case 'turn':
            room.communityCards.push(room.deck.pop());
            room.round = 'river';
            break;
        case 'river':
            // 摊牌
            const winner = compareHands(
                [...room.players[1].cards, ...room.communityCards],
                [...room.players[2].cards, ...room.communityCards]
            );
            room.winner = winner;
            if (winner === 1) {
                room.players[1].chips += room.pot;
            } else if (winner === 2) {
                room.players[2].chips += room.pot;
            } else {
                room.players[1].chips += Math.floor(room.pot / 2);
                room.players[2].chips += Math.ceil(room.pot / 2);
            }
            room.pot = 0;
            room.gameStarted = false;
            room.round = 'showdown';
            broadcastState(roomId);
            return;
    }

    room.currentPlayer = 1;
    broadcastState(roomId);
}

// ---------- Socket 连接处理 ----------
io.on('connection', (socket) => {
    console.log('用户连接:', socket.id);

    socket.on('joinRoom', (roomId) => {
        if (!rooms[roomId]) initRoom(roomId);
        const room = rooms[roomId];

        let playerNum = null;
        if (!room.players[1].id) {
            playerNum = 1;
            room.players[1].id = socket.id;
        } else if (!room.players[2].id) {
            playerNum = 2;
            room.players[2].id = socket.id;
        } else {
            socket.emit('error', '房间已满');
            return;
        }

        socket.join(roomId);
        socket.emit('assigned', { playerNum, roomId });
        io.to(roomId).emit('playerCount', Object.values(room.players).filter(p => p.id).length);

        // 两人到齐自动开始
        if (room.players[1].id && room.players[2].id) {
            startGame(roomId);
        }
    });

    socket.on('action', (data) => {
        const { roomId, action, amount } = data;
        const room = rooms[roomId];
        if (!room) return;

        let playerNum = null;
        if (room.players[1].id === socket.id) playerNum = 1;
        else if (room.players[2].id === socket.id) playerNum = 2;
        else return;

        if (room.currentPlayer !== playerNum) {
            socket.emit('error', '还没轮到你');
            return;
        }

        switch (action) {
            case 'fold':
                room.players[playerNum].folded = true;
                const winner = playerNum === 1 ? 2 : 1;
                room.players[winner].chips += room.pot; // 底池已包含所有下注
                room.pot = 0;
                room.gameStarted = false;
                room.round = 'showdown';
                room.winner = winner;
                broadcastState(roomId);
                break;

            case 'check':
                if (room.players[1].currentBet !== room.players[2].currentBet) {
                    socket.emit('error', '不能过牌，请下注');
                    return;
                }
                nextTurn(roomId);
                break;

            case 'bet':
                let betAmount = parseInt(amount);
                if (isNaN(betAmount) || betAmount <= 0) return;
                betAmount = Math.min(betAmount, room.players[playerNum].chips);

                const opponentNum = playerNum === 1 ? 2 : 1;
                const opponent = room.players[opponentNum];
                const needed = opponent.currentBet - room.players[playerNum].currentBet;
                // 禁止下注少于所需跟注额（除非全押）
                if (betAmount < needed && betAmount !== room.players[playerNum].chips) {
                    socket.emit('error', `需要至少下注 ${needed} 才能跟注`);
                    return;
                }

                // 限制加注超过对手可跟注范围（简化处理，避免边池）
                const newCurrentBet = room.players[playerNum].currentBet + betAmount;
                const maxAllowed = opponent.currentBet + opponent.chips;
                if (newCurrentBet > maxAllowed && !opponent.folded) {
                    socket.emit('error', '下注额超过对手可跟注范围');
                    return;
                }

                room.players[playerNum].chips -= betAmount;
                room.players[playerNum].currentBet += betAmount;
                room.pot += betAmount; // 实时增加底池

                nextTurn(roomId);
                break;
        }
    });

    socket.on('disconnect', () => {
        for (const roomId in rooms) {
            const room = rooms[roomId];
            if (room.players[1].id === socket.id) {
                room.players[1].id = null;
                io.to(roomId).emit('playerLeft', 1);
                break;
            } else if (room.players[2].id === socket.id) {
                room.players[2].id = null;
                io.to(roomId).emit('playerLeft', 2);
                break;
            }
        }
    });
});

server.listen(3000, () => {
    console.log('服务器运行在 http://localhost:3000');
});