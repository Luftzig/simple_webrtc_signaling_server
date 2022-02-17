// IMPORTS
const http = require("http");
const express = require("express");
const socketio = require("socket.io");
const cors = require("cors");
const sirv = require("sirv");

// ENVIRONMENT VARIABLES
const PORT = process.env.PORT || 3030;
const DEV = process.env.NODE_ENV === "development";
const TOKEN = process.env.TOKEN;
const PING = process.env.PING

// SETUP SERVERS
const app = express();
app.use(express.json(), cors());
const server = http.createServer(app);
const io = socketio(server, {cors: {}});

// AUTHENTICATION MIDDLEWARE
io.use((socket, next) => {
  const token = socket.handshake.auth.token; // check the auth token provided by the client upon connection
  if (token === TOKEN) {
    next();
  } else {
    next(new Error("Authentication error"));
  }
});

// API ENDPOINT TO DISPLAY THE CONNECTION TO THE SIGNALING SERVER
let connections = {};
app.get("/connections", (req, res) => {
  res.json(Object.values(connections));
});

app.get("/clock", (req, res) => {
  res.json({server: new Date()})
})

if (PING) {
  let pingCounter = 0;
  const parseResult = parseInt(PING)
  const pingInterval = isNaN(parseResult) ? +Infinity : parseResult


  setInterval(() => {
    const time = new Date()
    const counter = pingCounter++;
    Object.values(connections).map(({socketId}) =>
      io.to(socketId).emit("ping", {serverTime: time, counter})
    )
  }, pingInterval)
}

// MESSAGING LOGIC
io.on("connection", (socket) => {
  console.log("User connected with id", socket.id);

  socket.on("ready", (peerId, peerType) => {
    // Make sure that the hostname is unique, if the hostname is already in connections, send an error and disconnect
    if (peerId in connections) {
      socket.emit("uniquenessError", {
        message: `${peerId} is already connected to the signalling server. Please change your peer ID and try again.`,
      });
      socket.disconnect(true);
    } else {
      console.log(`Added ${peerId} to connections`);
      // Let new peer know about all exisiting peers
      socket.send({
        type: "ready",
        from: "all",
        target: peerId,
        payload: {action: "open", connections: Object.values(connections), bePolite: false}
      }); // The new peer doesn't need to be polite.
      // Create new peer
      const newPeer = {socketId: socket.id, peerId, peerType};
      // Updates connections object
      connections[peerId] = newPeer;
      // Let all other peers know about new peer
      socket.broadcast.emit("message", {
        type: "ready",
        from: peerId,
        target: "all",
        payload: {action: "open", connections: [newPeer], bePolite: true}, // send connections object with an array containing the only new peer and make all exisiting peers polite.
      });
    }
  });
  socket.on("message", (message) => {
    // Send message to all peers expect the sender
    console.log("received message", message)
    socket.broadcast.emit("message", message);
  });
  socket.on("messageOne", (message) => {
    // Send message to a specific targeted peer
    const {target} = message;
    const targetPeer = connections[target];
    if (targetPeer) {
      io.to(targetPeer.socketId).emit("message", {...message});
    } else {
      console.log(`Target ${target} not found`);
    }
  });
  socket.on("countdown", (message) => {
    const {outOf, intervalMs} = message
    let count = 0
    let intervalHandler = setInterval(() => {
      console.log("Countdown tick at", new Date(), count, "out of", outOf)
      const payload = {
        type: "countdown",
        count: count,
        outOf,
        intervalMs
      }
      socket.broadcast.emit("message", payload)
      socket.send(payload)
      count++
      if (count > outOf) {
        clearInterval(intervalHandler)
      }
    }, intervalMs)
  })
  socket.on("disconnect", () => {
    const disconnectingPeer = Object.values(connections).find((peer) => peer.socketId === socket.id);
    if (disconnectingPeer) {
      console.log("Disconnected", socket.id, "with peerId", disconnectingPeer.peerId);
      // Make all peers close their peer channels
      socket.broadcast.emit("message", {
        type: "disconnect",
        from: disconnectingPeer.peerId,
        target: "all",
        payload: {action: "close", message: "Peer has left the signaling server"},
      });
      // remove disconnecting peer from connections
      delete connections[disconnectingPeer.peerId];
    } else {
      console.log(socket.id, "has disconnected");
    }
  });

  socket.on("clock", () => {
    io.to(socket.id).send("message", {type: "clock", server: new Date()})
  })

  if (PING) {
    socket.on("ping", (message) => {
      const currentTime = new Date()
      const {serverTime, counter} = message;
      if (counter !== pingCounter - 1) {
        console.debug("Peer out of sync", socket.id, "by", (pingCounter - 1 - counter), "pings")
        return
      }
      console.log("Peer delay for", socket.id, "is", currentTime - serverTime)
    })
  }
});

// SERVE STATIC FILES
app.use(sirv("public", {DEV}));

// RUN APP
server.listen(PORT, console.log(`Listening on PORT ${PORT}`));
