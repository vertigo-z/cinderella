import { SMTPServer } from "smtp-server";
import nodemailer from "nodemailer";

const NEXT_HOP = process.env.NEXT_HOP || "10.0.0.3:10025";
const LISTEN_PORT = process.env.LISTEN_PORT || "10025";
const LISTEN_HOST = process.env.LISTEN_HOST || "0.0.0.0";

const [nextHost, nextPort] = NEXT_HOP.split(":");
const transporter = nodemailer.createTransport({
  host: nextHost,
  port: nextPort,
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

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log(
    `MIDDLE RELAY listening on ${LISTEN_HOST}:${LISTEN_PORT} (plaintext) -> next hop ${NEXT_HOP}`
  );
});
