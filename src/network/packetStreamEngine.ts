import { isValidIpv4 } from './ipMath';
import {
  computeSpanningTreeState,
  getRouterLogicalInterfaces,
  isLinkOperational,
  runDhcpDoraSimulation,
  runHttpBrowserSimulation,
  runPacketSimulation,
} from './simulator';
import {
  NetworkLink,
  NetworkNode,
  ProtocolType,
  SimulationStep,
  StepStatus,
} from './types';

export type ProtocolFilterCategory = 'ARP' | 'ICMP' | 'DHCP' | 'DNS' | 'HTTP' | 'STP';

export type SimulationExecutionMode = 'realtime' | 'simulation';

export const ALL_PROTOCOL_CATEGORIES: ProtocolFilterCategory[] = [
  'ARP',
  'ICMP',
  'DHCP',
  'DNS',
  'HTTP',
  'STP',
];

export const SPEED_PRESETS: number[] = [0.1, 0.25, 0.5, 1, 2, 4];

export interface ProtocolVisualMeta {
  category: ProtocolFilterCategory;
  shortLabel: string;
  microGlyph: string;
  fillHex: string;
  borderHex: string;
  glowHex: string;
  trailHex: string;
  badgeClass: string;
  squareClass: string;
  isDropped: boolean;
}

export interface PacketFilterOptions {
  enabledCategories: Record<ProtocolFilterCategory, boolean>;
  onlyDropped: boolean;
  deviceFilterId: string; // 'ALL' or node.id
  searchQuery: string;
}

export interface PduDiffField {
  layer: 'L1' | 'L2' | 'L3' | 'L4' | 'L7';
  field: string;
  inboundValue: string;
  outboundValue: string;
  changed: boolean;
  changeBadge?: string;
}

export interface PduHeaderDiffReport {
  hasAnyChange: boolean;
  macChanged: boolean;
  ipNatChanged: boolean;
  vlanTagChanged: boolean;
  ttlDecremented: boolean;
  changeBadges: string[];
  fields: PduDiffField[];
}

export interface CanvasPacketSquareDescriptor {
  id: string;
  step: SimulationStep;
  stepIndexZeroBased: number;
  linkId: string;
  fromNodeId: string;
  toNodeId: string;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  progress: number; // 0..1 along link from->to
  x: number;
  y: number;
  tailX: number;
  tailY: number;
  laneOffsetPx: number;
  visual: ProtocolVisualMeta;
  isPrimaryActive: boolean;
}

export function createDefaultEnabledCategories(): Record<ProtocolFilterCategory, boolean> {
  return {
    ARP: true,
    ICMP: true,
    DHCP: true,
    DNS: true,
    HTTP: true,
    STP: true,
  };
}

export function getProtocolCategory(protocol: ProtocolType): ProtocolFilterCategory {
  if (protocol.startsWith('ARP')) return 'ARP';
  if (protocol.startsWith('ICMP')) return 'ICMP';
  if (protocol.startsWith('DHCP')) return 'DHCP';
  if (protocol.startsWith('DNS')) return 'DNS';
  if (protocol === 'STP_BPDU') return 'STP';
  return 'HTTP';
}

export function getProtocolVisualMeta(
  protocol: ProtocolType,
  status: StepStatus
): ProtocolVisualMeta {
  const category = getProtocolCategory(protocol);
  const isDropped = status === 'dropped';

  if (isDropped) {
    return {
      category,
      shortLabel: 'DROP',
      microGlyph: '✕',
      fillHex: '#ef4444',
      borderHex: '#fca5a5',
      glowHex: 'rgba(239, 68, 68, 0.75)',
      trailHex: '#f87171',
      badgeClass: 'bg-red-500/20 text-red-300 border-red-500/50',
      squareClass:
        'bg-red-500 border-red-200 text-white shadow-[0_0_12px_rgba(239,68,68,0.9)]',
      isDropped: true,
    };
  }

  switch (category) {
    case 'ARP':
      return {
        category,
        shortLabel: protocol === 'ARP_Request' || protocol === 'ARP_REQUEST' ? 'ARP?' : 'ARP!',
        microGlyph: 'A',
        fillHex: '#f59e0b',
        borderHex: '#fde68a',
        glowHex: 'rgba(245, 158, 11, 0.75)',
        trailHex: '#fbbf24',
        badgeClass: 'bg-amber-500/20 text-amber-300 border-amber-500/45',
        squareClass:
          'bg-amber-500 border-amber-200 text-slate-950 shadow-[0_0_11px_rgba(245,158,11,0.85)]',
        isDropped: false,
      };
    case 'ICMP':
      return {
        category,
        shortLabel:
          protocol === 'ICMP_ECHO_REQUEST'
            ? 'PING'
            : protocol === 'ICMP_ECHO_REPLY'
            ? 'PONG'
            : 'TTL',
        microGlyph: 'I',
        fillHex: '#0ea5e9',
        borderHex: '#bae6fd',
        glowHex: 'rgba(14, 165, 233, 0.78)',
        trailHex: '#38bdf8',
        badgeClass: 'bg-sky-500/20 text-sky-300 border-sky-500/45',
        squareClass:
          'bg-sky-500 border-sky-200 text-slate-950 shadow-[0_0_11px_rgba(56,189,248,0.85)]',
        isDropped: false,
      };
    case 'DHCP':
      return {
        category,
        shortLabel: protocol.replace('DHCP_', ''),
        microGlyph: 'D',
        fillHex: '#a855f7',
        borderHex: '#e9d5ff',
        glowHex: 'rgba(168, 85, 247, 0.78)',
        trailHex: '#c084fc',
        badgeClass: 'bg-purple-500/20 text-purple-300 border-purple-500/45',
        squareClass:
          'bg-purple-500 border-purple-200 text-white shadow-[0_0_11px_rgba(168,85,247,0.85)]',
        isDropped: false,
      };
    case 'DNS':
      return {
        category,
        shortLabel: protocol === 'DNS_QUERY' ? 'DNS?' : 'DNS!',
        microGlyph: 'N',
        fillHex: '#f97316',
        borderHex: '#fed7aa',
        glowHex: 'rgba(249, 115, 22, 0.78)',
        trailHex: '#fb923c',
        badgeClass: 'bg-orange-500/20 text-orange-300 border-orange-500/45',
        squareClass:
          'bg-orange-500 border-orange-200 text-slate-950 shadow-[0_0_11px_rgba(249,115,22,0.85)]',
        isDropped: false,
      };
    case 'STP':
      return {
        category,
        shortLabel: 'BPDU',
        microGlyph: 'S',
        fillHex: '#6366f1',
        borderHex: '#c7d2fe',
        glowHex: 'rgba(99, 102, 241, 0.78)',
        trailHex: '#818cf8',
        badgeClass: 'bg-indigo-500/20 text-indigo-300 border-indigo-500/45',
        squareClass:
          'bg-indigo-500 border-indigo-200 text-white shadow-[0_0_11px_rgba(99,102,241,0.85)]',
        isDropped: false,
      };
    case 'HTTP':
    default:
      return {
        category: 'HTTP',
        shortLabel: protocol.startsWith('TCP_')
          ? protocol.replace('TCP_', '')
          : protocol === 'HTTP_GET'
          ? 'GET'
          : '200',
        microGlyph: 'H',
        fillHex: '#10b981',
        borderHex: '#a7f3d0',
        glowHex: 'rgba(16, 185, 129, 0.78)',
        trailHex: '#34d399',
        badgeClass: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/45',
        squareClass:
          'bg-emerald-500 border-emerald-200 text-slate-950 shadow-[0_0_11px_rgba(16,185,129,0.85)]',
        isDropped: false,
      };
  }
}

/**
 * Finds all concurrent step indices that belong to the same broadcast/flood fan-out wave
 * on a switch or multi-port transmitter so that broadcast packets visually fan out across
 * all active ports simultaneously.
 */
export function getConcurrentBroadcastWaveIndices(
  steps: SimulationStep[],
  activeStepIndex: number
): number[] {
  const current = steps[activeStepIndex];
  if (!current) return [];

  const result: number[] = [activeStepIndex];

  // If this step is a broadcast flood or STP BPDU fan-out from the same node
  const isFloodCandidate =
    current.status === 'broadcast' ||
    current.protocol === 'ARP_REQUEST' ||
    current.protocol === 'DHCP_DISCOVER' ||
    current.protocol === 'STP_BPDU' ||
    current.inboundPdu.l2.dstMac === 'FF:FF:FF:FF:FF:FF';

  if (isFloodCandidate) {
    // Look backwards and forwards for adjacent steps emitted from the same node with the same protocol
    for (let i = activeStepIndex - 1; i >= 0; i--) {
      const candidate = steps[i];
      if (
        candidate.fromNodeId === current.fromNodeId &&
        candidate.protocol === current.protocol
      ) {
        result.unshift(i);
      } else {
        break;
      }
    }
    for (let i = activeStepIndex + 1; i < steps.length; i++) {
      const candidate = steps[i];
      if (
        candidate.fromNodeId === current.fromNodeId &&
        candidate.protocol === current.protocol
      ) {
        result.push(i);
      } else {
        break;
      }
    }
  }

  return Array.from(new Set(result));
}

/**
 * Generates authentic IEEE 802.1D STP Configuration BPDU frames across switch links.
 * Ports in STP Blocking (BLK) state are skipped for outbound flooding or marked dropped on receive.
 */
export function synthesizeStpBpduSteps(
  nodes: NetworkNode[],
  links: NetworkLink[],
  startStepNumber: number = 1,
  startTimestampMs: number = 0
): SimulationStep[] {
  const stpMap = computeSpanningTreeState(nodes, links);
  const steps: SimulationStep[] = [];
  let stepCounter = startStepNumber;
  let timestamp = startTimestampMs;

  const switches = nodes.filter((n) => n.type === 'switch');
  if (switches.length === 0) return [];

  for (const sw of switches) {
    const swStp = stpMap[sw.id];
    if (!swStp) continue;

    for (const link of links) {
      if (!isLinkOperational(link, nodes)) continue;

      const isSource = link.sourceNodeId === sw.id;
      const isTarget = link.targetNodeId === sw.id;
      if (!isSource && !isTarget) continue;

      const localPortId = isSource ? link.sourcePortId : link.targetPortId;
      const peerNodeId = isSource ? link.targetNodeId : link.sourceNodeId;
      const peerPortId = isSource ? link.targetPortId : link.sourcePortId;

      const peerNode = nodes.find((n) => n.id === peerNodeId);
      if (!peerNode) continue;

      // Only emit BPDUs from switches toward other switches or routers/hosts on Designated/Root ports
      // To avoid duplicate bidirectional BPDU on same switch-to-switch link, only emit from Designated port
      const portStatus = swStp.ports[localPortId];
      if (!portStatus || portStatus.state === 'blocking' || portStatus.state === 'disabled') {
        continue;
      }

      if (peerNode.type === 'switch' && portStatus.role !== 'designated') {
        continue;
      }

      const localPort = sw.interfaces.find((p) => p.id === localPortId);
      const peerPort = peerNode.interfaces.find((p) => p.id === peerPortId);
      if (!localPort || !peerPort) continue;

      const peerStpPort = stpMap[peerNode.id]?.ports[peerPortId];
      const isBlockedAtReceiver = peerStpPort?.state === 'blocking';

      const bpduPdu = {
        l1: {
          inPort: 'CPU/STP',
          outPort: localPort.shortName,
          cableType: link.cableType,
          physicalStatus: '100BASE-TX Full-Duplex',
        },
        l2: {
          headerType: 'Ethernet II' as const,
          srcMac: localPort.macAddress,
          dstMac: '01:80:C2:00:00:00',
          etherType: '0x010B (STP BPDU)' as const,
          vlanTag: null,
        },
        l3: {
          headerType: 'IEEE 802.1D BPDU' as const,
          srcIp: swStp.rootBridgeName,
          dstIp: `Cost ${swStp.rootPathCost}`,
          ttl: 20,
          protocol: 'STP 802.1D',
        },
        l4: {
          type: 'STP_BPDU' as const,
          summary: `Config BPDU · Root=${swStp.rootBridgeName} · Cost=${swStp.rootPathCost}`,
          seqNumber: stepCounter,
        },
        l7: {
          appProtocol: 'STP' as const,
          headline: `IEEE 802.1D Configuration BPDU (${sw.name} → ${peerNode.name})`,
          fields: {
            'Root Bridge ID': swStp.rootBridgeId,
            'Root Bridge Name': swStp.rootBridgeName,
            'Root Path Cost': String(swStp.rootPathCost),
            'Sender Bridge MAC': swStp.bridgeMac,
            'Sender Port Role': portStatus.role.toUpperCase(),
            'Receiver Port State': isBlockedAtReceiver ? 'BLOCKING (BLK)' : 'FORWARDING (FWD)',
          },
        },
      };

      steps.push({
        id: `stp-bpdu-${stepCounter}-${sw.id}-${peerNode.id}`,
        stepIndex: stepCounter++,
        timestampMs: timestamp,
        fromNodeId: sw.id,
        fromNodeName: sw.name,
        fromPortName: localPort.shortName,
        toNodeId: peerNode.id,
        toNodeName: peerNode.name,
        toPortName: peerPort.shortName,
        linkId: link.id,
        protocol: 'STP_BPDU',
        status: isBlockedAtReceiver ? 'dropped' : 'forwarded',
        vlanTag: null,
        inboundPdu: bpduPdu,
        outboundPdu: {
          ...bpduPdu,
          l1: {
            ...bpduPdu.l1,
            inPort: peerPort.shortName,
            outPort: isBlockedAtReceiver ? 'STP BLK (Loop Guard)' : 'STP Control Plane',
          },
        },
        decisionTitle: isBlockedAtReceiver
          ? `${peerNode.name}: порт ${peerPort.shortName} в режиме STP BLOCKING (защита от петли L2) — кадр BPDU обработан, трафик данных заблокирован`
          : `${peerNode.name}: принят кадр STP 802.1D BPDU от ${sw.name} (Root Bridge: ${swStp.rootBridgeName}, Cost: ${swStp.rootPathCost})`,
        osiActions: [
          {
            layer: 'L1',
            title: `Приём служебного кадра на порт ${peerPort.shortName}`,
            detail: `Физический линк активен (${link.cableType}).`,
          },
          {
            layer: 'L2',
            title: 'Multicast-адрес назначения 01:80:C2:00:00:00 (Spanning Tree)',
            detail: isBlockedAtReceiver
              ? `Порт ${peerPort.shortName} находится в состоянии Alternate/Blocking (BLK) для предотвращения широковещательного шторма.`
              : `Коммутатор сверяет Root Bridge ID (${swStp.rootBridgeId}) и обновляет таймеры Hello Time (2s).`,
          },
        ],
        nodeSnapshotAfter: {
          arpTable: [...peerNode.arpTable],
          macTable: [...peerNode.macTable],
        },
      });
    }
    timestamp += 4;
  }

  return steps;
}

/**
 * Generates a rich multi-flow batch of simulation steps for Realtime / Live Traffic mode:
 * - STP BPDU frames from switches
 * - ICMP Ping Echo Request/Reply flows between active hosts
 * - DNS + HTTP GET/200 OK transactions to active servers
 * - DHCP DORA if unconfigured DHCP clients exist
 */
export function generateMultiFlowTrafficSteps(
  nodes: NetworkNode[],
  links: NetworkLink[],
  waveIteration: number = 0
): {
  steps: SimulationStep[];
  updatedNodes: NetworkNode[];
  summaryMessage: string;
} {
  let workingNodes: NetworkNode[] = JSON.parse(JSON.stringify(nodes));
  const combinedSteps: SimulationStep[] = [];
  let nextStepIndex = 1;
  let currentOffsetMs = 0;

  const appendSteps = (newSteps: SimulationStep[]) => {
    for (const st of newSteps) {
      combinedSteps.push({
        ...st,
        id: `live-${waveIteration}-${nextStepIndex}-${st.linkId}`,
        stepIndex: nextStepIndex++,
        timestampMs: currentOffsetMs + st.timestampMs,
      });
    }
    if (newSteps.length > 0) {
      const maxTime = Math.max(...newSteps.map((s) => s.timestampMs));
      currentOffsetMs += Math.max(12, maxTime + 8);
    }
  };

  // 1. Add STP 802.1D BPDU frames across switches
  const stpSteps = synthesizeStpBpduSteps(workingNodes, links, nextStepIndex, 0);
  appendSteps(stpSteps);

  // 2. Check if any PC in DHCP mode lacks an IP -> run DHCP DORA
  const dhcpClient = workingNodes.find(
    (n) =>
      n.type === 'pc' &&
      n.ipAssignmentMode === 'dhcp' &&
      !isValidIpv4(n.interfaces[0]?.ipAddress || '')
  );
  if (dhcpClient) {
    const dhcpRes = runDhcpDoraSimulation(workingNodes, links, dhcpClient.id);
    workingNodes = dhcpRes.updatedNodes;
    appendSteps(dhcpRes.steps);
  }

  // 3. Find active IP endpoints (PCs & Servers)
  const ipEndpoints = workingNodes.filter(
    (n) =>
      (n.type === 'pc' || n.type === 'server') &&
      n.interfaces.some((i) => i.adminStatus === 'up' && isValidIpv4(i.ipAddress))
  );

  const pcs = ipEndpoints.filter((n) => n.type === 'pc');
  const servers = ipEndpoints.filter((n) => n.type === 'server');

  // 4. Trigger ICMP Ping between pairs of PCs or PC -> Server/Router
  if (pcs.length >= 2) {
    const srcPc = pcs[waveIteration % pcs.length];
    const dstPc = pcs[(waveIteration + 1) % pcs.length];
    const dstIp = dstPc.interfaces.find((i) => isValidIpv4(i.ipAddress))?.ipAddress;
    if (dstIp) {
      const pingRes = runPacketSimulation(workingNodes, links, srcPc.id, dstIp, 'ICMP');
      workingNodes = pingRes.updatedNodes;
      appendSteps(pingRes.steps);
    }
  } else if (pcs.length === 1 && servers.length >= 1) {
    const dstIp = servers[0].interfaces.find((i) => isValidIpv4(i.ipAddress))?.ipAddress;
    if (dstIp) {
      const pingRes = runPacketSimulation(workingNodes, links, pcs[0].id, dstIp, 'ICMP');
      workingNodes = pingRes.updatedNodes;
      appendSteps(pingRes.steps);
    }
  }

  // 5. Trigger DNS + HTTP flow from a PC to an HTTP/DNS server
  if (pcs.length >= 1 && servers.length >= 1) {
    const clientPc = pcs[(waveIteration + 1) % pcs.length];
    const targetServer = servers[waveIteration % servers.length];
    const dnsDomain = targetServer.services?.dnsRecords?.[0]?.domain;
    const serverIp = targetServer.interfaces.find((i) => isValidIpv4(i.ipAddress))?.ipAddress;
    const targetHost = dnsDomain || serverIp;

    if (targetHost && targetServer.services?.httpEnabled !== false) {
      const httpRes = runHttpBrowserSimulation(workingNodes, links, clientPc.id, targetHost);
      workingNodes = httpRes.updatedNodes;
      appendSteps(httpRes.steps);
    }
  }

  // 6. Second cross-subnet or router ping for high-density multi-packet visual stream
  const routers = workingNodes.filter((n) => n.type === 'router');
  if (pcs.length >= 1 && routers.length >= 1) {
    const pc = pcs[0];
    const rtrIp = getRouterLogicalInterfaces(routers[0]).find((i) =>
      isValidIpv4(i.ipAddress)
    )?.ipAddress;
    if (rtrIp && combinedSteps.length < 10) {
      const rtrPing = runPacketSimulation(workingNodes, links, pc.id, rtrIp, 'ICMP');
      workingNodes = rtrPing.updatedNodes;
      appendSteps(rtrPing.steps);
    }
  }

  return {
    steps: combinedSteps,
    updatedNodes: workingNodes,
    summaryMessage: `Прямой эфир (Multi-Flow): сгенерировано ${combinedSteps.length} пакетов (STP BPDU, ARP, ICMP, DNS, HTTP).`,
  };
}

/**
 * Counts steps per ProtocolFilterCategory and dropped count for filter chip badges.
 */
export function countStepsByProtocolCategory(steps: SimulationStep[]): {
  counts: Record<ProtocolFilterCategory, number>;
  droppedCount: number;
  total: number;
} {
  const counts: Record<ProtocolFilterCategory, number> = {
    ARP: 0,
    ICMP: 0,
    DHCP: 0,
    DNS: 0,
    HTTP: 0,
    STP: 0,
  };
  let droppedCount = 0;

  for (const st of steps) {
    const cat = getProtocolCategory(st.protocol);
    counts[cat] = (counts[cat] || 0) + 1;
    if (st.status === 'dropped') {
      droppedCount++;
    }
  }

  return {
    counts,
    droppedCount,
    total: steps.length,
  };
}

/**
 * Checks whether a single SimulationStep passes the active protocol, drop, device, and search filters.
 */
export function doesStepMatchFilter(
  step: SimulationStep,
  options: PacketFilterOptions
): boolean {
  const category = getProtocolCategory(step.protocol);
  if (!options.enabledCategories[category]) {
    return false;
  }
  if (options.onlyDropped && step.status !== 'dropped') {
    return false;
  }
  if (
    options.deviceFilterId &&
    options.deviceFilterId !== 'ALL' &&
    step.fromNodeId !== options.deviceFilterId &&
    step.toNodeId !== options.deviceFilterId
  ) {
    return false;
  }

  const q = options.searchQuery.trim().toLowerCase();
  if (q) {
    const haystack = [
      step.fromNodeName,
      step.toNodeName,
      step.fromPortName,
      step.toPortName,
      step.protocol,
      step.inboundPdu.l3.srcIp,
      step.inboundPdu.l3.dstIp,
      step.outboundPdu.l3.srcIp,
      step.outboundPdu.l3.dstIp,
      step.inboundPdu.l2.srcMac,
      step.inboundPdu.l2.dstMac,
      step.decisionTitle,
      step.vlanTag !== null ? `vlan ${step.vlanTag}` : '',
    ]
      .join(' ')
      .toLowerCase();

    if (!haystack.includes(q)) {
      return false;
    }
  }

  return true;
}

/**
 * Filters SimulationSteps while preserving their original index in the master array.
 */
export function filterSimulationSteps(
  steps: SimulationStep[],
  options: PacketFilterOptions
): { step: SimulationStep; originalIndex: number }[] {
  const output: { step: SimulationStep; originalIndex: number }[] = [];
  for (let i = 0; i < steps.length; i++) {
    if (doesStepMatchFilter(steps[i], options)) {
      output.push({ step: steps[i], originalIndex: i });
    }
  }
  return output;
}

/**
 * Computes a side-by-side diff between Inbound PDU and Outbound PDU at a single hop,
 * highlighting L2 MAC rewrites, 802.1Q VLAN tagging, L3 NAT IP translation, and TTL decrements.
 */
export function computePduHeaderDiff(step: SimulationStep): PduHeaderDiffReport {
  const inPdu = step.inboundPdu;
  const outPdu = step.outboundPdu;

  const macChanged =
    inPdu.l2.srcMac !== outPdu.l2.srcMac || inPdu.l2.dstMac !== outPdu.l2.dstMac;
  const ipNatChanged =
    inPdu.l3.srcIp !== outPdu.l3.srcIp || inPdu.l3.dstIp !== outPdu.l3.dstIp;
  const vlanTagChanged = inPdu.l2.vlanTag !== outPdu.l2.vlanTag;
  const ttlDecremented = inPdu.l3.ttl !== outPdu.l3.ttl;

  const changeBadges: string[] = [];
  if (macChanged) changeBadges.push('L2 MAC Rewrite');
  if (vlanTagChanged) {
    changeBadges.push(
      outPdu.l2.vlanTag !== null
        ? `+802.1Q VLAN ${outPdu.l2.vlanTag}`
        : '802.1Q Untagged'
    );
  }
  if (ipNatChanged) changeBadges.push('NAT / PAT IP');
  if (ttlDecremented) changeBadges.push(`TTL ${inPdu.l3.ttl}→${outPdu.l3.ttl}`);
  if (step.status === 'dropped') changeBadges.push('✕ DROP');

  const inVlanText =
    inPdu.l2.vlanTag !== null ? `802.1Q VLAN ${inPdu.l2.vlanTag}` : 'Untagged (Native)';
  const outVlanText =
    outPdu.l2.vlanTag !== null ? `802.1Q VLAN ${outPdu.l2.vlanTag}` : 'Untagged (Native)';

  const fields: PduDiffField[] = [
    {
      layer: 'L1',
      field: 'Физический порт',
      inboundValue: `${step.fromNodeName}:${step.fromPortName}`,
      outboundValue: `${step.toNodeName}:${step.toPortName} (${outPdu.l1.outPort})`,
      changed: true,
      changeBadge: 'Hop',
    },
    {
      layer: 'L2',
      field: 'Source MAC',
      inboundValue: inPdu.l2.srcMac,
      outboundValue: outPdu.l2.srcMac,
      changed: inPdu.l2.srcMac !== outPdu.l2.srcMac,
      changeBadge: inPdu.l2.srcMac !== outPdu.l2.srcMac ? 'L2 Rewrite' : undefined,
    },
    {
      layer: 'L2',
      field: 'Destination MAC',
      inboundValue: inPdu.l2.dstMac,
      outboundValue: outPdu.l2.dstMac,
      changed: inPdu.l2.dstMac !== outPdu.l2.dstMac,
      changeBadge: inPdu.l2.dstMac !== outPdu.l2.dstMac ? 'Next-Hop MAC' : undefined,
    },
    {
      layer: 'L2',
      field: 'Метка IEEE 802.1Q',
      inboundValue: inVlanText,
      outboundValue: outVlanText,
      changed: vlanTagChanged,
      changeBadge: vlanTagChanged ? 'dot1Q Tag' : undefined,
    },
    {
      layer: 'L3',
      field: 'Source IP',
      inboundValue: inPdu.l3.srcIp,
      outboundValue: outPdu.l3.srcIp,
      changed: inPdu.l3.srcIp !== outPdu.l3.srcIp,
      changeBadge: inPdu.l3.srcIp !== outPdu.l3.srcIp ? 'NAT Inside→Global' : undefined,
    },
    {
      layer: 'L3',
      field: 'Destination IP',
      inboundValue: inPdu.l3.dstIp,
      outboundValue: outPdu.l3.dstIp,
      changed: inPdu.l3.dstIp !== outPdu.l3.dstIp,
      changeBadge: inPdu.l3.dstIp !== outPdu.l3.dstIp ? 'NAT Outside→Local' : undefined,
    },
    {
      layer: 'L3',
      field: 'TTL (Time To Live)',
      inboundValue: String(inPdu.l3.ttl),
      outboundValue: String(outPdu.l3.ttl),
      changed: ttlDecremented,
      changeBadge: ttlDecremented ? '-1 Hop' : undefined,
    },
    {
      layer: 'L4',
      field: 'Сегмент L4 / Порты',
      inboundValue:
        inPdu.l4.srcPort !== undefined
          ? `${inPdu.l4.type} (${inPdu.l4.srcPort} → ${inPdu.l4.dstPort})`
          : inPdu.l4.summary,
      outboundValue:
        outPdu.l4.srcPort !== undefined
          ? `${outPdu.l4.type} (${outPdu.l4.srcPort} → ${outPdu.l4.dstPort})`
          : outPdu.l4.summary,
      changed:
        inPdu.l4.srcPort !== outPdu.l4.srcPort ||
        inPdu.l4.dstPort !== outPdu.l4.dstPort ||
        inPdu.l4.summary !== outPdu.l4.summary,
    },
  ];

  return {
    hasAnyChange: macChanged || ipNatChanged || vlanTagChanged || ttlDecremented,
    macChanged,
    ipNatChanged,
    vlanTagChanged,
    ttlDecremented,
    changeBadges,
    fields,
  };
}

/**
 * Computes the set of visible 10x10 packet squares on the canvas for either:
 * - Simulation Mode (showing the active broadcast/unicast wave with smooth interpolation `stepProgress` + nearby pipeline packets)
 * - Realtime / Multi-Flow Mode (showing dozens of simultaneously moving packet squares across active links)
 */
export function buildCanvasPacketSquares(params: {
  nodes: NetworkNode[];
  steps: SimulationStep[];
  activeStepIndex: number;
  stepProgress: number; // 0..1 within current step
  executionMode: SimulationExecutionMode;
  liveStreamPhase: number; // continuous phase 0..1000 for Realtime mode
  filterOptions: PacketFilterOptions;
}): CanvasPacketSquareDescriptor[] {
  const {
    nodes,
    steps,
    activeStepIndex,
    stepProgress,
    executionMode,
    liveStreamPhase,
    filterOptions,
  } = params;

  if (steps.length === 0) return [];

  const nodeMap = new Map<string, NetworkNode>();
  for (const n of nodes) {
    nodeMap.set(n.id, n);
  }

  const descriptors: CanvasPacketSquareDescriptor[] = [];

  if (executionMode === 'realtime') {
    // In Realtime / Multi-Flow mode, render a continuous stream of moving squares across all active links.
    // To keep visual spacing clean on busy trunk links, group steps by (linkId + direction) and stagger evenly.
    const filtered = filterSimulationSteps(steps, filterOptions);
    if (filtered.length === 0) return [];

    const byLinkDir = new Map<string, { step: SimulationStep; originalIndex: number }[]>();
    for (const item of filtered) {
      const key = `${item.step.linkId}:${item.step.fromNodeId}->${item.step.toNodeId}`;
      const list = byLinkDir.get(key) || [];
      list.push(item);
      byLinkDir.set(key, list);
    }

    byLinkDir.forEach((groupItems) => {
      // Sample up to 3 evenly spaced packets per directional link at any moment
      const maxPerDirection = Math.min(3, groupItems.length);
      const phaseWindowOffset = Math.floor(liveStreamPhase * groupItems.length);

      for (let slotIdx = 0; slotIdx < maxPerDirection; slotIdx++) {
        const picked = groupItems[(phaseWindowOffset + slotIdx) % groupItems.length];
        const { step, originalIndex } = picked;

        const fromNode = nodeMap.get(step.fromNodeId);
        const toNode = nodeMap.get(step.toNodeId);
        if (!fromNode || !toNode) continue;

        // Evenly stagger packets along the link [0.10 .. 0.90]
        const stagger = slotIdx / maxPerDirection + (originalIndex % 5) * 0.04;
        const rawProgress = (liveStreamPhase * 1.6 + stagger) % 1;
        const clampedProgress =
          step.status === 'dropped'
            ? Math.min(0.76, 0.16 + rawProgress * 0.65)
            : 0.1 + rawProgress * 0.8;

        const dx = toNode.x - fromNode.x;
        const dy = toNode.y - fromNode.y;
        const len = Math.hypot(dx, dy) || 1;
        const nx = -dy / len;
        const ny = dx / len;

        // Separate forward and reverse lanes by 6px perpendicular to the cable
        const directionSign = step.fromNodeId < step.toNodeId ? 1 : -1;
        const laneOffsetPx = directionSign * 5.5;

        const x = fromNode.x + dx * clampedProgress + nx * laneOffsetPx;
        const y = fromNode.y + dy * clampedProgress + ny * laneOffsetPx;

        const tailProgress = Math.max(0.05, clampedProgress - 0.14);
        const tailX = fromNode.x + dx * tailProgress + nx * laneOffsetPx;
        const tailY = fromNode.y + dy * tailProgress + ny * laneOffsetPx;

        descriptors.push({
          id: `rt-pkt-${step.linkId}-${step.fromNodeId}-${slotIdx}-${originalIndex}`,
          step,
          stepIndexZeroBased: originalIndex,
          linkId: step.linkId,
          fromNodeId: step.fromNodeId,
          toNodeId: step.toNodeId,
          fromX: fromNode.x,
          fromY: fromNode.y,
          toX: toNode.x,
          toY: toNode.y,
          progress: clampedProgress,
          x,
          y,
          tailX,
          tailY,
          laneOffsetPx,
          visual: getProtocolVisualMeta(step.protocol, step.status),
          isPrimaryActive: originalIndex === activeStepIndex,
        });
      }
    });

    return descriptors;
  }

  // Simulation (Step-by-step / Wave) Mode:
  // Render all concurrent broadcast/multi-flow steps in the active wave at `stepProgress`,
  // plus recently completed / upcoming sibling steps in the flow for visual continuity.
  const waveIndices = getConcurrentBroadcastWaveIndices(steps, activeStepIndex);
  const clampedT = Math.max(0.12, Math.min(0.88, stepProgress));

  for (let wIdx = 0; wIdx < waveIndices.length; wIdx++) {
    const stepIdx = waveIndices[wIdx];
    const step = steps[stepIdx];
    if (!step || !doesStepMatchFilter(step, filterOptions)) continue;

    const fromNode = nodeMap.get(step.fromNodeId);
    const toNode = nodeMap.get(step.toNodeId);
    if (!fromNode || !toNode) continue;

    const dx = toNode.x - fromNode.x;
    const dy = toNode.y - fromNode.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;

    const laneOffsetPx = waveIndices.length > 1 ? ((wIdx % 3) - 1) * 3 : 0;
    const effectiveT = step.status === 'dropped' ? Math.min(0.74, clampedT) : clampedT;

    const x = fromNode.x + dx * effectiveT + nx * laneOffsetPx;
    const y = fromNode.y + dy * effectiveT + ny * laneOffsetPx;
    const tailT = Math.max(0.05, effectiveT - 0.16);
    const tailX = fromNode.x + dx * tailT + nx * laneOffsetPx;
    const tailY = fromNode.y + dy * tailT + ny * laneOffsetPx;

    descriptors.push({
      id: `sim-pkt-${step.id}-${stepIdx}`,
      step,
      stepIndexZeroBased: stepIdx,
      linkId: step.linkId,
      fromNodeId: step.fromNodeId,
      toNodeId: step.toNodeId,
      fromX: fromNode.x,
      fromY: fromNode.y,
      toX: toNode.x,
      toY: toNode.y,
      progress: effectiveT,
      x,
      y,
      tailX,
      tailY,
      laneOffsetPx,
      visual: getProtocolVisualMeta(step.protocol, step.status),
      isPrimaryActive: stepIdx === activeStepIndex,
    });
  }

  return descriptors;
}
