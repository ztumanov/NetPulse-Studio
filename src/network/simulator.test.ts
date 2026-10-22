import test from 'node:test';
import assert from 'node:assert/strict';
import { getNetworkAddress, isSameSubnet, isValidIpv4, isValidSubnetMask, maskToCidr } from './ipMath';
import { TOPOLOGY_PRESETS } from './presets';
import {
  runDhcpDoraSimulation,
  runHttpBrowserSimulation,
  runPacketSimulation,
  runTracerouteSimulation,
} from './simulator';
import { autocompleteIosCommand, executeIosCommand } from './cliParser';
import {
  addHardwarePortToNode,
  assignPortsToVlan,
  deleteDeviceVlan,
  getAvailableTargetPorts,
  getDeviceChassisPorts,
  getDeviceVlanDatabase,
  groupPortsIntoTwoRows,
  moveLinkToSocket,
  upsertDeviceVlan,
} from './hardwareChassis';

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


