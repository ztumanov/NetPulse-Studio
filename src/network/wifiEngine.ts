import {
  NetworkInterface,
  NetworkLink,
  NetworkNode,
  SimulationStep,
  WifiApConfig,
  WlanProfile,
} from './types';
import { generateMacAddress } from './ipMath';

export interface WifiSignalMetrics {
  distancePx: number;
  coverageRadiusPx: number;
  inRange: boolean;
  rssiDbm: number;
  signalQualityPercent: number;
  signalBars: 0 | 1 | 2 | 3 | 4;
}

export interface ScannedWifiNetwork {
  apNodeId: string;
  apName: string;
  bssidMac: string;
  ssid: string;
  channel: number;
  band: '2.4GHz' | '5GHz';
  security: 'open' | 'wpa2';
  coverageRadius: number;
  distancePx: number;
  inRange: boolean;
  rssiDbm: number;
  signalQualityPercent: number;
  signalBars: 0 | 1 | 2 | 3 | 4;
  isConnected: boolean;
  apMode?: 'autonomous' | 'lightweight';
  wlcControllerName?: string;
}

/**
 * Checks if a node is a Wireless LAN Controller (WLC 5520).
 */
export function isWlcControllerNode(node: NetworkNode): boolean {
  return node.deviceModel === 'wlc' || Boolean(node.wlcConfig);
}

/**
 * Checks if a node is a Lightweight AP (LAP) managed via CAPWAP by a WLC.
 */
export function isLightweightApNode(node: NetworkNode): boolean {
  return (
    isWifiAccessPointNode(node) && node.wifiConfig?.apMode === 'lightweight'
  );
}

/**
 * Checks if a node has an IEEE 802.11 Access Point or SOHO Wi-Fi Router radio module.
 */
export function isWifiAccessPointNode(node: NetworkNode): boolean {
  return (
    Boolean(node.wifiConfig) ||
    node.deviceModel === 'wifi_ap' ||
    node.deviceModel === 'soho_wifi_router'
  );
}

/**
 * Checks if a node is a wireless client (Laptop, Smartphone, or PC with wireless adapter).
 */
export function isWirelessClientNode(node: NetworkNode): boolean {
  return (
    Boolean(node.wifiClientConfig) ||
    node.deviceModel === 'laptop' ||
    node.deviceModel === 'smartphone' ||
    node.interfaces.some((i) => Boolean(i.isWireless))
  );
}

/**
 * Computes distance, RSSI (dBm), quality percentage, and 0..4 signal bars between a client and an AP.
 */
export function computeWifiSignalMetrics(
  clientNode: Pick<NetworkNode, 'x' | 'y'>,
  apNode: Pick<NetworkNode, 'x' | 'y' | 'wifiConfig'>
): WifiSignalMetrics {
  const radius = Math.max(80, apNode.wifiConfig?.coverageRadius ?? 240);
  const dx = clientNode.x - apNode.x;
  const dy = clientNode.y - apNode.y;
  const distancePx = Math.round(Math.hypot(dx, dy));
  const enabled = apNode.wifiConfig?.enabled !== false;
  const inRange = enabled && distancePx <= radius;

  if (!enabled) {
    return {
      distancePx,
      coverageRadiusPx: radius,
      inRange: false,
      rssiDbm: -100,
      signalQualityPercent: 0,
      signalBars: 0,
    };
  }

  const ratio = distancePx / radius;
  const rssiDbm = inRange
    ? Math.round(-35 - ratio * 48) // -35 dBm at 0px down to -83 dBm at edge
    : Math.max(-98, Math.round(-85 - (ratio - 1) * 30));

  const signalQualityPercent = inRange
    ? Math.max(8, Math.min(100, Math.round((1 - ratio * 0.88) * 100)))
    : 0;

  let signalBars: 0 | 1 | 2 | 3 | 4 = 0;
  if (inRange) {
    if (rssiDbm >= -52) signalBars = 4;
    else if (rssiDbm >= -64) signalBars = 3;
    else if (rssiDbm >= -74) signalBars = 2;
    else signalBars = 1;
  }

  return {
    distancePx,
    coverageRadiusPx: radius,
    inRange,
    rssiDbm,
    signalQualityPercent,
    signalBars,
  };
}

/**
 * Finds the primary wireless client interface (Wlan0) on a client node.
 */
export function getClientWirelessInterface(
  clientNode: NetworkNode
): NetworkInterface | undefined {
  return (
    clientNode.interfaces.find((i) => i.isWireless) ||
    clientNode.interfaces.find((i) =>
      i.shortName.toLowerCase().startsWith('wlan')
    ) ||
    (isWirelessClientNode(clientNode) ? clientNode.interfaces[0] : undefined)
  );
}

/**
 * Finds or allocates an available wireless radio port on an AP or SOHO Router for associating a client.
 */
export function findAvailableApWirelessPort(
  apNode: NetworkNode,
  links: NetworkLink[],
  forClientNodeId?: string
): NetworkInterface | undefined {
  const wirelessPorts = apNode.interfaces.filter(
    (i) => i.isWireless || i.shortName.toLowerCase().startsWith('wlan')
  );
  if (wirelessPorts.length === 0) return undefined;

  // If this client is already connected to one of the wireless ports on this AP, reuse it
  if (forClientNodeId) {
    const existingLink = links.find(
      (l) =>
        l.cableType === 'wireless' &&
        ((l.sourceNodeId === apNode.id && l.targetNodeId === forClientNodeId) ||
          (l.targetNodeId === apNode.id && l.sourceNodeId === forClientNodeId))
    );
    if (existingLink) {
      const portId =
        existingLink.sourceNodeId === apNode.id
          ? existingLink.sourcePortId
          : existingLink.targetPortId;
      const found = wirelessPorts.find((p) => p.id === portId);
      if (found && found.adminStatus === 'up') return found;
    }
  }

  // On a SOHO Router (type === 'router'), Wlan0 is the shared L3 WLAN gateway interface
  if (apNode.type === 'router') {
    return wirelessPorts.find((p) => p.adminStatus === 'up') || wirelessPorts[0];
  }

  // On an L2 Access Point (type === 'switch'), pick an unoccupied Wlan0/k port
  const freePort = wirelessPorts.find((p) => {
    if (p.adminStatus !== 'up') return false;
    const occupied = links.some(
      (l) =>
        (l.sourceNodeId === apNode.id && l.sourcePortId === p.id) ||
        (l.targetNodeId === apNode.id && l.targetPortId === p.id)
    );
    return !occupied;
  });

  return freePort || wirelessPorts.find((p) => p.adminStatus === 'up');
}

/**
 * Scans all available 802.11 Wi-Fi networks in the topology from the perspective of a client node.
 */
export function scanAvailableWifiNetworks(
  clientNode: NetworkNode,
  allNodes: NetworkNode[],
  allLinks: NetworkLink[]
): ScannedWifiNetwork[] {
  const clientPort = getClientWirelessInterface(clientNode);
  const activeWirelessLink = allLinks.find(
    (l) =>
      l.cableType === 'wireless' &&
      (l.sourceNodeId === clientNode.id || l.targetNodeId === clientNode.id)
  );
  const connectedApId = activeWirelessLink
    ? activeWirelessLink.sourceNodeId === clientNode.id
      ? activeWirelessLink.targetNodeId
      : activeWirelessLink.sourceNodeId
    : undefined;

  const networks: ScannedWifiNetwork[] = [];

  for (const node of allNodes) {
    if (node.id === clientNode.id) continue;
    if (!node.wifiConfig || !node.wifiConfig.enabled) continue;

    const wlanPort = node.interfaces.find(
      (i) => i.isWireless || i.shortName.toLowerCase().startsWith('wlan')
    );
    if (wlanPort && wlanPort.adminStatus !== 'up') continue;

    const metrics = computeWifiSignalMetrics(clientNode, node);
    const isConnected =
      connectedApId === node.id &&
      clientPort?.adminStatus === 'up' &&
      metrics.inRange;

    networks.push({
      apNodeId: node.id,
      apName: node.name,
      bssidMac: wlanPort?.macAddress || node.interfaces[0]?.macAddress || '00:11:22:33:44:55',
      ssid: node.wifiConfig.ssid,
      channel: node.wifiConfig.channel,
      band: node.wifiConfig.band,
      security: node.wifiConfig.security,
      coverageRadius: node.wifiConfig.coverageRadius,
      distancePx: metrics.distancePx,
      inRange: metrics.inRange,
      rssiDbm: metrics.rssiDbm,
      signalQualityPercent: metrics.signalQualityPercent,
      signalBars: metrics.signalBars,
      isConnected,
      apMode: node.wifiConfig.apMode || 'autonomous',
      wlcControllerName: node.wifiConfig.wlcControllerName,
    });
  }

  return networks.sort((a, b) => {
    if (a.isConnected !== b.isConnected) return a.isConnected ? -1 : 1;
    if (a.inRange !== b.inRange) return a.inRange ? -1 : 1;
    return b.rssiDbm - a.rssiDbm;
  });
}

/**
 * Finds the shortest operational wired path of links between two nodes (e.g. Lightweight AP <-> WLC).
 */
export function findWiredPathBetweenNodes(
  startNodeId: string,
  targetNodeId: string,
  nodes: NetworkNode[],
  links: NetworkLink[]
): {
  fromNode: NetworkNode;
  toNode: NetworkNode;
  link: NetworkLink;
  fromPort: NetworkInterface;
  toPort: NetworkInterface;
}[] | null {
  if (startNodeId === targetNodeId) return [];
  const nodeMap = new Map<string, NetworkNode>();
  for (const n of nodes) nodeMap.set(n.id, n);

  const visited = new Set<string>([startNodeId]);
  const queue: {
    currId: string;
    hops: {
      fromNode: NetworkNode;
      toNode: NetworkNode;
      link: NetworkLink;
      fromPort: NetworkInterface;
      toPort: NetworkInterface;
    }[];
  }[] = [{ currId: startNodeId, hops: [] }];

  while (queue.length > 0) {
    const { currId, hops } = queue.shift()!;
    const currNode = nodeMap.get(currId);
    if (!currNode) continue;

    for (const link of links) {
      if (link.cableType === 'wireless') continue;
      const isSrc = link.sourceNodeId === currId;
      const isDst = link.targetNodeId === currId;
      if (!isSrc && !isDst) continue;

      const peerId = isSrc ? link.targetNodeId : link.sourceNodeId;
      if (visited.has(peerId)) continue;

      const peerNode = nodeMap.get(peerId);
      if (!peerNode) continue;

      const fromPortId = isSrc ? link.sourcePortId : link.targetPortId;
      const toPortId = isSrc ? link.targetPortId : link.sourcePortId;
      const fromPort = currNode.interfaces.find((p) => p.id === fromPortId);
      const toPort = peerNode.interfaces.find((p) => p.id === toPortId);
      if (!fromPort || !toPort || fromPort.adminStatus !== 'up' || toPort.adminStatus !== 'up') {
        continue;
      }

      const nextHops = [
        ...hops,
        { fromNode: currNode, toNode: peerNode, link, fromPort, toPort },
      ];
      if (peerId === targetNodeId) {
        return nextHops;
      }
      visited.add(peerId);
      queue.push({ currId: peerId, hops: nextHops });
    }
  }

  return null;
}

/**
 * Synchronizes all Lightweight APs (LAPs) with their Wireless LAN Controller (WLC) via CAPWAP:
 * - Performs CAPWAP Discovery & Join over wired L2/L3 links (UDP 5246/5247)
 * - Centrally pushes the WLC's active WLAN Profile (SSID, WPA2-PSK, VLAN mapping, Band, Coverage Radius)
 * - Runs RRM Dynamic Channel Assignment (DCA) across joined Lightweight APs (Channels 1, 6, 11 or 36, 44, 149)
 */
export function syncWlcCapwapController(
  nodes: NetworkNode[],
  links: NetworkLink[]
): {
  nodes: NetworkNode[];
  capwapEvents: string[];
} {
  const capwapEvents: string[] = [];
  const activeWlcs = nodes.filter(
    (n) => isWlcControllerNode(n) && n.wlcConfig && n.wlcConfig.enabled !== false
  );

  // Track how many Lightweight APs have joined each WLC for RRM non-overlapping channel allocation
  const wlcApCounter = new Map<string, number>();

  const nextNodes = nodes.map((node) => {
    if (!node.wifiConfig) return node;

    const mode = node.wifiConfig.apMode || 'autonomous';
    if (mode !== 'lightweight') {
      if (node.wifiConfig.capwapStatus && node.wifiConfig.capwapStatus !== 'standalone') {
        return {
          ...node,
          wifiConfig: {
            ...node.wifiConfig,
            capwapStatus: 'standalone' as const,
          },
        };
      }
      return node;
    }

    // Find target WLC (explicitly configured wlcNodeId if reachable, or first reachable WLC)
    let matchedWlc: NetworkNode | undefined;
    if (node.wifiConfig.wlcNodeId) {
      const candidate = activeWlcs.find((w) => w.id === node.wifiConfig?.wlcNodeId);
      if (candidate && findWiredPathBetweenNodes(node.id, candidate.id, nodes, links)) {
        matchedWlc = candidate;
      }
    }
    if (!matchedWlc) {
      matchedWlc = activeWlcs.find((w) =>
        Boolean(findWiredPathBetweenNodes(node.id, w.id, nodes, links))
      );
    }

    if (!matchedWlc || !matchedWlc.wlcConfig) {
      if (node.wifiConfig.capwapStatus !== 'discovery') {
        capwapEvents.push(
          `CAPWAP Discovery: ${node.name} ищет контроллер WLC (UDP 5246)...`
        );
      }
      return {
        ...node,
        wifiConfig: {
          ...node.wifiConfig,
          capwapStatus: 'discovery' as const,
        },
      };
    }

    const wlcCfg = matchedWlc.wlcConfig;
    const enabledProfiles = (wlcCfg.wlanProfiles || []).filter((p) => p.enabled);
    const activeProfile: WlanProfile | undefined =
      enabledProfiles.find((p) => p.id === node.wifiConfig?.wlanProfileId) ||
      enabledProfiles[0] ||
      wlcCfg.wlanProfiles?.[0];

    const apIdx = wlcApCounter.get(matchedWlc.id) || 0;
    wlcApCounter.set(matchedWlc.id, apIdx + 1);

    const targetBand = activeProfile?.band || node.wifiConfig.band || '2.4GHz';
    const channels24 = [1, 6, 11];
    const channels5 = [36, 44, 149];
    const rrmChannel = wlcCfg.rfAutoChannel
      ? targetBand === '5GHz'
        ? channels5[apIdx % channels5.length]
        : channels24[apIdx % channels24.length]
      : node.wifiConfig.channel;

    const nextWifiConfig: WifiApConfig = {
      ...node.wifiConfig,
      enabled: activeProfile ? activeProfile.enabled : node.wifiConfig.enabled,
      ssid: activeProfile ? activeProfile.ssid : node.wifiConfig.ssid,
      security: activeProfile ? activeProfile.security : node.wifiConfig.security,
      password:
        activeProfile?.security === 'wpa2'
          ? activeProfile.password || 'cisco123'
          : '',
      band: targetBand,
      channel: rrmChannel,
      bridgeVlan: activeProfile ? activeProfile.vlanId : node.wifiConfig.bridgeVlan || 1,
      coverageRadius:
        wlcCfg.defaultCoverageRadius || node.wifiConfig.coverageRadius || 240,
      apMode: 'lightweight',
      wlcNodeId: matchedWlc.id,
      wlcControllerName: matchedWlc.name,
      wlcManagementIp:
        wlcCfg.managementIp ||
        matchedWlc.interfaces.find((i) => i.ipAddress)?.ipAddress ||
        '192.168.10.5',
      capwapStatus: 'joined',
      wlanProfileId: activeProfile?.id,
    };

    const wasJoined =
      node.wifiConfig.capwapStatus === 'joined' &&
      node.wifiConfig.wlcNodeId === matchedWlc.id &&
      node.wifiConfig.ssid === nextWifiConfig.ssid &&
      node.wifiConfig.channel === nextWifiConfig.channel &&
      node.wifiConfig.bridgeVlan === nextWifiConfig.bridgeVlan;

    if (!wasJoined) {
      capwapEvents.push(
        `CAPWAP Tunnel UP: ${node.name} подключена к контроллеру ${matchedWlc.name} (${nextWifiConfig.wlcManagementIp}:5246) → SSID «${nextWifiConfig.ssid}» (VLAN ${nextWifiConfig.bridgeVlan}, Ch ${nextWifiConfig.channel})`
      );
    }

    const targetVlan = nextWifiConfig.bridgeVlan || 1;
    const updatedInterfaces = node.interfaces.map((iface) => {
      if (iface.isWireless) {
        return { ...iface, accessVlan: targetVlan };
      }
      // Ensure uplink port allows the WLAN VLAN
      if (iface.vlanMode === 'trunk') {
        const nextAllowed = iface.trunkAllowedVlans.includes(targetVlan)
          ? iface.trunkAllowedVlans
          : [...iface.trunkAllowedVlans, targetVlan].sort((a, b) => a - b);
        return { ...iface, trunkAllowedVlans: nextAllowed };
      }
      return iface;
    });

    return {
      ...node,
      wifiConfig: nextWifiConfig,
      interfaces: updatedInterfaces,
    };
  });

  return { nodes: nextNodes, capwapEvents };
}

/**
 * Generates realistic CAPWAP Control (UDP 5246 Discovery/Join/Config Push) and
 * CAPWAP Data (UDP 5247 Keepalive/Encapsulated 802.11) simulation steps between Lightweight APs and WLC.
 */
export function synthesizeCapwapTunnelSteps(
  nodes: NetworkNode[],
  links: NetworkLink[],
  startStepNumber: number = 1,
  startTimestampMs: number = 0
): SimulationStep[] {
  const steps: SimulationStep[] = [];
  let stepCounter = startStepNumber;
  let timestamp = startTimestampMs;

  const synced = syncWlcCapwapController(nodes, links).nodes;
  const lightweightAps = synced.filter(
    (n) => isLightweightApNode(n) && n.wifiConfig?.wlcNodeId
  );

  for (const lap of lightweightAps) {
    const wlc = synced.find((n) => n.id === lap.wifiConfig?.wlcNodeId);
    if (!wlc || !wlc.wlcConfig) continue;

    const pathToWlc = findWiredPathBetweenNodes(lap.id, wlc.id, synced, links);
    const pathFromWlc = findWiredPathBetweenNodes(wlc.id, lap.id, synced, links);
    if (!pathToWlc || !pathFromWlc || pathToWlc.length === 0) continue;

    const lapUplink = pathToWlc[0].fromPort;
    const wlcPort = pathToWlc[pathToWlc.length - 1].toPort;
    const wlcIp =
      wlc.wlcConfig.managementIp || wlcPort.ipAddress || '192.168.10.5';
    const lapIp =
      lapUplink.ipAddress ||
      `192.168.${lap.wifiConfig?.bridgeVlan || 10}.${10 + (stepCounter % 30)}`;
    const ssid = lap.wifiConfig?.ssid || 'Corp-Enterprise';
    const vlanId = lap.wifiConfig?.bridgeVlan || 10;
    const channel = lap.wifiConfig?.channel || 1;

    // 1. CAPWAP Discovery & Join Request (LAP -> WLC, UDP 5246)
    for (const hop of pathToWlc) {
      const pdu = {
        l1: {
          inPort: hop.fromPort.shortName,
          outPort: hop.toPort.shortName,
          cableType: hop.link.cableType,
          physicalStatus: '1000BASE-T Full-Duplex (PoE+)',
        },
        l2: {
          headerType: 'IEEE 802.1Q' as const,
          srcMac: hop.fromPort.macAddress,
          dstMac: hop.toPort.macAddress,
          etherType: '0x0800 (IPv4)' as const,
          vlanTag: vlanId,
        },
        l3: {
          headerType: 'IPv4' as const,
          srcIp: lapIp,
          dstIp: wlcIp,
          ttl: 64,
          protocol: 'UDP (17)',
        },
        l4: {
          type: 'CAPWAP_CONTROL' as const,
          summary: `CAPWAP Control Join Request (UDP 5246) · ${lap.name} → ${wlc.name}`,
          seqNumber: stepCounter,
          srcPort: 5246,
          dstPort: 5246,
        },
        l7: {
          appProtocol: 'CAPWAP' as const,
          headline: `RFC 5415 CAPWAP Join Request (${lap.name} → ${wlc.name})`,
          fields: {
            'CAPWAP UDP Port': '5246 (Control Plane DTLS)',
            'Lightweight AP': `${lap.name} (${lapUplink.macAddress})`,
            'Target WLC': `${wlc.name} (${wlcIp})`,
            'Radio Band / RRM': `${lap.wifiConfig?.band || '2.4GHz'} · Channel ${channel}`,
          },
        },
      };

      steps.push({
        id: `capwap-join-req-${stepCounter}-${hop.fromNode.id}-${hop.toNode.id}`,
        stepIndex: stepCounter++,
        timestampMs: timestamp,
        fromNodeId: hop.fromNode.id,
        fromNodeName: hop.fromNode.name,
        fromPortName: hop.fromPort.shortName,
        toNodeId: hop.toNode.id,
        toNodeName: hop.toNode.name,
        toPortName: hop.toPort.shortName,
        linkId: hop.link.id,
        protocol: 'CAPWAP_CONTROL',
        status: hop.toNode.id === wlc.id ? 'delivered' : 'forwarded',
        vlanTag: vlanId,
        inboundPdu: pdu,
        outboundPdu: pdu,
        decisionTitle:
          hop.toNode.id === wlc.id
            ? `${wlc.name}: принят CAPWAP Join Request (UDP 5246) от легкой точки доступа ${lap.name} — регистрация в таблице AP`
            : `${hop.toNode.name}: коммутация пакета CAPWAP Control (UDP 5246) от ${lap.name} к контроллеру ${wlc.name}`,
        osiActions: [
          {
            layer: 'L4',
            title: 'CAPWAP Control Tunnel (UDP 5246)',
            detail: `Легкая точка доступа ${lap.name} устанавливает защищённый управляющий туннель DTLS/CAPWAP с контроллером ${wlc.name} (${wlcIp}).`,
          },
          {
            layer: 'L7',
            title: 'Запрос централизованного профиля WLAN',
            detail: `Передача телеметрии радиоэфира 802.11 и запрос конфигурации SSID/VLAN/RRM.`,
          },
        ],
        nodeSnapshotAfter: {
          arpTable: [...hop.toNode.arpTable],
          macTable: [...hop.toNode.macTable],
        },
      });
      timestamp += 4;
    }

    // 2. CAPWAP Join Response & WLAN Config Push (WLC -> LAP, UDP 5246) + Data Keepalive (UDP 5247)
    for (const hop of pathFromWlc) {
      const isFinalHop = hop.toNode.id === lap.id;
      const proto = isFinalHop ? ('CAPWAP_DATA' as const) : ('CAPWAP_CONTROL' as const);
      const udpPort = proto === 'CAPWAP_DATA' ? 5247 : 5246;
      const pdu = {
        l1: {
          inPort: hop.fromPort.shortName,
          outPort: hop.toPort.shortName,
          cableType: hop.link.cableType,
          physicalStatus: '1000BASE-T Full-Duplex',
        },
        l2: {
          headerType: 'IEEE 802.1Q' as const,
          srcMac: hop.fromPort.macAddress,
          dstMac: hop.toPort.macAddress,
          etherType: '0x0800 (IPv4)' as const,
          vlanTag: vlanId,
        },
        l3: {
          headerType: 'IPv4' as const,
          srcIp: wlcIp,
          dstIp: lapIp,
          ttl: 64,
          protocol: 'UDP (17)',
        },
        l4: {
          type: proto,
          summary: `CAPWAP Config Push & Tunnel Active (UDP ${udpPort}) → SSID «${ssid}» VLAN ${vlanId} Ch ${channel}`,
          seqNumber: stepCounter,
          srcPort: udpPort,
          dstPort: udpPort,
        },
        l7: {
          appProtocol: 'CAPWAP' as const,
          headline: `WLC Config Push: SSID «${ssid}» (VLAN ${vlanId}, Ch ${channel}) → ${lap.name}`,
          fields: {
            'CAPWAP Tunnel': `JOINED (UDP ${udpPort})`,
            'Pushed WLAN SSID': ssid,
            'Mapped 802.1Q VLAN': `VLAN ${vlanId}`,
            'RRM Assigned Channel': `Channel ${channel} (${lap.wifiConfig?.band || '2.4GHz'})`,
            'Security Policy':
              lap.wifiConfig?.security === 'wpa2' ? 'WPA2-PSK (AES-CCMP)' : 'Open',
          },
        },
      };

      steps.push({
        id: `capwap-cfg-push-${stepCounter}-${hop.fromNode.id}-${hop.toNode.id}`,
        stepIndex: stepCounter++,
        timestampMs: timestamp,
        fromNodeId: hop.fromNode.id,
        fromNodeName: hop.fromNode.name,
        fromPortName: hop.fromPort.shortName,
        toNodeId: hop.toNode.id,
        toNodeName: hop.toNode.name,
        toPortName: hop.toPort.shortName,
        linkId: hop.link.id,
        protocol: proto,
        status: isFinalHop ? 'delivered' : 'forwarded',
        vlanTag: vlanId,
        inboundPdu: pdu,
        outboundPdu: pdu,
        decisionTitle: isFinalHop
          ? `${lap.name}: применён профиль от ${wlc.name} — SSID «${ssid}», VLAN ${vlanId}, RRM Канал ${channel} (CAPWAP JOINED)`
          : `${hop.toNode.name}: доставка конфигурации CAPWAP от ${wlc.name} на легкую точку ${lap.name}`,
        osiActions: [
          {
            layer: 'L4',
            title: `CAPWAP Tunnel (UDP ${udpPort})`,
            detail: `Контроллер ${wlc.name} централизованно загружает параметры радиоинтерфейса на ${lap.name}.`,
          },
          {
            layer: 'L7',
            title: `Активация WLAN «${ssid}» (VLAN ${vlanId})`,
            detail: `Точка доступа ${lap.name} вещает SSID «${ssid}» на канале ${channel} и туннелирует трафик клиентов в VLAN ${vlanId}.`,
          },
        ],
        nodeSnapshotAfter: {
          arpTable: [...hop.toNode.arpTable],
          macTable: [...hop.toNode.macTable],
        },
      });
      timestamp += 4;
    }
  }

  return steps;
}

/**
 * Checks if a client's security credentials match an AP's Wi-Fi configuration.
 */
export function verifyWifiCredentials(
  apConfig: WifiApConfig,
  passphrase?: string
): { valid: boolean; reason?: string } {
  if (!apConfig.enabled) {
    return {
      valid: false,
      reason: 'Радиомодуль 802.11 на точке доступа выключен.',
    };
  }
  if (apConfig.security === 'open') {
    return { valid: true };
  }
  const expected = apConfig.password || '';
  const provided = passphrase ?? '';
  if (provided !== expected) {
    return {
      valid: false,
      reason:
        'Ошибка аутентификации 802.11i WPA2-PSK: неверный ключ безопасности (4-Way Handshake Failed).',
    };
  }
  return { valid: true };
}

/**
 * Manually associates a wireless client to a target AP or SOHO Wi-Fi Router.
 */
export function connectWirelessClientToAp(
  nodes: NetworkNode[],
  links: NetworkLink[],
  clientNodeId: string,
  apNodeId: string,
  passphrase?: string
): {
  ok: boolean;
  error?: string;
  nodes: NetworkNode[];
  links: NetworkLink[];
  rssiDbm?: number;
  summaryMessage: string;
} {
  const clientNode = nodes.find((n) => n.id === clientNodeId);
  const apNode = nodes.find((n) => n.id === apNodeId);

  if (!clientNode || !apNode || !apNode.wifiConfig) {
    return {
      ok: false,
      error: 'Точка доступа или беспроводной клиент не найдены.',
      nodes,
      links,
      summaryMessage: 'Ошибка подключения Wi-Fi.',
    };
  }

  const metrics = computeWifiSignalMetrics(clientNode, apNode);
  if (!metrics.inRange) {
    return {
      ok: false,
      error: `Клиент ${clientNode.name} находится вне зоны радиопокрытия ${apNode.name} (${metrics.distancePx} пкс > радиус ${metrics.coverageRadiusPx} пкс). Переместите устройство ближе к точке доступа.`,
      nodes,
      links,
      summaryMessage: `Не удалось подключиться к SSID «${apNode.wifiConfig.ssid}»: вне зоны покрытия.`,
    };
  }

  const auth = verifyWifiCredentials(apNode.wifiConfig, passphrase);
  if (!auth.valid) {
    return {
      ok: false,
      error: auth.reason,
      nodes,
      links,
      summaryMessage: auth.reason || 'Ошибка WPA2-PSK.',
    };
  }

  // Ensure client has an active wireless interface
  let updatedNodes = nodes.map((n) => {
    if (n.id !== clientNode.id) return n;
    const hasWlan = n.interfaces.some((i) => i.isWireless);
    const nextInterfaces = hasWlan
      ? n.interfaces.map((i) =>
          i.isWireless ? { ...i, adminStatus: 'up' as const } : i
        )
      : n.interfaces.map((i, idx) =>
          idx === 0
            ? {
                ...i,
                name: 'Wireless LAN 802.11',
                shortName: 'Wlan0',
                isWireless: true,
                adminStatus: 'up' as const,
                bandwidthMbps: 300,
              }
            : i
        );
    return {
      ...n,
      wifiClientConfig: {
        enabled: true,
        connectedSsid: apNode.wifiConfig!.ssid,
        connectedApNodeId: apNode.id,
        security: apNode.wifiConfig!.security,
        passphrase:
          apNode.wifiConfig!.security === 'wpa2'
            ? passphrase ?? apNode.wifiConfig!.password
            : '',
        autoRoaming: n.wifiClientConfig?.autoRoaming ?? true,
      },
      interfaces: nextInterfaces,
    };
  });

  const updatedClient = updatedNodes.find((n) => n.id === clientNode.id)!;
  const clientPort = getClientWirelessInterface(updatedClient);
  if (!clientPort) {
    return {
      ok: false,
      error: 'На клиенте отсутствует беспроводной адаптер Wlan0.',
      nodes,
      links,
      summaryMessage: 'Отсутствует адаптер Wlan0.',
    };
  }

  // Remove any existing links on clientPort
  const filteredLinks = links.filter(
    (l) =>
      !(
        (l.sourceNodeId === clientNode.id && l.sourcePortId === clientPort.id) ||
        (l.targetNodeId === clientNode.id && l.targetPortId === clientPort.id) ||
        (l.cableType === 'wireless' &&
          (l.sourceNodeId === clientNode.id || l.targetNodeId === clientNode.id))
      )
  );

  // Find or create a wireless port on the AP
  let targetApNode = updatedNodes.find((n) => n.id === apNode.id)!;
  let apPort = findAvailableApWirelessPort(targetApNode, filteredLinks, clientNode.id);

  if (!apPort && targetApNode.type === 'switch') {
    const newSlotNum =
      targetApNode.interfaces.filter((i) => i.isWireless).length + 1;
    const newPort: NetworkInterface = {
      id: `${targetApNode.id}-wlan0/${newSlotNum}`,
      name: `Dot11Radio0/${newSlotNum}`,
      shortName: `Wlan0/${newSlotNum}`,
      macAddress: generateMacAddress(90, newSlotNum),
      ipAddress: '',
      subnetMask: '',
      adminStatus: 'up',
      vlanMode: 'access',
      accessVlan: targetApNode.wifiConfig?.bridgeVlan || 1,
      trunkAllowedVlans: [1, 10, 20, 30],
      isWireless: true,
      bandwidthMbps: 300,
    };
    targetApNode = {
      ...targetApNode,
      interfaces: [...targetApNode.interfaces, newPort],
    };
    updatedNodes = updatedNodes.map((n) =>
      n.id === targetApNode.id ? targetApNode : n
    );
    apPort = newPort;
  }

  if (!apPort) {
    return {
      ok: false,
      error: 'На точке доступа нет доступных радиопортов Wlan0.',
      nodes,
      links,
      summaryMessage: 'Нет свободных радиопортов на точке доступа.',
    };
  }

  const newWirelessLink: NetworkLink = {
    id: `wifi-link-${clientNode.id}-${apNode.id}`,
    sourceNodeId: clientNode.id,
    sourcePortId: clientPort.id,
    targetNodeId: apNode.id,
    targetPortId: apPort.id,
    cableType: 'wireless',
  };

  return {
    ok: true,
    nodes: updatedNodes,
    links: [...filteredLinks, newWirelessLink],
    rssiDbm: metrics.rssiDbm,
    summaryMessage: `Wi-Fi 802.11: ${clientNode.name} подключён к SSID «${apNode.wifiConfig.ssid}» через ${apNode.name} (сигнал ${metrics.rssiDbm} dBm, ${
      apNode.wifiConfig.security === 'wpa2' ? 'WPA2-PSK' : 'Open'
    }).`,
  };
}

/**
 * Disconnects a wireless client from its current Wi-Fi network.
 */
export function disconnectWirelessClient(
  nodes: NetworkNode[],
  links: NetworkLink[],
  clientNodeId: string
): { nodes: NetworkNode[]; links: NetworkLink[]; summaryMessage: string } {
  const clientNode = nodes.find((n) => n.id === clientNodeId);
  const nextLinks = links.filter(
    (l) =>
      !(
        l.cableType === 'wireless' &&
        (l.sourceNodeId === clientNodeId || l.targetNodeId === clientNodeId)
      )
  );
  const nextNodes = nodes.map((n) => {
    if (n.id !== clientNodeId || !n.wifiClientConfig) return n;
    return {
      ...n,
      wifiClientConfig: {
        ...n.wifiClientConfig,
        connectedSsid: undefined,
        connectedApNodeId: undefined,
      },
    };
  });
  return {
    nodes: nextNodes,
    links: nextLinks,
    summaryMessage: `Клиент ${clientNode?.name || clientNodeId} отключён от беспроводной сети Wi-Fi.`,
  };
}

/**
 * Synchronizes all WLC CAPWAP Lightweight AP tunnels, wireless associations, and performs automatic 802.11 ESS roaming
 * when nodes are dragged on the canvas or WLC / AP settings (radius, SSID, security, channel) change.
 */
export function syncWirelessAssociations(
  nodes: NetworkNode[],
  links: NetworkLink[]
): {
  nodes: NetworkNode[];
  links: NetworkLink[];
  roamingEvents: string[];
} {
  // 0. First synchronize Lightweight APs (LAPs) with any active Wireless LAN Controller (WLC) via CAPWAP
  const capwapSynced = syncWlcCapwapController(nodes, links);
  const roamingEvents: string[] = [...capwapSynced.capwapEvents];

  // 1. Sync AP bridgeVlan onto AP wireless ports
  let nextNodes = capwapSynced.nodes.map((node) => {
    if (node.type === 'switch' && node.wifiConfig?.bridgeVlan) {
      const targetVlan = node.wifiConfig.bridgeVlan;
      const needsUpdate = node.interfaces.some(
        (i) => i.isWireless && i.accessVlan !== targetVlan
      );
      if (needsUpdate) {
        return {
          ...node,
          interfaces: node.interfaces.map((i) =>
            i.isWireless ? { ...i, accessVlan: targetVlan } : i
          ),
        };
      }
    }
    return node;
  });

  // 2. Validate existing wireless links (remove if out-of-range, radio disabled, or SSID/security mismatch)
  let nextLinks = links.filter((link) => {
    if (link.cableType !== 'wireless') return true;

    const nodeA = nextNodes.find((n) => n.id === link.sourceNodeId);
    const nodeB = nextNodes.find((n) => n.id === link.targetNodeId);
    if (!nodeA || !nodeB) return false;

    const portA = nodeA.interfaces.find((p) => p.id === link.sourcePortId);
    const portB = nodeB.interfaces.find((p) => p.id === link.targetPortId);
    if (!portA || !portB || portA.adminStatus !== 'up' || portB.adminStatus !== 'up') {
      return false;
    }

    const apNode = isWifiAccessPointNode(nodeA) ? nodeA : isWifiAccessPointNode(nodeB) ? nodeB : null;
    const clientNode = apNode?.id === nodeA.id ? nodeB : nodeA;
    if (!apNode || !apNode.wifiConfig || !apNode.wifiConfig.enabled) {
      return false;
    }
    if (clientNode.wifiClientConfig && !clientNode.wifiClientConfig.enabled) {
      return false;
    }

    const metrics = computeWifiSignalMetrics(clientNode, apNode);
    if (!metrics.inRange) {
      roamingEvents.push(
        `${clientNode.name} покинул зону покрытия ${apNode.name} (${metrics.distancePx} пкс > ${metrics.coverageRadiusPx} пкс)`
      );
      return false;
    }

    if (clientNode.wifiClientConfig?.connectedSsid) {
      if (clientNode.wifiClientConfig.connectedSsid !== apNode.wifiConfig.ssid) {
        return false;
      }
      const auth = verifyWifiCredentials(
        apNode.wifiConfig,
        clientNode.wifiClientConfig.passphrase
      );
      if (!auth.valid) {
        return false;
      }
    }

    return true;
  });

  // 3. Check wireless clients for Auto-Association & Seamless ESS Roaming (same SSID)
  for (const client of nextNodes) {
    if (!isWirelessClientNode(client)) continue;
    const clientCfg = client.wifiClientConfig;
    if (!clientCfg || !clientCfg.enabled || !clientCfg.connectedSsid) continue;

    const clientPort = getClientWirelessInterface(client);
    if (!clientPort || clientPort.adminStatus !== 'up') continue;

    // Skip if client has a wired cable attached to its wireless port
    const currentWirelessLink = nextLinks.find(
      (l) =>
        l.cableType === 'wireless' &&
        (l.sourceNodeId === client.id || l.targetNodeId === client.id)
    );

    const currentApId = currentWirelessLink
      ? currentWirelessLink.sourceNodeId === client.id
        ? currentWirelessLink.targetNodeId
        : currentWirelessLink.sourceNodeId
      : undefined;
    const currentAp = currentApId
      ? nextNodes.find((n) => n.id === currentApId)
      : undefined;
    const currentMetrics =
      currentAp && currentAp.wifiConfig
        ? computeWifiSignalMetrics(client, currentAp)
        : null;

    // Find all in-range APs broadcasting the client's target SSID with valid credentials
    const candidateAps = nextNodes
      .filter((ap) => {
        if (ap.id === client.id || !ap.wifiConfig || !ap.wifiConfig.enabled) return false;
        if (ap.wifiConfig.ssid !== clientCfg.connectedSsid) return false;
        const wlanPort = ap.interfaces.find(
          (i) => i.isWireless || i.shortName.toLowerCase().startsWith('wlan')
        );
        if (wlanPort && wlanPort.adminStatus !== 'up') return false;
        const auth = verifyWifiCredentials(ap.wifiConfig, clientCfg.passphrase);
        if (!auth.valid) return false;
        const m = computeWifiSignalMetrics(client, ap);
        return m.inRange;
      })
      .map((ap) => ({
        ap,
        metrics: computeWifiSignalMetrics(client, ap),
      }))
      .sort((a, b) => b.metrics.rssiDbm - a.metrics.rssiDbm);

    if (candidateAps.length === 0) continue;

    const bestCandidate = candidateAps[0];

    // Connect if currently disconnected, OR roam if autoRoaming is enabled and new AP is >= 6 dBm stronger
    const shouldConnectOrRoam =
      !currentWirelessLink ||
      (clientCfg.autoRoaming !== false &&
        bestCandidate.ap.id !== currentApId &&
        (!currentMetrics ||
          !currentMetrics.inRange ||
          bestCandidate.metrics.rssiDbm >= currentMetrics.rssiDbm + 6));

    if (shouldConnectOrRoam) {
      const prevApName = currentAp?.name;
      const assoc = connectWirelessClientToAp(
        nextNodes,
        nextLinks,
        client.id,
        bestCandidate.ap.id,
        clientCfg.passphrase
      );
      if (assoc.ok) {
        nextNodes = assoc.nodes;
        nextLinks = assoc.links;
        if (prevApName && prevApName !== bestCandidate.ap.name) {
          roamingEvents.push(
            `Роуминг 802.11 (SSID «${clientCfg.connectedSsid}»): ${client.name} переключился с ${prevApName} на ${bestCandidate.ap.name} (${bestCandidate.metrics.rssiDbm} dBm)`
          );
        } else if (!prevApName) {
          roamingEvents.push(
            `Wi-Fi 802.11: ${client.name} автоматически подключился к ${bestCandidate.ap.name} (SSID «${clientCfg.connectedSsid}», ${bestCandidate.metrics.rssiDbm} dBm)`
          );
        }
      }
    }
  }

  return {
    nodes: nextNodes,
    links: nextLinks,
    roamingEvents,
  };
}
