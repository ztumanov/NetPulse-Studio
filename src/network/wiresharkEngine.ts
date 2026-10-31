import { OsiPduDetails, ProtocolType, SimulationStep } from './types';

export interface WiresharkHeaderField {
  id: string;
  label: string;
  value: string;
  byteOffset: number;
  byteLength: number;
  layer: 'L1' | 'L2' | 'L3' | 'L4' | 'L7';
  changedFromInbound?: string;
}

export interface WiresharkHeaderSection {
  id: string;
  title: string;
  summary: string;
  layer: 'L1' | 'L2' | 'L3' | 'L4' | 'L7';
  byteOffset: number;
  byteLength: number;
  fields: WiresharkHeaderField[];
}

export interface WiresharkHexRow {
  offsetHex: string;
  startIndex: number;
  bytes: number[];
  asciiChars: string[];
}

export interface WiresharkDissectedPacket {
  stepId: string;
  stepIndex: number;
  timeSeconds: string;
  source: string;
  destination: string;
  protocolLabel: string;
  lengthBytes: number;
  vlanTag: number | null;
  infoSummary: string;
  colorClass: string;
  isDropped: boolean;
  bytes: number[];
  hexRows: WiresharkHexRow[];
  sections: WiresharkHeaderSection[];
  changedByteOffsets: number[];
  diffSummaryItems: {
    fieldLabel: string;
    before: string;
    after: string;
    layer: 'L1' | 'L2' | 'L3' | 'L4' | 'L7';
  }[];
}

export interface FollowStreamMessage {
  stepIndex: number;
  timeSeconds: string;
  direction: 'client_to_server' | 'server_to_client';
  senderLabel: string;
  receiverLabel: string;
  protocol: ProtocolType;
  headline: string;
  rawText: string;
  byteCount: number;
}

export interface FollowStreamDialog {
  streamTitle: string;
  streamProtocol: string;
  clientEndpoint: string;
  serverEndpoint: string;
  totalPackets: number;
  totalBytes: number;
  messages: FollowStreamMessage[];
}

function parseMacToBytes(mac: string | undefined): number[] {
  if (!mac) return [0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
  const parts = mac
    .trim()
    .split(/[:-]/)
    .map((p) => parseInt(p, 16));
  if (parts.length === 6 && parts.every((n) => !Number.isNaN(n))) {
    return parts.map((n) => n & 0xff);
  }
  return [0x00, 0x1a, 0x2b, 0x00, 0x00, 0x01];
}

function parseIpv4ToBytes(ip: string | undefined): number[] {
  if (!ip) return [0, 0, 0, 0];
  const m = ip.trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return [0, 0, 0, 0];
  return [Number(m[1]) & 0xff, Number(m[2]) & 0xff, Number(m[3]) & 0xff, Number(m[4]) & 0xff];
}

function uint16ToBytes(val: number): [number, number] {
  return [(val >> 8) & 0xff, val & 0xff];
}

function uint32ToBytes(val: number): [number, number, number, number] {
  return [
    (val >>> 24) & 0xff,
    (val >>> 16) & 0xff,
    (val >>> 8) & 0xff,
    val & 0xff,
  ];
}

function asciiToBytes(text: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    out.push(code <= 0xff ? code : 0x3f);
  }
  return out;
}

function computeIpv4Checksum(header20: number[]): number {
  let sum = 0;
  for (let i = 0; i < header20.length; i += 2) {
    if (i === 10) continue; // skip checksum field itself
    const word = ((header20[i] || 0) << 8) | (header20[i + 1] || 0);
    sum += word;
    while (sum > 0xffff) {
      sum = (sum & 0xffff) + (sum >>> 16);
    }
  }
  return (~sum) & 0xffff;
}

function formatHex16(val: number): string {
  return `0x${(val & 0xffff).toString(16).toUpperCase().padStart(4, '0')}`;
}

export function getWiresharkRowColorClass(protocol: ProtocolType, isDropped: boolean): string {
  if (isDropped) {
    return 'bg-red-950/90 text-red-200 border-l-2 border-l-red-500 hover:bg-red-900/80';
  }
  switch (protocol) {
    case 'HTTP_GET':
    case 'HTTP_200_OK':
      return 'bg-emerald-950/55 text-emerald-100 hover:bg-emerald-900/65';
    case 'TCP_SYN':
    case 'TCP_SYN_ACK':
    case 'TCP_ACK':
    case 'BGP_OPEN':
    case 'BGP_UPDATE':
    case 'BGP_KEEPALIVE':
      return 'bg-indigo-950/55 text-indigo-100 hover:bg-indigo-900/65';
    case 'ICMP_ECHO_REQUEST':
    case 'ICMP_ECHO_REPLY':
    case 'ICMP_TIME_EXCEEDED':
      return 'bg-sky-950/55 text-sky-100 hover:bg-sky-900/65';
    case 'ARP_REQUEST':
    case 'ARP_REPLY':
      return 'bg-amber-950/50 text-amber-100 hover:bg-amber-900/65';
    case 'DNS_QUERY':
    case 'DNS_RESPONSE':
      return 'bg-cyan-950/55 text-cyan-100 hover:bg-cyan-900/65';
    case 'DHCP_DISCOVER':
    case 'DHCP_OFFER':
    case 'DHCP_REQUEST':
    case 'DHCP_ACK':
      return 'bg-purple-950/50 text-purple-100 hover:bg-purple-900/65';
    case 'SIP_INVITE':
    case 'SIP_200_OK':
    case 'RTP_AUDIO':
      return 'bg-fuchsia-950/50 text-fuchsia-100 hover:bg-fuchsia-900/65';
    case 'RTSP_SETUP':
    case 'RTSP_200_OK':
    case 'RTP_VIDEO':
      return 'bg-teal-950/50 text-teal-100 hover:bg-teal-900/65';
    case 'OSPF_HELLO':
    case 'OSPF_LSA':
      return 'bg-lime-950/50 text-lime-100 hover:bg-lime-900/65';
    case 'STP_BPDU':
    default:
      return 'bg-slate-900/80 text-slate-200 hover:bg-slate-800/80';
  }
}

export function buildHexRows(bytes: number[]): WiresharkHexRow[] {
  const rows: WiresharkHexRow[] = [];
  for (let offset = 0; offset < bytes.length; offset += 16) {
    const slice = bytes.slice(offset, offset + 16);
    const asciiChars = slice.map((b) =>
      b >= 32 && b <= 126 ? String.fromCharCode(b) : '.'
    );
    rows.push({
      offsetHex: offset.toString(16).toUpperCase().padStart(4, '0'),
      startIndex: offset,
      bytes: slice,
      asciiChars,
    });
  }
  return rows;
}

function serializeSinglePdu(
  step: SimulationStep,
  pdu: OsiPduDetails,
  compareInbound?: OsiPduDetails
): {
  bytes: number[];
  sections: WiresharkHeaderSection[];
} {
  const bytes: number[] = [];
  const sections: WiresharkHeaderSection[] = [];

  // 1. L2 Ethernet II + optional 802.1Q Tag
  const dstMacBytes = parseMacToBytes(pdu.l2.dstMac);
  const srcMacBytes = parseMacToBytes(pdu.l2.srcMac);
  const hasVlanTag = pdu.l2.vlanTag !== null && pdu.l2.vlanTag !== undefined;

  const l2StartOffset = 0;
  bytes.push(...dstMacBytes, ...srcMacBytes);

  const l2Fields: WiresharkHeaderField[] = [
    {
      id: 'eth.dst',
      label: 'Destination MAC Address',
      value: `${pdu.l2.dstMac}${pdu.l2.dstMac === 'FF:FF:FF:FF:FF:FF' ? ' (Broadcast)' : ''}`,
      byteOffset: 0,
      byteLength: 6,
      layer: 'L2',
      changedFromInbound:
        compareInbound && compareInbound.l2.dstMac !== pdu.l2.dstMac
          ? compareInbound.l2.dstMac
          : undefined,
    },
    {
      id: 'eth.src',
      label: 'Source MAC Address',
      value: pdu.l2.srcMac,
      byteOffset: 6,
      byteLength: 6,
      layer: 'L2',
      changedFromInbound:
        compareInbound && compareInbound.l2.srcMac !== pdu.l2.srcMac
          ? compareInbound.l2.srcMac
          : undefined,
    },
  ];

  const innerEtherTypeNum = pdu.l2.etherType.startsWith('0x0806')
    ? 0x0806
    : pdu.l2.etherType.startsWith('0x010B')
    ? 0x010b
    : 0x0800;

  if (hasVlanTag) {
    // TPID 0x8100 (2 bytes) + TCI (2 bytes: PRI + DEI + VLAN ID)
    bytes.push(0x81, 0x00);
    const cos =
      step.protocol === 'SIP_INVITE' ||
      step.protocol === 'SIP_200_OK' ||
      step.protocol === 'RTP_AUDIO'
        ? 5
        : step.protocol === 'RTSP_SETUP' ||
          step.protocol === 'RTSP_200_OK' ||
          step.protocol === 'RTP_VIDEO'
        ? 4
        : 0;
    const tci = ((cos & 0x07) << 13) | ((pdu.l2.vlanTag || 1) & 0x0fff);
    bytes.push(...uint16ToBytes(tci));
    bytes.push(...uint16ToBytes(innerEtherTypeNum));

    l2Fields.push(
      {
        id: 'eth.vlan.tpid',
        label: '802.1Q Tag Protocol Identifier (TPID)',
        value: '0x8100 (IEEE 802.1Q Virtual LAN)',
        byteOffset: 12,
        byteLength: 2,
        layer: 'L2',
      },
      {
        id: 'eth.vlan.id',
        label: '802.1Q Tag Control Information (PRI / VLAN ID)',
        value: `PRI (CoS): ${cos} · DEI: 0 · VLAN ID: ${pdu.l2.vlanTag}`,
        byteOffset: 14,
        byteLength: 2,
        layer: 'L2',
        changedFromInbound:
          compareInbound && compareInbound.l2.vlanTag !== pdu.l2.vlanTag
            ? compareInbound.l2.vlanTag === null
              ? 'Untagged'
              : `VLAN ${compareInbound.l2.vlanTag}`
            : undefined,
      },
      {
        id: 'eth.type',
        label: 'Encapsulated EtherType',
        value: pdu.l2.etherType,
        byteOffset: 16,
        byteLength: 2,
        layer: 'L2',
      }
    );
  } else {
    bytes.push(...uint16ToBytes(innerEtherTypeNum));
    l2Fields.push({
      id: 'eth.type',
      label: 'EtherType',
      value: pdu.l2.etherType,
      byteOffset: 12,
      byteLength: 2,
      layer: 'L2',
    });
  }

  const l2Length = bytes.length - l2StartOffset;
  sections.push({
    id: 'section-l2',
    title: hasVlanTag
      ? `Ethernet II + IEEE 802.1Q Tag (VLAN ${pdu.l2.vlanTag}), Src: ${pdu.l2.srcMac}, Dst: ${pdu.l2.dstMac}`
      : `Ethernet II, Src: ${pdu.l2.srcMac}, Dst: ${pdu.l2.dstMac}`,
    summary: pdu.l2.headerType,
    layer: 'L2',
    byteOffset: l2StartOffset,
    byteLength: l2Length,
    fields: l2Fields,
  });

  // 2. Build L7 Payload first (if any) so L3/L4 lengths are exact
  let l7Bytes: number[] = [];
  let l7Fields: WiresharkHeaderField[] = [];
  let l7Title = '';

  if (pdu.l7) {
    const entries = Object.entries(pdu.l7.fields);
    const serializedLines = [
      `${pdu.l7.appProtocol} — ${pdu.l7.headline}`,
      ...entries.map(([k, v]) => `${k}: ${v}`),
    ];
    l7Title = `${pdu.l7.appProtocol} Protocol (${pdu.l7.headline})`;

    let relOffset = 0;
    const rawChunks: number[] = [];
    for (let i = 0; i < serializedLines.length; i++) {
      const lineStr = serializedLines[i] + '\r\n';
      const lineBytes = asciiToBytes(lineStr);
      rawChunks.push(...lineBytes);
      if (i === 0) {
        l7Fields.push({
          id: `l7.headline`,
          label: `${pdu.l7.appProtocol} Headline`,
          value: pdu.l7.headline,
          byteOffset: relOffset, // adjusted after L3/L4 offset is known
          byteLength: lineBytes.length,
          layer: 'L7',
        });
      } else {
        const [k, v] = entries[i - 1];
        l7Fields.push({
          id: `l7.field.${i}`,
          label: k,
          value: v,
          byteOffset: relOffset,
          byteLength: lineBytes.length,
          layer: 'L7',
        });
      }
      relOffset += lineBytes.length;
    }
    l7Bytes = rawChunks;
  }

  // 3. Handle ARP or STP BPDU vs IPv4
  if (pdu.l3.headerType === 'ARP Payload' || step.protocol === 'ARP_REQUEST' || step.protocol === 'ARP_REPLY') {
    const arpStart = bytes.length;
    const isReply = step.protocol === 'ARP_REPLY';
    const senderMacBytes = srcMacBytes;
    const senderIpBytes = parseIpv4ToBytes(pdu.l3.srcIp);
    const targetMacBytes = isReply ? dstMacBytes : [0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
    const targetIpBytes = parseIpv4ToBytes(pdu.l3.dstIp);

    const arpPayload = [
      0x00, 0x01, // Hardware type: Ethernet (1)
      0x08, 0x00, // Protocol type: IPv4 (0x0800)
      0x06, // Hardware size: 6
      0x04, // Protocol size: 4
      0x00, isReply ? 0x02 : 0x01, // Opcode: 1 (request) or 2 (reply)
      ...senderMacBytes,
      ...senderIpBytes,
      ...targetMacBytes,
      ...targetIpBytes,
    ];
    bytes.push(...arpPayload);

    sections.push({
      id: 'section-l3-arp',
      title: `Address Resolution Protocol (${isReply ? 'reply' : 'request'})`,
      summary: pdu.l4.summary,
      layer: 'L3',
      byteOffset: arpStart,
      byteLength: 28,
      fields: [
        {
          id: 'arp.hw.type',
          label: 'Hardware type',
          value: 'Ethernet (1)',
          byteOffset: arpStart,
          byteLength: 2,
          layer: 'L3',
        },
        {
          id: 'arp.proto.type',
          label: 'Protocol type',
          value: 'IPv4 (0x0800)',
          byteOffset: arpStart + 2,
          byteLength: 2,
          layer: 'L3',
        },
        {
          id: 'arp.hw.size',
          label: 'Hardware size / Protocol size',
          value: 'MAC: 6 bytes · IPv4: 4 bytes',
          byteOffset: arpStart + 4,
          byteLength: 2,
          layer: 'L3',
        },
        {
          id: 'arp.opcode',
          label: 'Opcode',
          value: isReply ? 'reply (2)' : 'request (1)',
          byteOffset: arpStart + 6,
          byteLength: 2,
          layer: 'L3',
        },
        {
          id: 'arp.src.hw_mac',
          label: 'Sender MAC address',
          value: pdu.l2.srcMac,
          byteOffset: arpStart + 8,
          byteLength: 6,
          layer: 'L3',
        },
        {
          id: 'arp.src.proto_ipv4',
          label: 'Sender IP address',
          value: pdu.l3.srcIp,
          byteOffset: arpStart + 14,
          byteLength: 4,
          layer: 'L3',
        },
        {
          id: 'arp.dst.hw_mac',
          label: 'Target MAC address',
          value: isReply ? pdu.l2.dstMac : '00:00:00:00:00:00',
          byteOffset: arpStart + 18,
          byteLength: 6,
          layer: 'L3',
        },
        {
          id: 'arp.dst.proto_ipv4',
          label: 'Target IP address',
          value: pdu.l3.dstIp,
          byteOffset: arpStart + 24,
          byteLength: 4,
          layer: 'L3',
        },
      ],
    });
  } else if (step.protocol === 'STP_BPDU') {
    const stpStart = bytes.length;
    const bpduBytes = [
      0x42, 0x42, 0x03, // LLC DSAP=0x42, SSAP=0x42, Control=0x03
      0x00, 0x00, // Protocol ID: Spanning Tree (0x0000)
      0x00, // Version: Spanning Tree (0)
      0x00, // BPDU Type: Configuration (0x00)
      0x00, // Flags
      0x80, 0x00, ...srcMacBytes, // Root Identifier (32768 + MAC)
      0x00, 0x00, 0x00, 0x04, // Root Path Cost
      0x80, 0x00, ...srcMacBytes, // Bridge Identifier
      0x80, 0x01, // Port Identifier
      0x00, 0x00, // Message Age
      0x00, 0x14, // Max Age (20s)
      0x00, 0x02, // Hello Time (2s)
      0x00, 0x0f, // Forward Delay (15s)
    ];
    bytes.push(...bpduBytes);
    sections.push({
      id: 'section-l3-stp',
      title: 'Spanning Tree Protocol (IEEE 802.1D Configuration BPDU)',
      summary: pdu.l4.summary,
      layer: 'L2',
      byteOffset: stpStart,
      byteLength: bpduBytes.length,
      fields: [
        {
          id: 'stp.llc',
          label: 'Logical-Link Control (LLC)',
          value: 'DSAP: Spanning Tree BPDU (0x42), SSAP: 0x42, Ctrl: 0x03',
          byteOffset: stpStart,
          byteLength: 3,
          layer: 'L2',
        },
        {
          id: 'stp.proto',
          label: 'Protocol Identifier & Version',
          value: 'Spanning Tree Protocol (0x0000), Version 0 (802.1D)',
          byteOffset: stpStart + 3,
          byteLength: 4,
          layer: 'L2',
        },
        {
          id: 'stp.root',
          label: 'Root Identifier',
          value: `32768 / 1 / ${pdu.l2.srcMac}`,
          byteOffset: stpStart + 8,
          byteLength: 8,
          layer: 'L2',
        },
        {
          id: 'stp.cost',
          label: 'Root Path Cost',
          value: '4 (1000BASE-T Gigabit)',
          byteOffset: stpStart + 16,
          byteLength: 4,
          layer: 'L2',
        },
        {
          id: 'stp.bridge',
          label: 'Bridge Identifier',
          value: `32768 / 1 / ${pdu.l2.srcMac}`,
          byteOffset: stpStart + 20,
          byteLength: 8,
          layer: 'L2',
        },
        {
          id: 'stp.timers',
          label: 'STP Timers (Hello / Max Age / Forward Delay)',
          value: 'Hello: 2.0s · Max Age: 20.0s · Forward Delay: 15.0s',
          byteOffset: stpStart + 30,
          byteLength: 8,
          layer: 'L2',
        },
      ],
    });
  } else {
    // Standard IPv4 Header (20 bytes) + L4 Header + L7 Payload
    const ipStart = bytes.length;
    const isIcmp =
      step.protocol === 'ICMP_ECHO_REQUEST' ||
      step.protocol === 'ICMP_ECHO_REPLY' ||
      step.protocol === 'ICMP_TIME_EXCEEDED';
    const isTcp =
      step.protocol === 'TCP_SYN' ||
      step.protocol === 'TCP_SYN_ACK' ||
      step.protocol === 'TCP_ACK' ||
      step.protocol === 'HTTP_GET' ||
      step.protocol === 'HTTP_200_OK' ||
      step.protocol === 'RTSP_SETUP' ||
      step.protocol === 'RTSP_200_OK' ||
      step.protocol === 'BGP_OPEN' ||
      step.protocol === 'BGP_UPDATE' ||
      step.protocol === 'BGP_KEEPALIVE';
    const isOspf = step.protocol === 'OSPF_HELLO' || step.protocol === 'OSPF_LSA';
    const isIpsecEsp = step.protocol === 'IPSEC_ESP';

    const ipProtoNum = isIcmp ? 1 : isTcp ? 6 : isOspf ? 89 : isIpsecEsp ? 50 : 17;
    const dscpByte =
      step.protocol === 'SIP_INVITE' ||
      step.protocol === 'SIP_200_OK' ||
      step.protocol === 'RTP_AUDIO'
        ? 46 << 2 // DSCP EF (46)
        : step.protocol === 'RTSP_SETUP' ||
          step.protocol === 'RTSP_200_OK' ||
          step.protocol === 'RTP_VIDEO'
        ? 34 << 2 // DSCP AF41 (34)
        : isOspf ||
          step.protocol === 'BGP_OPEN' ||
          step.protocol === 'BGP_UPDATE' ||
          step.protocol === 'BGP_KEEPALIVE'
        ? 48 << 2 // DSCP CS6 (48)
        : 0x00;

    // Build L4 bytes
    let l4Bytes: number[] = [];
    if (isIcmp) {
      const icmpType =
        step.protocol === 'ICMP_ECHO_REQUEST'
          ? 8
          : step.protocol === 'ICMP_ECHO_REPLY'
          ? 0
          : 11;
      const seqNum = pdu.l4.seqNumber || 1;
      const echoPayload = asciiToBytes('abcdefghijklmnopqrstuvwabcdefghi'); // 32 bytes standard ping payload
      l4Bytes = [
        icmpType,
        0x00, // Code 0
        0x4d,
        (0x5a - seqNum) & 0xff, // Checksum
        0x00,
        0x01, // Identifier (BE)
        ...uint16ToBytes(seqNum),
        ...echoPayload,
      ];
    } else if (isTcp) {
      const srcPort = pdu.l4.srcPort ?? 49152;
      const dstPort = pdu.l4.dstPort ?? 80;
      const seqNum = pdu.l4.seqNumber || 1;
      const ackNum = step.protocol === 'TCP_SYN' ? 0 : 1;
      const tcpFlags =
        step.protocol === 'TCP_SYN'
          ? 0x02 // SYN
          : step.protocol === 'TCP_SYN_ACK'
          ? 0x12 // SYN, ACK
          : step.protocol === 'TCP_ACK'
          ? 0x10 // ACK
          : 0x18; // PSH, ACK
      l4Bytes = [
        ...uint16ToBytes(srcPort),
        ...uint16ToBytes(dstPort),
        ...uint32ToBytes(seqNum),
        ...uint32ToBytes(ackNum),
        0x50, // Header length: 20 bytes (5 * 4)
        tcpFlags,
        0xfa,
        0xf0, // Window size: 64240
        0x9a,
        0x3c, // Checksum
        0x00,
        0x00, // Urgent pointer
      ];
    } else if (isOspf) {
      const routerIpBytes = parseIpv4ToBytes(pdu.l3.srcIp);
      l4Bytes = [
        0x02, // Version: 2
        step.protocol === 'OSPF_HELLO' ? 0x01 : 0x04, // Type: 1 (Hello) or 4 (LS Update)
        0x00,
        0x18, // Packet Length: 24
        ...routerIpBytes, // Router ID
        0x00,
        0x00,
        0x00,
        0x00, // Area 0.0.0.0
        0xc4,
        0x12, // Checksum
        0x00,
        0x00, // Auth Type: Null
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
      ];
    } else {
      // UDP (8 bytes)
      const srcPort = pdu.l4.srcPort ?? 53000;
      const dstPort = pdu.l4.dstPort ?? 53;
      const udpTotalLen = 8 + l7Bytes.length;
      l4Bytes = [
        ...uint16ToBytes(srcPort),
        ...uint16ToBytes(dstPort),
        ...uint16ToBytes(udpTotalLen),
        0x7e,
        0x19, // Checksum
      ];
    }

    const ipv4TotalLen = 20 + l4Bytes.length + l7Bytes.length;
    const identification = 0x1a00 + (step.stepIndex & 0xff);
    const ttl = Math.max(0, Math.min(255, pdu.l3.ttl || 64));
    const srcIpBytes = parseIpv4ToBytes(pdu.l3.srcIp);
    const dstIpBytes = parseIpv4ToBytes(pdu.l3.dstIp);

    const ipHeader20 = [
      0x45, // Version 4, IHL 5 (20 bytes)
      dscpByte,
      ...uint16ToBytes(ipv4TotalLen),
      ...uint16ToBytes(identification),
      0x40,
      0x00, // Flags: Don't Fragment (0x4000)
      ttl,
      ipProtoNum,
      0x00,
      0x00, // Checksum placeholder
      ...srcIpBytes,
      ...dstIpBytes,
    ];
    const ipChecksum = computeIpv4Checksum(ipHeader20);
    ipHeader20[10] = (ipChecksum >> 8) & 0xff;
    ipHeader20[11] = ipChecksum & 0xff;

    bytes.push(...ipHeader20);

    const dscpLabel =
      dscpByte === 46 << 2
        ? 'DSCP: EF (46) Expedited Forwarding · ECN: 0'
        : dscpByte === 34 << 2
        ? 'DSCP: AF41 (34) Assured Forwarding · ECN: 0'
        : dscpByte === 48 << 2
        ? 'DSCP: CS6 (48) Internetwork Control · ECN: 0'
        : 'DSCP: CS0 (0) Best Effort · ECN: 0';

    sections.push({
      id: 'section-l3-ipv4',
      title: `Internet Protocol Version 4, Src: ${pdu.l3.srcIp}, Dst: ${pdu.l3.dstIp}`,
      summary: `${pdu.l3.protocol} · TTL ${ttl}`,
      layer: 'L3',
      byteOffset: ipStart,
      byteLength: 20,
      fields: [
        {
          id: 'ip.version_ihl',
          label: 'Version & Header Length (IHL)',
          value: '0100 .... = Version: 4 · .... 0101 = Header Length: 20 bytes (5)',
          byteOffset: ipStart,
          byteLength: 1,
          layer: 'L3',
        },
        {
          id: 'ip.dsfield',
          label: 'Differentiated Services Field (QoS)',
          value: dscpLabel,
          byteOffset: ipStart + 1,
          byteLength: 1,
          layer: 'L3',
        },
        {
          id: 'ip.len',
          label: 'Total Length',
          value: `${ipv4TotalLen} bytes`,
          byteOffset: ipStart + 2,
          byteLength: 2,
          layer: 'L3',
        },
        {
          id: 'ip.id',
          label: 'Identification',
          value: `${formatHex16(identification)} (${identification})`,
          byteOffset: ipStart + 4,
          byteLength: 2,
          layer: 'L3',
        },
        {
          id: 'ip.flags',
          label: 'Flags & Fragment Offset',
          value: '0x4000, Don\'t fragment (DF = 1, MF = 0, Offset = 0)',
          byteOffset: ipStart + 6,
          byteLength: 2,
          layer: 'L3',
        },
        {
          id: 'ip.ttl',
          label: 'Time to Live (TTL)',
          value: `${ttl} hops`,
          byteOffset: ipStart + 8,
          byteLength: 1,
          layer: 'L3',
          changedFromInbound:
            compareInbound && compareInbound.l3.ttl !== pdu.l3.ttl
              ? `${compareInbound.l3.ttl} hops`
              : undefined,
        },
        {
          id: 'ip.proto',
          label: 'Protocol',
          value: `${pdu.l3.protocol} (${ipProtoNum})`,
          byteOffset: ipStart + 9,
          byteLength: 1,
          layer: 'L3',
        },
        {
          id: 'ip.checksum',
          label: 'Header Checksum',
          value: `${formatHex16(ipChecksum)} [validation enabled: Good]`,
          byteOffset: ipStart + 10,
          byteLength: 2,
          layer: 'L3',
        },
        {
          id: 'ip.src',
          label: 'Source Address',
          value: pdu.l3.srcIp,
          byteOffset: ipStart + 12,
          byteLength: 4,
          layer: 'L3',
          changedFromInbound:
            compareInbound && compareInbound.l3.srcIp !== pdu.l3.srcIp
              ? compareInbound.l3.srcIp
              : undefined,
        },
        {
          id: 'ip.dst',
          label: 'Destination Address',
          value: pdu.l3.dstIp,
          byteOffset: ipStart + 16,
          byteLength: 4,
          layer: 'L3',
          changedFromInbound:
            compareInbound && compareInbound.l3.dstIp !== pdu.l3.dstIp
              ? compareInbound.l3.dstIp
              : undefined,
        },
      ],
    });

    // Push L4 section
    const l4Start = bytes.length;
    bytes.push(...l4Bytes);

    if (isIcmp) {
      const icmpType = l4Bytes[0];
      const icmpLabel =
        icmpType === 8
          ? '8 (Echo (ping) request)'
          : icmpType === 0
          ? '0 (Echo (ping) reply)'
          : '11 (Time-to-live exceeded)';
      sections.push({
        id: 'section-l4-icmp',
        title: `Internet Control Message Protocol (${pdu.l4.summary})`,
        summary: pdu.l4.summary,
        layer: 'L4',
        byteOffset: l4Start,
        byteLength: l4Bytes.length,
        fields: [
          {
            id: 'icmp.type',
            label: 'Type',
            value: icmpLabel,
            byteOffset: l4Start,
            byteLength: 1,
            layer: 'L4',
          },
          {
            id: 'icmp.code',
            label: 'Code',
            value: '0',
            byteOffset: l4Start + 1,
            byteLength: 1,
            layer: 'L4',
          },
          {
            id: 'icmp.checksum',
            label: 'Checksum',
            value: `${formatHex16((l4Bytes[2] << 8) | l4Bytes[3])} [correct]`,
            byteOffset: l4Start + 2,
            byteLength: 2,
            layer: 'L4',
          },
          {
            id: 'icmp.ident',
            label: 'Identifier (BE)',
            value: '0x0001 (1)',
            byteOffset: l4Start + 4,
            byteLength: 2,
            layer: 'L4',
          },
          {
            id: 'icmp.seq',
            label: 'Sequence Number (BE)',
            value: `${pdu.l4.seqNumber || 1}`,
            byteOffset: l4Start + 6,
            byteLength: 2,
            layer: 'L4',
          },
          {
            id: 'icmp.data',
            label: 'Data (32 bytes)',
            value: 'abcdefghijklmnopqrstuvwabcdefghi',
            byteOffset: l4Start + 8,
            byteLength: 32,
            layer: 'L4',
          },
        ],
      });
    } else if (isTcp) {
      const srcPort = pdu.l4.srcPort ?? 49152;
      const dstPort = pdu.l4.dstPort ?? 80;
      const flagStr =
        step.protocol === 'TCP_SYN'
          ? '0x002 (SYN)'
          : step.protocol === 'TCP_SYN_ACK'
          ? '0x012 (SYN, ACK)'
          : step.protocol === 'TCP_ACK'
          ? '0x010 (ACK)'
          : '0x018 (PSH, ACK)';
      sections.push({
        id: 'section-l4-tcp',
        title: `Transmission Control Protocol, Src Port: ${srcPort}, Dst Port: ${dstPort}, Seq: ${pdu.l4.seqNumber}`,
        summary: pdu.l4.summary,
        layer: 'L4',
        byteOffset: l4Start,
        byteLength: l4Bytes.length,
        fields: [
          {
            id: 'tcp.srcport',
            label: 'Source Port',
            value: `${srcPort}`,
            byteOffset: l4Start,
            byteLength: 2,
            layer: 'L4',
            changedFromInbound:
              compareInbound &&
              compareInbound.l4.srcPort !== undefined &&
              compareInbound.l4.srcPort !== pdu.l4.srcPort
                ? `${compareInbound.l4.srcPort}`
                : undefined,
          },
          {
            id: 'tcp.dstport',
            label: 'Destination Port',
            value: `${dstPort}`,
            byteOffset: l4Start + 2,
            byteLength: 2,
            layer: 'L4',
            changedFromInbound:
              compareInbound &&
              compareInbound.l4.dstPort !== undefined &&
              compareInbound.l4.dstPort !== pdu.l4.dstPort
                ? `${compareInbound.l4.dstPort}`
                : undefined,
          },
          {
            id: 'tcp.seq',
            label: 'Sequence Number (raw)',
            value: `${pdu.l4.seqNumber || 1}`,
            byteOffset: l4Start + 4,
            byteLength: 4,
            layer: 'L4',
          },
          {
            id: 'tcp.ack',
            label: 'Acknowledgment Number',
            value: `${step.protocol === 'TCP_SYN' ? 0 : 1}`,
            byteOffset: l4Start + 8,
            byteLength: 4,
            layer: 'L4',
          },
          {
            id: 'tcp.flags',
            label: 'Header Length & Flags',
            value: `Header: 20 bytes · Flags: ${flagStr}`,
            byteOffset: l4Start + 12,
            byteLength: 2,
            layer: 'L4',
          },
          {
            id: 'tcp.window_size',
            label: 'Window',
            value: '64240',
            byteOffset: l4Start + 14,
            byteLength: 2,
            layer: 'L4',
          },
          {
            id: 'tcp.checksum',
            label: 'Checksum',
            value: '0x9A3C [unverified]',
            byteOffset: l4Start + 16,
            byteLength: 2,
            layer: 'L4',
          },
        ],
      });
    } else if (isOspf) {
      sections.push({
        id: 'section-l4-ospf',
        title: `Open Shortest Path First (OSPFv2 ${
          step.protocol === 'OSPF_HELLO' ? 'Hello Packet' : 'LS Update'
        })`,
        summary: pdu.l4.summary,
        layer: 'L4',
        byteOffset: l4Start,
        byteLength: l4Bytes.length,
        fields: [
          {
            id: 'ospf.version_type',
            label: 'OSPF Version & Message Type',
            value: `Version 2 · Type: ${
              step.protocol === 'OSPF_HELLO' ? 'Hello Packet (1)' : 'LS Update (4)'
            }`,
            byteOffset: l4Start,
            byteLength: 2,
            layer: 'L4',
          },
          {
            id: 'ospf.router_id',
            label: 'Source OSPF Router ID',
            value: pdu.l3.srcIp,
            byteOffset: l4Start + 4,
            byteLength: 4,
            layer: 'L4',
          },
          {
            id: 'ospf.area_id',
            label: 'Area ID',
            value: '0.0.0.0 (Backbone)',
            byteOffset: l4Start + 8,
            byteLength: 4,
            layer: 'L4',
          },
        ],
      });
    } else {
      const srcPort = pdu.l4.srcPort ?? 53000;
      const dstPort = pdu.l4.dstPort ?? 53;
      sections.push({
        id: 'section-l4-udp',
        title: `User Datagram Protocol, Src Port: ${srcPort}, Dst Port: ${dstPort}`,
        summary: pdu.l4.summary,
        layer: 'L4',
        byteOffset: l4Start,
        byteLength: l4Bytes.length,
        fields: [
          {
            id: 'udp.srcport',
            label: 'Source Port',
            value: `${srcPort}`,
            byteOffset: l4Start,
            byteLength: 2,
            layer: 'L4',
          },
          {
            id: 'udp.dstport',
            label: 'Destination Port',
            value: `${dstPort}`,
            byteOffset: l4Start + 2,
            byteLength: 2,
            layer: 'L4',
          },
          {
            id: 'udp.length',
            label: 'Length',
            value: `${8 + l7Bytes.length} bytes`,
            byteOffset: l4Start + 4,
            byteLength: 2,
            layer: 'L4',
          },
          {
            id: 'udp.checksum',
            label: 'Checksum',
            value: '0x7E19 [correct]',
            byteOffset: l4Start + 6,
            byteLength: 2,
            layer: 'L4',
          },
        ],
      });
    }

    // Push L7 section if present
    if (l7Bytes.length > 0 && pdu.l7) {
      const l7Start = bytes.length;
      bytes.push(...l7Bytes);
      const adjustedL7Fields = l7Fields.map((f) => ({
        ...f,
        byteOffset: l7Start + f.byteOffset,
      }));
      sections.push({
        id: 'section-l7',
        title: l7Title,
        summary: pdu.l7.headline,
        layer: 'L7',
        byteOffset: l7Start,
        byteLength: l7Bytes.length,
        fields: adjustedL7Fields,
      });
    }
  }

  // Prepend Frame (L1 Physical Meta) section covering the entire frame [0..bytes.length]
  const totalBytes = bytes.length;
  const gponAction = step.osiActions.find(
    (a) =>
      a.title.includes('GPON') ||
      a.title.includes('1490') ||
      a.title.includes('1310') ||
      a.detail.includes('dBm')
  );
  const frameSection: WiresharkHeaderSection = {
    id: 'section-l1-frame',
    title: `Frame ${step.stepIndex}: ${totalBytes} bytes on wire (${
      totalBytes * 8
    } bits), captured on ${step.fromNodeName}:${step.fromPortName} → ${step.toNodeName}:${step.toPortName}`,
    summary: `${pdu.l1.cableType} · ${pdu.l1.physicalStatus}`,
    layer: 'L1',
    byteOffset: 0,
    byteLength: totalBytes,
    fields: [
      {
        id: 'frame.interface',
        label: 'Interface & Link Direction',
        value: `${step.fromNodeName}:${step.fromPortName} → ${step.toNodeName}:${step.toPortName} (${pdu.l1.cableType})`,
        byteOffset: 0,
        byteLength: totalBytes,
        layer: 'L1',
      },
      {
        id: 'frame.physical_status',
        label: 'Physical Layer Status (L1)',
        value: gponAction
          ? `${pdu.l1.physicalStatus} · ${gponAction.title}`
          : pdu.l1.physicalStatus,
        byteOffset: 0,
        byteLength: totalBytes,
        layer: 'L1',
      },
      {
        id: 'frame.time_relative',
        label: 'Time since reference or first frame',
        value: `${(step.timestampMs / 1000).toFixed(6)} seconds`,
        byteOffset: 0,
        byteLength: totalBytes,
        layer: 'L1',
      },
      {
        id: 'frame.len',
        label: 'Frame Length',
        value: `${totalBytes} bytes (${totalBytes * 8} bits)`,
        byteOffset: 0,
        byteLength: totalBytes,
        layer: 'L1',
      },
      {
        id: 'frame.protocols',
        label: 'Protocols in frame',
        value: [
          'eth',
          hasVlanTag ? 'vlan' : null,
          pdu.l3.headerType === 'ARP Payload' ? 'arp' : 'ip',
          step.protocol.toLowerCase(),
        ]
          .filter(Boolean)
          .join(':'),
        byteOffset: 0,
        byteLength: totalBytes,
        layer: 'L1',
      },
    ],
  };

  return {
    bytes,
    sections: [frameSection, ...sections],
  };
}

/**
 * Dissects a SimulationStep into a complete Wireshark-style packet structure
 * with L1-L7 expandable header tree, byte offsets, Hex/ASCII rows, and Inbound/Outbound byte diff.
 */
export function dissectStepForWireshark(
  step: SimulationStep,
  direction: 'outbound' | 'inbound' = 'outbound'
): WiresharkDissectedPacket {
  const activePdu = direction === 'inbound' ? step.inboundPdu : step.outboundPdu;
  const comparePdu = direction === 'outbound' ? step.inboundPdu : undefined;

  const { bytes, sections } = serializeSinglePdu(step, activePdu, comparePdu);
  const inboundSerialized = serializeSinglePdu(step, step.inboundPdu);
  const outboundSerialized =
    direction === 'outbound'
      ? { bytes, sections }
      : serializeSinglePdu(step, step.outboundPdu, step.inboundPdu);

  const changedByteOffsets: number[] = [];
  const maxLen = Math.max(
    inboundSerialized.bytes.length,
    outboundSerialized.bytes.length
  );
  for (let i = 0; i < maxLen; i++) {
    if (inboundSerialized.bytes[i] !== outboundSerialized.bytes[i]) {
      changedByteOffsets.push(i);
    }
  }

  const diffSummaryItems: WiresharkDissectedPacket['diffSummaryItems'] = [];
  if (step.inboundPdu.l2.srcMac !== step.outboundPdu.l2.srcMac) {
    diffSummaryItems.push({
      fieldLabel: 'Ethernet Src MAC',
      before: step.inboundPdu.l2.srcMac,
      after: step.outboundPdu.l2.srcMac,
      layer: 'L2',
    });
  }
  if (step.inboundPdu.l2.dstMac !== step.outboundPdu.l2.dstMac) {
    diffSummaryItems.push({
      fieldLabel: 'Ethernet Dst MAC',
      before: step.inboundPdu.l2.dstMac,
      after: step.outboundPdu.l2.dstMac,
      layer: 'L2',
    });
  }
  if (step.inboundPdu.l2.vlanTag !== step.outboundPdu.l2.vlanTag) {
    diffSummaryItems.push({
      fieldLabel: '802.1Q VLAN Tag',
      before:
        step.inboundPdu.l2.vlanTag !== null
          ? `VLAN ${step.inboundPdu.l2.vlanTag}`
          : 'Untagged',
      after:
        step.outboundPdu.l2.vlanTag !== null
          ? `VLAN ${step.outboundPdu.l2.vlanTag}`
          : 'Untagged',
      layer: 'L2',
    });
  }
  if (step.inboundPdu.l3.srcIp !== step.outboundPdu.l3.srcIp) {
    diffSummaryItems.push({
      fieldLabel: 'IPv4 Source IP (NAT/PAT)',
      before: step.inboundPdu.l3.srcIp,
      after: step.outboundPdu.l3.srcIp,
      layer: 'L3',
    });
  }
  if (step.inboundPdu.l3.dstIp !== step.outboundPdu.l3.dstIp) {
    diffSummaryItems.push({
      fieldLabel: 'IPv4 Destination IP (DNAT)',
      before: step.inboundPdu.l3.dstIp,
      after: step.outboundPdu.l3.dstIp,
      layer: 'L3',
    });
  }
  if (step.inboundPdu.l3.ttl !== step.outboundPdu.l3.ttl) {
    diffSummaryItems.push({
      fieldLabel: 'IPv4 Time to Live (TTL)',
      before: `${step.inboundPdu.l3.ttl}`,
      after: `${step.outboundPdu.l3.ttl}`,
      layer: 'L3',
    });
  }

  const isArpOrStp =
    step.protocol === 'ARP_REQUEST' ||
    step.protocol === 'ARP_REPLY' ||
    step.protocol === 'STP_BPDU';

  const source =
    isArpOrStp || !activePdu.l3.srcIp || activePdu.l3.srcIp === '0.0.0.0'
      ? activePdu.l2.srcMac
      : activePdu.l3.srcIp;
  const destination =
    isArpOrStp || !activePdu.l3.dstIp
      ? activePdu.l2.dstMac
      : activePdu.l3.dstIp;

  const infoSummary = activePdu.l7
    ? `${activePdu.l7.headline} (${step.fromNodeName}:${step.fromPortName} → ${step.toNodeName}:${step.toPortName})`
    : `${activePdu.l4.summary} (${step.fromNodeName}:${step.fromPortName} → ${step.toNodeName}:${step.toPortName})`;

  return {
    stepId: step.id,
    stepIndex: step.stepIndex,
    timeSeconds: (step.timestampMs / 1000).toFixed(3),
    source,
    destination,
    protocolLabel: step.protocol.replace(/_/g, ' '),
    lengthBytes: bytes.length,
    vlanTag: activePdu.l2.vlanTag,
    infoSummary,
    colorClass: getWiresharkRowColorClass(step.protocol, step.status === 'dropped'),
    isDropped: step.status === 'dropped',
    bytes,
    hexRows: buildHexRows(bytes),
    sections,
    changedByteOffsets,
    diffSummaryItems,
  };
}

const VALID_FILTER_PROTOCOLS = new Set([
  'icmp',
  'arp',
  'tcp',
  'udp',
  'http',
  'dns',
  'dhcp',
  'ospf',
  'bgp',
  'sip',
  'rtp',
  'rtsp',
  'stp',
  'capwap',
  'ipsec',
  'ikev2',
  'dropped',
]);

const VALID_FILTER_LHS = new Set([
  'ip.addr',
  'ip.src',
  'ip.dst',
  'eth.addr',
  'eth.src',
  'eth.dst',
  'tcp.port',
  'udp.port',
  'port',
  'vlan.id',
  'vlan',
  'node',
  'frame.dropped',
  'frame.number',
]);

function evaluateSingleClause(step: SimulationStep, rawClause: string): boolean {
  let clause = rawClause.trim();
  if (!clause) return true;

  let negate = false;
  while (clause.startsWith('!')) {
    negate = !negate;
    clause = clause.slice(1).trim();
  }
  if (clause.toLowerCase().startsWith('not ')) {
    negate = !negate;
    clause = clause.slice(4).trim();
  }

  const pdu = step.outboundPdu;
  const inPdu = step.inboundPdu;
  const protoLower = step.protocol.toLowerCase();
  const appProtoLower = (pdu.l7?.appProtocol || '').toLowerCase();

  const applyNeg = (val: boolean) => (negate ? !val : val);

  // Check comparison expression: lhs == rhs or lhs != rhs
  const compMatch = clause.match(/^([a-zA-Z0-9_.]+)\s*(==|!=|=)\s*(.+)$/);
  if (compMatch) {
    const lhs = compMatch[1].toLowerCase();
    const op = compMatch[2];
    const rhs = compMatch[3].trim().replace(/^["']|["']$/g, '').toLowerCase();

    let match = false;
    switch (lhs) {
      case 'ip.addr':
        match =
          pdu.l3.srcIp.toLowerCase() === rhs ||
          pdu.l3.dstIp.toLowerCase() === rhs ||
          inPdu.l3.srcIp.toLowerCase() === rhs ||
          inPdu.l3.dstIp.toLowerCase() === rhs;
        break;
      case 'ip.src':
        match =
          pdu.l3.srcIp.toLowerCase() === rhs ||
          inPdu.l3.srcIp.toLowerCase() === rhs;
        break;
      case 'ip.dst':
        match =
          pdu.l3.dstIp.toLowerCase() === rhs ||
          inPdu.l3.dstIp.toLowerCase() === rhs;
        break;
      case 'eth.addr':
        match =
          pdu.l2.srcMac.toLowerCase() === rhs ||
          pdu.l2.dstMac.toLowerCase() === rhs ||
          inPdu.l2.srcMac.toLowerCase() === rhs ||
          inPdu.l2.dstMac.toLowerCase() === rhs;
        break;
      case 'eth.src':
        match =
          pdu.l2.srcMac.toLowerCase() === rhs ||
          inPdu.l2.srcMac.toLowerCase() === rhs;
        break;
      case 'eth.dst':
        match =
          pdu.l2.dstMac.toLowerCase() === rhs ||
          inPdu.l2.dstMac.toLowerCase() === rhs;
        break;
      case 'tcp.port':
      case 'udp.port':
      case 'port': {
        const portNum = Number(rhs);
        match =
          pdu.l4.srcPort === portNum ||
          pdu.l4.dstPort === portNum ||
          inPdu.l4.srcPort === portNum ||
          inPdu.l4.dstPort === portNum;
        break;
      }
      case 'vlan.id':
      case 'vlan': {
        const vlanNum = Number(rhs);
        match =
          pdu.l2.vlanTag === vlanNum ||
          inPdu.l2.vlanTag === vlanNum ||
          step.vlanTag === vlanNum;
        break;
      }
      case 'node':
        match =
          step.fromNodeName.toLowerCase().includes(rhs) ||
          step.toNodeName.toLowerCase().includes(rhs) ||
          step.fromNodeId.toLowerCase() === rhs ||
          step.toNodeId.toLowerCase() === rhs;
        break;
      case 'frame.number':
        match = step.stepIndex === Number(rhs);
        break;
      default:
        match = false;
    }

    if (op === '!=') match = !match;
    return applyNeg(match);
  }

  // Standalone keyword / protocol check
  const kw = clause.toLowerCase();
  if (kw === 'frame.dropped' || kw === 'dropped') {
    return applyNeg(step.status === 'dropped');
  }
  if (kw === 'icmp') {
    return applyNeg(protoLower.startsWith('icmp'));
  }
  if (kw === 'arp') {
    return applyNeg(protoLower.startsWith('arp'));
  }
  if (kw === 'tcp') {
    return applyNeg(
      protoLower.startsWith('tcp') ||
        protoLower.startsWith('http') ||
        protoLower.startsWith('bgp') ||
        protoLower.startsWith('rtsp')
    );
  }
  if (kw === 'udp') {
    return applyNeg(
      protoLower.startsWith('dns') ||
        protoLower.startsWith('dhcp') ||
        protoLower.startsWith('sip') ||
        protoLower.startsWith('rtp') ||
        protoLower.startsWith('capwap')
    );
  }
  if (kw === 'http') {
    return applyNeg(protoLower.startsWith('http') || appProtoLower === 'http');
  }
  if (kw === 'dns') {
    return applyNeg(protoLower.startsWith('dns') || appProtoLower === 'dns');
  }
  if (kw === 'dhcp') {
    return applyNeg(protoLower.startsWith('dhcp') || appProtoLower === 'dhcp');
  }
  if (kw === 'ospf') {
    return applyNeg(protoLower.startsWith('ospf') || appProtoLower === 'ospf');
  }
  if (kw === 'bgp') {
    return applyNeg(protoLower.startsWith('bgp') || appProtoLower === 'bgp');
  }
  if (kw === 'sip') {
    return applyNeg(protoLower.startsWith('sip') || appProtoLower === 'sip');
  }
  if (kw === 'rtp') {
    return applyNeg(protoLower.startsWith('rtp') || appProtoLower === 'rtp');
  }
  if (kw === 'rtsp') {
    return applyNeg(protoLower.startsWith('rtsp') || appProtoLower === 'rtsp');
  }
  if (kw === 'stp') {
    return applyNeg(protoLower.startsWith('stp'));
  }
  if (kw === 'capwap') {
    return applyNeg(protoLower.startsWith('capwap'));
  }
  if (kw === 'ipsec' || kw === 'ikev2') {
    return applyNeg(protoLower.startsWith('ipsec') || protoLower.startsWith('ikev2'));
  }

  // Fallback substring search across IP, MAC, Node, Summary
  const haystack = [
    step.protocol,
    step.fromNodeName,
    step.toNodeName,
    pdu.l3.srcIp,
    pdu.l3.dstIp,
    pdu.l2.srcMac,
    pdu.l2.dstMac,
    pdu.l4.summary,
    pdu.l7?.headline || '',
  ]
    .join(' ')
    .toLowerCase();
  return applyNeg(haystack.includes(kw));
}

export function validateWiresharkDisplayFilter(expression: string): {
  valid: boolean;
  error?: string;
} {
  const trimmed = expression.trim();
  if (!trimmed) return { valid: true };

  const orGroups = trimmed.split(/\s*(?:\|\||\bor\b)\s*/i);
  for (const orPart of orGroups) {
    const andClauses = orPart.split(/\s*(?:&&|\band\b)\s*/i);
    for (const rawClause of andClauses) {
      let c = rawClause.trim().replace(/^\(+|\)+$/g, '').trim();
      while (c.startsWith('!')) c = c.slice(1).trim();
      if (c.toLowerCase().startsWith('not ')) c = c.slice(4).trim();
      if (!c) {
        return { valid: false, error: 'Незавершённое логическое выражение фильтра' };
      }

      const compMatch = c.match(/^([a-zA-Z0-9_.]+)\s*(==|!=|=)\s*(.+)$/);
      if (compMatch) {
        const lhs = compMatch[1].toLowerCase();
        const rhs = compMatch[3].trim();
        if (!VALID_FILTER_LHS.has(lhs)) {
          return {
            valid: false,
            error: `Неизвестное поле "${lhs}". Доступны: ip.addr, ip.src, ip.dst, eth.addr, tcp.port, udp.port, vlan.id, node`,
          };
        }
        if (!rhs) {
          return { valid: false, error: `Укажите значение после оператора для ${lhs}` };
        }
        continue;
      }

      const kw = c.toLowerCase();
      if (VALID_FILTER_PROTOCOLS.has(kw) || VALID_FILTER_LHS.has(kw)) {
        continue;
      }

      // If it contains invalid operators like "===" or lone "="
      if (/[<>~=]/.test(c)) {
        return {
          valid: false,
          error: `Некорректный синтаксис "${c}". Пример: ip.addr == 192.168.1.10 && icmp`,
        };
      }
    }
  }
  return { valid: true };
}

/**
 * Evaluates a Wireshark Display Filter expression (supporting &&, ||, !, ==, !=, protocol keywords)
 * against a SimulationStep.
 */
export function evaluateWiresharkDisplayFilter(
  step: SimulationStep,
  expression: string
): boolean {
  const trimmed = expression.trim();
  if (!trimmed) return true;

  const orGroups = trimmed.split(/\s*(?:\|\||\bor\b)\s*/i);
  return orGroups.some((orPart) => {
    const andClauses = orPart.split(/\s*(?:&&|\band\b)\s*/i);
    return andClauses.every((clause) =>
      evaluateSingleClause(step, clause.replace(/^\(+|\)+$/g, ''))
    );
  });
}

/**
 * Reconstructs a Wireshark "Follow TCP / UDP / HTTP / SIP / ICMP Stream" dialog
 * for the conversation containing `selectedStep`.
 */
export function buildFollowStreamDialog(
  allSteps: SimulationStep[],
  selectedStep: SimulationStep
): FollowStreamDialog {
  const selPdu = selectedStep.outboundPdu;
  const ipA = selPdu.l3.srcIp || selectedStep.fromNodeName;
  const ipB = selPdu.l3.dstIp || selectedStep.toNodeName;

  const isSameIpPair = (s: SimulationStep) => {
    const sSrc = s.outboundPdu.l3.srcIp || s.fromNodeName;
    const sDst = s.outboundPdu.l3.dstIp || s.toNodeName;
    const inSrc = s.inboundPdu.l3.srcIp;
    const inDst = s.inboundPdu.l3.dstIp;
    return (
      (sSrc === ipA && sDst === ipB) ||
      (sSrc === ipB && sDst === ipA) ||
      (inSrc === ipA && inDst === ipB) ||
      (inSrc === ipB && inDst === ipA)
    );
  };

  const isDhcpFlow = selectedStep.protocol.startsWith('DHCP');
  const isSipOrVoipFlow =
    selectedStep.protocol.startsWith('SIP') || selectedStep.protocol.startsWith('RTP_AUDIO');
  const isHttpOrTcpFlow =
    selectedStep.protocol.startsWith('HTTP') || selectedStep.protocol.startsWith('TCP');
  const isDnsFlow = selectedStep.protocol.startsWith('DNS');

  // Filter steps belonging to this logical stream and deduplicate intermediate L2 hops
  // so the stream shows meaningful endpoint-to-endpoint / server-to-client exchanges
  const relatedSteps = allSteps.filter((s) => {
    if (isDhcpFlow) return s.protocol.startsWith('DHCP');
    if (isSipOrVoipFlow) {
      return s.protocol.startsWith('SIP') || s.protocol.startsWith('RTP_AUDIO');
    }
    if (isDnsFlow) return s.protocol.startsWith('DNS');
    if (isHttpOrTcpFlow) {
      return (
        (s.protocol.startsWith('HTTP') || s.protocol.startsWith('TCP')) &&
        isSameIpPair(s)
      );
    }
    return isSameIpPair(s) && s.protocol !== 'ARP_REQUEST' && s.protocol !== 'ARP_REPLY';
  });

  // Deduplicate by (protocol + seqNumber + l7.headline) preferring 'delivered' or final hop
  const seenKeys = new Map<string, SimulationStep>();
  for (const s of relatedSteps.length > 0 ? relatedSteps : [selectedStep]) {
    const key = `${s.protocol}:${s.outboundPdu.l4.seqNumber}:${
      s.outboundPdu.l7?.headline || s.outboundPdu.l4.summary
    }`;
    const existing = seenKeys.get(key);
    if (!existing || s.status === 'delivered' || s.stepIndex > existing.stepIndex) {
      seenKeys.set(key, s);
    }
  }

  const streamSteps = Array.from(seenKeys.values()).sort(
    (a, b) => a.stepIndex - b.stepIndex
  );
  const first = streamSteps[0] || selectedStep;
  const clientIp = first.inboundPdu.l3.srcIp || first.fromNodeName;
  const serverIp = first.outboundPdu.l3.dstIp || first.toNodeName;

  let totalBytes = 0;
  const messages: FollowStreamMessage[] = streamSteps.map((st) => {
    const pdu = st.outboundPdu;
    const isClientToServer =
      pdu.l3.srcIp === clientIp ||
      st.inboundPdu.l3.srcIp === clientIp ||
      st.protocol === 'DHCP_DISCOVER' ||
      st.protocol === 'DHCP_REQUEST' ||
      st.protocol === 'DNS_QUERY' ||
      st.protocol === 'TCP_SYN' ||
      st.protocol === 'HTTP_GET' ||
      st.protocol === 'ICMP_ECHO_REQUEST' ||
      st.protocol === 'SIP_INVITE' ||
      st.protocol === 'RTSP_SETUP';

    let rawLines: string[] = [];
    if (pdu.l7) {
      rawLines.push(`${pdu.l7.headline}`);
      for (const [k, v] of Object.entries(pdu.l7.fields)) {
        rawLines.push(`${k}: ${v}`);
      }
    } else {
      rawLines.push(`${st.protocol}: ${pdu.l4.summary}`);
      rawLines.push(
        `IPv4: ${pdu.l3.srcIp} → ${pdu.l3.dstIp} (TTL=${pdu.l3.ttl}, Proto=${pdu.l3.protocol})`
      );
      rawLines.push(`Ethernet: ${pdu.l2.srcMac} → ${pdu.l2.dstMac}`);
    }

    const rawText = rawLines.join('\n');
    const byteCount = rawText.length + 54;
    totalBytes += byteCount;

    return {
      stepIndex: st.stepIndex,
      timeSeconds: (st.timestampMs / 1000).toFixed(3),
      direction: isClientToServer ? 'client_to_server' : 'server_to_client',
      senderLabel: `${st.fromNodeName} (${pdu.l3.srcIp || pdu.l2.srcMac})`,
      receiverLabel: `${st.toNodeName} (${pdu.l3.dstIp || pdu.l2.dstMac})`,
      protocol: st.protocol,
      headline: pdu.l7?.headline || pdu.l4.summary,
      rawText,
      byteCount,
    };
  });

  const streamProtocol = isHttpOrTcpFlow
    ? 'TCP / HTTP Stream'
    : isSipOrVoipFlow
    ? 'SIP / RTP VoIP Stream'
    : isDhcpFlow
    ? 'UDP / DHCP DORA Stream'
    : isDnsFlow
    ? 'UDP / DNS Stream'
    : `${selectedStep.protocol} Stream`;

  return {
    streamTitle: `Follow ${streamProtocol} (${clientIp} ↔ ${serverIp})`,
    streamProtocol,
    clientEndpoint: clientIp,
    serverEndpoint: serverIp,
    totalPackets: messages.length,
    totalBytes,
    messages,
  };
}
