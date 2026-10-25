import {
  AclAction,
  AclProtocol,
  AclRule,
  NetworkNode,
  RouteEntry,
  RouterSubinterface,
} from './types';
import { getNetworkAddress, isSameSubnet, isValidIpv4, isValidSubnetMask } from './ipMath';
import { getRouterLogicalInterfaces, syncConnectedRoutes } from './simulator';

export interface SuggestedStaticRoute {
  network: string;
  mask: string;
  nextHop: string;
  viaRouterName: string;
  description: string;
}

/**
 * Adds or updates an 802.1Q subinterface (e.g. Fa0/0.10) on a router port,
 * automatically setting the parent physical port to 802.1Q Trunk mode and
 * ensuring the VLAN ID is included in `trunkAllowedVlans`.
 */
export function upsertRouterSubinterface(
  routerNode: NetworkNode,
  parentInterfaceId: string,
  subif: RouterSubinterface
): NetworkNode {
  const cleanVlan = Math.max(1, Math.min(4094, Math.floor(Number(subif.vlanId) || 10)));
  const cleanIp = subif.ipAddress.trim();
  const cleanMask = isValidSubnetMask(subif.subnetMask.trim())
    ? subif.subnetMask.trim()
    : '255.255.255.0';
  const cleanHelper = subif.helperAddress?.trim() || undefined;
  const cleanNatRole = subif.natRole || 'none';

  const nextInterfaces = routerNode.interfaces.map((iface) => {
    if (iface.id !== parentInterfaceId) return iface;

    const existingSubs = iface.subinterfaces || [];
    const exists = existingSubs.some((s) => s.vlanId === cleanVlan);
    const newEntry: RouterSubinterface = {
      id: subif.id || `${iface.id}-sub-${cleanVlan}`,
      vlanId: cleanVlan,
      ipAddress: cleanIp,
      subnetMask: cleanMask,
      helperAddress: cleanHelper,
      natRole: cleanNatRole,
    };

    const nextSubs = exists
      ? existingSubs.map((s) => (s.vlanId === cleanVlan ? newEntry : s))
      : [...existingSubs, newEntry].sort((a, b) => a.vlanId - b.vlanId);

    const nextAllowedVlans = Array.from(
      new Set([...(iface.trunkAllowedVlans || [1]), 1, cleanVlan])
    ).sort((a, b) => a - b);

    return {
      ...iface,
      adminStatus: 'up' as const,
      vlanMode: 'trunk' as const,
      trunkAllowedVlans: nextAllowedVlans,
      subinterfaces: nextSubs,
    };
  });

  const updatedNode: NetworkNode = {
    ...routerNode,
    natEnabled:
      cleanNatRole !== 'none' ? true : Boolean(routerNode.natEnabled),
    interfaces: nextInterfaces,
  };

  return {
    ...updatedNode,
    routingTable: syncConnectedRoutes(updatedNode),
  };
}

/**
 * Removes an 802.1Q subinterface by VLAN ID from a router interface.
 */
export function removeRouterSubinterface(
  routerNode: NetworkNode,
  parentInterfaceId: string,
  vlanId: number
): NetworkNode {
  const nextInterfaces = routerNode.interfaces.map((iface) => {
    if (iface.id !== parentInterfaceId) return iface;
    const nextSubs = (iface.subinterfaces || []).filter((s) => s.vlanId !== vlanId);
    return {
      ...iface,
      subinterfaces: nextSubs,
    };
  });

  const updatedNode: NetworkNode = {
    ...routerNode,
    interfaces: nextInterfaces,
  };

  return {
    ...updatedNode,
    routingTable: syncConnectedRoutes(updatedNode),
  };
}

/**
 * Adds or updates a static route (`ip route <network> <mask> <nextHop>`) on a router,
 * normalizing the network address from the provided IP + mask and resolving the outgoing interface.
 */
export function addRouterStaticRoute(
  routerNode: NetworkNode,
  networkInput: string,
  maskInput: string,
  nextHopInput: string
): { updatedNode: NetworkNode; error: string | null } {
  const rawNet = networkInput.trim();
  const rawMask = maskInput.trim();
  const rawHop = nextHopInput.trim();

  if (!isValidIpv4(rawNet)) {
    return { updatedNode: routerNode, error: 'Некорректный IPv4-адрес сети назначения' };
  }
  const isDefaultRoute = rawNet === '0.0.0.0' && rawMask === '0.0.0.0';
  if (!isDefaultRoute && !isValidSubnetMask(rawMask)) {
    return { updatedNode: routerNode, error: 'Некорректная маска подсети' };
  }
  if (!isValidIpv4(rawHop)) {
    return { updatedNode: routerNode, error: 'Некорректный IPv4-адрес шлюза Next-Hop' };
  }

  const normalizedNet = isDefaultRoute
    ? '0.0.0.0'
    : getNetworkAddress(rawNet, rawMask);

  const logicalIfaces = getRouterLogicalInterfaces(routerNode);
  const matchingEgress = logicalIfaces.find(
    (iface) =>
      isValidIpv4(iface.ipAddress) &&
      isValidSubnetMask(iface.subnetMask) &&
      isSameSubnet(iface.ipAddress, rawHop, iface.subnetMask)
  );

  const interfaceName =
    matchingEgress?.logicalName || routerNode.interfaces[0]?.shortName || 'Fa0/0';

  const currentRoutes = syncConnectedRoutes(routerNode);
  const filteredStatic = currentRoutes.filter(
    (r) =>
      !(
        r.type === 'S' &&
        r.network === normalizedNet &&
        r.mask === rawMask &&
        r.nextHop === rawHop
      )
  );

  const newRoute: RouteEntry = {
    id: `rt-static-${normalizedNet}-${Date.now()}`,
    network: normalizedNet,
    mask: rawMask,
    nextHop: rawHop,
    interfaceName,
    type: 'S',
  };

  const updatedNode: NetworkNode = {
    ...routerNode,
    routingTable: [...filteredStatic, newRoute],
  };

  return { updatedNode, error: null };
}

/**
 * Discovers remote subnets across other routers/nodes in the topology that are not yet
 * present in `routerNode`'s routing table, returning ready-to-apply static route suggestions.
 */
export function getSuggestedStaticRoutes(
  routerNode: NetworkNode,
  allNodes: NetworkNode[]
): SuggestedStaticRoute[] {
  const existingRoutes = syncConnectedRoutes(routerNode);
  const myLogicalIfaces = getRouterLogicalInterfaces(routerNode).filter(
    (i) => isValidIpv4(i.ipAddress) && isValidSubnetMask(i.subnetMask)
  );

  const suggestions: SuggestedStaticRoute[] = [];
  const seenNets = new Set<string>(
    existingRoutes
      .filter((r) => r.type === 'C' || r.type === 'S')
      .map((r) => `${r.network}/${r.mask}`)
  );

  const otherRouters = allNodes.filter(
    (n) => n.type === 'router' && n.id !== routerNode.id
  );

  // Discover all directly connected neighbor router IPs (1-hop gateways)
  const directNeighborHops: string[] = [];
  for (const peerRouter of otherRouters) {
    const peerIfaces = getRouterLogicalInterfaces(peerRouter).filter(
      (i) => isValidIpv4(i.ipAddress) && isValidSubnetMask(i.subnetMask)
    );
    for (const myIface of myLogicalIfaces) {
      const peerMatch = peerIfaces.find((pIface) =>
        isSameSubnet(myIface.ipAddress, pIface.ipAddress, myIface.subnetMask)
      );
      if (peerMatch && !directNeighborHops.includes(peerMatch.ipAddress)) {
        directNeighborHops.push(peerMatch.ipAddress);
      }
    }
  }

  for (const peerRouter of otherRouters) {
    const peerIfaces = getRouterLogicalInterfaces(peerRouter).filter(
      (i) => isValidIpv4(i.ipAddress) && isValidSubnetMask(i.subnetMask)
    );

    // Find a shared transit subnet with this peerRouter, or fall back to our 1-hop neighbor router IP
    let reachableNextHop: string | null = null;
    for (const myIface of myLogicalIfaces) {
      const peerMatch = peerIfaces.find((pIface) =>
        isSameSubnet(myIface.ipAddress, pIface.ipAddress, myIface.subnetMask)
      );
      if (peerMatch) {
        reachableNextHop = peerMatch.ipAddress;
        break;
      }
    }

    if (!reachableNextHop) {
      reachableNextHop = directNeighborHops[0] || peerIfaces[0]?.ipAddress || null;
    }
    if (!reachableNextHop) continue;

    for (const peerIface of peerIfaces) {
      const remoteNet = getNetworkAddress(peerIface.ipAddress, peerIface.subnetMask);
      const key = `${remoteNet}/${peerIface.subnetMask}`;
      if (seenNets.has(key)) continue;

      seenNets.add(key);
      suggestions.push({
        network: remoteNet,
        mask: peerIface.subnetMask,
        nextHop: reachableNextHop,
        viaRouterName: peerRouter.name,
        description: `Сеть ${remoteNet} за ${peerRouter.name} (${peerIface.logicalName})`,
      });
    }
  }

  return suggestions;
}

/**
 * Adds a new ACL rule to the router and sorts rules by sequence number (`seq`).
 */
export function addRouterAclRule(
  routerNode: NetworkNode,
  ruleInput: {
    seq?: number;
    action: AclAction;
    protocol: AclProtocol;
    srcIp: string;
    dstIp: string;
    dstPort?: number;
  }
): NetworkNode {
  const existing = routerNode.aclRules || [];
  const nextSeq =
    ruleInput.seq && ruleInput.seq > 0
      ? Math.floor(ruleInput.seq)
      : existing.length > 0
      ? Math.max(...existing.map((r) => r.seq)) + 10
      : 10;

  const newRule: AclRule = {
    id: `acl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    seq: nextSeq,
    action: ruleInput.action,
    protocol: ruleInput.protocol,
    srcIp: ruleInput.srcIp.trim() || 'any',
    dstIp: ruleInput.dstIp.trim() || 'any',
    dstPort: ruleInput.dstPort,
    enabled: true,
    hitCount: 0,
  };

  const withoutDuplicateSeq = existing.filter((r) => r.seq !== nextSeq);
  return {
    ...routerNode,
    aclRules: [...withoutDuplicateSeq, newRule].sort((a, b) => a.seq - b.seq),
  };
}
