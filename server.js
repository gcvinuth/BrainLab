const express = require('express');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Room Store: roomId -> RoomState
const rooms = new Map();
// Client Lookup: ws -> { playerId, roomId }
const clients = new Map();

// Helper: Generate memorable Room Codes
const PREFIXES = ['CYBER', 'BRAIN', 'HYPER', 'NEXUS', 'QUANTUM', 'NEO', 'PULSE', 'TITAN', 'VORTEX', 'SYNAPSE'];
function generateRoomCode() {
    let code = '';
    do {
        const prefix = PREFIXES[Math.floor(Math.random() * PREFIXES.length)];
        const num = Math.floor(100 + Math.random() * 900);
        code = `${prefix}-${num}`;
    } while (rooms.has(code));
    return code;
}

function broadcastToRoom(roomId, messageObj, excludeWs = null) {
    const room = rooms.get(roomId);
    if (!room) return;
    const msgStr = JSON.stringify(messageObj);
    room.players.forEach((player, pId) => {
        if (player.ws && player.ws.readyState === WebSocket.OPEN && player.ws !== excludeWs) {
            player.ws.send(msgStr);
        }
    });
}

function getSanitizedRoom(room) {
    if (!room) return null;
    const playerList = Array.from(room.players.values()).map(p => ({
        id: p.id,
        name: p.name,
        avatarColor: p.avatarColor || '#9d4edd',
        hat: p.hat || 'none',
        trail: p.trail || 'neon-purple',
        x: p.x || 0,
        y: p.y || 0,
        z: p.z || 0,
        rotation: p.rotation || 0,
        isMoving: p.isMoving || false,
        emote: p.emote || null,
        score: p.score || 0,
        streak: p.streak || 0,
        progress: p.progress || 0,
        accuracy: p.accuracy || 100,
        ready: !!p.ready,
        isHost: p.id === room.hostId
    }));

    return {
        id: room.id,
        name: room.name,
        hostId: room.hostId,
        status: room.status,
        gameMode: room.gameMode,
        roundTime: room.roundTime,
        maxPlayers: room.maxPlayers,
        seed: room.seed,
        players: playerList,
        chat: room.chat.slice(-30)
    };
}

wss.on('connection', (ws) => {
    let playerId = 'P-' + Math.random().toString(36).substring(2, 9);
    clients.set(ws, { playerId, roomId: null });

    // Send initial handshake
    ws.send(JSON.stringify({
        type: 'CONNECTED',
        playerId
    }));

    ws.on('message', (raw) => {
        try {
            const data = JSON.parse(raw.toString());
            const clientInfo = clients.get(ws);
            if (!clientInfo) return;

            switch (data.type) {
                // 1. Create a New Meta World Room
                case 'CREATE_ROOM': {
                    const code = (data.customCode || generateRoomCode()).toUpperCase().trim();
                    const playerName = (data.playerName || 'CyberAgent').trim();
                    
                    const newRoom = {
                        id: code,
                        name: data.roomName || `${playerName}'s Meta Realm`,
                        hostId: playerId,
                        status: 'lobby', // 'lobby' | 'in_meta_world' | 'in_game' | 'podium'
                        gameMode: data.gameMode || 'math',
                        roundTime: Number(data.roundTime) || 30,
                        maxPlayers: Number(data.maxPlayers) || 12,
                        seed: Math.floor(Math.random() * 1000000),
                        players: new Map(),
                        chat: []
                    };

                    const hostPlayer = {
                        id: playerId,
                        ws: ws,
                        name: playerName,
                        avatarColor: data.avatarColor || '#9d4edd',
                        hat: data.hat || 'visor',
                        trail: data.trail || 'neon-cyan',
                        x: 0,
                        y: 0,
                        z: 0,
                        rotation: 0,
                        isMoving: false,
                        emote: null,
                        score: 0,
                        streak: 0,
                        progress: 0,
                        accuracy: 100,
                        ready: true
                    };

                    newRoom.players.set(playerId, hostPlayer);
                    rooms.set(code, newRoom);
                    clientInfo.roomId = code;

                    ws.send(JSON.stringify({
                        type: 'ROOM_CREATED',
                        room: getSanitizedRoom(newRoom),
                        playerId
                    }));
                    break;
                }

                // 2. Join Existing Room by Code
                case 'JOIN_ROOM': {
                    const code = (data.roomCode || '').toUpperCase().trim();
                    const room = rooms.get(code);

                    if (!room) {
                        ws.send(JSON.stringify({
                            type: 'ERROR',
                            message: `Room "${code}" not found! Check the code or create a new room.`
                        }));
                        return;
                    }

                    if (room.players.size >= room.maxPlayers) {
                        ws.send(JSON.stringify({
                            type: 'ERROR',
                            message: `Room "${code}" is full (Max ${room.maxPlayers} players)!`
                        }));
                        return;
                    }

                    // Leave old room if any
                    if (clientInfo.roomId && clientInfo.roomId !== code) {
                        handleLeaveRoom(ws);
                    }

                    const playerName = (data.playerName || 'Explorer_' + Math.floor(Math.random() * 100)).trim();
                    const newPlayer = {
                        id: playerId,
                        ws: ws,
                        name: playerName,
                        avatarColor: data.avatarColor || '#00f5d4',
                        hat: data.hat || 'none',
                        trail: data.trail || 'neon-pink',
                        x: (Math.random() - 0.5) * 6,
                        y: 0,
                        z: (Math.random() - 0.5) * 6,
                        rotation: 0,
                        isMoving: false,
                        emote: null,
                        score: 0,
                        streak: 0,
                        progress: 0,
                        accuracy: 100,
                        ready: false
                    };

                    room.players.set(playerId, newPlayer);
                    clientInfo.roomId = code;

                    // Notify joining player
                    ws.send(JSON.stringify({
                        type: 'ROOM_JOINED',
                        room: getSanitizedRoom(room),
                        playerId
                    }));

                    // Broadcast to others in room
                    broadcastToRoom(code, {
                        type: 'PLAYER_JOINED',
                        player: {
                            id: newPlayer.id,
                            name: newPlayer.name,
                            avatarColor: newPlayer.avatarColor,
                            hat: newPlayer.hat,
                            trail: newPlayer.trail,
                            x: newPlayer.x,
                            y: newPlayer.y,
                            z: newPlayer.z,
                            ready: newPlayer.ready,
                            isHost: false
                        },
                        room: getSanitizedRoom(room)
                    }, ws);

                    break;
                }

                // 3. Update Meta World 3D Avatar Movement
                case 'PLAYER_MOVE': {
                    const room = rooms.get(clientInfo.roomId);
                    if (!room) return;
                    const player = room.players.get(playerId);
                    if (!player) return;

                    player.x = data.x;
                    player.y = data.y;
                    player.z = data.z;
                    player.rotation = data.rotation;
                    player.isMoving = data.isMoving;

                    // Fast broadcast position delta to other peers
                    broadcastToRoom(room.id, {
                        type: 'PLAYER_MOVED',
                        id: playerId,
                        x: data.x,
                        y: data.y,
                        z: data.z,
                        rotation: data.rotation,
                        isMoving: data.isMoving
                    }, ws);
                    break;
                }

                // 4. Send Emote in Meta World
                case 'PLAYER_EMOTE': {
                    const room = rooms.get(clientInfo.roomId);
                    if (!room) return;
                    const player = room.players.get(playerId);
                    if (player) {
                        player.emote = data.emote;
                    }
                    broadcastToRoom(room.id, {
                        type: 'PLAYER_EMOTED',
                        id: playerId,
                        emote: data.emote
                    });
                    break;
                }

                // 5. In-World Spatial & Lobby Chat
                case 'SEND_CHAT': {
                    const room = rooms.get(clientInfo.roomId);
                    if (!room) return;
                    const player = room.players.get(playerId);
                    const chatEntry = {
                        id: 'msg-' + Date.now(),
                        senderId: playerId,
                        senderName: player ? player.name : 'Unknown',
                        text: (data.text || '').slice(0, 140),
                        timestamp: Date.now()
                    };
                    room.chat.push(chatEntry);
                    broadcastToRoom(room.id, {
                        type: 'NEW_CHAT',
                        chat: chatEntry
                    });
                    break;
                }

                // 6. Toggle Ready Status
                case 'TOGGLE_READY': {
                    const room = rooms.get(clientInfo.roomId);
                    if (!room) return;
                    const player = room.players.get(playerId);
                    if (!player) return;
                    player.ready = !player.ready;
                    broadcastToRoom(room.id, {
                        type: 'PLAYER_READY_CHANGED',
                        id: playerId,
                        ready: player.ready,
                        room: getSanitizedRoom(room)
                    });
                    break;
                }

                // 7. Update Room Match Settings (Host only)
                case 'UPDATE_ROOM_SETTINGS': {
                    const room = rooms.get(clientInfo.roomId);
                    if (!room || room.hostId !== playerId) return;
                    if (data.gameMode) room.gameMode = data.gameMode;
                    if (data.roundTime) room.roundTime = Number(data.roundTime);
                    broadcastToRoom(room.id, {
                        type: 'ROOM_SETTINGS_UPDATED',
                        gameMode: room.gameMode,
                        roundTime: room.roundTime,
                        room: getSanitizedRoom(room)
                    });
                    break;
                }

                // 8. Start Game Countdown (Host only)
                case 'START_MATCH': {
                    const room = rooms.get(clientInfo.roomId);
                    if (!room || room.hostId !== playerId) return;

                    room.status = 'in_game';
                    room.seed = Math.floor(Math.random() * 1000000); // Fresh deterministic seed
                    // Reset all scores
                    room.players.forEach(p => {
                        p.score = 0;
                        p.streak = 0;
                        p.progress = 0;
                        p.accuracy = 100;
                    });

                    broadcastToRoom(room.id, {
                        type: 'MATCH_COUNTDOWN_STARTED',
                        countdownSeconds: 3,
                        gameMode: room.gameMode,
                        roundTime: room.roundTime,
                        seed: room.seed,
                        room: getSanitizedRoom(room)
                    });
                    break;
                }

                // 9. Live In-Game Score / Progress Tick
                case 'SCORE_UPDATE': {
                    const room = rooms.get(clientInfo.roomId);
                    if (!room) return;
                    const player = room.players.get(playerId);
                    if (!player) return;

                    player.score = Number(data.score) || 0;
                    player.streak = Number(data.streak) || 0;
                    player.progress = Number(data.progress) || 0;
                    player.accuracy = Number(data.accuracy) || 100;

                    broadcastToRoom(room.id, {
                        type: 'LIVE_SCORE_UPDATE',
                        playerId,
                        score: player.score,
                        streak: player.streak,
                        progress: player.progress,
                        accuracy: player.accuracy,
                        leaderboard: Array.from(room.players.values()).map(p => ({
                            id: p.id,
                            name: p.name,
                            avatarColor: p.avatarColor,
                            score: p.score,
                            streak: p.streak,
                            progress: p.progress,
                            accuracy: p.accuracy
                        })).sort((a, b) => b.score - a.score)
                    });
                    break;
                }

                // 10. Match Finished -> Transition to Podium
                case 'MATCH_END': {
                    const room = rooms.get(clientInfo.roomId);
                    if (!room) return;
                    room.status = 'podium';

                    const finalRankings = Array.from(room.players.values()).map(p => ({
                        id: p.id,
                        name: p.name,
                        avatarColor: p.avatarColor,
                        hat: p.hat,
                        score: p.score,
                        streak: p.streak,
                        accuracy: p.accuracy
                    })).sort((a, b) => b.score - a.score);

                    broadcastToRoom(room.id, {
                        type: 'PODIUM_SHOW',
                        rankings: finalRankings,
                        winner: finalRankings[0] || null,
                        room: getSanitizedRoom(room)
                    });
                    break;
                }

                // 11. Return to Meta World / Rematch
                case 'RETURN_TO_META_WORLD': {
                    const room = rooms.get(clientInfo.roomId);
                    if (!room) return;
                    room.status = 'in_meta_world';
                    broadcastToRoom(room.id, {
                        type: 'RETURNED_TO_META_WORLD',
                        room: getSanitizedRoom(room)
                    });
                    break;
                }

                // 12. Request Public Rooms List
                case 'GET_PUBLIC_ROOMS': {
                    const publicList = [];
                    rooms.forEach(r => {
                        publicList.push({
                            id: r.id,
                            name: r.name,
                            playerCount: r.players.size,
                            maxPlayers: r.maxPlayers,
                            gameMode: r.gameMode,
                            status: r.status
                        });
                    });
                    ws.send(JSON.stringify({
                        type: 'PUBLIC_ROOMS_LIST',
                        rooms: publicList
                    }));
                    break;
                }
            }
        } catch (err) {
            console.error('WS Error:', err);
        }
    });

    ws.on('close', () => {
        handleLeaveRoom(ws);
        clients.delete(ws);
    });
});

function handleLeaveRoom(ws) {
    const clientInfo = clients.get(ws);
    if (!clientInfo || !clientInfo.roomId) return;

    const { playerId, roomId } = clientInfo;
    const room = rooms.get(roomId);
    if (!room) return;

    room.players.delete(playerId);
    clientInfo.roomId = null;

    if (room.players.size === 0) {
        // Delete empty room
        rooms.delete(roomId);
        console.log(`[Room Cleaned] ${roomId}`);
    } else {
        // If host left, assign new host
        if (room.hostId === playerId) {
            const nextHostId = room.players.keys().next().value;
            room.hostId = nextHostId;
        }

        broadcastToRoom(roomId, {
            type: 'PLAYER_LEFT',
            playerId,
            newHostId: room.hostId,
            room: getSanitizedRoom(room)
        });
    }
}

// REST API endpoint for quick room info & health check
app.get('/api/status', (req, res) => {
    res.json({
        online: true,
        activeRooms: rooms.size,
        totalPlayers: clients.size,
        serverTime: Date.now()
    });
});

server.listen(PORT, () => {
    console.log(`🚀 BrainLabs Meta World Server running at http://localhost:${PORT}`);
    console.log(`🌐 WebSocket Server live on ws://localhost:${PORT}`);
});
