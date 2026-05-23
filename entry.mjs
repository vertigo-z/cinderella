import { SMTPServer } from "smtp-server";
import nodemailer from "nodemailer";
import fs from "fs";

const TLS_CERT = process.env.TLS_CERT || "/etc/ssl/certs/mail.crt";
const TLS_KEY = process.env.TLS_KEY || "/etc/ssl/private/mail.key";
const NEXT_HOP = process.env.NEXT_HOP || "10.0.0.1:10025";
const LISTEN_PORT = process.env.LISTEN_PORT || "25";
const LISTEN_HOST = process.env.LISTEN_HOST || "0.0.0.0";

const [nextHost, nextPort] = NEXT_HOP.split(":");
const transporter = nodemailer.createTransport({
  host: nextHost,
  port: nextPort,
  secure: false,
  tls: { rejectUnauthorized: false },
});

const ipLastSeen = new Map();

process.on("uncaughtException", (err) => {
  console.error(`UNCAUGHT: ${err.message}`);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error(`UNHANDLED REJECTION: ${reason}`);
  process.exit(1);
});

const server = new SMTPServer({
  secure: false,
  requireSTARTTLS: true,
  authOptional: true,
  maxClients: 25,
  socketTimeout: 30000,
  maxSize: 50 * 1024 * 1024,
  tls: {
    cert: fs.readFileSync(TLS_CERT),
    key: fs.readFileSync(TLS_KEY),
  },
  disabledCommands: ["AUTH"],
  onData(stream, session, callback) {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => {
      const raw = Buffer.concat(chunks);
      const originalIp = session.remoteAddress;
      const envelope = {
        from: session.envelope.mailFrom.address,
        to: session.envelope.rcptTo.map((r) => r.address),
      };
      const prepended = `X-Original-IP: ${originalIp}\r\n${raw.toString("utf-8")}`;
      transporter
        .sendMail({
          envelope,
          raw: prepended,
        })
        .then(() => {
          console.log(
            `RELAYED from=<${envelope.from}> to=<${envelope.to.join(",")}>`
          );
          callback();
        })
        .catch((err) => {
          console.error(`RELAY FAILED: err=${err.message} from=<${envelope.from}> to=<${envelope.to.join(",")}>`);
          callback(new Error("relay failed"));
        });
    });
    stream.on("error", (err) => callback(err));
  },
  onConnect(session, callback) {
    callback();
  },
  onMailFrom(address, session, callback) {
    const ip = session.remoteAddress;
    const now = Date.now();
    const last = ipLastSeen.get(ip) || 0;
    if (now - last < 1000) {
      console.log(
        `BLOCKED from=<${address}> reason=ratelimited ip=${ip}`
      );
      return callback(new Error());
    }
    ipLastSeen.set(ip, now);
    callback();
  },
  onRcptTo(address, session, callback) {
    callback();
  },
});

function clearIPs() {
  const cutoff = Date.now() - 60 * 1000;
  for (const [ip, ts] of ipLastSeen) {
    if (ts < cutoff) ipLastSeen.delete(ip);
  }
}

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  setInterval(clearIPs, 60 * 1000);
  console.log(
    `ENTRYRELAY listening on ${LISTEN_HOST}:${LISTEN_PORT} (STARTTLS) -> next hop ${NEXT_HOP}`
  );
});
