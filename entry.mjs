import { SMTPServer } from "smtp-server";
import nodemailer from "nodemailer";
import fs from "fs";
import dns from "dns";

const NEXT_HOP = process.env.NEXT_HOP || "10.0.0.1:10025";
const LISTEN_PORT = process.env.LISTEN_PORT || "25";
const LISTEN_HOST = process.env.LISTEN_HOST || "0.0.0.0";
const HOSTNAME = process.env.HOSTNAME || 'localhost';

const TLS_CERT = process.env.TLS_CERT;
const TLS_KEY = process.env.TLS_KEY;

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
});

process.on("unhandledRejection", (reason) => {
  console.error(`UNHANDLED REJECTION: ${reason}`);
});

const server = new SMTPServer({
  name: HOSTNAME,
  secure: false,
  requireSTARTTLS: true,
  authOptional: true,
  maxClients: 25,
  socketTimeout: 30000,
  maxSize: 50 * 1024 * 1024,
  cert: fs.readFileSync(TLS_CERT),
  key: fs.readFileSync(TLS_KEY),
  minVersion: "TLSv1.2",
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
            `[` + new Date().toISOString() + `] ` + `RELAYED from=<${envelope.from}> to=<${envelope.to.join(",")}> ip=${originalIp}`
          );
          callback();
        })
        .catch((err) => {
          console.error(
            `[` + new Date().toISOString() + `] ` + `RELAY FAILED: ${err.message} from=<${envelope.from}> to=<${envelope.to.join(",")}> ip=${originalIp}`
          );
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
        `[` + new Date().toISOString() + `] ` + `BLOCKED from=<${address}> reason=ratelimited ip=${ip}`
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
    `[` + new Date().toISOString() + `] ` + `ENTRYRELAY listening on ${LISTEN_HOST}:${LISTEN_PORT} (STARTTLS) -> next hop ${NEXT_HOP}`
  );
});

const OUTGOING_PORT = process.env.OUTGOING_PORT || "10026";

const dnsResolver = dns.promises;

async function resolveMx(domain) {
  try {
    const records = await dnsResolver.resolveMx(domain);
    records.sort((a, b) => a.priority - b.priority);
    return records[0].exchange;
  } catch {
    return domain;
  }
}

const outgoingServer = new SMTPServer({
  name: HOSTNAME,
  secure: false,
  authOptional: true,
  disabledCommands: ["STARTTLS", "AUTH"],
  onData(stream, session, callback) {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", async () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      const envelope = {
        from: session.envelope.mailFrom.address,
        to: session.envelope.rcptTo.map((r) => r.address),
      };
      const byDomain = new Map();
      for (const addr of envelope.to) {
        const domain = addr.split("@")[1];
        if (!byDomain.has(domain)) byDomain.set(domain, []);
        byDomain.get(domain).push(addr);
      }
      const results = await Promise.allSettled(
        [...byDomain.entries()].map(async ([domain, recipients]) => {
          const mx = await resolveMx(domain);
          const transport = nodemailer.createTransport({
            host: mx,
            port: 25,
            secure: false,
            tls: { rejectUnauthorized: false },
          });
          try {
            await transport.sendMail({
              envelope: { from: envelope.from, to: recipients },
              raw,
            });
            console.log(
              `[` + new Date().toISOString() + `] ` + `OUTGOING DELIVERED from=<${envelope.from}> to=<${recipients.join(",")}> mx=${mx}`
            );
          } finally {
            transport.close();
          }
        })
      );
      const failures = results.filter((r) => r.status === "rejected");
      if (failures.length > 0) {
        for (const f of failures) {
          console.error(`[` + new Date().toISOString() + `] ` + `OUTGOING FAILED: ${f.reason?.message}`);
        }
        callback(new Error("delivery failed"));
      } else {
        callback();
      }
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

outgoingServer.listen(OUTGOING_PORT, LISTEN_HOST, () => {
  console.log(
    `[` + new Date().toISOString() + `] ` + `OUTGOING listening on ${LISTEN_HOST}:${OUTGOING_PORT} -> external MX`
  );
});
