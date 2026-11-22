export function lanAddresses(interfaces){
  const rank=name=>/^(wi-?fi|wlan|wl|en0$)/i.test(name)?0:1
  return Object.entries(interfaces)
    .filter(([name])=>!/^(docker|br-|veth|utun|tun\d|tap\d|tailscale|wg\d|vmnet|vbox|virbr|vEthernet)/i.test(name))
    .sort(([a],[b])=>rank(a)-rank(b))
    .flatMap(([,addrs])=>addrs.filter(a=>a.family==='IPv4' && !a.internal && !a.address.startsWith('169.254.')).map(a=>a.address))
}
