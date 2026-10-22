import {
  NetworkInterface,
  NetworkLink,
  NetworkNode,
  SimulationStep,
  SwitchVlanEntry,
} from './types';
import { generateMacAddress } from './ipMath';

export type PortLedState =
  | 'active-traffic'
  | 'link-up'
  | 'link-down'
  | 'admin-down'
  | 'unplugged';

export interface PortHardwareDescriptor {
  port: NetworkInterface;
  portIndex: number;
  isUplink: boolean;
  connectedLink: NetworkLink | null;
  peerNode: NetworkNode | null;
  peerPort: NetworkInterface | null;
  ledState: PortLedState;
  ledLabel: 'ACT' | 'UP' | 'DOWN' | 'SHUT' | 'FREE';
}

export interface AvailablePeerPortOption {
  nodeId: string;
  nodeName: string;
  nodeType: NetworkNode['type'];
  portId: string;
  portShortName: string;
  ipAddress: string;
  accessVlan: number;
  adminStatus: 'up' | 'down';
}

export interface TwoRowPortColumn {
  columnIndex: number;
  top: PortHardwareDescriptor;
  bottom: PortHardwareDescriptor | null;
}

const DEFAULT_VLAN_NAMES: Record<number, { name: string; subnetHint: string }> = {
  1: { name: 'default', subnetHint: 'Native / Management VLAN' },
  10: { name: 'VLAN0010_Sales', subnetHint: '192.168.10.0/24 · Отдел продаж' },
  20: { name: 'VLAN0020_DataCenter', subnetHint: '192.168.20.0/24 · Серверный сегмент' },
  30: { name: 'VLAN0030_Engineering', subnetHint: '192.168.30.0/24 · Инженерный отдел' },
};

/**
 * Returns the consolidated VLAN database for a network device, combining
 * explicit `node.vlanDatabase` entries with any VLANs referenced by ports.
 */
export function getDeviceVlanDatabase(node: NetworkNode): SwitchVlanEntry[] {
  const byId = new Map<number, SwitchVlanEntry>();

  // Always include VLAN 1
  byId.set(1, {
    id: 1,
    name: DEFAULT_VLAN_NAMES[1].name,
    subnetHint: DEFAULT_VLAN_NAMES[1].subnetHint,
  });

  if (Array.isArray(node.vlanDatabase)) {
    for (const entry of node.vlanDatabase) {
      if (entry.id >= 1 && entry.id <= 4094) {
        byId.set(entry.id, {
          id: entry.id,
          name: entry.name.trim() || `VLAN${String(entry.id).padStart(4, '0')}`,
          subnetHint: entry.subnetHint || DEFAULT_VLAN_NAMES[entry.id]?.subnetHint || '',
        });
      }
    }
  }

  for (const iface of node.interfaces) {
    if (iface.accessVlan >= 1 && iface.accessVlan <= 4094 && !byId.has(iface.accessVlan)) {
      const preset = DEFAULT_VLAN_NAMES[iface.accessVlan];
      byId.set(iface.accessVlan, {
        id: iface.accessVlan,
        name: preset?.name || `VLAN${String(iface.accessVlan).padStart(4, '0')}`,
        subnetHint: preset?.subnetHint || '',
      });
    }
    for (const trunkVlan of iface.trunkAllowedVlans || []) {
      if (trunkVlan >= 1 && trunkVlan <= 4094 && !byId.has(trunkVlan)) {
        const preset = DEFAULT_VLAN_NAMES[trunkVlan];
        byId.set(trunkVlan, {
          id: trunkVlan,
          name: preset?.name || `VLAN${String(trunkVlan).padStart(4, '0')}`,
          subnetHint: preset?.subnetHint || '',
        });
      }
    }
  }

  return Array.from(byId.values()).sort((a, b) => a.id - b.id);
}

/**
 * Adds or updates a VLAN in the switch's VLAN database and optionally adds it
 * to existing 802.1Q trunk ports on the device.
 */
export function upsertDeviceVlan(
  node: NetworkNode,
  vlanId: number,
  name: string,
  subnetHint = '',
  autoAllowOnTrunks = true
): NetworkNode {
  const cleanId = Math.max(1, Math.min(4094, Math.floor(Number(vlanId) || 1)));
  const cleanName =
    name.trim() ||
    DEFAULT_VLAN_NAMES[cleanId]?.name ||
    `VLAN${String(cleanId).padStart(4, '0')}`;
  const cleanHint = subnetHint.trim() || DEFAULT_VLAN_NAMES[cleanId]?.subnetHint || '';

  const currentDb = getDeviceVlanDatabase(node);
  const exists = currentDb.some((v) => v.id === cleanId);
  const nextDb = exists
    ? currentDb.map((v) =>
        v.id === cleanId ? { id: cleanId, name: cleanName, subnetHint: cleanHint } : v
      )
    : [...currentDb, { id: cleanId, name: cleanName, subnetHint: cleanHint }].sort(
        (a, b) => a.id - b.id
      );

  const nextInterfaces = autoAllowOnTrunks
    ? node.interfaces.map((iface) => {
        if (iface.vlanMode !== 'trunk') return iface;
        if (iface.trunkAllowedVlans.includes(cleanId)) return iface;
        return {
          ...iface,
          trunkAllowedVlans: [...iface.trunkAllowedVlans, cleanId].sort((a, b) => a - b),
        };
      })
    : node.interfaces;

  return {
    ...node,
    vlanDatabase: nextDb,
    interfaces: nextInterfaces,
  };
}

/**
 * Deletes a VLAN (except default VLAN 1) from the switch database and reassigns
 * any Access ports on that VLAN back to VLAN 1.
 */
export function deleteDeviceVlan(node: NetworkNode, vlanId: number): NetworkNode {
  if (vlanId === 1) return node;
  const currentDb = getDeviceVlanDatabase(node).filter((v) => v.id !== vlanId);
  const nextInterfaces = node.interfaces.map((iface) => {
    const nextAccess = iface.accessVlan === vlanId ? 1 : iface.accessVlan;
    const filteredTrunk = iface.trunkAllowedVlans.filter((v) => v !== vlanId);
    return {
      ...iface,
      accessVlan: nextAccess,
      trunkAllowedVlans: filteredTrunk.length > 0 ? filteredTrunk : [1],
    };
  });

  return {
    ...node,
    vlanDatabase: currentDb,
    interfaces: nextInterfaces,
  };
}

/**
 * Assigns one or multiple switch ports to a specific VLAN in Access or 802.1Q Trunk mode.
 */
export function assignPortsToVlan(
  node: NetworkNode,
  portIds: string[],
  vlanId: number,
  operation: 'access' | 'trunk-add' | 'trunk-remove'
): NetworkNode {
  const cleanVlan = Math.max(1, Math.min(4094, Math.floor(Number(vlanId) || 1)));
  const portSet = new Set(portIds);

  const withVlanEnsured = upsertDeviceVlan(
    node,
    cleanVlan,
    getDeviceVlanDatabase(node).find((v) => v.id === cleanVlan)?.name || '',
    getDeviceVlanDatabase(node).find((v) => v.id === cleanVlan)?.subnetHint || '',
    false
  );

  const nextInterfaces = withVlanEnsured.interfaces.map((iface) => {
    if (!portSet.has(iface.id)) return iface;
    if (operation === 'access') {
      return {
        ...iface,
        vlanMode: 'access' as const,
        accessVlan: cleanVlan,
      };
    }
    if (operation === 'trunk-add') {
      const merged = Array.from(new Set([...iface.trunkAllowedVlans, cleanVlan])).sort(
        (a, b) => a - b
      );
      return {
        ...iface,
        vlanMode: 'trunk' as const,
        trunkAllowedVlans: merged,
      };
    }
    // trunk-remove
    const remaining = iface.trunkAllowedVlans.filter((v) => v !== cleanVlan);
    return {
      ...iface,
      vlanMode: 'trunk' as const,
      trunkAllowedVlans: remaining.length > 0 ? remaining : [1],
    };
  });

  return {
    ...withVlanEnsured,
    interfaces: nextInterfaces,
  };
}

/**
 * Groups linear port descriptors into 2-row vertical switch columns
 * (top row = odd port 1X, 3X, 5X...; bottom row = even port 2X, 4X, 6X...).
 */
export function groupPortsIntoTwoRows(
  descriptors: PortHardwareDescriptor[]
): TwoRowPortColumn[] {
  const columns: TwoRowPortColumn[] = [];
  for (let i = 0; i < descriptors.length; i += 2) {
    columns.push({
      columnIndex: Math.floor(i / 2) + 1,
      top: descriptors[i],
      bottom: descriptors[i + 1] || null,
    });
  }
  return columns;
}

/**
 * Resolves the physical front-panel state (RJ45 socket, LED color/status, connected peer)
 * for every interface on a given network device.
 */
export function getDeviceChassisPorts(
  node: NetworkNode,
  allNodes: NetworkNode[],
  allLinks: NetworkLink[],
  activeStep: SimulationStep | null
): PortHardwareDescriptor[] {
  return node.interfaces.map((port, idx) => {
    const connectedLink =
      allLinks.find(
        (l) =>
          (l.sourceNodeId === node.id && l.sourcePortId === port.id) ||
          (l.targetNodeId === node.id && l.targetPortId === port.id)
      ) || null;

    let peerNode: NetworkNode | null = null;
    let peerPort: NetworkInterface | null = null;

    if (connectedLink) {
      const isSource =
        connectedLink.sourceNodeId === node.id && connectedLink.sourcePortId === port.id;
      const peerNodeId = isSource ? connectedLink.targetNodeId : connectedLink.sourceNodeId;
      const peerPortId = isSource ? connectedLink.targetPortId : connectedLink.sourcePortId;
      peerNode = allNodes.find((n) => n.id === peerNodeId) || null;
      peerPort = peerNode?.interfaces.find((p) => p.id === peerPortId) || null;
    }

    let ledState: PortLedState = 'unplugged';
    let ledLabel: PortHardwareDescriptor['ledLabel'] = 'FREE';

    if (port.adminStatus === 'down') {
      ledState = 'admin-down';
      ledLabel = 'SHUT';
    } else if (!connectedLink || !peerNode || !peerPort) {
      ledState = 'unplugged';
      ledLabel = 'FREE';
    } else if (peerPort.adminStatus === 'down') {
      ledState = 'link-down';
      ledLabel = 'DOWN';
    } else if (activeStep && activeStep.linkId === connectedLink.id) {
      ledState = 'active-traffic';
      ledLabel = 'ACT';
    } else {
      ledState = 'link-up';
      ledLabel = 'UP';
    }

    const isUplink =
      port.shortName.toLowerCase().startsWith('gi') ||
      port.name.toLowerCase().includes('gigabit');

    return {
      port,
      portIndex: idx + 1,
      isUplink,
      connectedLink,
      peerNode,
      peerPort,
      ledState,
      ledLabel,
    };
  });
}

/**
 * Finds all unoccupied ports across other devices in the topology that can accept a patch cord.
 */
export function getAvailableTargetPorts(
  sourceNodeId: string,
  allNodes: NetworkNode[],
  allLinks: NetworkLink[]
): AvailablePeerPortOption[] {
  const occupiedPortKeys = new Set<string>();
  for (const link of allLinks) {
    occupiedPortKeys.add(`${link.sourceNodeId}:${link.sourcePortId}`);
    occupiedPortKeys.add(`${link.targetNodeId}:${link.targetPortId}`);
  }

  const options: AvailablePeerPortOption[] = [];
  for (const node of allNodes) {
    if (node.id === sourceNodeId) continue;
    for (const iface of node.interfaces) {
      if (!occupiedPortKeys.has(`${node.id}:${iface.id}`)) {
        options.push({
          nodeId: node.id,
          nodeName: node.name,
          nodeType: node.type,
          portId: iface.id,
          portShortName: iface.shortName,
          ipAddress: iface.ipAddress,
          accessVlan: iface.accessVlan,
          adminStatus: iface.adminStatus,
        });
      }
    }
  }
  const priorityOrder: Record<NetworkNode['type'], number> = {
    pc: 1,
    server: 2,
    router: 3,
    switch: 4,
  };

  return options.sort(
    (a, b) => priorityOrder[a.nodeType] - priorityOrder[b.nodeType]
  );
}

/**
 * Moves an existing patch cord from one port on `nodeId` to another free port `newPortId` on the same device.
 */
export function moveLinkToSocket(
  links: NetworkLink[],
  linkId: string,
  nodeId: string,
  newPortId: string
): NetworkLink[] {
  // Check that target port isn't already used by another link
  const alreadyUsed = links.some(
    (l) =>
      l.id !== linkId &&
      ((l.sourceNodeId === nodeId && l.sourcePortId === newPortId) ||
        (l.targetNodeId === nodeId && l.targetPortId === newPortId))
  );
  if (alreadyUsed) return links;

  return links.map((link) => {
    if (link.id !== linkId) return link;
    if (link.sourceNodeId === nodeId) {
      return { ...link, sourcePortId: newPortId };
    }
    if (link.targetNodeId === nodeId) {
      return { ...link, targetPortId: newPortId };
    }
    return link;
  });
}

/**
 * Adds a new physical port to a device chassis (e.g., expanding a switch with another FastEthernet port).
 */
export function addHardwarePortToNode(node: NetworkNode): NetworkNode {
  const nextIndex = node.interfaces.length + 1;
  const seed = Math.abs(
    node.id.split('').reduce((acc, ch) => acc + ch.charCodeAt(0), 0) % 80
  ) + 10;

  if (node.type === 'switch') {
    const faPorts = node.interfaces.filter((i) =>
      i.shortName.toLowerCase().startsWith('fa')
    );
    const nextFaNum = faPorts.length + 1;
    const defaultVlan = faPorts[0]?.accessVlan || 1;
    const newPort: NetworkInterface = {
      id: `${node.id}-fa0/${nextFaNum}-${Date.now()}`,
      name: `FastEthernet0/${nextFaNum}`,
      shortName: `Fa0/${nextFaNum}`,
      macAddress: generateMacAddress(seed, nextIndex),
      ipAddress: '',
      subnetMask: '',
      adminStatus: 'up',
      vlanMode: 'access',
      accessVlan: defaultVlan,
      trunkAllowedVlans: [1, defaultVlan],
    };
    // Insert FastEthernet ports before Gigabit uplink ports for authentic Catalyst layout
    const firstGiIndex = node.interfaces.findIndex((i) =>
      i.shortName.toLowerCase().startsWith('gi')
    );
    const updatedInterfaces =
      firstGiIndex === -1
        ? [...node.interfaces, newPort]
        : [
            ...node.interfaces.slice(0, firstGiIndex),
            newPort,
            ...node.interfaces.slice(firstGiIndex),
          ];
    return { ...node, interfaces: updatedInterfaces };
  }

  if (node.type === 'router') {
    const faPorts = node.interfaces.filter((i) =>
      i.shortName.toLowerCase().startsWith('fa')
    );
    const nextFaNum = faPorts.length;
    const newPort: NetworkInterface = {
      id: `${node.id}-fa0/${nextFaNum}-${Date.now()}`,
      name: `FastEthernet0/${nextFaNum}`,
      shortName: `Fa0/${nextFaNum}`,
      macAddress: generateMacAddress(seed, nextIndex),
      ipAddress: '',
      subnetMask: '255.255.255.0',
      adminStatus: 'up',
      vlanMode: 'access',
      accessVlan: 1,
      trunkAllowedVlans: [1, 10, 20],
    };
    return { ...node, interfaces: [...node.interfaces, newPort] };
  }

  const nextEthNum = node.interfaces.length;
  const newPort: NetworkInterface = {
    id: `${node.id}-eth${nextEthNum}-${Date.now()}`,
    name: `Ethernet${nextEthNum}`,
    shortName: `Eth${nextEthNum}`,
    macAddress: generateMacAddress(seed, nextIndex),
    ipAddress: '',
    subnetMask: '255.255.255.0',
    adminStatus: 'up',
    vlanMode: 'access',
    accessVlan: node.interfaces[0]?.accessVlan || 1,
    trunkAllowedVlans: [1],
  };
  return { ...node, interfaces: [...node.interfaces, newPort] };
}
