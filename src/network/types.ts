export type DeviceType = 'router' | 'switch' | 'pc' | 'server';

export type VlanMode = 'access' | 'trunk';

export type CableType = 'straight' | 'crossover' | 'fiber';

export interface NetworkInterface {
  id: string;
  name: string; // e.g., 'Fa0/0', 'Gi0/1', 'Eth0'
  shortName: string; // e.g., 'Fa0/0'
  macAddress: string;
  ipAddress: string; // e.g., '192.168.1.1' or ''
  subnetMask: string; // e.g., '255.255.255.0' or ''
  adminStatus: 'up' | 'down';
  vlanMode: VlanMode;
  accessVlan: number; // default 1
  trunkAllowedVlans: number[]; // e.g., [1, 10, 20, 30]
  subinterfaces?: {
    vlanId: number;
    ipAddress: string;
    subnetMask: string;
  }[];
}

export interface RouteEntry {
  id: string;
  network: string; // e.g., '192.168.2.0'
  mask: string; // e.g., '255.255.255.0'
  nextHop: string; // e.g., '10.0.0.2' or 'Directly Connected'
  interfaceName: string; // e.g., 'Fa0/1'
  type: 'C' | 'S'; // Connected or Static
}

export interface ArpEntry {
  ipAddress: string;
  macAddress: string;
  interfaceName: string;
  vlan?: number;
}

export interface MacTableEntry {
  macAddress: string;
  portName: string;
  vlan: number;
  type: 'DYNAMIC' | 'STATIC';
}

export interface DhcpPool {
  id: string;
  poolName: string;
  network: string;
  mask: string;
  defaultRouter: string;
  dnsServer: string;
  startIp: string;
  endIp: string;
}

export interface DhcpLease {
  ipAddress: string;
  macAddress: string;
  hostname: string;
  poolName: string;
}

export interface DnsRecord {
  id: string;
  domain: string;
  ipAddress: string;
}

export interface ServerServices {
  dhcpEnabled: boolean;
  dhcpPools: DhcpPool[];
  dhcpLeases: DhcpLease[];
  dnsEnabled: boolean;
  dnsRecords: DnsRecord[];
  httpEnabled: boolean;
  httpTitle: string;
  httpBody: string;
}

export type ZoneColor = 'sky' | 'emerald' | 'amber' | 'indigo' | 'purple' | 'rose';

export interface NetworkZone {
  id: string;
  title: string; // e.g., 'VLAN 10 — Sales Department'
  subnetLabel: string; // e.g., '192.168.1.0/24 · Gateway 192.168.1.1'
  x: number;
  y: number;
  width: number;
  height: number;
  color: ZoneColor;
}

export interface CliState {
  mode: 'user' | 'priv' | 'config' | 'config-if';
  selectedInterface?: string;
  history: string[];
  commandLog?: string[];
}

export interface SwitchVlanEntry {
  id: number;
  name: string;
  subnetHint?: string;
}

export interface NetworkNode {
  id: string;
  name: string;
  type: DeviceType;
  x: number;
  y: number;
  defaultGateway: string; // used for PC / Server
  dnsServer?: string; // used for PC / Server DNS resolution
  ipAssignmentMode?: 'static' | 'dhcp';
  services?: ServerServices;
  vlanDatabase?: SwitchVlanEntry[];
  interfaces: NetworkInterface[];
  routingTable: RouteEntry[];
  arpTable: ArpEntry[];
  macTable: MacTableEntry[];
  cli: CliState;
}

export interface NetworkLink {
  id: string;
  sourceNodeId: string;
  sourcePortId: string;
  targetNodeId: string;
  targetPortId: string;
  cableType: CableType;
}

export type ProtocolType =
  | 'ARP_REQUEST'
  | 'ARP_REPLY'
  | 'ICMP_ECHO_REQUEST'
  | 'ICMP_ECHO_REPLY'
  | 'ICMP_TIME_EXCEEDED'
  | 'DHCP_DISCOVER'
  | 'DHCP_OFFER'
  | 'DHCP_REQUEST'
  | 'DHCP_ACK'
  | 'DNS_QUERY'
  | 'DNS_RESPONSE'
  | 'TCP_SYN'
  | 'TCP_SYN_ACK'
  | 'TCP_ACK'
  | 'HTTP_GET'
  | 'HTTP_200_OK';

export type StepStatus = 'forwarded' | 'broadcast' | 'delivered' | 'dropped';

export interface OsiPduDetails {
  l1: {
    inPort: string;
    outPort: string;
    cableType: string;
    physicalStatus: string;
  };
  l2: {
    headerType: 'Ethernet II' | 'IEEE 802.1Q';
    srcMac: string;
    dstMac: string;
    etherType: '0x0800 (IPv4)' | '0x0806 (ARP)';
    vlanTag: number | null;
  };
  l3: {
    headerType: 'IPv4' | 'ARP Payload';
    srcIp: string;
    dstIp: string;
    ttl: number;
    protocol: string;
  };
  l4: {
    type: ProtocolType;
    summary: string;
    seqNumber: number;
    srcPort?: number;
    dstPort?: number;
  };
  l7?: {
    appProtocol: 'DHCP' | 'DNS' | 'HTTP' | 'ICMP';
    headline: string;
    fields: Record<string, string>;
  };
}

export interface SimulationStep {
  id: string;
  stepIndex: number;
  timestampMs: number;
  fromNodeId: string;
  fromNodeName: string;
  fromPortName: string;
  toNodeId: string;
  toNodeName: string;
  toPortName: string;
  linkId: string;
  protocol: ProtocolType;
  status: StepStatus;
  vlanTag: number | null;
  inboundPdu: OsiPduDetails;
  outboundPdu: OsiPduDetails;
  decisionTitle: string;
  osiActions: {
    layer: 'L1' | 'L2' | 'L3' | 'L4' | 'L7';
    title: string;
    detail: string;
  }[];
  nodeSnapshotAfter: {
    arpTable: ArpEntry[];
    macTable: MacTableEntry[];
  };
}

export interface TracerouteHop {
  hopNumber: number;
  ttl: number;
  responderName: string;
  responderIp: string;
  rttMs: number;
  status: 'TIME_EXCEEDED' | 'REACHED' | 'TIMEOUT';
}

export interface HttpResponseResult {
  url: string;
  resolvedIp: string;
  statusCode: number;
  statusText: string;
  serverName: string;
  title: string;
  body: string;
  latencyMs: number;
}

export interface TopologyData {
  id: string;
  name: string;
  description: string;
  nodes: NetworkNode[];
  links: NetworkLink[];
  zones?: NetworkZone[];
}
