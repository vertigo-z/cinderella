import { SMTPServer } from "smtp-server";
import nodemailer from "nodemailer";
import fs from "fs";
import dns from "dns";
import { spf } from "mailauth/lib/spf/index.js";

const NEXT_HOP = process.env.NEXT_HOP || "10.0.0.1:10025";
const LISTEN_PORT = process.env.LISTEN_PORT || "25";
const LISTEN_HOST = process.env.LISTEN_HOST || "0.0.0.0";
const HOSTNAME = process.env.HOSTNAME || 'localhost';

let blacklist = [];
let whitelist = [];

function loadBlacklist(bl) {
  if (!bl) return; 
  blacklist = bl.split(",").map(d => d.trim().toLowerCase());
}

function loadWhitelist(wl) {
  if (!wl) return;
  whitelist = wl.split(",").map(d => d.trim().toLowerCase());
}

const TLS_CERT = process.env.TLS_CERT;
const TLS_KEY = process.env.TLS_KEY;

const [nextHost, nextPort] = NEXT_HOP.split(":");
const transporter = nodemailer.createTransport({
  host: nextHost,
  port: nextPort,
  secure: false,
  tls: { rejectUnauthorized: false },
});

const QUEUE_RETRY_MS = Number(process.env.QUEUE_RETRY_MS) || 12 * 60 * 60 * 1000;
const QUEUE_EXPIRY_MS = Number(process.env.QUEUE_EXPIRY_MS) || 7 * 24 * 60 * 60 * 1000;

const mailQueue = [];
let flushing = false;

function relayUnreachable(err) {
  if (!err) return false;
  if (err.responseCode) return false;
  if (err.code && ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "ESOCKET", "ECONNABORTED"].includes(err.code)) return true;
  return /greeting never received|socket|connection (refused|reset|timed out)|timed out/i.test(err.message || "");
}

function expireQueue() {
  const cutoff = Date.now() - QUEUE_EXPIRY_MS;
  while (mailQueue.length > 0 && mailQueue[0].queuedAt < cutoff) {
    const entry = mailQueue.shift();
    console.error(
      `[` + new Date().toISOString() + `] ` + `EXPIRED from=<${entry.envelope.from}> to=<${entry.envelope.to.join(",")}> ip=${entry.ip} age=${Math.round((Date.now() - entry.queuedAt) / 60000)}m`
    );
  }
}

async function flushQueue() {
  if (flushing || mailQueue.length === 0) return;
  flushing = true;
  try {
    expireQueue();
    while (mailQueue.length > 0) {
      const entry = mailQueue[0];
      try {
        await transporter.sendMail({ envelope: entry.envelope, raw: entry.raw });
      } catch (err) {
        if (relayUnreachable(err)) {
          console.error(
            `[` + new Date().toISOString() + `] ` + `QUEUE RETRY FAILED: relay unreachable from=<${entry.envelope.from}> to=<${entry.envelope.to.join(",")}> ip=${entry.ip} queued=${mailQueue.length}`
          );
          break;
        }
        mailQueue.shift();
        console.error(
          `[` + new Date().toISOString() + `] ` + `DISCARDED from=<${entry.envelope.from}> to=<${entry.envelope.to.join(",")}> ip=${entry.ip} reason=relay-denied (${err.message})`
        );
        continue;
      }
      mailQueue.shift();
      console.log(
        `[` + new Date().toISOString() + `] ` + `RELAYED from buffer from=<${entry.envelope.from}> to=<${entry.envelope.to.join(",")}> ip=${entry.ip}`
      );
    }
  } finally {
    flushing = false;
  }
}

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
      const spfHeader = session.spfResult?.header ? `${session.spfResult.header}\r\n` : "";
      const prepended = `X-Original-IP: ${originalIp}\r\n${raw.toString("utf-8")}`;
      const withSpf = spfHeader + prepended;
      transporter
        .sendMail({
          envelope,
          raw: withSpf,
        })
        .then(() => {
          console.log(
            `[` + new Date().toISOString() + `] ` + `RELAYED from=<${envelope.from}> to=<${envelope.to.join(",")}> ip=${originalIp}`
          );
          callback();
        })
        .catch((err) => {
          if (relayUnreachable(err)) {
            mailQueue.push({ envelope, raw: withSpf, ip: originalIp, queuedAt: Date.now() });
            console.log(
              `[` + new Date().toISOString() + `] ` + `BUFFERED from=<${envelope.from}> to=<${envelope.to.join(",")}> ip=${originalIp} queued=${mailQueue.length}`
            );
            callback();
            return;
          }
          console.error(
            `[` + new Date().toISOString() + `] ` + `RELAY FAILED: ${err.message} from=<${envelope.from}> to=<${envelope.to.join(",")}> ip=${originalIp}`
          );
          callback(new Error(err));
        });
    });
    stream.on("error", (err) => callback(err));
  },
  onConnect(session, callback) {
    const ip = session.remoteAddress;
    console.log(
      `[` + new Date().toISOString() + `] ` +  `CONNECTION established with ${ip}`
    );
    callback();
  },
  onSecure(socket, session, callback) {
    const ip = session.remoteAddress;
    console.log(
      `[` + new Date().toISOString() + `] ` +  `SECURE connection established with ${ip}`
    );
    callback();
  },
  onMailFrom(address, session, callback) {
    const ip = session.remoteAddress;
    const now = Date.now();
    const last = ipLastSeen.get(ip) || 0;
    if (now - last < 1000) {
      console.log(
        `[` + new Date().toISOString() + `] ` + `BLOCKED from=<${address.address}> reason=ratelimited ip=${ip}`
      );
      return callback(Object.assign(new Error("4.7.26 Rate limit exceeded"), { responseCode: 421 }));
    }
    ipLastSeen.set(ip, now);
    const domain = address.address.split("@")[1]?.toLowerCase();
    if (blacklist.includes(domain)){
      console.log(
        `[` + new Date().toISOString() + `] ` + `BLOCKED from=<${address.address}> reason=domain-blacklisted ip=${ip}`
      );
      return callback(Object.assign(new Error("5.7.1 Domain blacklisted"), { responseCode: 550 }));
    }
    spf(
      { sender: address.address, ip, 
        helo: session.hostName || "unknown", 
        mta: HOSTNAME }).then((result) => {
          if (result.status.result === "fail") {
            console.log(
              `[` + new Date().toISOString() + `] ` + `BLOCKED from=<${address.address}> reason=spf-fail ip=${ip}`
            );
            return callback(Object.assign(new Error("5.7.23 SPF check failed"), { responseCode: 550 }));
          }
          session.spfResult = result;
          console.log(
            `[` + new Date().toISOString() + `] ` + `SPF ${result.status.result} from=<${address.address}> ip=${ip}`
          );
          callback();
        }).catch((err) => {
          console.error(
            `[` + new Date().toISOString() + `] ` + `SPF ERROR: ${err.message} from=<${address.address}> ip=${ip}`
          );
          callback();
        });
  },
  onRcptTo(address, session, callback) {
    const ip = session.remoteAddress;
    const sender = session.envelope.mailFrom.address;
    const domain = address.address.split("@")[1]?.toLowerCase();
    if (!whitelist.includes(domain)) {
      console.log(
        `[` + new Date().toISOString() + `] ` + `BLOCKED from=<${sender}> to=<${address}> reason=unknown-rcpt-domain ip=${ip}`
      );
      return callback(Object.assign(new Error("5.7.1 Forwarding to remote hosts disabled"), { responseCode: 551 }));
    }
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
  loadBlacklist(process.env.BANNED_DOMAINS);
  loadWhitelist(process.env.ALLOWED_DOMAINS);
  setInterval(() => {
    clearIPs();
    expireQueue();
  }, 60 * 1000);
  setInterval(flushQueue, QUEUE_RETRY_MS);
  console.log(
    `[` + new Date().toISOString() + `] ` + `ENTRYRELAY listening on ${LISTEN_HOST}:${LISTEN_PORT} (STARTTLS) -> next hop ${NEXT_HOP} (queue retry ${(QUEUE_RETRY_MS / 3600000)}h, expiry ${(QUEUE_EXPIRY_MS / 86400000)}d)`
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

const outgoingEnabled = process.env.OUTGOING_ENABLED  === '1' ? 1 : 0;

if (outgoingEnabled === 1) {
  outgoingServer.listen(OUTGOING_PORT, LISTEN_HOST, () => {
    console.log(
      `[` + new Date().toISOString() + `] ` + `OUTGOING listening on ${LISTEN_HOST}:${OUTGOING_PORT} -> external MX`
    );
  });
} else {
  console.log(
    `[` + new Date().toISOString() + `] ` + `OUTGOING DISABLED`
  );
}

console.log(
  `[` + new Date().toISOString() + `] ` + `RECEIVING MAIL FOR: ${whitelist}`
);

function shutdown() {
  let pending = 2;
  const done = () => {
    pending--;
    if (pending === 0) process.exit(0);
  };
  server.close(() => {
    console.log(`[` + new Date().toISOString() + `] ` + `ENTRYRELAY closed`);
    done();
  });
  outgoingServer.close(() => {
    console.log(`[` + new Date().toISOString() + `] ` + `OUTGOING closed`);
    done();
  });
  setTimeout(() => {
    console.log(`[` + new Date().toISOString() + `] ` + `Forcing exit after timeout`);
    process.exit(1);
  }, 10000);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
