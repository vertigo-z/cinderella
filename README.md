# cinderella
a javascript intranet mail forwarding framework. hides the true ip address of the mail server by forwarding mail via vpn with mutliple hops. can theoretically be extended up to an arbitrary number of hops. helps prevent adversaries from profiling your infrastructure by assigning levels of publicity to each server. 

while at least one IP must be revealed in DNS records, VPNs such as wireguard enable data to be relayed securely and privately between servers so that your mail server can be sitting somewhere deep inside the network, away from the prying eyes of the public and behind a restrictive firewall, while still being able to send and receive mail to and from the wider internet. 
