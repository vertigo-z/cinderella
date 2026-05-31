# cinderella
a javascript intranet mail forwarding framework. hides the true ip address of the mail server by forwarding mail via vpn with mutliple hops. can theoretically be extended up to an arbitrary number of hops. helps prevent adversaries from profiling your infrastructure by assigning levels of publicity to each server. 

while at least one IP must be revealed in DNS records, VPNs such as wireguard enable data to be relayed securely and privately between servers so that your mail server can be sitting somewhere deep inside the network, away from the prying eyes of the public and behind a restrictive firewall, while still being able to send and receive mail to and from the wider internet. 

<sup>this framework has been tested exclusively with wireguard with an mtu of `1280`</sup>

### features:
* `entry.mjs` listens on port 25 for incoming mail
* `STARTTLS` enabled by default
* fully supports blacklists, set `BANNED_DOMAINS` env variable
* uses future-proof ESM format
* checks SPF and responds accordingly
* setting known domains blocks incoming mail not intended for you
* rate limiting that allows 1 incoming email per-second, per-ip
* firewall to be configured to only allow VPN traffic through the outgoing port
* `hop.mjs` can be duplicated to add new routes or extend relay paths
* clears ip from rate-limit map after 60 seconds
* logs are fail2ban-ready (.conf regex included)
* outgoing mail disabled by default, enabled with env variable
* fully supports multiple recipients
* `maxClients`, `maxSize`, and `socketTimeout` protect against resource exhaustion

## usage:

### using with systemd:
**example .service file:**
```
[Unit]
Description=mail-forwarder
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=mail
Group=mail
WorkingDirectory=/var/mail
ExecStart=/usr/bin/node /var/mail/front.mjs
Restart=on-failure
RestartSec=5
SyslogIdentifier=mail-forwarder
EnvironmentFile=/var/mail/.env

StandardOutput=append:/var/log/smtp-relay.log
StandardError=append:/var/log/smtp-relay.log

AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE

NoNewPrivileges=true
ProtectSystem=true
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```
*requires `CAP_NET_BIND_SERVICE` capability in order to bind to port 25*

**example `.env` file:**
```
TLS_CERT=/var/mail/tls/fullchain.pem
TLS_KEY=/var/mail/tls/privkey.pem
OUTGOING_ENABLED=1
ALLOWED_DOMAINS=example.com,example.com,example.com
BANNED_DOMAINS=evil.com,enemy.com
HOSTNAME=mail.example.com
```

## security:
**example fail2ban regex:**
```
[Definition]
datepattern = \[%%Y-%%m-%%dT%%H:%%M:%%S.%%fZ\]
failregex = ^ RELAY FAILED: Message failed: 450 relay failed from=<[^>]+> to=<[^>]+> ip=<HOST>$
            ^ BLOCKED from=<[^>]+> reason=ratelimited ip=<HOST>$
            ^ BLOCKED from=<[^>]+> to=<[^>]+> reason=unknown-rcpt-domain ip=<HOST>$
```
