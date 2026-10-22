import { NetworkInterface, NetworkLink, NetworkNode, SimulationStep } from './types';
import { isValidIpv4, isValidSubnetMask } from './ipMath';
import { getDeviceVlanDatabase, upsertDeviceVlan } from './hardwareChassis';
import {
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
      return `${node.name}(config-if)#`;
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
    'show arp',
    'show ip route',
    'help',
  ];

  const privCandidates = [
    'configure terminal',
    'show ip interface brief',
    'show ip route',
    'show ip dhcp binding',
    'show arp',
    'show mac address-table',
    'show vlan brief',
    'show running-config',
    'write memory',
    'copy running-config startup-config',
    'clear arp-cache',
    'clear mac address-table',
    'ping ',
    'traceroute ',
    'disable',
    'exit',
  ];

  const configCandidates = [
    ...portNames.map((p) => `interface ${p}`),
    'hostname ',
    'ip route ',
    'ip default-gateway ',
    'do show ip interface brief',
    'do write memory',
    'exit',
    'end',
  ];

  const configIfCandidates = [
    'ip address ',
    'ip address dhcp',
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
    const matchingPorts = portNames.filter((p) => p.startsWith(portPrefix));
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
    // Find longest common prefix among matches
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
      '  enable (en)                           — Переход в привилегированный режим (#)',
      '  configure terminal (conf t)           — Переход в режим глобальной конфигурации',
      '  interface (int) <fa0/0 | gi0/1>       — Выбор интерфейса для настройки',
      '  ip address (ip add) <IP> <MASK>|dhcp  — Назначение IPv4-адреса или запрос по DHCP',
      '  no shutdown (no shut) / shutdown      — Включение / выключение интерфейса',
      '  switchport mode (sw mode) access|trunk— Режим порта коммутатора (L2)',
      '  switchport access vlan <1-4094>       — Назначение Access VLAN на порт',
      '  ip route <NET> <MASK> <NEXT_HOP>      — Добавление статического маршрута L3',
      '  write memory (wr) / copy run start    — Сохранение конфигурации в NVRAM',
      '  ping <IP | домен>                     — Диагностика ICMP Echo (с поддержкой DNS)',
      '  traceroute / tracert <IP | домен>     — Трассировка маршрута по шагам TTL=1,2,3...',
      '  ipconfig [/renew]                     — Просмотр IP/DNS или запуск DHCP DORA',
      '  nslookup / curl <http://домен>        — Проверка DNS (UDP 53) и HTTP GET (TCP 80)',
      '  show ip int brief (sh ip int b)       — Сводка состояния портов и IP-адресов',
      '  show ip dhcp binding (sh ip dhcp)     — Таблица выданных арендованных адресов DHCP',
      '  show ip route / show arp / sh mac     — Таблицы маршрутов, ARP и MAC (CAM)',
      '  show vlan brief / show run (sh run)   — Таблица VLAN и текущая конфигурация',
      '  exit / end                            — Выход на уровень выше'
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
    return { updatedNode: node, outputLines: output };
  }

  if (first === 'exit' || first === 'ex') {
    if (node.cli.mode === 'config-if') {
      node.cli.mode = 'config';
      node.cli.selectedInterface = undefined;
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
    return { updatedNode: node, outputLines: output };
  }

  if (
    (first.startsWith('conf') && (second.startsWith('t') || !second))
  ) {
    if (node.cli.mode === 'user') {
      output.push('% Ошибка: сначала войдите в привилегированный режим командой "enable" (или "en").');
      return { updatedNode: node, outputLines: output };
    }
    node.cli.mode = 'config';
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

    let resolvedTargetIp = target;
    if (!isValidIpv4(target)) {
      for (const n of allNodes) {
        if (n.services?.dnsEnabled) {
          const rec = n.services.dnsRecords.find(
            (r) => r.domain.toLowerCase() === target.toLowerCase()
          );
          if (rec) {
            resolvedTargetIp = rec.ipAddress;
            break;
          }
        }
      }
    }

    if (!isValidIpv4(resolvedTargetIp)) {
      output.push(`% Не удалось разрешить имя узла "${target}". Проверьте записи DNS.`);
      return { updatedNode: node, outputLines: output };
    }

    const simResult = runPacketSimulation(allNodes, allLinks, node.id, resolvedTargetIp, 'ICMP');
    const updatedSelf = simResult.updatedNodes.find((n) => n.id === node.id) || node;
    updatedSelf.cli = node.cli;

    output.push(`Type escape sequence to abort.`);
    output.push(`Sending 5, 100-byte ICMP Echos to ${resolvedTargetIp} (${target}), timeout is 2 seconds:`);
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
  }

  // SHOW commands
  const isDoShow = first === 'do' && (second === 'show' || second === 'sh');
  if (first === 'show' || first === 'sh' || isDoShow) {
    const showTokens = isDoShow ? tokens.slice(2) : tokens.slice(1);
    const sub1 = showTokens[0]?.toLowerCase() || '';
    const sub2 = showTokens[1]?.toLowerCase() || '';

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

    if (sub1 === 'ip' && (sub2.startsWith('int') || sub2.startsWith('b'))) {
      output.push(
        'Port    IP-Address       Mask             Status   VLAN',
        '------  ---------------  ---------------  -------  -----------'
      );
      for (const iface of node.interfaces) {
        const nameCol = iface.shortName.padEnd(6, ' ');
        const ipCol = (iface.ipAddress || 'unassigned').padEnd(15, ' ');
        const maskCol = (iface.subnetMask || 'unassigned').padEnd(15, ' ');
        const statusCol = (iface.adminStatus === 'up' ? 'up' : 'down').padEnd(7, ' ');
        const vlanCol =
          iface.vlanMode === 'trunk'
            ? `trunk(${iface.trunkAllowedVlans.join(',')})`
            : `vlan ${iface.accessVlan}`;
        output.push(`${nameCol}  ${ipCol}  ${maskCol}  ${statusCol}  ${vlanCol}`);
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

    output.push('% Неизвестная команда show. Попробуйте: sh ip int b, sh ip dhcp, sh ip route, sh arp, sh mac, sh run');
    return { updatedNode: node, outputLines: output };
  }

  // Configuration mode commands
  if (node.cli.mode === 'config' || node.cli.mode === 'config-if') {
    if ((first === 'hostname' || first === 'host') && tokens[1]) {
      node.name = tokens[1];
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

  // Interface configuration commands (including abbreviated forms: ip add, no shut, shut, sw mode acc/tr, sw acc vlan)
  if (node.cli.mode === 'config-if' && node.cli.selectedInterface) {
    const iface = node.interfaces.find((i) => i.id === node.cli.selectedInterface);
    if (!iface) {
      node.cli.mode = 'config';
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
      iface.ipAddress = ip;
      iface.subnetMask = mask;
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
