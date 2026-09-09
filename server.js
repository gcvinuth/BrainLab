/**
 * Zero-Dependency Pure Node.js WebSocket & Static HTTP Server
 * Requires ZERO npm install / NO node_modules folder!
 * Works directly with: node server.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;

// Room Store: roomId -> RoomState
const rooms = new Map();
// Client Lookup: socket -> { playerId, roomId }
const clients = new Map();

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

function broadcastToRoom(roomId, messageObj, excludeSocket = null) {
    const room = rooms.get(roomId);
    if (!room) return;
    const msgStr = JSON.stringify(messageObj);
    room.players.forEach((player) => {
        if (player.socket && player.socket.writable && player.socket !== excludeSocket) {
            sendWebSocketFrame(player.socket, msgStr);
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
        trail: p.trail || 'neon-cyan',
        device: p.device || 'pc',
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

// MIME Types for Zero-Dependency Static File Server
const MIME_TYPES = {
    '.html': 'text/html; charset=UTF-8',
    '.js': 'application/javascript; charset=UTF-8',
    '.css': 'text/css; charset=UTF-8',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
    // API Health Check
    if (req.url === '/api/status') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({
            online: true,
            activeRooms: rooms.size,
            totalPlayers: clients.size,
            serverTime: Date.now()
        }));
        return;
    }

    let filePath = path.join(__dirname, req.url === '/' ? 'meta_world.html' : req.url.split('?')[0]);
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'text/plain';

    fs.readFile(filePath, (err, content) => {
        if (err) {
            if (err.code === 'ENOENT') {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('404 Not Found');
            } else {
                res.writeHead(500);
                res.end('Internal Server Error: ' + err.code);
            }
        } else {
            res.writeHead(200, { 'Content-Type': contentType, 'Access-Control-Allow-Origin': '*' });
            res.end(content);
        }
    });
});

// WebSocket Protocol Implementation (RFC 6455)
server.on('upgrade', (req, socket, head) => {
    const key = req.headers['sec-websocket-key'];
    if (!key) {
        socket.destroy();
        return;
    }

    const acceptKey = crypto.createHash('sha1')
        .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        .digest('base64');

    const headers = [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${acceptKey}`,
        '\r\n'
    ];

    socket.write(headers.join('\r\n'));

    const playerId = 'P-' + Math.random().toString(36).substring(2, 9);
    clients.set(socket, { playerId, roomId: null });

    // Send initial handshake
    sendWebSocketFrame(socket, JSON.stringify({
        type: 'CONNECTED',
        playerId
    }));

    let buffer = (head && head.length > 0) ? Buffer.from(head) : Buffer.alloc(0);

    socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 2) {
            const isFinal = (buffer[0] & 0x80) !== 0;
            const opcode = buffer[0] & 0x0F;
            const isMasked = (buffer[1] & 0x80) !== 0;
            let payloadLength = buffer[1] & 0x7F;

            let offset = 2;
            if (payloadLength === 126) {
                if (buffer.length < 4) return;
                payloadLength = buffer.readUInt16BE(2);
                offset = 4;
            } else if (payloadLength === 127) {
                if (buffer.length < 10) return;
                payloadLength = Number(buffer.readBigUInt64BE(2));
                offset = 10;
            }

            let maskKey = null;
            if (isMasked) {
                if (buffer.length < offset + 4) return;
                maskKey = buffer.slice(offset, offset + 4);
                offset += 4;
            }

            if (buffer.length < offset + payloadLength) return;

            let payload = buffer.slice(offset, offset + payloadLength);
            buffer = buffer.slice(offset + payloadLength);

            if (opcode === 0x08) {
                // Close frame
                socket.end();
                return;
            }

            if (opcode === 0x09) {
                // Ping frame -> Send Pong
                const pong = Buffer.from([0x8A, 0x00]);
                socket.write(pong);
                continue;
            }

            if (opcode === 0x01) {
                // Text frame
                if (isMasked && maskKey) {
                    for (let i = 0; i < payload.length; i++) {
                        payload[i] ^= maskKey[i % 4];
                    }
                }
                const messageStr = payload.toString('utf8');
                try {
                    const data = JSON.parse(messageStr);
                    handleClientMessage(socket, data);
                } catch (e) {
                    console.error('Invalid WS JSON:', e);
                }
            }
        }
    });

    socket.on('close', () => {
        handleDisconnect(socket);
        clients.delete(socket);
    });

    socket.on('error', () => {
        handleDisconnect(socket);
        clients.delete(socket);
    });
});

// Send a WebSocket PING frame (opcode 0x09) to every connected client.
// Keeps connections alive through hosting-platform proxies (Render,
// Railway, etc.) that close sockets after ~55-60s of total silence, and
// lets us prune dead sockets that never got a close event.
function sendWebSocketPing(socket) {
    if (!socket.writable) return;
    try {
        socket.write(Buffer.from([0x89, 0x00])); // FIN + opcode 0x9, zero-length payload
    } catch (e) {}
}

setInterval(() => {
    for (const socket of clients.keys()) {
        if (socket.writable) {
            sendWebSocketPing(socket);
        } else {
            handleDisconnect(socket);
            clients.delete(socket);
        }
    }
}, 25000);

function sendWebSocketFrame(socket, text) {
    if (!socket.writable) return;
    const payload = Buffer.from(text, 'utf8');
    const length = payload.length;

    let header;
    if (length <= 125) {
        header = Buffer.from([0x81, length]);
    } else if (length <= 65535) {
        header = Buffer.alloc(4);
        header[0] = 0x81;
        header[1] = 126;
        header.writeUInt16BE(length, 2);
    } else {
        header = Buffer.alloc(10);
        header[0] = 0x81;
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(length), 2);
    }

    try {
        socket.write(Buffer.concat([header, payload]));
    } catch (e) {}
}

function handleClientMessage(socket, data) {
    const clientInfo = clients.get(socket);
    if (!clientInfo) return;
    const { playerId } = clientInfo;

    switch (data.type) {
        case 'CREATE_ROOM': {
            const code = (data.customCode || generateRoomCode()).toUpperCase().trim();
            const playerName = (data.playerName || 'CyberHero').trim();

            const newRoom = {
                id: code,
                name: data.roomName || `${playerName}'s Meta Realm`,
                hostId: playerId,
                status: 'lobby',
                gameMode: data.gameMode || 'math',
                roundTime: Number(data.roundTime) || 30,
                maxPlayers: Number(data.maxPlayers) || 12,
                seed: Math.floor(Math.random() * 1000000),
                players: new Map(),
                chat: []
            };

            const hostPlayer = {
                id: playerId,
                socket,
                name: playerName,
                avatarColor: data.avatarColor || '#9d4edd',
                hat: data.hat || 'visor',
                trail: data.trail || 'neon-cyan',
                device: data.device || 'pc',
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

            sendWebSocketFrame(socket, JSON.stringify({
                type: 'ROOM_CREATED',
                room: getSanitizedRoom(newRoom),
                playerId
            }));
            break;
        }

        case 'JOIN_ROOM': {
            const rawCode = (data.roomCode || '').toUpperCase().trim();
            let room = rooms.get(rawCode);
            if (!room) {
                // Try searching case-insensitively / without hyphens
                const cleanCode = rawCode.replace(/[^A-Z0-9]/gi, '');
                for (const [rId, rObj] of rooms.entries()) {
                    if (rId.replace(/[^A-Z0-9]/gi, '') === cleanCode) {
                        room = rObj;
                        break;
                    }
                }
            }

            if (!room) {
                sendWebSocketFrame(socket, JSON.stringify({
                    type: 'ERROR',
                    message: `Room "${rawCode}" not found!`
                }));
                return;
            }

            const code = room.id;

            if (room.players.size >= room.maxPlayers) {
                sendWebSocketFrame(socket, JSON.stringify({
                    type: 'ERROR',
                    message: `Room "${code}" is full!`
                }));
                return;
            }

            if (clientInfo.roomId && clientInfo.roomId !== code) {
                handleDisconnect(socket);
            }

            const playerName = (data.playerName || 'Explorer_' + Math.floor(Math.random() * 100)).trim();
            const newPlayer = {
                id: playerId,
                socket,
                name: playerName,
                avatarColor: data.avatarColor || '#00f5d4',
                hat: data.hat || 'none',
                trail: data.trail || 'neon-pink',
                device: data.device || 'pc',
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

            sendWebSocketFrame(socket, JSON.stringify({
                type: 'ROOM_JOINED',
                room: getSanitizedRoom(room),
                playerId
            }));

            broadcastToRoom(code, {
                type: 'PLAYER_JOINED',
                player: {
                    id: newPlayer.id,
                    name: newPlayer.name,
                    avatarColor: newPlayer.avatarColor,
                    hat: newPlayer.hat,
                    trail: newPlayer.trail,
                    device: newPlayer.device,
                    x: newPlayer.x,
                    y: newPlayer.y,
                    z: newPlayer.z,
                    ready: newPlayer.ready,
                    isHost: false
                },
                room: getSanitizedRoom(room)
            }, socket);
            break;
        }

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

            broadcastToRoom(room.id, {
                type: 'PLAYER_MOVED',
                id: playerId,
                x: data.x,
                y: data.y,
                z: data.z,
                rotation: data.rotation,
                isMoving: data.isMoving
            }, socket);
            break;
        }

        case 'PLAYER_EMOTE': {
            const room = rooms.get(clientInfo.roomId);
            if (!room) return;
            broadcastToRoom(room.id, {
                type: 'PLAYER_EMOTED',
                id: playerId,
                emote: data.emote
            });
            break;
        }

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

        case 'START_MATCH': {
            const room = rooms.get(clientInfo.roomId);
            if (!room || room.hostId !== playerId) return;

            room.status = 'in_game';
            room.seed = Math.floor(Math.random() * 1000000);
            room.players.forEach(p => {
                p.score = 0; p.streak = 0; p.progress = 0; p.accuracy = 100;
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
    }
}

function handleDisconnect(socket) {
    const clientInfo = clients.get(socket);
    if (!clientInfo || !clientInfo.roomId) return;

    const { playerId, roomId } = clientInfo;
    const room = rooms.get(roomId);
    if (!room) return;

    room.players.delete(playerId);
    clientInfo.roomId = null;

    if (room.players.size === 0) {
        rooms.delete(roomId);
        console.log(`[Room Deleted] ${roomId}`);
    } else {
        if (room.hostId === playerId) {
            room.hostId = room.players.keys().next().value;
        }
        broadcastToRoom(roomId, {
            type: 'PLAYER_LEFT',
            playerId,
            newHostId: room.hostId,
            room: getSanitizedRoom(room)
        });
    }
}

server.listen(PORT, () => {
    console.log(`=================================================`);
    console.log(`🚀 BrainLabs Meta World Server LIVE at http://localhost:${PORT}`);
    console.log(`⚡ Zero-Dependency Node.js Server (NO node_modules needed!)`);
    console.log(`=================================================`);
});
