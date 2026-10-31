import { intToIp, isSameSubnet, isValidIpv4, isValidSubnetMask } from './ipMath';
import {
  FirewallConfig,
  FirewallPolicyRule,
  FirewallPortForwardRule,
  FirewallStatefulSession,
  FirewallZoneName,
  IpsecTunnelConfig,
  NetworkInterface,
  NetworkLink,
  NetworkNode,
  OsiPduDetails,
  ProtocolType,
  RouterSubinterface,
  SimulationStep,
} from './types';

/**
 * Checks whether a node acts as a stateful Firewall (Cisco ASA / FortiGate NGFW).
 */
export function isFirewallNode(node: NetworkNode): boolean {
  return (
    node.deviceModel === 'firewall' ||
    Boolean(node.firewallConfig && node.firewallConfig.enabled)
  );
}

/**
 * Returns default Cisco ASA security level for a named zone:
 * - inside -> 100 (Trusted corporate LAN)
 * - dmz    -> 50  (Demilitarized Zone with published servers)
 * - outside -> 0  (Untrusted Internet / WAN)
 */
export function getDefaultSecurityLevelForZone(zone: FirewallZoneName): number {
  switch (zone) {
    case 'inside':
      return 100;
    case 'dmz':
      return 50;
    case 'outside':
    default:
      return 0;
  }
}

export function getZoneLabelRu(zone: FirewallZoneName, level?: number): string {
  const lvl = level ?? getDefaultSecurityLevelForZone(zone);
  switch (zone) {
    case 'inside':
      return `Inside (${lvl})`;
    case 'dmz':
      return `DMZ (${lvl})`;
    case 'outside':
      return `Outside (${lvl})`;
  }
}

/**
 * Resolves the security zone (`inside` / `dmz` / `outside`) and security level (`0..100`)
 * for a physical interface or 802.1Q subinterface on a firewall.
 */
export function getInterfaceSecurityZoneAndLevel(
  iface?: NetworkInterface,
  sub?: RouterSubinterface
): { zone: FirewallZoneName; level: number } {
  if (sub?.securityZone) {
    return {
      zone: sub.securityZone,
      level:
        sub.securityLevel !== undefined
          ? sub.securityLevel
          : getDefaultSecurityLevelForZone(sub.securityZone),
    };
  }
  if (iface?.securityZone) {
    return {
      zone: iface.securityZone,
      level:
        iface.securityLevel !== undefined
          ? iface.securityLevel
          : getDefaultSecurityLevelForZone(iface.securityZone),
    };
  }
  if (sub?.natRole === 'outside' || iface?.natRole === 'outside') {
    return { zone: 'outside', level: 0 };
  }
  if (iface?.shortName.toLowerCase().includes('dmz') || iface?.shortName === 'Gi0/1') {
    return { zone: 'dmz', level: 50 };
  }
  return { zone: 'inside', level: 100 };
}

/**
 * Creates a default FirewallConfig for Cisco ASA / FortiGate nodes.
 */
export function getDefaultFirewallConfig(nodeId: string = 'fw'): FirewallConfig {
  return {
    enabled: true,
    vendorModel: 'Cisco ASA 5516-X',
    spiEnabled: true,
    inspectTcp: true,
    inspectUdp: true,
    inspectIcmp: true,
    inspectHttp: true,
    sameSecurityTrafficPermit: true,
    portForwards: [
      {
        id: `${nodeId}-pf-http`,
        name: 'DMZ-Web-HTTP-80',
        enabled: true,
        externalInterface: 'Gi0/2',
        externalIp: '203.0.113.2',
        externalPort: 80,
        protocol: 'ANY',
        internalIp: '172.16.50.100',
        internalPort: 80,
        targetZone: 'dmz',
        hitCount: 0,
      },
    ],
    policyRules: [],
    ipsecTunnels: [],
    statefulSessions: [],
  };
}

export function matchesSubnetSpec(ip: string, spec: string): boolean {
  const clean = (spec || 'any').trim().toLowerCase();
  if (!clean || clean === 'any' || clean === '*' || clean === '0.0.0.0/0') {
    return true;
  }
  if (!isValidIpv4(ip)) return false;

  if (clean.includes('/')) {
    const [netPart, prefixStr] = clean.split('/');
    const prefix = Number(prefixStr);
    if (!isValidIpv4(netPart) || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
      return false;
    }
    const maskInt = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    const maskIp = intToIp(maskInt);
    return isSameSubnet(ip, netPart, maskIp);
  }

  if (clean.includes(' ')) {
    const [netPart, maskPart] = clean.split(/\s+/);
    if (isValidIpv4(netPart) && isValidSubnetMask(maskPart)) {
      return isSameSubnet(ip, netPart, maskPart);
    }
  }

  return ip === clean;
}

function mapProtocolToSpiCategory(
  protocol: ProtocolType
): 'TCP' | 'UDP' | 'ICMP' | 'HTTP' {
  if (protocol.startsWith('HTTP')) return 'HTTP';
  if (protocol.startsWith('TCP')) return 'TCP';
  if (protocol.startsWith('ICMP')) return 'ICMP';
  return 'UDP';
}

function isReturnTraffic(protocol: ProtocolType): boolean {
  return (
    protocol === 'ICMP_ECHO_REPLY' ||
    protocol === 'ICMP_TIME_EXCEEDED' ||
    protocol === 'TCP_SYN_ACK' ||
    protocol === 'TCP_ACK' ||
    protocol === 'HTTP_200_OK' ||
    protocol === 'DNS_RESPONSE' ||
    protocol === 'DHCP_OFFER' ||
    protocol === 'DHCP_ACK'
  );
}

/**
 * Evaluates Inbound Port Forwarding (Static NAT / DNAT) on a Firewall when a packet arrives on `outside`.
 */
export function evaluateFirewallInboundDnat(
  firewallNode: NetworkNode,
  ingressPort?: NetworkInterface,
  ingressSub?: RouterSubinterface,
  packet?: {
    protocol: ProtocolType;
    srcIp: string;
    dstIp: string;
    dstPort?: number;
  }
): {
  matchedRule?: FirewallPortForwardRule;
  translatedDstIp?: string;
  translatedDstPort?: number;
  osiActionTitle?: string;
  osiActionDetail?: string;
} {
  if (!isFirewallNode(firewallNode) || !firewallNode.firewallConfig?.enabled || !packet) {
    return {};
  }
  if (isReturnTraffic(packet.protocol)) {
    return {};
  }

  const { zone: inZone } = getInterfaceSecurityZoneAndLevel(ingressPort, ingressSub);
  if (inZone !== 'outside') {
    return {};
  }

  const rules = (firewallNode.firewallConfig.portForwards || []).filter((r) => r.enabled);
  for (const rule of rules) {
    if (rule.externalIp && rule.externalIp !== 'any' && rule.externalIp !== packet.dstIp) {
      continue;
    }

    let protoMatch = false;
    if (rule.protocol === 'ANY') {
      protoMatch = true;
    } else if (rule.protocol === 'HTTP' || rule.protocol === 'TCP') {
      protoMatch =
        packet.protocol.startsWith('TCP') || packet.protocol.startsWith('HTTP');
    } else if (rule.protocol === 'UDP') {
      protoMatch =
        packet.protocol.startsWith('DNS') || packet.protocol.startsWith('DHCP');
    } else if (rule.protocol === 'ICMP') {
      protoMatch = packet.protocol.startsWith('ICMP');
    }

    if (!protoMatch) continue;

    if (
      rule.externalPort > 0 &&
      packet.dstPort !== undefined &&
      packet.dstPort !== rule.externalPort
    ) {
      continue;
    }

    rule.hitCount = (rule.hitCount || 0) + 1;
    return {
      matchedRule: rule,
      translatedDstIp: rule.internalIp,
      translatedDstPort: rule.internalPort,
      osiActionTitle: `Port Forwarding / Static DNAT (${rule.name})`,
      osiActionDetail: `Межсетевой экран ${firewallNode.name} перенаправил входящий запрос с публичного адреса ${packet.dstIp}:${rule.externalPort} на сервер DMZ ${rule.internalIp}:${rule.internalPort} (Зона ${getZoneLabelRu(rule.targetZone)}).`,
    };
  }

  return {};
}

/**
 * Checks if traffic between `srcIp` and `dstIp` matches an active Site-to-Site IPsec VPN tunnel on `firewallNode`.
 */
export function findMatchingIpsecTunnel(
  firewallNode: NetworkNode,
  srcIp: string,
  dstIp: string,
  allNodes?: NetworkNode[]
): IpsecTunnelConfig | undefined {
  if (!isFirewallNode(firewallNode) || !firewallNode.firewallConfig?.enabled) {
    return undefined;
  }
  const tunnels = (firewallNode.firewallConfig.ipsecTunnels || []).filter(
    (t) => t.enabled && t.status === 'UP'
  );
  for (const tun of tunnels) {
    const forwardMatch =
      matchesSubnetSpec(srcIp, tun.localSubnet) &&
      matchesSubnetSpec(dstIp, tun.remoteSubnet);
    const reverseMatch =
      matchesSubnetSpec(srcIp, tun.remoteSubnet) &&
      matchesSubnetSpec(dstIp, tun.localSubnet);

    if (forwardMatch || reverseMatch) {
      if (allNodes) {
        const peerFw = allNodes.find(
          (n) =>
            n.id !== firewallNode.id &&
            isFirewallNode(n) &&
            n.interfaces.some((i) => i.ipAddress === tun.peerPublicIp)
        );
        if (peerFw?.firewallConfig) {
          const peerTunnel = (peerFw.firewallConfig.ipsecTunnels || []).find(
            (pt) =>
              pt.enabled &&
              pt.status === 'UP' &&
              pt.preSharedKey === tun.preSharedKey
          );
          if (!peerTunnel) continue;
        }
      }
      return tun;
    }
  }
  return undefined;
}

/**
 * Evaluates Cisco ASA / FortiGate Security Zone Levels (`Inside 100`, `DMZ 50`, `Outside 0`),
 * Stateful Packet Inspection (SPI), Port Forwarding (DNAT), Site-to-Site IPsec VPN, and explicit Security Policies.
 */
export function evaluateFirewallZonePolicyAndSpi(
  firewallNode: NetworkNode,
  ingressPort: NetworkInterface | undefined,
  ingressSub: RouterSubinterface | undefined,
  egressPort: NetworkInterface | undefined,
  egressSub: RouterSubinterface | undefined,
  packet: {
    protocol: ProtocolType;
    srcIp: string;
    dstIp: string;
    originalDstIp?: string;
    srcPort?: number;
    dstPort?: number;
    matchedPortForward?: FirewallPortForwardRule;
    matchedIpsecTunnel?: IpsecTunnelConfig;
  }
): {
  allowed: boolean;
  fromZone: FirewallZoneName;
  fromLevel: number;
  toZone: FirewallZoneName;
  toLevel: number;
  reason: string;
  decisionTitle: string;
  osiActionTitle: string;
  osiActionDetail: string;
} {
  const cfg = firewallNode.firewallConfig;
  const inInfo = getInterfaceSecurityZoneAndLevel(ingressPort, ingressSub);
  const outInfo = getInterfaceSecurityZoneAndLevel(egressPort, egressSub);
  const fromZone = inInfo.zone;
  const fromLevel = inInfo.level;
  const toZone = outInfo.zone;
  const toLevel = outInfo.level;

  if (!cfg || !cfg.enabled) {
    return {
      allowed: true,
      fromZone,
      fromLevel,
      toZone,
      toLevel,
      reason: 'firewall_disabled',
      decisionTitle: `${firewallNode.name}: Межсетевой экран выключен — пакет пропущен`,
      osiActionTitle: 'Межсетевой экран (Bypass)',
      osiActionDetail: 'Инспекция межсетевого экрана отключена.',
    };
  }

  if (!Array.isArray(cfg.statefulSessions)) {
    cfg.statefulSessions = [];
  }

  const spiProto = mapProtocolToSpiCategory(packet.protocol);
  const srcPort = packet.srcPort || 49152;
  const dstPort = packet.dstPort || 80;

  const recordOrUpdateSpiSession = (
    initIp: string,
    respIp: string,
    initZone: FirewallZoneName,
    respZone: FirewallZoneName,
    initLvl: number,
    respLvl: number
  ) => {
    if (!cfg.spiEnabled) return;
    const existing = cfg.statefulSessions.find(
      (s) =>
        s.protocol === spiProto &&
        ((s.initiatorIp === initIp && s.responderIp === respIp) ||
          (s.initiatorIp === respIp && s.responderIp === initIp))
    );
    if (existing) {
      existing.packetsCount += 1;
      existing.state = 'ESTABLISHED';
    } else {
      cfg.statefulSessions.push({
        id: `spi-${Date.now()}-${cfg.statefulSessions.length + 1}`,
        protocol: spiProto,
        initiatorIp: initIp,
        initiatorPort: srcPort,
        responderIp: respIp,
        responderPort: dstPort,
        initiatorZone: initZone,
        responderZone: respZone,
        initiatorLevel: initLvl,
        responderLevel: respLvl,
        state:
          spiProto === 'ICMP'
            ? 'ECHO_ACTIVE'
            : spiProto === 'UDP'
            ? 'UDP_ACTIVE'
            : 'ESTABLISHED',
        packetsCount: 1,
      });
    }
  };

  // 1. Site-to-Site IPsec VPN Tunnel Traffic
  if (packet.matchedIpsecTunnel) {
    const tun = packet.matchedIpsecTunnel;
    if (toZone === 'outside') {
      tun.packetsEncrypted = (tun.packetsEncrypted || 0) + 1;
    } else {
      tun.packetsDecrypted = (tun.packetsDecrypted || 0) + 1;
    }
    recordOrUpdateSpiSession(
      packet.srcIp,
      packet.dstIp,
      fromZone,
      toZone,
      fromLevel,
      toLevel
    );
    return {
      allowed: true,
      fromZone,
      fromLevel,
      toZone,
      toLevel,
      reason: 'ipsec_vpn',
      decisionTitle: `${firewallNode.name}: Site-to-Site IPsec VPN (${tun.tunnelName}) — шифрованный туннель ${tun.localPublicIp} ⇄ ${tun.peerPublicIp} (${tun.cryptoSuite})`,
      osiActionTitle: `Криптотуннель Site-to-Site IPsec VPN (${tun.ikeVersion} / ESP)`,
      osiActionDetail: `Пакет ${packet.protocol} (${packet.srcIp} → ${packet.dstIp}) защищён туннелем «${tun.tunnelName}» (${tun.cryptoSuite}). Переход между зонами ${getZoneLabelRu(fromZone, fromLevel)} → ${getZoneLabelRu(toZone, toLevel)} разрешён криптографической политикой IPsec SA.`,
    };
  }

  // 2. Port Forwarding (Static NAT / DNAT) into DMZ or Inside
  if (packet.matchedPortForward) {
    const pf = packet.matchedPortForward;
    recordOrUpdateSpiSession(
      packet.srcIp,
      packet.dstIp,
      fromZone,
      toZone,
      fromLevel,
      toLevel
    );
    return {
      allowed: true,
      fromZone,
      fromLevel,
      toZone,
      toLevel,
      reason: 'port_forward',
      decisionTitle: `${firewallNode.name}: Разрешён Port Forwarding (DNAT) из ${getZoneLabelRu(fromZone, fromLevel)} в ${getZoneLabelRu(toZone, toLevel)} → ${pf.internalIp}:${pf.internalPort}`,
      osiActionTitle: `Публикация сервера в DMZ — Port Forwarding (${pf.name})`,
      osiActionDetail: `Входящее соединение на внешний адрес ${packet.originalDstIp || pf.externalIp}:${pf.externalPort} транслировано на внутренний сервер ${pf.internalIp}:${pf.internalPort} в зоне ${getZoneLabelRu(toZone, toLevel)} и внесено в таблицу состояний SPI.`,
    };
  }

  // 3. Stateful Packet Inspection (SPI) Return Traffic Check (e.g., Outside 0 -> Inside 100 for established outbound connection)
  if (cfg.spiEnabled) {
    const matchingSpi = [...cfg.statefulSessions].reverse().find(
      (s) =>
        (s.protocol === spiProto ||
          (s.protocol === 'HTTP' && spiProto === 'TCP') ||
          (s.protocol === 'TCP' && spiProto === 'HTTP')) &&
        ((s.initiatorIp === packet.dstIp && s.responderIp === packet.srcIp) ||
          (s.initiatorIp === packet.srcIp && s.responderIp === packet.dstIp) ||
          isReturnTraffic(packet.protocol))
    );

    if (matchingSpi && (isReturnTraffic(packet.protocol) || fromLevel < toLevel)) {
      matchingSpi.packetsCount += 1;
      matchingSpi.state = 'ESTABLISHED';
      return {
        allowed: true,
        fromZone,
        fromLevel,
        toZone,
        toLevel,
        reason: 'spi_return',
        decisionTitle: `${firewallNode.name}: Stateful Packet Inspection (SPI) разрешил ответный пакет ${packet.protocol} (${getZoneLabelRu(fromZone, fromLevel)} → ${getZoneLabelRu(toZone, toLevel)})`,
        osiActionTitle: `Stateful Packet Inspection (SPI — Инспекция состояний)`,
        osiActionDetail: `Пакет ${packet.protocol} (${packet.srcIp} → ${packet.dstIp}) поступает из зоны с меньшим уровнем безопасности ${getZoneLabelRu(fromZone, fromLevel)} в зону ${getZoneLabelRu(toZone, toLevel)}, но соответствует активной сессии в таблице состояний SPI (${matchingSpi.initiatorIp} ↔ ${matchingSpi.responderIp}, статус ${matchingSpi.state}). Автоматически разрешён!`,
      };
    }
  }

  // 4. Explicit Security Policy Rules (ACL / NGFW Policy Table)
  const activePolicies = (cfg.policyRules || []).filter((r) => r.enabled);
  for (const rule of activePolicies) {
    const zoneMatch =
      (rule.fromZone === 'any' || rule.fromZone === fromZone) &&
      (rule.toZone === 'any' || rule.toZone === toZone);
    if (!zoneMatch) continue;

    let protoMatch = false;
    if (rule.protocol === 'ANY') protoMatch = true;
    else if (rule.protocol === 'ICMP') protoMatch = packet.protocol.startsWith('ICMP');
    else if (rule.protocol === 'TCP' || rule.protocol === 'HTTP')
      protoMatch = packet.protocol.startsWith('TCP') || packet.protocol.startsWith('HTTP');
    else if (rule.protocol === 'UDP' || rule.protocol === 'DNS')
      protoMatch = packet.protocol.startsWith('DNS') || packet.protocol.startsWith('DHCP');

    if (!protoMatch) continue;
    if (!matchesSubnetSpec(packet.srcIp, rule.srcIp)) continue;
    if (!matchesSubnetSpec(packet.dstIp, rule.dstIp)) continue;

    rule.hitCount = (rule.hitCount || 0) + 1;
    if (rule.action === 'permit') {
      recordOrUpdateSpiSession(
        packet.srcIp,
        packet.dstIp,
        fromZone,
        toZone,
        fromLevel,
        toLevel
      );
      return {
        allowed: true,
        fromZone,
        fromLevel,
        toZone,
        toLevel,
        reason: 'policy_permit',
        decisionTitle: `${firewallNode.name}: Разрешено политикой безопасности «${rule.name}» (${getZoneLabelRu(fromZone, fromLevel)} → ${getZoneLabelRu(toZone, toLevel)})`,
        osiActionTitle: `Политика безопасности межсетевого экрана (${rule.name})`,
        osiActionDetail: `Явное разрешающее правило (${rule.fromZone} → ${rule.toZone}, ${rule.protocol}) разрешило прохождение пакета и создало запись SPI.`,
      };
    } else {
      return {
        allowed: false,
        fromZone,
        fromLevel,
        toZone,
        toLevel,
        reason: 'policy_deny',
        decisionTitle: `Firewall ASA DROP на ${firewallNode.name}: заблокировано политикой «${rule.name}» (${getZoneLabelRu(fromZone, fromLevel)} → ${getZoneLabelRu(toZone, toLevel)})`,
        osiActionTitle: `Блокировка политикой межсетевого экрана (${rule.name})`,
        osiActionDetail: `Правило безопасности запретило передачу пакета ${packet.protocol} (${packet.srcIp} → ${packet.dstIp}) из зоны ${getZoneLabelRu(fromZone, fromLevel)} в зону ${getZoneLabelRu(toZone, toLevel)}.`,
      };
    }
  }

  // 5. Default Cisco ASA Security-Level Policy:
  // Higher security-level -> Lower security-level (e.g. Inside 100 -> DMZ 50, Inside 100 -> Outside 0, DMZ 50 -> Outside 0)
  if (
    fromLevel > toLevel ||
    (fromLevel === toLevel && cfg.sameSecurityTrafficPermit)
  ) {
    const inspectAllowed =
      (spiProto === 'TCP' && cfg.inspectTcp) ||
      (spiProto === 'HTTP' && (cfg.inspectHttp || cfg.inspectTcp)) ||
      (spiProto === 'UDP' && cfg.inspectUdp) ||
      (spiProto === 'ICMP' && cfg.inspectIcmp);

    if (cfg.spiEnabled && inspectAllowed) {
      recordOrUpdateSpiSession(
        packet.srcIp,
        packet.dstIp,
        fromZone,
        toZone,
        fromLevel,
        toLevel
      );
    }

    return {
      allowed: true,
      fromZone,
      fromLevel,
      toZone,
      toLevel,
      reason: 'higher_to_lower_zone',
      decisionTitle: `${firewallNode.name}: Исходящий трафик ${getZoneLabelRu(fromZone, fromLevel)} → ${getZoneLabelRu(toZone, toLevel)} разрешён (создана сессия SPI)`,
      osiActionTitle: `Контроль зон безопасности ASA (${getZoneLabelRu(fromZone, fromLevel)} → ${getZoneLabelRu(toZone, toLevel)})`,
      osiActionDetail: `По алгоритму Cisco ASA трафик из более доверенной зоны ${getZoneLabelRu(fromZone, fromLevel)} в менее доверенную зону ${getZoneLabelRu(toZone, toLevel)} разрешён. Инспектор SPI (${spiProto}) зарегистрировал соединение ${packet.srcIp} → ${packet.dstIp} для автоматического пропуска обратных пакетов.`,
    };
  }

  // 6. Lower security-level -> Higher security-level (e.g. Outside 0 -> Inside 100, Outside 0 -> DMZ 50 without DNAT, DMZ 50 -> Inside 100) -> DROP!
  return {
    allowed: false,
    fromZone,
    fromLevel,
    toZone,
    toLevel,
    reason: 'zone_security_drop',
    decisionTitle: `Firewall ASA DROP на ${firewallNode.name}: трафик ${packet.protocol} из зоны ${getZoneLabelRu(fromZone, fromLevel)} в защищённую зону ${getZoneLabelRu(toZone, toLevel)} заблокирован`,
    osiActionTitle: `Межсетевой экран ASA / NGFW — Блокировка межзонного перехода (${getZoneLabelRu(fromZone, fromLevel)} ✕ ${getZoneLabelRu(toZone, toLevel)})`,
    osiActionDetail: `Уровень безопасности входящего интерфейса ${getZoneLabelRu(fromZone, fromLevel)} ниже уровня целевой зоны ${getZoneLabelRu(toZone, toLevel)} (${fromLevel} < ${toLevel}). Для пакета ${packet.srcIp} → ${packet.dstIp} нет ни активной сессии в таблице SPI, ни правила Port Forwarding (DNAT). Пакет уничтожен.`,
  };
}

/**
 * Synthesizes visual simulation steps for Site-to-Site IPsec VPN (IKEv2 Phase 1/2 SA negotiation + Encrypted IPSEC_ESP Tunnel packet)
 * between two firewalls across the WAN.
 */
export function synthesizeIpsecVpnSteps(
  nodes: NetworkNode[],
  links: NetworkLink[],
  startStepIndex: number = 1,
  startTimestampMs: number = 0
): SimulationStep[] {
  const steps: SimulationStep[] = [];
  let stepCounter = startStepIndex;
  let timeMs = startTimestampMs;

  const firewalls = nodes.filter(
    (n) =>
      isFirewallNode(n) &&
      (n.firewallConfig?.ipsecTunnels?.filter((t) => t.enabled && t.status === 'UP')
        .length || 0) > 0
  );

  if (firewalls.length === 0) return steps;

  const fwA = firewalls[0];
  const tunA = fwA.firewallConfig!.ipsecTunnels.find(
    (t) => t.enabled && t.status === 'UP'
  )!;
  const fwB =
    firewalls.find(
      (f) =>
        f.id !== fwA.id &&
        f.interfaces.some((i) => i.ipAddress === tunA.peerPublicIp)
    ) || firewalls[1];

  const outPortA =
    fwA.interfaces.find(
      (i) => i.shortName === tunA.localInterface || i.securityZone === 'outside'
    ) || fwA.interfaces[0];

  const wanLinkA = links.find(
    (l) => l.sourceNodeId === fwA.id || l.targetNodeId === fwA.id
  );
  const hopNodeId = wanLinkA
    ? wanLinkA.sourceNodeId === fwA.id
      ? wanLinkA.targetNodeId
      : wanLinkA.sourceNodeId
    : fwB?.id || fwA.id;
  const hopNode = nodes.find((n) => n.id === hopNodeId) || fwB || fwA;

  // Step 1: IKEv2 SA_INIT / IKE_AUTH negotiation (UDP 500)
  const ikePdu: OsiPduDetails = {
    l1: {
      inPort: 'Crypto Engine (IKEv2)',
      outPort: outPortA?.shortName || 'Gi0/2',
      cableType: 'fiber',
      physicalStatus: 'UP',
    },
    l2: {
      headerType: 'Ethernet II',
      srcMac: outPortA?.macAddress || '00:1A:2B:AA:BB:01',
      dstMac: hopNode.interfaces[0]?.macAddress || '00:1A:2B:CC:DD:02',
      etherType: '0x0800 (IPv4)',
      vlanTag: null,
    },
    l3: {
      headerType: 'IPv4',
      srcIp: tunA.localPublicIp,
      dstIp: tunA.peerPublicIp,
      ttl: 64,
      protocol: 'UDP (17)',
    },
    l4: {
      type: 'IKEV2',
      summary: `IKEv2 IKE_SA_INIT + IKE_AUTH (UDP 500): ${tunA.localPublicIp} ⇄ ${tunA.peerPublicIp} [${tunA.cryptoSuite}]`,
      seqNumber: 1,
      srcPort: 500,
      dstPort: 500,
    },
    l7: {
      appProtocol: 'IKEV2',
      headline: `IKEv2 Security Association (${tunA.tunnelName})`,
      fields: {
        'IKE Version': tunA.ikeVersion,
        'Crypto Suite': tunA.cryptoSuite,
        'Local Protected Subnet': tunA.localSubnet,
        'Remote Protected Subnet': tunA.remoteSubnet,
        'Authentication': 'Pre-Shared Key (PSK Verified)',
      },
    },
  };

  steps.push({
    id: `step-${stepCounter}`,
    stepIndex: stepCounter,
    timestampMs: timeMs + 180,
    fromNodeId: fwA.id,
    fromNodeName: fwA.name,
    fromPortName: outPortA?.shortName || 'Gi0/2',
    toNodeId: hopNode.id,
    toNodeName: hopNode.name,
    toPortName: hopNode.interfaces[0]?.shortName || 'Gi0/0',
    linkId: wanLinkA?.id || '',
    protocol: 'IKEV2',
    status: 'delivered',
    vlanTag: null,
    inboundPdu: ikePdu,
    outboundPdu: ikePdu,
    decisionTitle: `${fwA.name} → ${fwB ? fwB.name : tunA.peerPublicIp}: Согласование ключей IKEv2 SA (UDP 500, ${tunA.cryptoSuite})`,
    osiActions: [
      {
        layer: 'L4',
        title: 'Протокол обмена ключами IKEv2 (UDP 500)',
        detail: `Установлены криптографические ключи Диффи-Хеллмана и проверен Pre-Shared Key между ${tunA.localPublicIp} и ${tunA.peerPublicIp}.`,
      },
      {
        layer: 'L7',
        title: `IPsec Phase 1 & Phase 2 Active (${tunA.tunnelName})`,
        detail: `Защищаемые подсети: ${tunA.localSubnet} ⇄ ${tunA.remoteSubnet}. Статус туннеля: UP.`,
      },
    ],
  });
  stepCounter++;
  timeMs += 180;

  // Step 2: IPsec ESP Encrypted Tunnel Packet (IP Protocol 50)
  const espPdu: OsiPduDetails = {
    l1: {
      inPort: 'IPsec Crypto Engine (ESP)',
      outPort: outPortA?.shortName || 'Gi0/2',
      cableType: 'fiber',
      physicalStatus: 'UP',
    },
    l2: {
      headerType: 'Ethernet II',
      srcMac: outPortA?.macAddress || '00:1A:2B:AA:BB:01',
      dstMac: hopNode.interfaces[0]?.macAddress || '00:1A:2B:CC:DD:02',
      etherType: '0x0800 (IPv4)',
      vlanTag: null,
    },
    l3: {
      headerType: 'IPsec ESP Packet (IP Proto 50)',
      srcIp: tunA.localPublicIp,
      dstIp: tunA.peerPublicIp,
      ttl: 63,
      protocol: 'ESP (50)',
    },
    l4: {
      type: 'IPSEC_ESP',
      summary: `IPsec ESP Tunnel [SPI 0x9F4A2C11]: Outer(${tunA.localPublicIp} → ${tunA.peerPublicIp}) | Inner Encrypted(${tunA.localSubnet} → ${tunA.remoteSubnet})`,
      seqNumber: 2,
    },
    l7: {
      appProtocol: 'IPSEC',
      headline: `Encapsulating Security Payload — Шифрованный пакет ESP (${tunA.cryptoSuite})`,
      fields: {
        'Outer IP Header': `${tunA.localPublicIp} → ${tunA.peerPublicIp} (WAN Outside)`,
        'Encrypted Inner Payload': `${tunA.localSubnet} → ${tunA.remoteSubnet} (AES-256-GCM Ciphertext)`,
        'ESP SPI / Integrity': '0x9F4A2C11 / SHA-256 HMAC Verified',
      },
    },
  };

  steps.push({
    id: `step-${stepCounter}`,
    stepIndex: stepCounter,
    timestampMs: timeMs + 180,
    fromNodeId: fwA.id,
    fromNodeName: fwA.name,
    fromPortName: outPortA?.shortName || 'Gi0/2',
    toNodeId: hopNode.id,
    toNodeName: hopNode.name,
    toPortName: hopNode.interfaces[0]?.shortName || 'Gi0/0',
    linkId: wanLinkA?.id || '',
    protocol: 'IPSEC_ESP',
    status: 'delivered',
    vlanTag: null,
    inboundPdu: espPdu,
    outboundPdu: espPdu,
    decisionTitle: `${fwA.name}: Инкапсуляция и шифрование пакета в туннель IPsec ESP (${tunA.localPublicIp} → ${tunA.peerPublicIp})`,
    osiActions: [
      {
        layer: 'L3',
        title: 'IPsec Tunnel Mode Encapsulation (IP Protocol 50 — ESP)',
        detail: `Оригинальный IP-пакет между локальными сетями (${tunA.localSubnet} → ${tunA.remoteSubnet}) полностью зашифрован алгоритмом ${tunA.cryptoSuite} и помещён внутрь внешнего IP-заголовка ${tunA.localPublicIp} → ${tunA.peerPublicIp}.`,
      },
    ],
  });

  return steps;
}
