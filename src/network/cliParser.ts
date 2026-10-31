import {
  AclAction,
  AclProtocol,
  FirewallZoneName,
  NetworkInterface,
  NetworkLink,
  NetworkNode,
  SimulationStep,
  SwitchSviInterface,
} from './types';
import {
  getDefaultSecurityLevelForZone,
  getInterfaceSecurityZoneAndLevel,
} from './firewallEngine';
import {
  getDefaultStackVirtualMac,
  getNodeStackStatus,
  getStackGroups,
} from './stackEngine';
import { isValidIpv4, isValidSubnetMask, maskToCidr } from './ipMath';
import { getDeviceVlanDatabase, upsertDeviceVlan } from './hardwareChassis';
import {
  addOspfNetworkStatementToRouter,
  calculateOspfInterfaceCost,
  computeOspfNeighborsForRouter,
  electOspfRouterId,
  getDefaultOspfConfig,
  getInterfaceBandwidthMbps,
  synthesizeOspfHelloSteps,
} from './ospfEngine';
import {
  computeSpanningTreeState,
  getEtherChannelBundles,
  isSwitchSviLineProtocolUp,
  runBgpPeeringSimulation,
  runDhcpDoraSimulation,
  runHttpBrowserSimulation,
  runPacketSimulation,
  runRtspVideoStreamSimulation,
  runTracerouteSimulation,
  runVoipSipCallSimulation,
  syncAllRoutersRoutingTables,
  syncConnectedRoutes,
} from './simulator';
import {
  computeBgpRoutesForRouter,
  discoverBgpPeersForRouter,
  formatWanImpairmentSummary,
  resolveBgpRouterId,
} from './bgpAndWanEngine';
import {
  computeSwitchPoeStatus,
  getIpCameraDirectory,
  getVoipDirectory,
  isVoipPhoneNode,
} from './poeAndVoipEngine';

export interface CliExecutionResult {
  updatedNode: NetworkNode;
  updatedAllNodes?: NetworkNode[];
  outputLines: string[];
  triggeredSimulationSteps?: SimulationStep[];
  triggeredSummaryMessage?: string;
}

function normalizeInterfaceQuery(raw: string): string {
  const s = raw.trim().toLowerCase().replace(/\s+/g, '');
  if (s.startsWith('fastethernet')) return 'fa' + s.slice('fastethernet'.length);
  if (s.startsWith('gigabitethernet')) return 'gi' + s.slice('gigabitethernet'.length);
  if (s.startsWith('ethernet')) return 'eth' + s.slice('ethernet'.length);
  return s;
}

function findInterface(node: NetworkNode, rawName: string): NetworkInterface | undefined {
  const norm = normalizeInterfaceQuery(rawName);
  return node.interfaces.find(
    (i) =>
      i.shortName.toLowerCase() === norm ||
      i.name.toLowerCase().replace(/\s+/g, '') === norm
  );
}

export function generateSviMacAddress(node: NetworkNode, vlanId: number): string {
  const baseMac = node.interfaces[0]?.macAddress || '00:D0:BA:10:00:01';
  const parts = baseMac.split(':');
  const hexVlan = (vlanId & 0xff).toString(16).toUpperCase().padStart(2, '0');
  if (parts.length === 6) {
    return `${parts[0]}:${parts[1]}:${parts[2]}:5F:${parts[4]}:${hexVlan}`;
  }
  return `00:D0:BA:5F:00:${hexVlan}`;
}

export function getCliPrompt(node: NetworkNode): string {
  switch (node.cli.mode) {
    case 'user':
      return `${node.name}>`;
    case 'priv':
      return `${node.name}#`;
    case 'config':
      return `${node.name}(config)#`;
    case 'config-if':
      return node.cli.selectedSubinterfaceVlan
        ? `${node.name}(config-subif)#`
        : `${node.name}(config-if)#`;
    case 'config-router':
      return `${node.name}(config-router)#`;
    default:
      return `${node.name}>`;
  }
}

/**
 * Context-aware Tab Autocomplete for Cisco IOS CLI & Host Terminal.
 */
export function autocompleteIosCommand(
  partialInput: string,
  node: NetworkNode
): { completed: string; suggestions: string[] } {
  const trimmedLeft = partialInput.replace(/^\s+/, '');
  const hasTrailingSpace = /\s$/.test(partialInput);
  const tokens = trimmedLeft ? trimmedLeft.trim().split(/\s+/) : [];

  const portNames = node.interfaces.map((i) => i.shortName.toLowerCase());
  const subPortNames = node.interfaces.flatMap((i) =>
    (i.subinterfaces || []).map((s) => `${i.shortName.toLowerCase()}.${s.vlanId}`)
  );
  const sviPortNames =
    node.type === 'switch'
      ? (node.sviInterfaces || []).map((s) => `vlan ${s.vlanId}`)
      : [];
  const allPortCandidates = [...portNames, ...subPortNames, ...sviPortNames];

  // Mode-specific root command dictionaries
  const userCandidates = [
    'enable',
    'ping ',
    'traceroute ',
    'ipconfig',
    'ipconfig /renew',
    'nslookup ',
    'curl http://app.corp.local',
    'show ip interface brief',
    'show ip ospf neighbor',
    'show ip protocols',
    'show spanning-tree',
    'show etherchannel summary',
    'show ip nat translations',
    'show access-lists',
    'show arp',
    'show ip route',
    'help',
  ];

  const privCandidates = [
    'configure terminal',
    'show ip interface brief',
    'show ip route',
    'show ip bgp summary',
    'show ip bgp',
    'show wan',
    'show ip ospf neighbor',
    'show ip protocols',
    'show ip dhcp binding',
    'show ip nat translations',
    'show nameif',
    'show conn',
    'show nat',
    'show crypto ipsec sa',
    'show access-lists',
    'show spanning-tree',
    'show etherchannel summary',
    'show switch',
    'show standby brief',
    'show arp',
    'show mac address-table',
    'show vlan brief',
    'show running-config',
    'write memory',
    'copy running-config startup-config',
    'clear arp-cache',
    'clear mac address-table',
    'clear ip nat translation *',
    'ping ',
    'traceroute ',
    'disable',
    'exit',
  ];

  const configCandidates = [
    ...allPortCandidates.map((p) => `interface ${p}`),
    'interface vlan 10',
    'interface vlan 20',
    'ip routing',
    'router ospf 1',
    'router rip',
    'hostname ',
    'ip route ',
    'ip default-gateway ',
    'access-list 100 deny icmp any any',
    'access-list 100 permit ip any any',
    'spanning-tree vlan 1 priority ',
    'do show ip ospf neighbor',
    'do show etherchannel summary',
    'do show ip route',
    'do show ip interface brief',
    'do write memory',
    'exit',
    'end',
  ];

  const configIfCandidates = [
    'encapsulation dot1Q ',
    'ip address ',
    'ip address dhcp',
    'nameif inside',
    'nameif dmz',
    'nameif outside',
    'security-level ',
    'ip ospf cost ',
    'ip helper-address ',
    'ip nat inside',
    'ip nat outside',
    'channel-group 1 mode active',
    'channel-group 1 mode passive',
    'channel-group 1 mode on',
    'no channel-group',
    'no shutdown',
    'shutdown',
    'switchport mode access',
    'switchport mode trunk',
    'switchport access vlan ',
    'switchport trunk allowed vlan ',
    'do show ip interface brief',
    'exit',
    'end',
  ];

  const configRouterCandidates = [
    'network 10.0.0.0 0.0.0.3 area 0',
    'network 172.16.1.0 0.0.0.255 area 0',
    'network 172.16.2.0 0.0.0.255 area 0',
    'network 192.168.1.0 0.0.0.255 area 0',
    'passive-interface ',
    'router-id ',
    'version 2',
    'do show ip ospf neighbor',
    'do show ip route',
    'exit',
    'end',
  ];

  const pool =
    node.cli.mode === 'user'
      ? userCandidates
      : node.cli.mode === 'priv'
      ? privCandidates
      : node.cli.mode === 'config'
      ? configCandidates
      : node.cli.mode === 'config-router'
      ? configRouterCandidates
      : configIfCandidates;

  if (!trimmedLeft) {
    return { completed: partialInput, suggestions: pool.slice(0, 6) };
  }

  const lowerInput = trimmedLeft.toLowerCase();

  // Expand shorthand prefixes directly before matching
  const shorthandMap: Record<string, string> = {
    'conf': 'configure terminal',
    'conf t': 'configure terminal',
    'sh ip int': 'show ip interface brief',
    'sh ip int b': 'show ip interface brief',
    'sh ip ospf': 'show ip ospf neighbor',
    'sh ip ospf n': 'show ip ospf neighbor',
    'sh ip ospf nei': 'show ip ospf neighbor',
    'sh ip proto': 'show ip protocols',
    'sh ip ro': 'show ip route',
    'sh run': 'show running-config',
    'sh mac': 'show mac address-table',
    'sh vlan': 'show vlan brief',
    'sh span': 'show spanning-tree',
    'sh eth': 'show etherchannel summary',
    'sh eth sum': 'show etherchannel summary',
    'sh etherchannel': 'show etherchannel summary',
    'sh ip nat': 'show ip nat translations',
    'sh ip nat tr': 'show ip nat translations',
    'sh access-lists': 'show access-lists',
    'sh acl': 'show access-lists',
    'encap': 'encapsulation dot1Q ',
    'encap dot1q': 'encapsulation dot1Q ',
    'ip helper': 'ip helper-address ',
    'ch': 'channel-group 1 mode active',
    'channel-group': 'channel-group 1 mode active',
    'no shut': 'no shutdown',
    'shut': 'shutdown',
    'wr': 'write memory',
    'copy run start': 'copy running-config startup-config',
    'sw mode a': 'switchport mode access',
    'sw mode t': 'switchport mode trunk',
    'sw a v': 'switchport access vlan ',
  };

  if (shorthandMap[lowerInput]) {
    return { completed: shorthandMap[lowerInput], suggestions: [shorthandMap[lowerInput]] };
  }

  // Handle "int <port>" or "interface <port>" completion
  if ((tokens[0]?.toLowerCase() === 'int' || tokens[0]?.toLowerCase() === 'interface') && tokens.length <= 2) {
    const portPrefix = (tokens[1] || '').toLowerCase();
    const matchingPorts = allPortCandidates.filter((p) => p.startsWith(portPrefix));
    if (matchingPorts.length === 1) {
      return {
        completed: `interface ${matchingPorts[0]}`,
        suggestions: [`interface ${matchingPorts[0]}`],
      };
    }
    if (matchingPorts.length > 1 && !hasTrailingSpace && tokens.length === 1) {
      return {
        completed: 'interface ',
        suggestions: matchingPorts.map((p) => `interface ${p}`),
      };
    }
  }

  const matches = pool.filter((cand) => cand.toLowerCase().startsWith(lowerInput));
  if (matches.length === 1) {
    return { completed: matches[0], suggestions: matches };
  }
  if (matches.length > 1) {
    let prefix = matches[0];
    for (let i = 1; i < matches.length; i++) {
      while (!matches[i].toLowerCase().startsWith(prefix.toLowerCase()) && prefix.length > 0) {
        prefix = prefix.slice(0, -1);
      }
    }
    return {
      completed: prefix.length > trimmedLeft.length ? prefix : partialInput,
      suggestions: matches,
    };
  }

  return { completed: partialInput, suggestions: [] };
}

export function executeIosCommand(
  rawCommand: string,
  nodeInput: NetworkNode,
  allNodes: NetworkNode[],
  allLinks: NetworkLink[]
): CliExecutionResult {
  const node: NetworkNode = JSON.parse(JSON.stringify(nodeInput));
  const cmd = rawCommand.trim();
  const prompt = getCliPrompt(node);

  if (!cmd) {
    return { updatedNode: node, outputLines: [prompt] };
  }

  // Record command in commandLog for ↑/↓ arrow history navigation
  const prevLog = node.cli.commandLog || [];
  if (prevLog[prevLog.length - 1] !== cmd) {
    node.cli.commandLog = [...prevLog.slice(-49), cmd];
  }

  const tokens = cmd.split(/\s+/);
  const first = tokens[0].toLowerCase();
  const second = tokens[1]?.toLowerCase() || '';
  const third = tokens[2]?.toLowerCase() || '';
  const output: string[] = [`${prompt} ${cmd}`];

  // Universal commands across modes
  if (first === 'help' || first === '?') {
    output.push(
      'Доступные команды Cisco IOS / Host CLI (поддерживаются Tab и стрелки ↑/↓):',
      '  enable (en) / configure terminal (conf t)    — Привилегированный режим и конфигурация',
      '  interface <fa0/0 | fa0/0.10 | vlan 10>       — Выбор порта, 802.1Q подинтерфейса или SVI Vlan',
      '  ip routing / no ip routing                   — Включение маршрутизации L3 на коммутаторе (SVI)',
      '  channel-group <1-6> mode <active|passive|on> — Агрегация портов EtherChannel / LACP (Po1..Po6)',
      '  encapsulation dot1Q <vlan-id>                — Привязка VLAN к подинтерфейсу маршрутизатора',
      '  ip address <IP> <MASK> | dhcp                — Назначение IPv4 или запрос по DHCP',
      '  ip helper-address <DHCP_SERVER_IP>           — Ретрансляция DHCP (DHCP Relay Agent)',
      '  ip nat inside | ip nat outside               — Настройка роли интерфейса для NAT/PAT',
      '  access-list 100 <permit|deny> <proto> <s_ip> <d_ip> — Правило межсетевого экрана ACL',
      '  spanning-tree vlan 1 priority <0-61440>      — Приоритет STP 802.1D (выбор Root Bridge)',
      '  switchport mode access|trunk                 — Режим порта коммутатора (L2)',
      '  ip route <NET> <MASK> <NEXT_HOP>             — Статический маршрут L3',
      '  router ospf 1 / network <IP> <WILD> area 0   — Динамическая маршрутизация OSPFv2 (SPF)',
      '  ip ospf cost <1-65535>                       — Ручная стоимость линка OSPF на интерфейсе',
      '  show ip ospf neighbor / show ip protocols    — Таблица соседей OSPF и параметры протокола',
      '  show etherchannel summary (sh eth sum)       — Сводка агрегированных каналов Port-channel (LACP)',
      '  ping / traceroute / ipconfig /renew / curl   — Диагностика сети (ICMP, TTL, DHCP, HTTP)',
      '  show ip int brief / show ip route / show arp — Сводка интерфейсов, маршрутов и ARP',
      '  show spanning-tree (sh span)                 — Статус STP 802.1D (Root Bridge, FWD/BLK)',
      '  show ip nat translations (sh ip nat tr)      — Таблица трансляций NAT/PAT',
      '  show access-lists (sh acl)                   — Список правил фильтрации ACL и счётчики',
      '  exit / end / write memory (wr)               — Выход и сохранение конфигурации'
    );
    return { updatedNode: node, outputLines: output };
  }

  // Write memory / Save NVRAM shorthand (wr, write, copy run start, do wr)
  const isDoWrite =
    first === 'do' && (second === 'wr' || second === 'write' || second === 'copy');
  if (
    first === 'wr' ||
    first === 'write' ||
    (first === 'copy' && second.startsWith('run') && third.startsWith('start')) ||
    isDoWrite
  ) {
    output.push('Building configuration...');
    output.push('[OK] Конфигурация сохранена в энергонезависимую память (NVRAM / LocalStorage).');
    return { updatedNode: node, outputLines: output };
  }

  if (first === 'end') {
    node.cli.mode = 'priv';
    node.cli.selectedInterface = undefined;
    node.cli.selectedSubinterfaceVlan = undefined;
    node.cli.selectedSviVlan = undefined;
    node.cli.selectedRoutingProtocol = undefined;
    node.cli.selectedOspfProcessId = undefined;
    return { updatedNode: node, outputLines: output };
  }

  if (first === 'exit' || first === 'ex') {
    if (node.cli.mode === 'config-if' || node.cli.mode === 'config-router') {
      node.cli.mode = 'config';
      node.cli.selectedInterface = undefined;
      node.cli.selectedSubinterfaceVlan = undefined;
      node.cli.selectedSviVlan = undefined;
      node.cli.selectedRoutingProtocol = undefined;
      node.cli.selectedOspfProcessId = undefined;
    } else if (node.cli.mode === 'config') {
      node.cli.mode = 'priv';
    } else if (node.cli.mode === 'priv') {
      node.cli.mode = 'user';
    }
    return { updatedNode: node, outputLines: output };
  }

  // Mode transitions
  if (first === 'enable' || first === 'en') {
    node.cli.mode = 'priv';
    return { updatedNode: node, outputLines: output };
  }

  if (first === 'disable' || first === 'dis') {
    node.cli.mode = 'user';
    node.cli.selectedInterface = undefined;
    node.cli.selectedSubinterfaceVlan = undefined;
    node.cli.selectedSviVlan = undefined;
    return { updatedNode: node, outputLines: output };
  }

  if (first.startsWith('conf') && (second.startsWith('t') || !second)) {
    if (node.cli.mode === 'user') {
      output.push('% Ошибка: сначала войдите в привилегированный режим командой "enable" (или "en").');
      return { updatedNode: node, outputLines: output };
    }
    node.cli.mode = 'config';
    node.cli.selectedInterface = undefined;
    node.cli.selectedSubinterfaceVlan = undefined;
    node.cli.selectedSviVlan = undefined;
    output.push('Enter configuration commands, one per line. End with CNTL/Z or "end".');
    return { updatedNode: node, outputLines: output };
  }

  // Host IPCONFIG / DHCP DORA
  if (first === 'ipconfig' || first === 'ifconfig') {
    if (second === '/renew' || second === 'renew') {
      const dhcpRes = runDhcpDoraSimulation(allNodes, allLinks, node.id);
      const updatedSelf = dhcpRes.updatedNodes.find((n) => n.id === node.id) || node;
      updatedSelf.cli = node.cli;

      output.push('Windows / NetPulse IP Configuration — Запуск DHCP DORA (Discover → Offer → Request → Ack)...');
      if (dhcpRes.success && dhcpRes.assignedDhcpConfig) {
        const cfg = dhcpRes.assignedDhcpConfig;
        output.push(
          `Ethernet adapter Eth0:`,
          `   DHCP Server . . . . . . . . . . . : ${cfg.serverName}`,
          `   IPv4 Address. . . . . . . . . . . : ${cfg.ipAddress}`,
          `   Subnet Mask . . . . . . . . . . . : ${cfg.subnetMask}`,
          `   Default Gateway . . . . . . . . . : ${cfg.defaultGateway}`,
          `   DNS Server  . . . . . . . . . . . : ${cfg.dnsServer}`
        );
      } else {
        output.push(`% Ошибка DHCP: ${dhcpRes.summaryMessage}`);
      }
      return {
        updatedNode: updatedSelf,
        updatedAllNodes: dhcpRes.updatedNodes.map((n) =>
          n.id === updatedSelf.id ? { ...n, cli: updatedSelf.cli } : n
        ),
        outputLines: output,
        triggeredSimulationSteps: dhcpRes.steps,
        triggeredSummaryMessage: dhcpRes.summaryMessage,
      };
    }

    const iface = node.interfaces[0];
    output.push(
      `Host Configuration (${node.name}):`,
      `   IP Assignment Mode  . . . . . . . : ${(node.ipAssignmentMode || 'static').toUpperCase()}`,
      `   Physical Address (MAC). . . . . . : ${iface?.macAddress || 'N/A'}`,
      `   IPv4 Address. . . . . . . . . . . : ${iface?.ipAddress || '0.0.0.0'}`,
      `   Subnet Mask . . . . . . . . . . . : ${iface?.subnetMask || '0.0.0.0'}`,
      `   Default Gateway . . . . . . . . . : ${node.defaultGateway || 'Not set'}`,
      `   DNS Server  . . . . . . . . . . . : ${node.dnsServer || 'Not set'}`
    );
    return { updatedNode: node, outputLines: output };
  }

  // NSLOOKUP / CURL (DNS & HTTP L7)
  if (first === 'nslookup' || first === 'curl') {
    const target = tokens[1];
    if (!target) {
      output.push(`% Использование: ${first} <домен или URL> (напр. ${first} app.corp.local)`);
      return { updatedNode: node, outputLines: output };
    }

    const httpRes = runHttpBrowserSimulation(allNodes, allLinks, node.id, target);
    const updatedSelf = httpRes.updatedNodes.find((n) => n.id === node.id) || node;
    updatedSelf.cli = node.cli;

    if (httpRes.success && httpRes.httpResult) {
      output.push(
        `Server:  ${node.dnsServer || '192.168.2.100'}`,
        `Name:    ${target.replace(/^https?:\/\//i, '')}`,
        `Address: ${httpRes.httpResult.resolvedIp}`,
        `HTTP/1.1 ${httpRes.httpResult.statusCode} ${httpRes.httpResult.statusText} — "${httpRes.httpResult.title}"`,
        `${httpRes.httpResult.body}`
      );
    } else {
      output.push(`% ${httpRes.summaryMessage}`);
    }

    return {
      updatedNode: updatedSelf,
      updatedAllNodes: httpRes.updatedNodes.map((n) =>
        n.id === updatedSelf.id ? { ...n, cli: updatedSelf.cli } : n
      ),
      outputLines: output,
      triggeredSimulationSteps: httpRes.steps,
      triggeredSummaryMessage: httpRes.summaryMessage,
    };
  }

  // TRACEROUTE / TRACERT
  if (first === 'traceroute' || first === 'tracert') {
    const target = tokens[1];
    if (!target) {
      output.push('% Использование: traceroute <IPv4-адрес или домен>');
      return { updatedNode: node, outputLines: output };
    }

    const traceRes = runTracerouteSimulation(allNodes, allLinks, node.id, target);
    const updatedSelf = traceRes.updatedNodes.find((n) => n.id === node.id) || node;
    updatedSelf.cli = node.cli;

    output.push(`Tracing route to ${target} over a maximum of 6 hops:`);
    if (traceRes.tracerouteHops && traceRes.tracerouteHops.length > 0) {
      for (const hop of traceRes.tracerouteHops) {
        if (hop.status === 'TIMEOUT') {
          output.push(`  ${hop.hopNumber}     *        *        *     Request timed out.`);
        } else {
          const tag = hop.status === 'TIME_EXCEEDED' ? '[ICMP Time Exceeded, TTL=0]' : '[Reached Target]';
          output.push(
            `  ${hop.hopNumber}    ${hop.rttMs} ms    ${hop.rttMs} ms    ${hop.rttMs} ms  ${hop.responderName} [${hop.responderIp}] ${tag}`
          );
        }
      }
    }
    output.push(traceRes.success ? 'Trace complete.' : `% ${traceRes.summaryMessage}`);

    return {
      updatedNode: updatedSelf,
      updatedAllNodes: traceRes.updatedNodes.map((n) =>
        n.id === updatedSelf.id ? { ...n, cli: updatedSelf.cli } : n
      ),
      outputLines: output,
      triggeredSimulationSteps: traceRes.steps,
      triggeredSummaryMessage: traceRes.summaryMessage,
    };
  }

  // PING command
  if (first === 'ping') {
    const target = tokens[1];
    if (!target) {
      output.push('% Использование: ping <IPv4-адрес или домен>');
      return { updatedNode: node, outputLines: output };
    }

    const simResult = runPacketSimulation(allNodes, allLinks, node.id, target, 'ICMP');
    const updatedSelf = simResult.updatedNodes.find((n) => n.id === node.id) || node;
    updatedSelf.cli = node.cli;

    const isDomainTarget = !isValidIpv4(target) && !/^[0-9.]+$/.test(target);
    if (isDomainTarget) {
      output.push(`Translating "${target}"... domain server (${node.dnsServer || 'not set'})`);
      if (!simResult.resolvedIp) {
        output.push(`% ${simResult.summaryMessage}`);
        return {
          updatedNode: updatedSelf,
          updatedAllNodes: simResult.updatedNodes.map((n) =>
            n.id === updatedSelf.id ? { ...n, cli: updatedSelf.cli } : n
          ),
          outputLines: output,
          triggeredSimulationSteps: simResult.steps,
          triggeredSummaryMessage: simResult.summaryMessage,
        };
      }
      output.push(`[OK] Имя "${target}" разрешено через DNS в ${simResult.resolvedIp}`);
    } else if (!isValidIpv4(target)) {
      output.push(`% ${simResult.summaryMessage}`);
      return { updatedNode: node, outputLines: output };
    }

    const effectiveIp = simResult.resolvedIp || target;
    output.push(`Type escape sequence to abort.`);
    output.push(`Sending 5, 100-byte ICMP Echos to ${effectiveIp} (${target}), timeout is 2 seconds:`);
    if (simResult.success) {
      output.push('!!!!!');
      output.push(`Success rate is 100 percent (5/5), round-trip min/avg/max = 1/2/4 ms`);
      output.push(`[Симуляция]: Записано ${simResult.steps.length} шагов L2/L3.`);
    } else {
      output.push('.....');
      output.push(`Success rate is 0 percent (0/5)`);
      output.push(`[Причина отказа]: ${simResult.summaryMessage}`);
    }

    return {
      updatedNode: updatedSelf,
      updatedAllNodes: simResult.updatedNodes.map((n) =>
        n.id === updatedSelf.id ? { ...n, cli: updatedSelf.cli } : n
      ),
      outputLines: output,
      triggeredSimulationSteps: simResult.steps,
      triggeredSummaryMessage: simResult.summaryMessage,
    };
  }

  // Clear commands
  if (first === 'clear') {
    if (second.startsWith('arp')) {
      node.arpTable = [];
      output.push('[OK] ARP-кэш устройства очищен.');
      return { updatedNode: node, outputLines: output };
    }
    if (second.startsWith('mac')) {
      node.macTable = [];
      output.push('[OK] Таблица коммутации MAC-адресов очищена.');
      return { updatedNode: node, outputLines: output };
    }
    if (second === 'ip' && third.startsWith('nat')) {
      node.natTranslations = [];
      output.push('[OK] Таблица трансляций NAT/PAT очищена.');
      return { updatedNode: node, outputLines: output };
    }
  }

  // SHOW commands
  const isDoShow = first === 'do' && (second === 'show' || second === 'sh');
  if (first === 'show' || first === 'sh' || isDoShow) {
    const showTokens = isDoShow ? tokens.slice(2) : tokens.slice(1);
    const sub1 = showTokens[0]?.toLowerCase() || '';
    const sub2 = showTokens[1]?.toLowerCase() || '';
    const sub3 = showTokens[2]?.toLowerCase() || '';

    // show etherchannel summary
    if (sub1.startsWith('ether') || sub1.startsWith('eth') || sub1 === 'port-channel') {
      if (node.type !== 'switch') {
        output.push('% Агрегация каналов EtherChannel (IEEE 802.3ad LACP) поддерживается на коммутаторах.');
        return { updatedNode: node, outputLines: output };
      }
      const allBundles = getEtherChannelBundles(allNodes, allLinks);
      const myGroups = new Map<
        number,
        {
          mode: string;
          ports: { shortName: string; flag: 'P' | 'D' | 'I' }[];
          activeBundle?: ReturnType<typeof getEtherChannelBundles>[number];
        }
      >();

      for (const iface of node.interfaces) {
        if (!iface.channelGroup) continue;
        const g = iface.channelGroup;
        if (!myGroups.has(g)) {
          myGroups.set(g, {
            mode: (iface.channelMode || 'active') === 'on' ? 'NONE (Static ON)' : 'LACP',
            ports: [],
            activeBundle: allBundles.find(
              (b) =>
                b.channelGroup === g && (b.switchAId === node.id || b.switchBId === node.id)
            ),
          });
        }
        const entry = myGroups.get(g)!;
        const inActiveBundle = Boolean(
          entry.activeBundle?.memberPortIdsOnSwitch[node.id]?.includes(iface.id)
        );
        const flag: 'P' | 'D' | 'I' =
          iface.adminStatus !== 'up' ? 'D' : inActiveBundle ? 'P' : 'I';
        entry.ports.push({ shortName: iface.shortName, flag });
      }

      output.push(
        'Flags:  D - down        P - bundled in port-channel',
        '        I - stand-alone s - suspended',
        '        S - Layer2      U - in use',
        `Number of channel-groups in use: ${myGroups.size}`,
        '',
        'Group  Port-channel  Protocol        Ports',
        '------+-------------+---------------+-------------------------------------------'
      );

      if (myGroups.size === 0) {
        output.push('  (Агрегированные каналы Port-channel не настроены — используйте "channel-group 1 mode active" на интерфейсе)');
      } else {
        Array.from(myGroups.entries())
          .sort((a, b) => a[0] - b[0])
          .forEach(([groupNum, info]) => {
            const poStatus = info.activeBundle ? 'SU' : 'SD';
            const poName = `Po${groupNum}(${poStatus})`;
            const portsStr = info.ports.map((p) => `${p.shortName}(${p.flag})`).join(' ');
            const bwSuffix = info.activeBundle
              ? ` [${info.activeBundle.totalBandwidthMbps} Mbps, STP Cost ${info.activeBundle.stpCost}]`
              : '';
            output.push(
              `${String(groupNum).padEnd(6, ' ')} ${poName.padEnd(13, ' ')} ${info.mode.padEnd(
                15,
                ' '
              )} ${portsStr}${bwSuffix}`
            );
          });
      }
      return { updatedNode: node, outputLines: output };
    }

    // show spanning-tree
    if (sub1.startsWith('span') || sub1 === 'stp') {
      if (node.type !== 'switch') {
        output.push('% Протокол Spanning Tree (IEEE 802.1D) работает на коммутаторах L2.');
        return { updatedNode: node, outputLines: output };
      }
      const stpMap = computeSpanningTreeState(allNodes, allLinks);
      const st = stpMap[node.id];
      if (!st) {
        output.push('% Данные Spanning Tree недоступны.');
        return { updatedNode: node, outputLines: output };
      }
      output.push(
        'VLAN0001',
        '  Spanning tree enabled protocol ieee (802.1D)',
        `  Root ID    Priority    ${st.rootBridgeId.split('.')[0]}`,
        `             Address     ${st.rootBridgeId.split('.')[1] || st.bridgeMac}`,
        st.isRootBridge
          ? '             This bridge is the root'
          : `             Root Bridge ${st.rootBridgeName} (Cost ${st.rootPathCost}, Port ${st.rootPortName || 'N/A'})`,
        '',
        `  Bridge ID  Priority    ${st.bridgePriority}`,
        `             Address     ${st.bridgeMac}`,
        '',
        'Interface        Role Sts Cost      Prio.Nbr Type',
        '---------------- ---- --- --------- -------- --------------------------------'
      );
      node.interfaces.forEach((iface, idx) => {
        const pSt = st.ports[iface.id];
        if (!pSt || pSt.state === 'disabled') return;
        const roleStr =
          pSt.role === 'root'
            ? 'Root'
            : pSt.role === 'designated'
            ? 'Desg'
            : pSt.role === 'alternate'
            ? 'Altn'
            : 'Dis ';
        const stateStr = pSt.state === 'forwarding' ? 'FWD' : pSt.state === 'blocking' ? 'BLK' : 'DIS';
        const poTag = pSt.portChannelName
          ? ` [${pSt.portChannelName} ${pSt.aggregatedBandwidthMbps || 200}M]`
          : '';
        const peerLabel = pSt.peerNodeName
          ? `P2p (${pSt.peerNodeName}:${pSt.peerPortName})${poTag}`
          : 'Edge';
        output.push(
          `${iface.shortName.padEnd(16, ' ')} ${roleStr} ${stateStr} ${String(pSt.pathCost).padEnd(9, ' ')} 128.${String(
            idx + 1
          ).padEnd(4, ' ')} ${peerLabel}`
        );
      });
      return { updatedNode: node, outputLines: output };
    }

    // show nameif (Cisco ASA Security Zones & Levels)
    if (sub1 === 'nameif') {
      output.push(
        'Interface                Name                     Security',
        '-----------------------  -----------------------  --------'
      );
      for (const iface of node.interfaces) {
        const zInfo = getInterfaceSecurityZoneAndLevel(iface);
        output.push(
          `${iface.name.slice(0, 23).padEnd(23, ' ')}  ${zInfo.zone.padEnd(23, ' ')}  ${String(
            zInfo.level
          ).padStart(3, ' ')}`
        );
      }
      return { updatedNode: node, outputLines: output };
    }

    // show conn (Cisco ASA Stateful Packet Inspection table)
    if (sub1.startsWith('conn')) {
      const sessions = node.firewallConfig?.statefulSessions || [];
      output.push(
        `${sessions.length} in use, ${sessions.length} most used`,
        'Proto  Initiator (High Sec)       Responder (Low Sec)        Zones                  State',
        '-----  -------------------------  -------------------------  ---------------------  -----------'
      );
      if (sessions.length === 0) {
        output.push(
          '  (Таблица активных соединений SPI пуста — отправьте пакет из зоны Inside наружу или в DMZ)'
        );
      } else {
        for (const s of sessions) {
          const zonesCol = `${s.initiatorZone}(${s.initiatorLevel})->${s.responderZone}(${s.responderLevel})`;
          output.push(
            `${s.protocol.padEnd(5, ' ')}  ${`${s.initiatorIp}:${s.initiatorPort}`.padEnd(
              25,
              ' '
            )}  ${`${s.responderIp}:${s.responderPort}`.padEnd(25, ' ')}  ${zonesCol.padEnd(
              21,
              ' '
            )}  ${s.state}`
          );
        }
      }
      return { updatedNode: node, outputLines: output };
    }

    // show crypto ipsec sa (Cisco ASA / IOS Site-to-Site IPsec VPN)
    if (sub1 === 'crypto' || sub1 === 'ipsec' || sub1 === 'vpn') {
      const tunnels = node.firewallConfig?.ipsecTunnels || [];
      if (tunnels.length === 0) {
        output.push('% На устройстве не настроены криптотуннели Site-to-Site IPsec VPN.');
      } else {
        for (const t of tunnels) {
          output.push(
            `interface: ${t.localInterface} (${t.tunnelName})`,
            `    Crypto map tag: ${t.tunnelName}, seq num: 10, local addr: ${t.localPublicIp}`,
            `    access-list VPN_ACL extended permit ip ${t.localSubnet} ${t.remoteSubnet}`,
            `    current_peer: ${t.peerPublicIp} (${t.ikeVersion}, Status: ${
              t.enabled ? t.status : 'DOWN'
            })`,
            `    #pkts encaps: ${t.packetsEncrypted}, #pkts encrypt: ${t.packetsEncrypted}, #pkts decaps: ${t.packetsDecrypted}, #pkts decrypt: ${t.packetsDecrypted}`,
            `    transform-set: ${t.cryptoSuite}`
          );
        }
      }
      return { updatedNode: node, outputLines: output };
    }

    // show power inline (IEEE 802.3af/at PoE status on Switches)
    if (sub1.startsWith('power') || sub1 === 'poe') {
      if (node.type !== 'switch') {
        output.push('% Команда "show power inline" поддерживается на коммутаторах с поддержкой PoE 802.3af/at.');
        return { updatedNode: node, outputLines: output };
      }
      const poe = computeSwitchPoeStatus(node, allNodes, allLinks);
      output.push(
        `Available: ${poe.totalBudgetWatts.toFixed(1)}(w)  Used: ${poe.usedWatts.toFixed(1)}(w)  Remaining: ${poe.remainingWatts.toFixed(1)}(w)  [${poe.standard}]`,
        '',
        'Interface   Admin  Oper       Power   Device                  Class              Max',
        '                              (Watts)                                            ',
        '---------   -----  ---------  ------  ----------------------  -----------------  ----'
      );
      for (const p of poe.portList) {
        const operStr =
          p.operStatus === 'delivering'
            ? 'on'
            : p.operStatus === 'fault_overload'
            ? 'fault(ovl)'
            : 'off';
        const devStr = p.pdNodeName
          ? `${p.pdNodeName} (${p.pdDeviceTypeLabel || 'PD'})`.slice(0, 32)
          : 'n/a';
        output.push(
          `${p.portShortName.padEnd(10, ' ')}  ${p.adminMode.padEnd(5, ' ')}  ${operStr.padEnd(
            9,
            ' '
          )}  ${p.allocatedWatts.toFixed(1).padEnd(6, ' ')}  ${devStr.padEnd(
            32,
            ' '
          )}  ${p.poeClass.padEnd(17, ' ')}  ${p.maxPortWatts.toFixed(1)}`
        );
      }
      return { updatedNode: node, outputLines: output };
    }

    // show voip sip / show ephone / show sip
    if (sub1 === 'voip' || sub1 === 'ephone' || sub1 === 'sip') {
      const phones = getVoipDirectory(allNodes, allLinks);
      output.push(
        'Cisco Unified Communications / SIP Registrar Directory (UDP 5060):',
        'Ext   Device Name     IPv4 Address     Voice VLAN  Data VLAN  PoE Power       Status',
        '----  --------------  ---------------  ----------  ---------  --------------  ----------'
      );
      if (phones.length === 0) {
        output.push('  (В топологии нет IP-телефонов VoIP)');
      } else {
        for (const ph of phones) {
          output.push(
            `${ph.extension.padEnd(4, ' ')}  ${ph.nodeName.padEnd(14, ' ')}  ${(
              ph.ipAddress || 'unassigned'
            ).padEnd(15, ' ')}  VLAN ${String(ph.voiceVlan).padEnd(5, ' ')}  VLAN ${String(
              ph.dataVlan
            ).padEnd(4, ' ')}  ${`${ph.poeWatts.toFixed(1)}W 802.3af`.padEnd(14, ' ')}  ${
              ph.isPowered ? 'REGISTERED' : 'POWER OFF'
            }`
          );
        }
      }
      return { updatedNode: node, outputLines: output };
    }

    // show cctv / show camera / show rtsp / show nvr
    if (sub1 === 'cctv' || sub1 === 'camera' || sub1 === 'rtsp' || sub1 === 'nvr') {
      const cameras = getIpCameraDirectory(allNodes, allLinks);
      output.push(
        'NetPulse CCTV / RTSP Video Surveillance Directory (TCP 554 / RTP UDP 5004):',
        'Device Name     IPv4 Address     VLAN     Codec / Res             Mode / NVR Target           PoE Power       Status',
        '--------------  ---------------  -------  ----------------------  --------------------------  --------------  ----------'
      );
      if (cameras.length === 0) {
        output.push('  (В топологии нет IP-камер видеонаблюдения)');
      } else {
        for (const cam of cameras) {
          const codecRes = `${cam.codec.split(' ')[0]} ${cam.resolution.split(' ')[0]}`;
          const targetCol =
            cam.streamMode === 'multicast'
              ? `Mcast ${cam.multicastGroupIp}`
              : `Unicast ${cam.nvrTargetIp}`;
          output.push(
            `${cam.nodeName.padEnd(14, ' ')}  ${(cam.ipAddress || 'unassigned').padEnd(
              15,
              ' '
            )}  VLAN ${String(cam.surveillanceVlan).padEnd(2, ' ')}  ${codecRes.padEnd(
              22,
              ' '
            )}  ${targetCol.padEnd(26, ' ')}  ${`${cam.poeWatts.toFixed(1)}W 802.3af`.padEnd(
              14,
              ' '
            )}  ${cam.isPowered ? 'STREAMING' : 'POWER OFF'}`
          );
        }
      }
      return { updatedNode: node, outputLines: output };
    }

    // show ip nat translations / show nat
    if ((sub1 === 'ip' && sub2.startsWith('nat')) || sub1 === 'nat') {
      const portForwards = node.firewallConfig?.portForwards || [];
      if (portForwards.length > 0) {
        output.push(
          'Static NAT / Port Forwarding Policies (Section 1):',
          'Rule Name             Ext Interface   Public IP:Port          Internal DMZ IP:Port    Hits',
          '--------------------  --------------  ----------------------  ----------------------  ----'
        );
        for (const pf of portForwards) {
          output.push(
            `${pf.name.padEnd(20, ' ')}  ${pf.externalInterface.padEnd(14, ' ')}  ${`${pf.externalIp}:${pf.externalPort}`.padEnd(
              22,
              ' '
            )}  ${`${pf.internalIp}:${pf.internalPort}`.padEnd(22, ' ')}  ${pf.hitCount}`
          );
        }
        output.push('');
      }
      output.push(
        'Pro  Inside global         Inside local          Outside local         Outside global',
        '---  --------------------  --------------------  --------------------  --------------------'
      );
      const entries = node.natTranslations || [];
      if (entries.length === 0) {
        output.push('  (Таблица трансляций NAT пуста — отправьте трафик из сети Inside в Outside)');
      } else {
        for (const e of entries) {
          output.push(
            `${e.protocol.padEnd(4, ' ')} ${e.insideGlobal.padEnd(20, ' ')}  ${e.insideLocal.padEnd(
              20,
              ' '
            )}  ${e.outsideLocal.padEnd(20, ' ')}  ${e.outsideGlobal}`
          );
        }
      }
      return { updatedNode: node, outputLines: output };
    }

    // show access-lists / show ip access-lists
    if (
      sub1.startsWith('access') ||
      sub1 === 'acl' ||
      (sub1 === 'ip' && sub2.startsWith('access'))
    ) {
      const rules = (node.aclRules || []).slice().sort((a, b) => a.seq - b.seq);
      if (rules.length === 0) {
        output.push('Extended IP access list 100: (правила фильтрации не заданы — весь трафик разрешён)');
      } else {
        output.push(`Extended IP access list 100 (${rules.length} rules):`);
        for (const r of rules) {
          const portSuffix = r.dstPort ? ` eq ${r.dstPort}` : '';
          const statusPrefix = r.enabled === false ? '[DISABLED] ' : '';
          const hits = r.hitCount ? ` (${r.hitCount} matches)` : '';
          output.push(
            `    ${r.seq} ${statusPrefix}${r.action} ${r.protocol.toLowerCase()} ${r.srcIp} ${r.dstIp}${portSuffix}${hits}`
          );
        }
      }
      return { updatedNode: node, outputLines: output };
    }

    if (sub1 === 'ip' && sub2.startsWith('dhcp')) {
      output.push(
        'IP Address       Client-ID/Hardware Addr   Lease Expiration  Type       Pool',
        '---------------  ------------------------  ----------------  ---------  ---------------'
      );
      const leases = node.services?.dhcpLeases || [];
      if (leases.length === 0) {
        output.push('  (Нет активных аренд DHCP — запустите DHCP DORA с клиентского ПК)');
      } else {
        for (const l of leases) {
          output.push(
            `${l.ipAddress.padEnd(15, ' ')}  ${l.macAddress.padEnd(24, ' ')}  86400s (Active)   Automatic  ${l.poolName}`
          );
        }
      }
      return { updatedNode: node, outputLines: output };
    }

    if (sub1 === 'ip' && (sub2.startsWith('int') || sub2.startsWith('br') || sub3.startsWith('b'))) {
      output.push(
        'Interface    IP-Address       Mask             Status   VLAN / Role',
        '-----------  ---------------  ---------------  -------  --------------------'
      );
      for (const iface of node.interfaces) {
        const nameCol = iface.shortName.padEnd(11, ' ');
        const ipCol = (iface.ipAddress || 'unassigned').padEnd(15, ' ');
        const maskCol = (iface.subnetMask || 'unassigned').padEnd(15, ' ');
        const statusCol = (iface.adminStatus === 'up' ? 'up' : 'down').padEnd(7, ' ');
        const natTag =
          iface.natRole && iface.natRole !== 'none' ? ` [NAT ${iface.natRole}]` : '';
        const helperTag = iface.helperAddress ? ` [Helper ${iface.helperAddress}]` : '';
        const poTag = iface.channelGroup
          ? ` [Po${iface.channelGroup} ${iface.channelMode || 'active'}]`
          : '';
        const vlanCol =
          iface.vlanMode === 'trunk'
            ? `trunk(${iface.trunkAllowedVlans.join(',')})${poTag}${natTag}${helperTag}`
            : `vlan ${iface.accessVlan}${poTag}${natTag}${helperTag}`;
        output.push(`${nameCol}  ${ipCol}  ${maskCol}  ${statusCol}  ${vlanCol}`);

        if (Array.isArray(iface.subinterfaces)) {
          for (const sub of iface.subinterfaces) {
            const subName = `${iface.shortName}.${sub.vlanId}`.padEnd(11, ' ');
            const subIp = (sub.ipAddress || 'unassigned').padEnd(15, ' ');
            const subMask = (sub.subnetMask || 'unassigned').padEnd(15, ' ');
            const subNat =
              sub.natRole && sub.natRole !== 'none' ? ` [NAT ${sub.natRole}]` : '';
            const subHelper = sub.helperAddress ? ` [Helper ${sub.helperAddress}]` : '';
            output.push(
              `${subName}  ${subIp}  ${subMask}  ${statusCol}  dot1Q vlan ${sub.vlanId}${subNat}${subHelper}`
            );
          }
        }
      }

      if (node.type === 'switch' && Array.isArray(node.sviInterfaces)) {
        for (const svi of node.sviInterfaces) {
          const sviName = `Vlan${svi.vlanId}`.padEnd(11, ' ');
          const sviIp = (svi.ipAddress || 'unassigned').padEnd(15, ' ');
          const sviMask = (svi.subnetMask || 'unassigned').padEnd(15, ' ');
          const lineUp =
            svi.adminStatus === 'up' && isSwitchSviLineProtocolUp(node, svi.vlanId, allNodes, allLinks);
          const sviStatus = (svi.adminStatus === 'up' ? (lineUp ? 'up' : 'up/down') : 'down').padEnd(
            7,
            ' '
          );
          const helperTag = svi.helperAddress ? ` [Helper ${svi.helperAddress}]` : '';
          const l3Tag = node.ipRoutingEnabled ? ' [L3 SVI Gateway]' : ' [Mgmt SVI]';
          output.push(
            `${sviName}  ${sviIp}  ${sviMask}  ${sviStatus}  SVI vlan ${svi.vlanId}${l3Tag}${helperTag}`
          );
        }
      }

      return { updatedNode: node, outputLines: output };
    }

    // show ip ospf neighbor / show ip ospf interface
    if (sub1 === 'ip' && sub2 === 'ospf') {
      if (node.type !== 'router') {
        output.push('% Протокол OSPFv2 работает только на маршрутизаторах L3.');
        return { updatedNode: node, outputLines: output };
      }
      if (sub3.startsWith('int')) {
        const ospfCfg = node.ospfConfig || getDefaultOspfConfig(node);
        const rid = electOspfRouterId(node);
        for (const iface of node.interfaces) {
          if (!iface.ipAddress) continue;
          const bw = getInterfaceBandwidthMbps(iface);
          const cost = calculateOspfInterfaceCost(iface);
          const passive = (ospfCfg.passiveInterfaces || []).includes(iface.shortName);
          output.push(
            `${iface.name} is ${iface.adminStatus === 'up' ? 'up, line protocol is up' : 'administratively down'}`,
            `  Internet Address ${iface.ipAddress}/${maskToCidr(iface.subnetMask)}, Area 0`,
            `  Process ID ${ospfCfg.processId}, Router ID ${rid}, Network Type POINT_TO_POINT, Cost: ${cost} (${bw} Mbps)`,
            `  Timer intervals configured, Hello 10, Dead 40, Wait 40, Retransmit 5`,
            passive
              ? `  No Hellos (Passive interface)`
              : `  Hello due in 00:00:07, Neighbor count is 1`
          );
        }
        return { updatedNode: node, outputLines: output };
      }

      const neighbors = computeOspfNeighborsForRouter(node, allNodes, allLinks);
      output.push(
        'Neighbor ID     Pri   State           Dead Time   Address         Interface    Cost',
        '--------------- ----- --------------- ----------- --------------- ------------ ------'
      );
      if (!node.ospfConfig?.enabled) {
        output.push('  % OSPF process is not enabled on this router (use "router ospf 1" in config mode)');
      } else if (neighbors.length === 0) {
        output.push('  (Соседи OSPF не обнаружены — проверьте "network <ip> <wildcard> area 0" на обоих маршрутизаторах)');
      } else {
        for (const nb of neighbors) {
          output.push(
            `${nb.neighborRouterId.padEnd(15, ' ')} ${String(nb.priority).padEnd(
              5,
              ' '
            )} ${nb.state.padEnd(15, ' ')} ${nb.deadTime.padEnd(11, ' ')} ${nb.neighborIp.padEnd(
              15,
              ' '
            )} ${nb.localInterface.padEnd(12, ' ')} ${nb.interfaceCost}`
          );
        }
      }
      return { updatedNode: node, outputLines: output };
    }

    // show ip protocols
    if (sub1 === 'ip' && sub2.startsWith('prot')) {
      if (node.type !== 'router') {
        output.push('% Маршрутизирующие протоколы L3 активны только на маршрутизаторах.');
        return { updatedNode: node, outputLines: output };
      }
      const ospfCfg = node.ospfConfig;
      if (!ospfCfg || (!ospfCfg.enabled && !ospfCfg.ripEnabled)) {
        output.push('*** IP Routing is NSF aware ***', '  (Ни один протокол динамической маршрутизации OSPF/RIP не включён)');
        return { updatedNode: node, outputLines: output };
      }
      if (ospfCfg.enabled) {
        const rid = electOspfRouterId(node);
        output.push(
          `Routing Protocol is "ospf ${ospfCfg.processId}"`,
          `  Outgoing update filter list for all interfaces is not set`,
          `  Incoming update filter list for all interfaces is not set`,
          `  Router ID ${rid}`,
          `  Number of areas in this router is 1. 1 normal 0 stub 0 nssa`,
          `  Routing for Networks:`
        );
        for (const net of ospfCfg.networks) {
          output.push(`    ${net.network} ${net.wildcard} area ${net.area}`);
        }
        if ((ospfCfg.passiveInterfaces || []).length > 0) {
          output.push(`  Passive Interface(s):`);
          for (const pIf of ospfCfg.passiveInterfaces) {
            output.push(`    ${pIf}`);
          }
        }
        output.push(`  Distance: (default is 110)`);
      }
      if (ospfCfg.ripEnabled) {
        output.push(
          `Routing Protocol is "rip"`,
          `  Sending updates every 30 seconds, Hold down 180, flushed after 240`,
          `  Default version control: send version 2, receive version 2`,
          `  Distance: (default is 120)`
        );
      }
      return { updatedNode: node, outputLines: output };
    }

    // show wan / show impairment (WAN Link Impairment Emulator status)
    if (sub1 === 'wan' || sub1.startsWith('impair')) {
      const wanCfg = node.wanImpairment;
      output.push(
        `NetPulse WAN Link Impairment Emulator (${node.name}):`,
        'Parameter                Value                         Status',
        '-----------------------  ----------------------------  ----------------'
      );
      if (!wanCfg || !wanCfg.enabled) {
        output.push(
          `WAN Impairment Engine    0 ms / 0% Loss / Unlimited    BYPASS (Ideal Link)`
        );
      } else {
        output.push(
          `Profile Name             ${(wanCfg.profileName || 'Custom WAN Link').padEnd(28, ' ')}  ACTIVE`,
          `Propagation Latency      ${`${wanCfg.latencyMs} ms`.padEnd(28, ' ')}  +${wanCfg.latencyMs}ms per hop`,
          `Delay Jitter             ${`±${wanCfg.jitterMs} ms`.padEnd(28, ' ')}  RFC 3393 Jitter`,
          `Packet Loss Rate         ${`${wanCfg.packetLossPercent}%`.padEnd(28, ' ')}  ${
            wanCfg.packetLossPercent >= 50 ? 'CRITICAL DROP (>=50%)' : wanCfg.packetLossPercent > 0 ? 'DEGRADED' : '0% Loss'
          }`,
          `Bandwidth Policing       ${`${wanCfg.bandwidthLimitMbps} Mbps`.padEnd(28, ' ')}  ${
            wanCfg.bandwidthLimitMbps <= 0 ? 'THROTTLED (0 Mbps)' : 'Token Bucket QoS'
          }`
        );
      }
      return { updatedNode: node, outputLines: output };
    }

    // show ip bgp summary / show ip bgp / show bgp
    if ((sub1 === 'ip' && sub2 === 'bgp') || sub1 === 'bgp') {
      const bgpArg = sub1 === 'bgp' ? sub2 : sub3;
      const bgpCfg = node.bgpConfig;
      if (!bgpCfg || !bgpCfg.enabled) {
        output.push('% BGP not active on this router (enable eBGP in Router GUI or configure ASN)');
        return { updatedNode: node, outputLines: output };
      }
      const rid = resolveBgpRouterId(node);
      const peers = discoverBgpPeersForRouter(node, allNodes, allLinks);

      if (bgpArg.startsWith('sum')) {
        output.push(
          `BGP router identifier ${rid}, local AS number ${bgpCfg.asn}`,
          `BGP table version is 4, main routing table version 4`,
          '',
          'Neighbor        V           AS MsgRcvd MsgSent   TblVer  InQ OutQ Up/Down  State/PfxRcd',
          '--------------- - ------------ ------- ------- -------- ---- ---- -------- --------------'
        );
        if (peers.length === 0) {
          output.push('  (Соседи eBGP не настроены)');
        } else {
          for (const p of peers) {
            const stateCol =
              p.state === 'Established' ? String(p.prefixesReceived) : p.state;
            const wanTag = p.wanImpairment?.enabled
              ? ` [${formatWanImpairmentSummary(p.wanImpairment)}]`
              : '';
            output.push(
              `${p.neighborIp.padEnd(15, ' ')} 4 ${String(p.remoteAs).padStart(
                12,
                ' '
              )}      18      18        4    0    0 00:14:22 ${stateCol}${wanTag}`
            );
          }
        }
        return { updatedNode: node, outputLines: output };
      }

      const bgpComp = computeBgpRoutesForRouter(node, allNodes, allLinks);
      output.push(
        `BGP table version is 4, local router ID is ${rid}, Local AS ${bgpCfg.asn}`,
        'Status codes: s suppressed, d damped, h history, * valid, > best, i - internal',
        'Origin codes: i - IGP, e - EGP, ? - incomplete',
        '',
        '   Network          Next Hop            Metric LocPrf Weight Path'
      );
      if (bgpComp.allCandidateBgpRoutes.length === 0) {
        output.push('   (В таблице BGP нет полученных маршрутов от соседей eBGP)');
      } else {
        for (const r of bgpComp.allCandidateBgpRoutes) {
          const code = r.bgpBestPath ? '*>' : '* ';
          const prefixStr = `${r.network}/${maskToCidr(r.mask)}`.padEnd(16, ' ');
          const nhStr = r.nextHop.padEnd(19, ' ');
          const metricStr = String(r.metric ?? 0).padStart(6, ' ');
          const lpStr = String(r.bgpLocalPref ?? 100).padStart(6, ' ');
          const wtStr = String(r.bgpWeight ?? 100).padStart(6, ' ');
          const pathStr = `${(r.bgpAsPath || []).join(' ')} ${r.bgpOrigin || 'i'}`.trim();
          output.push(`${code} ${prefixStr} ${nhStr} ${metricStr} ${lpStr} ${wtStr} ${pathStr}`);
        }
      }
      return { updatedNode: node, outputLines: output };
    }

    if (sub1 === 'ip' && sub2.startsWith('ro')) {
      const nodesForSync = allNodes.map((n) => (n.id === node.id ? node : n));
      const allRoutes = syncConnectedRoutes(node, nodesForSync, allLinks);
      const filterOspfOnly = sub3 === 'ospf';
      const filterRipOnly = sub3 === 'rip';
      const filterBgpOnly = sub3 === 'bgp';
      const routes = filterOspfOnly
        ? allRoutes.filter((r) => r.type === 'O')
        : filterRipOnly
        ? allRoutes.filter((r) => r.type === 'R')
        : filterBgpOnly
        ? allRoutes.filter((r) => r.type === 'B')
        : allRoutes;

      output.push(
        'Codes: C - connected, S - static, B - eBGP (AD 20), O - OSPF (AD 110), R - RIPv2 (AD 120)',
        node.defaultGateway ? `Default Gateway is ${node.defaultGateway}` : 'Gateway of last resort is not set',
        ''
      );
      if (routes.length === 0) {
        output.push('  (Таблица маршрутизации пуста)');
      } else {
        for (const r of routes) {
          if (r.type === 'C') {
            output.push(
              `C    ${r.network}/${r.mask} is directly connected, ${r.interfaceName}`
            );
          } else if (r.type === 'S') {
            output.push(
              `S    ${r.network}/${r.mask} [1/0] via ${r.nextHop}, ${r.interfaceName}`
            );
          } else if (r.type === 'B') {
            const ad = r.administrativeDistance ?? 20;
            const med = r.metric ?? 0;
            const asPathStr = r.bgpAsPath?.length ? ` [AS_PATH: ${r.bgpAsPath.join(' ')}]` : '';
            output.push(
              `B    ${r.network}/${r.mask} [${ad}/${med}] via ${r.nextHop}, 00:04:15, ${r.interfaceName}${asPathStr}`
            );
          } else if (r.type === 'O') {
            const ad = r.administrativeDistance ?? 110;
            const cost = r.metric ?? 1;
            const areaTag = r.ospfArea !== undefined ? `, Area ${r.ospfArea}` : '';
            output.push(
              `O    ${r.network}/${r.mask} [${ad}/${cost}] via ${r.nextHop}, 00:01:12, ${r.interfaceName}${areaTag}`
            );
          } else if (r.type === 'R') {
            const ad = r.administrativeDistance ?? 120;
            const hops = r.metric ?? 1;
            output.push(
              `R    ${r.network}/${r.mask} [${ad}/${hops}] via ${r.nextHop}, 00:00:18, ${r.interfaceName}`
            );
          }
        }
      }
      return { updatedNode: node, outputLines: output };
    }

    if (sub1 === 'arp' || (sub1 === 'ip' && sub2 === 'arp')) {
      output.push(
        'Protocol  Address          Hardware Addr      Type   Interface',
        '--------  ---------------  -----------------  -----  ---------'
      );
      if (node.arpTable.length === 0) {
        output.push('  (ARP-кэш пуст — выполните ping для динамического разрешения адресов)');
      } else {
        for (const a of node.arpTable) {
          output.push(
            `Internet  ${a.ipAddress.padEnd(15, ' ')}  ${a.macAddress}  ARPA   ${a.interfaceName}`
          );
        }
      }
      return { updatedNode: node, outputLines: output };
    }

    if (sub1.startsWith('mac')) {
      output.push(
        '          Mac Address Table (CAM)',
        '-------------------------------------------',
        'Vlan    Mac Address         Type        Ports',
        '----    -----------------   --------    -----'
      );
      if (node.macTable.length === 0) {
        output.push('  (Таблица MAC-адресов пуста)');
      } else {
        for (const m of node.macTable) {
          output.push(
            `${String(m.vlan).padEnd(6, ' ')}  ${m.macAddress}   ${m.type.padEnd(10, ' ')}  ${m.portName}`
          );
        }
      }
      return { updatedNode: node, outputLines: output };
    }

    if (sub1.startsWith('vlan')) {
      output.push(
        'VLAN Name                             Status    Ports',
        '---- -------------------------------- --------- -------------------------------'
      );
      const db = getDeviceVlanDatabase(node);
      const vlanMap = new Map<number, string[]>();
      for (const entry of db) {
        vlanMap.set(entry.id, []);
      }
      for (const iface of node.interfaces) {
        if (iface.vlanMode === 'access') {
          const v = iface.accessVlan || 1;
          if (!vlanMap.has(v)) vlanMap.set(v, []);
          vlanMap.get(v)!.push(iface.shortName);
        } else {
          for (const v of iface.trunkAllowedVlans) {
            if (!vlanMap.has(v)) vlanMap.set(v, []);
            vlanMap.get(v)!.push(`${iface.shortName}(T)`);
          }
        }
      }
      Array.from(vlanMap.entries())
        .sort((a, b) => a[0] - b[0])
        .forEach(([vlanId, ports]) => {
          const vName =
            db.find((e) => e.id === vlanId)?.name ||
            (vlanId === 1 ? 'default' : `VLAN${String(vlanId).padStart(4, '0')}`);
          output.push(
            `${String(vlanId).padEnd(4, ' ')} ${vName.padEnd(32, ' ')} active    ${ports.join(', ')}`
          );
        });
      return { updatedNode: node, outputLines: output };
    }

    if (sub1.startsWith('run')) {
      output.push(
        'Building configuration...',
        'Current configuration:',
        '!',
        `hostname ${node.name}`,
        '!'
      );
      if (node.type === 'switch') {
        if (node.ipRoutingEnabled) {
          output.push('ip routing', '!');
        }
        output.push(`spanning-tree mode ieee`, `spanning-tree vlan 1 priority ${node.stpPriority ?? 32768}`, '!');
      }
      if (node.services?.dhcpEnabled && node.services.dhcpPools.length > 0) {
        for (const pool of node.services.dhcpPools) {
          output.push(
            `ip dhcp pool ${pool.poolName}`,
            ` network ${pool.network} ${pool.mask}`,
            ` default-router ${pool.defaultRouter}`,
            ` dns-server ${pool.dnsServer}`,
            '!'
          );
        }
      }
      for (const iface of node.interfaces) {
        output.push(`interface ${iface.name}`);
        if (iface.ipAddress) {
          output.push(` ip address ${iface.ipAddress} ${iface.subnetMask}`);
        } else {
          output.push(` no ip address`);
        }
        if (iface.helperAddress) {
          output.push(` ip helper-address ${iface.helperAddress}`);
        }
        if (iface.natRole && iface.natRole !== 'none') {
          output.push(` ip nat ${iface.natRole}`);
        }
        if (iface.ospfCost !== undefined && iface.ospfCost > 0) {
          output.push(` ip ospf cost ${iface.ospfCost}`);
        }
        if (node.type === 'switch') {
          output.push(` switchport mode ${iface.vlanMode}`);
          if (iface.vlanMode === 'access') {
            output.push(` switchport access vlan ${iface.accessVlan}`);
          } else {
            output.push(` switchport trunk allowed vlan ${iface.trunkAllowedVlans.join(',')}`);
          }
          if (iface.channelGroup) {
            output.push(` channel-group ${iface.channelGroup} mode ${iface.channelMode || 'active'}`);
          }
        }
        output.push(iface.adminStatus === 'up' ? ` no shutdown` : ` shutdown`);
        output.push('!');

        if (Array.isArray(iface.subinterfaces)) {
          for (const sub of iface.subinterfaces) {
            output.push(
              `interface ${iface.name}.${sub.vlanId}`,
              ` encapsulation dot1Q ${sub.vlanId}`,
              ` ip address ${sub.ipAddress} ${sub.subnetMask}`
            );
            if (sub.helperAddress) {
              output.push(` ip helper-address ${sub.helperAddress}`);
            }
            if (sub.natRole && sub.natRole !== 'none') {
              output.push(` ip nat ${sub.natRole}`);
            }
            output.push('!');
          }
        }
      }
      if (node.type === 'switch' && Array.isArray(node.sviInterfaces)) {
        for (const svi of node.sviInterfaces) {
          output.push(
            `interface Vlan${svi.vlanId}`,
            svi.ipAddress ? ` ip address ${svi.ipAddress} ${svi.subnetMask}` : ` no ip address`
          );
          if (svi.helperAddress) {
            output.push(` ip helper-address ${svi.helperAddress}`);
          }
          output.push(svi.adminStatus === 'up' ? ` no shutdown` : ` shutdown`, '!');
        }
      }
      if (node.ospfConfig?.enabled) {
        output.push(`router ospf ${node.ospfConfig.processId}`);
        if (node.ospfConfig.routerId) {
          output.push(` router-id ${node.ospfConfig.routerId}`);
        }
        for (const pIf of node.ospfConfig.passiveInterfaces || []) {
          output.push(` passive-interface ${pIf}`);
        }
        for (const net of node.ospfConfig.networks) {
          output.push(` network ${net.network} ${net.wildcard} area ${net.area}`);
        }
        output.push('!');
      }
      if (node.ospfConfig?.ripEnabled) {
        output.push(`router rip`, ` version 2`, ` no auto-summary`, '!');
      }
      if (node.aclRules && node.aclRules.length > 0) {
        for (const r of node.aclRules) {
          output.push(
            `access-list 100 ${r.action} ${r.protocol.toLowerCase()} ${r.srcIp} ${r.dstIp}${
              r.dstPort ? ` eq ${r.dstPort}` : ''
            }`
          );
        }
        output.push('!');
      }
      if (node.defaultGateway) {
        output.push(`ip default-gateway ${node.defaultGateway}`);
      }
      for (const r of node.routingTable.filter((rt) => rt.type === 'S')) {
        output.push(`ip route ${r.network} ${r.mask} ${r.nextHop}`);
      }
      output.push('end');
      return { updatedNode: node, outputLines: output };
    }

    if (sub1 === 'switch' || sub1 === 'stack') {
      const stackInfo = getNodeStackStatus(node.id, allNodes, allLinks);
      const groups = getStackGroups(allNodes, allLinks);
      const group = stackInfo?.group || groups.find((g) => g.deviceType === node.type);

      if (!group) {
        output.push(
          `Switch/Router ${node.name} is operating in Standalone mode (StackWise / VSS disabled).`,
          'Используйте Стек-кабель (StackWise / HA), вкладку «Стек» в Web GUI или команду "stack-group STACK-1" в режиме config.'
        );
        return { updatedNode: node, outputLines: output };
      }

      output.push(
        `Stack/Cluster ID : ${group.stackId} (${group.protocol} · Backplane ${group.backplaneSpeedGbps} Gbps)`,
        `Stack Virtual MAC: ${group.virtualMac}${group.virtualIp ? ` · Virtual IP (VIP): ${group.virtualIp}` : ''}`,
        `                                           H/W   Current`,
        `Switch#   Role        Mac Address        Priority Version  State       Node Name`,
        `-------------------------------------------------------------------------------------`
      );
      for (const m of group.members) {
        const star = m.role === 'master' ? '*' : ' ';
        const roleLabel =
          m.role === 'master' ? 'Master' : m.role === 'standby' ? 'Standby' : 'Member';
        output.push(
          `${star}${String(m.memberNumber).padEnd(8, ' ')} ${roleLabel.padEnd(11, ' ')} ${m.macAddress}   ${String(
            m.priority
          ).padEnd(8, ' ')} V04      ${m.state.padEnd(11, ' ')} ${m.nodeName}`
        );
      }
      return { updatedNode: node, outputLines: output };
    }

    if (sub1 === 'standby' || sub1 === 'hsrp' || sub1 === 'vrrp') {
      const stackInfo = getNodeStackStatus(node.id, allNodes, allLinks);
      if (!stackInfo) {
        output.push(
          `% HSRP / Router Stack не настроен на ${node.name}.`,
          'Используйте команду "standby 1 ip <VIP>" в режиме config-if или вкладку «Стек / HA» в GUI роутера.'
        );
        return { updatedNode: node, outputLines: output };
      }
      const { group, member } = stackInfo;
      const lanPort =
        node.interfaces.find((i) => isValidIpv4(i.ipAddress))?.shortName ||
        node.interfaces[0]?.shortName ||
        'Gi0/0';
      output.push(
        `                     P indicates configured to preempt.`,
        `                     |`,
        `Interface   Grp  Pri P State    Active          Standby         Virtual IP      Virtual MAC`,
        `---------------------------------------------------------------------------------------------------`,
        `${lanPort.padEnd(11, ' ')} ${String(group.domainId).padEnd(4, ' ')} ${String(
          member.priority
        ).padEnd(3, ' ')} P ${member.state.padEnd(8, ' ')} ${(
          group.masterNodeName || 'local'
        ).padEnd(15, ' ')} ${(group.standbyNodeName || 'unknown').padEnd(15, ' ')} ${(
          group.virtualIp || 'unassigned'
        ).padEnd(15, ' ')} ${group.virtualMac}`
      );
      return { updatedNode: node, outputLines: output };
    }

    output.push(
      '% Неизвестная команда show. Попробуйте: sh ip int b, sh switch, sh standby, sh etherchannel summary, sh ip ospf neighbor, sh ip route, sh span, sh ip nat tr, sh access-lists, sh arp, sh mac, sh run'
    );
    return { updatedNode: node, outputLines: output };
  }

  // Configuration mode commands
  if (node.cli.mode === 'config' || node.cli.mode === 'config-if') {
    if ((first === 'hostname' || first === 'host') && tokens[1]) {
      node.name = tokens[1];
      return { updatedNode: node, outputLines: output };
    }

    // L3 Switch IP Routing: ip routing / no ip routing
    if (first === 'ip' && second === 'routing') {
      if (node.type === 'switch') {
        node.ipRoutingEnabled = true;
        node.routingTable = syncConnectedRoutes(node, allNodes, allLinks);
        const updatedAll = syncAllRoutersRoutingTables(
          allNodes.map((n) => (n.id === node.id ? node : n)),
          allLinks
        );
        const updatedSelf = updatedAll.find((n) => n.id === node.id) || node;
        output.push(
          `[OK] Аппаратная межсетевая маршрутизация L3 (ip routing) включена на коммутаторе ${node.name}.`
        );
        return { updatedNode: updatedSelf, updatedAllNodes: updatedAll, outputLines: output };
      }
      output.push('[OK] Маршрутизация IPv4 уже активна на данном устройстве.');
      return { updatedNode: node, outputLines: output };
    }

    if (first === 'no' && second === 'ip' && third === 'routing') {
      if (node.type === 'switch') {
        node.ipRoutingEnabled = false;
        output.push(`[OK] Маршрутизация L3 (ip routing) отключена на коммутаторе ${node.name} (режим чистого L2).`);
        return { updatedNode: node, outputLines: output };
      }
      return { updatedNode: node, outputLines: output };
    }

    // Switch / Router Stack CLI configuration:
    // "stack-group <stackId>" or "switch <1-8> priority <1-15>" or "standby <grp> ip <vip>"
    if (first === 'stack-group' && tokens[1]) {
      const stackId = tokens[1].toUpperCase();
      const isSw = node.type === 'switch';
      node.stackConfig = {
        enabled: true,
        stackId,
        domainId: node.stackConfig?.domainId || 1,
        memberNumber: node.stackConfig?.memberNumber || 1,
        priority: node.stackConfig?.priority || 15,
        protocol: isSw ? 'StackWise-480' : 'HSRP',
        virtualIp: node.stackConfig?.virtualIp,
        virtualMac: node.stackConfig?.virtualMac || getDefaultStackVirtualMac(1),
        preempt: true,
        backplaneSpeedGbps: isSw ? 480 : 80,
      };
      const updatedAll = syncAllRoutersRoutingTables(
        allNodes.map((n) => (n.id === node.id ? node : n)),
        allLinks
      );
      const updatedSelf = updatedAll.find((n) => n.id === node.id) || node;
      output.push(
        `[OK] Устройство ${node.name} включено в стек ${stackId} (${node.stackConfig.protocol}, Member #${node.stackConfig.memberNumber}, Priority ${node.stackConfig.priority}).`
      );
      return { updatedNode: updatedSelf, updatedAllNodes: updatedAll, outputLines: output };
    }

    if (first === 'switch' && /^\d+$/.test(second) && third === 'priority' && tokens[3]) {
      const memberNum = Math.max(1, Math.min(8, Number(second)));
      const prioVal = Math.max(1, Math.min(15, Number(tokens[3])));
      const isSw = node.type === 'switch';
      node.stackConfig = {
        enabled: true,
        stackId: node.stackConfig?.stackId || (isSw ? 'STACK-CORE-1' : 'STACK-WAN-1'),
        domainId: node.stackConfig?.domainId || 1,
        memberNumber: memberNum,
        priority: prioVal,
        protocol: node.stackConfig?.protocol || (isSw ? 'StackWise-480' : 'HSRP'),
        virtualIp: node.stackConfig?.virtualIp,
        virtualMac: node.stackConfig?.virtualMac || getDefaultStackVirtualMac(1),
        preempt: true,
        backplaneSpeedGbps: isSw ? 480 : 80,
      };
      output.push(
        `[OK] Стек ${node.stackConfig.stackId}: Member #${memberNum} приоритет установлен в ${prioVal} (1..15, максимальный становится Master).`
      );
      return { updatedNode: node, outputLines: output };
    }

    if (first === 'standby') {
      const hasGrp = /^\d+$/.test(second);
      const grpId = hasGrp ? Number(second) : 1;
      const subCmd = (hasGrp ? third : second).toLowerCase();
      const argVal = hasGrp ? tokens[3] : tokens[2];

      const baseStack = node.stackConfig || {
        enabled: true,
        stackId: 'STACK-WAN-1',
        domainId: grpId,
        memberNumber: 1,
        priority: 15,
        protocol: 'HSRP' as const,
        virtualMac: getDefaultStackVirtualMac(grpId),
        preempt: true,
        backplaneSpeedGbps: 80,
      };

      if (subCmd === 'ip' && argVal && isValidIpv4(argVal)) {
        node.stackConfig = {
          ...baseStack,
          enabled: true,
          domainId: grpId,
          virtualIp: argVal,
          virtualMac: getDefaultStackVirtualMac(grpId),
        };
        output.push(
          `%HSRP-5-STATECHANGE: Группа HSRP ${grpId} активна. Виртуальный шлюз VIP: ${argVal} (Virtual MAC ${node.stackConfig.virtualMac}).`
        );
        return { updatedNode: node, outputLines: output };
      }

      if (subCmd === 'priority' && argVal && /^\d+$/.test(argVal)) {
        const rawPrio = Number(argVal);
        const normPrio = rawPrio > 15 ? Math.max(1, Math.min(15, Math.round(rawPrio / 10))) : Math.max(1, rawPrio);
        node.stackConfig = {
          ...baseStack,
          enabled: true,
          domainId: grpId,
          priority: normPrio,
        };
        output.push(`[OK] Приоритет HSRP / Stack для ${node.name} установлен в ${normPrio}.`);
        return { updatedNode: node, outputLines: output };
      }
    }

    // Spanning-tree priority command
    if (first === 'spanning-tree' || first === 'stp') {
      const prioTokenIdx = tokens.findIndex((t) => t.toLowerCase().startsWith('prio'));
      const rootPrimary = tokens.some((t) => t.toLowerCase() === 'primary');
      if (rootPrimary) {
        node.stpPriority = 4096;
        output.push(`[OK] Приоритет STP на ${node.name} установлен в 4096 (Root Bridge Primary).`);
        return { updatedNode: node, outputLines: output };
      }
      if (prioTokenIdx !== -1 && tokens[prioTokenIdx + 1]) {
        const prioVal = Number(tokens[prioTokenIdx + 1]);
        if (Number.isInteger(prioVal) && prioVal >= 0 && prioVal <= 61440) {
          node.stpPriority = prioVal;
          output.push(`[OK] Приоритет моста STP 802.1D установлен в ${prioVal}.`);
          return { updatedNode: node, outputLines: output };
        }
      }
      output.push('% Использование: spanning-tree vlan 1 priority <0-61440> (кратные 4096, напр. 4096, 24576, 32768)');
      return { updatedNode: node, outputLines: output };
    }

    // Access-list command: access-list 100 <permit|deny> <proto> <src> <dst> [eq <port>]
    if (first === 'no' && second.startsWith('access-list')) {
      node.aclRules = [];
      output.push('[OK] Все правила списка контроля доступа (ACL) удалены.');
      return { updatedNode: node, outputLines: output };
    }

    if (first === 'access-list' || first === 'acl') {
      const hasNumber = /^\d+$/.test(tokens[1] || '');
      const baseIdx = hasNumber ? 2 : 1;
      const actionRaw = (tokens[baseIdx] || '').toLowerCase();
      const protoRaw = (tokens[baseIdx + 1] || 'any').toUpperCase();
      const srcRaw = tokens[baseIdx + 2] || 'any';
      const dstRaw = tokens[baseIdx + 3] || 'any';
      const eqIdx = tokens.findIndex((t, i) => i >= baseIdx + 4 && t.toLowerCase() === 'eq');
      const dstPort = eqIdx !== -1 && tokens[eqIdx + 1] ? Number(tokens[eqIdx + 1]) : undefined;

      if (actionRaw !== 'permit' && actionRaw !== 'deny') {
        output.push(
          '% Использование: access-list 100 <permit|deny> <icmp|tcp|udp|http|dns|any> <srcIp|any> <dstIp|any> [eq <port>]'
        );
        return { updatedNode: node, outputLines: output };
      }

      const validProtos: Record<string, AclProtocol> = {
        ANY: 'ANY',
        IP: 'ANY',
        ICMP: 'ICMP',
        TCP: 'TCP',
        UDP: 'UDP',
        HTTP: 'HTTP',
        DNS: 'DNS',
      };
      const mappedProto: AclProtocol = validProtos[protoRaw] || 'ANY';
      const existingRules = node.aclRules || [];
      const nextSeq =
        existingRules.length > 0 ? Math.max(...existingRules.map((r) => r.seq)) + 10 : 10;

      const newRule = {
        id: `acl-${Date.now()}-${nextSeq}`,
        seq: nextSeq,
        action: actionRaw as AclAction,
        protocol: mappedProto,
        srcIp: srcRaw,
        dstIp: dstRaw,
        dstPort: dstPort && dstPort > 0 ? dstPort : undefined,
        enabled: true,
        hitCount: 0,
      };
      node.aclRules = [...existingRules, newRule];
      output.push(
        `[OK] Добавлено правило ACL #${nextSeq}: ${newRule.action.toUpperCase()} ${newRule.protocol} ${newRule.srcIp} → ${newRule.dstIp}${
          newRule.dstPort ? ` (port ${newRule.dstPort})` : ''
        }.`
      );
      return { updatedNode: node, outputLines: output };
    }

    if (first === 'vlan' && tokens[1]) {
      const vlanNum = Number(tokens[1]);
      if (Number.isInteger(vlanNum) && vlanNum >= 1 && vlanNum <= 4094) {
        const customName = tokens.slice(2).join('_');
        const updated = upsertDeviceVlan(node, vlanNum, customName);
        output.push(
          `[OK] VLAN ${vlanNum} (${
            updated.vlanDatabase?.find((v) => v.id === vlanNum)?.name || ''
          }) добавлен в базу данных коммутатора.`
        );
        return { updatedNode: updated, outputLines: output };
      }
      output.push('% Недопустимый номер VLAN (1..4094). Использование: vlan <1-4094> [имя]');
      return { updatedNode: node, outputLines: output };
    }

    if (first === 'interface' || first === 'int') {
      const ifaceQuery = tokens.slice(1).join('');

      // Check for Switch Virtual Interface (SVI): e.g. "interface vlan 10" or "int vlan10"
      const vlanMatch = ifaceQuery.match(/^vlan(\d+)$/i);
      if (vlanMatch) {
        if (node.type !== 'switch') {
          output.push('% Виртуальные интерфейсы SVI (interface Vlan<ID>) поддерживаются на коммутаторах L2/L3.');
          return { updatedNode: node, outputLines: output };
        }
        const sviVlan = Number(vlanMatch[1]);
        if (!Number.isInteger(sviVlan) || sviVlan < 1 || sviVlan > 4094) {
          output.push('% Недопустимый номер интерфейса Vlan (1..4094).');
          return { updatedNode: node, outputLines: output };
        }
        if (!Array.isArray(node.sviInterfaces)) {
          node.sviInterfaces = [];
        }
        let svi = node.sviInterfaces.find((s) => s.vlanId === sviVlan);
        if (!svi) {
          svi = {
            id: `${node.id}-svi-${sviVlan}`,
            vlanId: sviVlan,
            name: `Vlan${sviVlan}`,
            ipAddress: '',
            subnetMask: '255.255.255.0',
            adminStatus: 'up',
            macAddress: generateSviMacAddress(node, sviVlan),
          };
          node.sviInterfaces.push(svi);
          node.sviInterfaces.sort((a, b) => a.vlanId - b.vlanId);
        }
        const withVlan = upsertDeviceVlan(
          node,
          sviVlan,
          `VLAN${String(sviVlan).padStart(4, '0')}`,
          '',
          true
        );
        node.vlanDatabase = withVlan.vlanDatabase;
        node.cli.mode = 'config-if';
        node.cli.selectedSviVlan = sviVlan;
        node.cli.selectedInterface = undefined;
        node.cli.selectedSubinterfaceVlan = undefined;
        node.routingTable = syncConnectedRoutes(node, allNodes, allLinks);
        output.push(`%LINEPROTO-5-UPDOWN: Line protocol on Interface Vlan${sviVlan}, changed state to up`);
        return { updatedNode: node, outputLines: output };
      }

      // Check for Router-on-a-Stick subinterface notation: e.g. fa0/0.10 or FastEthernet0/0.20
      const dotMatch = ifaceQuery.match(/^([^.]+)\.(\d+)$/);
      if (dotMatch && node.type === 'router') {
        const basePart = dotMatch[1];
        const subVlan = Number(dotMatch[2]);
        const foundBase = findInterface(node, basePart);
        if (!foundBase) {
          output.push(
            `% Физический интерфейс "${basePart}" не найден. Доступные порты: ${node.interfaces
              .map((i) => i.shortName)
              .join(', ')}`
          );
          return { updatedNode: node, outputLines: output };
        }
        if (subVlan < 1 || subVlan > 4094) {
          output.push('% Недопустимый номер подинтерфейса VLAN (1..4094).');
          return { updatedNode: node, outputLines: output };
        }
        if (!Array.isArray(foundBase.subinterfaces)) {
          foundBase.subinterfaces = [];
        }
        let sub = foundBase.subinterfaces.find((s) => s.vlanId === subVlan);
        if (!sub) {
          sub = {
            id: `${foundBase.id}-sub-${subVlan}`,
            vlanId: subVlan,
            ipAddress: '',
            subnetMask: '255.255.255.0',
          };
          foundBase.subinterfaces.push(sub);
          foundBase.subinterfaces.sort((a, b) => a.vlanId - b.vlanId);
        }
        foundBase.vlanMode = 'trunk';
        if (!foundBase.trunkAllowedVlans.includes(subVlan)) {
          foundBase.trunkAllowedVlans = [...foundBase.trunkAllowedVlans, subVlan].sort(
            (a, b) => a - b
          );
        }
        node.cli.mode = 'config-if';
        node.cli.selectedInterface = foundBase.id;
        node.cli.selectedSubinterfaceVlan = subVlan;
        node.cli.selectedSviVlan = undefined;
        node.routingTable = syncConnectedRoutes(node);
        return { updatedNode: node, outputLines: output };
      }

      const found = findInterface(node, ifaceQuery);
      if (!found) {
        output.push(
          `% Интерфейс "${tokens.slice(1).join(' ')}" не найден. Доступные порты: ${node.interfaces
            .map((i) => i.shortName)
            .join(', ')}`
        );
        return { updatedNode: node, outputLines: output };
      }
      node.cli.mode = 'config-if';
      node.cli.selectedInterface = found.id;
      node.cli.selectedSubinterfaceVlan = undefined;
      node.cli.selectedSviVlan = undefined;
      return { updatedNode: node, outputLines: output };
    }

    if (first === 'ip' && (second === 'default-gateway' || second === 'def') && tokens[2]) {
      if (!isValidIpv4(tokens[2])) {
        output.push('% Некорректный IPv4-адрес шлюза по умолчанию.');
        return { updatedNode: node, outputLines: output };
      }
      node.defaultGateway = tokens[2];
      return { updatedNode: node, outputLines: output };
    }

    if (first === 'ip' && second === 'route') {
      const net = tokens[2];
      const mask = tokens[3];
      const nextHop = tokens[4];
      if (!isValidIpv4(net) || !isValidSubnetMask(mask) || !isValidIpv4(nextHop)) {
        output.push('% Использование: ip route <сеть> <маска> <next-hop-ip>');
        return { updatedNode: node, outputLines: output };
      }
      const outIface =
        node.interfaces.find((i) => i.ipAddress && i.subnetMask)?.shortName ||
        (node.sviInterfaces?.[0] ? `Vlan${node.sviInterfaces[0].vlanId}` : undefined) ||
        node.interfaces[0]?.shortName ||
        'Fa0/0';
      node.routingTable.push({
        id: `static-${Date.now()}`,
        network: net,
        mask,
        nextHop,
        interfaceName: outIface,
        type: 'S',
      });
      const updatedAll = syncAllRoutersRoutingTables(
        allNodes.map((n) => (n.id === node.id ? node : n)),
        allLinks
      );
      const updatedSelf = updatedAll.find((n) => n.id === node.id) || node;
      output.push(`[OK] Статический маршрут к ${net}/${mask} через ${nextHop} добавлен.`);
      return { updatedNode: updatedSelf, updatedAllNodes: updatedAll, outputLines: output };
    }

    // router ospf <id> / router rip / no router ospf / no router rip
    if (first === 'no' && second === 'router' && (third === 'ospf' || third === 'rip')) {
      if (node.type !== 'router') {
        output.push('% Маршрутизирующие протоколы L3 доступны только на маршрутизаторах.');
        return { updatedNode: node, outputLines: output };
      }
      const currentOspf = node.ospfConfig || getDefaultOspfConfig(node);
      if (third === 'ospf') {
        node.ospfConfig = { ...currentOspf, enabled: false };
        output.push('[OK] Процесс динамической маршрутизации OSPF остановлен.');
      } else {
        node.ospfConfig = { ...currentOspf, ripEnabled: false };
        output.push('[OK] Процесс маршрутизации RIPv2 остановлен.');
      }
      const updatedAll = syncAllRoutersRoutingTables(
        allNodes.map((n) => (n.id === node.id ? node : n)),
        allLinks
      );
      const updatedSelf = updatedAll.find((n) => n.id === node.id) || node;
      return { updatedNode: updatedSelf, updatedAllNodes: updatedAll, outputLines: output };
    }

    if (first === 'router' && (second === 'ospf' || second === 'rip')) {
      if (node.type !== 'router') {
        output.push('% Команда "router ospf / rip" поддерживается только на маршрутизаторах L3.');
        return { updatedNode: node, outputLines: output };
      }
      const currentOspf = node.ospfConfig || getDefaultOspfConfig(node);
      if (second === 'ospf') {
        const pid = Number(tokens[2]) || 1;
        if (!Number.isInteger(pid) || pid < 1 || pid > 65535) {
          output.push('% Использование: router ospf <1-65535>');
          return { updatedNode: node, outputLines: output };
        }
        node.ospfConfig = {
          ...currentOspf,
          enabled: true,
          processId: pid,
          routerId: currentOspf.routerId || electOspfRouterId(node),
        };
        node.cli.mode = 'config-router';
        node.cli.selectedRoutingProtocol = 'ospf';
        node.cli.selectedOspfProcessId = pid;
        const updatedAll = syncAllRoutersRoutingTables(
          allNodes.map((n) => (n.id === node.id ? node : n)),
          allLinks
        );
        const updatedSelf = updatedAll.find((n) => n.id === node.id) || node;
        return { updatedNode: updatedSelf, updatedAllNodes: updatedAll, outputLines: output };
      } else {
        node.ospfConfig = {
          ...currentOspf,
          ripEnabled: true,
        };
        node.cli.mode = 'config-router';
        node.cli.selectedRoutingProtocol = 'rip';
        const updatedAll = syncAllRoutersRoutingTables(
          allNodes.map((n) => (n.id === node.id ? node : n)),
          allLinks
        );
        const updatedSelf = updatedAll.find((n) => n.id === node.id) || node;
        output.push('[OK] Включён протокол RIPv2 (Distance-Vector, AD=120, метрика Hop Count).');
        return { updatedNode: updatedSelf, updatedAllNodes: updatedAll, outputLines: output };
      }
    }
  }

  // Router OSPF / RIP sub-mode commands: Router(config-router)#
  if (node.cli.mode === 'config-router') {
    const ospfCfg = node.ospfConfig || getDefaultOspfConfig(node);

    // Allow jumping straight to another interface from config-router
    if (first === 'interface' || first === 'int') {
      const ifaceQuery = tokens.slice(1).join('');
      const found = findInterface(node, ifaceQuery);
      if (found) {
        node.cli.mode = 'config-if';
        node.cli.selectedInterface = found.id;
        node.cli.selectedSubinterfaceVlan = undefined;
        node.cli.selectedSviVlan = undefined;
        node.cli.selectedRoutingProtocol = undefined;
        return { updatedNode: node, outputLines: output };
      }
    }

    if (first === 'router-id' && tokens[1]) {
      if (!isValidIpv4(tokens[1])) {
        output.push('% Использование: router-id <A.B.C.D>');
        return { updatedNode: node, outputLines: output };
      }
      node.ospfConfig = { ...ospfCfg, routerId: tokens[1] };
      output.push(`[OK] OSPF Router-ID установлен в ${tokens[1]}.`);
      return { updatedNode: node, outputLines: output };
    }

    if (first === 'version' && tokens[1] === '2') {
      node.ospfConfig = { ...ospfCfg, ripEnabled: true };
      output.push('[OK] RIPv2 (бесклассовая маршрутизация с передачей масок подсетей) активирован.');
      return { updatedNode: node, outputLines: output };
    }

    if (first === 'passive-interface' && tokens[1]) {
      const found = findInterface(node, tokens[1]);
      const ifName = found ? found.shortName : tokens[1];
      const nextPassive = Array.from(new Set([...(ospfCfg.passiveInterfaces || []), ifName]));
      node.ospfConfig = { ...ospfCfg, passiveInterfaces: nextPassive };
      const updatedAll = syncAllRoutersRoutingTables(
        allNodes.map((n) => (n.id === node.id ? node : n)),
        allLinks
      );
      const updatedSelf = updatedAll.find((n) => n.id === node.id) || node;
      output.push(`[OK] Интерфейс ${ifName} переведён в пассивный режим OSPF (рассылка Hello подавлена).`);
      return { updatedNode: updatedSelf, updatedAllNodes: updatedAll, outputLines: output };
    }

    if (first === 'no' && second === 'passive-interface' && tokens[2]) {
      const found = findInterface(node, tokens[2]);
      const ifName = found ? found.shortName : tokens[2];
      const nextPassive = (ospfCfg.passiveInterfaces || []).filter(
        (p) => p.toLowerCase() !== ifName.toLowerCase()
      );
      node.ospfConfig = { ...ospfCfg, passiveInterfaces: nextPassive };
      const updatedAll = syncAllRoutersRoutingTables(
        allNodes.map((n) => (n.id === node.id ? node : n)),
        allLinks
      );
      const updatedSelf = updatedAll.find((n) => n.id === node.id) || node;
      output.push(`[OK] На интерфейсе ${ifName} возобновлена рассылка пакетов OSPF Hello.`);
      return { updatedNode: updatedSelf, updatedAllNodes: updatedAll, outputLines: output };
    }

    if (first === 'no' && second === 'network' && tokens[2]) {
      const targetNet = tokens[2];
      const nextNets = ospfCfg.networks.filter((n) => n.network !== targetNet);
      node.ospfConfig = { ...ospfCfg, networks: nextNets };
      const updatedAll = syncAllRoutersRoutingTables(
        allNodes.map((n) => (n.id === node.id ? node : n)),
        allLinks
      );
      const updatedSelf = updatedAll.find((n) => n.id === node.id) || node;
      output.push(`[OK] Сеть ${targetNet} удалена из анонсов OSPF.`);
      return { updatedNode: updatedSelf, updatedAllNodes: updatedAll, outputLines: output };
    }

    if (first === 'network') {
      // Support both "network <ip> <wildcard> area <area>" and RIP "network <ip>"
      if (node.cli.selectedRoutingProtocol === 'rip' && tokens.length === 2 && isValidIpv4(tokens[1])) {
        const res = addOspfNetworkStatementToRouter(node, tokens[1], '0.0.0.255', 0);
        const updatedRouter = {
          ...res.updatedNode,
          ospfConfig: {
            ...(res.updatedNode.ospfConfig || ospfCfg),
            ripEnabled: true,
          },
        };
        const updatedAll = syncAllRoutersRoutingTables(
          allNodes.map((n) => (n.id === updatedRouter.id ? updatedRouter : n)),
          allLinks
        );
        const updatedSelf = updatedAll.find((n) => n.id === updatedRouter.id) || updatedRouter;
        output.push(`[OK] Сеть ${tokens[1]} включена в рассылку RIPv2.`);
        return { updatedNode: updatedSelf, updatedAllNodes: updatedAll, outputLines: output };
      }

      const netIp = tokens[1] || '';
      const wildcard = tokens[2] || '0.0.0.255';
      const areaTokenIdx = tokens.findIndex((t) => t.toLowerCase() === 'area');
      const areaNum =
        areaTokenIdx !== -1 && tokens[areaTokenIdx + 1] !== undefined
          ? Number(tokens[areaTokenIdx + 1])
          : 0;

      const addRes = addOspfNetworkStatementToRouter(node, netIp, wildcard, areaNum);
      if (addRes.error) {
        output.push(`% ${addRes.error}. Использование: network <IP> <wildcard-mask> area <area-id>`);
        return { updatedNode: node, outputLines: output };
      }

      const updatedNodeWithCli: NetworkNode = {
        ...addRes.updatedNode,
        cli: node.cli,
      };
      const updatedAll = syncAllRoutersRoutingTables(
        allNodes.map((n) => (n.id === updatedNodeWithCli.id ? updatedNodeWithCli : n)),
        allLinks
      );
      const updatedSelf = updatedAll.find((n) => n.id === updatedNodeWithCli.id) || updatedNodeWithCli;
      const neighbors = computeOspfNeighborsForRouter(updatedSelf, updatedAll, allLinks);
      const ospfSteps = synthesizeOspfHelloSteps(updatedAll, allLinks, 1, 0);

      output.push(
        `[OK] Анонс OSPF добавлен: network ${netIp} ${wildcard} area ${areaNum}.`
      );
      if (neighbors.length > 0) {
        for (const nb of neighbors) {
          output.push(
            `%OSPF-5-ADJCHG: Process ${updatedSelf.ospfConfig?.processId || 1}, Nbr ${nb.neighborRouterId} (${nb.neighborRouterName}) on ${nb.localInterface} from LOADING to FULL, Loading Done`
          );
        }
      }

      return {
        updatedNode: updatedSelf,
        updatedAllNodes: updatedAll,
        outputLines: output,
        triggeredSimulationSteps: ospfSteps.length > 0 ? ospfSteps : undefined,
        triggeredSummaryMessage:
          ospfSteps.length > 0
            ? `OSPFv2 Area ${areaNum}: рассылка Hello (224.0.0.5) и синхронизация LSDB / пересчёт дерева Дейкстры (SPF).`
            : undefined,
      };
    }
  }

  // Switch Virtual Interface (SVI: interface Vlan<ID>) configuration commands
  if (node.cli.mode === 'config-if' && node.cli.selectedSviVlan) {
    const sviVlan = node.cli.selectedSviVlan;
    const svi: SwitchSviInterface | undefined = (node.sviInterfaces || []).find(
      (s) => s.vlanId === sviVlan
    );
    if (!svi) {
      node.cli.mode = 'config';
      node.cli.selectedSviVlan = undefined;
      return { updatedNode: node, outputLines: output };
    }

    if (first === 'ip' && second.startsWith('add')) {
      const ip = tokens[2];
      const mask = tokens[3];
      if (!isValidIpv4(ip) || !isValidSubnetMask(mask)) {
        output.push('% Некорректный IPv4-адрес или маска. Пример: ip address 192.168.10.1 255.255.255.0');
        return { updatedNode: node, outputLines: output };
      }
      svi.ipAddress = ip;
      svi.subnetMask = mask;
      node.routingTable = syncConnectedRoutes(node, allNodes, allLinks);
      const updatedAll = syncAllRoutersRoutingTables(
        allNodes.map((n) => (n.id === node.id ? node : n)),
        allLinks
      );
      const updatedSelf = updatedAll.find((n) => n.id === node.id) || node;
      output.push(`[OK] Назначен адрес шлюза SVI Vlan${sviVlan}: ${ip}/${maskToCidr(mask)}.`);
      return { updatedNode: updatedSelf, updatedAllNodes: updatedAll, outputLines: output };
    }

    if (first === 'no' && second === 'ip' && third.startsWith('add')) {
      svi.ipAddress = '';
      node.routingTable = syncConnectedRoutes(node, allNodes, allLinks);
      output.push(`[OK] IPv4-адрес удалён с интерфейса Vlan${sviVlan}.`);
      return { updatedNode: node, outputLines: output };
    }

    if (first === 'ip' && second.startsWith('helper')) {
      const helperIp = tokens[2];
      if (!isValidIpv4(helperIp)) {
        output.push('% Использование: ip helper-address <IPv4-адрес DHCP-сервера>');
        return { updatedNode: node, outputLines: output };
      }
      svi.helperAddress = helperIp;
      output.push(`[OK] DHCP Relay (ip helper-address ${helperIp}) настроен на SVI Vlan${sviVlan}.`);
      return { updatedNode: node, outputLines: output };
    }

    if (first === 'no' && second.startsWith('shut')) {
      svi.adminStatus = 'up';
      node.routingTable = syncConnectedRoutes(node, allNodes, allLinks);
      output.push(`%LINK-3-UPDOWN: Interface Vlan${sviVlan}, changed state to up`);
      return { updatedNode: node, outputLines: output };
    }

    if (first.startsWith('shut')) {
      svi.adminStatus = 'down';
      node.routingTable = syncConnectedRoutes(node, allNodes, allLinks);
      output.push(`%LINK-5-CHANGED: Interface Vlan${sviVlan}, changed state to administratively down`);
      return { updatedNode: node, outputLines: output };
    }
  }

  // Physical Interface / Subinterface configuration commands
  if (node.cli.mode === 'config-if' && node.cli.selectedInterface) {
    const iface = node.interfaces.find((i) => i.id === node.cli.selectedInterface);
    if (!iface) {
      node.cli.mode = 'config';
      node.cli.selectedSubinterfaceVlan = undefined;
      return { updatedNode: node, outputLines: output };
    }

    const activeSubVlan = node.cli.selectedSubinterfaceVlan;
    const activeSub =
      activeSubVlan && Array.isArray(iface.subinterfaces)
        ? iface.subinterfaces.find((s) => s.vlanId === activeSubVlan)
        : undefined;

    // channel-group <1-6> mode <active|passive|on> / no channel-group
    if (first === 'no' && second.startsWith('channel-group')) {
      iface.channelGroup = undefined;
      iface.channelMode = undefined;
      output.push(`[OK] Интерфейс ${iface.shortName} исключён из агрегированного канала Port-channel.`);
      return { updatedNode: node, outputLines: output };
    }

    if (first.startsWith('channel-group') || first === 'ch') {
      if (node.type !== 'switch') {
        output.push('% Агрегация каналов EtherChannel (channel-group) поддерживается на коммутаторах.');
        return { updatedNode: node, outputLines: output };
      }
      const groupNum = Number(tokens[1]);
      const modeTokenIdx = tokens.findIndex((t) => t.toLowerCase() === 'mode');
      const modeRaw = (
        modeTokenIdx !== -1 && tokens[modeTokenIdx + 1]
          ? tokens[modeTokenIdx + 1]
          : tokens[2] || 'active'
      ).toLowerCase();

      if (!Number.isInteger(groupNum) || groupNum < 1 || groupNum > 6) {
        output.push('% Использование: channel-group <1-6> mode <active | passive | on>');
        return { updatedNode: node, outputLines: output };
      }

      const modeVal: 'active' | 'passive' | 'on' =
        modeRaw === 'passive' ? 'passive' : modeRaw === 'on' ? 'on' : 'active';
      iface.channelGroup = groupNum;
      iface.channelMode = modeVal;
      output.push(
        `Creating a port-channel interface Port-channel ${groupNum}`,
        `[OK] Порт ${iface.shortName} добавлен в Port-channel${groupNum} (Po${groupNum}, режим: ${modeVal.toUpperCase()}).`
      );
      return { updatedNode: node, outputLines: output };
    }

    // encapsulation dot1Q <vlan>
    if (first.startsWith('encap') && second.startsWith('dot1q')) {
      const vlanNum = Number(tokens[2]);
      if (!Number.isInteger(vlanNum) || vlanNum < 1 || vlanNum > 4094) {
        output.push('% Использование: encapsulation dot1Q <1-4094>');
        return { updatedNode: node, outputLines: output };
      }
      if (!Array.isArray(iface.subinterfaces)) {
        iface.subinterfaces = [];
      }
      if (activeSub) {
        activeSub.vlanId = vlanNum;
        node.cli.selectedSubinterfaceVlan = vlanNum;
      } else {
        let sub = iface.subinterfaces.find((s) => s.vlanId === vlanNum);
        if (!sub) {
          sub = {
            id: `${iface.id}-sub-${vlanNum}`,
            vlanId: vlanNum,
            ipAddress: '',
            subnetMask: '255.255.255.0',
          };
          iface.subinterfaces.push(sub);
        }
        node.cli.selectedSubinterfaceVlan = vlanNum;
      }
      iface.vlanMode = 'trunk';
      if (!iface.trunkAllowedVlans.includes(vlanNum)) {
        iface.trunkAllowedVlans = [...iface.trunkAllowedVlans, vlanNum].sort((a, b) => a - b);
      }
      node.routingTable = syncConnectedRoutes(node);
      output.push(`[OK] Инкапсуляция IEEE 802.1Q VLAN ${vlanNum} настроена на ${iface.shortName}.${vlanNum}.`);
      return { updatedNode: node, outputLines: output };
    }

    // ip helper-address <ip>
    if (first === 'ip' && second.startsWith('helper')) {
      const helperIp = tokens[2];
      if (!isValidIpv4(helperIp)) {
        output.push('% Использование: ip helper-address <IPv4-адрес DHCP-сервера>');
        return { updatedNode: node, outputLines: output };
      }
      if (activeSub) {
        activeSub.helperAddress = helperIp;
        output.push(
          `[OK] DHCP Relay (ip helper-address ${helperIp}) настроен на подинтерфейсе ${iface.shortName}.${activeSub.vlanId}.`
        );
      } else {
        iface.helperAddress = helperIp;
        output.push(`[OK] DHCP Relay (ip helper-address ${helperIp}) настроен на интерфейсе ${iface.shortName}.`);
      }
      return { updatedNode: node, outputLines: output };
    }

    // ip nat inside / ip nat outside
    if (first === 'ip' && second === 'nat') {
      if (third === 'inside' || third === 'outside') {
        node.natEnabled = true;
        if (activeSub) {
          activeSub.natRole = third;
          output.push(`[OK] Подинтерфейс ${iface.shortName}.${activeSub.vlanId} переведён в режим ip nat ${third}.`);
        } else {
          iface.natRole = third;
          output.push(`[OK] Интерфейс ${iface.shortName} переведён в режим ip nat ${third}.`);
        }
        return { updatedNode: node, outputLines: output };
      }
    }

    // Cisco ASA: nameif <inside|dmz|outside>
    if (first === 'nameif') {
      const zoneArg = (second || '').toLowerCase();
      if (zoneArg !== 'inside' && zoneArg !== 'dmz' && zoneArg !== 'outside') {
        output.push('% Использование: nameif <inside | dmz | outside>');
        return { updatedNode: node, outputLines: output };
      }
      const zone = zoneArg as FirewallZoneName;
      const defaultLevel = getDefaultSecurityLevelForZone(zone);
      if (activeSub) {
        activeSub.securityZone = zone;
        activeSub.securityLevel = defaultLevel;
        activeSub.natRole = zone === 'outside' ? 'outside' : 'inside';
      } else {
        iface.securityZone = zone;
        iface.securityLevel = defaultLevel;
        iface.natRole = zone === 'outside' ? 'outside' : 'inside';
      }
      output.push(
        `INFO: Security level for "${zone}" is set to ${defaultLevel} by default.`,
        `[OK] Интерфейс ${iface.shortName} назначен в зону безопасности "${zone.toUpperCase()}" (Security Level ${defaultLevel}).`
      );
      return { updatedNode: node, outputLines: output };
    }

    // Cisco ASA: security-level <0-100>
    if (first === 'security-level' || (first === 'security' && second === 'level')) {
      const lvlVal = Number(first === 'security-level' ? second : third);
      if (!Number.isInteger(lvlVal) || lvlVal < 0 || lvlVal > 100) {
        output.push('% Использование: security-level <0-100>');
        return { updatedNode: node, outputLines: output };
      }
      if (activeSub) {
        activeSub.securityLevel = lvlVal;
      } else {
        iface.securityLevel = lvlVal;
      }
      output.push(`[OK] Уровень безопасности (security-level) на интерфейсе ${iface.shortName} установлен в ${lvlVal}.`);
      return { updatedNode: node, outputLines: output };
    }

    if (first === 'ip' && second.startsWith('add')) {
      if (tokens[2]?.toLowerCase() === 'dhcp') {
        const dhcpRes = runDhcpDoraSimulation(allNodes, allLinks, node.id);
        const updatedSelf = dhcpRes.updatedNodes.find((n) => n.id === node.id) || node;
        updatedSelf.cli = node.cli;
        output.push(dhcpRes.summaryMessage);
        return {
          updatedNode: updatedSelf,
          updatedAllNodes: dhcpRes.updatedNodes.map((n) =>
            n.id === updatedSelf.id ? { ...n, cli: updatedSelf.cli } : n
          ),
          outputLines: output,
          triggeredSimulationSteps: dhcpRes.steps,
          triggeredSummaryMessage: dhcpRes.summaryMessage,
        };
      }

      const ip = tokens[2];
      const mask = tokens[3];
      if (!isValidIpv4(ip) || !isValidSubnetMask(mask)) {
        output.push('% Некорректный IP-адрес или маска. Пример: ip add 192.168.1.1 255.255.255.0 (или ip add dhcp)');
        return { updatedNode: node, outputLines: output };
      }
      if (activeSub) {
        activeSub.ipAddress = ip;
        activeSub.subnetMask = mask;
      } else {
        iface.ipAddress = ip;
        iface.subnetMask = mask;
      }
      if (node.type === 'router' || node.type === 'switch') {
        const updatedAll = syncAllRoutersRoutingTables(
          allNodes.map((n) => (n.id === node.id ? node : n)),
          allLinks
        );
        const updatedSelf = updatedAll.find((n) => n.id === node.id) || node;
        return { updatedNode: updatedSelf, updatedAllNodes: updatedAll, outputLines: output };
      }
      return { updatedNode: node, outputLines: output };
    }

    // ip ospf cost <1-65535> / no ip ospf cost
    if (first === 'no' && second === 'ip' && third === 'ospf' && tokens[3]?.toLowerCase() === 'cost') {
      iface.ospfCost = undefined;
      const autoCost = calculateOspfInterfaceCost(iface);
      const updatedAll = syncAllRoutersRoutingTables(
        allNodes.map((n) => (n.id === node.id ? node : n)),
        allLinks
      );
      const updatedSelf = updatedAll.find((n) => n.id === node.id) || node;
      output.push(`[OK] Ручная стоимость OSPF сброшена на ${iface.shortName} (автоматический Cost=${autoCost} по полосе пропускания).`);
      return { updatedNode: updatedSelf, updatedAllNodes: updatedAll, outputLines: output };
    }

    if (first === 'ip' && second === 'ospf' && third === 'cost') {
      const costVal = Number(tokens[3]);
      if (!Number.isInteger(costVal) || costVal < 1 || costVal > 65535) {
        output.push('% Использование: ip ospf cost <1-65535>');
        return { updatedNode: node, outputLines: output };
      }
      iface.ospfCost = costVal;
      const updatedAll = syncAllRoutersRoutingTables(
        allNodes.map((n) => (n.id === node.id ? node : n)),
        allLinks
      );
      const updatedSelf = updatedAll.find((n) => n.id === node.id) || node;
      output.push(`[OK] Стоимость линка OSPF на интерфейсе ${iface.shortName} установлена в ${costVal} (пересчитано дерево Дейкстры SPF).`);
      return { updatedNode: updatedSelf, updatedAllNodes: updatedAll, outputLines: output };
    }

    if (first === 'no' && second.startsWith('shut')) {
      iface.adminStatus = 'up';
      output.push(`%LINK-3-UPDOWN: Interface ${iface.name}, changed state to up`);
      const updatedAll = syncAllRoutersRoutingTables(
        allNodes.map((n) => (n.id === node.id ? node : n)),
        allLinks
      );
      const updatedSelf = updatedAll.find((n) => n.id === node.id) || node;
      return { updatedNode: updatedSelf, updatedAllNodes: updatedAll, outputLines: output };
    }

    if (first.startsWith('shut')) {
      iface.adminStatus = 'down';
      output.push(`%LINK-5-CHANGED: Interface ${iface.name}, changed state to administratively down`);
      const updatedAll = syncAllRoutersRoutingTables(
        allNodes.map((n) => (n.id === node.id ? node : n)),
        allLinks
      );
      const updatedSelf = updatedAll.find((n) => n.id === node.id) || node;
      return { updatedNode: updatedSelf, updatedAllNodes: updatedAll, outputLines: output };
    }

    if (first === 'switchport' || first === 'sw') {
      if (second.startsWith('m') && tokens[2]) {
        const modeArg = tokens[2].toLowerCase();
        if (modeArg.startsWith('acc') || modeArg === 'a') {
          iface.vlanMode = 'access';
          return { updatedNode: node, outputLines: output };
        }
        if (modeArg.startsWith('tr') || modeArg === 't') {
          iface.vlanMode = 'trunk';
          return { updatedNode: node, outputLines: output };
        }
      }
      if (second.startsWith('acc') && tokens[2]?.toLowerCase().startsWith('v') && tokens[3]) {
        const vlanNum = Number(tokens[3]);
        if (Number.isInteger(vlanNum) && vlanNum >= 1 && vlanNum <= 4094) {
          iface.accessVlan = vlanNum;
          iface.vlanMode = 'access';
          return { updatedNode: node, outputLines: output };
        }
        output.push('% Недопустимый номер VLAN (допустимый диапазон 1..4094).');
        return { updatedNode: node, outputLines: output };
      }
      if (
        second.startsWith('tr') &&
        tokens[2]?.toLowerCase().startsWith('all') &&
        tokens[3]?.toLowerCase().startsWith('v') &&
        tokens[4]
      ) {
        const list = tokens[4]
          .split(',')
          .map((x) => Number(x.trim()))
          .filter((n) => Number.isInteger(n) && n >= 1 && n <= 4094);
        if (list.length > 0) {
          iface.trunkAllowedVlans = list;
          iface.vlanMode = 'trunk';
          return { updatedNode: node, outputLines: output };
        }
      }
      if (second === 'voice' && tokens[2]?.toLowerCase().startsWith('v') && tokens[3]) {
        const vVlan = Number(tokens[3]);
        if (Number.isInteger(vVlan) && vVlan >= 1 && vVlan <= 4094) {
          iface.voiceVlan = vVlan;
          output.push(
            `[OK] На порту ${iface.shortName} настроен голосовой Auxiliary Voice VLAN ${vVlan} (IEEE 802.1p CoS 5 / DSCP EF).`
          );
          return { updatedNode: node, outputLines: output };
        }
        output.push('% Недопустимый номер Voice VLAN (1..4094). Использование: switchport voice vlan <1-4094>');
        return { updatedNode: node, outputLines: output };
      }
    }

    if (
      first === 'no' &&
      (second === 'switchport' || second === 'sw') &&
      third === 'voice'
    ) {
      iface.voiceVlan = undefined;
      output.push(`[OK] Голосовой Voice VLAN отключён на порту ${iface.shortName}.`);
      return { updatedNode: node, outputLines: output };
    }

    // power inline auto | never (IEEE 802.3af/at PoE on switch ports)
    if (first === 'power' && second === 'inline') {
      const modeArg = (third || 'auto').toLowerCase();
      if (modeArg === 'never' || modeArg === 'off') {
        iface.poeEnabled = false;
        output.push(
          `%ILPOWER-5-IEEE_DISCONNECT: Interface ${iface.shortName}: PD removed (power inline never)`
        );
        return { updatedNode: node, outputLines: output };
      }
      iface.poeEnabled = true;
      output.push(
        `%ILPOWER-7-DETECT: Interface ${iface.shortName}: Power Device detected: IEEE 802.3af/at PoE Auto enabled`
      );
      return { updatedNode: node, outputLines: output };
    }
  }

  // VoIP SIP call command: "call <extension>" (e.g. "call 102")
  if (first === 'call' && tokens[1]) {
    const targetExt = tokens[1];
    const callRes = runVoipSipCallSimulation(allNodes, allLinks, node.id, targetExt);
    const updatedSelf = callRes.updatedNodes.find((n) => n.id === node.id) || node;
    updatedSelf.cli = node.cli;
    output.push(callRes.summaryMessage);
    return {
      updatedNode: updatedSelf,
      updatedAllNodes: callRes.updatedNodes,
      outputLines: output,
      triggeredSimulationSteps: callRes.steps,
      triggeredSummaryMessage: callRes.summaryMessage,
    };
  }

  // RTSP video stream command: "rtsp [targetIpOrMulticast]" or "stream [targetIpOrMulticast]"
  if (first === 'rtsp' || first === 'stream') {
    const targetArg = tokens[1];
    const rtspRes = runRtspVideoStreamSimulation(allNodes, allLinks, node.id, targetArg);
    const updatedSelf = rtspRes.updatedNodes.find((n) => n.id === node.id) || node;
    updatedSelf.cli = node.cli;
    output.push(rtspRes.summaryMessage);
    return {
      updatedNode: updatedSelf,
      updatedAllNodes: rtspRes.updatedNodes,
      outputLines: output,
      triggeredSimulationSteps: rtspRes.steps,
      triggeredSummaryMessage: rtspRes.summaryMessage,
    };
  }

  output.push(`% Неизвестная команда или неверный режим: "${cmd}". Нажмите Tab для автодополнения или введите "?".`);
  return { updatedNode: node, outputLines: output };
}
