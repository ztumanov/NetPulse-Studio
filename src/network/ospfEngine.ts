import {
  getNetworkAddress,
  intToIp,
  ipToInt,
  isSameSubnet,
  isValidIpv4,
  isValidSubnetMask,
  maskToCidr,
} from './ipMath';
import {
  computeSpanningTreeState,
  getConnectedPeer,
  getRouterLogicalInterfaces,
  isLinkOperational,
  LogicalInterfaceView,
} from './simulator';
import {
  NetworkInterface,
  NetworkLink,
  NetworkNode,
  OspfConfig,
  OspfNeighborEntry,
  OspfNetworkStatement,
  RouteEntry,
  SimulationStep,
} from './types';

export const OSPF_MULTICAST_IP = '224.0.0.5';
export const OSPF_MULTICAST_MAC = '01:00:5E:00:00:05';

export function createDefaultOspfConfig(_node?: NetworkNode): OspfConfig {
  return {
    enabled: false,
    processId: 1,
    referenceBandwidthMbps: 100,
    networks: [],
    passiveInterfaces: [],
    ripEnabled: false,
  };
}

export const getDefaultOspfConfig = createDefaultOspfConfig;

/**
 * Converts a standard subnet mask (e.g. 255.255.255.0) to a Cisco wildcard mask (0.0.0.255).
 */
export function subnetMaskToWildcard(subnetMask: string): string {
  if (!isValidIpv4(subnetMask)) return '0.0.0.255';
  const maskInt = ipToInt(subnetMask);
  const wildcardInt = (~maskInt) >>> 0;
  return intToIp(wildcardInt);
}

/**
 * Converts a Cisco wildcard mask (e.g. 0.0.0.255) back to a subnet mask (255.255.255.0).
 */
export function wildcardToSubnetMask(wildcardMask: string): string {
  if (!isValidIpv4(wildcardMask)) return '255.255.255.0';
  const wcInt = ipToInt(wildcardMask);
  const maskInt = (~wcInt) >>> 0;
  return intToIp(maskInt);
}

/**
 * Normalizes user input that might be either a wildcard mask (0.0.0.255) or a subnet mask (255.255.255.0)
 * into a canonical Cisco wildcard mask.
 */
export function normalizeWildcardMask(maskOrWildcard?: string): string {
  const clean = (maskOrWildcard || '').trim();
  if (!isValidIpv4(clean)) return '0.0.0.255';
  if (clean === '0.0.0.0' || clean === '255.255.255.255') return clean;
  // If starts with 255., user typed a standard subnet mask -> invert it to wildcard
  if (clean.startsWith('255.') && isValidSubnetMask(clean)) {
    return subnetMaskToWildcard(clean);
  }
  return clean;
}

/**
 * Elects the OSPF Router-ID for a router:
 * 1. Explicit `ospfConfig.routerId` if valid IPv4
 * 2. Highest active IPv4 address on the router's interfaces
 * 3. Fallback deterministic ID based on router name
 */
export function electOspfRouterId(router: NetworkNode): string {
  if (router.ospfConfig?.routerId && isValidIpv4(router.ospfConfig.routerId)) {
    return router.ospfConfig.routerId;
  }

  const logicalIfaces = getRouterLogicalInterfaces(router).filter((i) =>
    isValidIpv4(i.ipAddress)
  );
  if (logicalIfaces.length > 0) {
    const sortedIps = logicalIfaces
      .map((i) => i.ipAddress)
      .sort((a, b) => (ipToInt(b) >>> 0) - (ipToInt(a) >>> 0));
    return sortedIps[0];
  }

  return '1.1.1.1';
}

/**
 * Checks whether an interface IPv4 address matches an OSPF `network <net> <wildcard> area <id>` statement.
 */
export function doesIpMatchOspfStatement(
  ipAddress: string,
  stmt: OspfNetworkStatement
): boolean {
  if (!isValidIpv4(ipAddress) || !isValidIpv4(stmt.network)) return false;
  const wildcard = normalizeWildcardMask(stmt.wildcard || stmt.wildcardMask);
  if (!isValidIpv4(wildcard)) return false;

  const ipInt = ipToInt(ipAddress) >>> 0;
  const netInt = ipToInt(stmt.network) >>> 0;
  const maskBits = (~ipToInt(wildcard)) >>> 0;

  return ((ipInt & maskBits) >>> 0) === ((netInt & maskBits) >>> 0);
}

/**
 * Returns the first matching OSPF network statement for a given router interface IP, or null if not matched.
 */
export function getMatchingOspfStatement(
  router: NetworkNode,
  ipAddress: string
): OspfNetworkStatement | null {
  const cfg = router.ospfConfig;
  if (!cfg || !cfg.enabled || !Array.isArray(cfg.networks)) return null;

  // Sort statements by most specific wildcard first (smallest wildcard int)
  const sorted = [...cfg.networks].sort(
    (a, b) =>
      (ipToInt(normalizeWildcardMask(a.wildcard || a.wildcardMask)) >>> 0) -
      (ipToInt(normalizeWildcardMask(b.wildcard || b.wildcardMask)) >>> 0)
  );

  for (const stmt of sorted) {
    if (doesIpMatchOspfStatement(ipAddress, stmt)) {
      return stmt;
    }
  }
  return null;
}

/**
 * Determines effective link bandwidth in Mbps for a router port:
 * - Explicit `port.bandwidthMbps` if configured
 * - 1000 Mbps for GigabitEthernet (`Gi...`) or Fiber cable
 * - 10 Mbps for Serial (`Se...`)
 * - 100 Mbps for FastEthernet (`Fa...`)
 */
export function getInterfaceBandwidthMbps(
  port: NetworkInterface,
  link?: NetworkLink | null
): number {
  if (typeof port.bandwidthMbps === 'number' && port.bandwidthMbps > 0) {
    return port.bandwidthMbps;
  }
  const shortLower = port.shortName.toLowerCase();
  if (link?.cableType === 'fiber' || shortLower.startsWith('gi')) {
    return 1000;
  }
  if (shortLower.startsWith('se')) {
    return 10;
  }
  return 100;
}

/**
 * Calculates Cisco OSPF interface cost using `Cost = ReferenceBandwidth (100 Mbps) / Bandwidth (Mbps)`
 * (minimum 1), or returns `port.ospfCost` if explicitly configured on the interface.
 */
export function calculateOspfInterfaceCost(
  port: NetworkInterface,
  link?: NetworkLink | null,
  referenceBandwidthMbps: number = 100
): number {
  if (typeof port.ospfCost === 'number' && port.ospfCost > 0) {
    return Math.max(1, Math.floor(port.ospfCost));
  }
  const refBw = referenceBandwidthMbps > 0 ? referenceBandwidthMbps : 100;
  const bw = getInterfaceBandwidthMbps(port, link);
  return Math.max(1, Math.round(refBw / bw));
}

export interface ReachableRouterPeer {
  peerRouter: NetworkNode;
  peerLogical: LogicalInterfaceView;
  localLogical: LogicalInterfaceView;
  firstLink: NetworkLink;
  effectiveCost: number;
  effectiveBandwidthMbps: number;
  isPointToPoint: boolean;
}

/**
 * Finds all peer routers whose interfaces are reachable at Layer 2 from `routerNode`'s `localLogical` interface
 * (either via a direct router-to-router cable or across operational L2 switches in the same VLAN without STP blocking)
 * AND share the same IPv4 subnet.
 */
export function discoverL2ReachableRouterPeers(
  routerNode: NetworkNode,
  localLogical: LogicalInterfaceView,
  allNodes: NetworkNode[],
  allLinks: NetworkLink[]
): ReachableRouterPeer[] {
  if (
    localLogical.physicalPort.adminStatus !== 'up' ||
    !isValidIpv4(localLogical.ipAddress) ||
    !isValidSubnetMask(localLogical.subnetMask)
  ) {
    return [];
  }

  const firstPeer = getConnectedPeer(
    routerNode.id,
    localLogical.physicalPort.id,
    allNodes,
    allLinks
  );
  if (!firstPeer || !isLinkOperational(firstPeer.link, allNodes)) {
    return [];
  }

  const stpMap = computeSpanningTreeState(allNodes, allLinks);
  const refBw = routerNode.ospfConfig?.referenceBandwidthMbps || 100;
  const results: ReachableRouterPeer[] = [];

  // BFS across L2 switches to find reachable router ports in the same VLAN
  interface QueueItem {
    currentNode: NetworkNode;
    egressPort: NetworkInterface;
    vlan: number;
    isTaggedOnWire: boolean;
  }

  const visitedPortPairs = new Set<string>();
  const queue: QueueItem[] = [
    {
      currentNode: routerNode,
      egressPort: localLogical.physicalPort,
      vlan: localLogical.vlanId,
      isTaggedOnWire: localLogical.isTagged8021Q,
    },
  ];

  while (queue.length > 0) {
    const item = queue.shift()!;
    const conn = getConnectedPeer(
      item.currentNode.id,
      item.egressPort.id,
      allNodes,
      allLinks
    );
    if (!conn || !isLinkOperational(conn.link, allNodes)) continue;

    const visitKey = `${conn.link.id}:${item.currentNode.id}->${conn.peerNode.id}:${item.vlan}`;
    if (visitedPortPairs.has(visitKey)) continue;
    visitedPortPairs.add(visitKey);

    const { peerNode, peerPort, link } = conn;

    if (peerNode.type === 'switch') {
      const swStp = stpMap[peerNode.id];
      if (swStp?.ports[peerPort.id]?.state === 'blocking') {
        continue;
      }

      let switchVlan = item.vlan;
      if (peerPort.vlanMode === 'access') {
        switchVlan = peerPort.accessVlan || 1;
      } else if (peerPort.vlanMode === 'trunk') {
        if (!peerPort.trunkAllowedVlans.includes(item.vlan)) continue;
      }

      for (const outPort of peerNode.interfaces) {
        if (outPort.id === peerPort.id || outPort.adminStatus !== 'up') continue;
        if (swStp?.ports[outPort.id]?.state === 'blocking') continue;

        if (outPort.vlanMode === 'access') {
          if ((outPort.accessVlan || 1) !== switchVlan) continue;
          queue.push({
            currentNode: peerNode,
            egressPort: outPort,
            vlan: switchVlan,
            isTaggedOnWire: false,
          });
        } else if (outPort.vlanMode === 'trunk') {
          if (!outPort.trunkAllowedVlans.includes(switchVlan)) continue;
          queue.push({
            currentNode: peerNode,
            egressPort: outPort,
            vlan: switchVlan,
            isTaggedOnWire: true,
          });
        }
      }
      continue;
    }

    if (peerNode.type === 'router' && peerNode.id !== routerNode.id) {
      const peerLogicals = getRouterLogicalInterfaces(peerNode).filter(
        (pl) => pl.physicalPort.id === peerPort.id
      );

      for (const pl of peerLogicals) {
        // Match VLAN tagging / subinterface compatibility
        if (pl.subinterface) {
          if (!item.isTaggedOnWire || pl.vlanId !== item.vlan) continue;
        }
        if (
          isValidIpv4(pl.ipAddress) &&
          isSameSubnet(
            localLogical.ipAddress,
            pl.ipAddress,
            localLogical.subnetMask
          )
        ) {
          const localBw = getInterfaceBandwidthMbps(
            localLogical.physicalPort,
            firstPeer.link
          );
          const peerBw = getInterfaceBandwidthMbps(pl.physicalPort, link);
          const effectiveBw = Math.min(localBw, peerBw);
          const localCost = calculateOspfInterfaceCost(
            localLogical.physicalPort,
            firstPeer.link,
            refBw
          );
          const peerCost = calculateOspfInterfaceCost(
            pl.physicalPort,
            link,
            refBw
          );
          const effectiveCost = Math.max(localCost, peerCost);

          results.push({
            peerRouter: peerNode,
            peerLogical: pl,
            localLogical,
            firstLink: firstPeer.link,
            effectiveCost,
            effectiveBandwidthMbps: effectiveBw,
            isPointToPoint: firstPeer.peerNode.id === peerNode.id,
          });
        }
      }
    }
  }

  return results;
}

/**
 * Builds the OSPF Neighbor Table (`show ip ospf neighbor`) for a given router.
 */
export function computeOspfNeighborsForRouter(
  routerNode: NetworkNode,
  allNodes: NetworkNode[],
  allLinks: NetworkLink[]
): OspfNeighborEntry[] {
  if (routerNode.type !== 'router' || !routerNode.ospfConfig?.enabled) {
    return [];
  }

  const passiveSet = new Set(
    (routerNode.ospfConfig.passiveInterfaces || []).map((s) => s.toLowerCase())
  );
  const neighbors: OspfNeighborEntry[] = [];
  const logicalIfaces = getRouterLogicalInterfaces(routerNode);

  for (const localLogical of logicalIfaces) {
    if (
      passiveSet.has(localLogical.logicalName.toLowerCase()) ||
      passiveSet.has(localLogical.physicalPort.shortName.toLowerCase())
    ) {
      continue;
    }

    const myStmt = getMatchingOspfStatement(routerNode, localLogical.ipAddress);
    if (!myStmt) continue;

    const reachablePeers = discoverL2ReachableRouterPeers(
      routerNode,
      localLogical,
      allNodes,
      allLinks
    );

    for (const peer of reachablePeers) {
      const peerCfg = peer.peerRouter.ospfConfig;
      if (!peerCfg?.enabled) continue;

      const peerPassiveSet = new Set(
        (peerCfg.passiveInterfaces || []).map((s) => s.toLowerCase())
      );
      if (
        peerPassiveSet.has(peer.peerLogical.logicalName.toLowerCase()) ||
        peerPassiveSet.has(peer.peerLogical.physicalPort.shortName.toLowerCase())
      ) {
        continue;
      }

      const peerStmt = getMatchingOspfStatement(
        peer.peerRouter,
        peer.peerLogical.ipAddress
      );
      if (!peerStmt || peerStmt.area !== myStmt.area) {
        continue;
      }

      const peerRouterId = electOspfRouterId(peer.peerRouter);
      const myRouterId = electOspfRouterId(routerNode);
      const state: OspfNeighborEntry['state'] = peer.isPointToPoint
        ? 'FULL/P2P'
        : (ipToInt(peerRouterId) >>> 0) > (ipToInt(myRouterId) >>> 0)
        ? 'FULL/DR'
        : 'FULL/BDR';

      neighbors.push({
        neighborRouterId: peerRouterId,
        neighborNodeId: peer.peerRouter.id,
        neighborName: peer.peerRouter.name,
        neighborRouterName: peer.peerRouter.name,
        priority: peer.isPointToPoint ? 0 : 1,
        state,
        deadTime: '00:00:38',
        neighborIp: peer.peerLogical.ipAddress,
        localInterface: localLogical.logicalName,
        area: myStmt.area,
        cost: peer.effectiveCost,
        interfaceCost: peer.effectiveCost,
        bandwidthMbps: peer.effectiveBandwidthMbps,
      });
    }
  }

  return neighbors;
}

/**
 * Runs Dijkstra's Shortest Path First (SPF) algorithm from `sourceRouter` across the OSPF topology
 * and returns all dynamically learned OSPF (`'O'`, AD 110) routes.
 */
export function computeDijkstraSpfRoutesForRouter(
  sourceRouter: NetworkNode,
  allNodes: NetworkNode[],
  allLinks: NetworkLink[]
): RouteEntry[] {
  if (sourceRouter.type !== 'router' || !sourceRouter.ospfConfig?.enabled) {
    return [];
  }

  const routers = allNodes.filter(
    (n) => n.type === 'router' && n.ospfConfig?.enabled
  );
  if (routers.length <= 1) return [];

  const routerById = new Map<string, NetworkNode>();
  for (const r of routers) {
    routerById.set(r.id, r);
  }

  // Dijkstra SPF state
  const dist = new Map<string, number>();
  const firstHopIp = new Map<string, string>();
  const firstHopOutIface = new Map<string, string>();
  const spfPathByNode = new Map<string, string[]>();
  const visited = new Set<string>();

  for (const r of routers) {
    dist.set(r.id, Number.POSITIVE_INFINITY);
  }
  dist.set(sourceRouter.id, 0);
  spfPathByNode.set(sourceRouter.id, [sourceRouter.name]);

  while (visited.size < routers.length) {
    let uId: string | null = null;
    let bestD = Number.POSITIVE_INFINITY;

    for (const [rId, d] of dist.entries()) {
      if (!visited.has(rId) && d < bestD) {
        bestD = d;
        uId = rId;
      }
    }

    if (!uId || !Number.isFinite(bestD)) break;
    visited.add(uId);

    const uRouter = routerById.get(uId)!;
    const uNeighbors = computeOspfNeighborsForRouter(
      uRouter,
      allNodes,
      allLinks
    );

    for (const nbr of uNeighbors) {
      if (visited.has(nbr.neighborNodeId)) continue;
      const altCost = bestD + nbr.cost;
      const currentVDist =
        dist.get(nbr.neighborNodeId) ?? Number.POSITIVE_INFINITY;

      if (altCost < currentVDist) {
        dist.set(nbr.neighborNodeId, altCost);
        if (uId === sourceRouter.id) {
          firstHopIp.set(nbr.neighborNodeId, nbr.neighborIp);
          firstHopOutIface.set(nbr.neighborNodeId, nbr.localInterface);
        } else {
          firstHopIp.set(nbr.neighborNodeId, firstHopIp.get(uId)!);
          firstHopOutIface.set(nbr.neighborNodeId, firstHopOutIface.get(uId)!);
        }
        spfPathByNode.set(nbr.neighborNodeId, [
          ...(spfPathByNode.get(uId) || [sourceRouter.name]),
          nbr.neighborName,
        ]);
      }
    }
  }

  // Collect all directly connected subnets on sourceRouter to avoid adding OSPF routes for local networks
  const localConnectedKeys = new Set<string>();
  for (const localLogical of getRouterLogicalInterfaces(sourceRouter)) {
    if (
      isValidIpv4(localLogical.ipAddress) &&
      isValidSubnetMask(localLogical.subnetMask)
    ) {
      const net = getNetworkAddress(
        localLogical.ipAddress,
        localLogical.subnetMask
      );
      localConnectedKeys.add(`${net}/${localLogical.subnetMask}`);
    }
  }

  // For each reachable remote OSPF router, collect its OSPF-advertised subnets
  const bestOspfRouteBySubnet = new Map<string, RouteEntry>();
  const refBw = sourceRouter.ospfConfig.referenceBandwidthMbps || 100;

  for (const remoteRouter of routers) {
    if (remoteRouter.id === sourceRouter.id) continue;
    const pathCostToRouter =
      dist.get(remoteRouter.id) ?? Number.POSITIVE_INFINITY;
    if (!Number.isFinite(pathCostToRouter)) continue;

    const nextHop = firstHopIp.get(remoteRouter.id);
    const outIface = firstHopOutIface.get(remoteRouter.id);
    const spfPath = spfPathByNode.get(remoteRouter.id) || [
      sourceRouter.name,
      remoteRouter.name,
    ];
    if (!nextHop || !outIface) continue;

    const remoteRouterId = electOspfRouterId(remoteRouter);
    const remoteLogicals = getRouterLogicalInterfaces(remoteRouter);

    for (const rLogical of remoteLogicals) {
      if (
        !isValidIpv4(rLogical.ipAddress) ||
        !isValidSubnetMask(rLogical.subnetMask)
      ) {
        continue;
      }

      // Check if this interface on remoteRouter is advertised into OSPF
      const stmt = getMatchingOspfStatement(remoteRouter, rLogical.ipAddress);
      if (!stmt) continue;

      const remoteNet = getNetworkAddress(
        rLogical.ipAddress,
        rLogical.subnetMask
      );
      const subnetKey = `${remoteNet}/${rLogical.subnetMask}`;
      if (localConnectedKeys.has(subnetKey)) continue;

      const peerConn = getConnectedPeer(
        remoteRouter.id,
        rLogical.physicalPort.id,
        allNodes,
        allLinks
      );
      const stubCost = calculateOspfInterfaceCost(
        rLogical.physicalPort,
        peerConn?.link,
        refBw
      );
      // If this remote interface is a transit subnet back toward an OSPF neighbor, its cost is already in pathCostToRouter;
      // if it is a stub/LAN network, add stubCost
      const isStubLan = !routers.some(
        (otherR) =>
          otherR.id !== remoteRouter.id &&
          getRouterLogicalInterfaces(otherR).some(
            (oi) =>
              isValidIpv4(oi.ipAddress) &&
              isSameSubnet(oi.ipAddress, rLogical.ipAddress, rLogical.subnetMask)
          )
      );
      const totalMetric = isStubLan
        ? pathCostToRouter + stubCost
        : pathCostToRouter;

      const existing = bestOspfRouteBySubnet.get(subnetKey);
      if (!existing || totalMetric < (existing.metric ?? Number.POSITIVE_INFINITY)) {
        bestOspfRouteBySubnet.set(subnetKey, {
          id: `ospf-${sourceRouter.id}-${remoteNet}-${maskToCidr(rLogical.subnetMask)}`,
          network: remoteNet,
          mask: rLogical.subnetMask,
          nextHop,
          interfaceName: outIface,
          type: 'O',
          administrativeDistance: 110,
          metric: totalMetric,
          ospfArea: stmt.area,
          learnedFromRouterId: remoteRouterId,
          learnedFromRouterName: remoteRouter.name,
          spfPath,
        });
      }
    }
  }

  return Array.from(bestOspfRouteBySubnet.values());
}

/**
 * Runs RIPv2 Distance-Vector (Bellman-Ford / Hop Count, AD 120) routing calculation for `sourceRouter`.
 */
export function computeRipRoutesForRouter(
  sourceRouter: NetworkNode,
  allNodes: NetworkNode[],
  allLinks: NetworkLink[]
): RouteEntry[] {
  if (sourceRouter.type !== 'router' || !sourceRouter.ospfConfig?.ripEnabled) {
    return [];
  }

  const ripRouters = allNodes.filter(
    (n) => n.type === 'router' && n.ospfConfig?.ripEnabled
  );
  if (ripRouters.length <= 1) return [];

  const routerById = new Map<string, NetworkNode>();
  for (const r of ripRouters) {
    routerById.set(r.id, r);
  }

  const hops = new Map<string, number>();
  const firstHopIp = new Map<string, string>();
  const firstHopOutIface = new Map<string, string>();
  const pathNames = new Map<string, string[]>();

  for (const r of ripRouters) {
    hops.set(r.id, Number.POSITIVE_INFINITY);
  }
  hops.set(sourceRouter.id, 0);
  pathNames.set(sourceRouter.id, [sourceRouter.name]);

  const queue: NetworkNode[] = [sourceRouter];
  while (queue.length > 0) {
    const curr = queue.shift()!;
    const currHops = hops.get(curr.id) ?? Number.POSITIVE_INFINITY;
    if (currHops >= 15) continue;

    for (const localLogical of getRouterLogicalInterfaces(curr)) {
      const peers = discoverL2ReachableRouterPeers(
        curr,
        localLogical,
        allNodes,
        allLinks
      );
      for (const peer of peers) {
        if (!peer.peerRouter.ospfConfig?.ripEnabled) continue;
        const candidateHops = currHops + 1;
        if (candidateHops < (hops.get(peer.peerRouter.id) ?? Number.POSITIVE_INFINITY)) {
          hops.set(peer.peerRouter.id, candidateHops);
          if (curr.id === sourceRouter.id) {
            firstHopIp.set(peer.peerRouter.id, peer.peerLogical.ipAddress);
            firstHopOutIface.set(peer.peerRouter.id, localLogical.logicalName);
          } else {
            firstHopIp.set(peer.peerRouter.id, firstHopIp.get(curr.id)!);
            firstHopOutIface.set(peer.peerRouter.id, firstHopOutIface.get(curr.id)!);
          }
          pathNames.set(peer.peerRouter.id, [
            ...(pathNames.get(curr.id) || [sourceRouter.name]),
            peer.peerRouter.name,
          ]);
          queue.push(peer.peerRouter);
        }
      }
    }
  }

  const localConnectedKeys = new Set<string>();
  for (const localLogical of getRouterLogicalInterfaces(sourceRouter)) {
    if (
      isValidIpv4(localLogical.ipAddress) &&
      isValidSubnetMask(localLogical.subnetMask)
    ) {
      const net = getNetworkAddress(
        localLogical.ipAddress,
        localLogical.subnetMask
      );
      localConnectedKeys.add(`${net}/${localLogical.subnetMask}`);
    }
  }

  const ripRoutes = new Map<string, RouteEntry>();
  for (const remoteRouter of ripRouters) {
    if (remoteRouter.id === sourceRouter.id) continue;
    const hopCount = hops.get(remoteRouter.id) ?? Number.POSITIVE_INFINITY;
    if (!Number.isFinite(hopCount) || hopCount > 15) continue;

    const nextHop = firstHopIp.get(remoteRouter.id);
    const outIface = firstHopOutIface.get(remoteRouter.id);
    if (!nextHop || !outIface) continue;

    for (const rLogical of getRouterLogicalInterfaces(remoteRouter)) {
      if (
        !isValidIpv4(rLogical.ipAddress) ||
        !isValidSubnetMask(rLogical.subnetMask)
      ) {
        continue;
      }
      const remoteNet = getNetworkAddress(
        rLogical.ipAddress,
        rLogical.subnetMask
      );
      const subnetKey = `${remoteNet}/${rLogical.subnetMask}`;
      if (localConnectedKeys.has(subnetKey)) continue;

      const existing = ripRoutes.get(subnetKey);
      if (!existing || hopCount < (existing.metric ?? 16)) {
        ripRoutes.set(subnetKey, {
          id: `rip-${sourceRouter.id}-${remoteNet}-${maskToCidr(rLogical.subnetMask)}`,
          network: remoteNet,
          mask: rLogical.subnetMask,
          nextHop,
          interfaceName: outIface,
          type: 'R',
          administrativeDistance: 120,
          metric: hopCount,
          learnedFromRouterName: remoteRouter.name,
          spfPath: pathNames.get(remoteRouter.id),
        });
      }
    }
  }

  return Array.from(ripRoutes.values());
}

/**
 * Synthesizes authentic OSPFv2 Hello (`224.0.0.5`, IP Proto 89) and Link-State Update (`OSPF_LSA`)
 * steps across active OSPF router links for Realtime / Simulation visualization.
 */
export function synthesizeOspfHelloSteps(
  nodes: NetworkNode[],
  links: NetworkLink[],
  startStepNumber: number = 1,
  startTimestampMs: number = 0
): SimulationStep[] {
  const steps: SimulationStep[] = [];
  let stepCounter = startStepNumber;
  let timestamp = startTimestampMs;

  const routers = nodes.filter(
    (n) => n.type === 'router' && n.ospfConfig?.enabled
  );
  if (routers.length === 0) return [];

  for (const rtr of routers) {
    const rtrId = electOspfRouterId(rtr);
    const passiveSet = new Set(
      (rtr.ospfConfig?.passiveInterfaces || []).map((s) => s.toLowerCase())
    );
    const logicalIfaces = getRouterLogicalInterfaces(rtr);

    for (const localLogical of logicalIfaces) {
      if (
        passiveSet.has(localLogical.logicalName.toLowerCase()) ||
        passiveSet.has(localLogical.physicalPort.shortName.toLowerCase())
      ) {
        continue;
      }

      const stmt = getMatchingOspfStatement(rtr, localLogical.ipAddress);
      if (!stmt) continue;

      const conn = getConnectedPeer(
        rtr.id,
        localLogical.physicalPort.id,
        nodes,
        links
      );
      if (!conn || !isLinkOperational(conn.link, nodes)) continue;

      const { link, peerNode, peerPort } = conn;
      const bwMbps = getInterfaceBandwidthMbps(localLogical.physicalPort, link);
      const cost = calculateOspfInterfaceCost(
        localLogical.physicalPort,
        link,
        rtr.ospfConfig?.referenceBandwidthMbps || 100
      );

      const helloPdu = {
        l1: {
          inPort: 'OSPF Process 1',
          outPort: localLogical.logicalName,
          cableType: link.cableType,
          physicalStatus: `${bwMbps} Mbps Full-Duplex (Cost ${cost})`,
        },
        l2: {
          headerType: (localLogical.isTagged8021Q
            ? 'IEEE 802.1Q'
            : 'Ethernet II') as 'Ethernet II' | 'IEEE 802.1Q',
          srcMac: localLogical.macAddress,
          dstMac: OSPF_MULTICAST_MAC,
          etherType: '0x0800 (IPv4)' as const,
          vlanTag: localLogical.isTagged8021Q ? localLogical.vlanId : null,
        },
        l3: {
          headerType: 'OSPFv2 Packet (IP Proto 89)' as const,
          srcIp: localLogical.ipAddress,
          dstIp: OSPF_MULTICAST_IP,
          ttl: 1,
          protocol: 'OSPF (89)',
        },
        l4: {
          type: 'OSPF_HELLO' as const,
          summary: `OSPFv2 Hello · Area ${stmt.area} · RID ${rtrId} · Cost ${cost}`,
          seqNumber: stepCounter,
        },
        l7: {
          appProtocol: 'OSPF' as const,
          headline: `OSPFv2 Hello Packet (${rtr.name} → AllSPFRouters 224.0.0.5)`,
          fields: {
            'Router ID': rtrId,
            'Area ID': `0.0.0.${stmt.area} (Area ${stmt.area})`,
            'Hello / Dead Interval': '10s / 40s',
            'Interface Bandwidth': `${bwMbps} Mbps`,
            'OSPF Link Cost': `${cost} (100 Mbps / ${bwMbps} Mbps)`,
            'Multicast Group': '224.0.0.5 (AllSPFRouters)',
          },
        },
      };

      steps.push({
        id: `ospf-hello-${stepCounter}-${rtr.id}-${peerNode.id}`,
        stepIndex: stepCounter++,
        timestampMs: timestamp,
        fromNodeId: rtr.id,
        fromNodeName: rtr.name,
        fromPortName: localLogical.logicalName,
        toNodeId: peerNode.id,
        toNodeName: peerNode.name,
        toPortName: peerPort.shortName,
        linkId: link.id,
        protocol: 'OSPF_HELLO',
        status: 'forwarded',
        vlanTag: localLogical.isTagged8021Q ? localLogical.vlanId : null,
        inboundPdu: helloPdu,
        outboundPdu: {
          ...helloPdu,
          l1: {
            ...helloPdu.l1,
            inPort: peerPort.shortName,
            outPort:
              peerNode.type === 'router'
                ? 'OSPF Adjacency Engine'
                : 'L2 Multicast Flood',
          },
        },
        decisionTitle: `${rtr.name} → ${peerNode.name}: Пакет OSPFv2 Hello (Area ${stmt.area}, Router-ID ${rtrId}, Cost=${cost})`,
        osiActions: [
          {
            layer: 'L3',
            title: 'Multicast-рассылка OSPF Hello на адрес 224.0.0.5 (TTL=1)',
            detail: `Маршрутизатор ${rtr.name} (RID ${rtrId}) отправляет Hello-пакет через ${localLogical.logicalName} (${localLogical.ipAddress}) для поддержания соседства в Area ${stmt.area}.`,
          },
          {
            layer: 'L7',
            title: `Метрика канала OSPF Cost = ${cost} (Bandwidth ${bwMbps} Mbps)`,
            detail: `Стоимость рассчитывается по формуле Cost = 100 Mbps / ${bwMbps} Mbps = ${cost} и используется алгоритмом Дейкстры (SPF).`,
          },
        ],
        nodeSnapshotAfter: {
          arpTable: [...peerNode.arpTable],
          macTable: [...peerNode.macTable],
        },
      });
      timestamp += 6;

      // If peerNode is also an OSPF-enabled router on the same link, emit an OSPF_LSA (Link-State Update)
      if (peerNode.type === 'router' && peerNode.ospfConfig?.enabled) {
        const advertisedNets = getRouterLogicalInterfaces(rtr)
          .filter((i) => getMatchingOspfStatement(rtr, i.ipAddress))
          .map((i) => `${getNetworkAddress(i.ipAddress, i.subnetMask)}/${maskToCidr(i.subnetMask)}`)
          .join(', ');

        const peerIp =
          peerNode.interfaces.find((p) => p.id === peerPort.id)?.ipAddress ||
          OSPF_MULTICAST_IP;

        const lsaPdu = {
          ...helloPdu,
          l3: {
            ...helloPdu.l3,
            dstIp: peerIp || OSPF_MULTICAST_IP,
          },
          l4: {
            type: 'OSPF_LSA' as const,
            summary: `OSPFv2 LSU (Type-1 Router LSA) · Networks: ${advertisedNets || 'Area 0'}`,
            seqNumber: stepCounter,
          },
          l7: {
            appProtocol: 'OSPF' as const,
            headline: `OSPFv2 Link-State Update / LSA (${rtr.name} → ${peerNode.name})`,
            fields: {
              'Advertising Router': `${rtrId} (${rtr.name})`,
              'LSA Type': 'Type 1 — Router LSA (Intra-Area)',
              'Advertised Subnets': advertisedNets || 'None',
              'SPF Tree Calculation': `Dijkstra SPF Cost = ${cost}`,
              'Adjacency State': 'FULL',
            },
          },
        };

        steps.push({
          id: `ospf-lsa-${stepCounter}-${rtr.id}-${peerNode.id}`,
          stepIndex: stepCounter++,
          timestampMs: timestamp,
          fromNodeId: rtr.id,
          fromNodeName: rtr.name,
          fromPortName: localLogical.logicalName,
          toNodeId: peerNode.id,
          toNodeName: peerNode.name,
          toPortName: peerPort.shortName,
          linkId: link.id,
          protocol: 'OSPF_LSA',
          status: 'delivered',
          vlanTag: localLogical.isTagged8021Q ? localLogical.vlanId : null,
          inboundPdu: lsaPdu,
          outboundPdu: {
            ...lsaPdu,
            l1: {
              ...lsaPdu.l1,
              inPort: peerPort.shortName,
              outPort: 'LSDB & Dijkstra SPF Engine',
            },
          },
          decisionTitle: `${peerNode.name}: Принят пакет OSPFv2 LSA от ${rtr.name} — обновление базы LSDB и пересчёт дерева Дейкстры (SPF) для сетей [${advertisedNets}]`,
          osiActions: [
            {
              layer: 'L3',
              title: 'Синхронизация базы данных состояния каналов (LSDB)',
              detail: `${peerNode.name} получает список подсетей [${advertisedNets}] от соседа ${rtr.name} (${rtrId}).`,
            },
            {
              layer: 'L7',
              title: 'Расчёт кратчайшего пути по алгоритму Дейкстры (SPF)',
              detail: `Маршруты с кодом 'O' (Administrative Distance 110) автоматически устанавливаются в таблицу маршрутизации.`,
            },
          ],
          nodeSnapshotAfter: {
            arpTable: [...peerNode.arpTable],
            macTable: [...peerNode.macTable],
          },
        });
        timestamp += 6;
      }
    }
  }

  return steps;
}

/**
 * Automatically enables OSPF Process 1 (Area 0) on a router and adds `network <subnet> <wildcard> area 0`
 * statements for all currently configured IPv4 interfaces and 802.1Q subinterfaces on that router.
 */
export function enableOspfAutoArea0OnRouter(
  routerNode: NetworkNode,
  area: number = 0
): NetworkNode {
  const existingCfg = routerNode.ospfConfig || createDefaultOspfConfig();
  const logicalIfaces = getRouterLogicalInterfaces(routerNode).filter(
    (i) => isValidIpv4(i.ipAddress) && isValidSubnetMask(i.subnetMask)
  );

  const nextStatements: OspfNetworkStatement[] = [...existingCfg.networks];

  for (const iface of logicalIfaces) {
    const net = getNetworkAddress(iface.ipAddress, iface.subnetMask);
    const wildcard = subnetMaskToWildcard(iface.subnetMask);
    const alreadyExists = nextStatements.some(
      (s) =>
        s.network === net &&
        normalizeWildcardMask(s.wildcard || s.wildcardMask) === wildcard &&
        s.area === area
    );
    if (!alreadyExists) {
      nextStatements.push({
        id: `ospf-net-${net}-${area}-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
        network: net,
        wildcard,
        wildcardMask: wildcard,
        area,
      });
    }
  }

  // Fallback if router has no IP interfaces yet: add 0.0.0.0 255.255.255.255 area 0
  if (nextStatements.length === 0) {
    nextStatements.push({
      id: `ospf-net-all-${Date.now()}`,
      network: '0.0.0.0',
      wildcard: '255.255.255.255',
      wildcardMask: '255.255.255.255',
      area,
    });
  }

  return {
    ...routerNode,
    ospfConfig: {
      ...existingCfg,
      enabled: true,
      processId: existingCfg.processId || 1,
      referenceBandwidthMbps: existingCfg.referenceBandwidthMbps || 100,
      networks: nextStatements,
    },
  };
}

/**
 * Adds a single `network <network> <wildcard> area <area>` statement to a router's OSPF config.
 */
export function addOspfNetworkStatementToRouter(
  routerNode: NetworkNode,
  networkInput: string,
  wildcardOrMaskInput: string,
  areaInput: number = 0
): { updatedNode: NetworkNode; error: string | null; statement?: OspfNetworkStatement } {
  const rawNet = networkInput.trim();
  const rawWildcard = wildcardOrMaskInput.trim();
  const cleanArea = Math.max(0, Math.floor(Number(areaInput) || 0));

  if (!isValidIpv4(rawNet)) {
    return {
      updatedNode: routerNode,
      error: 'Некорректный IPv4-адрес сети для анонса OSPF',
    };
  }
  if (!isValidIpv4(rawWildcard)) {
    return {
      updatedNode: routerNode,
      error: 'Некорректная Wildcard-маска (например 0.0.0.255 или 0.0.0.3)',
    };
  }

  const wildcard = normalizeWildcardMask(rawWildcard);
  const subnetMask = wildcardToSubnetMask(wildcard);
  const normalizedNet = isValidSubnetMask(subnetMask)
    ? getNetworkAddress(rawNet, subnetMask)
    : rawNet;

  const existingCfg = routerNode.ospfConfig || createDefaultOspfConfig();
  const filtered = existingCfg.networks.filter(
    (s) =>
      !(
        s.network === normalizedNet &&
        normalizeWildcardMask(s.wildcard || s.wildcardMask) === wildcard &&
        s.area === cleanArea
      )
  );

  const newStmt: OspfNetworkStatement = {
    id: `ospf-stmt-${normalizedNet}-${cleanArea}-${Date.now()}`,
    network: normalizedNet,
    wildcard,
    wildcardMask: wildcard,
    area: cleanArea,
  };

  return {
    updatedNode: {
      ...routerNode,
      ospfConfig: {
        ...existingCfg,
        enabled: true,
        networks: [...filtered, newStmt],
      },
    },
    error: null,
    statement: newStmt,
  };
}
