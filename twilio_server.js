const fs = require("fs");
const path = require("path");
var https = require("https");
var HttpDispatcher = require("httpdispatcher");
var WebSocketServer = require("websocket").server;
var WebSocketClient = require("websocket").client;
var dispatcher = new HttpDispatcher();
const options = {
  path: "/socket",
  key: fs.readFileSync("keys/privkey.pem"),
  cert: fs.readFileSync("keys/fullchain.pem")
};
var httpserver = https.createServer(options, handleRequest);

const HTTP_SERVER_PORT = 1314;

var twiliows = new WebSocketServer({
  httpServer: httpserver,
  autoAcceptConnections: true
});

function log(message, ...args) {
  console.log(new Date(), message, ...args);
}

function handleRequest(request, response) {
  try {
    dispatcher.dispatch(request, response);
  } catch (err) {
    console.error(err);
  }
}

dispatcher.onPost("/twiml", function (req, res) {
  log("POST TwiML");

  var filePath = path.join(__dirname + "/templates", "streams.xml");
  var stat = fs.statSync(filePath);

  res.writeHead(200, {
    "Content-Type": "text/xml",
    "Content-Length": stat.size
  });

  var readStream = fs.createReadStream(filePath);
  readStream.pipe(res);
});

twiliows.on("connect", function (connection) {
  log("From Twilio: Connection accepted");
  new MediaStream(connection);
});

class MediaStream {
  constructor(twilio_connection) {
    this.twilio_connection = twilio_connection;
    this.vaws = new WebSocketClient();
    this.vaws.on("connectFailed", function (error) {
      console.log("Connect Error: " + error.toString());
    });
    this.vaws.on("connect", this.prepareWebsockets.bind(this));
    this.vaws.connect("ws://localhost:8888/ws-streaming-twilio");

    //this.vaws.on("message",this.handleMessageFromService.bind(this))
  }

  prepareWebsockets(va_connection) {
    this.va_connection = va_connection;
    this.twilio_connection.on(
      "message",
      this.handleMessageFromTwilio.bind(this)
    );
    this.twilio_connection.on("close", this.close.bind(this));
    this.va_connection.on("message", this.handleMessageFromVA.bind(this));
    this.va_connection.on("close", function () {
      console.log("Connection with VA Closed");
    });
    this.mode = "recording";
    this.streamSid = "-1";
  }

  handleMessageFromVA(message) {
    /* expected message: a dict with a type=utf-8
     * and utf8Data=SINGLE_UTTERANCE_END or
     * a base64 string reprsenting audio, prefixed with _MULAW
     */
    var new_msg;
    if (message.type === "utf8") {
      new_msg = message.utf8Data;
      if (new_msg === "SINGLE_UTTERANCE_END") this.mode = "waiting";
      else if (new_msg.startsWith("_MULAW")) {
        const payload = new_msg.slice(4);
        const ss = this.streamSid;
        const msg = {
          event: "media",
          streamSid: ss,
          media: {
            payload
          }
        };
        const messageJSON = JSON.stringify(msg);
        log(
          "To Twilio: sent base64-encoded string of length " +
            msg.media.payload.length +
            " characters."
        );
        this.twilio_connection.sendUTF(messageJSON);
        //also need to send mark message to
        //request a notification when the audio stop playing
        const markmsg = {
          event: "mark",
          streamSid: ss,
          mark: {
            name: "playback_complete"
          }
        };
        this.twilio_connection.sendUTF(JSON.stringify(markmsg));
      }
    } else if (message.type === "binary") {
      log("From VA: binary message received (not supported)");
      return;
    }
  }
  handleMessageFromTwilio(message) {
    if (message.type === "utf8") {
      const data = JSON.parse(message.utf8Data);
      if (data.event === "connected") {
        log("From Twilio: Connected event received: ", data);
      }
      if (data.event === "start") {
        log("From Twilio: Start event received: ", data);
        this.streamSid = data.start.streamSid;
        while (!this.va_connection.connected) {}
        this.va_connection.sendUTF("RESTART_COMMUNICATION");
      }
      if (data.event === "media") {
        if (this.mode === "recording") {
          this.va_connection.sendUTF(data.media.payload);
        }
      }
      if (data.event === "mark") {
        log("From Twilio: Mark event received", data);
        if (data.mark.name == "playback_complete") {
          this.mode = "recording";
          this.va_connection.sendUTF("RESTART_COMMUNICATION");
        }
      }
      if (data.event === "close") {
        log("From Twilio: Close event received: ", data);
        this.close();
      }
    } else if (message.type === "binary") {
      log("From Twilio: binary message received (not supported)");
    }
  }

  close() {
    log("Server: Closed");
  }
}

httpserver.listen(HTTP_SERVER_PORT, function () {
  console.log(
    "Server listening on: https://ilspvoiceassistant.gr:%s",
    HTTP_SERVER_PORT
  );
});
