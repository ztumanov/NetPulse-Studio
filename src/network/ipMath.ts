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

/**
 * Automatically formats IPv4 / Subnet Mask input as the user types:
 * - Converts spaces, commas, or slashes into dots '.'
 * - Automatically inserts a dot '.' after a 3-digit octet (e.g. "192" -> "192.")
 *   or when an octet would exceed 255 (e.g. "192168110")
 * - Preserves normal Backspace deletion when deleting a trailing dot.
 */
export function formatIpv4Input(raw: string, prevValue = ''): string {
  if (!raw) return '';

  const isDeletingTrailingDot =
    prevValue.endsWith('.') && raw === prevValue.slice(0, -1);

  const normalized = raw
    .replace(/[ ,/юбЮБ]+/g, '.')
    .replace(/[^0-9.]/g, '')
    .replace(/\.+/g, '.')
    .replace(/^\./, '');

  const rawParts = normalized.split('.');
  const octets: string[] = [];

  for (let i = 0; i < rawParts.length && octets.length < 4; i++) {
    let chunk = rawParts[i];
    if (chunk === '') {
      if (i === rawParts.length - 1 && octets.length > 0 && octets.length < 4) {
        return `${octets.join('.')}.`;
      }
      continue;
    }

    while (chunk.length > 0 && octets.length < 4) {
      if (chunk.length <= 3) {
        const val = Number(chunk);
        if (val > 255) {
          octets.push(chunk.slice(0, 2));
          chunk = chunk.slice(2);
        } else {
          octets.push(chunk);
          chunk = '';
        }
      } else {
        const firstThree = Number(chunk.slice(0, 3));
        if (firstThree <= 255) {
          octets.push(chunk.slice(0, 3));
          chunk = chunk.slice(3);
        } else {
          octets.push(chunk.slice(0, 2));
          chunk = chunk.slice(2);
        }
      }
    }
  }

  const joined = octets.slice(0, 4).join('.');
  const isAddingChars = raw.length > prevValue.length;
  const lastOctet = octets[octets.length - 1] || '';

  if (
    isAddingChars &&
    !isDeletingTrailingDot &&
    octets.length >= 1 &&
    octets.length < 4 &&
    lastOctet.length === 3
  ) {
    return `${joined}.`;
  }

  return joined;
}

/**
 * Returns the default subnet mask for a given IPv4 address when the user clicks/focuses the mask field.
 * - Class A (1.0.0.0 – 126.255.255.255): 255.0.0.0
 * - Class B (128.0.0.0 – 191.255.255.255): 255.255.0.0
 * - Class C & Default (192.0.0.0+): 255.255.255.0
 */
export function suggestSubnetMaskForIp(ip: string): string {
  if (!ip || typeof ip !== 'string') return '255.255.255.0';
  const cleaned = ip.trim();
  const firstPart = cleaned.split('.')[0];
  const firstOctet = Number(firstPart);
  if (!firstPart || Number.isNaN(firstOctet)) return '255.255.255.0';

  if (firstOctet >= 1 && firstOctet <= 126) {
    return '255.0.0.0';
  }
  if (firstOctet >= 128 && firstOctet <= 191) {
    return '255.255.0.0';
  }
  return '255.255.255.0';
}

