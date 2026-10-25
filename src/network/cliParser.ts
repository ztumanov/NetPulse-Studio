import {
  AclAction,
  AclProtocol,
  NetworkInterface,
  NetworkLink,
  NetworkNode,
  SimulationStep,
} from './types';
import { isValidIpv4, isValidSubnetMask } from './ipMath';
import { getDeviceVlanDatabase, upsertDeviceVlan } from './hardwareChassis';
import {
  computeSpanningTreeState,
  runDhcpDoraSimulation,
  runHttpBrowserSimulation,
  runPacketSimulation,
  runTracerouteSimulation,
  syncConnectedRoutes,
} from './simulator';

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
  const allPortCandidates = [...portNames, ...subPortNames];

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
    'show spanning-tree',
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
    'show ip dhcp binding',
    'show ip nat translations',
    'show access-lists',
    'show spanning-tree',
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
    'hostname ',
    'ip route ',
    'ip default-gateway ',
    'access-list 100 deny icmp any any',
    'access-list 100 permit ip any any',
    'spanning-tree vlan 1 priority ',
    'do show ip interface brief',
    'do write memory',
    'exit',
    'end',
  ];

  const configIfCandidates = [
    'encapsulation dot1Q ',
    'ip address ',
    'ip address dhcp',
    'ip helper-address ',
    'ip nat inside',
    'ip nat outside',
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

  const pool =
    node.cli.mode === 'user'
      ? userCandidates
      : node.cli.mode === 'priv'
      ? privCandidates
      : node.cli.mode === 'config'
      ? configCandidates
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
    'sh run': 'show running-config',
    'sh mac': 'show mac address-table',
    'sh vlan': 'show vlan brief',
    'sh span': 'show spanning-tree',
    'sh ip nat': 'show ip nat translations',
    'sh ip nat tr': 'show ip nat translations',
    'sh access-lists': 'show access-lists',
    'sh acl': 'show access-lists',
    'encap': 'encapsulation dot1Q ',
    'encap dot1q': 'encapsulation dot1Q ',
    'ip helper': 'ip helper-address ',
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
      '  interface <fa0/0 | fa0/0.10 | gi0/1>         — Выбор порта или 802.1Q подинтерфейса (RoAS)',
      '  encapsulation dot1Q <vlan-id>                — Привязка VLAN к подинтерфейсу маршрутизатора',
      '  ip address <IP> <MASK> | dhcp                — Назначение IPv4 или запрос по DHCP',
      '  ip helper-address <DHCP_SERVER_IP>           — Ретрансляция DHCP (DHCP Relay Agent)',
      '  ip nat inside | ip nat outside               — Настройка роли интерфейса для NAT/PAT',
      '  access-list 100 <permit|deny> <proto> <s_ip> <d_ip> — Правило межсетевого экрана ACL',
      '  spanning-tree vlan 1 priority <0-61440>      — Приоритет STP 802.1D (выбор Root Bridge)',
      '  switchport mode access|trunk                 — Режим порта коммутатора (L2)',
      '  ip route <NET> <MASK> <NEXT_HOP>             — Статический маршрут L3',
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
    return { updatedNode: node, outputLines: output };
  }

  if (first === 'exit' || first === 'ex') {
    if (node.cli.mode === 'config-if') {
      node.cli.mode = 'config';
      node.cli.selectedInterface = undefined;
      node.cli.selectedSubinterfaceVlan = undefined;
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
        const peerLabel = pSt.peerNodeName ? `P2p (${pSt.peerNodeName}:${pSt.peerPortName})` : 'Edge';
        output.push(
          `${iface.shortName.padEnd(16, ' ')} ${roleStr} ${stateStr} ${String(pSt.pathCost).padEnd(9, ' ')} 128.${String(
            idx + 1
          ).padEnd(4, ' ')} ${peerLabel}`
        );
      });
      return { updatedNode: node, outputLines: output };
    }

    // show ip nat translations
    if (sub1 === 'ip' && sub2.startsWith('nat')) {
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

    if (sub1 === 'ip' && (sub2.startsWith('int') || sub2.startsWith('b') || sub3.startsWith('b'))) {
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
        const vlanCol =
          iface.vlanMode === 'trunk'
            ? `trunk(${iface.trunkAllowedVlans.join(',')})${natTag}${helperTag}`
            : `vlan ${iface.accessVlan}${natTag}${helperTag}`;
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
      return { updatedNode: node, outputLines: output };
    }

    if (sub1 === 'ip' && sub2.startsWith('ro')) {
      const routes = syncConnectedRoutes(node);
      output.push(
        'Codes: C - connected, S - static',
        node.defaultGateway ? `Default Gateway is ${node.defaultGateway}` : 'Gateway of last resort is not set',
        ''
      );
      if (routes.length === 0) {
        output.push('  (Таблица маршрутизации пуста)');
      } else {
        for (const r of routes) {
          output.push(
            `${r.type}    ${r.network}/${r.mask} is ${
              r.type === 'C' ? 'directly connected' : `via ${r.nextHop}`
            }, ${r.interfaceName}`
          );
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
        if (node.type === 'switch') {
          output.push(` switchport mode ${iface.vlanMode}`);
          if (iface.vlanMode === 'access') {
            output.push(` switchport access vlan ${iface.accessVlan}`);
          } else {
            output.push(` switchport trunk allowed vlan ${iface.trunkAllowedVlans.join(',')}`);
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

    output.push(
      '% Неизвестная команда show. Попробуйте: sh ip int b, sh span, sh ip nat tr, sh access-lists, sh ip route, sh arp, sh mac, sh run'
    );
    return { updatedNode: node, outputLines: output };
  }

  // Configuration mode commands
  if (node.cli.mode === 'config' || node.cli.mode === 'config-if') {
    if ((first === 'hostname' || first === 'host') && tokens[1]) {
      node.name = tokens[1];
      return { updatedNode: node, outputLines: output };
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
      // Support both "access-list 100 deny icmp any any" and "access-list deny icmp any any"
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
      node.routingTable = syncConnectedRoutes(node);
      output.push(`[OK] Статический маршрут к ${net}/${mask} через ${nextHop} добавлен.`);
      return { updatedNode: node, outputLines: output };
    }
  }

  // Interface / Subinterface configuration commands
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
      if (node.type === 'router') {
        node.routingTable = syncConnectedRoutes(node);
      }
      return { updatedNode: node, outputLines: output };
    }

    if (first === 'no' && second.startsWith('shut')) {
      iface.adminStatus = 'up';
      output.push(`%LINK-3-UPDOWN: Interface ${iface.name}, changed state to up`);
      return { updatedNode: node, outputLines: output };
    }

    if (first.startsWith('shut')) {
      iface.adminStatus = 'down';
      output.push(`%LINK-5-CHANGED: Interface ${iface.name}, changed state to administratively down`);
      return { updatedNode: node, outputLines: output };
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
    }
  }

  output.push(`% Неизвестная команда или неверный режим: "${cmd}". Нажмите Tab для автодополнения или введите "?".`);
  return { updatedNode: node, outputLines: output };
}
