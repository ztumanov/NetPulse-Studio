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
  runDhcpDoraSimulation,
  runHttpBrowserSimulation,
  runPacketSimulation,
  runTracerouteSimulation,
  syncConnectedRoutes,
} from './simulator';
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

test('Multi-Preset Laboratory Suite: all 7 presets define valid testScenarios and Core Self-Diagnostics (L1-L7) passes 9/9 checks', () => {
  assert.equal(TOPOLOGY_PRESETS.length, 7, 'Must provide 7 laboratory topology presets');

  for (const preset of TOPOLOGY_PRESETS) {
    assert.ok(preset.shortTag, `Preset ${preset.id} must have a shortTag`);
    assert.ok(
      preset.testScenarios && preset.testScenarios.length >= 3,
      `Preset ${preset.id} must provide at least 3 built-in test scenarios`
    );
  }

  // Execute the full L1-L7 Core Self-Diagnostics Suite across all 7 presets
  const report = runCoreDiagnosticsSuite();
  for (const check of report.results) {
    assert.equal(
      check.passed,
      true,
      `Core diagnostic check [${check.id}] (${check.title}) failed: ${check.detail}`
    );
  }
  assert.equal(report.totalChecks, 9);
  assert.equal(report.passedChecks, 9);
  assert.equal(report.allPassed, true);
});



