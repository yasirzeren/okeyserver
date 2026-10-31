const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Ana sayfa
app.get("/", (req, res) => {
    res.send("okeyserver calisiyor!");
});

// Sunucu sağlık kontrolü
app.get("/health", (req, res) => {
    res.json({
        status: "ok",
        server: "okeyserver"
    });
});

// Oyuncu sunucuya bağlandığında
io.on("connection", (socket) => {
    console.log("Oyuncu bağlandı:", socket.id);

    // Oyuncu odaya katıldığında
    socket.on("joinRoom", (roomId) => {
        if (
            typeof roomId !== "string" ||
            roomId.length < 1 ||
            roomId.length > 50
        ) {
            socket.emit("errorMessage", "Geçersiz oda kodu!");
            return;
        }

        socket.join(roomId);

        socket.emit("roomJoined", {
            roomId: roomId,
            message: "Odaya katıldın!"
        });

        socket.to(roomId).emit("playerJoined", {
            playerId: socket.id
        });

        console.log(
            socket.id + " oyuncusu " + roomId + " odasına katıldı."
        );
    });

    // Aynı odadaki oyunculara mesaj gönderme
    socket.on("sendMessage", (data) => {
        if (
            !data ||
            typeof data.roomId !== "string" ||
            typeof data.message !== "string"
        ) {
            return;
        }

        if (!socket.rooms.has(data.roomId)) {
            return;
        }

        io.to(data.roomId).emit("receiveMessage", {
            playerId: socket.id,
            message: data.message.slice(0, 500)
        });
    });

    // Oyuncu bağlantısı kesildiğinde
    socket.on("disconnect", () => {
        console.log("Oyuncu ayrıldı:", socket.id);
    });
});

// Render portunu otomatik olarak kullanır.
const PORT = process.env.PORT || 3000;

server.listen(PORT, "0.0.0.0", () => {
    console.log(`okeyserver ${PORT} portunda çalışıyor!`);
});