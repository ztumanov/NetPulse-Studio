import {
  NetworkInterface,
  NetworkLink,
  NetworkNode,
  StackConfig,
  StackMemberRole,
  StackProtocol,
} from './types';
import { isSameSubnet, isValidIpv4 } from './ipMath';

export interface StackMemberStatus {
  node: NetworkNode;
  nodeId: string;
  nodeName: string;
  deviceType: 'router' | 'switch';
  memberNumber: number;
  priority: number;
  role: StackMemberRole;
  state: 'Ready' | 'Standby' | 'Active' | 'Offline';
  isOperational: boolean;
  macAddress: string;
  virtualIp?: string;
  virtualMac: string;
  stackPortNames: string[];
}

export interface StackGroupInfo {
  stackId: string;
  domainId: number;
  deviceType: 'router' | 'switch';
  protocol: StackProtocol;
  backplaneSpeedGbps: number;
  virtualIp?: string;
  virtualMac: string;
  masterNodeId: string | null;
  masterNodeName: string | null;
  standbyNodeId: string | null;
  standbyNodeName: string | null;
  members: StackMemberStatus[];
  stackLinkIds: string[];
}

export function getDefaultStackVirtualMac(domainId: number = 1): string {
  const hex = Math.max(1, Math.min(255, domainId || 1))
    .toString(16)
    .toUpperCase()
    .padStart(2, '0');
  return `00:00:0C:9F:F0:${hex}`;
}

export function getNodePrimaryMac(node: NetworkNode): string {
  const macs = node.interfaces
    .map((i) => i.macAddress?.toUpperCase())
    .filter(Boolean)
    .sort();
  return macs[0] || '00:00:00:FF:FF:FF';
}

export function isNodeOperationalInStack(
  node: NetworkNode,
  allNodes?: NetworkNode[],
  allLinks?: NetworkLink[]
): boolean {
  const upInterfaces = node.interfaces.filter((i) => i.adminStatus === 'up');
  if (upInterfaces.length === 0) return false;
  if (!allNodes || !allLinks) return true;

  // If the node has links attached, check if at least one non-shutdown link is up,
  // or if it has no links yet, count its admin-up interfaces as operational.
  const nodeLinks = allLinks.filter(
    (l) => l.sourceNodeId === node.id || l.targetNodeId === node.id
  );
  if (nodeLinks.length === 0) return true;

  return nodeLinks.some((l) => {
    const src = allNodes.find((n) => n.id === l.sourceNodeId);
    const dst = allNodes.find((n) => n.id === l.targetNodeId);
    if (!src || !dst) return false;
    const sp = src.interfaces.find((p) => p.id === l.sourcePortId);
    const dp = dst.interfaces.find((p) => p.id === l.targetPortId);
    return sp?.adminStatus === 'up' && dp?.adminStatus === 'up';
  });
}

/**
 * Discovers all active Switch Stacks (StackWise-480 / VSS) and Router Stacks (HSRP / VSS)
 * in the topology, dynamically electing Master/Active and Standby roles.
 */
export function getStackGroups(
  nodes: NetworkNode[],
  links: NetworkLink[]
): StackGroupInfo[] {
  const stackableNodes = nodes.filter(
    (n) => n.type === 'switch' || n.type === 'router'
  );
  if (stackableNodes.length === 0) return [];

  // Map nodeId -> effective stackId
  const effectiveStackIdByNode = new Map<string, string>();
  for (const node of stackableNodes) {
    if (node.stackConfig?.enabled && node.stackConfig.stackId.trim()) {
      effectiveStackIdByNode.set(node.id, node.stackConfig.stackId.trim());
    }
  }

  // Also include any switches or routers connected via a 'stack' cable even if stackConfig wasn't initialized yet
  for (const link of links) {
    if (link.cableType !== 'stack') continue;
    const src = nodes.find((n) => n.id === link.sourceNodeId);
    const dst = nodes.find((n) => n.id === link.targetNodeId);
    if (!src || !dst || src.type !== dst.type) continue;
    if (src.type !== 'switch' && src.type !== 'router') continue;

    const existingA = effectiveStackIdByNode.get(src.id);
    const existingB = effectiveStackIdByNode.get(dst.id);
    const resolvedId =
      existingA ||
      existingB ||
      (src.type === 'switch' ? 'STACK-SW-1' : 'STACK-RTR-1');
    effectiveStackIdByNode.set(src.id, resolvedId);
    effectiveStackIdByNode.set(dst.id, resolvedId);
  }

  // Group nodes by effective stackId
  const nodesByStackId = new Map<string, NetworkNode[]>();
  for (const node of stackableNodes) {
    const sid = effectiveStackIdByNode.get(node.id);
    if (!sid) continue;
    const list = nodesByStackId.get(sid) || [];
    list.push(node);
    nodesByStackId.set(sid, list);
  }

  const groups: StackGroupInfo[] = [];

  for (const [stackId, memberNodes] of nodesByStackId.entries()) {
    const firstCfg = memberNodes.find((n) => n.stackConfig)?.stackConfig;
    const deviceType: 'router' | 'switch' =
      memberNodes[0].type === 'router' ? 'router' : 'switch';
    const domainId = firstCfg?.domainId || 1;
    const protocol: StackProtocol =
      firstCfg?.protocol || (deviceType === 'switch' ? 'StackWise-480' : 'HSRP');
    const backplaneSpeedGbps =
      firstCfg?.backplaneSpeedGbps || (protocol === 'StackWise-480' ? 480 : 80);
    const sharedVirtualIp =
      memberNodes
        .map((n) => n.stackConfig?.virtualIp?.trim())
        .find((ip) => ip && isValidIpv4(ip)) || undefined;
    const sharedVirtualMac =
      memberNodes
        .map((n) => n.stackConfig?.virtualMac?.trim())
        .find(Boolean) || getDefaultStackVirtualMac(domainId);

    // Find stack interconnect links among members of this stack
    const memberIdSet = new Set(memberNodes.map((n) => n.id));
    const stackLinks = links.filter(
      (l) =>
        memberIdSet.has(l.sourceNodeId) &&
        memberIdSet.has(l.targetNodeId) &&
        l.sourceNodeId !== l.targetNodeId
    );

    // Prepare candidate entries for Master / Standby election
    const rawMembers = memberNodes.map((node, idx) => {
      const cfg = node.stackConfig;
      const memberNumber = cfg?.memberNumber || idx + 1;
      const priority = cfg?.priority ?? (idx === 0 ? 15 : 10);
      const isOperational = isNodeOperationalInStack(node, nodes, links);
      const macAddress = getNodePrimaryMac(node);

      const stackPortNames: string[] = [];
      for (const sl of stackLinks) {
        if (sl.sourceNodeId === node.id) {
          const p = node.interfaces.find((i) => i.id === sl.sourcePortId);
          if (p) stackPortNames.push(p.shortName);
        } else if (sl.targetNodeId === node.id) {
          const p = node.interfaces.find((i) => i.id === sl.targetPortId);
          if (p) stackPortNames.push(p.shortName);
        }
      }

      return {
        node,
        memberNumber,
        priority,
        isOperational,
        macAddress,
        stackPortNames,
      };
    });

    // Elect Master (highest priority among operational members, then lowest memberNumber, then lowest MAC)
    const electionOrder = [...rawMembers].sort((a, b) => {
      if (a.isOperational !== b.isOperational) {
        return a.isOperational ? -1 : 1;
      }
      if (b.priority !== a.priority) {
        return b.priority - a.priority;
      }
      if (a.memberNumber !== b.memberNumber) {
        return a.memberNumber - b.memberNumber;
      }
      return a.macAddress.localeCompare(b.macAddress);
    });

    const masterEntry = electionOrder.find((m) => m.isOperational) || electionOrder[0];
    const standbyEntry =
      electionOrder.find(
        (m) => m.isOperational && m.node.id !== masterEntry?.node.id
      ) || null;

    // Sort members by memberNumber for display
    const sortedByMemberNum = [...rawMembers].sort(
      (a, b) => a.memberNumber - b.memberNumber
    );

    const members: StackMemberStatus[] = sortedByMemberNum.map((m) => {
      let role: StackMemberRole = 'member';
      let state: StackMemberStatus['state'] = m.isOperational ? 'Ready' : 'Offline';

      if (!m.isOperational) {
        role = 'member';
        state = 'Offline';
      } else if (masterEntry && m.node.id === masterEntry.node.id) {
        role = 'master';
        state = deviceType === 'router' ? 'Active' : 'Ready';
      } else if (standbyEntry && m.node.id === standbyEntry.node.id) {
        role = 'standby';
        state = deviceType === 'router' ? 'Standby' : 'Ready';
      }

      return {
        node: m.node,
        nodeId: m.node.id,
        nodeName: m.node.name,
        deviceType,
        memberNumber: m.memberNumber,
        priority: m.priority,
        role,
        state,
        isOperational: m.isOperational,
        macAddress: m.macAddress,
        virtualIp: m.node.stackConfig?.virtualIp || sharedVirtualIp,
        virtualMac: sharedVirtualMac,
        stackPortNames: m.stackPortNames,
      };
    });

    groups.push({
      stackId,
      domainId,
      deviceType,
      protocol,
      backplaneSpeedGbps,
      virtualIp: sharedVirtualIp,
      virtualMac: sharedVirtualMac,
      masterNodeId: masterEntry?.node.id || null,
      masterNodeName: masterEntry?.node.name || null,
      standbyNodeId: standbyEntry?.node.id || null,
      standbyNodeName: standbyEntry?.node.name || null,
      members,
      stackLinkIds: stackLinks.map((l) => l.id),
    });
  }

  return groups;
}

/**
 * Returns the StackGroupInfo and StackMemberStatus for a specific node, if it belongs to a stack.
 */
export function getNodeStackStatus(
  nodeOrId: NetworkNode | string,
  nodes: NetworkNode[],
  links: NetworkLink[]
): (StackMemberStatus & { group: StackGroupInfo; stackGroup: StackGroupInfo; member: StackMemberStatus }) | null {
  const targetId = typeof nodeOrId === 'string' ? nodeOrId : nodeOrId.id;
  const groups = getStackGroups(nodes, links);
  for (const group of groups) {
    const member = group.members.find((m) => m.nodeId === targetId);
    if (member) {
      return {
        ...member,
        group,
        stackGroup: group,
        member,
      };
    }
  }
  return null;
}

/**
 * Checks whether two nodes belong to the same active stack.
 */
export function areNodesInSameActiveStack(
  nodeA: NetworkNode,
  nodeB: NetworkNode,
  nodes: NetworkNode[],
  links: NetworkLink[]
): boolean {
  if (nodeA.id === nodeB.id || nodeA.type !== nodeB.type) return false;
  if (nodeA.type !== 'switch' && nodeA.type !== 'router') return false;

  if (
    nodeA.stackConfig?.enabled &&
    nodeB.stackConfig?.enabled &&
    nodeA.stackConfig.stackId &&
    nodeA.stackConfig.stackId === nodeB.stackConfig.stackId
  ) {
    return true;
  }

  return links.some(
    (l) =>
      l.cableType === 'stack' &&
      ((l.sourceNodeId === nodeA.id && l.targetNodeId === nodeB.id) ||
        (l.sourceNodeId === nodeB.id && l.targetNodeId === nodeA.id))
  );
}

/**
 * Checks if a link connects two members of the same stack (either cableType === 'stack'
 * or any link between two nodes in the same active stack).
 */
export function isStackInterconnectLink(
  link: NetworkLink,
  nodes: NetworkNode[],
  links: NetworkLink[]
): boolean {
  const src = nodes.find((n) => n.id === link.sourceNodeId);
  const dst = nodes.find((n) => n.id === link.targetNodeId);
  if (!src || !dst) return false;
  if (link.cableType === 'stack' && src.type === dst.type) return true;
  return areNodesInSameActiveStack(src, dst, nodes, links);
}

/**
 * Determines if a Router (or L3 Switch) port should act as the active Virtual Gateway
 * for `targetIp` on a given subnet/VLAN (supporting HSRP / VRRP / Stack Virtual IP and
 * automatic takeover if the primary Master router's LAN port is down).
 */
export function resolveStackVirtualGatewayOnPort(
  candidateNode: NetworkNode,
  candidatePort: NetworkInterface,
  targetIp: string,
  allNodes: NetworkNode[],
  allLinks: NetworkLink[]
): {
  isVirtualGatewayMatch: boolean;
  isActiveResponder: boolean;
  virtualIp: string;
  virtualMac: string;
  stackId: string;
  role: StackMemberRole;
} | null {
  if (!isValidIpv4(targetIp) || candidatePort.adminStatus !== 'up') return null;

  const stackStatus = getNodeStackStatus(candidateNode.id, allNodes, allLinks);
  if (!stackStatus) return null;

  const { group, member } = stackStatus;
  if (group.members.length < 1) return null;

  // Check if candidatePort has a valid IPv4 in the same subnet as targetIp
  const portHasSameSubnet =
    isValidIpv4(candidatePort.ipAddress) &&
    isValidIpv4(candidatePort.subnetMask) &&
    isSameSubnet(candidatePort.ipAddress, targetIp, candidatePort.subnetMask);

  // Determine all Virtual IPs protected by this stack:
  // 1) Explicit virtualIp configured on the stack or any stack member
  // 2) Or, if another member of the stack has `targetIp` configured on a port that is currently DOWN/disconnected,
  //    operational members on the same subnet automatically take over `targetIp`!
  const explicitVip =
    candidateNode.stackConfig?.virtualIp?.trim() || group.virtualIp;

  let isProtectedTargetIp = false;
  if (explicitVip && explicitVip === targetIp) {
    isProtectedTargetIp = true;
  } else if (portHasSameSubnet && candidatePort.ipAddress !== targetIp) {
    // Check if another member in the same stack owns targetIp on an interface that is currently DOWN
    for (const m of group.members) {
      if (m.nodeId === candidateNode.id) continue;
      const peerMemberNode = allNodes.find((n) => n.id === m.nodeId);
      if (!peerMemberNode) continue;
      const peerPortWithIp = peerMemberNode.interfaces.find(
        (p) => p.ipAddress === targetIp
      );
      if (peerPortWithIp) {
        const peerLinkUp = allLinks.some((l) => {
          const isConn =
            (l.sourceNodeId === peerMemberNode.id &&
              l.sourcePortId === peerPortWithIp.id) ||
            (l.targetNodeId === peerMemberNode.id &&
              l.targetPortId === peerPortWithIp.id);
          if (!isConn) return false;
          return peerPortWithIp.adminStatus === 'up';
        });
        if (!peerLinkUp || peerPortWithIp.adminStatus !== 'up') {
          isProtectedTargetIp = true;
        }
      }
    }
  }

  if (!isProtectedTargetIp) return null;

  // Find all stack members that have an operational port on this exact subnet
  const eligibleMembers = group.members.filter((m) => {
    const mNode = allNodes.find((n) => n.id === m.nodeId);
    if (!mNode) return false;
    return mNode.interfaces.some((iface) => {
      if (iface.adminStatus !== 'up') return false;
      // Check that the port is connected to an operational link
      const hasUpLink = allLinks.some((l) => {
        const matchesEnd =
          (l.sourceNodeId === mNode.id && l.sourcePortId === iface.id) ||
          (l.targetNodeId === mNode.id && l.targetPortId === iface.id);
        if (!matchesEnd) return false;
        const otherNodeId =
          l.sourceNodeId === mNode.id ? l.targetNodeId : l.sourceNodeId;
        const otherPortId =
          l.sourceNodeId === mNode.id ? l.targetPortId : l.sourcePortId;
        const otherNode = allNodes.find((n) => n.id === otherNodeId);
        const otherPort = otherNode?.interfaces.find((p) => p.id === otherPortId);
        return otherPort?.adminStatus === 'up';
      });
      if (!hasUpLink) return false;

      return (
        isValidIpv4(iface.ipAddress) &&
        isValidIpv4(iface.subnetMask) &&
        isSameSubnet(iface.ipAddress, targetIp, iface.subnetMask)
      );
    });
  });

  if (eligibleMembers.length === 0) return null;

  // Sort eligible members by priority DESC, memberNumber ASC, MAC ASC
  eligibleMembers.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    if (a.memberNumber !== b.memberNumber) return a.memberNumber - b.memberNumber;
    return a.macAddress.localeCompare(b.macAddress);
  });

  const activeMember = eligibleMembers[0];
  const isActiveResponder = activeMember.nodeId === candidateNode.id;

  return {
    isVirtualGatewayMatch: true,
    isActiveResponder,
    virtualIp: targetIp,
    virtualMac: group.virtualMac,
    stackId: group.stackId,
    role: isActiveResponder ? 'master' : member.role,
  };
}

/**
 * Helper to configure two same-type devices (Switch+Switch or Router+Router) into a unified Stack
 * when connected by a Stack cable or joined via the GUI.
 */
export function buildJoinedStackNodes(
  nodeAId: string,
  nodeBId: string,
  sourcePortId: string | null,
  targetPortId: string | null,
  nodes: NetworkNode[]
): { updatedNodes: NetworkNode[]; stackId: string } {
  const nodeA = nodes.find((n) => n.id === nodeAId);
  const nodeB = nodes.find((n) => n.id === nodeBId);
  if (!nodeA || !nodeB || nodeA.type !== nodeB.type) {
    return { updatedNodes: nodes, stackId: '' };
  }

  const isSwitch = nodeA.type === 'switch';
  const defaultStackId = isSwitch ? 'STACK-CORE-1' : 'STACK-WAN-1';
  const stackId =
    (nodeA.stackConfig?.enabled && nodeA.stackConfig.stackId) ||
    (nodeB.stackConfig?.enabled && nodeB.stackConfig.stackId) ||
    defaultStackId;

  const existingStackMembers = nodes.filter(
    (n) =>
      n.id !== nodeA.id &&
      n.id !== nodeB.id &&
      n.stackConfig?.enabled &&
      n.stackConfig.stackId === stackId
  );

  const usedNumbers = new Set<number>(
    existingStackMembers.map((m) => m.stackConfig?.memberNumber || 1)
  );
  const getNextMemberNum = (): number => {
    let num = 1;
    while (usedNumbers.has(num)) num++;
    usedNumbers.add(num);
    return num;
  };

  const numA =
    nodeA.stackConfig?.enabled && nodeA.stackConfig.stackId === stackId
      ? (usedNumbers.add(nodeA.stackConfig.memberNumber),
        nodeA.stackConfig.memberNumber)
      : getNextMemberNum();
  const numB =
    nodeB.stackConfig?.enabled && nodeB.stackConfig.stackId === stackId
      ? (usedNumbers.add(nodeB.stackConfig.memberNumber),
        nodeB.stackConfig.memberNumber)
      : getNextMemberNum();

  // Determine shared Virtual IP for routers if one of them has a LAN IP
  const existingVip =
    nodeA.stackConfig?.virtualIp || nodeB.stackConfig?.virtualIp || '';

  const updatedNodes = nodes.map((n) => {
    if (n.id !== nodeA.id && n.id !== nodeB.id) return n;
    const isFirst = n.id === nodeA.id;
    const memberNumber = isFirst ? numA : numB;
    const defaultPriority = memberNumber === 1 ? 15 : Math.max(1, 15 - (memberNumber - 1) * 5);
    const portIdToTrunk = isFirst ? sourcePortId : targetPortId;

    const nextInterfaces = isSwitch
      ? n.interfaces.map((iface) =>
          iface.id === portIdToTrunk
            ? {
                ...iface,
                vlanMode: 'trunk' as const,
                trunkAllowedVlans: Array.from(
                  new Set([...(iface.trunkAllowedVlans || [1, 10, 20, 30]), 1, 10, 20, 30, 99])
                ),
              }
            : iface
        )
      : n.interfaces;

    const nextStackConfig: StackConfig = {
      enabled: true,
      stackId,
      domainId: n.stackConfig?.domainId || 1,
      memberNumber,
      priority: n.stackConfig?.priority || defaultPriority,
      role: memberNumber === 1 ? 'master' : memberNumber === 2 ? 'standby' : 'member',
      protocol: isSwitch ? 'StackWise-480' : 'HSRP',
      virtualIp: existingVip || n.stackConfig?.virtualIp,
      virtualMac: n.stackConfig?.virtualMac || getDefaultStackVirtualMac(1),
      preempt: true,
      backplaneSpeedGbps: isSwitch ? 480 : 80,
    };

    return {
      ...n,
      interfaces: nextInterfaces,
      stackConfig: nextStackConfig,
    };
  });

  return { updatedNodes, stackId };
}
