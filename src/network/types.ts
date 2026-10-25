export type DeviceType = 'router' | 'switch' | 'pc' | 'server';

export type VlanMode = 'access' | 'trunk';

export type CableType = 'straight' | 'crossover' | 'fiber';

export interface RouterSubinterface {
  id?: string;
  vlanId: number;
  ipAddress: string;
  subnetMask: string;
  helperAddress?: string;
  natRole?: 'none' | 'inside' | 'outside';
}

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
  helperAddress?: string; // ip helper-address for DHCP Relay
  natRole?: 'none' | 'inside' | 'outside'; // ip nat inside / outside
  bandwidthMbps?: number; // Link bandwidth in Mbps (e.g., 1000 for Gi, 100 for Fa, 10 for Serial/Backup)
  ospfCost?: number; // Explicit OSPF interface cost override (ip ospf cost)
  subinterfaces?: RouterSubinterface[];
}

export interface OspfNetworkStatement {
  id: string;
  network: string; // e.g., '192.168.1.0'
  wildcard: string; // e.g., '0.0.0.255'
  wildcardMask?: string; // alias for wildcard
  area: number; // default 0
}

export interface OspfConfig {
  enabled: boolean;
  processId: number; // default 1
  routerId?: string; // Explicit Router-ID or auto-elected highest active IPv4
  referenceBandwidthMbps?: number; // default 100 (Cost = 100 Mbps / Bandwidth)
  networks: OspfNetworkStatement[];
  passiveInterfaces: string[]; // Interface shortNames that do not send OSPF Hellos
  ripEnabled?: boolean; // RIPv2 dynamic routing protocol (AD 120, hop count metric)
}

export interface OspfNeighborEntry {
  neighborRouterId: string;
  neighborNodeId: string;
  neighborName: string;
  neighborRouterName: string;
  priority: number;
  state: 'FULL/DR' | 'FULL/BDR' | 'FULL/P2P';
  deadTime: string;
  neighborIp: string;
  localInterface: string;
  area: number;
  cost: number;
  interfaceCost: number;
  bandwidthMbps: number;
}

export type StpPortRole = 'root' | 'designated' | 'alternate' | 'disabled';
export type StpPortState = 'forwarding' | 'blocking' | 'disabled';

export interface StpPortStatus {
  portId: string;
  portShortName: string;
  role: StpPortRole;
  state: StpPortState;
  pathCost: number;
  designatedBridgeId: string;
  peerNodeName?: string;
  peerPortName?: string;
}

export interface StpSwitchState {
  bridgePriority: number;
  bridgeMac: string;
  rootBridgeId: string;
  rootBridgeName: string;
  isRootBridge: boolean;
  rootPathCost: number;
  rootPortName: string | null;
  ports: Record<string, StpPortStatus>;
}

export type AclAction = 'permit' | 'deny';
export type AclProtocol = 'ANY' | 'ICMP' | 'TCP' | 'UDP' | 'HTTP' | 'DNS';

export interface AclRule {
  id: string;
  seq: number;
  name?: string;
  action: AclAction;
  protocol: AclProtocol;
  srcIp: string; // 'any', single IP '192.168.1.10', or CIDR '192.168.1.0/24'
  dstIp: string; // 'any', single IP, or CIDR
  dstPort?: number;
  enabled?: boolean;
  hitCount?: number;
}

export interface NatTranslationEntry {
  id: string;
  protocol: 'icmp' | 'tcp' | 'udp';
  insideLocal: string;
  insideGlobal: string;
  outsideLocal: string;
  outsideGlobal: string;
  insideIp: string;
  globalIp: string;
  outsideIp: string;
  port: number;
}

export interface RouteEntry {
  id: string;
  network: string; // e.g., '192.168.2.0'
  mask: string; // e.g., '255.255.255.0'
  nextHop: string; // e.g., '10.0.0.2' or 'Directly Connected'
  interfaceName: string; // e.g., 'Fa0/1' or 'Fa0/0.10'
  type: 'C' | 'S' | 'O' | 'R'; // Connected, Static, OSPF (AD 110), or RIPv2 (AD 120)
  administrativeDistance?: number; // C=0, S=1, O=110, R=120
  metric?: number; // OSPF cumulative path Cost or RIP hop count
  ospfArea?: number; // e.g., 0
  learnedFromRouterId?: string;
  learnedFromRouterName?: string;
  spfPath?: string[];
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
  mode: 'user' | 'priv' | 'config' | 'config-if' | 'config-router';
  selectedInterface?: string;
  selectedSubinterfaceVlan?: number;
  selectedRoutingProtocol?: 'ospf' | 'rip';
  selectedOspfProcessId?: number;
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
  stpPriority?: number; // IEEE 802.1D Bridge Priority (default 32768)
  aclRules?: AclRule[]; // Router L3/L4 Firewall ACL rules
  natEnabled?: boolean; // Router NAT/PAT overload toggle
  natTranslations?: NatTranslationEntry[]; // Active NAT translation table
  ospfConfig?: OspfConfig; // OSPFv2 Single-Area & RIPv2 Dynamic Routing configuration
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
  | 'HTTP_200_OK'
  | 'STP_BPDU'
  | 'OSPF_HELLO'
  | 'OSPF_LSA';

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
    etherType: '0x0800 (IPv4)' | '0x0806 (ARP)' | '0x010B (STP BPDU)';
    vlanTag: number | null;
  };
  l3: {
    headerType: 'IPv4' | 'ARP Payload' | 'IEEE 802.1D BPDU' | 'OSPFv2 Packet (IP Proto 89)';
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
    appProtocol: 'DHCP' | 'DNS' | 'HTTP' | 'ICMP' | 'STP' | 'OSPF';
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

export interface PresetTestScenario {
  id: string;
  title: string;
  subtitle: string;
  protocolBadge: 'ICMP' | 'OSPF' | 'RIP' | 'DHCP' | 'HTTP' | 'TRACEROUTE' | 'STP' | 'ACL';
  expectedOutcome: 'success' | 'blocked';
  actionType: 'ping' | 'traceroute' | 'dhcp' | 'http' | 'ospf_hello' | 'multi_flow';
  sourceNodeId?: string;
  targetIpOrHost?: string;
}

export interface TopologyData {
  id: string;
  name: string;
  shortTag?: string;
  description: string;
  nodes: NetworkNode[];
  links: NetworkLink[];
  zones?: NetworkZone[];
  testScenarios?: PresetTestScenario[];
}
