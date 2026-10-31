export type DeviceType = 'router' | 'switch' | 'pc' | 'server';

export type DeviceModel =
  | 'router'
  | 'switch'
  | 'pc'
  | 'server'
  | 'wifi_ap'
  | 'soho_wifi_router'
  | 'laptop'
  | 'smartphone'
  | 'wlc'
  | 'firewall'
  | 'ip_phone'
  | 'ip_camera'
  | 'nvr'
  | 'isp_cloud'
  | 'gpon_olt'
  | 'gpon_ont';

export type FirewallZoneName = 'inside' | 'dmz' | 'outside';

export interface FirewallPortForwardRule {
  id: string;
  name: string; // e.g., 'Publish DMZ Web Server HTTP 80'
  enabled: boolean;
  externalInterface: string; // e.g., 'Gi0/2' (Outside)
  externalIp: string; // e.g., '203.0.113.2'
  externalPort: number; // e.g., 80
  protocol: 'TCP' | 'UDP' | 'HTTP' | 'ICMP' | 'ANY';
  internalIp: string; // e.g., '172.16.50.100' (DMZ Server)
  internalPort: number; // e.g., 80
  targetZone: FirewallZoneName; // default 'dmz'
  hitCount: number;
}

export interface FirewallPolicyRule {
  id: string;
  name: string;
  enabled: boolean;
  fromZone: FirewallZoneName | 'any';
  toZone: FirewallZoneName | 'any';
  srcIp: string; // 'any' or IP/CIDR
  dstIp: string; // 'any' or IP/CIDR
  protocol: 'ANY' | 'TCP' | 'UDP' | 'ICMP' | 'HTTP' | 'DNS';
  dstPort?: number;
  action: 'permit' | 'deny';
  hitCount?: number;
}

export interface IpsecTunnelConfig {
  id: string;
  tunnelName: string; // e.g., 'VPN-HQ-to-Branch'
  enabled: boolean;
  localInterface: string; // e.g., 'Gi0/2' (Outside)
  localPublicIp: string; // e.g., '203.0.113.2'
  peerPublicIp: string; // e.g., '198.51.100.2'
  localSubnet: string; // e.g., '192.168.100.0/24'
  remoteSubnet: string; // e.g., '10.200.1.0/24'
  preSharedKey: string; // e.g., 'NetPulse-IPsec-2026'
  ikeVersion: 'IKEv1' | 'IKEv2';
  cryptoSuite: string; // e.g., 'AES-256-GCM / SHA-256 / DH14'
  status: 'UP' | 'DOWN';
  packetsEncrypted: number;
  packetsDecrypted: number;
}

export interface FirewallStatefulSession {
  id: string;
  protocol: 'TCP' | 'UDP' | 'ICMP' | 'HTTP';
  initiatorIp: string;
  initiatorPort: number;
  responderIp: string;
  responderPort: number;
  initiatorZone: FirewallZoneName;
  responderZone: FirewallZoneName;
  initiatorLevel: number;
  responderLevel: number;
  state: 'ESTABLISHED' | 'SYN_SENT' | 'ECHO_ACTIVE' | 'UDP_ACTIVE';
  packetsCount: number;
}

export interface FirewallConfig {
  enabled: boolean;
  vendorModel: 'Cisco ASA 5516-X' | 'FortiGate 100F NGFW' | string;
  spiEnabled: boolean; // Stateful Packet Inspection
  inspectTcp: boolean;
  inspectUdp: boolean;
  inspectIcmp: boolean;
  inspectHttp: boolean;
  sameSecurityTrafficPermit: boolean;
  portForwards: FirewallPortForwardRule[];
  policyRules: FirewallPolicyRule[];
  ipsecTunnels: IpsecTunnelConfig[];
  statefulSessions: FirewallStatefulSession[];
}

export type VlanMode = 'access' | 'trunk';

export type CableType = 'straight' | 'crossover' | 'fiber' | 'wireless' | 'stack';

export type StackProtocol = 'StackWise-480' | 'VSS' | 'HSRP';

export type StackMemberRole = 'master' | 'standby' | 'member';

export interface StackConfig {
  enabled: boolean;
  stackId: string; // e.g., 'STACK-CORE-1' or 'STACK-WAN-1'
  domainId: number; // e.g., 1..255 (StackWise domain / HSRP group)
  memberNumber: number; // 1..8
  priority: number; // 1..15 (StackWise / HSRP election priority, higher wins Master/Active)
  role?: StackMemberRole; // Dynamically elected ('master' | 'standby' | 'member')
  protocol: StackProtocol; // 'StackWise-480' | 'VSS' | 'HSRP'
  virtualIp?: string; // Shared Virtual Gateway IPv4 (VIP) for Router HSRP / L3 Switch Stack
  virtualMac?: string; // Shared Virtual MAC (e.g., '00:00:0C:9F:F0:01')
  preempt?: boolean; // Automatically reclaim Master/Active role when higher-priority node recovers
  backplaneSpeedGbps?: number; // e.g. 480 Gbps for StackWise-480, 80 Gbps for VSS
}

export interface VoipCallLogEntry {
  id: string;
  timestamp: string;
  direction: 'outgoing' | 'incoming';
  peerExtension: string;
  peerIp: string;
  codec: string;
  status: 'CONNECTED' | 'FAILED';
}

export interface VoipPhoneConfig {
  enabled: boolean;
  extension: string; // e.g., '101', '102'
  displayName: string; // e.g., 'Sales Desk 101'
  sipServerIp: string; // e.g., '192.168.20.100'
  voiceVlan: number; // e.g., 20 (IEEE 802.1Q Voice VLAN with CoS 5 / DSCP EF)
  dataVlan: number; // e.g., 10 (Untagged Data VLAN on PC Passthrough Port)
  codec: 'G.711u (64 kbps)' | 'G.729a (8 kbps)' | 'Opus HD (32 kbps)';
  dscpMark: 'EF (46)' | 'CS3 (24)' | 'BE (0)';
  poeClassWatts: number; // default 7.0 (IEEE 802.3af Class 2)
  acAdapterConnected?: boolean; // Optional external 48V power brick when PoE is off
  callStatus?: 'idle' | 'calling' | 'connected' | 'failed';
  activePeerExtension?: string;
  callHistory?: VoipCallLogEntry[];
}

export interface SwitchPoeConfig {
  enabled: boolean;
  standard: '802.3af PoE (15.4W/port)' | '802.3at PoE+ (30W/port)';
  totalBudgetWatts: number; // e.g., 60, 120, 370, 740
}

export interface SipExtensionEntry {
  id: string;
  extension: string; // e.g., '101'
  displayName: string; // e.g., 'Cisco IP Phone 101'
  ipAddress: string; // e.g., '192.168.20.11'
  voiceVlan?: number; // e.g., 20
}

export interface IpCameraConfig {
  enabled: boolean;
  channelNumber?: number; // e.g., 1, 2
  locationName?: string; // e.g., 'Периметр: Главный вход', 'Серверная ЦОД'
  cameraName: string; // e.g., 'CAM-01 Главный въезд (КПП)'
  streamUrl: string; // e.g., 'rtsp://192.168.30.11:554/live/ch01'
  nvrServerIp?: string; // e.g., '192.168.30.100'
  nvrTargetIp: string; // e.g., '192.168.30.100'
  surveillanceVlan: number; // e.g., 30 (Dedicated CCTV / IoT VLAN)
  streamMode: 'unicast' | 'multicast'; // RTSP/RTP Unicast vs IGMP Multicast
  multicastGroupIp: string; // e.g., '239.0.30.1'
  rtspPort: number; // default 554
  rtpVideoPort: number; // default 5004
  videoCodec?: string;
  codec: string; // e.g., 'H.265 (HEVC)' | 'H.264 (AVC)' | 'MJPEG'
  resolution: string; // e.g., '4K (3840×2160)' | '1080p (1920×1080)' | '720p (1280×720)'
  fps: number; // 15 | 25 | 30 | 60
  bitrateKbps: number; // default 6144
  dscpMark?: 'AF41 (34)' | 'CS4 (32)' | 'BE (0)';
  poeClassWatts?: number; // default 9.5 (IEEE 802.3af/at Class 3 PoE Camera)
  poeRequiredWatts?: number; // default 9.5
  poePowered?: boolean;
  acAdapterConnected?: boolean; // Optional external 12V DC adapter
  motionDetection?: boolean; // ONVIF motion event detection
  irNightVision?: boolean; // IR LED Night Vision
  status?: 'idle' | 'streaming' | 'blocked';
  lastStreamStatus?: 'idle' | 'streaming' | 'blocked';
  lastStreamTarget?: string;
}

export interface NvrCameraChannelEntry {
  id: string;
  channelNumber: number; // 1..16
  cameraName: string; // e.g., 'CAM-Gate-01'
  ipAddress: string; // e.g., '192.168.30.11'
  rtspUrl: string; // e.g., 'rtsp://192.168.30.11:554/live/ch1'
  surveillanceVlan: number; // e.g., 30
  codec: string; // e.g., 'H.265 (HEVC 4K · 6 Mbps)'
  recordingActive: boolean;
}

export interface WlanProfile {
  id: string;
  wlanId: number; // e.g., 1, 2
  profileName: string; // e.g., 'Corp_Enterprise_WLAN'
  ssid: string; // e.g., 'Corp-Enterprise'
  vlanId: number; // e.g., 10
  security: 'open' | 'wpa2';
  password?: string;
  band: '2.4GHz' | '5GHz';
  enabled: boolean;
}

export interface WlcConfig {
  enabled: boolean;
  controllerName?: string;
  managementIp: string;
  managementVlan: number;
  capwapUdpControlPort: number; // UDP 5246
  capwapUdpDataPort: number; // UDP 5247
  rfAutoChannel: boolean; // RRM DCA (Dynamic Channel Assignment: 1, 6, 11 / 36, 44, 149)
  defaultCoverageRadius: number;
  wlanProfiles: WlanProfile[];
}

export interface WifiApConfig {
  enabled: boolean;
  ssid: string;
  channel: number; // e.g. 1, 6, 11 (2.4GHz) or 36, 44, 149 (5GHz)
  band: '2.4GHz' | '5GHz';
  security: 'open' | 'wpa2';
  password?: string;
  coverageRadius: number; // Canvas radius in px (e.g. 140..420, default 240)
  bridgeVlan?: number; // Default 1 (VLAN assigned to wireless bridge ports)
  apMode?: 'autonomous' | 'lightweight'; // Autonomous AP vs Lightweight AP (LAP managed via CAPWAP by WLC)
  wlcNodeId?: string; // Joined WLC node ID
  wlcControllerName?: string; // Joined WLC name
  wlcManagementIp?: string; // Joined WLC management IPv4 (UDP 5246/5247)
  capwapStatus?: 'joined' | 'discovery' | 'standalone';
  wlanProfileId?: string; // Active WLAN profile pushed from WLC
}

export interface WifiClientConfig {
  enabled: boolean;
  connectedSsid?: string;
  connectedApNodeId?: string;
  security?: 'open' | 'wpa2';
  passphrase?: string;
  autoRoaming?: boolean; // Automatically roam to strongest AP with same SSID
}

export interface RouterSubinterface {
  id?: string;
  vlanId: number;
  ipAddress: string;
  subnetMask: string;
  helperAddress?: string;
  natRole?: 'none' | 'inside' | 'outside';
  securityZone?: FirewallZoneName;
  securityLevel?: number;
}

export interface SwitchSviInterface {
  id: string;
  vlanId: number;
  name: string; // e.g., 'Vlan10'
  ipAddress: string;
  subnetMask: string;
  adminStatus: 'up' | 'down';
  macAddress: string;
  helperAddress?: string;
}

export interface NetworkInterface {
  id: string;
  name: string; // e.g., 'Fa0/0', 'Gi0/1', 'Eth0', 'Wlan0'
  shortName: string; // e.g., 'Fa0/0', 'Wlan0'
  macAddress: string;
  ipAddress: string; // e.g., '192.168.1.1' or ''
  subnetMask: string; // e.g., '255.255.255.0' or ''
  adminStatus: 'up' | 'down';
  vlanMode: VlanMode;
  accessVlan: number; // default 1
  trunkAllowedVlans: number[]; // e.g., [1, 10, 20, 30]
  isWireless?: boolean; // IEEE 802.11 radio interface
  dhcpEnabled?: boolean;
  helperAddress?: string; // ip helper-address for DHCP Relay
  natRole?: 'none' | 'inside' | 'outside'; // ip nat inside / outside
  securityZone?: FirewallZoneName; // Cisco ASA nameif: 'inside' (100), 'dmz' (50), 'outside' (0)
  securityLevel?: number; // Cisco ASA security-level 0..100
  bandwidthMbps?: number; // Link bandwidth in Mbps (e.g., 1000 for Gi, 100 for Fa, 300 for Wi-Fi)
  ospfCost?: number; // Explicit OSPF interface cost override (ip ospf cost)
  channelGroup?: number; // IEEE 802.3ad EtherChannel group number (1..6 -> Po1..Po6)
  channelMode?: 'active' | 'passive' | 'on'; // LACP active/passive or static 'on'
  voiceVlan?: number; // Cisco Auxiliary Voice VLAN ID (switchport voice vlan <1-4094>)
  poeEnabled?: boolean; // IEEE 802.3af/at inline power on switch port (power inline auto / never)
  poeMaxWatts?: number;
  poePriority?: 'critical' | 'high' | 'low';
  wanImpairment?: WanImpairmentConfig; // Optional per-interface WAN link impairment override
  subinterfaces?: RouterSubinterface[];
}

export interface WanImpairmentConfig {
  enabled: boolean;
  profileName?: string; // e.g., 'Tier-1 MPLS Fiber (8 ms)', 'Backup LTE/Radio (45 ms)', 'Degraded WAN'
  latencyMs: number; // One-way propagation delay in ms (0..2000, default 8)
  jitterMs: number; // Delay variation in ms (0..500, default 1)
  packetLossPercent: number; // Packet loss percentage (0..100, default 0)
  bandwidthLimitMbps: number; // Rate limit / link capacity in Mbps (1..10000, default 1000)
}

export type GponSplitterRatio = '1:1' | '1:8' | '1:16' | '1:32' | '1:64';

export interface GponOltConfig {
  enabled: boolean;
  vendorModel: string; // e.g., 'Huawei MA5800-X7 GPON OLT' | 'Eltex LTP-8X GPON OLT'
  sfpClass: 'B+' | 'C+'; // Class B+ (+3.5 dBm TX), Class C+ (+5.5 dBm TX)
  txPowerDbm: number; // Downstream 1490 nm optical launch power in dBm (e.g., +3.5)
  downstreamWavelengthNm: 1490;
  upstreamWavelengthNm: 1310;
  splitterRatio: GponSplitterRatio; // Passive PLC splitter ratio ('1:8', '1:16', '1:32', '1:64')
  requireSnAuth: boolean; // Require ONT GPON-SN authorization on OLT
  authorizedSnList: string[]; // Authorized ONT Serial Numbers (e.g., ['HWTC-1001A2B3', 'HWTC-1002C4D5'])
  internetVlan: number; // Triple-Play VLAN for Internet PPPoE/DHCP (default 100)
  iptvVlan: number; // Triple-Play VLAN for IPTV Multicast (default 200)
  voipVlan: number; // Triple-Play VLAN for VoIP SIP/RTP (default 300)
}

export interface GponOntServicePortMapping {
  portShortName: string; // 'LAN1', 'LAN2', 'LAN3'
  serviceType: 'internet' | 'iptv' | 'voip' | 'custom';
  serviceLabel: string; // e.g., 'Порт 1 — Интернет (PPPoE / DHCP)'
  vlanId: number; // e.g., 100, 200, 300
  pppoeUsername?: string; // e.g., 'abonent_101@ftth.isp'
  igmpMulticastGroup?: string; // e.g., '239.255.1.1'
  qosCos?: number; // IEEE 802.1p CoS priority (0 = Best Effort, 4 = Video AF41, 5 = Voice EF)
}

export interface GponOntConfig {
  enabled: boolean;
  vendorModel: string; // e.g., 'Huawei EchoLife HG8245H GPON ONT'
  gponSn: string; // e.g., 'HWTC-1001A2B3'
  distanceKm: number; // Optical fiber length in km (0.35 dB/km attenuation at 1490 nm)
  extraAttenuationDb: number; // Additional bend / splice / dirty connector attenuation in dB
  losThresholdDbm: number; // Receiver sensitivity threshold in dBm (default -28.0 dBm)
  overloadThresholdDbm: number; // Receiver overload threshold in dBm (default -8.0 dBm)
  txPowerDbm: number; // Upstream 1310 nm laser launch power in dBm (default +2.5 dBm)
  servicePorts: GponOntServicePortMapping[];
}

export interface BgpNeighborConfig {
  id: string;
  ip: string; // e.g., '203.0.113.1'
  remoteAs: number; // e.g., 65101
  description?: string; // e.g., 'ISP-1 Primary Tier-1 Telecom'
  weight?: number; // Cisco BGP Weight (default 100, higher is preferred locally)
  localPref?: number; // BGP LOCAL_PREF (default 100, higher is preferred across AS)
  prependCount?: number; // AS-Path Prepend count (0..5, default 0)
  enabled?: boolean; // default true
}

export interface BgpAdvertisedNetwork {
  id: string;
  network: string; // e.g., '8.8.8.0'
  mask: string; // e.g., '255.255.255.0'
}

export interface BgpConfig {
  enabled: boolean;
  asn: number; // Autonomous System Number (e.g., 65000, 65101, 65202)
  routerId?: string; // Explicit BGP Router-ID or highest IPv4
  providerName?: string; // e.g., 'ISP-1 Primary (AS 65101 · Fiber 1 Gbps)'
  redistributeConnected?: boolean; // Advertise connected public networks into eBGP
  neighbors: BgpNeighborConfig[];
  advertisedNetworks: BgpAdvertisedNetwork[];
}

export interface BgpPeerStatusEntry {
  neighborIp: string;
  remoteAs: number;
  localAs: number;
  peerNodeId?: string;
  peerNodeName?: string;
  peerRouterId?: string;
  localInterface: string;
  state: 'Established' | 'Active' | 'Idle (Admin)' | 'Connect';
  prefixesReceived: number;
  weight: number;
  localPref: number;
  prependCount: number;
  uptime: string;
  wanLatencyMs: number;
  wanLossPercent: number;
  wanBandwidthMbps: number;
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
  channelGroup?: number;
  portChannelName?: string;
  aggregatedBandwidthMbps?: number;
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
  type: 'C' | 'S' | 'O' | 'R' | 'B'; // Connected, Static, OSPF (AD 110), RIPv2 (AD 120), or eBGP (AD 20)
  administrativeDistance?: number; // C=0, S=1, B=20, O=110, R=120
  metric?: number; // OSPF cumulative path Cost, RIP hop count, or BGP MED/WAN Latency
  ospfArea?: number; // e.g., 0
  learnedFromRouterId?: string;
  learnedFromRouterName?: string;
  spfPath?: string[];
  bgpAsPath?: number[]; // e.g., [65101] or [65202, 65202]
  bgpWeight?: number; // Cisco Weight (default 100)
  bgpLocalPref?: number; // LOCAL_PREF (default 100)
  bgpOrigin?: 'i' | 'e' | '?';
  bgpBestPath?: boolean;
  wanLatencyMs?: number;
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
  dhcpLeases?: DhcpLease[];
  dnsEnabled: boolean;
  dnsRecords: DnsRecord[];
  httpEnabled: boolean;
  httpTitle?: string;
  httpBody?: string;
  serverBanner?: string;
  sipEnabled?: boolean; // Asterisk / Cisco CUCM SIP Registrar (UDP 5060)
  sipDomain?: string; // e.g., 'voip.corp.local'
  sipExtensions?: SipExtensionEntry[];
  nvrEnabled?: boolean; // Network Video Recorder RTSP / ONVIF Server (TCP/UDP 554)
  nvrStorageTb?: number; // e.g., 16 TB RAID-6
  nvrRetentionDays?: number; // e.g., 30 days
  nvrMulticastGroup?: string; // e.g., '239.0.30.1'
  nvrChannels?: NvrCameraChannelEntry[];
  tftpEnabled?: boolean; // TFTP / FTP Server (UDP 69 / TCP 21) for Cisco IOS images & configs
  tftpFiles?: string[];
  syslogEnabled?: boolean; // Syslog Collector (UDP 514)
  ntpEnabled?: boolean; // Network Time Protocol (UDP 123)
  ntpStratum?: number; // 1..4
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
  selectedSviVlan?: number;
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
  deviceModel?: DeviceModel;
  x: number;
  y: number;
  defaultGateway: string; // used for PC / Server
  dnsServer?: string; // used for PC / Server DNS resolution
  ipAssignmentMode?: 'static' | 'dhcp';
  stpPriority?: number; // IEEE 802.1D Bridge Priority (default 32768)
  ipRoutingEnabled?: boolean; // Multilayer Switch L3 IP Routing ('ip routing')
  sviInterfaces?: SwitchSviInterface[]; // Switch Virtual Interfaces (interface Vlan10, Vlan20...)
  wifiConfig?: WifiApConfig; // IEEE 802.11 Access Point / SOHO Router radio config
  wifiClientConfig?: WifiClientConfig; // IEEE 802.11 Wireless Client config (Laptop / Smartphone)
  wlcConfig?: WlcConfig; // Wireless LAN Controller (WLC 5520) CAPWAP & WLAN Profile config
  firewallConfig?: FirewallConfig; // Cisco ASA 5516-X / FortiGate NGFW Security Zones, SPI, Port Forwarding & IPsec VPN
  stackConfig?: StackConfig; // Switch StackWise-480 / VSS & Router HSRP / HA Cluster configuration
  voipConfig?: VoipPhoneConfig; // Cisco IP Phone 7960 VoIP SIP / RTP / Voice+Data VLAN config
  ipCameraConfig?: IpCameraConfig; // PoE IP Camera (RTSP 554 / RTP Video / Multicast / Surveillance VLAN)
  poeConfig?: SwitchPoeConfig; // Switch IEEE 802.3af/at Power over Ethernet PSU budget config
  aclRules?: AclRule[]; // Router L3/L4 Firewall ACL rules
  natEnabled?: boolean; // Router NAT/PAT overload toggle
  natTranslations?: NatTranslationEntry[]; // Active NAT translation table
  ospfConfig?: OspfConfig; // OSPFv2 Single-Area & RIPv2 Dynamic Routing configuration
  bgpConfig?: BgpConfig; // eBGP Autonomous System (ASN), Dual-ISP Peering & Prefix Advertisements
  wanImpairment?: WanImpairmentConfig; // WAN Link Emulator (Latency ms, Jitter ms, Packet Loss %, Bandwidth Limit Mbps)
  gponOltConfig?: GponOltConfig; // GPON OLT (1490nm TX / 1310nm RX, Splitter 1:8..1:64, GPON-SN Auth, Triple-Play VLANs)
  gponOntConfig?: GponOntConfig; // Subscriber GPON ONT/ONU (Optical Rx dBm, LOS < -28 dBm, Port 1 Internet / Port 2 IPTV / Port 3 VoIP)
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
  wanImpairment?: WanImpairmentConfig;
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
  | 'OSPF_LSA'
  | 'CAPWAP_CONTROL'
  | 'CAPWAP_DATA'
  | 'IKEV2'
  | 'IPSEC_ESP'
  | 'SIP_INVITE'
  | 'SIP_200_OK'
  | 'RTP_AUDIO'
  | 'RTSP_SETUP'
  | 'RTSP_200_OK'
  | 'RTP_VIDEO'
  | 'BGP_OPEN'
  | 'BGP_UPDATE'
  | 'BGP_KEEPALIVE';

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
    headerType:
      | 'IPv4'
      | 'ARP Payload'
      | 'IEEE 802.1D BPDU'
      | 'OSPFv2 Packet (IP Proto 89)'
      | 'IPsec ESP Packet (IP Proto 50)';
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
    appProtocol:
      | 'DHCP'
      | 'DNS'
      | 'HTTP'
      | 'ICMP'
      | 'STP'
      | 'OSPF'
      | 'CAPWAP'
      | 'IPSEC'
      | 'IKEV2'
      | 'SIP'
      | 'RTP'
      | 'RTSP'
      | 'BGP';
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
  hop?: number;
  ttl: number;
  responderName: string;
  nodeName?: string;
  responderIp: string;
  ipAddress?: string;
  rttMs: number;
  status: 'TIME_EXCEEDED' | 'REACHED' | 'TIMEOUT';
}

export interface HttpResponseResult {
  url: string;
  resolvedIp: string;
  serverIp?: string;
  statusCode: number;
  statusText: string;
  status?: string;
  serverName: string;
  title: string;
  body: string;
  latencyMs: number;
}

export interface PresetTestScenario {
  id: string;
  title: string;
  subtitle: string;
  protocolBadge:
    | 'ICMP'
    | 'OSPF'
    | 'RIP'
    | 'DHCP'
    | 'HTTP'
    | 'TRACEROUTE'
    | 'STP'
    | 'ACL'
    | 'WIFI'
    | 'CAPWAP'
    | 'FIREWALL'
    | 'IPSEC'
    | 'STACK'
    | 'VOIP'
    | 'POE'
    | 'RTSP'
    | 'BGP'
    | 'WAN'
    | 'GPON';
  expectedOutcome: 'success' | 'blocked';
  actionType:
    | 'ping'
    | 'traceroute'
    | 'dhcp'
    | 'http'
    | 'ospf_hello'
    | 'multi_flow'
    | 'capwap_join'
    | 'ipsec_vpn'
    | 'voip_call'
    | 'rtsp_stream'
    | 'bgp_peering';
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
