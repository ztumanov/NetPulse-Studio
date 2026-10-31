import {
  BgpAdvertisedNetwork,
  BgpConfig,
  BgpNeighborConfig,
  BgpPeerStatusEntry,
  NetworkInterface,
  NetworkLink,
  NetworkNode,
  OsiPduDetails,
  RouteEntry,
  SimulationStep,
  WanImpairmentConfig,
} from './types';
import {
  getNetworkAddress,
  ipToInt,
  isSameSubnet,
  isValidIpv4,
  maskToCidr,
} from './ipMath';

export function isIspCloudNode(node: NetworkNode): boolean {
  return node.deviceModel === 'isp_cloud';
}

export function getDefaultWanImpairmentConfig(
  tier: 'primary' | 'backup' | 'satellite' = 'primary'
): WanImpairmentConfig {
  if (tier === 'backup') {
    return {
      enabled: true,
      profileName: 'Резервный канал (Radio/LTE · 45 мс)',
      latencyMs: 45,
      jitterMs: 6,
      packetLossPercent: 0,
      bandwidthLimitMbps: 100,
    };
  }
  if (tier === 'satellite') {
    return {
      enabled: true,
      profileName: 'Спутниковый канал GEO (600 мс)',
      latencyMs: 600,
      jitterMs: 25,
      packetLossPercent: 5,
      bandwidthLimitMbps: 10,
    };
  }
  return {
    enabled: true,
    profileName: 'Оптическая магистраль Tier-1 (8 мс)',
    latencyMs: 8,
    jitterMs: 1,
    packetLossPercent: 0,
    bandwidthLimitMbps: 1000,
  };
}

export function getDefaultBgpConfig(
  index: number = 1,
  isIspCloud: boolean = false
): BgpConfig {
  const asn = isIspCloud ? 65100 + index : 65000 + index;
  return {
    enabled: true,
    asn,
    providerName: isIspCloud
      ? `ISP-${index} Telecom (AS ${asn})`
      : `Enterprise Edge (AS ${asn})`,
    redistributeConnected: isIspCloud,
    neighbors: [],
    advertisedNetworks: isIspCloud
      ? [
          {
            id: `bgp-net-${index}-1`,
            network: '8.8.8.0',
            mask: '255.255.255.0',
          },
        ]
      : [],
  };
}

/**
 * Resolves the highest active IPv4 or explicit BGP Router-ID for a router / ISP cloud.
 */
export function resolveBgpRouterId(node: NetworkNode): string {
  if (node.bgpConfig?.routerId && isValidIpv4(node.bgpConfig.routerId)) {
    return node.bgpConfig.routerId;
  }
  if (node.ospfConfig?.routerId && isValidIpv4(node.ospfConfig.routerId)) {
    return node.ospfConfig.routerId;
  }
  const activeIps: string[] = [];
  for (const iface of node.interfaces) {
    if (iface.adminStatus === 'up' && isValidIpv4(iface.ipAddress)) {
      activeIps.push(iface.ipAddress);
    }
    if (iface.adminStatus === 'up' && Array.isArray(iface.subinterfaces)) {
      for (const sub of iface.subinterfaces) {
        if (isValidIpv4(sub.ipAddress)) {
          activeIps.push(sub.ipAddress);
        }
      }
    }
  }
  if (activeIps.length === 0) return '0.0.0.0';
  activeIps.sort((a, b) => (ipToInt(b) >>> 0) - (ipToInt(a) >>> 0));
  return activeIps[0];
}

/**
 * Resolves the active WAN Link Impairment parameters (Latency, Jitter, Packet Loss %, Bandwidth Limit)
 * on a link between two nodes. Checks link-level, port-level, and ISP Cloud node-level impairment configs.
 */
export function resolveLinkWanImpairment(
  senderNode: NetworkNode,
  senderPort: NetworkInterface,
  receiverNode: NetworkNode,
  receiverPort: NetworkInterface,
  link: NetworkLink
): WanImpairmentConfig | null {
  if (link.wanImpairment?.enabled) {
    return link.wanImpairment;
  }
  if (senderPort.wanImpairment?.enabled) {
    return senderPort.wanImpairment;
  }
  if (receiverPort.wanImpairment?.enabled) {
    return receiverPort.wanImpairment;
  }
  // If either endpoint is an ISP Cloud node (or has node-level wanImpairment enabled on an outside/WAN port),
  // apply its WAN Impairment config on the ingress/egress link to the customer edge router!
  if (isIspCloudNode(senderNode) && senderNode.wanImpairment?.enabled) {
    return senderNode.wanImpairment;
  }
  if (isIspCloudNode(receiverNode) && receiverNode.wanImpairment?.enabled) {
    return receiverNode.wanImpairment;
  }
  if (
    senderNode.wanImpairment?.enabled &&
    (senderPort.natRole === 'outside' ||
      senderPort.securityZone === 'outside' ||
      isIspCloudNode(receiverNode))
  ) {
    return senderNode.wanImpairment;
  }
  if (
    receiverNode.wanImpairment?.enabled &&
    (receiverPort.natRole === 'outside' ||
      receiverPort.securityZone === 'outside' ||
      isIspCloudNode(senderNode))
  ) {
    return receiverNode.wanImpairment;
  }
  return null;
}

/**
 * Formats a concise human-readable WAN Link Impairment summary badge.
 */
export function formatWanImpairmentSummary(imp: WanImpairmentConfig): string {
  return `Задержка: ${imp.latencyMs} мс (±${imp.jitterMs || 0} мс) · Потери: ${imp.packetLossPercent}% · Полоса: ${imp.bandwidthLimitMbps} Мбит/с`;
}

/**
 * Checks if a physical link between two ports is up for BGP peering.
 */
function isDirectLinkUp(
  nodeA: NetworkNode,
  portA: NetworkInterface,
  nodeB: NetworkNode,
  portB: NetworkInterface,
  link: NetworkLink
): boolean {
  if (portA.adminStatus !== 'up' || portB.adminStatus !== 'up') return false;
  const imp = resolveLinkWanImpairment(nodeA, portA, nodeB, portB, link);
  if (imp && (imp.packetLossPercent >= 100 || imp.bandwidthLimitMbps <= 0)) {
    return false;
  }
  return true;
}

/**
 * Discovers all configured and auto-detected eBGP peers for a router or ISP Cloud node.
 */
export function discoverBgpPeersForRouter(
  router: NetworkNode,
  allNodes: NetworkNode[],
  allLinks: NetworkLink[]
): BgpPeerStatusEntry[] {
  if (router.type !== 'router' || !router.bgpConfig?.enabled) {
    return [];
  }

  const myBgp = router.bgpConfig;
  const results: BgpPeerStatusEntry[] = [];
  const handledIps = new Set<string>();

  // Helper to find a directly connected peer router by IP
  const findDirectPeerByIp = (
    targetIp: string
  ): {
    localPort: NetworkInterface;
    peerNode: NetworkNode;
    peerPort: NetworkInterface;
    link: NetworkLink;
    linkUp: boolean;
  } | null => {
    for (const localPort of router.interfaces) {
      if (!isValidIpv4(localPort.ipAddress) || !isValidIpv4(localPort.subnetMask)) {
        continue;
      }
      if (!isSameSubnet(targetIp, localPort.ipAddress, localPort.subnetMask)) {
        continue;
      }
      const matchedLinks = allLinks.filter(
        (l) =>
          (l.sourceNodeId === router.id && l.sourcePortId === localPort.id) ||
          (l.targetNodeId === router.id && l.targetPortId === localPort.id)
      );
      for (const link of matchedLinks) {
        const peerNodeId =
          link.sourceNodeId === router.id ? link.targetNodeId : link.sourceNodeId;
        const peerPortId =
          link.sourceNodeId === router.id ? link.targetPortId : link.sourcePortId;
        const peerNode = allNodes.find((n) => n.id === peerNodeId);
        const peerPort = peerNode?.interfaces.find((p) => p.id === peerPortId);
        if (peerNode && peerPort && peerPort.ipAddress === targetIp) {
          const linkUp = isDirectLinkUp(router, localPort, peerNode, peerPort, link);
          return { localPort, peerNode, peerPort, link, linkUp };
        }
      }
    }
    return null;
  };

  // 1. Evaluate explicitly configured neighbors in router.bgpConfig.neighbors
  for (const nbr of myBgp.neighbors || []) {
    if (!isValidIpv4(nbr.ip)) continue;
    handledIps.add(nbr.ip);

    const direct = findDirectPeerByIp(nbr.ip);
    const imp = direct
      ? resolveLinkWanImpairment(
          router,
          direct.localPort,
          direct.peerNode,
          direct.peerPort,
          direct.link
        )
      : null;

    const peerBgp = direct?.peerNode.bgpConfig;
    const isAdminDisabled = nbr.enabled === false;
    const peerHasBgpUp =
      Boolean(direct?.linkUp) &&
      Boolean(peerBgp?.enabled) &&
      peerBgp!.asn === nbr.remoteAs;

    const state: BgpPeerStatusEntry['state'] = isAdminDisabled
      ? 'Idle (Admin)'
      : peerHasBgpUp
      ? 'Established'
      : 'Active';

    const pfxCount =
      state === 'Established' && direct
        ? getOriginatedBgpPrefixesForNode(direct.peerNode).length
        : 0;

    results.push({
      neighborIp: nbr.ip,
      remoteAs: nbr.remoteAs,
      localAs: myBgp.asn,
      peerNodeId: direct?.peerNode.id,
      peerNodeName: direct?.peerNode.name || nbr.description,
      peerRouterId: direct ? resolveBgpRouterId(direct.peerNode) : undefined,
      localInterface: direct?.localPort.shortName || '—',
      state,
      prefixesReceived: pfxCount,
      weight: nbr.weight ?? 100,
      localPref: nbr.localPref ?? 100,
      prependCount: nbr.prependCount ?? 0,
      uptime: state === 'Established' ? '00:24:18' : 'never',
      wanLatencyMs: imp?.latencyMs ?? 2,
      wanLossPercent: imp?.packetLossPercent ?? 0,
      wanBandwidthMbps:
        imp?.bandwidthLimitMbps ?? direct?.localPort.bandwidthMbps ?? 1000,
    });
  }

  // 2. Also auto-discover directly connected BGP-enabled ISP Cloud / Router peers if not already in neighbors list
  for (const localPort of router.interfaces) {
    if (!isValidIpv4(localPort.ipAddress) || !isValidIpv4(localPort.subnetMask)) {
      continue;
    }
    const matchedLinks = allLinks.filter(
      (l) =>
        (l.sourceNodeId === router.id && l.sourcePortId === localPort.id) ||
        (l.targetNodeId === router.id && l.targetPortId === localPort.id)
    );
    for (const link of matchedLinks) {
      const peerNodeId =
        link.sourceNodeId === router.id ? link.targetNodeId : link.sourceNodeId;
      const peerPortId =
        link.sourceNodeId === router.id ? link.targetPortId : link.sourcePortId;
      const peerNode = allNodes.find((n) => n.id === peerNodeId);
      const peerPort = peerNode?.interfaces.find((p) => p.id === peerPortId);
      if (
        !peerNode ||
        !peerPort ||
        peerNode.type !== 'router' ||
        !peerNode.bgpConfig?.enabled ||
        !isValidIpv4(peerPort.ipAddress) ||
        handledIps.has(peerPort.ipAddress)
      ) {
        continue;
      }
      if (!isSameSubnet(peerPort.ipAddress, localPort.ipAddress, localPort.subnetMask)) {
        continue;
      }

      // Check if peer explicitly disabled this neighbor
      const peerNbrCfg = peerNode.bgpConfig.neighbors?.find(
        (n) => n.ip === localPort.ipAddress
      );
      if (peerNbrCfg && peerNbrCfg.enabled === false) {
        continue;
      }

      handledIps.add(peerPort.ipAddress);
      const linkUp = isDirectLinkUp(router, localPort, peerNode, peerPort, link);
      const imp = resolveLinkWanImpairment(router, localPort, peerNode, peerPort, link);
      const state: BgpPeerStatusEntry['state'] = linkUp ? 'Established' : 'Active';
      const pfxCount = linkUp ? getOriginatedBgpPrefixesForNode(peerNode).length : 0;

      results.push({
        neighborIp: peerPort.ipAddress,
        remoteAs: peerNode.bgpConfig.asn,
        localAs: myBgp.asn,
        peerNodeId: peerNode.id,
        peerNodeName: peerNode.name,
        peerRouterId: resolveBgpRouterId(peerNode),
        localInterface: localPort.shortName,
        state,
        prefixesReceived: pfxCount,
        weight: 100,
        localPref: 100,
        prependCount: 0,
        uptime: state === 'Established' ? '00:24:18' : 'never',
        wanLatencyMs: imp?.latencyMs ?? 2,
        wanLossPercent: imp?.packetLossPercent ?? 0,
        wanBandwidthMbps: imp?.bandwidthLimitMbps ?? localPort.bandwidthMbps ?? 1000,
      });
    }
  }

  return results;
}

/**
 * Returns all IPv4 networks originated into BGP by a router or ISP Cloud node.
 */
export function getOriginatedBgpPrefixesForNode(
  node: NetworkNode
): BgpAdvertisedNetwork[] {
  if (!node.bgpConfig?.enabled) return [];
  const map = new Map<string, BgpAdvertisedNetwork>();

  for (const adv of node.bgpConfig.advertisedNetworks || []) {
    if (isValidIpv4(adv.network) && isValidIpv4(adv.mask)) {
      const net = getNetworkAddress(adv.network, adv.mask);
      map.set(`${net}/${adv.mask}`, {
        id: adv.id,
        network: net,
        mask: adv.mask,
      });
    }
  }

  if (node.bgpConfig.redistributeConnected || isIspCloudNode(node)) {
    for (const iface of node.interfaces) {
      if (
        iface.adminStatus === 'up' &&
        isValidIpv4(iface.ipAddress) &&
        isValidIpv4(iface.subnetMask)
      ) {
        const net = getNetworkAddress(iface.ipAddress, iface.subnetMask);
        const key = `${net}/${iface.subnetMask}`;
        if (!map.has(key)) {
          map.set(key, {
            id: `bgp-conn-${node.id}-${iface.shortName}`,
            network: net,
            mask: iface.subnetMask,
          });
        }
      }
    }
  }

  return Array.from(map.values());
}

/**
 * Computes eBGP routes (Administrative Distance 20, type 'B') for a router or ISP Cloud node,
 * applying authentic Cisco BGP Best-Path Selection:
 *   1. Highest Weight (Cisco local attribute, default 100)
 *   2. Highest LOCAL_PREF (default 100)
 *   3. Shortest AS_PATH length (including AS-Path Prepending)
 *   4. Lowest WAN Link Latency (ms)
 *   5. Lowest Neighbor IP
 */
export function computeBgpRoutesForRouter(
  router: NetworkNode,
  allNodes: NetworkNode[],
  allLinks: NetworkLink[]
): {
  bestRoutes: RouteEntry[];
  allCandidateBgpRoutes: RouteEntry[];
} {
  if (router.type !== 'router' || !router.bgpConfig?.enabled) {
    return { bestRoutes: [], allCandidateBgpRoutes: [] };
  }

  const myAsn = router.bgpConfig.asn;
  const peers = discoverBgpPeersForRouter(router, allNodes, allLinks).filter(
    (p) => p.state === 'Established' && p.peerNodeId
  );
  if (peers.length === 0) {
    return { bestRoutes: [], allCandidateBgpRoutes: [] };
  }

  // Own connected networks so we don't install redundant BGP routes for our own directly attached interfaces
  const ownConnectedKeys = new Set<string>();
  for (const iface of router.interfaces) {
    if (
      iface.adminStatus === 'up' &&
      isValidIpv4(iface.ipAddress) &&
      isValidIpv4(iface.subnetMask)
    ) {
      ownConnectedKeys.add(
        `${getNetworkAddress(iface.ipAddress, iface.subnetMask)}/${iface.subnetMask}`
      );
    }
  }

  const candidatesByPrefix = new Map<string, RouteEntry[]>();

  // BFS across BGP Autonomous Systems starting from each Established neighbor
  for (const peer of peers) {
    const firstPeerNode = allNodes.find((n) => n.id === peer.peerNodeId);
    if (!firstPeerNode || !firstPeerNode.bgpConfig?.enabled) continue;

    // Build initial AS_PATH with optional AS-Path Prepending
    const prependRepeats = Math.max(0, Math.min(5, peer.prependCount || 0));
    const initialAsPath: number[] = Array.from(
      { length: 1 + prependRepeats },
      () => peer.remoteAs
    );

    interface BgpTraversalItem {
      currentNode: NetworkNode;
      asPath: number[];
      cumulativeLatencyMs: number;
      visitedNodeIds: Set<string>;
    }

    const queue: BgpTraversalItem[] = [
      {
        currentNode: firstPeerNode,
        asPath: initialAsPath,
        cumulativeLatencyMs: peer.wanLatencyMs,
        visitedNodeIds: new Set([router.id, firstPeerNode.id]),
      },
    ];

    while (queue.length > 0) {
      const item = queue.shift()!;
      const prefixes = getOriginatedBgpPrefixesForNode(item.currentNode);

      for (const pfx of prefixes) {
        const prefixKey = `${pfx.network}/${pfx.mask}`;
        if (ownConnectedKeys.has(prefixKey)) continue;

        const candidate: RouteEntry = {
          id: `bgp-${router.id}-${peer.neighborIp}-${pfx.network}-${maskToCidr(pfx.mask)}`,
          network: pfx.network,
          mask: pfx.mask,
          nextHop: peer.neighborIp,
          interfaceName: peer.localInterface,
          type: 'B',
          administrativeDistance: 20, // Standard eBGP AD = 20
          metric: item.cumulativeLatencyMs,
          learnedFromRouterId: peer.peerRouterId,
          learnedFromRouterName: peer.peerNodeName,
          bgpAsPath: [...item.asPath],
          bgpWeight: peer.weight,
          bgpLocalPref: peer.localPref,
          bgpOrigin: 'i',
          bgpBestPath: false,
          wanLatencyMs: item.cumulativeLatencyMs,
        };

        const list = candidatesByPrefix.get(prefixKey) || [];
        // Keep only the shortest path from the same nextHop for the same prefix
        const existingIdx = list.findIndex((c) => c.nextHop === peer.neighborIp);
        if (existingIdx === -1) {
          list.push(candidate);
        } else if (
          (candidate.bgpAsPath?.length ?? 99) <
          (list[existingIdx].bgpAsPath?.length ?? 99)
        ) {
          list[existingIdx] = candidate;
        }
        candidatesByPrefix.set(prefixKey, list);
      }

      // Propagate to downstream eBGP neighbors of item.currentNode (up to 4 AS hops)
      if (item.asPath.length < 6) {
        const downstreamPeers = discoverBgpPeersForRouter(
          item.currentNode,
          allNodes,
          allLinks
        ).filter((dp) => dp.state === 'Established' && dp.peerNodeId);

        for (const dp of downstreamPeers) {
          if (!dp.peerNodeId || item.visitedNodeIds.has(dp.peerNodeId)) continue;
          // BGP Loop Prevention: reject if myAsn or dp.remoteAs is already in AS_PATH
          if (dp.remoteAs === myAsn || item.asPath.includes(dp.remoteAs)) continue;
          const nextNode = allNodes.find((n) => n.id === dp.peerNodeId);
          if (!nextNode) continue;

          const nextVisited = new Set(item.visitedNodeIds);
          nextVisited.add(nextNode.id);

          queue.push({
            currentNode: nextNode,
            asPath: [...item.asPath, dp.remoteAs],
            cumulativeLatencyMs: item.cumulativeLatencyMs + dp.wanLatencyMs,
            visitedNodeIds: nextVisited,
          });
        }
      }
    }
  }

  const bestRoutes: RouteEntry[] = [];
  const allCandidateBgpRoutes: RouteEntry[] = [];

  for (const [, candidates] of candidatesByPrefix.entries()) {
    candidates.sort((a, b) => {
      // 1. Highest Weight
      const wDiff = (b.bgpWeight ?? 100) - (a.bgpWeight ?? 100);
      if (wDiff !== 0) return wDiff;
      // 2. Highest LOCAL_PREF
      const lpDiff = (b.bgpLocalPref ?? 100) - (a.bgpLocalPref ?? 100);
      if (lpDiff !== 0) return lpDiff;
      // 3. Shortest AS_PATH
      const asLenDiff = (a.bgpAsPath?.length ?? 99) - (b.bgpAsPath?.length ?? 99);
      if (asLenDiff !== 0) return asLenDiff;
      // 4. Lowest WAN Latency / MED
      const medDiff = (a.metric ?? 0) - (b.metric ?? 0);
      if (medDiff !== 0) return medDiff;
      // 5. Lowest Next-Hop IP
      return (ipToInt(a.nextHop) >>> 0) - (ipToInt(b.nextHop) >>> 0);
    });

    candidates[0].bgpBestPath = true;
    bestRoutes.push(candidates[0]);
    for (const c of candidates) {
      allCandidateBgpRoutes.push(c);
    }
  }

  return { bestRoutes, allCandidateBgpRoutes };
}

/**
 * Generates visual simulation steps for eBGP Peering (BGP_OPEN -> BGP_KEEPALIVE -> BGP_UPDATE on TCP port 179)
 * between a router/ISP Cloud and all of its active eBGP neighbors.
 */
export function buildBgpSessionSimulationSteps(
  sourceRouter: NetworkNode,
  allNodes: NetworkNode[],
  allLinks: NetworkLink[]
): {
  steps: SimulationStep[];
  summaryMessage: string;
  success: boolean;
} {
  if (!sourceRouter.bgpConfig?.enabled) {
    return {
      steps: [],
      summaryMessage: `На узле ${sourceRouter.name} не включён процесс маршрутизации eBGP.`,
      success: false,
    };
  }

  const peers = discoverBgpPeersForRouter(sourceRouter, allNodes, allLinks).filter(
    (p) => p.state === 'Established' && p.peerNodeId
  );

  if (peers.length === 0) {
    return {
      steps: [],
      summaryMessage: `У маршрутизатора ${sourceRouter.name} (AS ${sourceRouter.bgpConfig.asn}) нет активных соседей eBGP в состоянии Established.`,
      success: false,
    };
  }

  const steps: SimulationStep[] = [];
  let seq = 1;
  let currentTimeMs = 150;

  for (const peer of peers) {
    const peerNode = allNodes.find((n) => n.id === peer.peerNodeId);
    const localPort = sourceRouter.interfaces.find(
      (i) => i.shortName === peer.localInterface
    );
    if (!peerNode || !localPort) continue;

    const link = allLinks.find(
      (l) =>
        (l.sourceNodeId === sourceRouter.id &&
          l.sourcePortId === localPort.id &&
          l.targetNodeId === peerNode.id) ||
        (l.targetNodeId === sourceRouter.id &&
          l.targetPortId === localPort.id &&
          l.sourceNodeId === peerNode.id)
    );
    const peerPort = peerNode.interfaces.find((p) => p.ipAddress === peer.neighborIp);
    if (!link || !peerPort) continue;

    const imp = resolveLinkWanImpairment(
      sourceRouter,
      localPort,
      peerNode,
      peerPort,
      link
    );
    const hopDelay = Math.max(20, imp?.latencyMs ?? 15);
    const advNets = getOriginatedBgpPrefixesForNode(peerNode)
      .map((n) => `${n.network}/${maskToCidr(n.mask)}`)
      .join(', ') || '0.0.0.0/0';

    const makeBgpPdu = (
      proto: 'BGP_OPEN' | 'BGP_KEEPALIVE' | 'BGP_UPDATE',
      srcMac: string,
      dstMac: string,
      srcIp: string,
      dstIp: string,
      inPort: string,
      outPort: string,
      summary: string,
      fields: Record<string, string>
    ): OsiPduDetails => ({
      l1: {
        inPort,
        outPort,
        cableType: link.cableType,
        physicalStatus: imp
          ? `UP (WAN: ${imp.latencyMs}ms · Loss ${imp.packetLossPercent}% · ${imp.bandwidthLimitMbps}Mbps)`
          : 'UP',
      },
      l2: {
        headerType: 'Ethernet II',
        srcMac,
        dstMac,
        etherType: '0x0800 (IPv4)',
        vlanTag: null,
      },
      l3: {
        headerType: 'IPv4',
        srcIp,
        dstIp,
        ttl: 1, // eBGP single-hop TTL=1
        protocol: '6 (TCP · BGP-4)',
      },
      l4: {
        type: proto,
        summary,
        seqNumber: seq,
        srcPort: 179,
        dstPort: 179,
      },
      l7: {
        appProtocol: 'BGP',
        headline: summary,
        fields,
      },
    });

    // 1. BGP OPEN (sourceRouter -> peerNode)
    const openSummary = `BGP-4 OPEN: AS ${sourceRouter.bgpConfig.asn} → AS ${peer.remoteAs} (Router-ID ${resolveBgpRouterId(sourceRouter)}, HoldTime 180s)`;
    const openPdu = makeBgpPdu(
      'BGP_OPEN',
      localPort.macAddress,
      peerPort.macAddress,
      localPort.ipAddress,
      peerPort.ipAddress,
      localPort.shortName,
      peerPort.shortName,
      openSummary,
      {
        Version: 'BGP-4 (RFC 4271)',
        'My Autonomous System': `AS ${sourceRouter.bgpConfig.asn}`,
        'Peer Autonomous System': `AS ${peer.remoteAs}`,
        'BGP Identifier': resolveBgpRouterId(sourceRouter),
        'Hold Time': '180 sec',
      }
    );
    steps.push({
      id: `step-${seq}`,
      stepIndex: seq,
      timestampMs: currentTimeMs,
      fromNodeId: sourceRouter.id,
      fromNodeName: sourceRouter.name,
      fromPortName: localPort.shortName,
      toNodeId: peerNode.id,
      toNodeName: peerNode.name,
      toPortName: peerPort.shortName,
      linkId: link.id,
      protocol: 'BGP_OPEN',
      status: 'delivered',
      vlanTag: null,
      inboundPdu: openPdu,
      outboundPdu: openPdu,
      decisionTitle: `${sourceRouter.name} → ${peerNode.name}: Установка сессии eBGP OPEN (AS ${sourceRouter.bgpConfig.asn} ↔ AS ${peer.remoteAs}, TCP 179)`,
      osiActions: [
        {
          layer: 'L4',
          title: 'Сессия TCP порт 179 (eBGP Peering)',
          detail: `Установлено соединение BGP-4 между ${localPort.ipAddress} (AS ${sourceRouter.bgpConfig.asn}) и ${peerPort.ipAddress} (AS ${peer.remoteAs}).`,
        },
        {
          layer: 'L7',
          title: openSummary,
          detail: imp
            ? `Параметры WAN-канала провайдера: ${formatWanImpairmentSummary(imp)}.`
            : 'Обмен параметрами автономных систем и таймерами удержания (Hold Time 180s).',
        },
      ],
      nodeSnapshotAfter: {
        arpTable: JSON.parse(JSON.stringify(peerNode.arpTable)),
        macTable: JSON.parse(JSON.stringify(peerNode.macTable)),
      },
    });
    seq++;
    currentTimeMs += hopDelay + 120;

    // 2. BGP KEEPALIVE (peerNode -> sourceRouter)
    const keepaliveSummary = `BGP-4 KEEPALIVE: Сосед ${peerNode.name} (AS ${peer.remoteAs}) подтвердил статус ESTABLISHED`;
    const keepalivePdu = makeBgpPdu(
      'BGP_KEEPALIVE',
      peerPort.macAddress,
      localPort.macAddress,
      peerPort.ipAddress,
      localPort.ipAddress,
      peerPort.shortName,
      localPort.shortName,
      keepaliveSummary,
      {
        State: 'ESTABLISHED',
        'Peer AS': `AS ${peer.remoteAs}`,
        'Local Pref / Weight': `LP ${peer.localPref} / Weight ${peer.weight}`,
      }
    );
    steps.push({
      id: `step-${seq}`,
      stepIndex: seq,
      timestampMs: currentTimeMs,
      fromNodeId: peerNode.id,
      fromNodeName: peerNode.name,
      fromPortName: peerPort.shortName,
      toNodeId: sourceRouter.id,
      toNodeName: sourceRouter.name,
      toPortName: localPort.shortName,
      linkId: link.id,
      protocol: 'BGP_KEEPALIVE',
      status: 'delivered',
      vlanTag: null,
      inboundPdu: keepalivePdu,
      outboundPdu: keepalivePdu,
      decisionTitle: `${peerNode.name} → ${sourceRouter.name}: Подтверждение соседства BGP KEEPALIVE (State = ESTABLISHED)`,
      osiActions: [
        {
          layer: 'L7',
          title: keepaliveSummary,
          detail: `Пиринг eBGP между ${peerNode.name} (AS ${peer.remoteAs}) и ${sourceRouter.name} (AS ${sourceRouter.bgpConfig.asn}) перешёл в состояние ESTABLISHED.`,
        },
      ],
      nodeSnapshotAfter: {
        arpTable: JSON.parse(JSON.stringify(sourceRouter.arpTable)),
        macTable: JSON.parse(JSON.stringify(sourceRouter.macTable)),
      },
    });
    seq++;
    currentTimeMs += hopDelay + 120;

    // 3. BGP UPDATE (peerNode -> sourceRouter advertising NLRI prefixes + AS_PATH)
    const asPathStr = Array.from(
      { length: 1 + (peer.prependCount || 0) },
      () => peer.remoteAs
    ).join(' ');
    const updateSummary = `BGP-4 UPDATE: Анонс NLRI [${advNets}] · NEXT_HOP ${peer.neighborIp} · AS_PATH [${asPathStr} i] · LP ${peer.localPref} · Weight ${peer.weight}`;
    const updatePdu = makeBgpPdu(
      'BGP_UPDATE',
      peerPort.macAddress,
      localPort.macAddress,
      peerPort.ipAddress,
      localPort.ipAddress,
      peerPort.shortName,
      localPort.shortName,
      updateSummary,
      {
        'NLRI Prefixes': advNets,
        NEXT_HOP: peer.neighborIp,
        AS_PATH: `${asPathStr} i`,
        LOCAL_PREF: String(peer.localPref),
        WEIGHT: String(peer.weight),
        'Admin Distance': '20 (eBGP)',
      }
    );
    steps.push({
      id: `step-${seq}`,
      stepIndex: seq,
      timestampMs: currentTimeMs,
      fromNodeId: peerNode.id,
      fromNodeName: peerNode.name,
      fromPortName: peerPort.shortName,
      toNodeId: sourceRouter.id,
      toNodeName: sourceRouter.name,
      toPortName: localPort.shortName,
      linkId: link.id,
      protocol: 'BGP_UPDATE',
      status: 'delivered',
      vlanTag: null,
      inboundPdu: updatePdu,
      outboundPdu: updatePdu,
      decisionTitle: `${peerNode.name} (AS ${peer.remoteAs}) → ${sourceRouter.name}: Анонс маршрутов BGP UPDATE (${advNets}, AS_PATH: ${asPathStr} i)`,
      osiActions: [
        {
          layer: 'L3',
          title: `Обновление таблицы BGP и RIB (AD 20)`,
          detail: `Маршрутизатор ${sourceRouter.name} получил префиксы [${advNets}] от провайдера ${peerNode.name} (Next-Hop ${peer.neighborIp}, Weight=${peer.weight}, LocalPref=${peer.localPref}, AS_PATH=${asPathStr}).`,
        },
        {
          layer: 'L7',
          title: updateSummary,
          detail: `Выбор лучшего пути (Best Path Selection): Weight → Local Preference → длина AS_PATH → задержка WAN (${peer.wanLatencyMs} мс).`,
        },
      ],
      nodeSnapshotAfter: {
        arpTable: JSON.parse(JSON.stringify(sourceRouter.arpTable)),
        macTable: JSON.parse(JSON.stringify(sourceRouter.macTable)),
      },
    });
    seq++;
    currentTimeMs += hopDelay + 140;
  }

  const { bestRoutes } = computeBgpRoutesForRouter(sourceRouter, allNodes, allLinks);
  const bestSummary = bestRoutes
    .map(
      (r) =>
        `${r.network}/${maskToCidr(r.mask)} via ${r.nextHop} (${r.learnedFromRouterName || 'eBGP'}, AS_PATH: ${r.bgpAsPath?.join(' ') || ''})`
    )
    .join('; ');

  return {
    steps,
    summaryMessage: `Обмен маршрутами eBGP (TCP 179) завершён: ${peers.length} пиров ESTABLISHED. Лучший маршрут (Best Path): ${bestSummary || 'установлен'}.`,
    success: true,
  };
}
