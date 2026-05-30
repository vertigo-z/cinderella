import { SMTPServer } from "smtp-server";
import nodemailer from "nodemailer";

const NEXT_HOP = process.env.NEXT_HOP || "10.0.0.3:10025";
const LISTEN_PORT = process.env.LISTEN_PORT || "10025";
const LISTEN_HOST = process.env.LISTEN_HOST || "0.0.0.0";

const OUTGOING_PORT = process.env.OUTGOING_PORT || "10026";
const OUTGOING_NEXT_HOP = process.env.OUTGOING_NEXT_HOP || "10.0.0.2:10026";

const [nextHost, nextPort] = NEXT_HOP.split(":");
const transporter = nodemailer.createTransport({
  host: nextHost,
  port: nextPort,
  secure: false,
  tls: { rejectUnauthorized: false },
});

const [outHost, outPort] = OUTGOING_NEXT_HOP.split(":");
const outgoingTransporter = nodemailer.createTransport({
  host: outHost,
  port: outPort,
  secure: false,
  tls: { rejectUnauthorized: false },
});

const server = new SMTPServer({
  secure: false,
  authOptional: true,
  disabledCommands: ["STARTTLS", "AUTH"],
  onData(stream, session, callback) {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => {
      const raw = Buffer.concat(chunks);
      const envelope = {
        from: session.envelope.mailFrom.address,
        to: session.envelope.rcptTo.map((r) => r.address),
      };
      transporter
        .sendMail({
          envelope,
          raw: raw.toString("utf-8"),
        })
        .then(() => {
          console.log(
            `RELAYED from=<${envelope.from}> to=<${envelope.to.join(",")}>`
          );
          callback();
        })
        .catch((err) => {
          console.error(`RELAY FAILED: ${err.message} from=<${envelope.from}> to=<${envelope.to.join(",")}>`);
          callback(new Error("relay failed"));
        });
    });
    stream.on("error", (err) => callback(err));
  },
  onConnect(session, callback) {
    callback();
  },
  onMailFrom(address, session, callback) {
    callback();
  },
  onRcptTo(address, session, callback) {
    callback();
  },
});

const outgoingServer = new SMTPServer({
  secure: false,
  authOptional: true,
  disabledCommands: ["STARTTLS", "AUTH"],
  onData(stream, session, callback) {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => {
      const raw = Buffer.concat(chunks);
      const envelope = {
        from: session.envelope.mailFrom.address,
        to: session.envelope.rcptTo.map((r) => r.address),
      };
      outgoingTransporter
        .sendMail({
          envelope,
          raw: raw.toString("utf-8"),
        })
        .then(() => {
          console.log(
            `OUTGOING RELAYED from=<${envelope.from}> to=<${envelope.to.join(",")}>`
          );
          callback();
        })
        .catch((err) => {
          console.error(`OUTGOING RELAY FAILED: ${err.message}`);
          callback(new Error("relay failed"));
        });
    });
    stream.on("error", (err) => callback(err));
  },
  onConnect(session, callback) {
    callback();
  },
  onMailFrom(address, session, callback) {
    callback();
  },
  onRcptTo(address, session, callback) {
    callback();
  },
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log(
    `MIDDLE RELAY listening on ${LISTEN_HOST}:${LISTEN_PORT} (plaintext) -> next hop ${NEXT_HOP}`
  );
});

outgoingServer.listen(OUTGOING_PORT, LISTEN_HOST, () => {
  console.log(
    `MIDDLE OUTGOING listening on ${LISTEN_HOST}:${OUTGOING_PORT} -> outgoing hop ${OUTGOING_NEXT_HOP}`
  );
});

function shutdown() {
  let pending = 2;
  const done = () => {
    pending--;
    if (pending === 0) process.exit(0);
  };
  server.close(() => {
    console.log(`MIDDLE RELAY closed`);
    done();
  });
  outgoingServer.close(() => {
    console.log(`MIDDLE OUTGOING closed`);
    done();
  });
  setTimeout(() => {
    console.log(`Forcing exit after timeout`);
    process.exit(1);
  }, 10000);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
