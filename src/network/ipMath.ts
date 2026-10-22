/**
 * Pure IPv4 and Subnet Mask bitwise helper functions.
 */

export function isValidIpv4(ip: string): boolean {
  if (!ip || typeof ip !== 'string') return false;
  const parts = ip.trim().split('.');
  if (parts.length !== 4) return false;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return false;
    const num = Number(part);
    if (num < 0 || num > 255) return false;
  }
  return true;
}

export function isValidSubnetMask(mask: string): boolean {
  if (!isValidIpv4(mask)) return false;
  const num = ipToInt(mask);
  if (num === 0) return false;
  // Valid mask has contiguous 1s followed by contiguous 0s
  const inverted = ~num >>> 0;
  return ((inverted + 1) & inverted) === 0;
}

export function ipToInt(ip: string): number {
  const parts = ip.trim().split('.').map(Number);
  return (((parts[0] << 24) >>> 0) + ((parts[1] << 16) >>> 0) + ((parts[2] << 8) >>> 0) + parts[3]) >>> 0;
}

export function intToIp(intVal: number): string {
  const unsigned = intVal >>> 0;
  return [
    (unsigned >>> 24) & 255,
    (unsigned >>> 16) & 255,
    (unsigned >>> 8) & 255,
    unsigned & 255,
  ].join('.');
}

export function getNetworkAddress(ip: string, mask: string): string {
  if (!isValidIpv4(ip) || !isValidIpv4(mask)) return '0.0.0.0';
  return intToIp((ipToInt(ip) & ipToInt(mask)) >>> 0);
}

export function isSameSubnet(ip1: string, ip2: string, mask: string): boolean {
  if (!isValidIpv4(ip1) || !isValidIpv4(ip2) || !isValidIpv4(mask)) return false;
  return getNetworkAddress(ip1, mask) === getNetworkAddress(ip2, mask);
}

export function maskToCidr(mask: string): number {
  if (!isValidIpv4(mask)) return 0;
  let num = ipToInt(mask);
  let count = 0;
  while (num > 0) {
    count += num & 1;
    num = num >>> 1;
  }
  return count;
}

export function formatCidr(ip: string, mask: string): string {
  if (!ip) return 'Не назначен';
  const cidr = maskToCidr(mask || '255.255.255.0');
  return `${ip}/${cidr}`;
}

export function generateMacAddress(seedIndex: number, portIndex: number): string {
  const hexSeed = (seedIndex & 0xff).toString(16).padStart(2, '0').toUpperCase();
  const hexPort = (portIndex & 0xff).toString(16).padStart(2, '0').toUpperCase();
  return `00:1A:2B:00:${hexSeed}:${hexPort}`;
}
