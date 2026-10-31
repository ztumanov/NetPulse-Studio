import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatIpv4Input,
  getNetworkAddress,
  isSameSubnet,
  isValidIpv4,
  isValidSubnetMask,
  maskToCidr,
  suggestSubnetMaskForIp,
} from './ipMath';
import { createDeviceNode, TOPOLOGY_PRESETS } from './presets';
import {
  computeSpanningTreeState,
  findBestRoute,
  runBgpPeeringSimulation,
  runDhcpDoraSimulation,
  runHttpBrowserSimulation,
  runPacketSimulation,
  runRtspVideoStreamSimulation,
  runTracerouteSimulation,
  runVoipSipCallSimulation,
  syncConnectedRoutes,
} from './simulator';
import {
  computeBgpRoutesForRouter,
  discoverBgpPeersForRouter,
} from './bgpAndWanEngine';
import { analyzeNetworkTroubles } from './networkTroubleshooter';
import {
  computeTopologyLinkHeatmap,
  formatBandwidthShort,
} from './linkHeatmapEngine';
import {
  buildFollowStreamDialog,
  dissectStepForWireshark,
  evaluateWiresharkDisplayFilter,
  validateWiresharkDisplayFilter,
} from './wiresharkEngine';
import {
  computeSwitchPoeStatus,
  getIpCameraDirectory,
  getPoweredDevicePoeState,
  getVoipDirectory,
} from './poeAndVoipEngine';
import {
  computeDijkstraSpfRoutesForRouter,
  computeOspfNeighborsForRouter,
  synthesizeOspfHelloSteps,
} from './ospfEngine';
import { autocompleteIosCommand, executeIosCommand } from './cliParser';
import {
  addHardwarePortToNode,
  assignPortsToVlan,
  closeChassisWindow,
  computeChassisInitialPosition,
  deleteDeviceVlan,
  getAvailableTargetPorts,
  getDeviceChassisPorts,
  getDeviceVlanDatabase,
  groupPortsIntoTwoRows,
  moveLinkToSocket,
  openChassisWindow,
  upsertDeviceVlan,
} from './hardwareChassis';
import {
  addRouterAclRule,
  addRouterStaticRoute,
  getSuggestedStaticRoutes,
  removeRouterSubinterface,
  upsertRouterSubinterface,
} from './routerGuiHelpers';
import {
  buildCanvasPacketSquares,
  computePduHeaderDiff,
  countStepsByProtocolCategory,
  createDefaultEnabledCategories,
  filterSimulationSteps,
  generateMultiFlowTrafficSteps,
  getConcurrentBroadcastWaveIndices,
  getProtocolCategory,
} from './packetStreamEngine';
import { runCoreDiagnosticsSuite } from './diagnosticsSuite';
import {
  computeWifiSignalMetrics,
  connectWirelessClientToAp,
  disconnectWirelessClient,
  scanAvailableWifiNetworks,
  syncWirelessAssociations,
  syncWlcCapwapController,
  synthesizeCapwapTunnelSteps,
} from './wifiEngine';
import {
  computeGponOltConnectedOnts,
  computeGponOntOpticalState,
  getGponSplitterInsertionLossDb,
  syncOntInterfacesWithServicePorts,
} from './gponEngine';

test('IPv4 and subnet math validates and calculates network addresses accurately', () => {
  assert.equal(isValidIpv4('192.168.1.10'), true);
  assert.equal(isValidIpv4('999.168.1.10'), false);
  assert.equal(isValidSubnetMask('255.255.255.0'), true);
  assert.equal(isValidSubnetMask('255.255.255.252'), true);
  assert.equal(isValidSubnetMask('255.0.255.0'), false);
  assert.equal(getNetworkAddress('192.168.1.45', '255.255.255.0'), '192.168.1.0');
  assert.equal(isSameSubnet('192.168.1.10', '192.168.1.250', '255.255.255.0'), true);
  assert.equal(isSameSubnet('192.168.1.10', '192.168.2.10', '255.255.255.0'), false);
  assert.equal(maskToCidr('255.255.255.252'), 30);
});

test('Preset 1 (Routed Dual LAN): ARP + L2 Switching + L3 Routing succeeds between PC-1 and SRV-Web', () => {
  const preset = TOPOLOGY_PRESETS[0];
  const res = runPacketSimulation(preset.nodes, preset.links, 'node-pc-1', '192.168.2.100', 'ICMP');

  assert.equal(res.success, true, `Expected ping to succeed, got: ${res.summaryMessage}`);
  assert.ok(res.steps.length >= 6, 'Should record ARP and ICMP steps across switches and router');

  const updatedPc1 = res.updatedNodes.find((n) => n.id === 'node-pc-1')!;
  const updatedSw1 = res.updatedNodes.find((n) => n.id === 'node-sw-1')!;
  assert.ok(updatedPc1.arpTable.some((a) => a.ipAddress === '192.168.1.1'), 'PC-1 should learn gateway ARP');
  assert.ok(updatedSw1.macTable.length >= 2, 'Switch should learn source and gateway MAC addresses');
});

test('DHCP DORA simulation dynamically assigns IP, Mask, Gateway, and DNS to client PC', () => {
  const preset = TOPOLOGY_PRESETS[0];
  const dhcpRes = runDhcpDoraSimulation(preset.nodes, preset.links, 'node-pc-2');

  assert.equal(dhcpRes.success, true, `Expected DHCP DORA to succeed, got: ${dhcpRes.summaryMessage}`);
  assert.ok(dhcpRes.assignedDhcpConfig, 'Should return assignedDhcpConfig');
  assert.equal(dhcpRes.assignedDhcpConfig?.ipAddress, '192.168.1.50');
  assert.equal(dhcpRes.assignedDhcpConfig?.defaultGateway, '192.168.1.1');
  assert.equal(dhcpRes.assignedDhcpConfig?.dnsServer, '192.168.2.100');

  const protocols = dhcpRes.steps.map((s) => s.protocol);
  assert.ok(protocols.includes('DHCP_DISCOVER'), 'Includes DHCP_DISCOVER');
  assert.ok(protocols.includes('DHCP_OFFER'), 'Includes DHCP_OFFER');
  assert.ok(protocols.includes('DHCP_REQUEST'), 'Includes DHCP_REQUEST');
  assert.ok(protocols.includes('DHCP_ACK'), 'Includes DHCP_ACK');
});

test('DNS + TCP 3-Way Handshake + HTTP GET/200 OK resolves app.corp.local and delivers web page', () => {
  const preset = TOPOLOGY_PRESETS[0];
  const httpRes = runHttpBrowserSimulation(preset.nodes, preset.links, 'node-pc-1', 'http://app.corp.local');

  assert.equal(httpRes.success, true, `Expected HTTP simulation to succeed, got: ${httpRes.summaryMessage}`);
  assert.equal(httpRes.httpResult?.resolvedIp, '192.168.2.100');
  assert.equal(httpRes.httpResult?.statusCode, 200);

  const protocols = httpRes.steps.map((s) => s.protocol);
  assert.ok(protocols.includes('DNS_QUERY'), 'Includes DNS_QUERY');
  assert.ok(protocols.includes('DNS_RESPONSE'), 'Includes DNS_RESPONSE');
  assert.ok(protocols.includes('TCP_SYN'), 'Includes TCP_SYN');
  assert.ok(protocols.includes('TCP_SYN_ACK'), 'Includes TCP_SYN_ACK');
  assert.ok(protocols.includes('TCP_ACK'), 'Includes TCP_ACK');
  assert.ok(protocols.includes('HTTP_GET'), 'Includes HTTP_GET');
  assert.ok(protocols.includes('HTTP_200_OK'), 'Includes HTTP_200_OK');
});

test('Traceroute simulation increments TTL=1,2,3 and records ICMP_TIME_EXCEEDED across WAN routers', () => {
  const wanPreset = TOPOLOGY_PRESETS[2];
  const traceRes = runTracerouteSimulation(wanPreset.nodes, wanPreset.links, 'wan-pc-1', '172.16.2.50');

  assert.equal(traceRes.success, true, `Expected traceroute to succeed, got: ${traceRes.summaryMessage}`);
  assert.equal(traceRes.tracerouteHops?.length, 3, 'Should take 3 hops: RTR-Branch -> RTR-HQ -> SRV-HQ-DB');
  assert.equal(traceRes.tracerouteHops?.[0].status, 'TIME_EXCEEDED');
  assert.equal(traceRes.tracerouteHops?.[1].status, 'TIME_EXCEEDED');
  assert.equal(traceRes.tracerouteHops?.[2].status, 'REACHED');

  const protocols = traceRes.steps.map((s) => s.protocol);
  assert.ok(protocols.includes('ICMP_TIME_EXCEEDED'), 'Includes ICMP_TIME_EXCEEDED packets');
});

test('Cisco IOS CLI parser executes shorthand commands (conf t, int, ip add, no shut, wr) and logs command history', () => {
  const preset = TOPOLOGY_PRESETS[0];
  let rtr = preset.nodes.find((n) => n.id === 'node-rtr-1')!;

  rtr = executeIosCommand('conf t', rtr, preset.nodes, preset.links).updatedNode;
  assert.equal(rtr.cli.mode, 'config');

  rtr = executeIosCommand('int gi0/0', rtr, preset.nodes, preset.links).updatedNode;
  assert.equal(rtr.cli.mode, 'config-if');

  rtr = executeIosCommand('ip add 10.20.30.1 255.255.255.0', rtr, preset.nodes, preset.links).updatedNode;
  rtr = executeIosCommand('no shut', rtr, preset.nodes, preset.links).updatedNode;

  const wrRes = executeIosCommand('wr', rtr, preset.nodes, preset.links);
  rtr = wrRes.updatedNode;
  assert.ok(wrRes.outputLines.some((l) => l.includes('Building configuration')), 'wr outputs Building configuration...');

  const giPort = rtr.interfaces.find((i) => i.shortName === 'Gi0/0')!;
  assert.equal(giPort.ipAddress, '10.20.30.1');
  assert.equal(giPort.adminStatus, 'up');
  assert.ok((rtr.cli.commandLog || []).includes('conf t'), 'Records commandLog history');
  assert.ok((rtr.cli.commandLog || []).includes('no shut'), 'Records no shut in commandLog history');
});

test('Cisco IOS CLI Tab autocomplete expands partial commands and interface names', () => {
  const preset = TOPOLOGY_PRESETS[0];
  let rtr = preset.nodes.find((n) => n.id === 'node-rtr-1')!;

  const tabConf = autocompleteIosCommand('conf', rtr);
  assert.equal(tabConf.completed, 'configure terminal');

  const tabShowIp = autocompleteIosCommand('show ip r', rtr);
  assert.equal(tabShowIp.completed, 'show ip route');

  rtr = executeIosCommand('conf t', rtr, preset.nodes, preset.links).updatedNode;
  const tabInt = autocompleteIosCommand('interface gi', rtr);
  assert.equal(tabInt.completed, 'interface gi0/0');
});

test('Topology presets include visual subnet zones', () => {
  for (const preset of TOPOLOGY_PRESETS) {
    assert.ok(Array.isArray(preset.zones) && preset.zones.length >= 2, `Preset ${preset.id} has visual subnet zones`);
  }
});

test('Switch hardware front panel resolves RJ45 sockets, LEDs, patch cord moves, and port expansion', () => {
  const preset = TOPOLOGY_PRESETS[0];
  const sw1 = preset.nodes.find((n) => n.id === 'node-sw-1')!;

  const descriptors = getDeviceChassisPorts(sw1, preset.nodes, preset.links, null);
  assert.equal(descriptors.length, 8, 'SW-Access-A should have 8 physical ports (6 Fa + 2 Gi)');

  const fa1 = descriptors.find((d) => d.port.shortName === 'Fa0/1')!;
  assert.equal(fa1.ledState, 'link-up');
  assert.equal(fa1.peerNode?.name, 'PC-1');

  const fa4 = descriptors.find((d) => d.port.shortName === 'Fa0/4')!;
  assert.equal(fa4.ledState, 'unplugged');
  assert.equal(fa4.peerNode, null);

  // Move patch cord from Fa0/1 to free socket Fa0/4
  const movedLinks = moveLinkToSocket(preset.links, fa1.connectedLink!.id, sw1.id, fa4.port.id);
  const afterMove = getDeviceChassisPorts(sw1, preset.nodes, movedLinks, null);
  assert.equal(afterMove.find((d) => d.port.shortName === 'Fa0/1')?.ledState, 'unplugged');
  assert.equal(afterMove.find((d) => d.port.shortName === 'Fa0/4')?.ledState, 'link-up');
  assert.equal(afterMove.find((d) => d.port.shortName === 'Fa0/4')?.peerNode?.name, 'PC-1');

  // Check available target ports and port expansion
  const freePeerPorts = getAvailableTargetPorts(sw1.id, preset.nodes, preset.links);
  assert.ok(freePeerPorts.length >= 4, 'Should list free ports on other devices');

  const expandedSw = addHardwarePortToNode(sw1);
  assert.equal(expandedSw.interfaces.length, 9, 'Adding a port increases interface count to 9');
  assert.ok(expandedSw.interfaces.some((i) => i.shortName === 'Fa0/7'), 'Creates Fa0/7');

  const accessCols = groupPortsIntoTwoRows(descriptors.filter((d) => !d.isUplink));
  assert.equal(accessCols.length, 3, '6 FastEthernet ports group into 3 two-row columns');
  assert.equal(accessCols[0].top.port.shortName, 'Fa0/1');
  assert.equal(accessCols[0].bottom?.port.shortName, 'Fa0/2');
  assert.equal(accessCols[2].top.port.shortName, 'Fa0/5');
  assert.equal(accessCols[2].bottom?.port.shortName, 'Fa0/6');
});

test('Switch Web GUI VLAN database creation, bulk port assignment, and deletion work accurately', () => {
  const preset = TOPOLOGY_PRESETS[1]; // VLAN 802.1Q Trunk preset
  let sw = preset.nodes.find((n) => n.id === 'vlan-sw-1')!;

  const initialDb = getDeviceVlanDatabase(sw);
  assert.ok(initialDb.some((v) => v.id === 1), 'Includes default VLAN 1');
  assert.ok(initialDb.some((v) => v.id === 10), 'Includes VLAN 10');
  assert.ok(initialDb.some((v) => v.id === 20), 'Includes VLAN 20');

  // Create VLAN 40 (Accounting) and auto-allow on trunks
  sw = upsertDeviceVlan(sw, 40, 'VLAN0040_Accounting', '192.168.40.0/24', true);
  const afterUpsertDb = getDeviceVlanDatabase(sw);
  assert.ok(
    afterUpsertDb.some((v) => v.id === 40 && v.name === 'VLAN0040_Accounting'),
    'VLAN 40 added to switch VLAN database'
  );

  const trunkPort = sw.interfaces.find((i) => i.vlanMode === 'trunk')!;
  assert.ok(trunkPort.trunkAllowedVlans.includes(40), 'Trunk port automatically allows VLAN 40');

  // Bulk assign Fa0/3 and Fa0/4 to Access VLAN 40
  const targetPortIds = sw.interfaces
    .filter((i) => i.shortName === 'Fa0/3' || i.shortName === 'Fa0/4')
    .map((i) => i.id);
  sw = assignPortsToVlan(sw, targetPortIds, 40, 'access');
  assert.equal(
    sw.interfaces.find((i) => i.shortName === 'Fa0/3')?.accessVlan,
    40,
    'Fa0/3 assigned to Access VLAN 40'
  );
  assert.equal(
    sw.interfaces.find((i) => i.shortName === 'Fa0/4')?.accessVlan,
    40,
    'Fa0/4 assigned to Access VLAN 40'
  );

  // Delete VLAN 40 and verify ports revert to VLAN 1
  sw = deleteDeviceVlan(sw, 40);
  assert.equal(
    sw.interfaces.find((i) => i.shortName === 'Fa0/3')?.accessVlan,
    1,
    'Deleting VLAN 40 resets Fa0/3 back to default VLAN 1'
  );
  assert.ok(
    !getDeviceVlanDatabase(sw).some((v) => v.id === 40),
    'VLAN 40 removed from switch VLAN database'
  );
});

test('Multi-window 1U switch rack helpers allow opening multiple switches simultaneously and stack vertically', () => {
  let openIds: string[] = [];
  openIds = openChassisWindow(openIds, 'sw-1');
  openIds = openChassisWindow(openIds, 'sw-2');
  assert.deepEqual(openIds, ['sw-1', 'sw-2'], 'Both 1U switch windows remain open simultaneously');

  // Re-clicking sw-1 does not duplicate it or close sw-2
  openIds = openChassisWindow(openIds, 'sw-1');
  assert.deepEqual(openIds, ['sw-1', 'sw-2'], 'No duplicate window IDs');

  // Vertical 19-inch rack stacking coordinates do not overlap
  const pos0 = computeChassisInitialPosition(0);
  const pos1 = computeChassisInitialPosition(1);
  assert.equal(pos0.x, pos1.x, 'Rack units align on the same horizontal 19-inch rack column');
  assert.ok(pos1.y - pos0.y >= 135, 'Second 1U switch is stacked vertically below the first 1U switch');

  // Closing sw-1 keeps sw-2 open
  openIds = closeChassisWindow(openIds, 'sw-1');
  assert.deepEqual(openIds, ['sw-2'], 'Closing first 1U switch leaves second 1U switch open');
});

test('Switch equipment factory creates both standard 6-port and 24-port 1U switches with 2-row port banks', () => {
  const sw6 = createDeviceNode('switch', 1, 100, 100, undefined, 6);
  const sw24 = createDeviceNode('switch', 2, 200, 200, undefined, 24);

  const sw6Descriptors = getDeviceChassisPorts(sw6, [sw6, sw24], [], null);
  const sw6Access = sw6Descriptors.filter((d) => !d.isUplink);
  const sw6Uplinks = sw6Descriptors.filter((d) => d.isUplink);
  assert.equal(sw6Access.length, 6, 'Standard switch has 6 FastEthernet access ports');
  assert.equal(sw6Uplinks.length, 2, 'Standard switch has 2 Gigabit uplink ports');
  assert.equal(groupPortsIntoTwoRows(sw6Access).length, 3, '6-port switch groups into 3 columns of 2 rows');

  const sw24Descriptors = getDeviceChassisPorts(sw24, [sw6, sw24], [], null);
  const sw24Access = sw24Descriptors.filter((d) => !d.isUplink);
  const sw24Uplinks = sw24Descriptors.filter((d) => d.isUplink);
  assert.equal(sw24.name, 'SW24-2', '24-port switch receives SW24 prefix');
  assert.equal(sw24Access.length, 24, '24-port switch has 24 FastEthernet access ports (Fa0/1..Fa0/24)');
  assert.equal(sw24Uplinks.length, 2, '24-port switch has 2 Gigabit uplink ports (Gi0/1..Gi0/2)');

  const sw24Cols = groupPortsIntoTwoRows(sw24Access);
  assert.equal(sw24Cols.length, 12, '24-port switch groups into 12 columns of 2 rows');
  assert.equal(sw24Cols[0].top.port.shortName, 'Fa0/1');
  assert.equal(sw24Cols[0].bottom?.port.shortName, 'Fa0/2');
  assert.equal(sw24Cols[11].top.port.shortName, 'Fa0/23');
  assert.equal(sw24Cols[11].bottom?.port.shortName, 'Fa0/24');
});

test('Fix 1: Default Gateway subnet validation immediately rejects off-subnet gateway without ARP broadcast', () => {
  const preset = JSON.parse(JSON.stringify(TOPOLOGY_PRESETS[0]));
  const pc1 = preset.nodes.find((n: { id: string }) => n.id === 'node-pc-1')!;
  // PC-1 is 192.168.1.10/24, misconfigure gateway to 10.99.99.1
  pc1.defaultGateway = '10.99.99.1';

  const res = runPacketSimulation(preset.nodes, preset.links, 'node-pc-1', '192.168.2.100', 'ICMP');
  assert.equal(res.success, false, 'Packet transmission should fail when Default Gateway is off-subnet');
  assert.equal(res.steps.length, 0, 'Must not emit any ARP Request on the local L2 segment');
  assert.ok(
    res.summaryMessage.includes('Network is unreachable (Gateway not on local subnet)'),
    `Expected Gateway not on local subnet error, got: ${res.summaryMessage}`
  );
});

test('Fix 2: RFC 826 ARP discipline prevents broadcast frames from polluting bystander ARP tables while updating existing entries', () => {
  const preset = JSON.parse(JSON.stringify(TOPOLOGY_PRESETS[0]));
  const res = runPacketSimulation(preset.nodes, preset.links, 'node-pc-1', '192.168.2.100', 'ICMP');
  assert.equal(res.success, true);

  const updatedRtr = res.updatedNodes.find((n) => n.id === 'node-rtr-1')!;
  const updatedPc2 = res.updatedNodes.find((n) => n.id === 'node-pc-2')!;

  // Router (192.168.1.1) was the target of PC-1's ARP Request, so it MUST learn PC-1 (192.168.1.10)
  assert.ok(
    updatedRtr.arpTable.some((a) => a.ipAddress === '192.168.1.10'),
    'Target gateway router learns sender IP in ARP cache'
  );

  // Bystander PC-2 (192.168.1.11) received the flooded ARP Request for 192.168.1.1, so its ARP table must remain clean
  assert.equal(
    updatedPc2.arpTable.some((a) => a.ipAddress === '192.168.1.10'),
    false,
    'Bystander PC-2 ARP cache must not be polluted by broadcast ARP targeting 192.168.1.1'
  );

  // If PC-2 already has a stale entry for 192.168.1.10, RFC 826 Merge_flag updates it upon broadcast
  const presetWithExisting = JSON.parse(JSON.stringify(TOPOLOGY_PRESETS[0]));
  const pc2Pre = presetWithExisting.nodes.find((n: { id: string }) => n.id === 'node-pc-2')!;
  pc2Pre.arpTable.push({
    ipAddress: '192.168.1.10',
    macAddress: '00:00:00:00:00:00',
    interfaceName: 'Eth0',
    vlan: 10,
  });
  const resMerge = runPacketSimulation(
    presetWithExisting.nodes,
    presetWithExisting.links,
    'node-pc-1',
    '192.168.2.100',
    'ICMP'
  );
  const updatedPc2Merged = resMerge.updatedNodes.find((n) => n.id === 'node-pc-2')!;
  assert.equal(
    updatedPc2Merged.arpTable.find((a) => a.ipAddress === '192.168.1.10')?.macAddress,
    '00:1A:2B:AA:10:01',
    'Existing ARP entry on bystander host is updated with fresh MAC address'
  );
});

test('Fix 3: Router-originated traffic selects egress interface IP via findBestRoute instead of first interface', () => {
  const preset = JSON.parse(JSON.stringify(TOPOLOGY_PRESETS[0]));
  // RTR-Core has Fa0/0 = 192.168.1.1 (first interface) and Fa0/1 = 192.168.2.1 (second interface)
  // Pinging SRV-Web (192.168.2.100) from RTR-Core must use Fa0/1 (192.168.2.1) as Source IP
  const res = runPacketSimulation(preset.nodes, preset.links, 'node-rtr-1', '192.168.2.100', 'ICMP');
  assert.equal(res.success, true, `Router ping to 192.168.2.100 should succeed: ${res.summaryMessage}`);

  const echoReqStep = res.steps.find((s) => s.protocol === 'ICMP_ECHO_REQUEST')!;
  assert.ok(echoReqStep, 'Should emit ICMP_ECHO_REQUEST');
  assert.equal(
    echoReqStep.outboundPdu.l3.srcIp,
    '192.168.2.1',
    'Router must use egress interface Fa0/1 IP (192.168.2.1) rather than first interface Fa0/0 (192.168.1.1)'
  );

  const echoReplyStep = res.steps.find((s) => s.protocol === 'ICMP_ECHO_REPLY')!;
  assert.ok(echoReplyStep, 'Should emit ICMP_ECHO_REPLY');
  assert.equal(
    echoReplyStep.outboundPdu.l3.dstIp,
    '192.168.2.1',
    'Target host replies directly to the router egress IP 192.168.2.1'
  );
});

test('Fix 4: DHCP DORA detects pool exhaustion and refuses to assign duplicate IP addresses', () => {
  const preset = JSON.parse(JSON.stringify(TOPOLOGY_PRESETS[0]));
  const rtr = preset.nodes.find((n: { id: string }) => n.id === 'node-rtr-1')!;
  // Restrict VLAN 10 pool to a single IP: 192.168.1.10 (which is already used by PC-1!)
  rtr.services.dhcpPools[0].startIp = '192.168.1.10';
  rtr.services.dhcpPools[0].endIp = '192.168.1.10';

  const dhcpRes = runDhcpDoraSimulation(preset.nodes, preset.links, 'node-pc-2');
  assert.equal(dhcpRes.success, false, 'DHCP must fail when all pool IPs are already in use');
  assert.ok(
    dhcpRes.summaryMessage.includes('DHCP Pool Exhausted'),
    `Expected DHCP Pool Exhausted message, got: ${dhcpRes.summaryMessage}`
  );
  const protocols = dhcpRes.steps.map((s) => s.protocol);
  assert.ok(protocols.includes('DHCP_DISCOVER'), 'Sends DHCP_DISCOVER');
  assert.equal(protocols.includes('DHCP_OFFER'), false, 'Does not send duplicate DHCP_OFFER when pool is exhausted');
});

test('Fix 5: CLI ping <domain> executes real DNS_QUERY and DNS_RESPONSE packets over the network instead of bypassing stack', () => {
  const preset = JSON.parse(JSON.stringify(TOPOLOGY_PRESETS[0]));
  const pc1 = preset.nodes.find((n: { id: string }) => n.id === 'node-pc-1')!;

  // 1. Normal domain ping succeeds and generates real DNS + ICMP steps
  const okCli = executeIosCommand('ping app.corp.local', pc1, preset.nodes, preset.links);
  assert.ok(okCli.outputLines.some((l) => l.includes('!!!!!')), 'CLI ping app.corp.local succeeds when DNS server is reachable');
  const okProtocols = (okCli.triggeredSimulationSteps || []).map((s) => s.protocol);
  assert.ok(okProtocols.includes('DNS_QUERY'), 'Generates real DNS_QUERY packet on wire');
  assert.ok(okProtocols.includes('DNS_RESPONSE'), 'Generates real DNS_RESPONSE packet on wire');
  assert.ok(okProtocols.includes('ICMP_ECHO_REQUEST'), 'Generates ICMP_ECHO_REQUEST after DNS resolution');

  // 2. Shut down the DNS/Web server interface -> CLI domain ping must fail because DNS packet cannot reach server
  const brokenNodes = JSON.parse(JSON.stringify(preset.nodes));
  const srv = brokenNodes.find((n: { id: string }) => n.id === 'node-srv-1')!;
  srv.interfaces[0].adminStatus = 'down';

  const failCli = executeIosCommand('ping router.corp.local', pc1, brokenNodes, preset.links);
  assert.equal(
    failCli.outputLines.some((l) => l.includes('!!!!!')),
    false,
    'CLI domain ping must fail when DNS server port is down even if target router.corp.local (192.168.1.1) is local'
  );
  assert.ok(
    failCli.outputLines.some((l) => l.includes('DNS-запрос к серверу 192.168.2.100 не доставлен')),
    'CLI outputs real network DNS failure message'
  );
});

test('CCNA 1: Router-on-a-Stick (802.1Q Subinterfaces Fa0/0.10 & Fa0/0.20) routes inter-VLAN traffic over a single Trunk cable', () => {
  const ccnaPreset = JSON.parse(JSON.stringify(TOPOLOGY_PRESETS[3]));
  assert.equal(ccnaPreset.id, 'ccna-roas-stp-acl-nat');

  // Ping from PC-VLAN10 (192.168.10.10, VLAN 10) to PC-VLAN20 (192.168.20.10, VLAN 20)
  // Both VLANs share a single physical Trunk link (Fa0/0 <-> SW-Core Fa0/3) to RTR-Edge
  const res = runPacketSimulation(
    ccnaPreset.nodes,
    ccnaPreset.links,
    'ccna-pc-10',
    '192.168.20.10',
    'ICMP'
  );
  assert.equal(
    res.success,
    true,
    `Expected Router-on-a-Stick inter-VLAN ping to succeed, got: ${res.summaryMessage}`
  );

  // Verify 802.1Q tags 10 and 20 both traverse the router trunk link (ccna-link-roas)
  const roasLinkSteps = res.steps.filter((s) => s.linkId === 'ccna-link-roas');
  assert.ok(
    roasLinkSteps.some((s) => s.vlanTag === 10),
    'Traffic from VLAN 10 enters RTR-Edge over Trunk with 802.1Q tag 10'
  );
  assert.ok(
    roasLinkSteps.some((s) => s.vlanTag === 20),
    'Routed traffic exits RTR-Edge over the same Trunk with 802.1Q tag 20'
  );
});

test('CCNA 2: DHCP Relay (ip helper-address) forwards client broadcast DHCP Discover/Request across router to central DHCP server', () => {
  const ccnaPreset = JSON.parse(JSON.stringify(TOPOLOGY_PRESETS[3]));

  // PC-VLAN10 is in VLAN 10 (192.168.10.0/24), while SRV-Cloud-ISP (DHCP server) is in 203.0.113.0/24!
  // RTR-Edge Fa0/0.10 has helperAddress = 203.0.113.100
  const dhcpRes = runDhcpDoraSimulation(ccnaPreset.nodes, ccnaPreset.links, 'ccna-pc-10');
  assert.equal(
    dhcpRes.success,
    true,
    `Expected DHCP Relay across router to central server to succeed, got: ${dhcpRes.summaryMessage}`
  );
  assert.ok(
    dhcpRes.summaryMessage.includes('через Relay'),
    'Summary message confirms DHCP Relay via RTR-Edge'
  );

  const updatedPc10 = dhcpRes.updatedNodes.find((n) => n.id === 'ccna-pc-10')!;
  assert.equal(
    updatedPc10.interfaces[0].ipAddress,
    '192.168.10.50',
    'PC-VLAN10 receives 192.168.10.50 from central DHCP server pool RELAY_VLAN10_POOL'
  );
  assert.equal(updatedPc10.defaultGateway, '192.168.10.1');
  assert.equal(updatedPc10.dnsServer, '203.0.113.100');
});

test('CCNA 3: Spanning Tree Protocol (STP 802.1D) elects Root Bridge and puts redundant loop port in BLK state with orange LED', () => {
  const ccnaPreset = JSON.parse(JSON.stringify(TOPOLOGY_PRESETS[3]));
  const stpMap = computeSpanningTreeState(ccnaPreset.nodes, ccnaPreset.links);

  // SW-Core has priority 4096 -> must be Root Bridge
  assert.equal(stpMap['ccna-sw-core'].isRootBridge, true, 'SW-Core (priority 4096) is elected Root Bridge');
  assert.equal(stpMap['ccna-sw-1'].isRootBridge, false, 'SW-Floor1 is Non-Root');
  assert.equal(stpMap['ccna-sw-2'].isRootBridge, false, 'SW-Floor2 is Non-Root');

  // On the redundant link ccna-link-stp3 (SW-Floor1 Gi0/2 <-> SW-Floor2 Gi0/2),
  // SW-Floor1 has lower MAC than SW-Floor2, so SW-Floor1 Gi0/2 is Designated (FWD) and SW-Floor2 Gi0/2 is Alternate (BLK)
  const sw1Gi2 = stpMap['ccna-sw-1'].ports['csw1-gi0/2'];
  const sw2Gi2 = stpMap['ccna-sw-2'].ports['csw2-gi0/2'];
  assert.equal(sw1Gi2.role, 'designated');
  assert.equal(sw1Gi2.state, 'forwarding');
  assert.equal(sw2Gi2.role, 'alternate', 'SW-Floor2 Gi0/2 is placed in Alternate role');
  assert.equal(sw2Gi2.state, 'blocking', 'SW-Floor2 Gi0/2 is placed in STP Blocking (BLK) state');

  // Verify 1U switch front panel port descriptor gets ledState === 'stp-blocking' and ledLabel === 'BLK'
  const sw2Node = ccnaPreset.nodes.find((n: { id: string }) => n.id === 'ccna-sw-2')!;
  const sw2ChassisPorts = getDeviceChassisPorts(sw2Node, ccnaPreset.nodes, ccnaPreset.links, null);
  const gi2Desc = sw2ChassisPorts.find((d) => d.port.id === 'csw2-gi0/2')!;
  assert.equal(gi2Desc.ledState, 'stp-blocking', '1U switch panel shows orange stp-blocking LED on blocked port');
  assert.equal(gi2Desc.ledLabel, 'BLK');

  // Verify broadcast frames do NOT loop infinitely in the 3-switch triangle (dropped by STP on ccna-link-stp3)
  const pingRes = runPacketSimulation(ccnaPreset.nodes, ccnaPreset.links, 'ccna-pc-10', '192.168.10.99', 'ICMP');
  const forwardedBlockedLinkFrames = pingRes.steps.filter(
    (s) => s.linkId === 'ccna-link-stp3' && s.status !== 'dropped'
  );
  assert.equal(
    forwardedBlockedLinkFrames.length,
    0,
    'STP Blocked link ccna-link-stp3 must not forward broadcast ARP frames'
  );
});

test('CCNA 4: Router Access Control Lists (ACL) filter packets and emit visual ACL Drop step', () => {
  const ccnaPreset = JSON.parse(JSON.stringify(TOPOLOGY_PRESETS[3]));
  const rtr = ccnaPreset.nodes.find((n: { id: string }) => n.id === 'ccna-rtr-1')!;

  // Add an ACL rule via CLI: access-list 100 deny icmp any host 203.0.113.100
  executeIosCommand('conf t', rtr, ccnaPreset.nodes, ccnaPreset.links);
  const aclCmd = executeIosCommand(
    'access-list 100 deny icmp any host 203.0.113.100',
    rtr,
    ccnaPreset.nodes,
    ccnaPreset.links
  );
  // Prepend or ensure the deny rule has lower seq than default permit rule
  aclCmd.updatedNode.aclRules = [
    {
      id: 'acl-deny-test',
      seq: 5,
      action: 'deny',
      protocol: 'ICMP',
      srcIp: 'any',
      dstIp: '203.0.113.100',
      enabled: true,
    },
    ...(aclCmd.updatedNode.aclRules || []),
  ];
  const nodesWithAcl = ccnaPreset.nodes.map((n: { id: string }) =>
    n.id === rtr.id ? aclCmd.updatedNode : n
  );

  // 1. ICMP Ping from PC-VLAN10 to 203.0.113.100 must be dropped by ACL #5
  const icmpRes = runPacketSimulation(nodesWithAcl, ccnaPreset.links, 'ccna-pc-10', '203.0.113.100', 'ICMP');
  assert.equal(icmpRes.success, false, 'ICMP Ping must be blocked by Router ACL');
  const aclDroppedStep = icmpRes.steps.find(
    (s) => s.status === 'dropped' && s.decisionTitle.includes('ACL Drop')
  );
  assert.ok(aclDroppedStep, 'Simulation records an explicit ACL Drop step at the router');

  // 2. HTTP GET to http://cloud.netpulse.org (203.0.113.100) is still permitted by ACL #10 (permit ANY)
  const httpRes = runHttpBrowserSimulation(
    nodesWithAcl,
    ccnaPreset.links,
    'ccna-pc-10',
    'http://cloud.netpulse.org'
  );
  assert.equal(httpRes.success, true, 'HTTP traffic is permitted when only ICMP is denied');
});

test('CCNA 5: NAT / PAT Overload translates private Inside Local IP to public Outside Global IP and populates NAT table', () => {
  const ccnaPreset = JSON.parse(JSON.stringify(TOPOLOGY_PRESETS[3]));

  // Ping from PC-VLAN10 (192.168.10.10, inside) to SRV-Cloud-ISP (203.0.113.100, outside)
  const res = runPacketSimulation(
    ccnaPreset.nodes,
    ccnaPreset.links,
    'ccna-pc-10',
    '203.0.113.100',
    'ICMP'
  );
  assert.equal(res.success, true, `NAT Ping should succeed: ${res.summaryMessage}`);

  // On the WAN link (ccna-link-wan), the outbound ICMP Echo Request must have srcIp translated to 203.0.113.1!
  const wanEchoReq = res.steps.find(
    (s) => s.linkId === 'ccna-link-wan' && s.protocol === 'ICMP_ECHO_REQUEST'
  )!;
  assert.ok(wanEchoReq, 'ICMP_ECHO_REQUEST traverses WAN link');
  assert.equal(
    wanEchoReq.inboundPdu.l3.srcIp,
    '192.168.10.10',
    'Inbound PDU at router has private Inside Local IP 192.168.10.10'
  );
  assert.equal(
    wanEchoReq.outboundPdu.l3.srcIp,
    '203.0.113.1',
    'Outbound PDU on WAN link has public Inside Global IP 203.0.113.1 (NAT translated)'
  );

  // Check router NAT translation table and CLI show ip nat translations
  const updatedRtr = res.updatedNodes.find((n) => n.id === 'ccna-rtr-1')!;
  assert.ok(
    (updatedRtr.natTranslations || []).length >= 1,
    'Router records NAT translation entry in natTranslations table'
  );
  assert.equal(updatedRtr.natTranslations![0].insideIp, '192.168.10.10');
  assert.equal(updatedRtr.natTranslations![0].globalIp, '203.0.113.1');
  assert.equal(updatedRtr.natTranslations![0].outsideIp, '203.0.113.100');

  const natCli = executeIosCommand('show ip nat translations', updatedRtr, res.updatedNodes, ccnaPreset.links);
  assert.ok(
    natCli.outputLines.some((l) => l.includes('203.0.113.1') && l.includes('192.168.10.10')),
    'CLI show ip nat translations displays the active NAT/PAT session'
  );
});

test('PC Monitor: formatIpv4Input automatically inserts dots between octets and suggestSubnetMaskForIp selects mask by IP class', () => {
  // Typing 3 digits in the first octet auto-appends a dot
  assert.equal(formatIpv4Input('192', '19'), '192.');
  // Continuing to type 168 auto-appends the second dot
  assert.equal(formatIpv4Input('192.168', '192.16'), '192.168.');
  // Pressing Backspace on a trailing dot deletes the dot without re-adding it
  assert.equal(formatIpv4Input('192', '192.'), '192');
  // Typing continuous digits without dots splits into valid octets automatically
  assert.equal(formatIpv4Input('192168001010', ''), '192.168.001.010');
  // Typing space converts to dot
  assert.equal(formatIpv4Input('10 ', '10'), '10.');

  // Auto-filled subnet mask by IP class
  assert.equal(suggestSubnetMaskForIp('10.0.0.15'), '255.0.0.0');
  assert.equal(suggestSubnetMaskForIp('172.16.5.20'), '255.255.0.0');
  assert.equal(suggestSubnetMaskForIp('192.168.1.10'), '255.255.255.0');
  assert.equal(suggestSubnetMaskForIp(''), '255.255.255.0');
});

test('Cisco ISR Router GUI helpers manage 802.1Q subinterfaces, static routes, route discovery, and ACL sequencing', () => {
  let rtr = createDeviceNode('router', 1, 100, 100, 'RTR-Edge');
  const fa0Id = rtr.interfaces[0].id;

  // 1. Upserting 802.1Q subinterface switches parent port to trunk and adds connected route
  rtr = upsertRouterSubinterface(rtr, fa0Id, {
    vlanId: 30,
    ipAddress: '192.168.30.1',
    subnetMask: '255.255.255.0',
    helperAddress: '203.0.113.100',
    natRole: 'inside',
  });
  assert.equal(rtr.interfaces[0].vlanMode, 'trunk', 'Parent port automatically becomes 802.1Q trunk');
  assert.ok(rtr.interfaces[0].trunkAllowedVlans.includes(30), 'Trunk allows VLAN 30');
  assert.equal(rtr.interfaces[0].subinterfaces?.length, 1);
  assert.equal(rtr.natEnabled, true, 'Setting natRole=inside enables router NAT');
  assert.ok(
    rtr.routingTable.some((rt) => rt.network === '192.168.30.0' && rt.interfaceName === 'Fa0/0.30'),
    'Connected route for Fa0/0.30 is synced into routingTable'
  );

  // Removing subinterface cleans up connected route
  rtr = removeRouterSubinterface(rtr, fa0Id, 30);
  assert.equal(rtr.interfaces[0].subinterfaces?.length, 0);

  // 2. Adding static route normalizes network address and validates IPv4/mask
  rtr.interfaces[0].ipAddress = '10.0.0.1';
  rtr.interfaces[0].subnetMask = '255.255.255.252';
  const badRes = addRouterStaticRoute(rtr, '999.1.1.0', '255.255.255.0', '10.0.0.2');
  assert.ok(badRes.error, 'Rejects invalid destination IP');

  const okRes = addRouterStaticRoute(rtr, '172.16.2.50', '255.255.255.0', '10.0.0.2');
  assert.equal(okRes.error, null);
  rtr = okRes.updatedNode;
  const staticRt = rtr.routingTable.find((rt) => rt.type === 'S')!;
  assert.equal(staticRt.network, '172.16.2.0', 'Normalizes host IP 172.16.2.50 to network 172.16.2.0');
  assert.equal(staticRt.nextHop, '10.0.0.2');
  assert.equal(staticRt.interfaceName, 'Fa0/0');

  // 3. Auto-discovering remote subnets across WAN topology
  const wanPreset = JSON.parse(JSON.stringify(TOPOLOGY_PRESETS[2]));
  const rtrhq = wanPreset.nodes.find((n: { id: string }) => n.id === 'wan-rtr-1')!;
  // Clear static routes on RTR-HQ to test auto-suggestion of RTR-Branch subnet
  rtrhq.routingTable = rtrhq.routingTable.filter((r: { type: string }) => r.type !== 'S');
  const suggestions = getSuggestedStaticRoutes(rtrhq, wanPreset.nodes);
  assert.ok(
    suggestions.some((s) => s.network === '172.16.2.0' && s.nextHop === '10.0.0.2'),
    'Auto-discovers remote 172.16.2.0/24 subnet via 10.0.0.2 on peer router'
  );

  // 4. Adding ACL rules sorts by sequence number
  rtr = addRouterAclRule(rtr, {
    seq: 20,
    action: 'permit',
    protocol: 'ANY',
    srcIp: 'any',
    dstIp: 'any',
  });
  rtr = addRouterAclRule(rtr, {
    seq: 10,
    action: 'deny',
    protocol: 'ICMP',
    srcIp: '192.168.10.0/24',
    dstIp: 'any',
  });
  assert.equal(rtr.aclRules?.length, 2);
  assert.equal(rtr.aclRules?.[0].seq, 10);
  assert.equal(rtr.aclRules?.[0].action, 'deny');
  assert.equal(rtr.aclRules?.[1].seq, 20);
});

test('Multi-Packet Stream Engine: generates multi-flow traffic (STP, ARP, ICMP, DNS, HTTP), groups broadcast waves, filters by protocol, and computes Inbound/Outbound PDU diffs', () => {
  const ccnaPreset = JSON.parse(JSON.stringify(TOPOLOGY_PRESETS[3]));

  // 1. Multi-Flow generator produces STP BPDU, ICMP, DNS, and HTTP packets
  const batch = generateMultiFlowTrafficSteps(ccnaPreset.nodes, ccnaPreset.links, 1);
  assert.ok(batch.steps.length >= 10, `Expected >= 10 multi-flow steps, got ${batch.steps.length}`);

  const stats = countStepsByProtocolCategory(batch.steps);
  assert.ok(stats.counts.STP >= 1, 'Includes STP 802.1D BPDU frames');
  assert.ok(stats.counts.ICMP >= 1, 'Includes ICMP Echo frames');
  assert.ok(stats.counts.HTTP >= 1 || stats.counts.DNS >= 1, 'Includes DNS/HTTP application flows');

  // 2. Protocol filtering hides disabled protocol categories and filters by device/search
  const filterOpts = {
    enabledCategories: {
      ...createDefaultEnabledCategories(),
      STP: false,
      ARP: false,
    },
    onlyDropped: false,
    deviceFilterId: 'ALL',
    searchQuery: '',
  };
  const filtered = filterSimulationSteps(batch.steps, filterOpts);
  assert.ok(
    filtered.every(
      (entry) =>
        getProtocolCategory(entry.step.protocol) !== 'STP' &&
        getProtocolCategory(entry.step.protocol) !== 'ARP'
    ),
    'Filtered steps exclude disabled STP and ARP categories'
  );

  // 3. Realtime mode builds concurrent 10x10 packet square descriptors for all filtered steps
  const realtimeSquares = buildCanvasPacketSquares({
    nodes: batch.updatedNodes,
    steps: batch.steps,
    activeStepIndex: 0,
    stepProgress: 0.5,
    executionMode: 'realtime',
    liveStreamPhase: 0.35,
    filterOptions: filterOpts,
  });
  assert.ok(
    realtimeSquares.length >= 6 && realtimeSquares.length <= filtered.length,
    'Realtime mode renders evenly staggered moving squares across active links'
  );

  // 4. Broadcast wave grouping groups sibling ARP_REQUEST flood hops emitted by a switch
  const preset0 = JSON.parse(JSON.stringify(TOPOLOGY_PRESETS[0]));
  const arpSim = runPacketSimulation(
    preset0.nodes,
    preset0.links,
    'node-pc-1',
    '192.168.2.100',
    'ICMP'
  );
  const floodIdx = arpSim.steps.findIndex(
    (s) => s.fromNodeId === 'node-sw-1' && s.protocol === 'ARP_REQUEST'
  );
  assert.ok(floodIdx >= 0, 'Switch emits ARP_REQUEST flood step');
  const waveIndices = getConcurrentBroadcastWaveIndices(arpSim.steps, floodIdx);
  assert.ok(waveIndices.length >= 2, 'Broadcast wave groups multiple concurrent flood ports on the switch');

  // 5. Inbound vs Outbound PDU Diff detects NAT IP translation and L2 MAC rewrite on CCNA WAN hop
  const wanEchoStep = batch.steps.find(
    (s) => s.linkId === 'ccna-link-wan' && s.protocol === 'ICMP_ECHO_REQUEST'
  );
  if (wanEchoStep) {
    const diff = computePduHeaderDiff(wanEchoStep);
    assert.equal(diff.ipNatChanged, true, 'Detects NAT Inside Local -> Inside Global IP rewrite');
    assert.equal(diff.macChanged, true, 'Detects L2 MAC rewrite across router hop');
    assert.ok(diff.changeBadges.includes('NAT / PAT IP'));
  }
});

test('Stage 1 Dynamic L3 Routing: OSPFv2 Neighbor Table, Dijkstra SPF Cost (100Mbps/BW), automatic link failover, CLI router ospf 1, and OSPF_HELLO / OSPF_LSA packets', () => {
  const wanPreset = JSON.parse(JSON.stringify(TOPOLOGY_PRESETS[2]));
  const rtrBranch = wanPreset.nodes.find((n: { id: string }) => n.id === 'wan-rtr-1')!;
  const rtrHq = wanPreset.nodes.find((n: { id: string }) => n.id === 'wan-rtr-2')!;

  // Remove static routes so routing relies purely on OSPFv2 Dijkstra SPF
  rtrBranch.routingTable = rtrBranch.routingTable.filter((r: { type: string }) => r.type !== 'S');
  rtrHq.routingTable = rtrHq.routingTable.filter((r: { type: string }) => r.type !== 'S');

  // 1. Verify OSPF Neighbor adjacency table (show ip ospf neighbor)
  const neighbors = computeOspfNeighborsForRouter(rtrBranch, wanPreset.nodes, wanPreset.links);
  assert.equal(
    neighbors.length,
    2,
    'RTR-Branch forms 2 OSPF adjacencies with RTR-HQ (primary Gi0/0 and backup Fa0/1)'
  );
  assert.ok(neighbors.some((nb) => nb.localInterface === 'Gi0/0' && nb.interfaceCost === 1));
  assert.ok(neighbors.some((nb) => nb.localInterface === 'Fa0/1' && nb.interfaceCost === 10));

  // 2. Verify Dijkstra SPF selects Primary Fiber Gi0/0 (Cost = 1 + 1 = 2) over Backup Fa0/1 (Cost = 10 + 1 = 11)
  const spfRoutes = computeDijkstraSpfRoutesForRouter(rtrBranch, wanPreset.nodes, wanPreset.links);
  const routeToHqLan = spfRoutes.find((r) => r.network === '172.16.2.0')!;
  assert.ok(routeToHqLan, 'OSPF SPF learns remote 172.16.2.0/24 subnet');
  assert.equal(routeToHqLan.type, 'O');
  assert.equal(routeToHqLan.administrativeDistance, 110);
  assert.equal(routeToHqLan.nextHop, '10.0.0.2', 'Selects primary 1Gbps fiber next-hop 10.0.0.2');
  assert.equal(routeToHqLan.interfaceName, 'Gi0/0');
  assert.equal(routeToHqLan.metric, 2, 'Cumulative SPF cost is 1 (Gi0/0 transit) + 1 (HQ LAN) = 2');

  // 3. Simulate cable/interface failure on primary Gi0/0 -> verify automatic SPF failover to Backup Fa0/1 (10.0.1.2, Cost=11)
  const linksWithoutPrimary = wanPreset.links.filter((l: { id: string }) => l.id !== 'wlink-wan');
  const failoverBest = findBestRoute(rtrBranch, '172.16.2.50', wanPreset.nodes, linksWithoutPrimary);
  assert.ok(failoverBest, 'Router immediately finds backup OSPF route after primary cable cut');
  assert.equal(failoverBest?.type, 'O');
  assert.equal(
    failoverBest?.nextHop,
    '10.0.1.2',
    'OSPF automatically reconverges to backup link Fa0/1 (10.0.1.2)'
  );
  assert.equal(failoverBest?.interfaceName, 'Fa0/1');
  assert.equal(failoverBest?.metric, 11, 'Backup cumulative SPF cost is 10 (Fa0/1 10Mbps) + 1 = 11');

  // Verify end-to-end ICMP Ping from PC-Branch to SRV-HQ-DB succeeds over the backup OSPF link!
  const pingOverBackup = runPacketSimulation(
    wanPreset.nodes,
    linksWithoutPrimary,
    'wan-pc-1',
    '172.16.2.50',
    'ICMP'
  );
  assert.equal(
    pingOverBackup.success,
    true,
    'ICMP Ping succeeds across backup link via OSPF reconvergence'
  );

  // 4. Verify OSPF Hello (224.0.0.5) & LSA packet stream synthesis
  const ospfSteps = synthesizeOspfHelloSteps(wanPreset.nodes, wanPreset.links, 1, 0);
  assert.ok(ospfSteps.some((s) => s.protocol === 'OSPF_HELLO'), 'Emits OSPF_HELLO multicast 224.0.0.5 steps');
  assert.ok(ospfSteps.some((s) => s.protocol === 'OSPF_LSA'), 'Emits OSPF_LSA Link-State Update steps');
  assert.equal(getProtocolCategory('OSPF_HELLO'), 'OSPF');
  assert.equal(getProtocolCategory('OSPF_LSA'), 'OSPF');

  // 5. Verify Cisco IOS CLI commands: router ospf 1, network <ip> <wildcard> area 0, show ip ospf neighbor, show ip route ospf
  let cliRouter = createDeviceNode('router', 9, 200, 200, 'RTR-Core');
  cliRouter.interfaces[0].ipAddress = '10.0.0.1';
  cliRouter.interfaces[0].subnetMask = '255.255.255.252';
  cliRouter = executeIosCommand('enable', cliRouter, [cliRouter], []).updatedNode;
  cliRouter = executeIosCommand('conf t', cliRouter, [cliRouter], []).updatedNode;
  cliRouter = executeIosCommand('router ospf 1', cliRouter, [cliRouter], []).updatedNode;
  assert.equal(cliRouter.cli.mode, 'config-router');
  assert.equal(cliRouter.ospfConfig?.enabled, true);

  const netRes = executeIosCommand(
    'network 10.0.0.0 0.0.0.3 area 0',
    cliRouter,
    [cliRouter],
    []
  );
  cliRouter = netRes.updatedNode;
  assert.equal(cliRouter.ospfConfig?.networks.length, 1);
  assert.equal(cliRouter.ospfConfig?.networks[0].network, '10.0.0.0');
  assert.equal(cliRouter.ospfConfig?.networks[0].wildcard, '0.0.0.3');

  const showNbrCli = executeIosCommand(
    'show ip ospf neighbor',
    rtrBranch,
    wanPreset.nodes,
    wanPreset.links
  );
  assert.ok(
    showNbrCli.outputLines.some((l) => l.includes('172.16.2.1') && l.includes('FULL')),
    'CLI show ip ospf neighbor displays FULL adjacency with RTR-HQ (172.16.2.1)'
  );

  const showRouteOspfCli = executeIosCommand(
    'show ip route ospf',
    rtrBranch,
    wanPreset.nodes,
    wanPreset.links
  );
  assert.ok(
    showRouteOspfCli.outputLines.some((l) => l.includes('O    172.16.2.0/255.255.255.0 [110/2]')),
    'CLI show ip route ospf outputs OSPF route with [110/2] AD and cost'
  );

  // Synced routing table includes Connected + OSPF routes
  const syncedRoutes = syncConnectedRoutes(rtrBranch, wanPreset.nodes, wanPreset.links);
  assert.ok(syncedRoutes.some((r) => r.type === 'O' && r.network === '172.16.2.0'));
});

test('Multi-Preset Laboratory Suite: all 16 presets define valid testScenarios and Core Self-Diagnostics (L1-L7) passes 17/17 checks', () => {
  assert.equal(TOPOLOGY_PRESETS.length, 16, 'Must provide 16 laboratory topology presets');

  for (const preset of TOPOLOGY_PRESETS) {
    assert.ok(preset.shortTag, `Preset ${preset.id} must have a shortTag`);
    assert.ok(
      preset.testScenarios && preset.testScenarios.length >= 3,
      `Preset ${preset.id} must provide at least 3 built-in test scenarios`
    );
  }

  // Execute the full L1-L7 Core Self-Diagnostics Suite across all 15 presets
  const report = runCoreDiagnosticsSuite();
  for (const check of report.results) {
    assert.equal(
      check.passed,
      true,
      `Core diagnostic check [${check.id}] (${check.title}) failed: ${check.detail}`
    );
  }
  assert.equal(report.totalChecks, 17);
  assert.equal(report.passedChecks, 17);
  assert.equal(report.allPassed, true);
});

test('Stage 2 Multilayer Switch L3 (SVI Vlan10/Vlan20) & EtherChannel LACP (IEEE 802.3ad Po1): STP forwarding on bundled links, SVI inter-VLAN routing, DHCP Relay, and CLI commands', () => {
  const p8 = JSON.parse(
    JSON.stringify(TOPOLOGY_PRESETS.find((p) => p.id === 'l3-switch-svi-etherchannel')!)
  );

  // 1. Verify STP 802.1D treats Po1 (Gi0/1 + Gi0/2) as a single logical channel with 2000 Mbps and both ports in FORWARDING (never BLK)
  const stp = computeSpanningTreeState(p8.nodes, p8.links);
  const corePorts = stp['l3sw-core'].ports;
  const accessPorts = stp['l3sw-access'].ports;

  assert.equal(corePorts['l3c-gi0/1'].state, 'forwarding');
  assert.equal(corePorts['l3c-gi0/2'].state, 'forwarding');
  assert.equal(accessPorts['l3a-gi0/1'].state, 'forwarding');
  assert.equal(accessPorts['l3a-gi0/2'].state, 'forwarding');
  assert.equal(accessPorts['l3a-gi0/1'].portChannelName, 'Po1');
  assert.equal(accessPorts['l3a-gi0/2'].portChannelName, 'Po1');
  assert.equal(accessPorts['l3a-gi0/1'].aggregatedBandwidthMbps, 2000);
  assert.equal(stp['l3sw-access'].rootPathCost, 2, '2x1Gbps Po1 bundle halves STP path cost from 4 to 2');

  // 2. Verify Inter-VLAN Routing directly inside L3 Switch (PC-Sales-V10 192.168.10.10 -> PC-Eng-V20 192.168.20.20) without any external router
  const interVlanPing = runPacketSimulation(
    p8.nodes,
    p8.links,
    'l3sw-pc-10',
    '192.168.20.20',
    'ICMP'
  );
  assert.equal(interVlanPing.success, true, 'L3 Switch routes ICMP across Vlan10 -> Vlan20 SVI');
  assert.ok(
    interVlanPing.steps.some(
      (s) => s.fromNodeId === 'l3sw-core' && s.protocol === 'ICMP_ECHO_REQUEST'
    ),
    'Emits L3 Routing step inside SW-Core-L3'
  );

  // 3. Verify CLI commands on a fresh switch: ip routing, interface Vlan10, ip address, channel-group 1 mode active, show etherchannel summary
  let sw = createDeviceNode('switch', 1, 100, 100, 'SW-Test-L3');
  sw = executeIosCommand('enable', sw, [sw], []).updatedNode;
  sw = executeIosCommand('conf t', sw, [sw], []).updatedNode;
  sw = executeIosCommand('ip routing', sw, [sw], []).updatedNode;
  assert.equal(sw.ipRoutingEnabled, true);

  sw = executeIosCommand('interface vlan 10', sw, [sw], []).updatedNode;
  sw = executeIosCommand('ip address 10.10.10.1 255.255.255.0', sw, [sw], []).updatedNode;
  assert.equal(sw.sviInterfaces?.length, 1);
  assert.equal(sw.sviInterfaces?.[0].name, 'Vlan10');
  assert.equal(sw.sviInterfaces?.[0].ipAddress, '10.10.10.1');

  sw = executeIosCommand('interface Fa0/1', sw, [sw], []).updatedNode;
  sw = executeIosCommand('channel-group 1 mode active', sw, [sw], []).updatedNode;
  assert.equal(sw.interfaces[0].channelGroup, 1);
  assert.equal(sw.interfaces[0].channelMode, 'active');

  const ethSummary = executeIosCommand('show etherchannel summary', p8.nodes[0], p8.nodes, p8.links);
  assert.ok(
    ethSummary.outputLines.some((l) => l.includes('Po1(SU)') && l.includes('LACP')),
    'CLI show etherchannel summary displays Po1(SU) LACP bundle'
  );
});

test('Stage 3 Wi-Fi 802.11 Module: Coverage Zones, WPA2-PSK 4-Way Handshake, Airwave Scanner, DHCP over Wi-Fi, and ESS Seamless Roaming', () => {
  const p9 = JSON.parse(
    JSON.stringify(TOPOLOGY_PRESETS.find((p) => p.id === 'wifi-campus-roaming-lab')!)
  );

  const laptop = p9.nodes.find((n: { id: string }) => n.id === 'wifi-laptop-1')!;
  const apWest = p9.nodes.find((n: { id: string }) => n.id === 'wifi-ap-west')!;

  // 1. Signal metrics & airwave scanner
  const westSignal = computeWifiSignalMetrics(laptop, apWest);
  assert.equal(westSignal.inRange, true, 'Laptop-Pro starts inside AP-West coverage zone');
  assert.ok(westSignal.rssiDbm > -80 && westSignal.rssiDbm <= -35);

  const scanned = scanAvailableWifiNetworks(laptop, p9.nodes, p9.links);
  assert.equal(scanned.length, 3, 'Scanner discovers AP-West, AP-East, and SOHO-WiFi-RTR');
  const associatedWest = scanned.find((s) => s.apNodeId === 'wifi-ap-west')!;
  assert.equal(associatedWest.isConnected, true);

  // 2. WPA2-PSK authentication: wrong password fails, correct password succeeds
  const wrongPassRes = connectWirelessClientToAp(
    p9.nodes,
    p9.links,
    'wifi-laptop-1',
    'wifi-ap-west',
    'wrong-pass'
  );
  assert.equal(wrongPassRes.ok, false, 'Rejects wrong WPA2-PSK password');
  assert.ok(wrongPassRes.error?.includes('WPA2-PSK'));

  const okPassRes = connectWirelessClientToAp(
    p9.nodes,
    p9.links,
    'wifi-laptop-1',
    'wifi-ap-west',
    'cisco123'
  );
  assert.equal(okPassRes.ok, true, 'Accepts matching WPA2-PSK password');

  // 3. End-to-end ICMP Ping and DHCP DORA over Wi-Fi 802.11
  const wifiPing = runPacketSimulation(
    p9.nodes,
    p9.links,
    'wifi-laptop-1',
    '192.168.20.100',
    'ICMP'
  );
  assert.equal(wifiPing.success, true, 'Laptop-Pro pings SRV-Portal over Wi-Fi + L3 Router');

  const wifiDhcp = runDhcpDoraSimulation(p9.nodes, p9.links, 'wifi-phone-1');
  assert.equal(wifiDhcp.success, true, 'Phone-iOS obtains IP lease via DHCP DORA over Wi-Fi');

  // 4. Seamless ESS Roaming when Laptop-Pro moves from AP-West (x=155,y=495) to AP-East (x=520,y=460)
  const movedToEastNodes = p9.nodes.map((n: { id: string }) =>
    n.id === 'wifi-laptop-1' ? { ...n, x: 520, y: 460 } : n
  );
  const roamed = syncWirelessAssociations(movedToEastNodes, p9.links);
  assert.ok(roamed.roamingEvents.length >= 1, 'Detects out-of-range from AP-West and triggers ESS roam');
  assert.ok(
    roamed.links.some(
      (l) =>
        l.cableType === 'wireless' &&
        ((l.sourceNodeId === 'wifi-laptop-1' && l.targetNodeId === 'wifi-ap-east') ||
          (l.sourceNodeId === 'wifi-ap-east' && l.targetNodeId === 'wifi-laptop-1'))
    ),
    'Laptop-Pro automatically roams to AP-East (same SSID Corp-WiFi)'
  );

  // Ping after roaming to AP-East still succeeds
  const pingAfterRoam = runPacketSimulation(
    roamed.nodes,
    roamed.links,
    'wifi-laptop-1',
    '192.168.20.100',
    'ICMP'
  );
  assert.equal(pingAfterRoam.success, true, 'Ping succeeds immediately after roaming to AP-East');

  // 5. Disconnecting wireless client removes the wireless link
  const discRes = disconnectWirelessClient(roamed.nodes, roamed.links, 'wifi-laptop-1');
  assert.equal(
    discRes.links.some(
      (l) =>
        l.cableType === 'wireless' &&
        (l.sourceNodeId === 'wifi-laptop-1' || l.targetNodeId === 'wifi-laptop-1')
    ),
    false,
    'Disconnecting wireless client removes its 802.11 link'
  );
});

test('Stage 4 Enterprise WLC 5520 & Lightweight AP (CAPWAP UDP 5246/5247): centralized SSID/VLAN provisioning, RRM auto-channel (1/6/11), and CAPWAP packet synthesis', () => {
  const p10 = JSON.parse(
    JSON.stringify(TOPOLOGY_PRESETS.find((p) => p.id === 'wlc-capwap-enterprise-lab')!)
  ) as (typeof TOPOLOGY_PRESETS)[number];

  // 1. Verify WLC CAPWAP Discovery & Join across all 3 Lightweight APs
  const capwapSync = syncWlcCapwapController(p10.nodes, p10.links);

  const lap1 = capwapSync.nodes.find((n) => n.id === 'wlc-lap-1')!;
  const lap2 = capwapSync.nodes.find((n) => n.id === 'wlc-lap-2')!;
  const lap3 = capwapSync.nodes.find((n) => n.id === 'wlc-lap-3')!;

  assert.equal(lap1.wifiConfig?.capwapStatus, 'joined');
  assert.equal(lap2.wifiConfig?.capwapStatus, 'joined');
  assert.equal(lap3.wifiConfig?.capwapStatus, 'joined');
  assert.equal(lap1.wifiConfig?.wlcControllerName, 'WLC-5520');
  assert.equal(lap1.wifiConfig?.wlcManagementIp, '192.168.10.5');

  // 2. Verify RRM Dynamic Channel Assignment assigns non-overlapping channels 1, 6, 11
  assert.equal(lap1.wifiConfig?.channel, 1);
  assert.equal(lap2.wifiConfig?.channel, 6);
  assert.equal(lap3.wifiConfig?.channel, 11);

  // 3. Verify centralized WLAN profile update on WLC-5520 pushes new SSID, VLAN, and radius to all 3 LAPs
  const modifiedNodes = capwapSync.nodes.map((n) => {
    if (n.id !== 'wlc-ctrl-1' || !n.wlcConfig) return n;
    return {
      ...n,
      wlcConfig: {
        ...n.wlcConfig,
        defaultCoverageRadius: 260,
        wlanProfiles: [
          {
            ...n.wlcConfig.wlanProfiles[0],
            ssid: 'Corp-Unified-HQ',
            vlanId: 20,
          },
        ],
      },
    };
  });

  const pushed = syncWirelessAssociations(modifiedNodes, p10.links);
  for (const lapId of ['wlc-lap-1', 'wlc-lap-2', 'wlc-lap-3']) {
    const lap = pushed.nodes.find((n) => n.id === lapId)!;
    assert.equal(lap.wifiConfig?.ssid, 'Corp-Unified-HQ', `${lapId} receives new SSID from WLC`);
    assert.equal(lap.wifiConfig?.bridgeVlan, 20, `${lapId} receives new VLAN 20 from WLC`);
    assert.equal(lap.wifiConfig?.coverageRadius, 260, `${lapId} receives new coverage radius from WLC`);
  }

  // 4. Verify CAPWAP Control (UDP 5246) and CAPWAP Data (UDP 5247) packet synthesis
  const capwapSteps = synthesizeCapwapTunnelSteps(capwapSync.nodes, p10.links, 1, 0);
  assert.ok(capwapSteps.length >= 6, 'Synthesizes CAPWAP Control & Data steps for joined LAPs');
  assert.ok(
    capwapSteps.some(
      (s) =>
        s.protocol === 'CAPWAP_CONTROL' &&
        s.inboundPdu?.l4?.dstPort === 5246 &&
        s.inboundPdu?.l7?.appProtocol === 'CAPWAP'
    ),
    'Includes CAPWAP_CONTROL UDP 5246 step'
  );
  assert.ok(
    capwapSteps.some(
      (s) =>
        s.protocol === 'CAPWAP_DATA' &&
        s.inboundPdu?.l4?.dstPort === 5247 &&
        s.inboundPdu?.l7?.appProtocol === 'CAPWAP'
    ),
    'Includes CAPWAP_DATA UDP 5247 step'
  );
});

test('Stage 5 Firewall (Cisco ASA / FortiGate): Security Zones (Inside 100 / DMZ 50 / Outside 0), Stateful Packet Inspection (SPI), DMZ Port Forwarding (DNAT), Site-to-Site IPsec VPN, and ASA CLI', () => {
  const p11 = JSON.parse(
    JSON.stringify(
      TOPOLOGY_PRESETS.find((p) => p.id === 'firewall-asa-dmz-vpn-lab')!
    )
  );
  assert.ok(p11, 'Preset #11 (firewall-asa-dmz-vpn-lab) exists');

  // 1. Outbound traffic from Inside (100) -> Outside (0) is permitted, creates SPI session, and allows ICMP_ECHO_REPLY return
  const outboundPing = runPacketSimulation(
    p11.nodes,
    p11.links,
    'fw-pc-corp',
    '8.8.8.50',
    'ICMP'
  );
  assert.equal(
    outboundPing.success,
    true,
    'PC-Corp (Inside 100) successfully pings PC-Internet (Outside 0) with SPI return inspection'
  );
  const fwAfterPing = outboundPing.updatedNodes.find(
    (n: { id: string }) => n.id === 'fw-asa-hq'
  )!;
  assert.ok(
    (fwAfterPing.firewallConfig?.statefulSessions?.length || 0) >= 1,
    'Firewall records active SPI session in statefulSessions table'
  );

  // 2. Unsolicited inbound traffic from Outside (0) -> Inside (100) is dropped by ASA Security Level policy
  const outsideAttack = runPacketSimulation(
    p11.nodes,
    p11.links,
    'fw-pc-internet',
    '192.168.100.10',
    'ICMP'
  );
  assert.equal(
    outsideAttack.success,
    false,
    'Direct ping from Outside (0) to Inside (100) is blocked by FW-ASA-HQ'
  );
  assert.ok(
    outsideAttack.steps.some(
      (s) => s.status === 'dropped' && s.decisionTitle.includes('Firewall ASA DROP')
    ),
    'Emits explicit Firewall ASA DROP step when Outside (0) attempts to enter Inside (100)'
  );

  // 3. Port Forwarding (Static NAT / DNAT) publishes SRV-DMZ-Web (172.16.50.100:80) on Outside IP 203.0.113.2:80
  const dmzHttp = runHttpBrowserSimulation(
    p11.nodes,
    p11.links,
    'fw-pc-internet',
    'http://203.0.113.2'
  );
  assert.equal(
    dmzHttp.success,
    true,
    'PC-Internet (Outside 0) fetches HTTP 200 OK from SRV-DMZ-Web (DMZ 50) via Port Forwarding 203.0.113.2:80 -> 172.16.50.100:80'
  );
  assert.equal(dmzHttp.httpResult?.statusCode, 200);
  assert.ok(dmzHttp.httpResult?.body.includes('SRV-DMZ-Web'));

  // 4. Site-to-Site IPsec VPN encrypts traffic between HQ Inside (192.168.100.0/24) and Branch Inside (10.200.1.0/24)
  const vpnPing = runPacketSimulation(
    p11.nodes,
    p11.links,
    'fw-pc-corp',
    '10.200.1.10',
    'ICMP'
  );
  assert.equal(
    vpnPing.success,
    true,
    'PC-Corp (192.168.100.10) pings PC-Branch (10.200.1.10) across Site-to-Site IPsec VPN tunnel'
  );
  assert.ok(
    vpnPing.steps.some((s) => s.protocol === 'IPSEC_ESP'),
    'WAN hops between FW-ASA-HQ and FW-Branch-VPN are encapsulated in IPSEC_ESP (IP Proto 50)'
  );

  // 5. Verify Cisco ASA CLI commands (show nameif, show conn, show crypto ipsec sa)
  const cliNameif = executeIosCommand('show nameif', fwAfterPing, outboundPing.updatedNodes, p11.links);
  assert.ok(
    cliNameif.outputLines.some((l) => l.includes('inside') && l.includes('100')),
    'CLI show nameif displays inside zone with security level 100'
  );
  const cliConn = executeIosCommand('show conn', fwAfterPing, outboundPing.updatedNodes, p11.links);
  assert.ok(
    cliConn.outputLines.some((l) => l.includes('192.168.100.10') && l.includes('ESTABLISHED')),
    'CLI show conn displays active SPI session'
  );
  const cliIpsec = executeIosCommand('show crypto ipsec sa', fwAfterPing, outboundPing.updatedNodes, p11.links);
  const ipsecText = cliIpsec.outputLines.join('\n');
  assert.ok(
    ipsecText.includes('198.51.100.2') && ipsecText.includes('AES-256-GCM'),
    'CLI show crypto ipsec sa displays active IPsec SA peer and transform-set'
  );
});

test('Stage 6 Device Stacking: Switch StackWise-480 Ring, Router HSRP/VSS Stack Virtual IP, Cross-Stack Backplane Routing, Automatic Failover, and Stack CLI', () => {
  const p12 = JSON.parse(
    JSON.stringify(TOPOLOGY_PRESETS.find((p) => p.id === 'ha-stack-campus')!)
  );
  assert.ok(p12, 'Preset #12 (ha-stack-campus) exists');

  // 1. Verify Switch StackWise-480 ring ports are never blocked by STP and report 480000 Mbps
  const stp = computeSpanningTreeState(p12.nodes, p12.links);
  assert.equal(stp['stk-sw-1'].ports['ssw1-gi0/2'].state, 'forwarding');
  assert.equal(stp['stk-sw-2'].ports['ssw2-gi0/2'].state, 'forwarding');
  assert.equal(stp['stk-sw-1'].ports['ssw1-gi0/2'].portChannelName, 'StackWise-480');
  assert.equal(stp['stk-sw-1'].ports['ssw1-gi0/2'].aggregatedBandwidthMbps, 480000);

  // 2. Verify L2 Ping across Switch StackWise-480 backplane (PC-Sales-1 on SW-Stack-1 -> PC-Eng-2 on SW-Stack-2)
  const l2Ping = runPacketSimulation(
    p12.nodes,
    p12.links,
    'stk-pc-1',
    '192.168.10.11',
    'ICMP'
  );
  assert.equal(
    l2Ping.success,
    true,
    'PC-Sales-1 pings PC-Eng-2 across Switch StackWise-480 backplane'
  );

  // 3. Verify L3 Ping to SRV-Cloud (203.0.113.100) via HSRP Virtual Gateway 192.168.10.1 and Cross-Stack Backplane (RTR-Stack-1 -> RTR-Stack-2 -> SRV-Cloud)
  const l3Ping = runPacketSimulation(
    p12.nodes,
    p12.links,
    'stk-pc-1',
    '203.0.113.100',
    'ICMP'
  );
  assert.equal(
    l3Ping.success,
    true,
    'PC-Sales-1 pings SRV-Cloud via HSRP VIP 192.168.10.1 and Router Stack Backplane'
  );
  assert.ok(
    l3Ping.steps.some((s) => s.linkId === 'stk-link-rtr-stack'),
    'Traffic traverses the Router Stack Backplane link (stk-link-rtr-stack)'
  );

  // 4. Verify Automatic HSRP / Stack Failover when RTR-Stack-1 LAN interface Gi0/0 is shut down
  const failoverNodes = p12.nodes.map((n: { id: string; interfaces: Array<{ id: string; adminStatus: string }> }) =>
    n.id === 'stk-rtr-1'
      ? {
          ...n,
          interfaces: n.interfaces.map((i) =>
            i.id === 'sr1-gi0/0' ? { ...i, adminStatus: 'down' } : i
          ),
        }
      : n
  );
  const failoverPing = runPacketSimulation(
    failoverNodes,
    p12.links,
    'stk-pc-1',
    '203.0.113.100',
    'ICMP'
  );
  assert.equal(
    failoverPing.success,
    true,
    'Standby router RTR-Stack-2 automatically takes over HSRP VIP 192.168.10.1 when Master port Gi0/0 fails'
  );

  // 5. Verify Cisco IOS CLI commands: show switch, show standby brief, switch 1 priority 15
  const sw1 = p12.nodes.find((n: { id: string }) => n.id === 'stk-sw-1')!;
  const cliShowSwitch = executeIosCommand('show switch', sw1, p12.nodes, p12.links);
  const showSwitchText = cliShowSwitch.outputLines.join('\n');
  assert.ok(
    showSwitchText.includes('*1') &&
      showSwitchText.includes('Master') &&
      showSwitchText.includes('Standby'),
    'CLI show switch displays *1 Master and 2 Standby switches in StackWise ring'
  );

  const rtr1 = p12.nodes.find((n: { id: string }) => n.id === 'stk-rtr-1')!;
  const cliShowStandby = executeIosCommand('show standby brief', rtr1, p12.nodes, p12.links);
  const showStandbyText = cliShowStandby.outputLines.join('\n');
  assert.ok(
    showStandbyText.includes('192.168.10.1') && showStandbyText.includes('Active'),
    'CLI show standby brief displays Virtual IP 192.168.10.1 and Active state'
  );
});

test('Stage 7 IP Telephony (VoIP SIP / RTP), Voice + Data VLAN Single-Cable Passthrough, and IEEE 802.3af/at PoE Power Budget', () => {
  const p13 = JSON.parse(
    JSON.stringify(TOPOLOGY_PRESETS.find((p) => p.id === 'voip-poe-campus')!)
  );
  assert.ok(p13, 'Preset #13 (voip-poe-campus) exists');

  const swPoe = p13.nodes.find((n: { id: string }) => n.id === 'voip-sw-1')!;
  const phone101 = p13.nodes.find((n: { id: string }) => n.id === 'voip-phone-101')!;

  // 1. Verify IEEE 802.3af/at PoE Budget: 2 IP Phones (7.0W each) + 1 Wi-Fi AP (15.4W) = 29.4W / 370W
  const poeStatus = computeSwitchPoeStatus(swPoe, p13.nodes, p13.links);
  assert.equal(poeStatus.enabled, true);
  assert.equal(poeStatus.totalBudgetWatts, 370);
  assert.equal(poeStatus.usedWatts, 29.4);
  assert.equal(poeStatus.remainingWatts, 340.6);

  const pdState101 = getPoweredDevicePoeState(phone101, p13.nodes, p13.links);
  assert.equal(pdState101.isPowered, true);
  assert.equal(pdState101.watts, 7.0);
  assert.equal(pdState101.switchNodeName, 'SW-PoE-Core');

  // 2. Verify VoIP Directory lists 101 and 102 in Voice VLAN 20
  const dir = getVoipDirectory(p13.nodes, p13.links);
  assert.equal(dir.length, 2);
  assert.equal(dir[0].extension, '101');
  assert.equal(dir[1].extension, '102');

  // 3. Verify SIP INVITE -> SIP 200 OK -> RTP_AUDIO call from Ext 101 to Ext 102 over Voice VLAN 20
  const callSim = runVoipSipCallSimulation(p13.nodes, p13.links, 'voip-phone-101', '102');
  assert.equal(callSim.success, true, `SIP call 101 -> 102 should succeed: ${callSim.summaryMessage}`);
  assert.ok(callSim.steps.some((s) => s.protocol === 'SIP_INVITE'));
  assert.ok(callSim.steps.some((s) => s.protocol === 'SIP_200_OK'));
  assert.ok(callSim.steps.some((s) => s.protocol === 'RTP_AUDIO'));

  // 4. Verify 2-Port Internal Switch Passthrough: PC-Sales-1 (Data VLAN 10) -> IP-Phone-101 (PC->SW port) -> SW-PoE-Core -> IP-Phone-102 -> PC-Exec-2
  const pcDataPing = runPacketSimulation(
    p13.nodes,
    p13.links,
    'voip-pc-1',
    '192.168.10.11',
    'ICMP'
  );
  assert.equal(
    pcDataPing.success,
    true,
    'Daisy-chained PC-Sales-1 pings PC-Exec-2 through IP-Phone-101 and IP-Phone-102 passthrough ports'
  );

  // 5. Verify PoE Power Cutoff: shutting off PoE on Fa0/1 powers down IP-Phone-101 and blocks both phone calls and PC passthrough
  const noPoeNodes = p13.nodes.map((n: { id: string; interfaces: Array<{ id: string; poeEnabled?: boolean }> }) =>
    n.id === 'voip-sw-1'
      ? {
          ...n,
          interfaces: n.interfaces.map((i) =>
            i.id === 'vsw-fa0/1' ? { ...i, poeEnabled: false } : i
          ),
        }
      : n
  );
  const cutoffCall = runVoipSipCallSimulation(noPoeNodes, p13.links, 'voip-phone-101', '102');
  assert.equal(cutoffCall.success, false, 'Unpowered IP-Phone-101 cannot place SIP call');

  const cutoffPcPing = runPacketSimulation(
    noPoeNodes,
    p13.links,
    'voip-pc-1',
    '192.168.10.11',
    'ICMP'
  );
  assert.equal(
    cutoffPcPing.success,
    false,
    'Unpowered IP-Phone-101 internal 2-port switch stops forwarding PC passthrough traffic'
  );

  // 6. Verify Cisco IOS CLI commands: show power inline, show voip sip, switchport voice vlan, power inline never, call 102
  const cliPower = executeIosCommand('show power inline', swPoe, p13.nodes, p13.links);
  const powerOut = cliPower.outputLines.join('\n');
  assert.ok(
    powerOut.includes('29.4') && powerOut.includes('IP-Phone-101') && powerOut.includes('AP-PoE-Office'),
    'CLI show power inline displays 29.4W used and connected Powered Devices'
  );

  const cliCall = executeIosCommand('call 102', phone101, p13.nodes, p13.links);
  assert.ok(
    cliCall.triggeredSimulationSteps && cliCall.triggeredSimulationSteps.length >= 6,
    'CLI call 102 triggers SIP + RTP simulation steps'
  );
});

test('Stage 8 Video Surveillance & IoT: PoE IP Cameras (RTSP Unicast & Multicast), NVR Recorder, and ACL Internet Isolation', () => {
  const p14 = JSON.parse(
    JSON.stringify(TOPOLOGY_PRESETS.find((p) => p.id === 'cctv-iot-poe-vlan')!)
  );
  assert.ok(p14, 'Preset #14 (cctv-iot-poe-vlan) exists');

  const swCctv = p14.nodes.find((n: { id: string }) => n.id === 'cctv-sw-1')!;
  const camGate = p14.nodes.find((n: { id: string }) => n.id === 'cctv-cam-1')!;

  // 1. Verify IEEE 802.3af/at PoE Budget: 2 IP Cameras (9.5W each) = 19.0W / 370W
  const poeStatus = computeSwitchPoeStatus(swCctv, p14.nodes, p14.links);
  assert.equal(poeStatus.enabled, true);
  assert.equal(poeStatus.usedWatts, 19.0);
  assert.equal(poeStatus.remainingWatts, 351.0);

  const camPoeState = getPoweredDevicePoeState(camGate, p14.nodes, p14.links);
  assert.equal(camPoeState.isPowered, true);
  assert.equal(camPoeState.watts, 9.5);
  assert.equal(camPoeState.switchNodeName, 'SW-CCTV-PoE');

  // 2. Verify CCTV Camera Directory lists both cameras in VLAN 30
  const camDir = getIpCameraDirectory(p14.nodes, p14.links);
  assert.equal(camDir.length, 2);
  assert.equal(camDir[0].ipAddress, '192.168.30.11');
  assert.equal(camDir[1].ipAddress, '192.168.30.12');

  // 3. Verify RTSP Unicast video stream (RTSP_SETUP -> RTSP_200_OK -> RTP_VIDEO) from CAM-Gate-01 to NVR-Recorder (192.168.30.100)
  const unicastSim = runRtspVideoStreamSimulation(
    p14.nodes,
    p14.links,
    'cctv-cam-1',
    '192.168.30.100',
    'unicast'
  );
  assert.equal(unicastSim.success, true, `RTSP Unicast should succeed: ${unicastSim.summaryMessage}`);
  assert.ok(unicastSim.steps.some((s) => s.protocol === 'RTSP_SETUP'));
  assert.ok(unicastSim.steps.some((s) => s.protocol === 'RTSP_200_OK'));
  assert.ok(unicastSim.steps.some((s) => s.protocol === 'RTP_VIDEO'));

  // 4. Verify RTSP Multicast video stream from CAM-Vault-02 to Multicast group 239.0.30.1 (MAC 01:00:5E:00:1E:01)
  const multicastSim = runRtspVideoStreamSimulation(
    p14.nodes,
    p14.links,
    'cctv-cam-2',
    '239.0.30.1',
    'multicast'
  );
  assert.equal(multicastSim.success, true, `RTSP Multicast should succeed: ${multicastSim.summaryMessage}`);
  const mcastRtpStep = multicastSim.steps.find((s) => s.protocol === 'RTP_VIDEO');
  assert.ok(mcastRtpStep, 'Multicast RTP_VIDEO step generated');
  assert.equal(mcastRtpStep.outboundPdu?.l3.dstIp, '239.0.30.1');
  assert.equal(mcastRtpStep.outboundPdu?.l2.dstMac, '01:00:5E:00:1E:01');

  // 5. Verify ACL Internet Isolation: CAM-Gate-01 (192.168.30.11) -> WAN 203.0.113.100 is blocked by ACL Seq 10 DENY
  const wanPing = runPacketSimulation(p14.nodes, p14.links, 'cctv-cam-1', '203.0.113.100', 'ICMP');
  assert.equal(wanPing.success, false, 'Camera must be blocked from reaching external WAN');
  assert.ok(
    wanPing.steps.some((s) => s.status === 'dropped' && s.decisionTitle.includes('ACL Drop')),
    'Router drops camera WAN traffic with explicit ACL Drop step'
  );

  // 6. Verify PoE Cutoff: disabling PoE on Fa0/1 shuts off CAM-Gate-01 and blocks RTSP streaming
  const noPoeNodes = p14.nodes.map((n: { id: string; interfaces: Array<{ id: string; poeEnabled?: boolean }> }) =>
    n.id === 'cctv-sw-1'
      ? {
          ...n,
          interfaces: n.interfaces.map((i) =>
            i.id === 'csw-fa0/1' ? { ...i, poeEnabled: false } : i
          ),
        }
      : n
  );
  const unpoweredRtsp = runRtspVideoStreamSimulation(
    noPoeNodes,
    p14.links,
    'cctv-cam-1',
    '192.168.30.100'
  );
  assert.equal(unpoweredRtsp.success, false, 'Unpowered PoE IP Camera cannot stream RTSP');

  // 7. Verify CLI commands: show cctv and rtsp 192.168.30.100
  const cliShowCctv = executeIosCommand('show cctv', swCctv, p14.nodes, p14.links);
  assert.ok(
    cliShowCctv.outputLines.join('\n').includes('CAM-Gate-01') &&
      cliShowCctv.outputLines.join('\n').includes('239.0.30.1'),
    'CLI show cctv displays IP camera directory and multicast group'
  );

  // 8. Verify toolbar creation of IP Camera and NVR populates all ipCameraConfig and services fields
  const toolbarCam = createDeviceNode('pc', 100, 100, 1, undefined, 6, 'ip_camera');
  assert.ok(toolbarCam.ipCameraConfig, 'Toolbar IP camera must have ipCameraConfig');
  assert.equal(toolbarCam.ipCameraConfig?.codec.split(' ')[0], 'H.265');
  assert.equal(toolbarCam.ipCameraConfig?.resolution.split(' ')[0], '4K');
  assert.equal(toolbarCam.ipCameraConfig?.nvrTargetIp, '192.168.30.100');
  assert.equal(toolbarCam.ipCameraConfig?.surveillanceVlan, 30);

  const toolbarNvr = createDeviceNode('server', 200, 200, 2, undefined, 6, 'nvr');
  assert.equal(toolbarNvr.services?.nvrEnabled, true);
  assert.equal(toolbarNvr.services?.nvrStorageTb, 16);
});

test('Stage 9 ISP Cloud / WAN Emulator & eBGP Dual-ISP Multihoming (ASN 65000 <-> AS 65101 / AS 65202): Best-Path selection, Automatic Failover, and WAN Link Impairment (Latency / Packet Loss)', () => {
  const p15 = JSON.parse(
    JSON.stringify(
      TOPOLOGY_PRESETS.find((p) => p.id === 'dual-isp-ebgp-wan-impairment')!
    )
  );
  assert.ok(p15, 'Preset #15 (dual-isp-ebgp-wan-impairment) exists');

  const rtrHq = p15.nodes.find((n: { id: string }) => n.id === 'bgp-rtr-hq')!;

  // 1. Verify eBGP Peer Discovery (AS 65101 ISP-1-Primary and AS 65202 ISP-2-Backup are both Established)
  const peers = discoverBgpPeersForRouter(rtrHq, p15.nodes, p15.links);
  assert.equal(peers.length, 2, 'RTR-HQ-Edge has 2 eBGP neighbors');
  assert.ok(peers.every((p) => p.state === 'Established'));
  assert.ok(peers.some((p) => p.remoteAs === 65101 && p.neighborIp === '203.0.113.1'));
  assert.ok(peers.some((p) => p.remoteAs === 65202 && p.neighborIp === '198.51.100.1'));

  // 2. Verify eBGP Best-Path Selection: ISP-1 (Weight 200, LP 150, AS_PATH [65101], 8ms) beats ISP-2 (Weight 100, LP 90, AS_PATH [65202, 65202], 45ms)
  const bgpTable = computeBgpRoutesForRouter(rtrHq, p15.nodes, p15.links);
  const best888 = bgpTable.bestRoutes.find((r) => r.network === '8.8.8.0')!;
  assert.ok(best888, 'eBGP learns 8.8.8.0/24 prefix');
  assert.equal(best888.type, 'B');
  assert.equal(best888.administrativeDistance, 20);
  assert.equal(best888.nextHop, '203.0.113.1', 'Primary eBGP Best-Path selects ISP-1 (203.0.113.1)');
  assert.deepEqual(best888.bgpAsPath, [65101]);

  // 3. Verify eBGP Peering Simulation (TCP 179 BGP_OPEN -> BGP_KEEPALIVE -> BGP_UPDATE)
  const bgpSim = runBgpPeeringSimulation(p15.nodes, p15.links, 'bgp-rtr-hq');
  assert.equal(bgpSim.success, true);
  assert.ok(bgpSim.steps.some((s) => s.protocol === 'BGP_OPEN'));
  assert.ok(bgpSim.steps.some((s) => s.protocol === 'BGP_KEEPALIVE'));
  assert.ok(bgpSim.steps.some((s) => s.protocol === 'BGP_UPDATE'));

  // 4. Verify Primary Ping traverses ISP-1-Primary and includes WAN Latency telemetry (+8ms)
  const primaryPing = runPacketSimulation(p15.nodes, p15.links, 'bgp-pc-hq', '8.8.8.8', 'ICMP');
  assert.equal(primaryPing.success, true);
  assert.ok(
    primaryPing.steps.some((s) => s.fromNodeId === 'bgp-isp-1' || s.toNodeId === 'bgp-isp-1'),
    'Traffic traverses ISP-1-Primary'
  );

  // 5. Verify Automatic Dual-ISP Failover when ISP-1-Primary experiences 100% Packet Loss
  const isp1DownNodes = p15.nodes.map((n: { id: string; wanImpairment?: Record<string, unknown> }) =>
    n.id === 'bgp-isp-1' && n.wanImpairment
      ? {
          ...n,
          wanImpairment: {
            ...n.wanImpairment,
            enabled: true,
            packetLossPercent: 100,
          },
        }
      : n
  );
  const failoverPing = runPacketSimulation(isp1DownNodes, p15.links, 'bgp-pc-hq', '8.8.8.8', 'ICMP');
  assert.equal(failoverPing.success, true, 'Traffic automatically fails over to ISP-2-Backup');
  assert.ok(
    failoverPing.steps.some((s) => s.fromNodeId === 'bgp-isp-2' || s.toNodeId === 'bgp-isp-2'),
    'Failover traffic traverses ISP-2-Backup (AS 65202)'
  );

  // 6. Verify CLI commands: show ip bgp summary, show ip bgp, show wan, show ip route bgp
  const cliBgpSum = executeIosCommand('show ip bgp summary', rtrHq, p15.nodes, p15.links);
  assert.ok(
    cliBgpSum.outputLines.join('\n').includes('65101') &&
      cliBgpSum.outputLines.join('\n').includes('65202'),
    'CLI show ip bgp summary lists AS 65101 and AS 65202 neighbors'
  );

  const cliBgpTable = executeIosCommand('show ip bgp', rtrHq, p15.nodes, p15.links);
  assert.ok(
    cliBgpTable.outputLines.join('\n').includes('*> 8.8.8.0/24') &&
      cliBgpTable.outputLines.join('\n').includes('203.0.113.1'),
    'CLI show ip bgp marks *> 8.8.8.0/24 via 203.0.113.1 as Best Path'
  );

  // 7. Verify toolbar creation of ISP Cloud node populates bgpConfig and wanImpairment
  const toolbarIsp = createDeviceNode('router', 300, 200, 1, undefined, 4, 'isp_cloud');
  assert.equal(toolbarIsp.deviceModel, 'isp_cloud');
  assert.equal(toolbarIsp.bgpConfig?.enabled, true);
  assert.equal(toolbarIsp.wanImpairment?.enabled, true);
});

test('Stage 10 Interactive Network Troubleshooter (analyzeNetworkTroubles & 1-click Auto-Fix): Gateway, VLAN mismatch, Missing L3 Route, ACL Block, and PoE Off', () => {
  // 1. Example 1: Missing Default Gateway on PC -> [Прописать шлюз 192.168.1.1]
  const p0 = JSON.parse(JSON.stringify(TOPOLOGY_PRESETS[0]));
  const brokenGwNodes = p0.nodes.map((n: { id: string; defaultGateway?: string }) =>
    n.id === 'node-pc-1' ? { ...n, defaultGateway: '' } : n
  );
  const failedGwPing = runPacketSimulation(
    brokenGwNodes,
    p0.links,
    'node-pc-1',
    '192.168.2.100',
    'ICMP'
  );
  assert.equal(failedGwPing.success, false, 'Ping fails when Default Gateway is missing');

  const gwTroubles = analyzeNetworkTroubles({
    nodes: failedGwPing.updatedNodes,
    links: p0.links,
    steps: failedGwPing.steps,
    summaryMessage: failedGwPing.summaryMessage,
    sourceNodeId: 'node-pc-1',
    targetIp: '192.168.2.100',
  });
  const gwDiag = gwTroubles.find((d) => d.category === 'GATEWAY' && d.nodeId === 'node-pc-1');
  assert.ok(gwDiag, 'Troubleshooter detects missing Default Gateway on node-pc-1');
  assert.ok(
    gwDiag.fixButtonLabel.includes('192.168.1.1'),
    'Suggests 1-click fix: Прописать шлюз 192.168.1.1'
  );

  const fixedGwState = gwDiag.applyFix(failedGwPing.updatedNodes, p0.links);
  const verifyGwPing = runPacketSimulation(
    fixedGwState.updatedNodes,
    fixedGwState.updatedLinks,
    'node-pc-1',
    '192.168.2.100',
    'ICMP'
  );
  assert.equal(verifyGwPing.success, true, 'After 1-click gateway fix, Ping succeeds');

  // 2. Example 2: Switch port in VLAN 1 while IP-Camera is in VLAN 30 -> [Перевести порт в Access VLAN 30]
  const p14 = JSON.parse(
    JSON.stringify(
      TOPOLOGY_PRESETS.find((p) => p.id === 'cctv-iot-poe-vlan')!
    )
  );
  const brokenVlanNodes = p14.nodes.map(
    (n: { id: string; interfaces: Array<{ id: string; accessVlan?: number }> }) =>
      n.id === 'cctv-sw-1'
        ? {
            ...n,
            interfaces: n.interfaces.map((iface) =>
              iface.id === 'csw-fa0/1' ? { ...iface, accessVlan: 1 } : iface
            ),
          }
        : n
  );
  const vlanTroubles = analyzeNetworkTroubles({
    nodes: brokenVlanNodes,
    links: p14.links,
    steps: [],
    summaryMessage: '',
  });
  const vlanDiag = vlanTroubles.find(
    (d) => d.category === 'VLAN' && d.nodeId === 'cctv-sw-1'
  );
  assert.ok(vlanDiag, 'Troubleshooter detects switch port in VLAN 1 vs IP-Camera VLAN 30');
  assert.ok(
    vlanDiag.fixButtonLabel.includes('VLAN 30'),
    'Suggests 1-click fix: Перевести порт в Access VLAN 30'
  );

  const fixedVlanState = vlanDiag.applyFix(brokenVlanNodes, p14.links);
  const verifyRtsp = runRtspVideoStreamSimulation(
    fixedVlanState.updatedNodes,
    fixedVlanState.updatedLinks,
    'cctv-cam-1',
    '192.168.30.100'
  );
  assert.equal(verifyRtsp.success, true, 'After 1-click VLAN 30 fix, RTSP stream to NVR succeeds');

  // 3. Example 3: Missing route on Router -> [Добавить маршрут ...]
  const pStatic = JSON.parse(
    JSON.stringify(
      TOPOLOGY_PRESETS.find((p) => p.id === 'static-wan-routing')!
    )
  );
  const brokenRouteNodes = pStatic.nodes.map(
    (n: {
      id: string;
      ospfConfig?: { enabled: boolean };
      routingTable: Array<{ type: string }>;
    }) =>
      n.id === 'wan-rtr-1'
        ? {
            ...n,
            ospfConfig: n.ospfConfig ? { ...n.ospfConfig, enabled: false } : undefined,
            routingTable: n.routingTable.filter((r) => r.type === 'C'),
          }
        : n
  );
  const failedRoutePing = runPacketSimulation(
    brokenRouteNodes,
    pStatic.links,
    'wan-pc-1',
    '172.16.2.50',
    'ICMP'
  );
  assert.equal(failedRoutePing.success, false, 'Ping fails when route on RTR-Branch is missing');

  const routeTroubles = analyzeNetworkTroubles({
    nodes: failedRoutePing.updatedNodes,
    links: pStatic.links,
    steps: failedRoutePing.steps,
    summaryMessage: failedRoutePing.summaryMessage,
    sourceNodeId: 'wan-pc-1',
    targetIp: '172.16.2.50',
  });
  const routeDiag = routeTroubles.find((d) => d.category === 'ROUTING');
  assert.ok(routeDiag, 'Troubleshooter detects missing route on RTR-Branch');
  assert.ok(
    routeDiag.fixButtonLabel.includes('Добавить маршрут'),
    'Suggests 1-click route addition'
  );

  const fixedRouteState = routeDiag.applyFix(failedRoutePing.updatedNodes, pStatic.links);
  const verifyRoutePing = runPacketSimulation(
    fixedRouteState.updatedNodes,
    fixedRouteState.updatedLinks,
    'wan-pc-1',
    '172.16.2.50',
    'ICMP'
  );
  assert.equal(verifyRoutePing.success, true, 'After 1-click route fix, WAN Ping succeeds');

  // 4. Example 4: ACL Drop after ARP broadcast (CAM-Gate-01 -> WAN 203.0.113.100) -> [Отключить правило ACL Seq #10]
  const aclPing = runPacketSimulation(
    p14.nodes,
    p14.links,
    'cctv-cam-1',
    '203.0.113.100',
    'ICMP'
  );
  assert.equal(aclPing.success, false, 'Ping is blocked by ACL Seq #10');
  const aclTroubles = analyzeNetworkTroubles({
    nodes: aclPing.updatedNodes,
    links: p14.links,
    steps: aclPing.steps,
    summaryMessage: aclPing.summaryMessage,
    sourceNodeId: 'cctv-cam-1',
    targetIp: '203.0.113.100',
  });
  const aclDiag = aclTroubles.find((d) => d.category === 'ACL');
  assert.ok(aclDiag, 'Troubleshooter detects ACL Drop even when preceded by ARP broadcast discards');
  const fixedAclState = aclDiag.applyFix(aclPing.updatedNodes, p14.links);
  const verifyAclPing = runPacketSimulation(
    fixedAclState.updatedNodes,
    fixedAclState.updatedLinks,
    'cctv-cam-1',
    '203.0.113.100',
    'ICMP'
  );
  assert.equal(verifyAclPing.success, true, 'After 1-click ACL fix, Ping to WAN succeeds');
});

test('37. Link Utilization & QoS Heatmap Engine (Bandwidth 100M/1G/10G/480G + DiffServ DSCP EF/AF41/CS6/BE)', () => {
  assert.equal(formatBandwidthShort(100), '100M');
  assert.equal(formatBandwidthShort(1000), '1G');
  assert.equal(formatBandwidthShort(10000), '10G');
  assert.equal(formatBandwidthShort(480000), '480G');

  // 1. VoIP Preset 13: IP-Phone links should classify as QoS EF (DSCP 46, CoS 5)
  const pVoip = TOPOLOGY_PRESETS.find((p) => p.id === 'voip-poe-campus')!;
  const voipHeatmap = computeTopologyLinkHeatmap({
    nodes: pVoip.nodes,
    links: pVoip.links,
    activeStep: null,
  });
  const phoneLink = pVoip.links.find(
    (l) =>
      (l.sourceNodeId === 'voip-phone-101' && l.targetNodeId === 'voip-sw-1') ||
      (l.sourceNodeId === 'voip-sw-1' && l.targetNodeId === 'voip-phone-101')
  )!;
  const phoneMetrics = voipHeatmap[phoneLink.id];
  assert.ok(phoneMetrics, 'VoIP phone link metrics computed');
  assert.equal(phoneMetrics.qosQueue, 'EF', 'VoIP Phone link uses Priority Queue EF');
  assert.equal(phoneMetrics.qosDscpCode, 'DSCP 46 (EF)', 'VoIP Phone link tagged DSCP 46 (EF)');
  assert.ok(phoneMetrics.qosBadgeLabel.includes('CoS 5'), 'VoIP Phone link uses 802.1p CoS 5');

  // 2. CCTV Preset 14: IP-Camera RTSP links should classify as QoS AF41 (DSCP 34, CoS 4)
  const pCctv = TOPOLOGY_PRESETS.find((p) => p.id === 'cctv-iot-poe-vlan')!;
  const cctvHeatmap = computeTopologyLinkHeatmap({
    nodes: pCctv.nodes,
    links: pCctv.links,
    activeStep: null,
  });
  const camLink = pCctv.links.find(
    (l) => l.sourceNodeId === 'cctv-cam-1' || l.targetNodeId === 'cctv-cam-1'
  )!;
  const camMetrics = cctvHeatmap[camLink.id];
  assert.ok(camMetrics, 'IP Camera link metrics computed');
  assert.equal(camMetrics.qosQueue, 'AF41', 'IP Camera RTSP link uses Queue AF41');
  assert.equal(camMetrics.qosDscpCode, 'DSCP 34 (AF41)', 'IP Camera link tagged DSCP 34 (AF41)');
  assert.ok(camMetrics.qosBadgeLabel.includes('CoS 4'), 'IP Camera link uses 802.1p CoS 4');
  assert.ok(camMetrics.utilizationPercent >= 18, 'Continuous RTSP stream generates baseline link utilization');

  // 3. Dual-ISP WAN Preset 15: eBGP WAN links should reflect ISP latency & bandwidth and CS6 Control Plane
  const pBgp = TOPOLOGY_PRESETS.find((p) => p.id === 'dual-isp-ebgp-wan-impairment')!;
  const bgpHeatmap = computeTopologyLinkHeatmap({
    nodes: pBgp.nodes,
    links: pBgp.links,
    activeStep: null,
  });
  const isp1Link = pBgp.links.find(
    (l) =>
      (l.sourceNodeId === 'bgp-isp-1' && l.targetNodeId === 'bgp-rtr-hq') ||
      (l.sourceNodeId === 'bgp-rtr-hq' && l.targetNodeId === 'bgp-isp-1')
  )!;
  const isp1Metrics = bgpHeatmap[isp1Link.id];
  assert.ok(isp1Metrics, 'ISP-1 WAN link metrics computed');
  assert.equal(isp1Metrics.qosQueue, 'CS6', 'eBGP peering link uses Control Plane CS6');
  assert.equal(isp1Metrics.latencyMs, 8, 'Reflects ISP-1 WAN latency (8 ms)');
  assert.equal(isp1Metrics.bandwidthMbps, 1000, 'Reflects ISP-1 WAN bandwidth (1000 Mbps = 1G)');
});

test('38. Carrier GPON / FTTH Optical Network (OLT + ONT/ONU): 1490/1310nm, Optical Budget dBm, LOS < -28.0 dBm, GPON-SN Auth & Triple-Play Ports', () => {
  // 1. Splitter insertion loss validation
  assert.equal(getGponSplitterInsertionLossDb('1:8'), 10.5);
  assert.equal(getGponSplitterInsertionLossDb('1:16'), 13.8);
  assert.equal(getGponSplitterInsertionLossDb('1:32'), 17.2);
  assert.equal(getGponSplitterInsertionLossDb('1:64'), 20.5);

  const pGpon = JSON.parse(
    JSON.stringify(
      TOPOLOGY_PRESETS.find((p) => p.id === 'gpon-ftth-triple-play')!
    )
  );
  assert.ok(pGpon, 'Preset #16 (gpon-ftth-triple-play) exists');

  const olt = pGpon.nodes.find((n: { id: string }) => n.id === 'gpon-olt-1')!;
  const ont1 = pGpon.nodes.find((n: { id: string }) => n.id === 'gpon-ont-1')!;
  assert.equal(olt.gponOltConfig?.downstreamWavelengthNm, 1490);
  assert.equal(olt.gponOltConfig?.upstreamWavelengthNm, 1310);

  // 2. Normal optical state on ONT-Home-1: TX +3.5 dBm - 13.8 dB (1:16) - 1.4 dB (4.0km) - 2.0 dB = -13.7 dBm
  const opt1 = computeGponOntOpticalState(ont1, pGpon.nodes, pGpon.links);
  assert.equal(opt1.rxPowerDbm, -13.7, 'Calculates accurate Rx Power -13.7 dBm');
  assert.equal(opt1.isLos, false, 'Signal -13.7 dBm is above -28.0 dBm threshold (no LOS)');
  assert.equal(opt1.isSnAuthorized, true, 'GPON-SN HWTC-1001A2B3 is authorized on OLT');
  assert.equal(opt1.isPonUp, true, 'PON link is operational');

  const oltOntList = computeGponOltConnectedOnts(olt, pGpon.nodes, pGpon.links);
  assert.equal(oltOntList.length, 2, 'OLT discovers both connected ONTs');

  // 3. Triple-Play Service Port verification:
  // Port 1 (LAN1 -> VLAN 100 Internet)
  const inetPing = runPacketSimulation(
    pGpon.nodes,
    pGpon.links,
    'gpon-pc-inet1',
    '100.64.100.100',
    'ICMP'
  );
  assert.equal(inetPing.success, true, 'Subscriber LAN1 (VLAN 100 Internet) reaches ISP TriplePlay server over GPON');
  assert.ok(
    inetPing.steps.some((s) =>
      s.osiActions.some(
        (a) =>
          a.title.includes('1490 нм') ||
          a.title.includes('1310 нм') ||
          a.detail.includes('1490 нм')
      )
    ),
    'GPON steps include 1490nm/1310nm optical telemetry'
  );

  // Port 2 (LAN2 -> VLAN 200 IPTV Multicast)
  const iptvPing = runPacketSimulation(
    pGpon.nodes,
    pGpon.links,
    'gpon-stb-iptv1',
    '100.64.100.100',
    'ICMP'
  );
  assert.equal(iptvPing.success, true, 'Subscriber LAN2 (VLAN 200 IPTV) reaches IPTV headend over GPON');

  // Port 3 (LAN3 -> VLAN 300 VoIP SIP)
  const voipPing = runPacketSimulation(
    pGpon.nodes,
    pGpon.links,
    'gpon-phone-voip1',
    '100.64.100.100',
    'ICMP'
  );
  assert.equal(voipPing.success, true, 'Subscriber LAN3 (VLAN 300 VoIP) reaches SIP server over GPON');

  // 4. Optical Budget LOS (< -28.0 dBm) drops frames and triggers Troubleshooter 1-Click Auto-Fix
  const losNodes = pGpon.nodes.map(
    (n: { id: string; gponOntConfig?: Record<string, unknown> }) =>
      n.id === 'gpon-ont-1'
        ? {
            ...n,
            gponOntConfig: {
              ...n.gponOntConfig,
              extraAttenuationDb: 18.5, // Pushes Rx Power below -28.0 dBm
            },
          }
        : n
  );
  const losState = computeGponOntOpticalState(
    losNodes.find((n: { id: string }) => n.id === 'gpon-ont-1')!,
    losNodes,
    pGpon.links
  );
  assert.ok(losState.rxPowerDbm < -28.0, `Expected Rx < -28.0 dBm, got ${losState.rxPowerDbm}`);
  assert.equal(losState.isLos, true, 'LOS alarm turns ON when Rx Power < -28.0 dBm');

  const losPing = runPacketSimulation(
    losNodes,
    pGpon.links,
    'gpon-pc-inet1',
    '100.64.100.100',
    'ICMP'
  );
  assert.equal(losPing.success, false, 'Packets are dropped when ONT is in LOS state (< -28.0 dBm)');

  const losTroubles = analyzeNetworkTroubles({
    nodes: losPing.updatedNodes,
    links: pGpon.links,
    steps: losPing.steps,
    summaryMessage: losPing.summaryMessage,
    sourceNodeId: 'gpon-pc-inet1',
    targetIp: '100.64.100.100',
  });
  const gponLosDiag = losTroubles.find((d) => d.category === 'GPON');
  assert.ok(gponLosDiag, 'Troubleshooter detects GPON LOS alarm (< -28.0 dBm)');
  const fixedLos = gponLosDiag.applyFix(losPing.updatedNodes, pGpon.links);
  const verifyFixedLosPing = runPacketSimulation(
    fixedLos.updatedNodes,
    fixedLos.updatedLinks,
    'gpon-pc-inet1',
    '100.64.100.100',
    'ICMP'
  );
  assert.equal(verifyFixedLosPing.success, true, 'After 1-click GPON LOS fix, subscriber Ping succeeds');

  // 5. GPON-SN OMCI Authorization check & 1-click Auto-Fix
  const unauthNodes = pGpon.nodes.map(
    (n: { id: string; gponOltConfig?: { authorizedSnList: string[] } }) =>
      n.id === 'gpon-olt-1' && n.gponOltConfig
        ? {
            ...n,
            gponOltConfig: {
              ...n.gponOltConfig,
              authorizedSnList: ['HWTC-1002C4D5'], // Remove HWTC-1001A2B3
            },
          }
        : n
  );
  const unauthPing = runPacketSimulation(
    unauthNodes,
    pGpon.links,
    'gpon-pc-inet1',
    '100.64.100.100',
    'ICMP'
  );
  assert.equal(unauthPing.success, false, 'Packets from unauthorized GPON-SN are dropped by OLT OMCI');

  const unauthTroubles = analyzeNetworkTroubles({
    nodes: unauthPing.updatedNodes,
    links: pGpon.links,
    steps: unauthPing.steps,
    summaryMessage: unauthPing.summaryMessage,
  });
  const snDiag = unauthTroubles.find((d) => d.category === 'GPON');
  assert.ok(snDiag, 'Troubleshooter detects unauthorized GPON-SN on OLT');
  const fixedSn = snDiag.applyFix(unauthPing.updatedNodes, pGpon.links);
  const verifySnPing = runPacketSimulation(
    fixedSn.updatedNodes,
    fixedSn.updatedLinks,
    'gpon-pc-inet1',
    '100.64.100.100',
    'ICMP'
  );
  assert.equal(verifySnPing.success, true, 'After 1-click GPON-SN registration on OLT, Ping succeeds');

  // 6. Toolbar creation of gpon_olt and gpon_ont
  const newOlt = createDeviceNode('switch', 100, 100, 1, undefined, 6, 'gpon_olt');
  const newOnt = syncOntInterfacesWithServicePorts(
    createDeviceNode('switch', 200, 100, 1, undefined, 4, 'gpon_ont')
  );
  assert.equal(newOlt.deviceModel, 'gpon_olt');
  assert.equal(newOnt.deviceModel, 'gpon_ont');
  assert.equal(newOnt.interfaces.find((i) => i.shortName === 'LAN1')?.accessVlan, 100);
  assert.equal(newOnt.interfaces.find((i) => i.shortName === 'LAN2')?.accessVlan, 200);
  assert.equal(newOnt.interfaces.find((i) => i.shortName === 'LAN3')?.accessVlan, 300);
});

test('39. Wireshark Deep Packet Inspection (DPI), Hex/ASCII Byte Serializer, Display Filter & Follow Stream', () => {
  // 1. Run HTTP simulation on CCNA preset to capture ARP, DNS, TCP 3-Way Handshake, NAT PAT, and HTTP GET/200 OK
  const ccnaPreset = JSON.parse(JSON.stringify(TOPOLOGY_PRESETS[3]));
  assert.ok(ccnaPreset, 'CCNA preset exists');

  const httpSim = runHttpBrowserSimulation(
    ccnaPreset.nodes,
    ccnaPreset.links,
    'ccna-pc-10',
    'http://cloud.netpulse.org'
  );
  assert.equal(httpSim.success, true);
  assert.ok(httpSim.steps.length >= 6);

  // 2. Dissect an HTTP_GET step and verify L1-L7 sections, byte offsets, and Hex/ASCII serialization
  const httpGetStep = httpSim.steps.find((s) => s.protocol === 'HTTP_GET')!;
  assert.ok(httpGetStep, 'Found HTTP_GET step');

  const dissectedHttp = dissectStepForWireshark(httpGetStep, 'outbound');
  assert.equal(dissectedHttp.protocolLabel, 'HTTP GET');
  assert.ok(dissectedHttp.lengthBytes >= 54, 'Serialized HTTP packet is at least 54 bytes');
  assert.equal(dissectedHttp.bytes.length, dissectedHttp.lengthBytes);
  assert.ok(dissectedHttp.hexRows.length >= 4, 'Hex dump has multiple 16-byte rows');

  // Verify sections: Frame (L1), Ethernet II (L2), IPv4 (L3), TCP (L4), HTTP Application (L7)
  const layerList = dissectedHttp.sections.map((s) => s.layer);
  assert.deepEqual(layerList, ['L1', 'L2', 'L3', 'L4', 'L7']);

  // Verify bi-directional byte offsets: Ethernet Dst MAC is at 0..6, Src MAC at 6..12
  const l2Sec = dissectedHttp.sections.find((s) => s.layer === 'L2')!;
  const dstMacField = l2Sec.fields.find((f) => f.id === 'eth.dst')!;
  const srcMacField = l2Sec.fields.find((f) => f.id === 'eth.src')!;
  assert.equal(dstMacField.byteOffset, 0);
  assert.equal(dstMacField.byteLength, 6);
  assert.equal(srcMacField.byteOffset, 6);
  assert.equal(srcMacField.byteLength, 6);

  // Verify L3 IPv4 Source IP bytes match actual IP address octets
  const l3Sec = dissectedHttp.sections.find((s) => s.layer === 'L3')!;
  const srcIpField = l3Sec.fields.find((f) => f.id === 'ip.src')!;
  assert.equal(srcIpField.byteLength, 4);
  const ipOctets = httpGetStep.outboundPdu.l3.srcIp.split('.').map(Number);
  const serializedIpBytes = dissectedHttp.bytes.slice(
    srcIpField.byteOffset,
    srcIpField.byteOffset + 4
  );
  assert.deepEqual(serializedIpBytes, ipOctets, 'Hex bytes at ip.src offset match IPv4 octets');

  // 3. Verify Inbound vs Outbound Byte Diff on a Router hop (NAT PAT IP rewrite, TTL decrement & MAC rewrite)
  const pingSim = runPacketSimulation(
    ccnaPreset.nodes,
    ccnaPreset.links,
    'ccna-pc-10',
    '203.0.113.100',
    'ICMP'
  );
  assert.equal(pingSim.success, true);

  // Find WAN hop where router forwards packet (NAT PAT 192.168.10.10 -> 203.0.113.1 & TTL decrement)
  const routerHopStep = pingSim.steps.find(
    (s) => s.linkId === 'ccna-link-wan' && s.protocol === 'ICMP_ECHO_REQUEST'
  )!;
  assert.ok(routerHopStep, 'Found router WAN forwarding step with NAT PAT and TTL decrement');
  const dissectedRouterHop = dissectStepForWireshark(routerHopStep, 'outbound');
  assert.ok(
    dissectedRouterHop.changedByteOffsets.length > 0,
    'Router hop has modified byte offsets between Inbound and Outbound'
  );
  assert.ok(
    dissectedRouterHop.diffSummaryItems.length > 0,
    'Diff summary records header modifications on router hop'
  );

  // 4. Test Display Filter syntax validation and evaluation
  assert.equal(validateWiresharkDisplayFilter('icmp').valid, true);
  assert.equal(validateWiresharkDisplayFilter('ip.addr == 192.168.10.10 && tcp.port == 80').valid, true);
  assert.equal(validateWiresharkDisplayFilter('vlan.id == 100 || frame.dropped').valid, true);
  assert.equal(validateWiresharkDisplayFilter('invalid.syntax === ???').valid, false);

  const icmpFiltered = httpSim.steps.filter((s) => evaluateWiresharkDisplayFilter(s, 'http'));
  assert.ok(icmpFiltered.length >= 2, 'Display filter "http" matches HTTP_GET and HTTP_200_OK');

  const dnsFiltered = httpSim.steps.filter((s) =>
    evaluateWiresharkDisplayFilter(s, 'dns && udp.port == 53')
  );
  assert.ok(dnsFiltered.length >= 2, 'Display filter "dns && udp.port == 53" matches DNS steps');

  // 5. Test Follow Stream conversation reconstruction (Client Red <-> Server Blue)
  const streamDialog = buildFollowStreamDialog(httpSim.steps, httpGetStep);
  assert.equal(streamDialog.streamProtocol, 'TCP / HTTP Stream');
  assert.ok(streamDialog.messages.length >= 3, 'Follow Stream reconstructs TCP handshake + HTTP GET/200 OK');
  assert.ok(
    streamDialog.messages.some((m) => m.direction === 'client_to_server'),
    'Stream includes client_to_server messages'
  );
  assert.ok(
    streamDialog.messages.some((m) => m.direction === 'server_to_client'),
    'Stream includes server_to_client messages'
  );
});





