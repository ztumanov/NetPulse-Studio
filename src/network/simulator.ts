import {
  AclRule,
  ArpEntry,
  DhcpPool,
  HttpResponseResult,
  MacTableEntry,
  NatTranslationEntry,
  NetworkInterface,
  NetworkLink,
  NetworkNode,
  OsiPduDetails,
  ProtocolType,
  RouteEntry,
  RouterSubinterface,
  SimulationStep,
  StepStatus,
  StpPortStatus,
  StpSwitchState,
  TracerouteHop,
} from './types';
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
  computeDijkstraSpfRoutesForRouter,
  computeRipRoutesForRouter,
} from './ospfEngine';

export const BROADCAST_MAC = 'FF:FF:FF:FF:FF:FF';
export const BROADCAST_IP = '255.255.255.255';

export interface LogicalInterfaceView {
  physicalPort: NetworkInterface;
  subinterface?: RouterSubinterface;
  logicalName: string; // e.g., 'Fa0/0' or 'Fa0/0.10'
  ipAddress: string;
  subnetMask: string;
  macAddress: string;
  vlanId: number;
  isTagged8021Q: boolean;
  helperAddress?: string;
  natRole?: 'none' | 'inside' | 'outside';
}

/**
 * Returns all active L3 logical interfaces on a node (physical ports + 802.1Q subinterfaces).
 */
export function getRouterLogicalInterfaces(node: NetworkNode): LogicalInterfaceView[] {
  const views: LogicalInterfaceView[] = [];
  for (const iface of node.interfaces) {
    if (iface.adminStatus !== 'up') continue;

    if (isValidIpv4(iface.ipAddress) && isValidIpv4(iface.subnetMask)) {
      views.push({
        physicalPort: iface,
        logicalName: iface.shortName,
        ipAddress: iface.ipAddress,
        subnetMask: iface.subnetMask,
        macAddress: iface.macAddress,
        vlanId: iface.accessVlan || 1,
        isTagged8021Q: iface.vlanMode === 'trunk',
        helperAddress: iface.helperAddress,
        natRole: iface.natRole,
      });
    }

    if (Array.isArray(iface.subinterfaces)) {
      for (const sub of iface.subinterfaces) {
        if (isValidIpv4(sub.ipAddress) && isValidIpv4(sub.subnetMask) && sub.vlanId >= 1 && sub.vlanId <= 4094) {
          views.push({
            physicalPort: iface,
            subinterface: sub,
            logicalName: `${iface.shortName}.${sub.vlanId}`,
            ipAddress: sub.ipAddress,
            subnetMask: sub.subnetMask,
            macAddress: iface.macAddress,
            vlanId: sub.vlanId,
            isTagged8021Q: true,
            helperAddress: sub.helperAddress || iface.helperAddress,
            natRole: sub.natRole || iface.natRole,
          });
        }
      }
    }
  }
  return views;
}

/**
 * Finds a specific logical interface on a node by its logical name (e.g., 'Fa0/0' or 'Fa0/0.10').
 */
export function findLogicalInterfaceByName(
  node: NetworkNode,
  logicalName: string
): LogicalInterfaceView | undefined {
  const norm = logicalName.trim().toLowerCase();
  const views = getRouterLogicalInterfaces(node);
  const found = views.find((v) => v.logicalName.toLowerCase() === norm);
  if (found) return found;

  // Fallback for physical interface without IP or when subinterface was referenced
  const phys = node.interfaces.find((p) => p.shortName.toLowerCase() === norm);
  if (phys && phys.adminStatus === 'up') {
    return {
      physicalPort: phys,
      logicalName: phys.shortName,
      ipAddress: phys.ipAddress,
      subnetMask: phys.subnetMask,
      macAddress: phys.macAddress,
      vlanId: phys.accessVlan || 1,
      isTagged8021Q: phys.vlanMode === 'trunk',
      helperAddress: phys.helperAddress,
      natRole: phys.natRole,
    };
  }
  return undefined;
}

/**
 * Automatically builds Connected ('C') routes from active interfaces and 802.1Q subinterfaces
 * with IPv4 addresses, preserving Static ('S') routes configured by the user, and computing
 * Dynamic OSPFv2 ('O', AD 110) and RIPv2 ('R', AD 120) routes when topology context is provided.
 */
export function syncConnectedRoutes(
  node: NetworkNode,
  allNodes?: NetworkNode[],
  allLinks?: NetworkLink[]
): RouteEntry[] {
  const staticRoutes = node.routingTable.filter((r) => r.type === 'S');
  const connectedRoutes: RouteEntry[] = [];

  for (const iface of node.interfaces) {
    if (iface.adminStatus !== 'up') continue;

    if (isValidIpv4(iface.ipAddress) && isValidIpv4(iface.subnetMask)) {
      const network = getNetworkAddress(iface.ipAddress, iface.subnetMask);
      connectedRoutes.push({
        id: `conn-${iface.id}`,
        network,
        mask: iface.subnetMask,
        nextHop: 'Directly Connected',
        interfaceName: iface.shortName,
        type: 'C',
        administrativeDistance: 0,
        metric: 0,
      });
    }

    if (Array.isArray(iface.subinterfaces)) {
      for (const sub of iface.subinterfaces) {
        if (
          sub.vlanId >= 1 &&
          sub.vlanId <= 4094 &&
          isValidIpv4(sub.ipAddress) &&
          isValidIpv4(sub.subnetMask)
        ) {
          const network = getNetworkAddress(sub.ipAddress, sub.subnetMask);
          connectedRoutes.push({
            id: `conn-${iface.id}-sub-${sub.vlanId}`,
            network,
            mask: sub.subnetMask,
            nextHop: 'Directly Connected',
            interfaceName: `${iface.shortName}.${sub.vlanId}`,
            type: 'C',
            administrativeDistance: 0,
            metric: 0,
          });
        }
      }
    }
  }

  let dynamicRoutes: RouteEntry[] = [];
  if (node.type === 'router' && allNodes && allLinks) {
    const ospfRoutes = computeDijkstraSpfRoutesForRouter(node, allNodes, allLinks);
    const ripRoutes = computeRipRoutesForRouter(node, allNodes, allLinks);
    dynamicRoutes = [...ospfRoutes];
    for (const rip of ripRoutes) {
      const alreadyInOspf = dynamicRoutes.some(
        (o) => o.network === rip.network && o.mask === rip.mask
      );
      if (!alreadyInOspf) {
        dynamicRoutes.push(rip);
      }
    }
  } else if (node.type === 'router') {
    // Preserve existing dynamic routes if topology context was not passed
    dynamicRoutes = node.routingTable.filter(
      (r) =>
        (r.type === 'O' && node.ospfConfig?.enabled) ||
        (r.type === 'R' && node.ospfConfig?.ripEnabled)
    );
  }

  return [...connectedRoutes, ...staticRoutes, ...dynamicRoutes];
}

/**
 * Synchronizes routing tables on all routers in the topology (Connected + Static + OSPF SPF + RIPv2).
 */
export function syncAllRoutersRoutingTables(
  nodes: NetworkNode[],
  links: NetworkLink[]
): NetworkNode[] {
  return nodes.map((n) => {
    if (n.type !== 'router') return n;
    return {
      ...n,
      routingTable: syncConnectedRoutes(n, nodes, links),
    };
  });
}

function getRouteAdminDistance(route: RouteEntry): number {
  if (route.administrativeDistance !== undefined) return route.administrativeDistance;
  if (route.type === 'C') return 0;
  if (route.type === 'S') return 1;
  if (route.type === 'O') return 110;
  return 120;
}

/**
 * Longest Prefix Match (LPM) lookup on a router's routing table,
 * breaking ties by Administrative Distance (C=0, S=1, O=110, R=120) and then Metric (Cost).
 */
export function findBestRoute(
  node: NetworkNode,
  dstIp: string,
  allNodes?: NetworkNode[],
  allLinks?: NetworkLink[]
): RouteEntry | null {
  if (!isValidIpv4(dstIp)) return null;
  const routes = syncConnectedRoutes(node, allNodes, allLinks);
  let bestRoute: RouteEntry | null = null;
  let longestPrefix = -1;

  for (const route of routes) {
    if (!isValidIpv4(route.network) || !isValidIpv4(route.mask)) continue;
    const egress = findLogicalInterfaceByName(node, route.interfaceName);
    if (!egress || egress.physicalPort.adminStatus !== 'up') continue;
    if (allNodes && allLinks) {
      const peer = getConnectedPeer(node.id, egress.physicalPort.id, allNodes, allLinks);
      if (!peer || !isLinkOperational(peer.link, allNodes)) continue;
    }

    if (isSameSubnet(dstIp, route.network, route.mask)) {
      const prefixLen = maskToCidr(route.mask);
      if (prefixLen > longestPrefix) {
        longestPrefix = prefixLen;
        bestRoute = route;
      } else if (prefixLen === longestPrefix && bestRoute) {
        const currentAd = getRouteAdminDistance(route);
        const bestAd = getRouteAdminDistance(bestRoute);
        if (
          currentAd < bestAd ||
          (currentAd === bestAd && (route.metric ?? 0) < (bestRoute.metric ?? 0))
        ) {
          bestRoute = route;
        }
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

/**
 * Computes IEEE 802.1D Spanning Tree Protocol (STP) state for all switches in the topology.
 * Automatically elects a Root Bridge per connected L2 component and places redundant loop links
 * into 'blocking' (BLK) state.
 */
export function computeSpanningTreeState(
  nodes: NetworkNode[],
  links: NetworkLink[]
): Record<string, StpSwitchState> {
  const switches = nodes.filter((n) => n.type === 'switch');
  const result: Record<string, StpSwitchState> = {};
  if (switches.length === 0) return result;

  const getBridgePriority = (sw: NetworkNode) => sw.stpPriority ?? 32768;
  const getBridgeMac = (sw: NetworkNode) => {
    const macs = sw.interfaces
      .map((i) => i.macAddress.toUpperCase())
      .filter(Boolean)
      .sort();
    return macs[0] || '00:00:00:FF:FF:FF';
  };

  const compareBridgeId = (a: NetworkNode, b: NetworkNode): number => {
    const prioDiff = getBridgePriority(a) - getBridgePriority(b);
    if (prioDiff !== 0) return prioDiff;
    const macA = getBridgeMac(a);
    const macB = getBridgeMac(b);
    if (macA !== macB) return macA.localeCompare(macB);
    return a.id.localeCompare(b.id);
  };

  const getPortLinkCost = (port: NetworkInterface, link: NetworkLink): number => {
    if (
      link.cableType === 'fiber' ||
      port.shortName.toLowerCase().startsWith('gi') ||
      port.name.toLowerCase().includes('gigabit')
    ) {
      return 4; // 1 Gbps IEEE 802.1D cost
    }
    return 19; // 100 Mbps IEEE 802.1D cost
  };

  // Build adjacency of operational switch-to-switch links
  const visitedSw = new Set<string>();

  for (const startSw of switches) {
    if (visitedSw.has(startSw.id)) continue;

    // BFS to find all switches in this connected L2 component
    const component: NetworkNode[] = [];
    const bfsQueue: NetworkNode[] = [startSw];
    visitedSw.add(startSw.id);

    while (bfsQueue.length > 0) {
      const curr = bfsQueue.shift()!;
      component.push(curr);

      for (const port of curr.interfaces) {
        if (port.adminStatus !== 'up') continue;
        const peer = getConnectedPeer(curr.id, port.id, nodes, links);
        if (
          peer &&
          peer.peerNode.type === 'switch' &&
          peer.peerPort.adminStatus === 'up' &&
          !visitedSw.has(peer.peerNode.id)
        ) {
          visitedSw.add(peer.peerNode.id);
          bfsQueue.push(peer.peerNode);
        }
      }
    }

    // Elect Root Bridge for this component
    const sortedByBid = [...component].sort(compareBridgeId);
    const rootSwitch = sortedByBid[0];
    const rootBridgeId = `${getBridgePriority(rootSwitch)}.${getBridgeMac(rootSwitch)}`;

    // Bellman-Ford / Relaxation for Root Path Cost and Root Port selection
    const costToRoot = new Map<string, number>();
    const rootPortIdBySw = new Map<string, string | null>();
    const upstreamSwBySw = new Map<string, NetworkNode | null>();
    const upstreamPortIdxBySw = new Map<string, number>();

    for (const sw of component) {
      if (sw.id === rootSwitch.id) {
        costToRoot.set(sw.id, 0);
        rootPortIdBySw.set(sw.id, null);
        upstreamSwBySw.set(sw.id, null);
        upstreamPortIdxBySw.set(sw.id, -1);
      } else {
        costToRoot.set(sw.id, Number.POSITIVE_INFINITY);
        rootPortIdBySw.set(sw.id, null);
        upstreamSwBySw.set(sw.id, null);
        upstreamPortIdxBySw.set(sw.id, Number.POSITIVE_INFINITY);
      }
    }

    let changed = true;
    let iterations = 0;
    while (changed && iterations < component.length * 4) {
      changed = false;
      iterations++;

      for (const sw of component) {
        if (sw.id === rootSwitch.id) continue;

        for (let localIdx = 0; localIdx < sw.interfaces.length; localIdx++) {
          const port = sw.interfaces[localIdx];
          if (port.adminStatus !== 'up') continue;
          const peer = getConnectedPeer(sw.id, port.id, nodes, links);
          if (!peer || peer.peerNode.type !== 'switch' || peer.peerPort.adminStatus !== 'up') {
            continue;
          }
          if (peer.peerNode.id === sw.id) continue; // Ignore self-loop for root path

          const neighborCost = costToRoot.get(peer.peerNode.id) ?? Number.POSITIVE_INFINITY;
          if (!Number.isFinite(neighborCost)) continue;

          const candidateCost = neighborCost + getPortLinkCost(port, peer.link);
          const currentBestCost = costToRoot.get(sw.id) ?? Number.POSITIVE_INFINITY;
          const currentUpstream = upstreamSwBySw.get(sw.id);
          const currentPeerPortIdx = upstreamPortIdxBySw.get(sw.id) ?? Number.POSITIVE_INFINITY;
          const candidatePeerPortIdx = peer.peerNode.interfaces.findIndex(
            (i) => i.id === peer.peerPort.id
          );
          const currentLocalPortIdx = sw.interfaces.findIndex(
            (i) => i.id === rootPortIdBySw.get(sw.id)
          );

          let isBetter = false;
          if (candidateCost < currentBestCost) {
            isBetter = true;
          } else if (candidateCost === currentBestCost && currentUpstream) {
            const bidCmp = compareBridgeId(peer.peerNode, currentUpstream);
            if (bidCmp < 0) {
              isBetter = true;
            } else if (bidCmp === 0) {
              if (candidatePeerPortIdx < currentPeerPortIdx) {
                isBetter = true;
              } else if (
                candidatePeerPortIdx === currentPeerPortIdx &&
                localIdx < currentLocalPortIdx
              ) {
                isBetter = true;
              }
            }
          }

          if (isBetter) {
            costToRoot.set(sw.id, candidateCost);
            rootPortIdBySw.set(sw.id, port.id);
            upstreamSwBySw.set(sw.id, peer.peerNode);
            upstreamPortIdxBySw.set(sw.id, candidatePeerPortIdx);
            changed = true;
          }
        }
      }
    }

    // Initialize STP state structures for every switch in component
    for (const sw of component) {
      const rpId = rootPortIdBySw.get(sw.id) || null;
      const rpPort = rpId ? sw.interfaces.find((i) => i.id === rpId) : null;
      const portsRecord: Record<string, StpPortStatus> = {};

      for (let idx = 0; idx < sw.interfaces.length; idx++) {
        const port = sw.interfaces[idx];
        const peer = getConnectedPeer(sw.id, port.id, nodes, links);
        const isUp =
          port.adminStatus === 'up' &&
          Boolean(peer) &&
          peer!.peerPort.adminStatus === 'up';

        if (!isUp || !peer) {
          portsRecord[port.id] = {
            portId: port.id,
            portShortName: port.shortName,
            role: 'disabled',
            state: 'disabled',
            pathCost: 19,
            designatedBridgeId: `${getBridgePriority(sw)}.${getBridgeMac(sw)}`,
          };
          continue;
        }

        const linkCost = getPortLinkCost(port, peer.link);

        // Edge port connected to Router, PC, or Server -> Designated Forwarding
        if (peer.peerNode.type !== 'switch') {
          portsRecord[port.id] = {
            portId: port.id,
            portShortName: port.shortName,
            role: 'designated',
            state: 'forwarding',
            pathCost: linkCost,
            designatedBridgeId: `${getBridgePriority(sw)}.${getBridgeMac(sw)}`,
            peerNodeName: peer.peerNode.name,
            peerPortName: peer.peerPort.shortName,
          };
          continue;
        }

        // Switch-to-Switch port: determine Root / Designated / Alternate (Blocking)
        const myRootPortId = rootPortIdBySw.get(sw.id);
        const peerRootPortId = rootPortIdBySw.get(peer.peerNode.id);

        if (myRootPortId === port.id) {
          portsRecord[port.id] = {
            portId: port.id,
            portShortName: port.shortName,
            role: 'root',
            state: 'forwarding',
            pathCost: linkCost,
            designatedBridgeId: `${getBridgePriority(peer.peerNode)}.${getBridgeMac(peer.peerNode)}`,
            peerNodeName: peer.peerNode.name,
            peerPortName: peer.peerPort.shortName,
          };
        } else if (peerRootPortId === peer.peerPort.id) {
          // Peer switch uses this link as its Root Port -> we are Designated for this link!
          portsRecord[port.id] = {
            portId: port.id,
            portShortName: port.shortName,
            role: 'designated',
            state: 'forwarding',
            pathCost: linkCost,
            designatedBridgeId: `${getBridgePriority(sw)}.${getBridgeMac(sw)}`,
            peerNodeName: peer.peerNode.name,
            peerPortName: peer.peerPort.shortName,
          };
        } else {
          // Redundant loop link! Neither end is a Root Port.
          // Compare (myCostToRoot, myBridgeId, myPortIndex) vs (peerCostToRoot, peerBridgeId, peerPortIndex)
          const myCost = costToRoot.get(sw.id) ?? Number.POSITIVE_INFINITY;
          const peerCost = costToRoot.get(peer.peerNode.id) ?? Number.POSITIVE_INFINITY;
          const peerPortIdx = peer.peerNode.interfaces.findIndex(
            (i) => i.id === peer.peerPort.id
          );

          let iAmDesignated = false;
          if (myCost < peerCost) {
            iAmDesignated = true;
          } else if (myCost === peerCost) {
            const bidCmp = compareBridgeId(sw, peer.peerNode);
            if (bidCmp < 0) {
              iAmDesignated = true;
            } else if (bidCmp === 0 && idx < peerPortIdx) {
              iAmDesignated = true;
            }
          }

          portsRecord[port.id] = {
            portId: port.id,
            portShortName: port.shortName,
            role: iAmDesignated ? 'designated' : 'alternate',
            state: iAmDesignated ? 'forwarding' : 'blocking',
            pathCost: linkCost,
            designatedBridgeId: iAmDesignated
              ? `${getBridgePriority(sw)}.${getBridgeMac(sw)}`
              : `${getBridgePriority(peer.peerNode)}.${getBridgeMac(peer.peerNode)}`,
            peerNodeName: peer.peerNode.name,
            peerPortName: peer.peerPort.shortName,
          };
        }
      }

      result[sw.id] = {
        bridgePriority: getBridgePriority(sw),
        bridgeMac: getBridgeMac(sw),
        rootBridgeId,
        rootBridgeName: rootSwitch.name,
        isRootBridge: sw.id === rootSwitch.id,
        rootPathCost: costToRoot.get(sw.id) ?? 0,
        rootPortName: rpPort ? rpPort.shortName : null,
        ports: portsRecord,
      };
    }
  }

  return result;
}

/**
 * Helper to check if an IP matches an ACL address specification ('any', exact IPv4, or CIDR '192.168.1.0/24').
 */
function matchesAclIpSpec(ip: string, spec: string): boolean {
  const cleanSpec = (spec || 'any').trim().toLowerCase();
  if (!cleanSpec || cleanSpec === 'any' || cleanSpec === '*' || cleanSpec === '0.0.0.0/0') {
    return true;
  }
  if (!isValidIpv4(ip)) return false;

  if (cleanSpec.startsWith('host ')) {
    const hostIp = cleanSpec.slice(5).trim();
    return ip === hostIp;
  }

  if (cleanSpec.includes('/')) {
    const [netPart, prefixStr] = cleanSpec.split('/');
    const prefix = Number(prefixStr);
    if (!isValidIpv4(netPart) || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
      return false;
    }
    const maskInt = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    const maskIp = intToIp(maskInt);
    return isSameSubnet(ip, netPart, maskIp);
  }

  // Space-separated network + mask or wildcard mask
  if (cleanSpec.includes(' ')) {
    const parts = cleanSpec.split(/\s+/);
    if (parts.length === 2 && isValidIpv4(parts[0]) && isValidIpv4(parts[1])) {
      if (isValidSubnetMask(parts[1])) {
        return isSameSubnet(ip, parts[0], parts[1]);
      }
      // Wildcard mask (e.g. 0.0.0.255)
      const invertedMaskInt = (~ipToInt(parts[1])) >>> 0;
      const maskIp = intToIp(invertedMaskInt);
      return isSameSubnet(ip, parts[0], maskIp);
    }
  }

  return ip === cleanSpec;
}

/**
 * Evaluates a router's Access Control List (ACL) rules against an L3/L4 packet.
 */
export function evaluateRouterAcl(
  router: NetworkNode,
  packet: {
    protocol: ProtocolType;
    srcIp: string;
    dstIp: string;
    dstPort?: number;
  }
): { allowed: boolean; matchedRule?: AclRule } {
  const activeRules = (router.aclRules || [])
    .filter((r) => r.enabled !== false)
    .sort((a, b) => a.seq - b.seq);

  if (activeRules.length === 0) {
    return { allowed: true };
  }

  const ports = getPortNumbers(packet.protocol);
  const effectiveDstPort = packet.dstPort ?? ports.dstPort;
  const effectiveSrcPort = ports.srcPort;

  for (const rule of activeRules) {
    const proto = rule.protocol;
    let protoMatch = false;

    if (proto === 'ANY') {
      protoMatch = true;
    } else if (proto === 'ICMP') {
      protoMatch = packet.protocol.startsWith('ICMP');
    } else if (proto === 'TCP') {
      protoMatch =
        packet.protocol.startsWith('TCP') || packet.protocol.startsWith('HTTP');
    } else if (proto === 'HTTP') {
      protoMatch =
        packet.protocol.startsWith('TCP') || packet.protocol.startsWith('HTTP');
    } else if (proto === 'UDP') {
      protoMatch =
        packet.protocol.startsWith('DNS') || packet.protocol.startsWith('DHCP');
    } else if (proto === 'DNS') {
      protoMatch = packet.protocol.startsWith('DNS');
    }

    if (!protoMatch) continue;
    if (!matchesAclIpSpec(packet.srcIp, rule.srcIp)) continue;
    if (!matchesAclIpSpec(packet.dstIp, rule.dstIp)) continue;

    if (rule.dstPort !== undefined && rule.dstPort > 0) {
      if (effectiveDstPort !== rule.dstPort && effectiveSrcPort !== rule.dstPort) {
        continue;
      }
    }

    rule.hitCount = (rule.hitCount || 0) + 1;
    return {
      allowed: rule.action === 'permit',
      matchedRule: rule,
    };
  }

  // If all configured rules are 'permit' rules (whitelist mode), apply Cisco implicit deny
  const allPermitOnly = activeRules.every((r) => r.action === 'permit');
  if (allPermitOnly) {
    return {
      allowed: false,
      matchedRule: {
        id: 'implicit-deny',
        seq: 9999,
        action: 'deny',
        protocol: 'ANY',
        srcIp: 'any',
        dstIp: 'any',
      },
    };
  }

  return { allowed: true };
}

export interface SimulationRunResult {
  steps: SimulationStep[];
  updatedNodes: NetworkNode[];
  success: boolean;
  summaryMessage: string;
  resolvedIp?: string;
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

/**
 * Selects the appropriate source logical interface on originNode for reaching dstIp.
 * On routers, uses Longest Prefix Match (findBestRoute) so the source IP matches the egress interface or subinterface.
 */
export function selectSourceInterfaceForTarget(
  originNode: NetworkNode,
  dstIp: string,
  allNodes?: NetworkNode[],
  allLinks?: NetworkLink[]
): {
  egressPort?: NetworkInterface;
  egressLogical?: LogicalInterfaceView;
  routeFailureReason?: string;
} {
  if (originNode.type === 'router' && isValidIpv4(dstIp)) {
    const logicalViews = getRouterLogicalInterfaces(originNode);
    const localLogical = logicalViews.find((v) => v.ipAddress === dstIp);
    if (localLogical) {
      return {
        egressPort: localLogical.physicalPort,
        egressLogical: localLogical,
      };
    }

    const route = findBestRoute(originNode, dstIp, allNodes, allLinks);
    if (!route) {
      return {
        egressPort: undefined,
        routeFailureReason: `Маршрутизатор ${originNode.name} не имеет маршрута к сети назначения ${dstIp} (Destination Net Unreachable).`,
      };
    }

    const routedLogical = findLogicalInterfaceByName(originNode, route.interfaceName);
    if (!routedLogical || !isValidIpv4(routedLogical.ipAddress)) {
      return {
        egressPort: undefined,
        routeFailureReason: `Исходящий интерфейс ${route.interfaceName} на маршрутизаторе ${originNode.name} выключен или не имеет IPv4-адреса.`,
      };
    }

    return {
      egressPort: routedLogical.physicalPort,
      egressLogical: routedLogical,
    };
  }

  if (isValidIpv4(dstIp)) {
    const sameSubnetPort = originNode.interfaces.find(
      (p) =>
        p.adminStatus === 'up' &&
        isValidIpv4(p.ipAddress) &&
        isValidIpv4(p.subnetMask) &&
        isSameSubnet(p.ipAddress, dstIp, p.subnetMask)
    );
    if (sameSubnetPort) {
      return {
        egressPort: sameSubnetPort,
        egressLogical: {
          physicalPort: sameSubnetPort,
          logicalName: sameSubnetPort.shortName,
          ipAddress: sameSubnetPort.ipAddress,
          subnetMask: sameSubnetPort.subnetMask,
          macAddress: sameSubnetPort.macAddress,
          vlanId: sameSubnetPort.accessVlan || 1,
          isTagged8021Q: sameSubnetPort.vlanMode === 'trunk',
        },
      };
    }
  }

  const firstUpPort = originNode.interfaces.find(
    (p) => p.adminStatus === 'up' && isValidIpv4(p.ipAddress)
  );
  if (!firstUpPort) {
    // Also check subinterfaces if router had non-IPv4 target
    const firstLogical = getRouterLogicalInterfaces(originNode)[0];
    if (firstLogical) {
      return {
        egressPort: firstLogical.physicalPort,
        egressLogical: firstLogical,
      };
    }
    return {
      egressPort: undefined,
      routeFailureReason: `Устройство ${originNode.name} не имеет активного интерфейса с настроенным IPv4-адресом. Запустите DHCP (DORA) или задайте IP вручную.`,
    };
  }
  return {
    egressPort: firstUpPort,
    egressLogical: {
      physicalPort: firstUpPort,
      logicalName: firstUpPort.shortName,
      ipAddress: firstUpPort.ipAddress,
      subnetMask: firstUpPort.subnetMask,
      macAddress: firstUpPort.macAddress,
      vlanId: firstUpPort.accessVlan || 1,
      isTagged8021Q: firstUpPort.vlanMode === 'trunk',
    },
  };
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

function getL3ProtocolName(proto: ProtocolType, etherType: '0x0806 (ARP)' | '0x0800 (IPv4)'): string {
  if (etherType === '0x0806 (ARP)') return 'ARP (0x0806)';
  if (proto.startsWith('DHCP') || proto.startsWith('DNS')) return 'UDP (17)';
  if (proto.startsWith('TCP') || proto.startsWith('HTTP')) return 'TCP (6)';
  return 'ICMP (1)';
}

export function getPortNumbers(proto: ProtocolType): { srcPort?: number; dstPort?: number } {
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

export interface DeliveredL2FrameInfo {
  node: NetworkNode;
  port: NetworkInterface;
  logicalPortName: string;
  matchedIp: string;
  vlan: number;
  subinterface?: RouterSubinterface;
  helperAddress?: string;
}

/**
 * Propagates a single L2 frame through switches (enforcing IEEE 802.1D STP Blocking ports and 802.1Q VLANs)
 * until it reaches target L3 interfaces (including Router-on-a-Stick 802.1Q subinterfaces) or gets dropped.
 */
function propagateL2Frame(
  initialItem: FramePropagationItem,
  nodes: NetworkNode[],
  links: NetworkLink[],
  steps: SimulationStep[],
  visitedSwitchPorts: Set<string>
): { deliveredToNodes: DeliveredL2FrameInfo[] } {
  const queue: FramePropagationItem[] = [initialItem];
  const deliveredToNodes: DeliveredL2FrameInfo[] = [];
  const stpStateMap = computeSpanningTreeState(nodes, links);

  while (queue.length > 0) {
    const item = queue.shift()!;
    const senderNode = nodes.find((n) => n.id === item.currentNodeId);
    if (!senderNode) continue;
    const senderPort = senderNode.interfaces.find((p) => p.id === item.egressPortId);
    if (!senderPort || senderPort.adminStatus !== 'up') continue;

    const peerInfo = getConnectedPeer(senderNode.id, senderPort.id, nodes, links);
    if (!peerInfo) continue;

    const { link, peerNode, peerPort } = peerInfo;
    if (visitedSwitchPorts.has(`${link.id}:${senderNode.id}->${peerNode.id}:${item.protocol}`)) continue;
    visitedSwitchPorts.add(`${link.id}:${senderNode.id}->${peerNode.id}:${item.protocol}`);

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
      const swStp = stpStateMap[peerNode.id];
      const ingressStpPort = swStp?.ports[peerPort.id];

      // Check if receiving switch port is in STP 802.1D Blocking state
      if (ingressStpPort?.state === 'blocking') {
        const dropStpPdu = buildPduDetails({
          inPort: peerPort.shortName,
          outPort: 'DROP (STP 802.1D Blocking)',
          cableType: link.cableType,
          physicalStatus: 'UP (STP BLK)',
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
          outboundPdu: dropStpPdu,
          decisionTitle: `STP 802.1D: Кадр отброшен на резервном порту ${peerNode.name}:${peerPort.shortName} (состояние BLOCKING — защита от петли L2)`,
          osiActions: [
            {
              layer: 'L2',
              title: 'Spanning Tree Protocol (IEEE 802.1D)',
              detail: `Порт ${peerPort.shortName} на коммутаторе ${peerNode.name} переведён в роль Alternate / BLOCKING (Root Bridge: ${swStp.rootBridgeName}), чтобы предотвратить широковещательный шторм.`,
            },
          ],
          nodeSnapshotAfter: {
            arpTable: JSON.parse(JSON.stringify(peerNode.arpTable)),
            macTable: JSON.parse(JSON.stringify(peerNode.macTable)),
          },
        });
        continue;
      }

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

      const blockedPortsOnSwitch = swStp
        ? Object.values(swStp.ports).filter((p) => p.state === 'blocking')
        : [];

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

      const switchOsiActions: SimulationStep['osiActions'] = [
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
            : `Адрес назначения ${item.dstMac} широковещательный или отсутствует в таблице MAC. Кадр дублируется во все активные FWD-порты VLAN ${ingressVlan}, кроме входящего ${peerPort.shortName}.`,
        },
      ];

      if (blockedPortsOnSwitch.length > 0) {
        switchOsiActions.push({
          layer: 'L2',
          title: `Защита от петель STP (IEEE 802.1D)`,
          detail: `Порты в состоянии BLOCKING (${blockedPortsOnSwitch
            .map((p) => p.portShortName)
            .join(', ')}) исключены из пересылки кадров для предотвращения петли L2 (Root Bridge: ${
            swStp?.rootBridgeName
          }).`,
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
        vlanTag: item.isTaggedOnWire ? ingressVlan : null,
        inboundPdu: item.inboundPduAtCurrentNode,
        outboundPdu: inboundAtSwitch,
        decisionTitle: camMatch
          ? `${peerNode.name}: Unicast-коммутация по MAC-таблице в порт ${camMatch.portName} (VLAN ${ingressVlan})`
          : `${peerNode.name}: Лавинная рассылка (Flooding) кадра во все FWD-порты VLAN ${ingressVlan}`,
        osiActions: switchOsiActions,
        nodeSnapshotAfter: {
          arpTable: JSON.parse(JSON.stringify(peerNode.arpTable)),
          macTable: JSON.parse(JSON.stringify(peerNode.macTable)),
        },
      });

      for (const swOutPort of peerNode.interfaces) {
        if (swOutPort.id === peerPort.id || swOutPort.adminStatus !== 'up') continue;
        // STP 802.1D: Do not forward frames out of a port that is in BLOCKING state
        if (swStp?.ports[swOutPort.id]?.state === 'blocking') continue;
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
      // Peer is a Router, PC, or Server
      // Check if peer is a Router with an 802.1Q subinterface matching item.vlan (Router-on-a-Stick)
      const matchedSub =
        peerNode.type === 'router' && Array.isArray(peerPort.subinterfaces)
          ? peerPort.subinterfaces.find((s) => s.vlanId === item.vlan && isValidIpv4(s.ipAddress))
          : undefined;

      const receiverVlan = matchedSub
        ? matchedSub.vlanId
        : peerPort.vlanMode === 'access'
        ? peerPort.accessVlan || 1
        : item.vlan;

      const effectivePortIp = matchedSub ? matchedSub.ipAddress : peerPort.ipAddress;
      const effectiveLogicalName = matchedSub
        ? `${peerPort.shortName}.${matchedSub.vlanId}`
        : peerPort.shortName;
      const effectiveHelperAddress = matchedSub?.helperAddress || peerPort.helperAddress;

      // If frame is 802.1Q tagged for a specific VLAN and arrives on a router physical port that has subinterfaces,
      // but no subinterface exists for item.vlan and the physical port IP doesn't match that VLAN, drop it.
      const hasSubinterfaces =
        peerNode.type === 'router' &&
        Array.isArray(peerPort.subinterfaces) &&
        peerPort.subinterfaces.length > 0;
      const vlanMismatchOnRoas =
        hasSubinterfaces &&
        !matchedSub &&
        (!isValidIpv4(peerPort.ipAddress) || (peerPort.accessVlan || 1) !== item.vlan);

      const isMacMatch =
        !vlanMismatchOnRoas &&
        (item.dstMac === BROADCAST_MAC || item.dstMac === peerPort.macAddress);
      const isTargetIp =
        !vlanMismatchOnRoas &&
        (item.dstIp === effectivePortIp || item.dstIp === BROADCAST_IP);

      // RFC 826 ARP cache update discipline:
      // Update existing entry if srcIp is already known (Merge_flag), or insert new entry ONLY if this port/subinterface IP is the target.
      if (
        isMacMatch &&
        isValidIpv4(item.srcIp) &&
        item.srcIp !== '0.0.0.0' &&
        item.srcIp !== BROADCAST_IP
      ) {
        const hasExistingArpEntry = peerNode.arpTable.some((a) => a.ipAddress === item.srcIp);
        const isDirectedToPortIp = isValidIpv4(effectivePortIp) && item.dstIp === effectivePortIp;
        if (hasExistingArpEntry || isDirectedToPortIp) {
          learnArp(peerNode, item.srcIp, item.srcMac, effectiveLogicalName, receiverVlan);
        }
      }

      // Check DHCP server acceptance or Router DHCP Relay (ip helper-address) acceptance on broadcast
      const isDhcpToServer =
        !vlanMismatchOnRoas &&
        (item.protocol === 'DHCP_DISCOVER' || item.protocol === 'DHCP_REQUEST') &&
        Boolean(peerNode.services?.dhcpEnabled) &&
        (peerNode.services?.dhcpPools?.length ?? 0) > 0;

      const isDhcpToRelayRouter =
        !vlanMismatchOnRoas &&
        peerNode.type === 'router' &&
        (item.protocol === 'DHCP_DISCOVER' || item.protocol === 'DHCP_REQUEST') &&
        isValidIpv4(effectiveHelperAddress || '') &&
        isValidIpv4(effectivePortIp);

      const isDhcpToClient =
        (item.protocol === 'DHCP_OFFER' || item.protocol === 'DHCP_ACK') && isMacMatch;

      const willAccept =
        isDhcpToServer ||
        isDhcpToRelayRouter ||
        isDhcpToClient ||
        (isMacMatch &&
          (item.etherType !== '0x0806 (ARP)' || isTargetIp || item.protocol === 'ARP_REPLY'));

      const stepStatus: StepStatus = !willAccept
        ? 'dropped'
        : isDhcpToServer || isDhcpToRelayRouter || isDhcpToClient || isTargetIp
        ? 'delivered'
        : 'forwarded';

      const outPdu = buildPduDetails({
        inPort: effectiveLogicalName,
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
          title: `Приём кадра на интерфейс ${effectiveLogicalName}`,
          detail: `Сигнал принят устройством ${peerNode.name} (${effectivePortIp || 'DHCP Client'}).`,
        },
        {
          layer: 'L2',
          title: matchedSub
            ? `Декапсуляция 802.1Q Subinterface (${effectiveLogicalName}, VLAN ${matchedSub.vlanId})`
            : `Проверка MAC-адреса назначения (${item.dstMac})`,
          detail: matchedSub
            ? `Маршрутизатор ${peerNode.name} распознал тег IEEE 802.1Q VLAN ${matchedSub.vlanId} на подинтерфейсе ${effectiveLogicalName} (${effectivePortIp}).`
            : isMacMatch
            ? `MAC назначения совпадает с интерфейсом (${peerPort.macAddress}) или является Broadcast. Декапсуляция Ethernet-кадра.`
            : `MAC назначения ${item.dstMac} не принадлежит порту ${peerPort.macAddress} (или отсутствует подинтерфейс для VLAN ${item.vlan}). Кадр отброшен.`,
        },
        {
          layer: 'L3',
          title: isDhcpToRelayRouter
            ? `DHCP Relay Agent (ip helper-address ${effectiveHelperAddress})`
            : willAccept
            ? `Обработка пакета (${item.srcIp} → ${item.dstIp}, TTL=${item.ttl})`
            : `Фильтрация пакета на сетевом уровне`,
          detail: isDhcpToRelayRouter
            ? `Интерфейс ${effectiveLogicalName} (${effectivePortIp}) перехватил широковещательный ${item.protocol} и готовит Unicast-ретрансляцию (giaddr=${effectivePortIp}) к DHCP-серверу ${effectiveHelperAddress}.`
            : willAccept
            ? `Пакет принят сетевым стеком ${peerNode.name} (${effectiveLogicalName}) и передан обработчику протокола ${item.protocol}.`
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
        toPortName: effectiveLogicalName,
        linkId: link.id,
        protocol: item.protocol,
        status: stepStatus,
        vlanTag: item.isTaggedOnWire ? item.vlan : null,
        inboundPdu: item.inboundPduAtCurrentNode,
        outboundPdu: outPdu,
        decisionTitle: isDhcpToRelayRouter
          ? `${peerNode.name} (${effectiveLogicalName}): Перехват ${item.protocol} через ip helper-address ${effectiveHelperAddress}`
          : willAccept
          ? `${peerNode.name} (${effectiveLogicalName}) обработал пакет ${item.protocol}`
          : `${peerNode.name} (${effectiveLogicalName}) отбросил кадр ${item.protocol} (адресован другому узлу)`,
        osiActions,
        nodeSnapshotAfter: {
          arpTable: JSON.parse(JSON.stringify(peerNode.arpTable)),
          macTable: JSON.parse(JSON.stringify(peerNode.macTable)),
        },
      });

      if (willAccept) {
        deliveredToNodes.push({
          node: peerNode,
          port: peerPort,
          logicalPortName: effectiveLogicalName,
          matchedIp: effectivePortIp,
          vlan: receiverVlan,
          subinterface: matchedSub,
          helperAddress: effectiveHelperAddress,
        });
      }
    }
  }

  return { deliveredToNodes };
}

/**
 * Resolves next-hop IPv4 to MAC via ARP table or generates ARP Request + ARP Reply steps,
 * supporting both standard physical interfaces and 802.1Q router subinterfaces.
 */
function resolveNextHopArp(
  senderNode: NetworkNode,
  senderLogical: LogicalInterfaceView,
  nextHopIp: string,
  nodes: NetworkNode[],
  links: NetworkLink[],
  steps: SimulationStep[]
): string | null {
  const existingArp = senderNode.arpTable.find((a) => a.ipAddress === nextHopIp);
  if (existingArp) {
    return existingArp.macAddress;
  }

  const senderPort = senderLogical.physicalPort;
  const vlan = senderLogical.vlanId;
  const isTagged = senderLogical.isTagged8021Q;
  const arpReqSummary = `Who has ${nextHopIp}? Tell ${senderLogical.ipAddress}`;

  const initialArpReqPdu = buildPduDetails({
    inPort: 'Internal ARP Stack',
    outPort: senderLogical.logicalName,
    cableType: 'straight',
    physicalStatus: 'UP',
    srcMac: senderPort.macAddress,
    dstMac: BROADCAST_MAC,
    etherType: '0x0806 (ARP)',
    vlanTag: isTagged ? vlan : null,
    srcIp: senderLogical.ipAddress,
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
      srcIp: senderLogical.ipAddress,
      dstIp: nextHopIp,
      vlan,
      isTaggedOnWire: isTagged,
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

  const targetMatch = deliveredToNodes.find((d) => d.matchedIp === nextHopIp);
  if (!targetMatch) {
    return null;
  }

  const replyTagged = Boolean(targetMatch.subinterface) || targetMatch.port.vlanMode === 'trunk';
  const replySummary = `${nextHopIp} is at ${targetMatch.port.macAddress}`;
  const initialArpReplyPdu = buildPduDetails({
    inPort: 'Internal ARP Stack',
    outPort: targetMatch.logicalPortName,
    cableType: 'straight',
    physicalStatus: 'UP',
    srcMac: targetMatch.port.macAddress,
    dstMac: senderPort.macAddress,
    etherType: '0x0806 (ARP)',
    vlanTag: replyTagged ? targetMatch.vlan : null,
    srcIp: nextHopIp,
    dstIp: senderLogical.ipAddress,
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
      dstIp: senderLogical.ipAddress,
      vlan: targetMatch.vlan,
      isTaggedOnWire: replyTagged,
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

  learnArp(senderNode, nextHopIp, targetMatch.port.macAddress, senderLogical.logicalName, vlan);
  return targetMatch.port.macAddress;
}

/**
 * Transmits an L3 IPv4 packet from originNode to dstIp across L2 switches and L3 routers,
 * supporting:
 * - Router-on-a-Stick (802.1Q subinterfaces Fa0/0.10, Fa0/0.20)
 * - Router Firewall ACLs (permit / deny with explicit ACL Drop step visualization)
 * - NAT / PAT (Inside -> Outside Source IP translation and Outside -> Inside Destination IP translation)
 * - Custom initial TTL for Traceroute
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
  usedSourceIp?: string;
  finalDstIp?: string;
  ttlExpiredAtRouter?: { router: NetworkNode; ingressPort: NetworkInterface; ingressIp: string };
  failureReason?: string;
} {
  let currentL3Node = originNode;
  let currentDstIp = dstIp;
  const originSelection = selectSourceInterfaceForTarget(
    originNode,
    currentDstIp,
    nodes,
    links
  );
  if (!originSelection.egressPort || !originSelection.egressLogical) {
    return {
      reachedTargetNode: null,
      failureReason: originSelection.routeFailureReason,
    };
  }
  const activeOriginLogical = originSelection.egressLogical;
  let currentSrcIp = activeOriginLogical.ipAddress;
  let lastIngressLogicalOnRouter: LogicalInterfaceView | undefined = undefined;

  let ttl = options?.initialTtl ?? 64;
  const maxHops = 8;

  for (let hop = 0; hop < maxHops; hop++) {
    // 1. Check if currentL3Node is a router with ACL rules
    if (currentL3Node.type === 'router') {
      const aclCheck = evaluateRouterAcl(currentL3Node, {
        protocol,
        srcIp: currentSrcIp,
        dstIp: currentDstIp,
      });
      if (!aclCheck.allowed && aclCheck.matchedRule) {
        const rule = aclCheck.matchedRule;
        // If there is a previous step that delivered the packet to this router, mark or append an explicit ACL Drop step
        const dropPortName = lastIngressLogicalOnRouter?.logicalName || activeOriginLogical.logicalName;
        const dropPdu = buildPduDetails({
          inPort: dropPortName,
          outPort: `ACL DROP (Rule #${rule.seq})`,
          cableType: 'straight',
          physicalStatus: 'UP',
          srcMac: activeOriginLogical.macAddress,
          dstMac: activeOriginLogical.macAddress,
          etherType: '0x0800 (IPv4)',
          vlanTag: null,
          srcIp: currentSrcIp,
          dstIp: currentDstIp,
          ttl,
          protocol,
          summary: `ACL DROP: Rule #${rule.seq} (${rule.action.toUpperCase()} ${rule.protocol} ${rule.srcIp} → ${rule.dstIp})`,
          l7: options?.l7,
        });

        steps.push({
          id: `step-${steps.length + 1}`,
          stepIndex: steps.length + 1,
          timestampMs: (steps.length + 1) * 180,
          fromNodeId: currentL3Node.id,
          fromNodeName: currentL3Node.name,
          fromPortName: dropPortName,
          toNodeId: currentL3Node.id,
          toNodeName: currentL3Node.name,
          toPortName: 'Firewall ACL Engine',
          linkId: '',
          protocol,
          status: 'dropped',
          vlanTag: null,
          inboundPdu: dropPdu,
          outboundPdu: dropPdu,
          decisionTitle: `ACL Drop на ${currentL3Node.name}: пакет ${protocol} (${currentSrcIp} → ${currentDstIp}) заблокирован правилом ACL #${rule.seq}`,
          osiActions: [
            {
              layer: 'L3',
              title: `Межсетевой экран / Access Control List (ACL #${rule.seq})`,
              detail: `Сработало запрещающее правило: access-list 100 deny ${rule.protocol.toLowerCase()} ${rule.srcIp} ${rule.dstIp}${
                rule.dstPort ? ` eq ${rule.dstPort}` : ''
              }. Пакет уничтожен.`,
            },
          ],
          nodeSnapshotAfter: {
            arpTable: JSON.parse(JSON.stringify(currentL3Node.arpTable)),
            macTable: JSON.parse(JSON.stringify(currentL3Node.macTable)),
          },
        });

        return {
          reachedTargetNode: null,
          usedSourceIp: currentSrcIp,
          finalDstIp: currentDstIp,
          failureReason: `Пакет отброшен межсетевым экраном (ACL Drop) на маршрутизаторе ${currentL3Node.name}: правило #${rule.seq} (${rule.action.toUpperCase()} ${rule.protocol} ${rule.srcIp} → ${rule.dstIp}).`,
        };
      }
    }

    // Check if currentL3Node owns currentDstIp (after any NAT return translation)
    const localLogicalMatch = getRouterLogicalInterfaces(currentL3Node).find(
      (v) => v.ipAddress === currentDstIp
    );
    if (localLogicalMatch && hop > 0) {
      return {
        reachedTargetNode: currentL3Node,
        usedSourceIp: currentSrcIp,
        finalDstIp: currentDstIp,
      };
    }

    let egressLogical: LogicalInterfaceView | undefined;
    let nextHopIp = currentDstIp;

    if (currentL3Node.type === 'router') {
      const route = findBestRoute(currentL3Node, currentDstIp, nodes, links);
      if (!route) {
        return {
          reachedTargetNode: null,
          usedSourceIp: currentSrcIp,
          finalDstIp: currentDstIp,
          failureReason: `Маршрутизатор ${currentL3Node.name} не имеет маршрута к сети назначения ${currentDstIp} (Destination Net Unreachable).`,
        };
      }
      egressLogical = findLogicalInterfaceByName(currentL3Node, route.interfaceName);
      nextHopIp =
        route.type === 'C' || route.nextHop === 'Directly Connected'
          ? currentDstIp
          : route.nextHop;
    } else {
      egressLogical = activeOriginLogical;
      if (!isSameSubnet(egressLogical.ipAddress, currentDstIp, egressLogical.subnetMask)) {
        if (!isValidIpv4(currentL3Node.defaultGateway)) {
          return {
            reachedTargetNode: null,
            usedSourceIp: currentSrcIp,
            finalDstIp: currentDstIp,
            failureReason: `Узел ${currentDstIp} находится в другой подсети, но на ${currentL3Node.name} не задан шлюз по умолчанию (Default Gateway).`,
          };
        }
        if (
          !isSameSubnet(
            egressLogical.ipAddress,
            currentL3Node.defaultGateway,
            egressLogical.subnetMask
          )
        ) {
          return {
            reachedTargetNode: null,
            usedSourceIp: currentSrcIp,
            finalDstIp: currentDstIp,
            failureReason: `Network is unreachable (Gateway not on local subnet): шлюз по умолчанию ${currentL3Node.defaultGateway} не принадлежит подсети интерфейса ${currentL3Node.name}:${egressLogical.logicalName} (${egressLogical.ipAddress}/${maskToCidr(egressLogical.subnetMask)}).`,
          };
        }
        nextHopIp = currentL3Node.defaultGateway;
      }
    }

    if (!egressLogical || egressLogical.physicalPort.adminStatus !== 'up') {
      return {
        reachedTargetNode: null,
        usedSourceIp: currentSrcIp,
        finalDstIp: currentDstIp,
        failureReason: `Исходящий интерфейс на устройстве ${currentL3Node.name} выключен или не найден.`,
      };
    }

    // 2. NAT / PAT Outbound Translation (Inside -> Outside) on Router
    const preNatSrcIp = currentSrcIp;
    let natActionDetail: string | null = null;

    if (
      currentL3Node.type === 'router' &&
      currentL3Node.natEnabled !== false &&
      egressLogical.natRole === 'outside' &&
      isValidIpv4(egressLogical.ipAddress)
    ) {
      const cameFromInside =
        lastIngressLogicalOnRouter?.natRole === 'inside' ||
        getRouterLogicalInterfaces(currentL3Node).some(
          (v) =>
            v.natRole === 'inside' &&
            isSameSubnet(currentSrcIp, v.ipAddress, v.subnetMask)
        );

      if (cameFromInside && currentSrcIp !== egressLogical.ipAddress) {
        const insideIp = currentSrcIp;
        const globalIp = egressLogical.ipAddress;
        const ports = getPortNumbers(protocol);
        const portNum = ports.srcPort || ports.dstPort || 1024;
        const natProto: NatTranslationEntry['protocol'] = protocol.startsWith('ICMP')
          ? 'icmp'
          : protocol.startsWith('TCP') || protocol.startsWith('HTTP')
          ? 'tcp'
          : 'udp';

        if (!Array.isArray(currentL3Node.natTranslations)) {
          currentL3Node.natTranslations = [];
        }

        const existingNat = currentL3Node.natTranslations.find(
          (t) =>
            t.insideIp === insideIp &&
            t.globalIp === globalIp &&
            t.outsideIp === currentDstIp &&
            t.protocol === natProto
        );

        if (!existingNat) {
          currentL3Node.natTranslations.push({
            id: `nat-${Date.now()}-${currentL3Node.natTranslations.length + 1}`,
            protocol: natProto,
            insideLocal: `${insideIp}:${portNum}`,
            insideGlobal: `${globalIp}:${portNum}`,
            outsideLocal: `${currentDstIp}:${ports.dstPort || portNum}`,
            outsideGlobal: `${currentDstIp}:${ports.dstPort || portNum}`,
            insideIp,
            globalIp,
            outsideIp: currentDstIp,
            port: portNum,
          });
        }

        currentSrcIp = globalIp;
        natActionDetail = `NAT/PAT Overload (Inside → Outside): Локальный адрес источника ${insideIp}:${portNum} подменён на публичный адрес внешнего интерфейса ${egressLogical.logicalName} (${globalIp}:${portNum}).`;
      }
    }

    const nextHopMac = resolveNextHopArp(
      currentL3Node,
      egressLogical,
      nextHopIp,
      nodes,
      links,
      steps
    );
    if (!nextHopMac) {
      return {
        reachedTargetNode: null,
        usedSourceIp: currentSrcIp,
        finalDstIp: currentDstIp,
        failureReason: `Не удалось разрешить MAC-адрес для ${nextHopIp} по протоколу ARP с интерфейса ${currentL3Node.name}:${egressLogical.logicalName}.`,
      };
    }

    const vlan = egressLogical.vlanId;
    const isTagged = egressLogical.isTagged8021Q;
    const summaryText =
      options?.customSummary ||
      `${protocol} (${currentSrcIp} → ${currentDstIp}, TTL=${ttl})`;

    const initialIpPdu = buildPduDetails({
      inPort:
        hop === 0
          ? 'OS Network Stack (L3)'
          : lastIngressLogicalOnRouter?.logicalName || 'Routing Engine (L3)',
      outPort: egressLogical.logicalName,
      cableType: 'straight',
      physicalStatus: 'UP',
      srcMac: egressLogical.macAddress,
      dstMac: nextHopMac,
      etherType: '0x0800 (IPv4)',
      vlanTag: isTagged ? vlan : null,
      srcIp: preNatSrcIp,
      dstIp: currentDstIp,
      ttl,
      protocol,
      summary: summaryText,
      l7: options?.l7,
    });

    const stepCountBefore = steps.length;
    const { deliveredToNodes } = propagateL2Frame(
      {
        currentNodeId: currentL3Node.id,
        egressPortId: egressLogical.physicalPort.id,
        srcMac: egressLogical.macAddress,
        dstIp: currentDstIp,
        dstMac: nextHopMac,
        srcIp: currentSrcIp,
        vlan,
        isTaggedOnWire: isTagged,
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

    // If NAT translation occurred on currentL3Node, annotate the step that left currentL3Node
    if (natActionDetail && steps.length > stepCountBefore) {
      const firstNewStep = steps[stepCountBefore];
      firstNewStep.osiActions.unshift({
        layer: 'L3',
        title: `Трансляция сетевых адресов NAT/PAT (${currentL3Node.name})`,
        detail: natActionDetail,
      });
    }

    const nextL3Receiver = deliveredToNodes.find((d) => d.port.macAddress === nextHopMac);
    if (!nextL3Receiver) {
      return {
        reachedTargetNode: null,
        usedSourceIp: currentSrcIp,
        finalDstIp: currentDstIp,
        failureReason: `Пакет ${protocol} не достиг следующего L3-узла (${nextHopIp}).`,
      };
    }

    const receiverNode = nextL3Receiver.node;
    const receiverLogical =
      findLogicalInterfaceByName(receiverNode, nextL3Receiver.logicalPortName) || {
        physicalPort: nextL3Receiver.port,
        subinterface: nextL3Receiver.subinterface,
        logicalName: nextL3Receiver.logicalPortName,
        ipAddress: nextL3Receiver.matchedIp,
        subnetMask: nextL3Receiver.subinterface?.subnetMask || nextL3Receiver.port.subnetMask,
        macAddress: nextL3Receiver.port.macAddress,
        vlanId: nextL3Receiver.vlan,
        isTagged8021Q: Boolean(nextL3Receiver.subinterface) || nextL3Receiver.port.vlanMode === 'trunk',
        helperAddress: nextL3Receiver.helperAddress,
        natRole: nextL3Receiver.subinterface?.natRole || nextL3Receiver.port.natRole,
      };

    // 3. Check Inbound NAT (Outside -> Inside) on receiverNode if it is a router with NAT table
    if (
      receiverNode.type === 'router' &&
      receiverNode.natEnabled !== false &&
      receiverLogical.natRole === 'outside' &&
      Array.isArray(receiverNode.natTranslations) &&
      receiverNode.natTranslations.length > 0
    ) {
      const matchingNat = [...receiverNode.natTranslations]
        .reverse()
        .find((t) => t.globalIp === currentDstIp && t.outsideIp === currentSrcIp);

      if (matchingNat) {
        const oldDstIp = currentDstIp;
        currentDstIp = matchingNat.insideIp;
        const lastStep = steps[steps.length - 1];
        if (lastStep && lastStep.toNodeId === receiverNode.id) {
          lastStep.outboundPdu.l3.dstIp = currentDstIp;
          lastStep.decisionTitle = `${receiverNode.name} (${receiverLogical.logicalName}): Обратная трансляция NAT (${oldDstIp} → ${currentDstIp})`;
          lastStep.osiActions.push({
            layer: 'L3',
            title: `Обратная трансляция NAT/PAT (Outside → Inside)`,
            detail: `По таблице NAT найдена сессия ${matchingNat.insideGlobal} ↔ ${matchingNat.insideLocal}. Целевой IP-адрес пакета заменён с внешнего ${oldDstIp} на внутренний ${currentDstIp}.`,
          });
        }
      }
    }

    const ownsDstIp = getRouterLogicalInterfaces(receiverNode).some(
      (v) => v.ipAddress === currentDstIp
    );
    if (ownsDstIp) {
      // Final check: if the destination itself is a router with ACLs, check ACL before accepting
      if (receiverNode.type === 'router') {
        const aclAtTarget = evaluateRouterAcl(receiverNode, {
          protocol,
          srcIp: currentSrcIp,
          dstIp: currentDstIp,
        });
        if (!aclAtTarget.allowed && aclAtTarget.matchedRule) {
          const rule = aclAtTarget.matchedRule;
          const lastStep = steps[steps.length - 1];
          if (lastStep && lastStep.toNodeId === receiverNode.id) {
            lastStep.status = 'dropped';
            lastStep.decisionTitle = `ACL Drop на ${receiverNode.name}: пакет ${protocol} заблокирован правилом ACL #${rule.seq}`;
            lastStep.osiActions.push({
              layer: 'L3',
              title: `Блокировка пакетов ACL #${rule.seq}`,
              detail: `Правило ${rule.action.toUpperCase()} ${rule.protocol} (${rule.srcIp} → ${rule.dstIp}) отбросило входящий пакет.`,
            });
          }
          return {
            reachedTargetNode: null,
            usedSourceIp: currentSrcIp,
            finalDstIp: currentDstIp,
            failureReason: `Пакет отброшен межсетевым экраном (ACL Drop) на маршрутизаторе ${receiverNode.name}: правило #${rule.seq}.`,
          };
        }
      }
      return {
        reachedTargetNode: receiverNode,
        usedSourceIp: currentSrcIp,
        finalDstIp: currentDstIp,
      };
    }

    if (receiverNode.type === 'router') {
      ttl -= 1;
      if (ttl <= 0) {
        return {
          reachedTargetNode: null,
          usedSourceIp: currentSrcIp,
          finalDstIp: currentDstIp,
          ttlExpiredAtRouter: {
            router: receiverNode,
            ingressPort: nextL3Receiver.port,
            ingressIp: receiverLogical.ipAddress,
          },
          failureReason: `TTL expired in transit на маршрутизаторе ${receiverNode.name} (${receiverLogical.ipAddress}).`,
        };
      }
      currentL3Node = receiverNode;
      lastIngressLogicalOnRouter = receiverLogical;
    } else {
      return {
        reachedTargetNode: null,
        usedSourceIp: currentSrcIp,
        finalDstIp: currentDstIp,
        failureReason: `Узел ${receiverNode.name} получил пакет для ${currentDstIp}, но не является маршрутизатором.`,
      };
    }
  }

  return {
    reachedTargetNode: null,
    usedSourceIp: currentSrcIp,
    finalDstIp: currentDstIp,
    failureReason: 'Превышено максимальное число транзитных переходов (Routing Loop).',
  };
}

/**
 * 1. Standard ICMP Ping or TCP Probe simulation (with automatic DNS resolution for domain targets).
 */
export function runPacketSimulation(
  nodesInput: NetworkNode[],
  links: NetworkLink[],
  sourceNodeId: string,
  targetHostOrIp: string,
  mode: 'ICMP' | 'TCP' = 'ICMP'
): SimulationRunResult {
  const nodes = cloneNodes(nodesInput);
  for (const n of nodes) {
    if (n.type === 'router') {
      n.routingTable = syncConnectedRoutes(n, nodes, links);
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

  const steps: SimulationStep[] = [];
  const trimmedTarget = targetHostOrIp.trim();
  let targetIp = trimmedTarget;

  if (!isValidIpv4(trimmedTarget)) {
    if (/^[0-9.]+$/.test(trimmedTarget)) {
      return {
        steps: [],
        updatedNodes: nodes,
        success: false,
        summaryMessage: `Некорректный целевой IPv4-адрес: "${trimmedTarget}".`,
      };
    }

    const dnsServerIp = (sourceNode.dnsServer || '').trim();
    if (!isValidIpv4(dnsServerIp)) {
      return {
        steps: [],
        updatedNodes: nodes,
        success: false,
        summaryMessage: `Не удалось разрешить имя узла "${trimmedTarget}": на устройстве ${sourceNode.name} не задан IPv4-адрес DNS-сервера.`,
      };
    }

    const dnsLookup = performDnsLookupTransaction(
      sourceNode,
      dnsServerIp,
      trimmedTarget,
      nodes,
      links,
      steps
    );
    if (!dnsLookup.resolvedIp) {
      return {
        steps,
        updatedNodes: nodes,
        success: false,
        summaryMessage:
          dnsLookup.error ||
          `Не удалось разрешить имя узла "${trimmedTarget}" через DNS-сервер ${dnsServerIp}.`,
      };
    }
    targetIp = dnsLookup.resolvedIp;
  }

  const reqProtocol: ProtocolType = mode === 'TCP' ? 'TCP_SYN' : 'ICMP_ECHO_REQUEST';
  const replyProtocol: ProtocolType = mode === 'TCP' ? 'TCP_SYN_ACK' : 'ICMP_ECHO_REPLY';

  const forwardResult = transmitIpPacket(sourceNode, targetIp, reqProtocol, nodes, links, steps);

  if (!forwardResult.reachedTargetNode) {
    return {
      steps,
      updatedNodes: nodes,
      success: false,
      resolvedIp: targetIp,
      summaryMessage:
        forwardResult.failureReason ||
        `Пакет ${reqProtocol} к узлу ${targetIp} потерян (Request timed out).`,
    };
  }

  const replyDstIp =
    forwardResult.usedSourceIp ||
    getRouterLogicalInterfaces(sourceNode)[0]?.ipAddress ||
    '';

  const returnResult = transmitIpPacket(
    forwardResult.reachedTargetNode,
    replyDstIp,
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
      resolvedIp: targetIp,
      summaryMessage:
        returnResult.failureReason ||
        `Запрос дошёл до ${forwardResult.reachedTargetNode.name}, но обратный пакет к ${replyDstIp} не смог вернуться.`,
    };
  }

  return {
    steps,
    updatedNodes: nodes,
    success: true,
    resolvedIp: targetIp,
    summaryMessage: `Успешный обмен пакетами (${sourceNode.name} ↔ ${forwardResult.reachedTargetNode.name}, ${targetIp}): выполнено ${steps.length} шагов.`,
  };
}

/**
 * 2. DHCP DORA Simulation (Discover -> Offer -> Request -> Ack),
 * supporting both local L2 DHCP servers and Router DHCP Relay (`ip helper-address`).
 */
export function runDhcpDoraSimulation(
  nodesInput: NetworkNode[],
  links: NetworkLink[],
  clientNodeId: string
): SimulationRunResult {
  const nodes = cloneNodes(nodesInput);
  for (const n of nodes) {
    if (n.type === 'router') {
      n.routingTable = syncConnectedRoutes(n, nodes, links);
    }
  }

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

  // Check for a direct L2 DHCP responder first
  let dhcpResponder = deliveredToNodes.find(
    (d) => d.node.services?.dhcpEnabled && (d.node.services.dhcpPools?.length ?? 0) > 0
  );

  // Check for a DHCP Relay Router (ip helper-address) if no direct DHCP server answered in this VLAN
  let relayAgent: DeliveredL2FrameInfo | undefined;
  let serverNode: NetworkNode | undefined;
  let serverPort: NetworkInterface | undefined;
  let relayGiaddr: string | undefined;

  if (dhcpResponder && dhcpResponder.node.services) {
    serverNode = dhcpResponder.node;
    serverPort = dhcpResponder.port;
    relayGiaddr = dhcpResponder.matchedIp;
  } else {
    relayAgent = deliveredToNodes.find(
      (d) =>
        d.node.type === 'router' &&
        isValidIpv4(d.helperAddress || '') &&
        isValidIpv4(d.matchedIp)
    );

    if (relayAgent && relayAgent.helperAddress) {
      relayGiaddr = relayAgent.matchedIp;
      const helperIp = relayAgent.helperAddress;

      // Relay DHCP_DISCOVER as Unicast from relayAgent.node to helperIp
      const relayDiscoverRes = transmitIpPacket(
        relayAgent.node,
        helperIp,
        'DHCP_DISCOVER',
        nodes,
        links,
        steps,
        {
          customSummary: `DHCP Discover [Relayed via giaddr ${relayGiaddr} → ${helperIp}]`,
          l7: {
            appProtocol: 'DHCP',
            headline: `DHCP Discover (Relayed via ip helper-address ${helperIp})`,
            fields: {
              'Transaction ID': xid,
              'Client MAC': clientPort.macAddress,
              'Relay Agent IP (giaddr)': relayGiaddr,
              'Target DHCP Server': helperIp,
            },
          },
        }
      );

      if (
        relayDiscoverRes.reachedTargetNode &&
        relayDiscoverRes.reachedTargetNode.services?.dhcpEnabled &&
        (relayDiscoverRes.reachedTargetNode.services.dhcpPools?.length ?? 0) > 0
      ) {
        serverNode = relayDiscoverRes.reachedTargetNode;
        serverPort =
          serverNode.interfaces.find((i) => i.adminStatus === 'up' && isValidIpv4(i.ipAddress)) ||
          serverNode.interfaces[0];
      } else {
        return {
          steps,
          updatedNodes: nodes,
          success: false,
          summaryMessage: `DHCP Relay (${relayAgent.node.name} → ${helperIp}): центральный DHCP-сервер недоступен или служба DHCP на нём выключена.`,
        };
      }
    }
  }

  if (!serverNode || !serverPort || !serverNode.services) {
    return {
      steps,
      updatedNodes: nodes,
      success: false,
      summaryMessage: `DHCP Discover отправлен в VLAN ${vlan}, но ни один активный DHCP-сервер (или ip helper-address) не ответил в данном широковещательном домене.`,
    };
  }

  const serverServices = serverNode.services;
  const poolLookupIp = relayGiaddr || serverPort.ipAddress;

  // Select matching pool for relayGiaddr (or serverPort's IP subnet), or fallback to first pool
  const matchedPool: DhcpPool =
    serverServices.dhcpPools.find(
      (p) => isValidIpv4(poolLookupIp) && isSameSubnet(poolLookupIp, p.network, p.mask)
    ) || serverServices.dhcpPools[0];

  // Allocate an unused IP from pool range (checking all interfaces + subinterfaces on other nodes and active leases)
  const usedIps = new Set<string>(
    nodes
      .filter((n) => n.id !== clientNode.id)
      .flatMap((n) => getRouterLogicalInterfaces(n).map((v) => v.ipAddress).filter(Boolean))
  );
  for (const lease of serverServices.dhcpLeases || []) {
    if (lease.macAddress !== clientPort.macAddress && lease.ipAddress) {
      usedIps.add(lease.ipAddress);
    }
  }

  let offeredIp: string | null = null;
  const startInt = ipToInt(matchedPool.startIp);
  const endInt = ipToInt(matchedPool.endIp);
  for (let curr = startInt; curr <= endInt; curr++) {
    const candidate = intToIp(curr);
    if (!usedIps.has(candidate)) {
      offeredIp = candidate;
      break;
    }
  }

  if (!offeredIp) {
    return {
      steps,
      updatedNodes: nodes,
      success: false,
      summaryMessage: `DHCP Pool Exhausted: на сервере ${serverNode.name} в пуле "${matchedPool.poolName}" (${matchedPool.startIp}–${matchedPool.endIp}) нет свободных IPv4-адресов.`,
    };
  }

  const serverIp =
    (dhcpResponder ? dhcpResponder.matchedIp : serverPort.ipAddress) ||
    matchedPool.defaultRouter ||
    '192.168.1.1';

  // Step 2: DHCP OFFER (Server -> Client, or Server -> Relay Router -> Client)
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
      ...(relayAgent && relayGiaddr ? { 'Relay Agent (giaddr)': relayGiaddr } : {}),
    },
  };

  if (relayAgent && relayGiaddr) {
    transmitIpPacket(serverNode, relayGiaddr, 'DHCP_OFFER', nodes, links, steps, {
      customSummary: `DHCP Offer ${offeredIp} [Relayed to ${relayAgent.node.name} ${relayGiaddr}]`,
      l7: offerL7,
    });

    const relayTagged = Boolean(relayAgent.subinterface) || relayAgent.port.vlanMode === 'trunk';
    const relayOfferPdu = buildPduDetails({
      inPort: 'DHCP Relay Agent',
      outPort: relayAgent.logicalPortName,
      cableType: 'straight',
      physicalStatus: 'UP',
      srcMac: relayAgent.port.macAddress,
      dstMac: clientPort.macAddress,
      etherType: '0x0800 (IPv4)',
      vlanTag: relayTagged ? relayAgent.vlan : null,
      srcIp: relayGiaddr,
      dstIp: offeredIp,
      ttl: 64,
      protocol: 'DHCP_OFFER',
      summary: `DHCP Offer: ${offeredIp}/${maskToCidr(matchedPool.mask)} (Relayed by ${relayAgent.logicalPortName})`,
      l7: offerL7,
    });

    propagateL2Frame(
      {
        currentNodeId: relayAgent.node.id,
        egressPortId: relayAgent.port.id,
        srcMac: relayAgent.port.macAddress,
        dstMac: clientPort.macAddress,
        srcIp: relayGiaddr,
        dstIp: offeredIp,
        vlan: relayAgent.vlan,
        isTaggedOnWire: relayTagged,
        etherType: '0x0800 (IPv4)',
        protocol: 'DHCP_OFFER',
        ttl: 64,
        summary: `DHCP Offer: ${offeredIp} (GW ${matchedPool.defaultRouter}, DNS ${matchedPool.dnsServer})`,
        l7: offerL7,
        inboundPduAtCurrentNode: relayOfferPdu,
      },
      nodes,
      links,
      steps,
      new Set()
    );
  } else if (dhcpResponder) {
    const respTagged =
      Boolean(dhcpResponder.subinterface) || dhcpResponder.port.vlanMode === 'trunk';
    const offerPdu = buildPduDetails({
      inPort: 'DHCP Server Daemon',
      outPort: dhcpResponder.logicalPortName,
      cableType: 'straight',
      physicalStatus: 'UP',
      srcMac: serverPort.macAddress,
      dstMac: clientPort.macAddress,
      etherType: '0x0800 (IPv4)',
      vlanTag: respTagged ? dhcpResponder.vlan : null,
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
        isTaggedOnWire: respTagged,
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
  }

  // Step 3: DHCP REQUEST (Client -> Broadcast, plus Relay if applicable)
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

  if (relayAgent && relayGiaddr && relayAgent.helperAddress) {
    transmitIpPacket(
      relayAgent.node,
      relayAgent.helperAddress,
      'DHCP_REQUEST',
      nodes,
      links,
      steps,
      {
        customSummary: `DHCP Request for ${offeredIp} [Relayed via giaddr ${relayGiaddr}]`,
        l7: requestL7,
      }
    );
  }

  // Step 4: DHCP ACK (Server -> Client, or Server -> Relay Router -> Client)
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

  if (relayAgent && relayGiaddr) {
    transmitIpPacket(serverNode, relayGiaddr, 'DHCP_ACK', nodes, links, steps, {
      customSummary: `DHCP ACK ${offeredIp} [Relayed to ${relayAgent.node.name} ${relayGiaddr}]`,
      l7: ackL7,
    });

    const relayTagged = Boolean(relayAgent.subinterface) || relayAgent.port.vlanMode === 'trunk';
    const relayAckPdu = buildPduDetails({
      inPort: 'DHCP Relay Agent',
      outPort: relayAgent.logicalPortName,
      cableType: 'straight',
      physicalStatus: 'UP',
      srcMac: relayAgent.port.macAddress,
      dstMac: clientPort.macAddress,
      etherType: '0x0800 (IPv4)',
      vlanTag: relayTagged ? relayAgent.vlan : null,
      srcIp: relayGiaddr,
      dstIp: offeredIp,
      ttl: 64,
      protocol: 'DHCP_ACK',
      summary: `DHCP ACK: ${offeredIp}/${maskToCidr(matchedPool.mask)} assigned to ${clientNode.name}`,
      l7: ackL7,
    });

    propagateL2Frame(
      {
        currentNodeId: relayAgent.node.id,
        egressPortId: relayAgent.port.id,
        srcMac: relayAgent.port.macAddress,
        dstMac: clientPort.macAddress,
        srcIp: relayGiaddr,
        dstIp: offeredIp,
        vlan: relayAgent.vlan,
        isTaggedOnWire: relayTagged,
        etherType: '0x0800 (IPv4)',
        protocol: 'DHCP_ACK',
        ttl: 64,
        summary: `DHCP ACK: ${offeredIp} assigned to ${clientNode.name}`,
        l7: ackL7,
        inboundPduAtCurrentNode: relayAckPdu,
      },
      nodes,
      links,
      steps,
      new Set()
    );
  } else if (dhcpResponder) {
    const respTagged =
      Boolean(dhcpResponder.subinterface) || dhcpResponder.port.vlanMode === 'trunk';
    const ackPdu = buildPduDetails({
      inPort: 'DHCP Server Daemon',
      outPort: dhcpResponder.logicalPortName,
      cableType: 'straight',
      physicalStatus: 'UP',
      srcMac: serverPort.macAddress,
      dstMac: clientPort.macAddress,
      etherType: '0x0800 (IPv4)',
      vlanTag: respTagged ? dhcpResponder.vlan : null,
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
        isTaggedOnWire: respTagged,
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
  }

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
    summaryMessage: `DHCP DORA завершён${
      relayAgent ? ` (через Relay ${relayAgent.logicalPortName})` : ''
    }: ${clientNode.name} получил IP ${offeredIp}/${maskToCidr(matchedPool.mask)}, GW ${matchedPool.defaultRouter}, DNS ${matchedPool.dnsServer} от ${serverNode.name}.`,
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
      n.routingTable = syncConnectedRoutes(n, nodes, links);
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

  const srcLogical = getRouterLogicalInterfaces(sourceNode)[0];
  if (!srcLogical) {
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
      const { router, ingressIp } = probeRes.ttlExpiredAtRouter;
      const routerIp =
        ingressIp || getRouterLogicalInterfaces(router)[0]?.ipAddress || '0.0.0.0';
      const replyTargetIp = probeRes.usedSourceIp || srcLogical.ipAddress;

      transmitIpPacket(router, replyTargetIp, 'ICMP_TIME_EXCEEDED', nodes, links, steps, {
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
      const replyTargetIp = probeRes.usedSourceIp || srcLogical.ipAddress;
      transmitIpPacket(targetNode, replyTargetIp, 'ICMP_ECHO_REPLY', nodes, links, steps, {
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
  const isLocalDnsServer = getRouterLogicalInterfaces(clientNode).some(
    (v) => v.ipAddress === dnsServerIp
  );
  if (isLocalDnsServer) {
    if (!clientNode.services?.dnsEnabled) {
      return {
        resolvedIp: null,
        error: `Узел ${clientNode.name} (${dnsServerIp}) является целевым DNS-сервером, но служба DNS Server (UDP 53) на нём выключена.`,
      };
    }
    const localRecord = clientNode.services.dnsRecords.find(
      (r) => r.domain.toLowerCase() === domain.toLowerCase()
    );
    if (!localRecord) {
      return {
        resolvedIp: null,
        dnsServerNode: clientNode,
        error: `DNS-сервер ${clientNode.name} вернул NXDOMAIN: запись для домена "${domain}" не найдена.`,
      };
    }
    return { resolvedIp: localRecord.ipAddress, dnsServerNode: clientNode };
  }

  const clientIp =
    selectSourceInterfaceForTarget(clientNode, dnsServerIp).egressLogical?.ipAddress ||
    getRouterLogicalInterfaces(clientNode)[0]?.ipAddress ||
    '';

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
  const responseDstIp = queryRes.usedSourceIp || clientIp;

  transmitIpPacket(dnsServer, responseDstIp, 'DNS_RESPONSE', nodes, links, steps, {
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
      n.routingTable = syncConnectedRoutes(n, nodes, links);
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

  const clientLogical = getRouterLogicalInterfaces(clientNode)[0];
  if (!clientLogical) {
    return {
      steps: [],
      updatedNodes: nodes,
      success: false,
      summaryMessage: `На устройстве ${clientNode.name} не настроен IPv4-адрес. Сначала получите IP по DHCP или задайте его вручную.`,
    };
  }

  let cleanInput = rawUrlOrHost.trim().replace(/^https?:\/\//i, '');
  const slashIdx = cleanInput.indexOf('/');
  const hostPart = slashIdx >= 0 ? cleanInput.slice(0, slashIdx) : cleanInput;
  const pathPart = slashIdx >= 0 ? cleanInput.slice(slashIdx) : '/index.html';

  const steps: SimulationStep[] = [];
  let targetIp = hostPart;

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
    customSummary: `TCP [SYN] Seq=0 Win=64240 Len=0 (${clientLogical.ipAddress}:49152 → ${targetIp}:80)`,
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

  const replyDstIp = synRes.usedSourceIp || clientLogical.ipAddress;

  const synAckRes = transmitIpPacket(webServer, replyDstIp, 'TCP_SYN_ACK', nodes, links, steps, {
    customSummary: `TCP [SYN, ACK] Seq=0 Ack=1 Win=65535 (${targetIp}:80 → ${replyDstIp}:49152)`,
  });

  if (!synAckRes.reachedTargetNode) {
    return {
      steps,
      updatedNodes: nodes,
      success: false,
      summaryMessage:
        synAckRes.failureReason || `Ответ TCP SYN-ACK от ${webServer.name} не смог вернуться к клиенту.`,
    };
  }

  transmitIpPacket(clientNode, targetIp, 'TCP_ACK', nodes, links, steps, {
    customSummary: `TCP [ACK] Seq=1 Ack=1 — Соединение TCP 3-Way Handshake установлено`,
  });

  // Phase 3: HTTP GET Request & HTTP 200 OK Response
  const getRes = transmitIpPacket(clientNode, targetIp, 'HTTP_GET', nodes, links, steps, {
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

  if (!getRes.reachedTargetNode) {
    return {
      steps,
      updatedNodes: nodes,
      success: false,
      summaryMessage: getRes.failureReason || `HTTP GET к ${targetIp} был заблокирован или потерян.`,
    };
  }

  const pageTitle = webServer.services?.httpTitle || `Welcome to ${webServer.name} (${hostPart})`;
  const pageBody =
    webServer.services?.httpBody ||
    `HTML-страница успешно загружена с узла ${webServer.name} (${targetIp}) по протоколу HTTP/1.1 поверх TCP-соединения.`;

  const httpReplyDstIp = getRes.usedSourceIp || replyDstIp;
  transmitIpPacket(webServer, httpReplyDstIp, 'HTTP_200_OK', nodes, links, steps, {
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
