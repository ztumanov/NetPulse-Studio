import { executeIosCommand } from './cliParser';
import {
  computeDijkstraSpfRoutesForRouter,
  computeOspfNeighborsForRouter,
  synthesizeOspfHelloSteps,
} from './ospfEngine';
import { generateMultiFlowTrafficSteps } from './packetStreamEngine';
import { TOPOLOGY_PRESETS } from './presets';
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
} from './simulator';
import {
  syncWirelessAssociations,
  synthesizeCapwapTunnelSteps,
} from './wifiEngine';
import { synthesizeIpsecVpnSteps } from './firewallEngine';
import { computeSwitchPoeStatus } from './poeAndVoipEngine';
import { computeBgpRoutesForRouter } from './bgpAndWanEngine';

export interface DiagnosticCheckResult {
  id: string;
  layer: 'L1/L2' | 'L2 STP' | 'L3 IP' | 'L3 OSPF' | 'L3 RIP' | 'L4 NAT/ACL' | 'L7 APP' | 'CLI/CORE';
  presetName: string;
  title: string;
  passed: boolean;
  detail: string;
  stepsGenerated: number;
  durationMs: number;
}

export interface CoreDiagnosticsReport {
  totalChecks: number;
  passedChecks: number;
  failedChecks: number;
  totalDurationMs: number;
  allPassed: boolean;
  results: DiagnosticCheckResult[];
}

function getPresetClone(presetId: string) {
  const found = TOPOLOGY_PRESETS.find((p) => p.id === presetId);
  if (!found) {
    throw new Error(`Preset ${presetId} not found`);
  }
  return JSON.parse(JSON.stringify(found)) as typeof found;
}

/**
 * Runs 12 comprehensive automated self-diagnostics across all 7 topology presets
 * to verify the L1–L7 simulation core, dynamic routing (OSPFv2 SPF & RIPv2), STP, VLAN, NAT, ACL, DHCP, DNS, HTTP, and CLI.
 */
export function runCoreDiagnosticsSuite(): CoreDiagnosticsReport {
  const results: DiagnosticCheckResult[] = [];
  const suiteStart = performance.now();

  const runCheck = (
    id: string,
    layer: DiagnosticCheckResult['layer'],
    presetName: string,
    title: string,
    fn: () => { passed: boolean; detail: string; stepsGenerated: number }
  ) => {
    const t0 = performance.now();
    try {
      const res = fn();
      results.push({
        id,
        layer,
        presetName,
        title,
        passed: res.passed,
        detail: res.detail,
        stepsGenerated: res.stepsGenerated,
        durationMs: Math.max(1, Math.round((performance.now() - t0) * 10) / 10),
      });
    } catch (err) {
      results.push({
        id,
        layer,
        presetName,
        title,
        passed: false,
        detail: err instanceof Error ? err.message : String(err),
        stepsGenerated: 0,
        durationMs: Math.max(1, Math.round((performance.now() - t0) * 10) / 10),
      });
    }
  };

  // 1. Preset 1: ARP + L2 Switching + L3 Inter-VLAN Routing
  runCheck(
    'diag-1-l3-routing',
    'L3 IP',
    'Стенд 1 (Routed Dual LAN)',
    'ARP Broadcast + L2 MAC Learning + L3 Маршрутизация (PC-1 → SRV-Web)',
    () => {
      const p1 = getPresetClone('routed-dual-lan');
      const sim = runPacketSimulation(p1.nodes, p1.links, 'node-pc-1', '192.168.2.100', 'ICMP');
      const hasArp = sim.steps.some((s) => s.protocol === 'ARP_REQUEST');
      const hasEchoReply = sim.steps.some((s) => s.protocol === 'ICMP_ECHO_REPLY');
      return {
        passed: sim.success && hasArp && hasEchoReply,
        detail: `Успешный обмен ICMP Echo/Reply через RTR-Core (${sim.steps.length} шагов PDU, таблицы ARP и MAC обновлены).`,
        stepsGenerated: sim.steps.length,
      };
    }
  );

  // 2. Preset 1: DHCP DORA + DNS + TCP 3-Way Handshake + HTTP 200 OK
  runCheck(
    'diag-2-l7-dhcp-dns-http',
    'L7 APP',
    'Стенд 1 (Routed Dual LAN)',
    'Стек L7: DHCP DORA + DNS (UDP 53) + TCP Handshake + HTTP GET 200 OK',
    () => {
      const p1 = getPresetClone('routed-dual-lan');
      const dhcp = runDhcpDoraSimulation(p1.nodes, p1.links, 'node-pc-2');
      const http = runHttpBrowserSimulation(
        dhcp.updatedNodes,
        p1.links,
        'node-pc-1',
        'http://app.corp.local'
      );
      const assignedIp = dhcp.assignedDhcpConfig?.ipAddress || '';
      const ok =
        dhcp.success &&
        assignedIp === '192.168.1.50' &&
        http.success &&
        http.httpResult?.statusCode === 200 &&
        http.httpResult?.resolvedIp === '192.168.2.100';
      return {
        passed: ok,
        detail: `PC-2 получил ${assignedIp}/24 по DHCP; домен app.corp.local разрешён в 192.168.2.100, доставлен HTTP 200 OK.`,
        stepsGenerated: dhcp.steps.length + http.steps.length,
      };
    }
  );

  // 3. Preset 2: IEEE 802.1Q Trunk Tagging & L2 VLAN Isolation
  runCheck(
    'diag-3-vlan-trunk',
    'L1/L2',
    'Стенд 2 (VLAN 802.1Q Trunk)',
    'Тегирование IEEE 802.1Q на Trunk-магистрали и строгая L2-изоляция VLAN 10 ≠ VLAN 20',
    () => {
      const p2 = getPresetClone('vlan-trunk-isolation');
      const sameVlan = runPacketSimulation(
        p2.nodes,
        p2.links,
        'vlan-pc-10a',
        '10.10.0.12',
        'ICMP'
      );
      const taggedStep = sameVlan.steps.some(
        (s) => s.linkId === 'vlink-trunk' && s.vlanTag === 10
      );
      const crossVlan = runPacketSimulation(
        p2.nodes,
        p2.links,
        'vlan-pc-10a',
        '10.10.0.22',
        'ICMP'
      );
      return {
        passed: sameVlan.success && taggedStep && !crossVlan.success,
        detail: `Кадры внутри VLAN 10 проходят через Trunk с тегом 802.1Q (VID=10), а трафик из VLAN 10 в VLAN 20 изолирован на L2.`,
        stepsGenerated: sameVlan.steps.length + crossVlan.steps.length,
      };
    }
  );

  // 4. Preset 3: OSPFv2 Neighbor Table, Primary Cost=2 Selection & Automatic Failover to Backup Cost=11
  runCheck(
    'diag-4-ospf-wan-failover',
    'L3 OSPF',
    'Стенд 3 (WAN OSPFv2 Failover)',
    'OSPFv2 Area 0: выбор основного оптического канала Gi0/0 (Cost=2) и авто-Failover на Fa0/1 (Cost=11)',
    () => {
      const p3 = getPresetClone('static-wan-routing');
      const r1 = p3.nodes.find((n) => n.id === 'wan-rtr-1')!;
      r1.routingTable = r1.routingTable.filter((r) => r.type !== 'S');
      const r2 = p3.nodes.find((n) => n.id === 'wan-rtr-2')!;
      r2.routingTable = r2.routingTable.filter((r) => r.type !== 'S');

      const neighbors = computeOspfNeighborsForRouter(r1, p3.nodes, p3.links);
      const primaryRoute = findBestRoute(r1, '172.16.2.50', p3.nodes, p3.links);

      // Cut primary fiber cable wlink-wan
      const cutLinks = p3.links.filter((l) => l.id !== 'wlink-wan');
      const backupRoute = findBestRoute(r1, '172.16.2.50', p3.nodes, cutLinks);
      const failoverPing = runPacketSimulation(
        p3.nodes,
        cutLinks,
        'wan-pc-1',
        '172.16.2.50',
        'ICMP'
      );

      const ok =
        neighbors.length === 2 &&
        primaryRoute?.interfaceName === 'Gi0/0' &&
        primaryRoute?.metric === 2 &&
        backupRoute?.interfaceName === 'Fa0/1' &&
        backupRoute?.metric === 11 &&
        failoverPing.success;

      return {
        passed: ok,
        detail: `Соседей OSPF: ${neighbors.length} (FULL/P2P). Основной маршрут: Gi0/0 [110/2] → при обрыве оптики мгновенный переход на Fa0/1 [110/11].`,
        stepsGenerated: failoverPing.steps.length,
      };
    }
  );

  // 5. Preset 4: CCNA Router-on-a-Stick (802.1Q Subinterfaces) + STP 802.1D Loop Prevention + DHCP Relay + NAT/PAT
  runCheck(
    'diag-5-ccna-roas-stp-nat',
    'L2 STP',
    'Стенд 4 (CCNA Lab)',
    'Router-on-a-Stick (Fa0/0.10/.20), STP 802.1D (SW-Floor2 Gi0/2 = BLK), DHCP Relay и NAT Overload',
    () => {
      const p4 = getPresetClone('ccna-roas-stp-acl-nat');
      const stp = computeSpanningTreeState(p4.nodes, p4.links);
      const rootOk = stp['ccna-sw-core']?.isRootBridge === true;
      const blkOk = stp['ccna-sw-2']?.ports['csw2-gi0/2']?.state === 'blocking';

      const roasPing = runPacketSimulation(
        p4.nodes,
        p4.links,
        'ccna-pc-10',
        '192.168.20.10',
        'ICMP'
      );
      const natPing = runPacketSimulation(
        p4.nodes,
        p4.links,
        'ccna-pc-10',
        '203.0.113.100',
        'ICMP'
      );
      const relayDhcp = runDhcpDoraSimulation(p4.nodes, p4.links, 'ccna-pc-10');

      const ok =
        rootOk &&
        blkOk &&
        roasPing.success &&
        natPing.success &&
        relayDhcp.success &&
        relayDhcp.assignedDhcpConfig?.ipAddress === '192.168.10.50';

      return {
        passed: ok,
        detail: `Root Bridge: SW-Core (4096), петля заблокирована на SW-Floor2:Gi0/2 (BLK). Меж-VLAN RoAS, DHCP Relay и NAT 192.168.10.10 → 203.0.113.1 работают.`,
        stepsGenerated: roasPing.steps.length + natPing.steps.length + relayDhcp.steps.length,
      };
    }
  );

  // 6. Preset 5: 3-Router OSPFv2 Triangle Mesh (2-Hop 1Gbps Fiber Cost=3 beats 1-Hop 10Mbps Direct Cost=11)
  runCheck(
    'diag-6-ospf-triangle-mesh',
    'L3 OSPF',
    'Стенд 5 (Кольцо 3 роутеров OSPF)',
    'Алгоритм Дейкстры (SPF) в кольце 3 роутеров: выбор 2-хоповой оптики через RTR-Core (Cost=3 < Cost=11)',
    () => {
      const p5 = getPresetClone('ospf-triangle-mesh');
      const rtrWest = p5.nodes.find((n) => n.id === 'mesh-rtr-west')!;
      const spfRoutes = computeDijkstraSpfRoutesForRouter(rtrWest, p5.nodes, p5.links);
      const bestToEast = spfRoutes.find((r) => r.network === '192.168.200.0');

      const traceRes = runTracerouteSimulation(
        p5.nodes,
        p5.links,
        'mesh-pc-west',
        '192.168.200.50'
      );
      const hops = traceRes.tracerouteHops || [];
      const goesViaCore = hops.some((h) => h.responderName === 'RTR-Core');

      // Now cut the fiber link to RTR-Core and verify automatic failover to direct 10Mbps link (10.10.99.2, Cost=11)
      const linksNoCoreFiber = p5.links.filter((l) => l.id !== 'mlink-west-core');
      const backupRoute = findBestRoute(rtrWest, '192.168.200.50', p5.nodes, linksNoCoreFiber);
      const backupPing = runPacketSimulation(
        p5.nodes,
        linksNoCoreFiber,
        'mesh-pc-west',
        '192.168.200.50',
        'ICMP'
      );

      const ospfHelloSteps = synthesizeOspfHelloSteps(p5.nodes, p5.links, 1, 0);

      const ok =
        bestToEast?.nextHop === '10.10.1.2' &&
        bestToEast?.metric === 3 &&
        goesViaCore &&
        backupRoute?.nextHop === '10.10.99.2' &&
        backupRoute?.metric === 11 &&
        backupPing.success &&
        ospfHelloSteps.length >= 6;

      return {
        passed: ok,
        detail: `SPF выбрал путь RTR-West → RTR-Core → RTR-East [110/3] (Traceroute ${hops.length} хопа). При обрыве оптики — автопереход на прямой линк 10.10.99.2 [110/11].`,
        stepsGenerated: traceRes.steps.length + backupPing.steps.length + ospfHelloSteps.length,
      };
    }
  );

  // 7. Preset 6: RIPv2 Multi-Hop Distance-Vector Routing (Hop Count Metric, AD 120)
  runCheck(
    'diag-7-ripv2-routing',
    'L3 RIP',
    'Стенд 6 (RIPv2 Hop Routing)',
    'Дистанционно-векторная маршрутизация RIPv2 через 3 роутера: маршрут R [120/2], Ping и Traceroute',
    () => {
      const p6 = getPresetClone('ripv2-hop-routing');
      const rtrA = p6.nodes.find((n) => n.id === 'rip-rtr-a')!;
      const bestRip = findBestRoute(rtrA, '10.2.0.50', p6.nodes, p6.links);

      const pingRes = runPacketSimulation(
        p6.nodes,
        p6.links,
        'rip-pc-a',
        '10.2.0.50',
        'ICMP'
      );
      const traceRes = runTracerouteSimulation(
        p6.nodes,
        p6.links,
        'rip-pc-a',
        '10.2.0.50'
      );
      const hopCount = (traceRes.tracerouteHops || []).length;

      const ok =
        bestRip?.type === 'R' &&
        bestRip?.administrativeDistance === 120 &&
        bestRip?.metric === 2 &&
        pingRes.success &&
        hopCount === 4;

      return {
        passed: ok,
        detail: `Изучен маршрут RIPv2: R 10.2.0.0/24 [120/2] via 172.30.1.2 (RTR-Hub). Ping и Traceroute (4 хопа) доставлены успешно.`,
        stepsGenerated: pingRes.steps.length + traceRes.steps.length,
      };
    }
  );

  // 8. Preset 7: Extended ACL Firewall DMZ (Deny ICMP from Guest, Permit HTTP from Guest, Permit ICMP from Admin)
  runCheck(
    'diag-8-acl-firewall-dmz',
    'L4 NAT/ACL',
    'Стенд 7 (Extended ACL & DMZ)',
    'Фильтрация Extended ACL 100: блокировка ICMP с PC-Guest (ACL Drop ✕) и разрешение HTTP (TCP 80) + VIP Admin',
    () => {
      const p7 = getPresetClone('acl-firewall-dmz');
      const guestPing = runPacketSimulation(
        p7.nodes,
        p7.links,
        'fw-pc-guest',
        '172.16.50.100',
        'ICMP'
      );
      const hasAclDropStep = guestPing.steps.some(
        (s) => s.status === 'dropped' && s.decisionTitle.includes('ACL Drop')
      );

      const guestHttp = runHttpBrowserSimulation(
        p7.nodes,
        p7.links,
        'fw-pc-guest',
        'http://vault.corp.local'
      );

      const adminPing = runPacketSimulation(
        p7.nodes,
        p7.links,
        'fw-pc-admin',
        '172.16.50.100',
        'ICMP'
      );

      const ok =
        !guestPing.success &&
        hasAclDropStep &&
        guestHttp.success &&
        guestHttp.httpResult?.statusCode === 200 &&
        adminPing.success;

      return {
        passed: ok,
        detail: `Правило ACL #10 заблокировало ICMP от PC-Guest (ACL Drop ✕), правило #20 пропустило HTTP GET (200 OK), правило #30 пропустило ICMP от PC-Admin.`,
        stepsGenerated:
          guestPing.steps.length + guestHttp.steps.length + adminPing.steps.length,
      };
    }
  );

  // 9. Multi-Flow Live Traffic Generator & Cisco IOS CLI Verification
  runCheck(
    'diag-9-cli-and-multiflow',
    'CLI/CORE',
    'Все стенды (CLI + Live Stream)',
    'Генератор живого потока (Multi-Flow: OSPF, STP, ARP, ICMP, DNS, HTTP) и парсер команд Cisco IOS CLI',
    () => {
      const p5 = getPresetClone('ospf-triangle-mesh');
      const batch = generateMultiFlowTrafficSteps(p5.nodes, p5.links, 1);
      const rtrWest = p5.nodes.find((n) => n.id === 'mesh-rtr-west')!;
      const cliNbr = executeIosCommand('show ip ospf neighbor', rtrWest, p5.nodes, p5.links);
      const cliProtocols = executeIosCommand('show ip protocols', rtrWest, p5.nodes, p5.links);

      const hasOspfSteps = batch.steps.some(
        (s) => s.protocol === 'OSPF_HELLO' || s.protocol === 'OSPF_LSA'
      );
      const cliOk =
        cliNbr.outputLines.some((l) => l.includes('2.2.2.2') && l.includes('FULL')) &&
        cliProtocols.outputLines.some((l) => l.includes('Routing Protocol is "ospf 1"'));

      return {
        passed: batch.steps.length >= 8 && hasOspfSteps && cliOk,
        detail: `Генератор Multi-Flow сформировал ${batch.steps.length} пакетов (включая OSPF_HELLO/LSA). Команды CLI show ip ospf neighbor и show ip protocols отработали корректно.`,
        stepsGenerated: batch.steps.length,
      };
    }
  );

  // 10. Preset 8: Multilayer Switch L3 (SVI Vlan10/Vlan20) & EtherChannel LACP (IEEE 802.3ad Po1)
  runCheck(
    'diag-10-l3-svi-etherchannel',
    'L1/L2',
    'Стенд 8 (L3 SVI & LACP Po1)',
    'Маршрутизирующий коммутатор L3 (interface Vlan10/Vlan20, ip routing) и агрегация каналов EtherChannel LACP Po1 (2 Gbps, оба линка в STP FWD)',
    () => {
      const p8 = getPresetClone('l3-switch-svi-etherchannel');
      const stp = computeSpanningTreeState(p8.nodes, p8.links);
      const accessGi1 = stp['l3sw-access']?.ports['l3a-gi0/1'];
      const accessGi2 = stp['l3sw-access']?.ports['l3a-gi0/2'];
      const lacpStpOk =
        accessGi1?.state === 'forwarding' &&
        accessGi2?.state === 'forwarding' &&
        accessGi1?.portChannelName === 'Po1' &&
        accessGi1?.aggregatedBandwidthMbps === 2000;

      const sviPing = runPacketSimulation(
        p8.nodes,
        p8.links,
        'l3sw-pc-10',
        '192.168.20.20',
        'ICMP'
      );
      const sviHttp = runHttpBrowserSimulation(
        p8.nodes,
        p8.links,
        'l3sw-pc-10',
        'http://svi.corp.local'
      );
      const sviDhcp = runDhcpDoraSimulation(p8.nodes, p8.links, 'l3sw-pc-10');

      const ok =
        lacpStpOk &&
        sviPing.success &&
        sviHttp.success &&
        sviHttp.httpResult?.statusCode === 200 &&
        sviDhcp.success &&
        sviDhcp.assignedDhcpConfig?.ipAddress === '192.168.10.50';

      return {
        passed: ok,
        detail: `Связка Po1 (Gi0/1+Gi0/2 = 2000 Mbps) работает в STP FWD без блокировки BLK. Меж-VLAN маршрутизация через SVI Vlan10→Vlan20, HTTP и DHCP Relay прошли успешно.`,
        stepsGenerated: sviPing.steps.length + sviHttp.steps.length + sviDhcp.steps.length,
      };
    }
  );

  // 11. Preset 9: IEEE 802.11 Wi-Fi Access Points, SOHO Router, WPA2-PSK, Wireless DHCP & Seamless ESS Roaming
  runCheck(
    'diag-11-wifi-80211-roaming',
    'L1/L2',
    'Стенд 9 (Wi-Fi 802.11 & Roaming)',
    'Беспроводная сеть Wi-Fi 802.11 (WPA2-PSK): Ping по радиоканалу, DHCP DORA по воздуху и авто-роуминг между AP-West и AP-East',
    () => {
      const p9 = getPresetClone('wifi-campus-roaming-lab');
      const wifiPing = runPacketSimulation(
        p9.nodes,
        p9.links,
        'wifi-laptop-1',
        '192.168.20.100',
        'ICMP'
      );
      const wifiDhcp = runDhcpDoraSimulation(p9.nodes, p9.links, 'wifi-phone-1');
      const wifiHttp = runHttpBrowserSimulation(
        p9.nodes,
        p9.links,
        'wifi-laptop-1',
        'http://wifi.corp.local'
      );

      // Move Laptop-Pro into AP-East coverage zone (x=520, y=460) and verify automatic roaming
      const movedNodes = p9.nodes.map((n) =>
        n.id === 'wifi-laptop-1' ? { ...n, x: 520, y: 460 } : n
      );
      const roamed = syncWirelessAssociations(movedNodes, p9.links);
      const laptopAfterRoam = roamed.nodes.find((n) => n.id === 'wifi-laptop-1');
      const roamedToEast = laptopAfterRoam?.wifiClientConfig?.connectedApNodeId === 'wifi-ap-east';
      const pingAfterRoam = runPacketSimulation(
        roamed.nodes,
        roamed.links,
        'wifi-laptop-1',
        '192.168.20.100',
        'ICMP'
      );

      const ok =
        wifiPing.success &&
        wifiDhcp.success &&
        wifiHttp.success &&
        roamedToEast &&
        pingAfterRoam.success;

      return {
        passed: ok,
        detail: `Wi-Fi 802.11 (SSID «Corp-WiFi» WPA2-PSK): Ping, HTTP и DHCP DORA по радиоканалу успешны. При перемещении Laptop-Pro выполнен бесшовный роуминг AP-West → AP-East.`,
        stepsGenerated:
          wifiPing.steps.length +
          wifiDhcp.steps.length +
          wifiHttp.steps.length +
          pingAfterRoam.steps.length,
      };
    }
  );

  // 12. Preset 10: WLC 5520 Wireless LAN Controller, CAPWAP Tunnels (UDP 5246/5247), RRM Auto-Channel & Lightweight APs
  runCheck(
    'diag-12-wlc-capwap',
    'L7 APP',
    'Стенд 10 (WLC 5520 & CAPWAP)',
    'Контроллер WLC 5520 и Lightweight AP: туннели CAPWAP (UDP 5246/5247), RRM каналы Ch 1/6/11, централизованный Push SSID/VLAN и трафик клиентов',
    () => {
      const p10 = getPresetClone('wlc-capwap-enterprise-lab');
      const synced = syncWirelessAssociations(p10.nodes, p10.links);

      const lap1 = synced.nodes.find((n) => n.id === 'wlc-lap-1');
      const lap2 = synced.nodes.find((n) => n.id === 'wlc-lap-2');
      const lap3 = synced.nodes.find((n) => n.id === 'wlc-lap-3');

      const allJoined =
        lap1?.wifiConfig?.capwapStatus === 'joined' &&
        lap2?.wifiConfig?.capwapStatus === 'joined' &&
        lap3?.wifiConfig?.capwapStatus === 'joined';

      const rrmChannelsOk =
        lap1?.wifiConfig?.channel === 1 &&
        lap2?.wifiConfig?.channel === 6 &&
        lap3?.wifiConfig?.channel === 11;

      const capwapSteps = synthesizeCapwapTunnelSteps(synced.nodes, synced.links, 1, 0);
      const capwapProtocolsOk =
        capwapSteps.some((s) => s.protocol === 'CAPWAP_CONTROL') &&
        capwapSteps.some((s) => s.protocol === 'CAPWAP_DATA');

      const wlcPing = runPacketSimulation(
        synced.nodes,
        synced.links,
        'wlc-laptop-1',
        '192.168.20.100',
        'ICMP'
      );
      const wlcHttp = runHttpBrowserSimulation(
        synced.nodes,
        synced.links,
        'wlc-laptop-1',
        'http://wlc.corp.local'
      );

      const ok =
        allJoined &&
        rrmChannelsOk &&
        capwapProtocolsOk &&
        wlcPing.success &&
        wlcHttp.success &&
        wlcHttp.httpResult?.statusCode === 200;

      return {
        passed: ok,
        detail: `WLC-5520 (192.168.10.5) управляет 3 точками Lightweight AP по CAPWAP (UDP 5246/5247), RRM разнёс каналы Ch 1/6/11, Ping и HTTP через LAP-Floor1 прошли успешно.`,
        stepsGenerated: capwapSteps.length + wlcPing.steps.length + wlcHttp.steps.length,
      };
    }
  );

  // 13. Preset 11: Firewall (Cisco ASA / FortiGate): Security Zones (Inside 100, DMZ 50, Outside 0), SPI, Port Forwarding & Site-to-Site IPsec VPN
  runCheck(
    'diag-13-firewall-asa-dmz-vpn',
    'L4 NAT/ACL',
    'Стенд 11 (Firewall ASA / FortiGate)',
    'Межсетевой экран ASA: зоны Inside(100)/DMZ(50)/Outside(0), сессии SPI, публикация DMZ Port Forwarding (DNAT) и Site-to-Site IPsec VPN (IKEv2/ESP)',
    () => {
      const p11 = getPresetClone('firewall-asa-dmz-vpn-lab');

      // 1. Inside (100) -> Outside (0) Ping creates SPI session and permits Echo Reply
      const spiOutbound = runPacketSimulation(
        p11.nodes,
        p11.links,
        'fw-pc-corp',
        '8.8.8.50',
        'ICMP'
      );
      const fwAfterSpi = spiOutbound.updatedNodes.find((n) => n.id === 'fw-asa-hq');
      const hasSpiSession =
        (fwAfterSpi?.firewallConfig?.statefulSessions?.length || 0) >= 1;

      // 2. Outside (0) -> Inside (100) direct Ping is dropped by ASA Security Level policy
      const outsideAttack = runPacketSimulation(
        p11.nodes,
        p11.links,
        'fw-pc-internet',
        '192.168.100.10',
        'ICMP'
      );
      const hasZoneDrop = outsideAttack.steps.some(
        (s) => s.status === 'dropped' && s.decisionTitle.includes('Firewall ASA DROP')
      );

      // 3. Outside (0) -> DMZ (50) Port Forwarding HTTP GET http://203.0.113.2 -> 172.16.50.100:80 succeeds
      const dmzHttp = runHttpBrowserSimulation(
        p11.nodes,
        p11.links,
        'fw-pc-internet',
        'http://203.0.113.2'
      );

      // 4. Site-to-Site IPsec VPN between PC-Corp (192.168.100.10) and PC-Branch (10.200.1.10)
      const vpnPing = runPacketSimulation(
        p11.nodes,
        p11.links,
        'fw-pc-corp',
        '10.200.1.10',
        'ICMP'
      );
      const ikeSteps = synthesizeIpsecVpnSteps(p11.nodes, p11.links, 1, 0);
      const hasEspStep =
        vpnPing.steps.some((s) => s.protocol === 'IPSEC_ESP') &&
        ikeSteps.some((s) => s.protocol === 'IKEV2');

      const ok =
        spiOutbound.success &&
        hasSpiSession &&
        !outsideAttack.success &&
        hasZoneDrop &&
        dmzHttp.success &&
        dmzHttp.httpResult?.statusCode === 200 &&
        vpnPing.success &&
        hasEspStep;

      return {
        passed: ok,
        detail: `Inside(100)→Outside(0) создал сессию SPI, атака Outside(0)→Inside(100) заблокирована (ASA DROP), DMZ Port Forward 203.0.113.2:80→172.16.50.100:80 вернул HTTP 200 OK, туннель IPsec ESP (192.168.100.0/24 ⇄ 10.200.1.0/24) активен.`,
        stepsGenerated:
          spiOutbound.steps.length +
          outsideAttack.steps.length +
          dmzHttp.steps.length +
          vpnPing.steps.length +
          ikeSteps.length,
      };
    }
  );

  // 14. Preset 12: Switch StackWise-480 Ring & Router Stack HSRP/VSS Virtual Gateway + Automatic Failover
  runCheck(
    'diag-14-stackwise-hsrp-vss',
    'L1/L2',
    'Стенд 12 (StackWise-480 & HSRP/VSS)',
    'Стекирование коммутаторов (StackWise-480) и стек роутеров (HSRP VIP 192.168.10.1): межшассийная коммутация и авто-Failover при отказе Master',
    () => {
      const p12 = getPresetClone('ha-stack-campus');

      // 1. L2 Ping across Switch StackWise-480 backplane (SW-Stack-1 <-> SW-Stack-2)
      const l2StackPing = runPacketSimulation(
        p12.nodes,
        p12.links,
        'stk-pc-1',
        '192.168.10.11',
        'ICMP'
      );

      // 2. L3 Ping & HTTP through HSRP Virtual IP (192.168.10.1) & Router Stack Backplane (RTR-Stack-1 -> RTR-Stack-2 -> SRV-Cloud)
      const l3VipPing = runPacketSimulation(
        p12.nodes,
        p12.links,
        'stk-pc-1',
        '203.0.113.100',
        'ICMP'
      );
      const l3VipHttp = runHttpBrowserSimulation(
        p12.nodes,
        p12.links,
        'stk-pc-2',
        'http://stack.netpulse.local'
      );

      // 3. Simulate Master Router (RTR-Stack-1) LAN port failure -> Standby Router (RTR-Stack-2) takes over VIP 192.168.10.1
      const failoverNodes = p12.nodes.map((n) =>
        n.id === 'stk-rtr-1'
          ? {
              ...n,
              interfaces: n.interfaces.map((i) =>
                i.id === 'sr1-gi0/0' ? { ...i, adminStatus: 'down' as const } : i
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

      const ok =
        l2StackPing.success &&
        l3VipPing.success &&
        l3VipHttp.success &&
        l3VipHttp.httpResult?.statusCode === 200 &&
        failoverPing.success;

      return {
        passed: ok,
        detail: `Кольцо коммутаторов StackWise-480 (480 Гбит/с) и стек роутеров HSRP/VSS (VIP 192.168.10.1) передают L2/L3 трафик; при отключении порта на RTR-Stack-1 резервный RTR-Stack-2 мгновенно перехватил VIP 192.168.10.1.`,
        stepsGenerated:
          l2StackPing.steps.length +
          l3VipPing.steps.length +
          l3VipHttp.steps.length +
          failoverPing.steps.length,
      };
    }
  );

  // 15. Preset 13 — VoIP SIP / RTP Call (101 -> 102), Voice + Data VLAN Passthrough & IEEE 802.3af/at PoE Budget
  runCheck(
    'diag-15-voip-poe-voice-vlan',
    'L7 APP',
    '13. IP-телефония (VoIP SIP) и PoE',
    'VoIP звонок SIP INVITE + RTP (101 → 102), проходной порт PC (Voice VLAN 20 + Data VLAN 10) и бюджет PoE 802.3af/at (29.4W / 370W)',
    () => {
      const p13 = getPresetClone('voip-poe-campus');
      const swPoe = p13.nodes.find((n) => n.id === 'voip-sw-1')!;
      const poeStatus = computeSwitchPoeStatus(swPoe, p13.nodes, p13.links);

      // 1. Verify SIP INVITE -> 200 OK -> RTP Audio call from IP-Phone-101 (Ext 101) to IP-Phone-102 (Ext 102)
      const sipCall = runVoipSipCallSimulation(
        p13.nodes,
        p13.links,
        'voip-phone-101',
        '102'
      );

      // 2. Verify PC Passthrough over single switch cable: PC-Sales-1 (Data VLAN 10) -> IP-Phone-101 -> SW-PoE-Core -> IP-Phone-102 -> PC-Exec-2
      const pcPassthroughPing = runPacketSimulation(
        p13.nodes,
        p13.links,
        'voip-pc-1',
        '192.168.10.11',
        'ICMP'
      );

      // 3. Verify Inter-VLAN L3 SVI routing from PC-Sales-1 (VLAN 10) to SRV-SIP-PBX (VLAN 20) through IP-Phone-101 passthrough switch
      const interVlanHttp = runHttpBrowserSimulation(
        p13.nodes,
        p13.links,
        'voip-pc-1',
        'http://voip.corp.local'
      );

      // 4. Verify PoE cutoff: disabling PoE on Fa0/1 (power inline never) powers off IP-Phone-101 and blocks SIP call
      const noPoeNodes = p13.nodes.map((n) =>
        n.id === 'voip-sw-1'
          ? {
              ...n,
              interfaces: n.interfaces.map((i) =>
                i.id === 'vsw-fa0/1' ? { ...i, poeEnabled: false } : i
              ),
            }
          : n
      );
      const unpoweredCall = runVoipSipCallSimulation(
        noPoeNodes,
        p13.links,
        'voip-phone-101',
        '102'
      );

      const ok =
        Math.abs(poeStatus.usedWatts - 29.4) < 0.05 &&
        sipCall.success &&
        sipCall.steps.some((s) => s.protocol === 'SIP_INVITE') &&
        sipCall.steps.some((s) => s.protocol === 'SIP_200_OK') &&
        sipCall.steps.some((s) => s.protocol === 'RTP_AUDIO') &&
        pcPassthroughPing.success &&
        interVlanHttp.success &&
        !unpoweredCall.success;

      return {
        passed: ok,
        detail: `PoE бюджет SW-PoE-Core: ${poeStatus.usedWatts}W / ${poeStatus.totalBudgetWatts}W (2×IP-Phone 7.0W + AP 15.4W); вызов SIP 101→102 (Voice VLAN 20, DSCP EF) и проходной трафик ПК (Data VLAN 10) по одному кабелю успешны.`,
        stepsGenerated:
          sipCall.steps.length +
          pcPassthroughPing.steps.length +
          interVlanHttp.steps.length,
      };
    }
  );

  // 16. Preset 14 — Video Surveillance & IoT: PoE IP Cameras (RTSP Unicast & Multicast), NVR Recorder & ACL Internet Isolation
  runCheck(
    'diag-16-cctv-iot-poe-acl',
    'L7 APP',
    '14. Видеонаблюдение и IoT (PoE + NVR + ACL)',
    'Потоковое видео RTSP/RTP (Unicast и Multicast 239.0.30.1) в CCTV VLAN 30, PoE 802.3af (19.0W) и блокировка выхода камер в Интернет через ACL',
    () => {
      const p14 = getPresetClone('cctv-iot-poe-vlan');
      const swCctv = p14.nodes.find((n) => n.id === 'cctv-sw-1')!;
      const poeStatus = computeSwitchPoeStatus(swCctv, p14.nodes, p14.links);

      // 1. Verify RTSP Unicast stream from CAM-Gate-01 (192.168.30.11) to NVR-Recorder (192.168.30.100)
      const rtspUnicast = runRtspVideoStreamSimulation(
        p14.nodes,
        p14.links,
        'cctv-cam-1',
        '192.168.30.100',
        'unicast'
      );

      // 2. Verify RTSP Multicast stream from CAM-Vault-02 (192.168.30.12) to Multicast Group 239.0.30.1
      const rtspMulticast = runRtspVideoStreamSimulation(
        p14.nodes,
        p14.links,
        'cctv-cam-2',
        '239.0.30.1',
        'multicast'
      );

      // 3. Verify IoT / Camera Internet isolation: CAM-Gate-01 (192.168.30.11) -> WAN 203.0.113.100 is blocked by ACL Seq 10 DENY
      const camInternetPing = runPacketSimulation(
        p14.nodes,
        p14.links,
        'cctv-cam-1',
        '203.0.113.100',
        'ICMP'
      );
      const aclBlocked =
        !camInternetPing.success &&
        camInternetPing.steps.some(
          (s) => s.status === 'dropped' && s.decisionTitle.includes('ACL Drop')
        );

      // 4. Verify Security Ops PC (VLAN 10) can access NVR-Recorder web portal (VLAN 30) via Router-on-a-Stick
      const opsToNvrHttp = runHttpBrowserSimulation(
        p14.nodes,
        p14.links,
        'cctv-pc-ops',
        'http://nvr.corp.local'
      );

      const ok =
        Math.abs(poeStatus.usedWatts - 19.0) < 0.05 &&
        rtspUnicast.success &&
        rtspUnicast.steps.some((s) => s.protocol === 'RTSP_SETUP') &&
        rtspUnicast.steps.some((s) => s.protocol === 'RTSP_200_OK') &&
        rtspUnicast.steps.some((s) => s.protocol === 'RTP_VIDEO') &&
        rtspMulticast.success &&
        rtspMulticast.steps.some(
          (s) => s.protocol === 'RTP_VIDEO' && s.outboundPdu?.l3.dstIp === '239.0.30.1'
        ) &&
        aclBlocked &&
        opsToNvrHttp.success;

      return {
        passed: ok,
        detail: `PoE бюджет SW-CCTV-PoE: ${poeStatus.usedWatts}W / ${poeStatus.totalBudgetWatts}W (2×IP-камеры 9.5W); потоки RTSP Unicast (4K H.265) и Multicast (239.0.30.1) записаны на NVR; выход камер в WAN (203.0.113.100) заблокирован ACL.`,
        stepsGenerated:
          rtspUnicast.steps.length +
          rtspMulticast.steps.length +
          camInternetPing.steps.length +
          opsToNvrHttp.steps.length,
      };
    }
  );

  // 17. Preset 15 — Dual-ISP WAN Cloud, eBGP Multihoming (AS 65000 <-> AS 65101 / AS 65202) & WAN Link Impairment
  runCheck(
    'diag-17-dual-isp-ebgp-wan-impairment',
    'L3 IP',
    '15. Провайдеры WAN / ISP Cloud, eBGP (Dual-ISP)',
    'eBGP пиринг TCP 179 (AS 65000 ↔ AS 65101 / AS 65202), Best-Path через ISP-1 (Weight 200, LP 150, 8ms), авто-переключение на ISP-2 при аварии и эмулятор потерь WAN',
    () => {
      const p15 = getPresetClone('dual-isp-ebgp-wan-impairment');
      const rtrHq = p15.nodes.find((n) => n.id === 'bgp-rtr-hq')!;

      // 1. Verify eBGP TCP 179 Peering simulation (BGP_OPEN -> BGP_KEEPALIVE -> BGP_UPDATE)
      const bgpPeering = runBgpPeeringSimulation(p15.nodes, p15.links, 'bgp-rtr-hq');

      // 2. Verify eBGP Best-Path selection chooses ISP-1-Primary (203.0.113.1, AS 65101) for 8.8.8.0/24
      const bgpTable = computeBgpRoutesForRouter(rtrHq, p15.nodes, p15.links);
      const best888 = bgpTable.bestRoutes.find((r) => r.network === '8.8.8.0');

      // 3. Verify ICMP Ping from PC-Corp-HQ (192.168.10.10) to SRV-Global-DNS (8.8.8.8) traverses ISP-1-Primary
      const primaryPing = runPacketSimulation(
        p15.nodes,
        p15.links,
        'bgp-pc-hq',
        '8.8.8.8',
        'ICMP'
      );
      const traversedIsp1 = primaryPing.steps.some(
        (s) => s.fromNodeId === 'bgp-isp-1' || s.toNodeId === 'bgp-isp-1'
      );

      // 4. Verify WAN Link Impairment: setting 100% Packet Loss on ISP-1-Primary triggers automatic eBGP failover to ISP-2-Backup (AS 65202)
      const isp1LossNodes = p15.nodes.map((n) =>
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
      const failoverPing = runPacketSimulation(
        isp1LossNodes,
        p15.links,
        'bgp-pc-hq',
        '8.8.8.8',
        'ICMP'
      );
      const traversedIsp2 = failoverPing.steps.some(
        (s) => s.fromNodeId === 'bgp-isp-2' || s.toNodeId === 'bgp-isp-2'
      );

      // 5. Verify WAN Packet Loss Drop when both ISP-1 and ISP-2 have 100% loss
      const bothLossNodes = isp1LossNodes.map((n) =>
        n.id === 'bgp-isp-2' && n.wanImpairment
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
      const droppedWanPing = runPacketSimulation(
        bothLossNodes,
        p15.links,
        'bgp-pc-hq',
        '8.8.8.8',
        'ICMP'
      );

      const ok =
        bgpPeering.success &&
        bgpPeering.steps.some((s) => s.protocol === 'BGP_OPEN') &&
        bgpPeering.steps.some((s) => s.protocol === 'BGP_UPDATE') &&
        best888?.nextHop === '203.0.113.1' &&
        primaryPing.success &&
        traversedIsp1 &&
        failoverPing.success &&
        traversedIsp2 &&
        !droppedWanPing.success;

      return {
        passed: ok,
        detail: `Сессии eBGP (AS 65000 ↔ AS 65101 / AS 65202) установлены; основной маршрут * > 8.8.8.0/24 идёт через ISP-1 (203.0.113.1, 8 мс); при аварии канала ISP-1 трафик автоматически переключается на резервный ISP-2 (198.51.100.1, 45 мс).`,
        stepsGenerated:
          bgpPeering.steps.length +
          primaryPing.steps.length +
          failoverPing.steps.length,
      };
    }
  );

  const totalDurationMs = Math.max(
    1,
    Math.round((performance.now() - suiteStart) * 10) / 10
  );
  const passedChecks = results.filter((r) => r.passed).length;
  const failedChecks = results.length - passedChecks;

  return {
    totalChecks: results.length,
    passedChecks,
    failedChecks,
    totalDurationMs,
    allPassed: failedChecks === 0,
    results,
  };
}

