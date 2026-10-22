import {
  ArpEntry,
  DhcpPool,
  HttpResponseResult,
  MacTableEntry,
  NetworkInterface,
  NetworkLink,
  NetworkNode,
  OsiPduDetails,
  ProtocolType,
  RouteEntry,
  SimulationStep,
  StepStatus,
  TracerouteHop,
} from './types';
import {
  getNetworkAddress,
  intToIp,
  ipToInt,
  isSameSubnet,
  isValidIpv4,
  maskToCidr,
} from './ipMath';

export const BROADCAST_MAC = 'FF:FF:FF:FF:FF:FF';
export const BROADCAST_IP = '255.255.255.255';

/**
 * Automatically builds Connected ('C') routes from active interfaces with IPv4 addresses,
 * preserving Static ('S') routes configured by the user.
 */
export function syncConnectedRoutes(node: NetworkNode): RouteEntry[] {
  const staticRoutes = node.routingTable.filter((r) => r.type === 'S');
  const connectedRoutes: RouteEntry[] = [];

  for (const iface of node.interfaces) {
    if (iface.adminStatus === 'up' && isValidIpv4(iface.ipAddress) && isValidIpv4(iface.subnetMask)) {
      const network = getNetworkAddress(iface.ipAddress, iface.subnetMask);
      connectedRoutes.push({
        id: `conn-${iface.id}`,
        network,
        mask: iface.subnetMask,
        nextHop: 'Directly Connected',
        interfaceName: iface.shortName,
        type: 'C',
      });
    }
  }

  return [...connectedRoutes, ...staticRoutes];
}

/**
 * Longest Prefix Match (LPM) lookup on a router's routing table.
 */
export function findBestRoute(node: NetworkNode, dstIp: string): RouteEntry | null {
  if (!isValidIpv4(dstIp)) return null;
  const routes = syncConnectedRoutes(node);
  let bestRoute: RouteEntry | null = null;
  let longestPrefix = -1;

  for (const route of routes) {
    if (!isValidIpv4(route.network) || !isValidIpv4(route.mask)) continue;
    if (isSameSubnet(dstIp, route.network, route.mask)) {
      const prefixLen = maskToCidr(route.mask);
      if (
        prefixLen > longestPrefix ||
        (prefixLen === longestPrefix && bestRoute?.type === 'S' && route.type === 'C')
      ) {
        longestPrefix = prefixLen;
        bestRoute = route;
      }
    }
  }

  return bestRoute;
}

/**
 * Finds the active link connected to a specific node and port.
 */
export function getConnectedPeer(
  nodeId: string,
  portId: string,
  nodes: NetworkNode[],
  links: NetworkLink[]
): { link: NetworkLink; peerNode: NetworkNode; peerPort: NetworkInterface } | null {
  const link = links.find(
    (l) =>
      (l.sourceNodeId === nodeId && l.sourcePortId === portId) ||
      (l.targetNodeId === nodeId && l.targetPortId === portId)
  );
  if (!link) return null;

  const isSource = link.sourceNodeId === nodeId && link.sourcePortId === portId;
  const peerNodeId = isSource ? link.targetNodeId : link.sourceNodeId;
  const peerPortId = isSource ? link.targetPortId : link.sourcePortId;

  const peerNode = nodes.find((n) => n.id === peerNodeId);
  if (!peerNode) return null;
  const peerPort = peerNode.interfaces.find((p) => p.id === peerPortId);
  if (!peerPort) return null;

  return { link, peerNode, peerPort };
}

/**
 * Checks if a link is physically operational (both end ports are administratively UP).
 */
export function isLinkOperational(link: NetworkLink, nodes: NetworkNode[]): boolean {
  const srcNode = nodes.find((n) => n.id === link.sourceNodeId);
  const dstNode = nodes.find((n) => n.id === link.targetNodeId);
  if (!srcNode || !dstNode) return false;
  const srcPort = srcNode.interfaces.find((p) => p.id === link.sourcePortId);
  const dstPort = dstNode.interfaces.find((p) => p.id === link.targetPortId);
  if (!srcPort || !dstPort) return false;
  return srcPort.adminStatus === 'up' && dstPort.adminStatus === 'up';
}

export interface SimulationRunResult {
  steps: SimulationStep[];
  updatedNodes: NetworkNode[];
  success: boolean;
  summaryMessage: string;
  tracerouteHops?: TracerouteHop[];
  httpResult?: HttpResponseResult;
  assignedDhcpConfig?: {
    ipAddress: string;
    subnetMask: string;
    defaultGateway: string;
    dnsServer: string;
    serverName: string;
  };
}

function cloneNodes(nodes: NetworkNode[]): NetworkNode[] {
  return JSON.parse(JSON.stringify(nodes));
}

function learnArp(node: NetworkNode, ip: string, mac: string, interfaceName: string, vlan?: number) {
  if (!isValidIpv4(ip) || ip === '0.0.0.0' || ip === BROADCAST_IP || !mac || mac === BROADCAST_MAC) return;
  const existing = node.arpTable.find((a) => a.ipAddress === ip);
  if (existing) {
    existing.macAddress = mac;
    existing.interfaceName = interfaceName;
    if (vlan !== undefined) existing.vlan = vlan;
  } else {
    node.arpTable.push({ ipAddress: ip, macAddress: mac, interfaceName, vlan });
  }
}

function learnMac(switchNode: NetworkNode, mac: string, portName: string, vlan: number) {
  if (!mac || mac === BROADCAST_MAC) return;
  const existing = switchNode.macTable.find((m) => m.macAddress === mac && m.vlan === vlan);
  if (existing) {
    existing.portName = portName;
  } else {
    switchNode.macTable.push({
      macAddress: mac,
      portName,
      vlan,
      type: 'DYNAMIC',
    });
  }
}

function getL3ProtocolName(proto: ProtocolType, etherType: '0x0800 (IPv4)' | '0x0806 (ARP)'): string {
  if (etherType === '0x0806 (ARP)') return 'ARP (0x0806)';
  if (proto.startsWith('DHCP') || proto.startsWith('DNS')) return 'UDP (17)';
  if (proto.startsWith('TCP') || proto.startsWith('HTTP')) return 'TCP (6)';
  return 'ICMP (1)';
}

function getPortNumbers(proto: ProtocolType): { srcPort?: number; dstPort?: number } {
  switch (proto) {
    case 'DHCP_DISCOVER':
    case 'DHCP_REQUEST':
      return { srcPort: 68, dstPort: 67 };
    case 'DHCP_OFFER':
    case 'DHCP_ACK':
      return { srcPort: 67, dstPort: 68 };
    case 'DNS_QUERY':
      return { srcPort: 54120, dstPort: 53 };
    case 'DNS_RESPONSE':
      return { srcPort: 53, dstPort: 54120 };
    case 'TCP_SYN':
    case 'TCP_ACK':
    case 'HTTP_GET':
      return { srcPort: 49152, dstPort: 80 };
    case 'TCP_SYN_ACK':
    case 'HTTP_200_OK':
      return { srcPort: 80, dstPort: 49152 };
    default:
      return {};
  }
}

function buildPduDetails(params: {
  inPort: string;
  outPort: string;
  cableType: string;
  physicalStatus: string;
  srcMac: string;
  dstMac: string;
  etherType: '0x0800 (IPv4)' | '0x0806 (ARP)';
  vlanTag: number | null;
  srcIp: string;
  dstIp: string;
  ttl: number;
  protocol: ProtocolType;
  summary: string;
  seqNumber?: number;
  l7?: OsiPduDetails['l7'];
}): OsiPduDetails {
  const isArp = params.etherType === '0x0806 (ARP)';
  const ports = getPortNumbers(params.protocol);
  return {
    l1: {
      inPort: params.inPort,
      outPort: params.outPort,
      cableType: params.cableType,
      physicalStatus: params.physicalStatus,
    },
    l2: {
      headerType: params.vlanTag !== null ? 'IEEE 802.1Q' : 'Ethernet II',
      srcMac: params.srcMac,
      dstMac: params.dstMac,
      etherType: params.etherType,
      vlanTag: params.vlanTag,
    },
    l3: {
      headerType: isArp ? 'ARP Payload' : 'IPv4',
      srcIp: params.srcIp,
      dstIp: params.dstIp,
      ttl: params.ttl,
      protocol: getL3ProtocolName(params.protocol, params.etherType),
    },
    l4: {
      type: params.protocol,
      summary: params.summary,
      seqNumber: params.seqNumber ?? 1,
      srcPort: ports.srcPort,
      dstPort: ports.dstPort,
    },
    l7: params.l7,
  };
}

interface FramePropagationItem {
  currentNodeId: string;
  egressPortId: string;
  srcMac: string;
  dstMac: string;
  srcIp: string;
  dstIp: string;
  vlan: number;
  isTaggedOnWire: boolean;
  etherType: '0x0800 (IPv4)' | '0x0806 (ARP)';
  protocol: ProtocolType;
  ttl: number;
  summary: string;
  l7?: OsiPduDetails['l7'];
  inboundPduAtCurrentNode: OsiPduDetails;
}

/**
 * Propagates a single L2 frame through switches until it reaches target L3 interfaces or gets dropped.
 */
function propagateL2Frame(
  initialItem: FramePropagationItem,
  nodes: NetworkNode[],
  links: NetworkLink[],
  steps: SimulationStep[],
  visitedSwitchPorts: Set<string>
): { deliveredToNodes: { node: NetworkNode; port: NetworkInterface; vlan: number }[] } {
  const queue: FramePropagationItem[] = [initialItem];
  const deliveredToNodes: { node: NetworkNode; port: NetworkInterface; vlan: number }[] = [];

  while (queue.length > 0) {
    const item = queue.shift()!;
    const senderNode = nodes.find((n) => n.id === item.currentNodeId);
    if (!senderNode) continue;
    const senderPort = senderNode.interfaces.find((p) => p.id === item.egressPortId);
    if (!senderPort || senderPort.adminStatus !== 'up') continue;

    const peerInfo = getConnectedPeer(senderNode.id, senderPort.id, nodes, links);
    if (!peerInfo) continue;

    const { link, peerNode, peerPort } = peerInfo;
    const visitKey = `${link.id}:${senderNode.id}->${peerNode.id}:${item.protocol}:${steps.length}`;
    if (visitedSwitchPorts.has(`${link.id}:${senderNode.id}->${peerNode.id}:${item.protocol}`)) continue;
    visitedSwitchPorts.add(`${link.id}:${senderNode.id}->${peerNode.id}:${item.protocol}`);
    void visitKey;

    if (peerPort.adminStatus !== 'up') {
      const pdu = buildPduDetails({
        inPort: senderPort.shortName,
        outPort: peerPort.shortName,
        cableType: link.cableType,
        physicalStatus: 'DOWN (Administratively Shutdown)',
        srcMac: item.srcMac,
        dstMac: item.dstMac,
        etherType: item.etherType,
        vlanTag: item.isTaggedOnWire ? item.vlan : null,
        srcIp: item.srcIp,
        dstIp: item.dstIp,
        ttl: item.ttl,
        protocol: item.protocol,
        summary: item.summary,
        l7: item.l7,
      });

      steps.push({
        id: `step-${steps.length + 1}`,
        stepIndex: steps.length + 1,
        timestampMs: (steps.length + 1) * 180,
        fromNodeId: senderNode.id,
        fromNodeName: senderNode.name,
        fromPortName: senderPort.shortName,
        toNodeId: peerNode.id,
        toNodeName: peerNode.name,
        toPortName: peerPort.shortName,
        linkId: link.id,
        protocol: item.protocol,
        status: 'dropped',
        vlanTag: item.isTaggedOnWire ? item.vlan : null,
        inboundPdu: item.inboundPduAtCurrentNode,
        outboundPdu: pdu,
        decisionTitle: `Пакет отброшен: порт ${peerNode.name}:${peerPort.shortName} выключен (shutdown)`,
        osiActions: [
          {
            layer: 'L1',
            title: 'Физический уровень (L1)',
            detail: `Интерфейс ${peerPort.name} на устройстве ${peerNode.name} находится в состоянии Administratively Down.`,
          },
        ],
        nodeSnapshotAfter: {
          arpTable: JSON.parse(JSON.stringify(peerNode.arpTable)),
          macTable: JSON.parse(JSON.stringify(peerNode.macTable)),
        },
      });
      continue;
    }

    if (peerNode.type === 'switch') {
      let ingressVlan = item.vlan;
      if (peerPort.vlanMode === 'access') {
        ingressVlan = peerPort.accessVlan || 1;
      } else if (peerPort.vlanMode === 'trunk') {
        if (!peerPort.trunkAllowedVlans.includes(item.vlan)) {
          const dropPdu = buildPduDetails({
            inPort: peerPort.shortName,
            outPort: 'DROP (VLAN Filter)',
            cableType: link.cableType,
            physicalStatus: 'UP',
            srcMac: item.srcMac,
            dstMac: item.dstMac,
            etherType: item.etherType,
            vlanTag: item.vlan,
            srcIp: item.srcIp,
            dstIp: item.dstIp,
            ttl: item.ttl,
            protocol: item.protocol,
            summary: item.summary,
            l7: item.l7,
          });
          steps.push({
            id: `step-${steps.length + 1}`,
            stepIndex: steps.length + 1,
            timestampMs: (steps.length + 1) * 180,
            fromNodeId: senderNode.id,
            fromNodeName: senderNode.name,
            fromPortName: senderPort.shortName,
            toNodeId: peerNode.id,
            toNodeName: peerNode.name,
            toPortName: peerPort.shortName,
            linkId: link.id,
            protocol: item.protocol,
            status: 'dropped',
            vlanTag: item.vlan,
            inboundPdu: item.inboundPduAtCurrentNode,
            outboundPdu: dropPdu,
            decisionTitle: `Отброшено на Trunk-порту ${peerNode.name}:${peerPort.shortName} (VLAN ${item.vlan} не разрешён)`,
            osiActions: [
              {
                layer: 'L2',
                title: 'Фильтрация 802.1Q Trunk',
                detail: `Кадр с тегом VLAN ${item.vlan} поступил на Trunk-порт ${peerPort.shortName}, где разрешены только VLAN: ${peerPort.trunkAllowedVlans.join(', ')}.`,
              },
            ],
            nodeSnapshotAfter: {
              arpTable: JSON.parse(JSON.stringify(peerNode.arpTable)),
              macTable: JSON.parse(JSON.stringify(peerNode.macTable)),
            },
          });
          continue;
        }
      }

      learnMac(peerNode, item.srcMac, peerPort.shortName, ingressVlan);

      const camMatch =
        item.dstMac !== BROADCAST_MAC
          ? peerNode.macTable.find((m) => m.macAddress === item.dstMac && m.vlan === ingressVlan)
          : undefined;

      const inboundAtSwitch = buildPduDetails({
        inPort: peerPort.shortName,
        outPort: camMatch ? camMatch.portName : 'Flood (VLAN ' + ingressVlan + ')',
        cableType: link.cableType,
        physicalStatus: 'UP (1000BASE-T)',
        srcMac: item.srcMac,
        dstMac: item.dstMac,
        etherType: item.etherType,
        vlanTag: item.isTaggedOnWire ? ingressVlan : null,
        srcIp: item.srcIp,
        dstIp: item.dstIp,
        ttl: item.ttl,
        protocol: item.protocol,
        summary: item.summary,
        l7: item.l7,
      });

      const stepStatus: StepStatus = item.dstMac === BROADCAST_MAC || !camMatch ? 'broadcast' : 'forwarded';

      steps.push({
        id: `step-${steps.length + 1}`,
        stepIndex: steps.length + 1,
        timestampMs: (steps.length + 1) * 180,
        fromNodeId: senderNode.id,
        fromNodeName: senderNode.name,
        fromPortName: senderPort.shortName,
        toNodeId: peerNode.id,
        toNodeName: peerNode.name,
        toPortName: peerPort.shortName,
        linkId: link.id,
        protocol: item.protocol,
        status: stepStatus,
        vlanTag: item.isTaggedOnWire ? ingressVlan : null,
        inboundPdu: item.inboundPduAtCurrentNode,
        outboundPdu: inboundAtSwitch,
        decisionTitle: camMatch
          ? `${peerNode.name}: Unicast-коммутация по MAC-таблице в порт ${camMatch.portName} (VLAN ${ingressVlan})`
          : `${peerNode.name}: Лавинная рассылка (Flooding) кадра во все активные порты VLAN ${ingressVlan}`,
        osiActions: [
          {
            layer: 'L1',
            title: `Приём битового потока на порт ${peerPort.shortName}`,
            detail: `Физический линк ${senderNode.name}:${senderPort.shortName} ↔ ${peerNode.name}:${peerPort.shortName} активен.`,
          },
          {
            layer: 'L2',
            title: `Обучение CAM-таблицы (MAC Learning)`,
            detail: `Коммутатор ${peerNode.name} записал MAC источника ${item.srcMac} за портом ${peerPort.shortName} в VLAN ${ingressVlan}.`,
          },
          {
            layer: 'L2',
            title: camMatch ? `Найдено соответствие в MAC-таблице` : `Широковещательная / Unknown Unicast рассылка`,
            detail: camMatch
              ? `Адрес назначения ${item.dstMac} найден на порту ${camMatch.portName} (VLAN ${ingressVlan}). Кадр направляется строго в этот порт.`
              : `Адрес назначения ${item.dstMac} широковещательный или отсутствует в таблице MAC. Кадр дублируется во все порты VLAN ${ingressVlan}, кроме входящего ${peerPort.shortName}.`,
          },
        ],
        nodeSnapshotAfter: {
          arpTable: JSON.parse(JSON.stringify(peerNode.arpTable)),
          macTable: JSON.parse(JSON.stringify(peerNode.macTable)),
        },
      });

      for (const swOutPort of peerNode.interfaces) {
        if (swOutPort.id === peerPort.id || swOutPort.adminStatus !== 'up') continue;
        if (camMatch && swOutPort.shortName !== camMatch.portName) continue;

        const isOutTrunk = swOutPort.vlanMode === 'trunk';
        if (!isOutTrunk && (swOutPort.accessVlan || 1) !== ingressVlan) {
          continue;
        }
        if (isOutTrunk && !swOutPort.trunkAllowedVlans.includes(ingressVlan)) {
          continue;
        }

        queue.push({
          currentNodeId: peerNode.id,
          egressPortId: swOutPort.id,
          srcMac: item.srcMac,
          dstMac: item.dstMac,
          srcIp: item.srcIp,
          dstIp: item.dstIp,
          vlan: ingressVlan,
          isTaggedOnWire: isOutTrunk,
          etherType: item.etherType,
          protocol: item.protocol,
          ttl: item.ttl,
          summary: item.summary,
          l7: item.l7,
          inboundPduAtCurrentNode: inboundAtSwitch,
        });
      }
    } else {
      const receiverVlan = peerPort.vlanMode === 'access' ? peerPort.accessVlan || 1 : item.vlan;
      const isMacMatch = item.dstMac === BROADCAST_MAC || item.dstMac === peerPort.macAddress;
      const isTargetIp = item.dstIp === peerPort.ipAddress || item.dstIp === BROADCAST_IP;

      if (isMacMatch && isValidIpv4(item.srcIp) && item.srcIp !== '0.0.0.0') {
        learnArp(peerNode, item.srcIp, item.srcMac, peerPort.shortName, receiverVlan);
      }

      // Check DHCP server acceptance on broadcast
      const isDhcpToServer =
        (item.protocol === 'DHCP_DISCOVER' || item.protocol === 'DHCP_REQUEST') &&
        Boolean(peerNode.services?.dhcpEnabled) &&
        (peerNode.services?.dhcpPools?.length ?? 0) > 0;

      const isDhcpToClient =
        (item.protocol === 'DHCP_OFFER' || item.protocol === 'DHCP_ACK') &&
        isMacMatch;

      const willAccept =
        isDhcpToServer ||
        isDhcpToClient ||
        (isMacMatch &&
          (item.etherType !== '0x0806 (ARP)' || isTargetIp || item.protocol === 'ARP_REPLY'));

      const stepStatus: StepStatus = !willAccept
        ? 'dropped'
        : isDhcpToServer || isDhcpToClient || isTargetIp
        ? 'delivered'
        : 'forwarded';

      const outPdu = buildPduDetails({
        inPort: peerPort.shortName,
        outPort: willAccept ? 'Upper OSI Layers (L3–L7)' : 'Discard (Not for this host)',
        cableType: link.cableType,
        physicalStatus: 'UP',
        srcMac: item.srcMac,
        dstMac: item.dstMac,
        etherType: item.etherType,
        vlanTag: item.isTaggedOnWire ? item.vlan : null,
        srcIp: item.srcIp,
        dstIp: item.dstIp,
        ttl: item.ttl,
        protocol: item.protocol,
        summary: item.summary,
        l7: item.l7,
      });

      const osiActions: SimulationStep['osiActions'] = [
        {
          layer: 'L1',
          title: `Приём кадра на интерфейс ${peerPort.shortName}`,
          detail: `Сигнал принят устройством ${peerNode.name} (${peerPort.ipAddress || 'DHCP Client'}).`,
        },
        {
          layer: 'L2',
          title: `Проверка MAC-адреса назначения (${item.dstMac})`,
          detail: isMacMatch
            ? `MAC назначения совпадает с интерфейсом (${peerPort.macAddress}) или является Broadcast. Декапсуляция Ethernet-кадра.`
            : `MAC назначения ${item.dstMac} не принадлежит порту ${peerPort.macAddress}. Кадр отброшен.`,
        },
        {
          layer: 'L3',
          title: willAccept
            ? `Обработка пакета (${item.srcIp} → ${item.dstIp}, TTL=${item.ttl})`
            : `Фильтрация пакета на сетевом уровне`,
          detail: willAccept
            ? `Пакет принят сетевым стеком ${peerNode.name} и передан обработчику протокола ${item.protocol}.`
            : `Устройство ${peerNode.name} не является получателем ${item.dstIp} или не обслуживает данный широковещательный запрос.`,
        },
      ];

      if (willAccept && item.l7) {
        osiActions.push({
          layer: 'L7',
          title: `Прикладной уровень (${item.l7.appProtocol}): ${item.l7.headline}`,
          detail: Object.entries(item.l7.fields)
            .map(([k, v]) => `${k}: ${v}`)
            .join(' · '),
        });
      }

      steps.push({
        id: `step-${steps.length + 1}`,
        stepIndex: steps.length + 1,
        timestampMs: (steps.length + 1) * 180,
        fromNodeId: senderNode.id,
        fromNodeName: senderNode.name,
        fromPortName: senderPort.shortName,
        toNodeId: peerNode.id,
        toNodeName: peerNode.name,
        toPortName: peerPort.shortName,
        linkId: link.id,
        protocol: item.protocol,
        status: stepStatus,
        vlanTag: item.isTaggedOnWire ? item.vlan : null,
        inboundPdu: item.inboundPduAtCurrentNode,
        outboundPdu: outPdu,
        decisionTitle: willAccept
          ? `${peerNode.name} (${peerPort.shortName}) обработал пакет ${item.protocol}`
          : `${peerNode.name} (${peerPort.shortName}) отбросил кадр ${item.protocol} (адресован другому узлу)`,
        osiActions,
        nodeSnapshotAfter: {
          arpTable: JSON.parse(JSON.stringify(peerNode.arpTable)),
          macTable: JSON.parse(JSON.stringify(peerNode.macTable)),
        },
      });

      if (willAccept) {
        deliveredToNodes.push({ node: peerNode, port: peerPort, vlan: receiverVlan });
      }
    }
  }

  return { deliveredToNodes };
}

/**
 * Resolves next-hop IPv4 to MAC via ARP table or generates ARP Request + ARP Reply steps.
 */
function resolveNextHopArp(
  senderNode: NetworkNode,
  senderPort: NetworkInterface,
  nextHopIp: string,
  nodes: NetworkNode[],
  links: NetworkLink[],
  steps: SimulationStep[]
): string | null {
  const existingArp = senderNode.arpTable.find((a) => a.ipAddress === nextHopIp);
  if (existingArp) {
    return existingArp.macAddress;
  }

  const vlan = senderPort.accessVlan || 1;
  const arpReqSummary = `Who has ${nextHopIp}? Tell ${senderPort.ipAddress}`;
  const initialArpReqPdu = buildPduDetails({
    inPort: 'Internal ARP Stack',
    outPort: senderPort.shortName,
    cableType: 'straight',
    physicalStatus: 'UP',
    srcMac: senderPort.macAddress,
    dstMac: BROADCAST_MAC,
    etherType: '0x0806 (ARP)',
    vlanTag: senderPort.vlanMode === 'trunk' ? vlan : null,
    srcIp: senderPort.ipAddress,
    dstIp: nextHopIp,
    ttl: 64,
    protocol: 'ARP_REQUEST',
    summary: arpReqSummary,
  });

  const { deliveredToNodes } = propagateL2Frame(
    {
      currentNodeId: senderNode.id,
      egressPortId: senderPort.id,
      srcMac: senderPort.macAddress,
      dstMac: BROADCAST_MAC,
      srcIp: senderPort.ipAddress,
      dstIp: nextHopIp,
      vlan,
      isTaggedOnWire: senderPort.vlanMode === 'trunk',
      etherType: '0x0806 (ARP)',
      protocol: 'ARP_REQUEST',
      ttl: 64,
      summary: arpReqSummary,
      inboundPduAtCurrentNode: initialArpReqPdu,
    },
    nodes,
    links,
    steps,
    new Set()
  );

  const targetMatch = deliveredToNodes.find((d) => d.port.ipAddress === nextHopIp);
  if (!targetMatch) {
    return null;
  }

  const replySummary = `${nextHopIp} is at ${targetMatch.port.macAddress}`;
  const initialArpReplyPdu = buildPduDetails({
    inPort: 'Internal ARP Stack',
    outPort: targetMatch.port.shortName,
    cableType: 'straight',
    physicalStatus: 'UP',
    srcMac: targetMatch.port.macAddress,
    dstMac: senderPort.macAddress,
    etherType: '0x0806 (ARP)',
    vlanTag: targetMatch.port.vlanMode === 'trunk' ? targetMatch.vlan : null,
    srcIp: nextHopIp,
    dstIp: senderPort.ipAddress,
    ttl: 64,
    protocol: 'ARP_REPLY',
    summary: replySummary,
  });

  propagateL2Frame(
    {
      currentNodeId: targetMatch.node.id,
      egressPortId: targetMatch.port.id,
      srcMac: targetMatch.port.macAddress,
      dstMac: senderPort.macAddress,
      srcIp: nextHopIp,
      dstIp: senderPort.ipAddress,
      vlan: targetMatch.vlan,
      isTaggedOnWire: targetMatch.port.vlanMode === 'trunk',
      etherType: '0x0806 (ARP)',
      protocol: 'ARP_REPLY',
      ttl: 64,
      summary: replySummary,
      inboundPduAtCurrentNode: initialArpReplyPdu,
    },
    nodes,
    links,
    steps,
    new Set()
  );

  learnArp(senderNode, nextHopIp, targetMatch.port.macAddress, senderPort.shortName, vlan);
  return targetMatch.port.macAddress;
}

/**
 * Transmits an L3 IPv4 packet from originNode to dstIp across L2 switches and L3 routers,
 * supporting custom initial TTL and L7 metadata. If TTL expires on an intermediate router,
 * returns `ttlExpiredAtRouter` so Traceroute can emit ICMP_TIME_EXCEEDED back to origin.
 */
function transmitIpPacket(
  originNode: NetworkNode,
  dstIp: string,
  protocol: ProtocolType,
  nodes: NetworkNode[],
  links: NetworkLink[],
  steps: SimulationStep[],
  options?: {
    initialTtl?: number;
    customSummary?: string;
    l7?: OsiPduDetails['l7'];
  }
): {
  reachedTargetNode: NetworkNode | null;
  ttlExpiredAtRouter?: { router: NetworkNode; ingressPort: NetworkInterface };
  failureReason?: string;
} {
  let currentL3Node = originNode;
  const activeOriginPort = originNode.interfaces.find(
    (p) => p.adminStatus === 'up' && isValidIpv4(p.ipAddress)
  );
  if (!activeOriginPort) {
    return {
      reachedTargetNode: null,
      failureReason: `Устройство ${originNode.name} не имеет активного интерфейса с настроенным IPv4-адресом. Запустите DHCP (DORA) или задайте IP вручную.`,
    };
  }
  const currentSrcIp = activeOriginPort.ipAddress;

  let ttl = options?.initialTtl ?? 64;
  const maxHops = 8;

  for (let hop = 0; hop < maxHops; hop++) {
    const localMatchPort = currentL3Node.interfaces.find(
      (p) => p.adminStatus === 'up' && p.ipAddress === dstIp
    );
    if (localMatchPort && hop > 0) {
      return { reachedTargetNode: currentL3Node };
    }

    let egressPort: NetworkInterface | undefined;
    let nextHopIp = dstIp;

    if (currentL3Node.type === 'router') {
      const route = findBestRoute(currentL3Node, dstIp);
      if (!route) {
        return {
          reachedTargetNode: null,
          failureReason: `Маршрутизатор ${currentL3Node.name} не имеет маршрута к сети назначения ${dstIp} (Destination Net Unreachable).`,
        };
      }
      egressPort = currentL3Node.interfaces.find((p) => p.shortName === route.interfaceName);
      nextHopIp = route.type === 'C' || route.nextHop === 'Directly Connected' ? dstIp : route.nextHop;
    } else {
      egressPort = activeOriginPort;
      if (!isSameSubnet(egressPort.ipAddress, dstIp, egressPort.subnetMask)) {
        if (!isValidIpv4(currentL3Node.defaultGateway)) {
          return {
            reachedTargetNode: null,
            failureReason: `Узел ${dstIp} находится в другой подсети, но на ${currentL3Node.name} не задан шлюз по умолчанию (Default Gateway).`,
          };
        }
        nextHopIp = currentL3Node.defaultGateway;
      }
    }

    if (!egressPort || egressPort.adminStatus !== 'up') {
      return {
        reachedTargetNode: null,
        failureReason: `Исходящий интерфейс на устройстве ${currentL3Node.name} выключен или не найден.`,
      };
    }

    const nextHopMac = resolveNextHopArp(currentL3Node, egressPort, nextHopIp, nodes, links, steps);
    if (!nextHopMac) {
      return {
        reachedTargetNode: null,
        failureReason: `Не удалось разрешить MAC-адрес для ${nextHopIp} по протоколу ARP с интерфейса ${currentL3Node.name}:${egressPort.shortName}.`,
      };
    }

    const vlan = egressPort.accessVlan || 1;
    const summaryText =
      options?.customSummary ||
      `${protocol} (${currentSrcIp} → ${dstIp}, TTL=${ttl})`;

    const initialIpPdu = buildPduDetails({
      inPort: hop === 0 ? 'OS Network Stack (L3)' : 'Routing Engine (L3)',
      outPort: egressPort.shortName,
      cableType: 'straight',
      physicalStatus: 'UP',
      srcMac: egressPort.macAddress,
      dstMac: nextHopMac,
      etherType: '0x0800 (IPv4)',
      vlanTag: egressPort.vlanMode === 'trunk' ? vlan : null,
      srcIp: currentSrcIp,
      dstIp,
      ttl,
      protocol,
      summary: summaryText,
      l7: options?.l7,
    });

    const { deliveredToNodes } = propagateL2Frame(
      {
        currentNodeId: currentL3Node.id,
        egressPortId: egressPort.id,
        srcMac: egressPort.macAddress,
        dstIp,
        dstMac: nextHopMac,
        srcIp: currentSrcIp,
        vlan,
        isTaggedOnWire: egressPort.vlanMode === 'trunk',
        etherType: '0x0800 (IPv4)',
        protocol,
        ttl,
        summary: summaryText,
        l7: options?.l7,
        inboundPduAtCurrentNode: initialIpPdu,
      },
      nodes,
      links,
      steps,
      new Set()
    );

    const nextL3Receiver = deliveredToNodes.find((d) => d.port.macAddress === nextHopMac);
    if (!nextL3Receiver) {
      return {
        reachedTargetNode: null,
        failureReason: `Пакет ${protocol} не достиг следующего L3-узла (${nextHopIp}).`,
      };
    }

    const ownsDstIp = nextL3Receiver.node.interfaces.some(
      (p) => p.adminStatus === 'up' && p.ipAddress === dstIp
    );
    if (ownsDstIp) {
      return { reachedTargetNode: nextL3Receiver.node };
    }

    if (nextL3Receiver.node.type === 'router') {
      ttl -= 1;
      if (ttl <= 0) {
        return {
          reachedTargetNode: null,
          ttlExpiredAtRouter: {
            router: nextL3Receiver.node,
            ingressPort: nextL3Receiver.port,
          },
          failureReason: `TTL expired in transit на маршрутизаторе ${nextL3Receiver.node.name} (${nextL3Receiver.port.ipAddress}).`,
        };
      }
      currentL3Node = nextL3Receiver.node;
    } else {
      return {
        reachedTargetNode: null,
        failureReason: `Узел ${nextL3Receiver.node.name} получил пакет для ${dstIp}, но не является маршрутизатором.`,
      };
    }
  }

  return {
    reachedTargetNode: null,
    failureReason: 'Превышено максимальное число транзитных переходов (Routing Loop).',
  };
}

/**
 * 1. Standard ICMP Ping or TCP Probe simulation.
 */
export function runPacketSimulation(
  nodesInput: NetworkNode[],
  links: NetworkLink[],
  sourceNodeId: string,
  targetIp: string,
  mode: 'ICMP' | 'TCP' = 'ICMP'
): SimulationRunResult {
  const nodes = cloneNodes(nodesInput);
  for (const n of nodes) {
    if (n.type === 'router') {
      n.routingTable = syncConnectedRoutes(n);
    }
  }

  const sourceNode = nodes.find((n) => n.id === sourceNodeId);
  if (!sourceNode) {
    return {
      steps: [],
      updatedNodes: nodes,
      success: false,
      summaryMessage: 'Узел-источник не найден в топологии.',
    };
  }

  if (!isValidIpv4(targetIp)) {
    return {
      steps: [],
      updatedNodes: nodes,
      success: false,
      summaryMessage: `Некорректный целевой IPv4-адрес: "${targetIp}".`,
    };
  }

  const steps: SimulationStep[] = [];
  const reqProtocol: ProtocolType = mode === 'TCP' ? 'TCP_SYN' : 'ICMP_ECHO_REQUEST';
  const replyProtocol: ProtocolType = mode === 'TCP' ? 'TCP_SYN_ACK' : 'ICMP_ECHO_REPLY';

  const forwardResult = transmitIpPacket(sourceNode, targetIp, reqProtocol, nodes, links, steps);

  if (!forwardResult.reachedTargetNode) {
    return {
      steps,
      updatedNodes: nodes,
      success: false,
      summaryMessage:
        forwardResult.failureReason ||
        `Пакет ${reqProtocol} к узлу ${targetIp} потерян (Request timed out).`,
    };
  }

  const srcPrimaryIp =
    sourceNode.interfaces.find((p) => p.adminStatus === 'up' && isValidIpv4(p.ipAddress))?.ipAddress || '';

  const returnResult = transmitIpPacket(
    forwardResult.reachedTargetNode,
    srcPrimaryIp,
    replyProtocol,
    nodes,
    links,
    steps
  );

  if (!returnResult.reachedTargetNode) {
    return {
      steps,
      updatedNodes: nodes,
      success: false,
      summaryMessage:
        returnResult.failureReason ||
        `Запрос дошёл до ${forwardResult.reachedTargetNode.name}, но обратный пакет к ${srcPrimaryIp} не смог вернуться.`,
    };
  }

  return {
    steps,
    updatedNodes: nodes,
    success: true,
    summaryMessage: `Успешный обмен пакетами (${sourceNode.name} ↔ ${forwardResult.reachedTargetNode.name}, ${targetIp}): выполнено ${steps.length} шагов.`,
  };
}

/**
 * 2. DHCP DORA Simulation (Discover -> Offer -> Request -> Ack).
 * Dynamically assigns IPv4, Subnet Mask, Default Gateway, and DNS Server to a host.
 */
export function runDhcpDoraSimulation(
  nodesInput: NetworkNode[],
  links: NetworkLink[],
  clientNodeId: string
): SimulationRunResult {
  const nodes = cloneNodes(nodesInput);
  const clientNode = nodes.find((n) => n.id === clientNodeId);
  if (!clientNode) {
    return {
      steps: [],
      updatedNodes: nodes,
      success: false,
      summaryMessage: 'Клиентское устройство не найдено.',
    };
  }

  const clientPort = clientNode.interfaces.find((p) => p.adminStatus === 'up');
  if (!clientPort) {
    return {
      steps: [],
      updatedNodes: nodes,
      success: false,
      summaryMessage: `На устройстве ${clientNode.name} нет включённого сетевого порта для отправки DHCP Discover.`,
    };
  }

  const steps: SimulationStep[] = [];
  const vlan = clientPort.accessVlan || 1;
  const xid = '0x4F2A9B01';

  // Step 1: DHCP DISCOVER (0.0.0.0:68 -> 255.255.255.255:67, Broadcast MAC)
  const discoverL7: OsiPduDetails['l7'] = {
    appProtocol: 'DHCP',
    headline: 'DHCP Discover (Message Type 1) — Поиск DHCP-сервера в сегменте L2',
    fields: {
      'Transaction ID': xid,
      'Client MAC': clientPort.macAddress,
      'Client IP (ciaddr)': '0.0.0.0',
      'Requested Options': 'Subnet Mask (1), Router (3), DNS Server (6), Lease Time (51)',
    },
  };

  const discoverPdu = buildPduDetails({
    inPort: 'DHCP Client Daemon',
    outPort: clientPort.shortName,
    cableType: 'straight',
    physicalStatus: 'UP',
    srcMac: clientPort.macAddress,
    dstMac: BROADCAST_MAC,
    etherType: '0x0800 (IPv4)',
    vlanTag: clientPort.vlanMode === 'trunk' ? vlan : null,
    srcIp: '0.0.0.0',
    dstIp: BROADCAST_IP,
    ttl: 64,
    protocol: 'DHCP_DISCOVER',
    summary: `DHCP Discover - Transaction ID ${xid} (UDP 68 → 67)`,
    l7: discoverL7,
  });

  const { deliveredToNodes } = propagateL2Frame(
    {
      currentNodeId: clientNode.id,
      egressPortId: clientPort.id,
      srcMac: clientPort.macAddress,
      dstMac: BROADCAST_MAC,
      srcIp: '0.0.0.0',
      dstIp: BROADCAST_IP,
      vlan,
      isTaggedOnWire: clientPort.vlanMode === 'trunk',
      etherType: '0x0800 (IPv4)',
      protocol: 'DHCP_DISCOVER',
      ttl: 64,
      summary: `DHCP Discover - Transaction ID ${xid}`,
      l7: discoverL7,
      inboundPduAtCurrentNode: discoverPdu,
    },
    nodes,
    links,
    steps,
    new Set()
  );

  // Find a reached node that has DHCP Server enabled and a pool matching the receiving interface's subnet
  const dhcpResponder = deliveredToNodes.find(
    (d) => d.node.services?.dhcpEnabled && (d.node.services.dhcpPools?.length ?? 0) > 0
  );

  if (!dhcpResponder || !dhcpResponder.node.services) {
    return {
      steps,
      updatedNodes: nodes,
      success: false,
      summaryMessage: `DHCP Discover отправлен в VLAN ${vlan}, но ни один активный DHCP-сервер не ответил в данном широковещательном домене.`,
    };
  }

  const serverNode = dhcpResponder.node;
  const serverPort = dhcpResponder.port;
  const serverServices = serverNode.services!;

  // Select matching pool for serverPort's IP subnet, or fallback to first pool
  let matchedPool: DhcpPool =
    serverServices.dhcpPools.find(
      (p) =>
        isValidIpv4(serverPort.ipAddress) &&
        isSameSubnet(serverPort.ipAddress, p.network, p.mask)
    ) || serverServices.dhcpPools[0];

  // Allocate an unused IP from pool range
  const usedIps = new Set<string>(
    nodes.flatMap((n) => n.interfaces.map((i) => i.ipAddress).filter(Boolean))
  );
  // Don't count clientNode's current IP as used if it already has one from this pool
  if (clientPort.ipAddress) {
    usedIps.delete(clientPort.ipAddress);
  }

  let offeredIp = matchedPool.startIp;
  const startInt = ipToInt(matchedPool.startIp);
  const endInt = ipToInt(matchedPool.endIp);
  for (let curr = startInt; curr <= endInt; curr++) {
    const candidate = intToIp(curr);
    if (!usedIps.has(candidate)) {
      offeredIp = candidate;
      break;
    }
  }

  const serverIp = serverPort.ipAddress || matchedPool.defaultRouter || '192.168.1.1';

  // Step 2: DHCP OFFER (Server -> Client)
  const offerL7: OsiPduDetails['l7'] = {
    appProtocol: 'DHCP',
    headline: `DHCP Offer (Message Type 2) — Сервер ${serverNode.name} предлагает адрес ${offeredIp}`,
    fields: {
      'Transaction ID': xid,
      'Offered IP (yiaddr)': offeredIp,
      'Subnet Mask (Opt 1)': matchedPool.mask,
      'Default Gateway (Opt 3)': matchedPool.defaultRouter,
      'DNS Server (Opt 6)': matchedPool.dnsServer,
      'DHCP Server ID (Opt 54)': serverIp,
    },
  };

  const offerPdu = buildPduDetails({
    inPort: 'DHCP Server Daemon',
    outPort: serverPort.shortName,
    cableType: 'straight',
    physicalStatus: 'UP',
    srcMac: serverPort.macAddress,
    dstMac: clientPort.macAddress,
    etherType: '0x0800 (IPv4)',
    vlanTag: serverPort.vlanMode === 'trunk' ? dhcpResponder.vlan : null,
    srcIp: serverIp,
    dstIp: offeredIp,
    ttl: 64,
    protocol: 'DHCP_OFFER',
    summary: `DHCP Offer: ${offeredIp}/${maskToCidr(matchedPool.mask)} from ${serverNode.name}`,
    l7: offerL7,
  });

  propagateL2Frame(
    {
      currentNodeId: serverNode.id,
      egressPortId: serverPort.id,
      srcMac: serverPort.macAddress,
      dstMac: clientPort.macAddress,
      srcIp: serverIp,
      dstIp: offeredIp,
      vlan: dhcpResponder.vlan,
      isTaggedOnWire: serverPort.vlanMode === 'trunk',
      etherType: '0x0800 (IPv4)',
      protocol: 'DHCP_OFFER',
      ttl: 64,
      summary: `DHCP Offer: ${offeredIp} (GW ${matchedPool.defaultRouter}, DNS ${matchedPool.dnsServer})`,
      l7: offerL7,
      inboundPduAtCurrentNode: offerPdu,
    },
    nodes,
    links,
    steps,
    new Set()
  );

  // Step 3: DHCP REQUEST (Client -> Broadcast)
  const requestL7: OsiPduDetails['l7'] = {
    appProtocol: 'DHCP',
    headline: `DHCP Request (Message Type 3) — Клиент ${clientNode.name} запрашивает аренду ${offeredIp}`,
    fields: {
      'Transaction ID': xid,
      'Requested IP (Opt 50)': offeredIp,
      'DHCP Server ID (Opt 54)': serverIp,
      'Client Hostname (Opt 12)': clientNode.name,
    },
  };

  const requestPdu = buildPduDetails({
    inPort: 'DHCP Client Daemon',
    outPort: clientPort.shortName,
    cableType: 'straight',
    physicalStatus: 'UP',
    srcMac: clientPort.macAddress,
    dstMac: BROADCAST_MAC,
    etherType: '0x0800 (IPv4)',
    vlanTag: clientPort.vlanMode === 'trunk' ? vlan : null,
    srcIp: '0.0.0.0',
    dstIp: BROADCAST_IP,
    ttl: 64,
    protocol: 'DHCP_REQUEST',
    summary: `DHCP Request for ${offeredIp} (Transaction ID ${xid})`,
    l7: requestL7,
  });

  propagateL2Frame(
    {
      currentNodeId: clientNode.id,
      egressPortId: clientPort.id,
      srcMac: clientPort.macAddress,
      dstMac: BROADCAST_MAC,
      srcIp: '0.0.0.0',
      dstIp: BROADCAST_IP,
      vlan,
      isTaggedOnWire: clientPort.vlanMode === 'trunk',
      etherType: '0x0800 (IPv4)',
      protocol: 'DHCP_REQUEST',
      ttl: 64,
      summary: `DHCP Request for ${offeredIp}`,
      l7: requestL7,
      inboundPduAtCurrentNode: requestPdu,
    },
    nodes,
    links,
    steps,
    new Set()
  );

  // Step 4: DHCP ACK (Server -> Client)
  const ackL7: OsiPduDetails['l7'] = {
    appProtocol: 'DHCP',
    headline: `DHCP ACK (Message Type 5) — Подтверждение аренды ${offeredIp} для ${clientNode.name}`,
    fields: {
      'Transaction ID': xid,
      'Assigned IP (yiaddr)': offeredIp,
      'Subnet Mask': matchedPool.mask,
      'Default Gateway': matchedPool.defaultRouter,
      'DNS Server': matchedPool.dnsServer,
      'Lease Time': '86400s (24 hours)',
    },
  };

  const ackPdu = buildPduDetails({
    inPort: 'DHCP Server Daemon',
    outPort: serverPort.shortName,
    cableType: 'straight',
    physicalStatus: 'UP',
    srcMac: serverPort.macAddress,
    dstMac: clientPort.macAddress,
    etherType: '0x0800 (IPv4)',
    vlanTag: serverPort.vlanMode === 'trunk' ? dhcpResponder.vlan : null,
    srcIp: serverIp,
    dstIp: offeredIp,
    ttl: 64,
    protocol: 'DHCP_ACK',
    summary: `DHCP ACK: ${offeredIp}/${maskToCidr(matchedPool.mask)} assigned to ${clientNode.name}`,
    l7: ackL7,
  });

  propagateL2Frame(
    {
      currentNodeId: serverNode.id,
      egressPortId: serverPort.id,
      srcMac: serverPort.macAddress,
      dstMac: clientPort.macAddress,
      srcIp: serverIp,
      dstIp: offeredIp,
      vlan: dhcpResponder.vlan,
      isTaggedOnWire: serverPort.vlanMode === 'trunk',
      etherType: '0x0800 (IPv4)',
      protocol: 'DHCP_ACK',
      ttl: 64,
      summary: `DHCP ACK: ${offeredIp} assigned to ${clientNode.name}`,
      l7: ackL7,
      inboundPduAtCurrentNode: ackPdu,
    },
    nodes,
    links,
    steps,
    new Set()
  );

  // Commit DHCP lease to client and server state
  clientPort.ipAddress = offeredIp;
  clientPort.subnetMask = matchedPool.mask;
  clientNode.defaultGateway = matchedPool.defaultRouter;
  clientNode.dnsServer = matchedPool.dnsServer;
  clientNode.ipAssignmentMode = 'dhcp';

  const existingLease = serverServices.dhcpLeases.find((l) => l.macAddress === clientPort.macAddress);
  if (existingLease) {
    existingLease.ipAddress = offeredIp;
    existingLease.hostname = clientNode.name;
    existingLease.poolName = matchedPool.poolName;
  } else {
    serverServices.dhcpLeases.push({
      ipAddress: offeredIp,
      macAddress: clientPort.macAddress,
      hostname: clientNode.name,
      poolName: matchedPool.poolName,
    });
  }

  return {
    steps,
    updatedNodes: nodes,
    success: true,
    summaryMessage: `DHCP DORA завершён: ${clientNode.name} получил IP ${offeredIp}/${maskToCidr(matchedPool.mask)}, GW ${matchedPool.defaultRouter}, DNS ${matchedPool.dnsServer} от ${serverNode.name}.`,
    assignedDhcpConfig: {
      ipAddress: offeredIp,
      subnetMask: matchedPool.mask,
      defaultGateway: matchedPool.defaultRouter,
      dnsServer: matchedPool.dnsServer,
      serverName: serverNode.name,
    },
  };
}

/**
 * 3. Traceroute Simulation (TTL = 1, 2, 3... with ICMP Time Exceeded from each intermediate router).
 */
export function runTracerouteSimulation(
  nodesInput: NetworkNode[],
  links: NetworkLink[],
  sourceNodeId: string,
  targetHostOrIp: string
): SimulationRunResult {
  const nodes = cloneNodes(nodesInput);
  for (const n of nodes) {
    if (n.type === 'router') {
      n.routingTable = syncConnectedRoutes(n);
    }
  }

  const sourceNode = nodes.find((n) => n.id === sourceNodeId);
  if (!sourceNode) {
    return {
      steps: [],
      updatedNodes: nodes,
      success: false,
      summaryMessage: 'Узел-источник не найден.',
    };
  }

  const srcPort = sourceNode.interfaces.find((p) => p.adminStatus === 'up' && isValidIpv4(p.ipAddress));
  if (!srcPort) {
    return {
      steps: [],
      updatedNodes: nodes,
      success: false,
      summaryMessage: `Устройство ${sourceNode.name} не имеет IPv4-адреса.`,
    };
  }

  const steps: SimulationStep[] = [];
  const tracerouteHops: TracerouteHop[] = [];
  let targetIp = targetHostOrIp.trim();

  // If target is a domain name, resolve it via DNS first!
  if (!isValidIpv4(targetIp)) {
    const dnsServerIp = sourceNode.dnsServer || '192.168.2.100';
    const dnsLookup = performDnsLookupTransaction(sourceNode, dnsServerIp, targetIp, nodes, links, steps);
    if (!dnsLookup.resolvedIp) {
      return {
        steps,
        updatedNodes: nodes,
        success: false,
        summaryMessage: dnsLookup.error || `Не удалось разрешить доменное имя "${targetIp}" через DNS.`,
        tracerouteHops,
      };
    }
    targetIp = dnsLookup.resolvedIp;
  }

  const maxTtl = 6;
  for (let currentTtl = 1; currentTtl <= maxTtl; currentTtl++) {
    const probeRes = transmitIpPacket(
      sourceNode,
      targetIp,
      'ICMP_ECHO_REQUEST',
      nodes,
      links,
      steps,
      {
        initialTtl: currentTtl,
        customSummary: `Traceroute Probe #${currentTtl} (TTL=${currentTtl}, Target=${targetIp})`,
        l7: {
          appProtocol: 'ICMP',
          headline: `Traceroute Probe (TTL = ${currentTtl})`,
          fields: {
            'Probe Hop': String(currentTtl),
            'IPv4 TTL': String(currentTtl),
            'Destination IP': targetIp,
          },
        },
      }
    );

    if (probeRes.ttlExpiredAtRouter) {
      const { router, ingressPort } = probeRes.ttlExpiredAtRouter;
      const routerIp = ingressPort.ipAddress || router.interfaces.find((i) => i.ipAddress)?.ipAddress || '0.0.0.0';

      // Send ICMP_TIME_EXCEEDED from router back to sourceNode
      transmitIpPacket(router, srcPort.ipAddress, 'ICMP_TIME_EXCEEDED', nodes, links, steps, {
        initialTtl: 64,
        customSummary: `ICMP Time Exceeded (TTL=0 in transit at ${router.name} ${routerIp})`,
        l7: {
          appProtocol: 'ICMP',
          headline: `ICMP Type 11 Code 0 (Time to Live Exceeded in Transit)`,
          fields: {
            'Reporting Router': `${router.name} (${routerIp})`,
            'Expired Probe TTL': String(currentTtl),
            'Original Destination': targetIp,
          },
        },
      });

      tracerouteHops.push({
        hopNumber: currentTtl,
        ttl: currentTtl,
        responderName: router.name,
        responderIp: routerIp,
        rttMs: currentTtl * 2,
        status: 'TIME_EXCEEDED',
      });
    } else if (probeRes.reachedTargetNode) {
      const targetNode = probeRes.reachedTargetNode;
      transmitIpPacket(targetNode, srcPort.ipAddress, 'ICMP_ECHO_REPLY', nodes, links, steps, {
        initialTtl: 64,
        customSummary: `ICMP Echo Reply from Final Target ${targetNode.name} (${targetIp})`,
        l7: {
          appProtocol: 'ICMP',
          headline: `ICMP Echo Reply (Type 0) — Целевой узел достигнут на шаге TTL=${currentTtl}`,
          fields: {
            'Final Responder': `${targetNode.name} (${targetIp})`,
            'Total Hops': String(currentTtl),
          },
        },
      });

      tracerouteHops.push({
        hopNumber: currentTtl,
        ttl: currentTtl,
        responderName: targetNode.name,
        responderIp: targetIp,
        rttMs: currentTtl * 2,
        status: 'REACHED',
      });

      return {
        steps,
        updatedNodes: nodes,
        success: true,
        summaryMessage: `Трассировка маршрута к ${targetIp} завершена за ${currentTtl} переходов (Hops): ${tracerouteHops
          .map((h) => `${h.hopNumber}. ${h.responderName} (${h.responderIp})`)
          .join(' → ')}.`,
        tracerouteHops,
      };
    } else {
      tracerouteHops.push({
        hopNumber: currentTtl,
        ttl: currentTtl,
        responderName: '*',
        responderIp: 'Request timed out',
        rttMs: 0,
        status: 'TIMEOUT',
      });
      return {
        steps,
        updatedNodes: nodes,
        success: false,
        summaryMessage: probeRes.failureReason || `Трассировка прервана на шаге TTL=${currentTtl}.`,
        tracerouteHops,
      };
    }
  }

  return {
    steps,
    updatedNodes: nodes,
    success: false,
    summaryMessage: `Превышен лимит переходов Traceroute (${maxTtl} hops).`,
    tracerouteHops,
  };
}

/**
 * Helper to perform a DNS UDP 53 Query + Response transaction.
 */
function performDnsLookupTransaction(
  clientNode: NetworkNode,
  dnsServerIp: string,
  domain: string,
  nodes: NetworkNode[],
  links: NetworkLink[],
  steps: SimulationStep[]
): { resolvedIp: string | null; dnsServerNode?: NetworkNode; error?: string } {
  const clientIp =
    clientNode.interfaces.find((p) => p.adminStatus === 'up' && isValidIpv4(p.ipAddress))?.ipAddress || '';

  const queryRes = transmitIpPacket(clientNode, dnsServerIp, 'DNS_QUERY', nodes, links, steps, {
    customSummary: `DNS Standard Query A "${domain}" (UDP 54120 → 53)`,
    l7: {
      appProtocol: 'DNS',
      headline: `DNS Standard Query (Type A): ${domain}`,
      fields: {
        'Transaction ID': '0x883A',
        'Query Name': domain,
        'Query Type': 'A (Host IPv4 Address)',
        'DNS Server': dnsServerIp,
      },
    },
  });

  if (!queryRes.reachedTargetNode) {
    return {
      resolvedIp: null,
      error: `DNS-запрос к серверу ${dnsServerIp} не доставлен: ${queryRes.failureReason || 'Timeout'}`,
    };
  }

  const dnsServer = queryRes.reachedTargetNode;
  if (!dnsServer.services?.dnsEnabled) {
    return {
      resolvedIp: null,
      error: `Узел ${dnsServer.name} (${dnsServerIp}) получен, но служба DNS Server (UDP 53) на нём выключена.`,
    };
  }

  const record = dnsServer.services.dnsRecords.find(
    (r) => r.domain.toLowerCase() === domain.toLowerCase()
  );

  const resolvedIp = record ? record.ipAddress : null;

  transmitIpPacket(dnsServer, clientIp, 'DNS_RESPONSE', nodes, links, steps, {
    customSummary: resolvedIp
      ? `DNS Response A "${domain}" → ${resolvedIp} (UDP 53 → 54120)`
      : `DNS Response NXDOMAIN "${domain}" (Domain Not Found)`,
    l7: {
      appProtocol: 'DNS',
      headline: resolvedIp
        ? `DNS Standard Query Response: ${domain} = ${resolvedIp}`
        : `DNS Response: NXDOMAIN (${domain} не найден в таблице DNS)`,
      fields: {
        'Transaction ID': '0x883A',
        'Question': `${domain} (Type A)`,
        'Answer': resolvedIp ? `${domain} → ${resolvedIp} (TTL 3600s)` : 'NXDOMAIN (No such name)',
        'Authoritative DNS': `${dnsServer.name} (${dnsServerIp})`,
      },
    },
  });

  if (!resolvedIp) {
    return {
      resolvedIp: null,
      dnsServerNode: dnsServer,
      error: `DNS-сервер ${dnsServer.name} вернул NXDOMAIN: запись для домена "${domain}" не найдена.`,
    };
  }

  return { resolvedIp, dnsServerNode: dnsServer };
}

/**
 * 4. Full DNS + TCP 3-Way Handshake + HTTP GET/200 OK Web Request Simulation.
 */
export function runHttpBrowserSimulation(
  nodesInput: NetworkNode[],
  links: NetworkLink[],
  clientNodeId: string,
  rawUrlOrHost: string
): SimulationRunResult {
  const nodes = cloneNodes(nodesInput);
  for (const n of nodes) {
    if (n.type === 'router') {
      n.routingTable = syncConnectedRoutes(n);
    }
  }

  const clientNode = nodes.find((n) => n.id === clientNodeId);
  if (!clientNode) {
    return {
      steps: [],
      updatedNodes: nodes,
      success: false,
      summaryMessage: 'Клиентский узел не найден.',
    };
  }

  const clientPort = clientNode.interfaces.find((p) => p.adminStatus === 'up' && isValidIpv4(p.ipAddress));
  if (!clientPort) {
    return {
      steps: [],
      updatedNodes: nodes,
      success: false,
      summaryMessage: `На устройстве ${clientNode.name} не настроен IPv4-адрес. Сначала получите IP по DHCP или задайте его вручную.`,
    };
  }

  // Parse URL host & path
  let cleanInput = rawUrlOrHost.trim().replace(/^https?:\/\//i, '');
  const slashIdx = cleanInput.indexOf('/');
  const hostPart = slashIdx >= 0 ? cleanInput.slice(0, slashIdx) : cleanInput;
  const pathPart = slashIdx >= 0 ? cleanInput.slice(slashIdx) : '/index.html';

  const steps: SimulationStep[] = [];
  let targetIp = hostPart;

  // Phase 1: DNS Resolution if hostPart is a domain name
  if (!isValidIpv4(hostPart)) {
    const dnsServerIp = clientNode.dnsServer || '192.168.2.100';
    const dnsRes = performDnsLookupTransaction(clientNode, dnsServerIp, hostPart, nodes, links, steps);
    if (!dnsRes.resolvedIp) {
      return {
        steps,
        updatedNodes: nodes,
        success: false,
        summaryMessage: dnsRes.error || `Ошибка разрешения DNS для ${hostPart}.`,
      };
    }
    targetIp = dnsRes.resolvedIp;
  }

  // Phase 2: TCP 3-Way Handshake (SYN -> SYN-ACK -> ACK)
  const synRes = transmitIpPacket(clientNode, targetIp, 'TCP_SYN', nodes, links, steps, {
    customSummary: `TCP [SYN] Seq=0 Win=64240 Len=0 (${clientPort.ipAddress}:49152 → ${targetIp}:80)`,
  });

  if (!synRes.reachedTargetNode) {
    return {
      steps,
      updatedNodes: nodes,
      success: false,
      summaryMessage: synRes.failureReason || `Не удалось установить TCP-соединение с ${targetIp}:80.`,
    };
  }

  const webServer = synRes.reachedTargetNode;
  if (webServer.services && webServer.services.httpEnabled === false) {
    return {
      steps,
      updatedNodes: nodes,
      success: false,
      summaryMessage: `Сервер ${webServer.name} (${targetIp}) отклонил TCP-соединение на порт 80 (HTTP-сервис выключен).`,
    };
  }

  const synAckRes = transmitIpPacket(webServer, clientPort.ipAddress, 'TCP_SYN_ACK', nodes, links, steps, {
    customSummary: `TCP [SYN, ACK] Seq=0 Ack=1 Win=65535 (${targetIp}:80 → ${clientPort.ipAddress}:49152)`,
  });

  if (!synAckRes.reachedTargetNode) {
    return {
      steps,
      updatedNodes: nodes,
      success: false,
      summaryMessage: `Ответ TCP SYN-ACK от ${webServer.name} не смог вернуться к клиенту.`,
    };
  }

  transmitIpPacket(clientNode, targetIp, 'TCP_ACK', nodes, links, steps, {
    customSummary: `TCP [ACK] Seq=1 Ack=1 — Соединение TCP 3-Way Handshake установлено`,
  });

  // Phase 3: HTTP GET Request & HTTP 200 OK Response
  transmitIpPacket(clientNode, targetIp, 'HTTP_GET', nodes, links, steps, {
    customSummary: `HTTP GET ${pathPart} HTTP/1.1 (Host: ${hostPart})`,
    l7: {
      appProtocol: 'HTTP',
      headline: `HTTP GET ${pathPart} HTTP/1.1`,
      fields: {
        'Host': hostPart,
        'User-Agent': 'NetPulse-Browser/1.0',
        'Accept': 'text/html,application/xhtml+xml',
        'Connection': 'keep-alive',
      },
    },
  });

  const pageTitle = webServer.services?.httpTitle || `Welcome to ${webServer.name} (${hostPart})`;
  const pageBody =
    webServer.services?.httpBody ||
    `HTML-страница успешно загружена с узла ${webServer.name} (${targetIp}) по протоколу HTTP/1.1 поверх TCP-соединения.`;

  transmitIpPacket(webServer, clientPort.ipAddress, 'HTTP_200_OK', nodes, links, steps, {
    customSummary: `HTTP/1.1 200 OK (Content-Type: text/html, Server: ${webServer.name})`,
    l7: {
      appProtocol: 'HTTP',
      headline: `HTTP/1.1 200 OK — Доставлена веб-страница "${pageTitle}"`,
      fields: {
        'Status': '200 OK',
        'Server': `NetPulse-HTTPd/2.4 (${webServer.name})`,
        'Content-Type': 'text/html; charset=UTF-8',
        'Document Title': pageTitle,
      },
    },
  });

  return {
    steps,
    updatedNodes: nodes,
    success: true,
    summaryMessage: `HTTP 200 OK: загружен ресурс http://${hostPart}${pathPart} (${targetIp}) за ${steps.length} шагов (DNS + TCP Handshake + HTTP).`,
    httpResult: {
      url: `http://${hostPart}${pathPart}`,
      resolvedIp: targetIp,
      statusCode: 200,
      statusText: 'OK',
      serverName: webServer.name,
      title: pageTitle,
      body: pageBody,
      latencyMs: steps.length * 12,
    },
  };
}
