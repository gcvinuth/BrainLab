import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.*;

/**
 * High-Performance Java Standalone WebSocket Server for BrainLabs Meta World.
 * Zero external dependencies required - compiles directly with standard JDK (Java 11+ / 17+ / 21+).
 * 
 * Usage:
 *   javac MetaWorldServer.java
 *   java MetaWorldServer [port]
 */
public class MetaWorldServer {
    private static final int DEFAULT_PORT = 3000;
    private static final Map<String, Room> rooms = new ConcurrentHashMap<>();
    private static final Map<ClientHandler, String> clientRooms = new ConcurrentHashMap<>();
    private static final String[] CODE_PREFIXES = {"CYBER", "BRAIN", "HYPER", "NEXUS", "QUANTUM", "NEO", "PULSE", "TITAN"};

    public static void main(String[] args) {
        int port = DEFAULT_PORT;
        if (args.length > 0) {
            try {
                port = Integer.parseInt(args[0]);
            } catch (NumberFormatException e) {
                System.out.println("Invalid port, falling back to " + DEFAULT_PORT);
            }
        }

        System.out.println("=================================================");
        System.out.println("⚡ BRAIN LABS META WORLD JAVA SERVER INITIALIZING");
        System.out.println("⚡ WebSocket Port: " + port);
        System.out.println("=================================================");

        ExecutorService threadPool = Executors.newCachedThreadPool();

        try (ServerSocket serverSocket = new ServerSocket(port)) {
            System.out.println("✅ Java Server is LIVE and listening on ws://localhost:" + port);
            while (true) {
                Socket clientSocket = serverSocket.accept();
                ClientHandler handler = new ClientHandler(clientSocket);
                threadPool.submit(handler);
            }
        } catch (IOException e) {
            System.err.println("❌ Server Error: " + e.getMessage());
        }
    }

    public static synchronized String generateRoomCode() {
        Random rand = new Random();
        String code;
        do {
            String prefix = CODE_PREFIXES[rand.nextInt(CODE_PREFIXES.length)];
            int num = 100 + rand.nextInt(900);
            code = prefix + "-" + num;
        } while (rooms.containsKey(code));
        return code;
    }

    public static void broadcastToRoom(String roomId, String jsonPayload, ClientHandler exclude) {
        Room room = rooms.get(roomId);
        if (room == null) return;
        for (ClientHandler client : room.players.values()) {
            if (client != exclude && client.isOpen()) {
                client.sendWebSocketText(jsonPayload);
            }
        }
    }

    // Room Model
    static class Room {
        String id;
        String name;
        String hostId;
        String status = "lobby";
        String gameMode = "math";
        int roundTime = 30;
        int maxPlayers = 12;
        long seed = (long) (Math.random() * 1000000);
        Map<String, ClientHandler> players = new ConcurrentHashMap<>();
        List<String> chat = new CopyOnWriteArrayList<>();

        Room(String id, String name, String hostId) {
            this.id = id;
            this.name = name;
            this.hostId = hostId;
        }

        String toPlayersJson() {
            StringBuilder sb = new StringBuilder("[");
            boolean first = true;
            for (ClientHandler p : players.values()) {
                if (!first) sb.append(",");
                first = false;
                sb.append(String.format("{\"id\":\"%s\",\"name\":\"%s\",\"avatarColor\":\"%s\",\"hat\":\"%s\",\"trail\":\"%s\",\"x\":%.2f,\"y\":%.2f,\"z\":%.2f,\"rotation\":%.2f,\"score\":%d,\"streak\":%d,\"progress\":%d,\"accuracy\":%d,\"ready\":%b,\"isHost\":%b}",
                    escape(p.playerId), escape(p.playerName), escape(p.avatarColor), escape(p.hat), escape(p.trail),
                    p.x, p.y, p.z, p.rotation, p.score, p.streak, p.progress, p.accuracy, p.ready, p.playerId.equals(hostId)
                ));
            }
            sb.append("]");
            return sb.toString();
        }

        String toJson() {
            return String.format("{\"id\":\"%s\",\"name\":\"%s\",\"hostId\":\"%s\",\"status\":\"%s\",\"gameMode\":\"%s\",\"roundTime\":%d,\"maxPlayers\":%d,\"seed\":%d,\"players\":%s}",
                escape(id), escape(name), escape(hostId), escape(status), escape(gameMode), roundTime, maxPlayers, seed, toPlayersJson()
            );
        }
    }

    // Client Handler with WebSocket RFC6455 Support
    static class ClientHandler implements Runnable {
        private final Socket socket;
        private InputStream in;
        private OutputStream out;
        private boolean isOpen = true;

        String playerId = "P-" + UUID.randomUUID().toString().substring(0, 6);
        String playerName = "CyberHero";
        String avatarColor = "#9d4edd";
        String hat = "visor";
        String trail = "neon-cyan";
        double x = 0, y = 0, z = 0, rotation = 0;
        int score = 0, streak = 0, progress = 0, accuracy = 100;
        boolean ready = false;

        public ClientHandler(Socket socket) {
            this.socket = socket;
        }

        public boolean isOpen() {
            return isOpen && socket.isConnected() && !socket.isClosed();
        }

        @Override
        public void run() {
            try {
                in = socket.getInputStream();
                out = socket.getOutputStream();

                // 1. Perform HTTP WebSocket Handshake
                if (!performHandshake()) {
                    close();
                    return;
                }

                // 2. Send Connected Welcome Frame
                sendWebSocketText(String.format("{\"type\":\"CONNECTED\",\"playerId\":\"%s\"}", playerId));

                // 3. Process WebSocket Frames
                while (isOpen) {
                    String message = readWebSocketText();
                    if (message == null) break;
                    processMessage(message);
                }
            } catch (Exception e) {
                // Connection closed
            } finally {
                close();
            }
        }

        private boolean performHandshake() throws Exception {
            Scanner scanner = new Scanner(in, StandardCharsets.UTF_8.name());
            String data = scanner.useDelimiter("\\r\\n\\r\\n").next();
            
            // Check for GET request with Upgrade header
            if (!data.startsWith("GET")) {
                // Return simple HTTP 200 health response if normal browser HTTP request
                String httpResp = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{\"javaServer\":true,\"status\":\"online\"}";
                out.write(httpResp.getBytes(StandardCharsets.UTF_8));
                out.flush();
                return false;
            }

            java.util.regex.Matcher match = java.util.regex.Pattern.compile("Sec-WebSocket-Key: (.*)").matcher(data);
            if (!match.find()) return false;

            String key = match.group(1).trim();
            byte[] response = MessageDigest.getInstance("SHA-1").digest((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").getBytes(StandardCharsets.UTF_8));
            String acceptKey = Base64.getEncoder().encodeToString(response);

            byte[] handshake = ("HTTP/1.1 101 Switching Protocols\r\n"
                    + "Connection: Upgrade\r\n"
                    + "Upgrade: websocket\r\n"
                    + "Sec-WebSocket-Accept: " + acceptKey + "\r\n\r\n").getBytes(StandardCharsets.UTF_8);

            out.write(handshake, 0, handshake.length);
            out.flush();
            return true;
        }

        private synchronized void sendWebSocketText(String text) {
            try {
                byte[] raw = text.getBytes(StandardCharsets.UTF_8);
                int length = raw.length;
                ByteArrayOutputStream frame = new ByteArrayOutputStream();

                frame.write(0x81); // Text frame FIN + opcode 1

                if (length <= 125) {
                    frame.write(length);
                } else if (length <= 65535) {
                    frame.write(126);
                    frame.write((length >> 8) & 0xFF);
                    frame.write(length & 0xFF);
                } else {
                    frame.write(127);
                    for (int i = 7; i >= 0; i--) {
                        frame.write((int)((length >> (8 * i)) & 0xFF));
                    }
                }

                frame.write(raw);
                out.write(frame.toByteArray());
                out.flush();
            } catch (IOException e) {
                isOpen = false;
            }
        }

        private String readWebSocketText() throws IOException {
            int b1 = in.read();
            if (b1 == -1) return null;
            int opcode = b1 & 0x0F;
            if (opcode == 0x08) return null; // Close frame

            int b2 = in.read();
            if (b2 == -1) return null;
            boolean masked = (b2 & 0x80) != 0;
            long length = b2 & 0x7F;

            if (length == 126) {
                length = ((in.read() << 8) | in.read());
            } else if (length == 127) {
                length = 0;
                for (int i = 0; i < 8; i++) {
                    length = (length << 8) | in.read();
                }
            }

            byte[] masks = new byte[4];
            if (masked) {
                in.read(masks, 0, 4);
            }

            byte[] payload = new byte[(int) length];
            int readTotal = 0;
            while (readTotal < length) {
                int read = in.read(payload, readTotal, (int) length - readTotal);
                if (read == -1) break;
                readTotal += read;
            }

            if (masked) {
                for (int i = 0; i < length; i++) {
                    payload[i] = (byte) (payload[i] ^ masks[i % 4]);
                }
            }

            return new String(payload, StandardCharsets.UTF_8);
        }

        private void processMessage(String json) {
            String type = extractJsonValue(json, "type");
            if (type == null) return;

            switch (type) {
                case "CREATE_ROOM": {
                    String customCode = extractJsonValue(json, "customCode");
                    String code = (customCode != null && !customCode.isEmpty()) ? customCode.toUpperCase() : generateRoomCode();
                    this.playerName = optJsonValue(json, "playerName", "CyberAgent");
                    this.avatarColor = optJsonValue(json, "avatarColor", "#9d4edd");
                    this.hat = optJsonValue(json, "hat", "visor");
                    this.trail = optJsonValue(json, "trail", "neon-cyan");

                    Room room = new Room(code, playerName + "'s Meta Realm", playerId);
                    room.players.put(playerId, this);
                    rooms.put(code, room);
                    clientRooms.put(this, code);

                    sendWebSocketText(String.format("{\"type\":\"ROOM_CREATED\",\"room\":%s,\"playerId\":\"%s\"}", room.toJson(), playerId));
                    break;
                }

                case "JOIN_ROOM": {
                    String code = extractJsonValue(json, "roomCode");
                    if (code == null) return;
                    code = code.toUpperCase().trim();
                    Room room = rooms.get(code);

                    if (room == null) {
                        sendWebSocketText(String.format("{\"type\":\"ERROR\",\"message\":\"Room '%s' not found in Java Server!\"}", code));
                        return;
                    }

                    this.playerName = optJsonValue(json, "playerName", "Explorer");
                    this.avatarColor = optJsonValue(json, "avatarColor", "#00f5d4");
                    this.hat = optJsonValue(json, "hat", "none");
                    this.trail = optJsonValue(json, "trail", "neon-pink");
                    this.x = (Math.random() - 0.5) * 6;
                    this.z = (Math.random() - 0.5) * 6;

                    room.players.put(playerId, this);
                    clientRooms.put(this, code);

                    sendWebSocketText(String.format("{\"type\":\"ROOM_JOINED\",\"room\":%s,\"playerId\":\"%s\"}", room.toJson(), playerId));
                    broadcastToRoom(code, String.format("{\"type\":\"PLAYER_JOINED\",\"player\":{\"id\":\"%s\",\"name\":\"%s\",\"avatarColor\":\"%s\",\"hat\":\"%s\",\"trail\":\"%s\",\"x\":%.2f,\"y\":%.2f,\"z\":%.2f,\"ready\":%b},\"room\":%s}",
                        escape(playerId), escape(playerName), escape(avatarColor), escape(hat), escape(trail), x, y, z, ready, room.toJson()), this);
                    break;
                }

                case "PLAYER_MOVE": {
                    String rId = clientRooms.get(this);
                    if (rId == null) return;
                    this.x = parseDouble(extractJsonValue(json, "x"), this.x);
                    this.y = parseDouble(extractJsonValue(json, "y"), this.y);
                    this.z = parseDouble(extractJsonValue(json, "z"), this.z);
                    this.rotation = parseDouble(extractJsonValue(json, "rotation"), this.rotation);
                    boolean isMoving = "true".equalsIgnoreCase(extractJsonValue(json, "isMoving"));

                    broadcastToRoom(rId, String.format("{\"type\":\"PLAYER_MOVED\",\"id\":\"%s\",\"x\":%.2f,\"y\":%.2f,\"z\":%.2f,\"rotation\":%.2f,\"isMoving\":%b}",
                        playerId, x, y, z, rotation, isMoving), this);
                    break;
                }

                case "PLAYER_EMOTE": {
                    String rId = clientRooms.get(this);
                    if (rId == null) return;
                    String emote = extractJsonValue(json, "emote");
                    broadcastToRoom(rId, String.format("{\"type\":\"PLAYER_EMOTED\",\"id\":\"%s\",\"emote\":\"%s\"}", playerId, escape(emote)), null);
                    break;
                }

                case "SEND_CHAT": {
                    String rId = clientRooms.get(this);
                    if (rId == null) return;
                    String text = extractJsonValue(json, "text");
                    broadcastToRoom(rId, String.format("{\"type\":\"NEW_CHAT\",\"chat\":{\"id\":\"msg-%d\",\"senderId\":\"%s\",\"senderName\":\"%s\",\"text\":\"%s\",\"timestamp\":%d}}",
                        System.currentTimeMillis(), playerId, escape(playerName), escape(text), System.currentTimeMillis()), null);
                    break;
                }

                case "TOGGLE_READY": {
                    String rId = clientRooms.get(this);
                    if (rId == null) return;
                    Room room = rooms.get(rId);
                    if (room == null) return;
                    this.ready = !this.ready;
                    broadcastToRoom(rId, String.format("{\"type\":\"PLAYER_READY_CHANGED\",\"id\":\"%s\",\"ready\":%b,\"room\":%s}", playerId, ready, room.toJson()), null);
                    break;
                }

                case "START_MATCH": {
                    String rId = clientRooms.get(this);
                    if (rId == null) return;
                    Room room = rooms.get(rId);
                    if (room == null || !room.hostId.equals(playerId)) return;
                    room.status = "in_game";
                    room.seed = (long)(Math.random() * 1000000);
                    for (ClientHandler p : room.players.values()) {
                        p.score = 0; p.streak = 0; p.progress = 0; p.accuracy = 100;
                    }
                    broadcastToRoom(rId, String.format("{\"type\":\"MATCH_COUNTDOWN_STARTED\",\"countdownSeconds\":3,\"gameMode\":\"%s\",\"roundTime\":%d,\"seed\":%d,\"room\":%s}",
                        room.gameMode, room.roundTime, room.seed, room.toJson()), null);
                    break;
                }

                case "SCORE_UPDATE": {
                    String rId = clientRooms.get(this);
                    if (rId == null) return;
                    Room room = rooms.get(rId);
                    if (room == null) return;
                    this.score = parseInt(extractJsonValue(json, "score"), this.score);
                    this.streak = parseInt(extractJsonValue(json, "streak"), this.streak);
                    this.progress = parseInt(extractJsonValue(json, "progress"), this.progress);
                    this.accuracy = parseInt(extractJsonValue(json, "accuracy"), this.accuracy);

                    broadcastToRoom(rId, String.format("{\"type\":\"LIVE_SCORE_UPDATE\",\"playerId\":\"%s\",\"score\":%d,\"streak\":%d,\"progress\":%d,\"accuracy\":%d,\"leaderboard\":%s}",
                        playerId, score, streak, progress, accuracy, room.toPlayersJson()), null);
                    break;
                }

                case "MATCH_END": {
                    String rId = clientRooms.get(this);
                    if (rId == null) return;
                    Room room = rooms.get(rId);
                    if (room == null) return;
                    room.status = "podium";
                    broadcastToRoom(rId, String.format("{\"type\":\"PODIUM_SHOW\",\"room\":%s}", room.toJson()), null);
                    break;
                }
            }
        }

        private void close() {
            isOpen = false;
            String rId = clientRooms.remove(this);
            if (rId != null) {
                Room room = rooms.get(rId);
                if (room != null) {
                    room.players.remove(playerId);
                    if (room.players.isEmpty()) {
                        rooms.remove(rId);
                        System.out.println("[Java Server] Room deleted: " + rId);
                    } else {
                        if (room.hostId.equals(playerId)) {
                            room.hostId = room.players.keySet().iterator().next();
                        }
                        broadcastToRoom(rId, String.format("{\"type\":\"PLAYER_LEFT\",\"playerId\":\"%s\",\"newHostId\":\"%s\",\"room\":%s}", playerId, room.hostId, room.toJson()), null);
                    }
                }
            }
            try { socket.close(); } catch (Exception ignored) {}
        }
    }

    // Lightweight String Parser Helpers
    private static String extractJsonValue(String json, String key) {
        String pattern = "\"" + key + "\"\\s*:\\s*\"?([^\",}]+)\"?";
        java.util.regex.Matcher m = java.util.regex.Pattern.compile(pattern).matcher(json);
        return m.find() ? m.group(1).trim().replace("\"", "") : null;
    }

    private static String optJsonValue(String json, String key, String def) {
        String val = extractJsonValue(json, key);
        return val != null && !val.isEmpty() ? val : def;
    }

    private static double parseDouble(String str, double def) {
        if (str == null) return def;
        try { return Double.parseDouble(str); } catch (Exception e) { return def; }
    }

    private static int parseInt(String str, int def) {
        if (str == null) return def;
        try { return Integer.parseInt(str); } catch (Exception e) { return def; }
    }

    private static String escape(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n").replace("\r", "");
    }
}
