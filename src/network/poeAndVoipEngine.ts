import {
  IpCameraConfig,
  NetworkInterface,
  NetworkLink,
  NetworkNode,
  SimulationStep,
  SipExtensionEntry,
  SwitchPoeConfig,
  VoipCallLogEntry,
  VoipPhoneConfig,
} from './types';
import { isValidIpv4 } from './ipMath';

export interface SwitchPortPoeStatus {
  portId: string;
  portShortName: string;
  adminMode: 'auto' | 'never';
  operStatus: 'delivering' | 'searching' | 'off' | 'fault_overload';
  allocatedWatts: number;
  maxPortWatts: number;
  poeClass: string;
  pdNodeId?: string;
  pdNodeName?: string;
  pdDeviceTypeLabel?: string;
  voiceVlan?: number;
  accessVlan: number;
}

export interface SwitchPoeSummary {
  enabled: boolean;
  standard: '802.3af PoE (15.4W/port)' | '802.3at PoE+ (30W/port)';
  totalBudgetWatts: number;
  usedWatts: number;
  remainingWatts: number;
  utilizationPercent: number;
  poweredDevicesCount: number;
  overloadedPortsCount: number;
  ports: Record<string, SwitchPortPoeStatus>;
  portList: SwitchPortPoeStatus[];
}

export interface PoweredDeviceState {
  isPoweredDevice: boolean;
  isPowered: boolean;
  powerSource: 'PoE 802.3af/at' | 'AC Adapter 48V' | 'OFF (No PoE)' | 'FAULT (PoE Budget Overload)' | 'Builtin PSU';
  watts: number;
  poeClassLabel: string;
  switchNodeId?: string;
  switchNodeName?: string;
  switchPortShortName?: string;
  reason?: string;
}

export function isVoipPhoneNode(node: NetworkNode): boolean {
  return node.deviceModel === 'ip_phone' || Boolean(node.voipConfig?.enabled);
}

export function isIpCameraNode(node: NetworkNode): boolean {
  return node.deviceModel === 'ip_camera' || Boolean(node.ipCameraConfig?.enabled);
}

export function isNvrServerNode(node: NetworkNode): boolean {
  return (
    node.deviceModel === 'nvr' ||
    (node.type === 'server' && Boolean(node.services?.nvrEnabled))
  );
}

export function isPoweredDeviceNode(node: NetworkNode): boolean {
  return (
    node.deviceModel === 'ip_phone' ||
    Boolean(node.voipConfig?.enabled) ||
    node.deviceModel === 'ip_camera' ||
    Boolean(node.ipCameraConfig?.enabled) ||
    node.deviceModel === 'wifi_ap'
  );
}

export function getDefaultSwitchPoeConfig(): SwitchPoeConfig {
  return {
    enabled: true,
    standard: '802.3at PoE+ (30W/port)',
    totalBudgetWatts: 370,
  };
}

export function getDefaultVoipPhoneConfig(index: number = 1): VoipPhoneConfig {
  const ext = String(100 + index);
  return {
    enabled: true,
    extension: ext,
    displayName: `Cisco IP Phone ${ext}`,
    sipServerIp: '192.168.20.100',
    voiceVlan: 20,
    dataVlan: 10,
    codec: 'G.711u (64 kbps)',
    dscpMark: 'EF (46)',
    poeClassWatts: 7.0,
    acAdapterConnected: false,
    callStatus: 'idle',
    callHistory: [],
  };
}

export function getDefaultIpCameraConfig(index: number = 1): IpCameraConfig {
  const ch = Math.max(1, index);
  const label =
    ch === 1
      ? 'CAM-01 Главный въезд (КПП)'
      : ch === 2
      ? 'CAM-02 Серверная ЦОД'
      : `CAM-${String(ch).padStart(2, '0')} Зона контроля #${ch}`;
  const defaultIp = `192.168.30.${10 + ch}`;
  const streamUrl = `rtsp://${defaultIp}:554/live/ch${String(ch).padStart(2, '0')}`;
  return {
    enabled: true,
    channelNumber: ch,
    locationName: label,
    cameraName: label,
    streamUrl,
    nvrServerIp: '192.168.30.100',
    nvrTargetIp: '192.168.30.100',
    surveillanceVlan: 30,
    streamMode: 'unicast',
    multicastGroupIp: `239.0.30.${ch}`,
    rtspPort: 554,
    rtpVideoPort: 5004,
    videoCodec: 'H.265 (HEVC)',
    codec: 'H.265 (HEVC)',
    resolution: '4K (3840×2160)',
    fps: 30,
    bitrateKbps: 6144,
    dscpMark: 'AF41 (34)',
    poeClassWatts: 9.5,
    poeRequiredWatts: 9.5,
    poePowered: true,
    acAdapterConnected: false,
    motionDetection: true,
    irNightVision: true,
    status: 'streaming',
    lastStreamStatus: 'idle',
  };
}

export function getDeviceRequiredPoeWatts(node: NetworkNode): {
  watts: number;
  poeClass: string;
  deviceLabel: string;
} {
  if (isVoipPhoneNode(node)) {
    const w = node.voipConfig?.poeClassWatts ?? 7.0;
    return {
      watts: w,
      poeClass: 'Class 2 (802.3af)',
      deviceLabel: 'Cisco IP Phone 7960',
    };
  }
  if (isIpCameraNode(node)) {
    const w =
      node.ipCameraConfig?.poeClassWatts ??
      node.ipCameraConfig?.poeRequiredWatts ??
      9.5;
    return {
      watts: w,
      poeClass: 'Class 3 (802.3af/at)',
      deviceLabel: 'PoE IP Camera 4K (RTSP)',
    };
  }
  if (node.deviceModel === 'wifi_ap') {
    return {
      watts: 15.4,
      poeClass: 'Class 3 (802.3af/at)',
      deviceLabel: 'Cisco Aironet AP',
    };
  }
  return {
    watts: 0,
    poeClass: 'N/A',
    deviceLabel: node.name,
  };
}

/**
 * Computes IEEE 802.3af/at Power over Ethernet (PoE) allocation across all ports of a switch.
 */
export function computeSwitchPoeStatus(
  switchNode: NetworkNode,
  allNodes: NetworkNode[],
  allLinks: NetworkLink[]
): SwitchPoeSummary {
  const poeCfg = switchNode.poeConfig || getDefaultSwitchPoeConfig();
  const maxPortWatts = poeCfg.standard.includes('802.3at') ? 30.0 : 15.4;
  const totalBudgetWatts = Math.max(0, poeCfg.totalBudgetWatts ?? 370);
  let usedWatts = 0;
  let poweredDevicesCount = 0;
  let overloadedPortsCount = 0;

  const ports: Record<string, SwitchPortPoeStatus> = {};
  const portList: SwitchPortPoeStatus[] = [];

  for (const iface of switchNode.interfaces) {
    const portPoeEnabled = poeCfg.enabled && iface.poeEnabled !== false;
    const adminMode: 'auto' | 'never' = portPoeEnabled ? 'auto' : 'never';

    const link = allLinks.find(
      (l) =>
        (l.sourceNodeId === switchNode.id && l.sourcePortId === iface.id) ||
        (l.targetNodeId === switchNode.id && l.targetPortId === iface.id)
    );

    let pdNode: NetworkNode | undefined;
    let pdPort: NetworkInterface | undefined;
    if (link && (link.cableType === 'straight' || link.cableType === 'crossover')) {
      const peerNodeId =
        link.sourceNodeId === switchNode.id ? link.targetNodeId : link.sourceNodeId;
      const peerPortId =
        link.sourceNodeId === switchNode.id ? link.targetPortId : link.sourcePortId;
      const candidateNode = allNodes.find((n) => n.id === peerNodeId);
      const candidatePort = candidateNode?.interfaces.find((p) => p.id === peerPortId);
      if (candidateNode && candidatePort && isPoweredDeviceNode(candidateNode)) {
        // For an IP Phone with 2 ports (SW and PC), only the SW port (index 0 or shortName SW/Fa0/0) draws PoE
        const isPhonePcPort =
          isVoipPhoneNode(candidateNode) &&
          candidatePort.shortName.toLowerCase().includes('pc');
        if (!isPhonePcPort) {
          pdNode = candidateNode;
          pdPort = candidatePort;
        }
      }
    }

    if (!portPoeEnabled) {
      const entry: SwitchPortPoeStatus = {
        portId: iface.id,
        portShortName: iface.shortName,
        adminMode: 'never',
        operStatus: 'off',
        allocatedWatts: 0,
        maxPortWatts,
        poeClass: pdNode ? getDeviceRequiredPoeWatts(pdNode).poeClass : 'n/a',
        pdNodeId: pdNode?.id,
        pdNodeName: pdNode?.name,
        pdDeviceTypeLabel: pdNode ? getDeviceRequiredPoeWatts(pdNode).deviceLabel : undefined,
        voiceVlan: iface.voiceVlan,
        accessVlan: iface.accessVlan || 1,
      };
      ports[iface.id] = entry;
      portList.push(entry);
      continue;
    }

    if (!pdNode || !pdPort || iface.adminStatus !== 'up' || pdPort.adminStatus !== 'up') {
      const entry: SwitchPortPoeStatus = {
        portId: iface.id,
        portShortName: iface.shortName,
        adminMode: 'auto',
        operStatus: 'searching',
        allocatedWatts: 0,
        maxPortWatts,
        poeClass: '0',
        voiceVlan: iface.voiceVlan,
        accessVlan: iface.accessVlan || 1,
      };
      ports[iface.id] = entry;
      portList.push(entry);
      continue;
    }

    const req = getDeviceRequiredPoeWatts(pdNode);
    const roundedNext = Math.round((usedWatts + req.watts) * 10) / 10;

    if (roundedNext <= totalBudgetWatts && req.watts <= maxPortWatts) {
      usedWatts = roundedNext;
      poweredDevicesCount += 1;
      const entry: SwitchPortPoeStatus = {
        portId: iface.id,
        portShortName: iface.shortName,
        adminMode: 'auto',
        operStatus: 'delivering',
        allocatedWatts: req.watts,
        maxPortWatts,
        poeClass: req.poeClass,
        pdNodeId: pdNode.id,
        pdNodeName: pdNode.name,
        pdDeviceTypeLabel: req.deviceLabel,
        voiceVlan: iface.voiceVlan,
        accessVlan: iface.accessVlan || 1,
      };
      ports[iface.id] = entry;
      portList.push(entry);
    } else {
      overloadedPortsCount += 1;
      const entry: SwitchPortPoeStatus = {
        portId: iface.id,
        portShortName: iface.shortName,
        adminMode: 'auto',
        operStatus: 'fault_overload',
        allocatedWatts: 0,
        maxPortWatts,
        poeClass: req.poeClass,
        pdNodeId: pdNode.id,
        pdNodeName: pdNode.name,
        pdDeviceTypeLabel: req.deviceLabel,
        voiceVlan: iface.voiceVlan,
        accessVlan: iface.accessVlan || 1,
      };
      ports[iface.id] = entry;
      portList.push(entry);
    }
  }

  const remainingWatts = Math.max(0, Math.round((totalBudgetWatts - usedWatts) * 10) / 10);
  const utilizationPercent =
    totalBudgetWatts > 0 ? Math.min(100, Math.round((usedWatts / totalBudgetWatts) * 100)) : 0;

  return {
    enabled: poeCfg.enabled,
    standard: poeCfg.standard,
    totalBudgetWatts,
    usedWatts,
    remainingWatts,
    utilizationPercent,
    poweredDevicesCount,
    overloadedPortsCount,
    ports,
    portList,
  };
}

/**
 * Evaluates whether a Powered Device (Cisco IP Phone or Wi-Fi AP) currently receives power.
 */
export function getPoweredDevicePoeState(
  node: NetworkNode,
  allNodes: NetworkNode[],
  allLinks: NetworkLink[]
): PoweredDeviceState {
  if (!isPoweredDeviceNode(node)) {
    return {
      isPoweredDevice: false,
      isPowered: true,
      powerSource: 'Builtin PSU',
      watts: 0,
      poeClassLabel: 'N/A',
    };
  }

  const req = getDeviceRequiredPoeWatts(node);

  if (node.voipConfig?.acAdapterConnected || node.ipCameraConfig?.acAdapterConnected) {
    return {
      isPoweredDevice: true,
      isPowered: true,
      powerSource: 'AC Adapter 48V',
      watts: req.watts,
      poeClassLabel: req.poeClass,
    };
  }

  // Find uplink port on the PD (for IP Phone: SW port / index 0; for IP Camera: Eth0; for AP: Gi0/1 / index 0)
  const uplinkPort =
    node.interfaces.find(
      (i) =>
        !i.isWireless &&
        !i.shortName.toLowerCase().includes('pc')
    ) || node.interfaces[0];

  if (!uplinkPort) {
    return {
      isPoweredDevice: true,
      isPowered: false,
      powerSource: 'OFF (No PoE)',
      watts: 0,
      poeClassLabel: req.poeClass,
      reason: 'Отсутствует порт подключения PoE',
    };
  }

  const link = allLinks.find(
    (l) =>
      (l.sourceNodeId === node.id && l.sourcePortId === uplinkPort.id) ||
      (l.targetNodeId === node.id && l.targetPortId === uplinkPort.id)
  );

  if (!link) {
    // Unconnected IP Phone or PoE IP Camera has no PoE power unless external AC/DC adapter is enabled
    if (isVoipPhoneNode(node) || isIpCameraNode(node)) {
      return {
        isPoweredDevice: true,
        isPowered: false,
        powerSource: 'OFF (No PoE)',
        watts: 0,
        poeClassLabel: req.poeClass,
        reason: `Порт ${uplinkPort.shortName} не подключён к PoE-коммутатору (нет питания 802.3af/at)`,
      };
    }
    return {
      isPoweredDevice: true,
      isPowered: true,
      powerSource: 'Builtin PSU',
      watts: req.watts,
      poeClassLabel: req.poeClass,
    };
  }

  const peerNodeId = link.sourceNodeId === node.id ? link.targetNodeId : link.sourceNodeId;
  const peerPortId = link.sourceNodeId === node.id ? link.targetPortId : link.sourcePortId;
  const peerNode = allNodes.find((n) => n.id === peerNodeId);
  const peerPort = peerNode?.interfaces.find((p) => p.id === peerPortId);

  if (peerNode && peerNode.type === 'switch' && peerPort) {
    const swPoe = computeSwitchPoeStatus(peerNode, allNodes, allLinks);
    const portStatus = swPoe.ports[peerPort.id];
    if (portStatus) {
      if (portStatus.operStatus === 'delivering') {
        return {
          isPoweredDevice: true,
          isPowered: true,
          powerSource: 'PoE 802.3af/at',
          watts: portStatus.allocatedWatts,
          poeClassLabel: req.poeClass,
          switchNodeId: peerNode.id,
          switchNodeName: peerNode.name,
          switchPortShortName: peerPort.shortName,
        };
      }
      if (portStatus.operStatus === 'off') {
        return {
          isPoweredDevice: true,
          isPowered: false,
          powerSource: 'OFF (No PoE)',
          watts: 0,
          poeClassLabel: req.poeClass,
          switchNodeId: peerNode.id,
          switchNodeName: peerNode.name,
          switchPortShortName: peerPort.shortName,
          reason: `Питание PoE отключено (power inline never) на порту ${peerNode.name}:${peerPort.shortName}`,
        };
      }
      if (portStatus.operStatus === 'fault_overload') {
        return {
          isPoweredDevice: true,
          isPowered: false,
          powerSource: 'FAULT (PoE Budget Overload)',
          watts: 0,
          poeClassLabel: req.poeClass,
          switchNodeId: peerNode.id,
          switchNodeName: peerNode.name,
          switchPortShortName: peerPort.shortName,
          reason: `Превышен бюджет мощности PoE (${swPoe.usedWatts}W / ${swPoe.totalBudgetWatts}W) на коммутаторе ${peerNode.name}`,
        };
      }
    }
  }

  // If connected to a router or non-switch port, allow power by default
  return {
    isPoweredDevice: true,
    isPowered: true,
    powerSource: 'PoE 802.3af/at',
    watts: req.watts,
    poeClassLabel: req.poeClass,
    switchNodeId: peerNode?.id,
    switchNodeName: peerNode?.name,
    switchPortShortName: peerPort?.shortName,
  };
}

export interface VoipDirectoryItem {
  nodeId: string;
  nodeName: string;
  extension: string;
  displayName: string;
  ipAddress: string;
  voiceVlan: number;
  dataVlan: number;
  sipServerIp: string;
  isPowered: boolean;
  poeWatts: number;
  switchPortLabel?: string;
}

/**
 * Lists all VoIP IP Phones in the topology along with their extension, IP, Voice VLAN, and PoE state.
 */
export function getVoipDirectory(
  allNodes: NetworkNode[],
  allLinks: NetworkLink[]
): VoipDirectoryItem[] {
  const list: VoipDirectoryItem[] = [];
  for (const n of allNodes) {
    if (!isVoipPhoneNode(n)) continue;
    const cfg = n.voipConfig || getDefaultVoipPhoneConfig(1);
    const swPort = n.interfaces[0];
    const poe = getPoweredDevicePoeState(n, allNodes, allLinks);
    list.push({
      nodeId: n.id,
      nodeName: n.name,
      extension: cfg.extension,
      displayName: cfg.displayName || n.name,
      ipAddress: swPort?.ipAddress || '',
      voiceVlan: cfg.voiceVlan || swPort?.accessVlan || 20,
      dataVlan: cfg.dataVlan || n.interfaces[1]?.accessVlan || 10,
      sipServerIp: cfg.sipServerIp || '192.168.20.100',
      isPowered: poe.isPowered,
      poeWatts: poe.watts,
      switchPortLabel:
        poe.switchNodeName && poe.switchPortShortName
          ? `${poe.switchNodeName}:${poe.switchPortShortName}`
          : undefined,
    });
  }
  return list.sort((a, b) => a.extension.localeCompare(b.extension));
}

/**
 * Resolves a dialed SIP number (e.g. '102') or IPv4 address to the target IP Phone node and IP.
 */
export function resolveSipExtensionTarget(
  dialedTarget: string,
  allNodes: NetworkNode[]
): { targetPhoneNode?: NetworkNode; targetIp?: string; extension?: string; sipRegistrarNode?: NetworkNode } {
  const trimmed = dialedTarget.trim();
  const sipRegistrarNode = allNodes.find(
    (n) => n.type === 'server' && (n.services?.sipEnabled || (n.services?.sipExtensions?.length ?? 0) > 0)
  );

  // 1. Direct match on an IP Phone's voipConfig.extension
  const phoneByExt = allNodes.find(
    (n) => isVoipPhoneNode(n) && n.voipConfig?.extension.trim() === trimmed
  );
  if (phoneByExt) {
    return {
      targetPhoneNode: phoneByExt,
      targetIp: phoneByExt.interfaces[0]?.ipAddress,
      extension: phoneByExt.voipConfig?.extension || trimmed,
      sipRegistrarNode,
    };
  }

  // 2. Match in SIP Server's sipExtensions table
  if (sipRegistrarNode?.services?.sipExtensions) {
    const extEntry: SipExtensionEntry | undefined =
      sipRegistrarNode.services.sipExtensions.find((e) => e.extension.trim() === trimmed);
    if (extEntry && isValidIpv4(extEntry.ipAddress)) {
      const matchedPhone = allNodes.find(
        (n) => n.interfaces.some((i) => i.ipAddress === extEntry.ipAddress)
      );
      return {
        targetPhoneNode: matchedPhone,
        targetIp: extEntry.ipAddress,
        extension: extEntry.extension,
        sipRegistrarNode,
      };
    }
  }

  // 3. Direct IPv4 match on an IP Phone
  if (isValidIpv4(trimmed)) {
    const phoneByIp = allNodes.find(
      (n) => isVoipPhoneNode(n) && n.interfaces.some((i) => i.ipAddress === trimmed)
    );
    return {
      targetPhoneNode: phoneByIp,
      targetIp: trimmed,
      extension: phoneByIp?.voipConfig?.extension || trimmed,
      sipRegistrarNode,
    };
  }

  return { sipRegistrarNode };
}

/**
 * Converts a successful L2/L3 packet path between two IP Phones into a full SIP INVITE + 200 OK + RTP Audio Voice VLAN trace.
 */
export function buildVoipCallStepsFromPath(
  callerNode: NetworkNode,
  calleeNode: NetworkNode,
  baseSteps: SimulationStep[],
  sipServerNode?: NetworkNode
): SimulationStep[] {
  const callerCfg = callerNode.voipConfig || getDefaultVoipPhoneConfig(1);
  const calleeCfg = calleeNode.voipConfig || getDefaultVoipPhoneConfig(2);
  const callerIp = callerNode.interfaces[0]?.ipAddress || '0.0.0.0';
  const calleeIp = calleeNode.interfaces[0]?.ipAddress || '0.0.0.0';
  const voiceVlan = callerCfg.voiceVlan || 20;
  const codec = callerCfg.codec || 'G.711u (64 kbps)';
  const dscp = callerCfg.dscpMark || 'EF (46)';
  const sipDomain = sipServerNode?.services?.sipDomain || callerCfg.sipServerIp || 'voip.corp.local';

  // Keep any ARP steps at the start intact, then transform the request hops into SIP_INVITE,
  // the reply hops into SIP_200_OK, and append RTP_AUDIO media stream hops!
  const arpSteps = baseSteps.filter(
    (s) => s.protocol === 'ARP_REQUEST' || s.protocol === 'ARP_REPLY'
  );
  const forwardHops = baseSteps.filter((s) => s.protocol === 'ICMP_ECHO_REQUEST');
  const reverseHops = baseSteps.filter((s) => s.protocol === 'ICMP_ECHO_REPLY');

  const result: SimulationStep[] = [];
  let seq = 1;

  for (const arp of arpSteps) {
    result.push({
      ...arp,
      id: `step-${seq}`,
      stepIndex: seq,
      timestampMs: seq * 180,
    });
    seq++;
  }

  // Phase 1: SIP INVITE (UDP 5060, DSCP CS3 / EF, Voice VLAN)
  for (const hop of forwardHops) {
    const inviteSummary = `SIP INVITE sip:${calleeCfg.extension}@${sipDomain} (From: ${callerCfg.extension}, VLAN ${voiceVlan}, QoS ${dscp})`;
    result.push({
      ...hop,
      id: `step-${seq}`,
      stepIndex: seq,
      timestampMs: seq * 180,
      protocol: 'SIP_INVITE',
      vlanTag: hop.vlanTag ?? voiceVlan,
      decisionTitle:
        hop.status === 'delivered' && hop.toNodeId === calleeNode.id
          ? `${calleeNode.name} (Ext ${calleeCfg.extension}): Принят вызов SIP INVITE от абонента ${callerCfg.extension} (${callerIp}) в Voice VLAN ${voiceVlan}`
          : `${hop.toNodeName}: Маршрутизация / коммутация вызова SIP INVITE (${callerCfg.extension} → ${calleeCfg.extension}, Voice VLAN ${voiceVlan})`,
      inboundPdu: {
        ...hop.inboundPdu,
        l2: {
          ...hop.inboundPdu.l2,
          headerType: 'IEEE 802.1Q',
          vlanTag: hop.vlanTag ?? voiceVlan,
        },
        l3: {
          ...hop.inboundPdu.l3,
          protocol: `UDP (17) · DSCP ${dscp}`,
        },
        l4: {
          type: 'SIP_INVITE',
          summary: inviteSummary,
          seqNumber: 101,
          srcPort: 5060,
          dstPort: 5060,
        },
        l7: {
          appProtocol: 'SIP',
          headline: `INVITE sip:${calleeCfg.extension}@${sipDomain} SIP/2.0`,
          fields: {
            'From': `"${callerCfg.displayName}" <sip:${callerCfg.extension}@${callerIp}>`,
            'To': `"${calleeCfg.displayName}" <sip:${calleeCfg.extension}@${calleeIp}>`,
            'Voice VLAN': `VLAN ${voiceVlan} (IEEE 802.1p CoS 5)`,
            'SDP Audio Codec': codec,
          },
        },
      },
      outboundPdu: {
        ...hop.outboundPdu,
        l2: {
          ...hop.outboundPdu.l2,
          headerType: 'IEEE 802.1Q',
          vlanTag: hop.vlanTag ?? voiceVlan,
        },
        l3: {
          ...hop.outboundPdu.l3,
          protocol: `UDP (17) · DSCP ${dscp}`,
        },
        l4: {
          type: 'SIP_INVITE',
          summary: inviteSummary,
          seqNumber: 101,
          srcPort: 5060,
          dstPort: 5060,
        },
        l7: {
          appProtocol: 'SIP',
          headline: `INVITE sip:${calleeCfg.extension}@${sipDomain} SIP/2.0`,
          fields: {
            'From': `"${callerCfg.displayName}" <sip:${callerCfg.extension}@${callerIp}>`,
            'To': `"${calleeCfg.displayName}" <sip:${calleeCfg.extension}@${calleeIp}>`,
            'Voice VLAN': `VLAN ${voiceVlan} (IEEE 802.1p CoS 5)`,
            'SDP Audio Codec': codec,
          },
        },
      },
      osiActions: [
        ...hop.osiActions.slice(0, 2),
        {
          layer: 'L7',
          title: `Сигнализация VoIP SIP INVITE (UDP 5060 · Voice VLAN ${voiceVlan})`,
          detail: `Установка голосового вызова ${callerCfg.extension} (${callerIp}) → ${calleeCfg.extension} (${calleeIp}), кодек ${codec}, маркировка QoS DSCP ${dscp}.`,
        },
      ],
    });
    seq++;
  }

  // Phase 2: SIP 200 OK (UDP 5060)
  for (const hop of reverseHops) {
    const okSummary = `SIP/2.0 200 OK (${calleeCfg.extension} → ${callerCfg.extension}, SDP ${codec} RTP:16384)`;
    result.push({
      ...hop,
      id: `step-${seq}`,
      stepIndex: seq,
      timestampMs: seq * 180,
      protocol: 'SIP_200_OK',
      vlanTag: hop.vlanTag ?? voiceVlan,
      decisionTitle:
        hop.status === 'delivered' && hop.toNodeId === callerNode.id
          ? `${callerNode.name} (Ext ${callerCfg.extension}): Получено подтверждение SIP 200 OK от ${calleeCfg.extension} — соединение установлено`
          : `${hop.toNodeName}: Передача ответа SIP 200 OK (${calleeCfg.extension} → ${callerCfg.extension})`,
      inboundPdu: {
        ...hop.inboundPdu,
        l2: {
          ...hop.inboundPdu.l2,
          headerType: 'IEEE 802.1Q',
          vlanTag: hop.vlanTag ?? voiceVlan,
        },
        l3: {
          ...hop.inboundPdu.l3,
          protocol: `UDP (17) · DSCP ${dscp}`,
        },
        l4: {
          type: 'SIP_200_OK',
          summary: okSummary,
          seqNumber: 102,
          srcPort: 5060,
          dstPort: 5060,
        },
        l7: {
          appProtocol: 'SIP',
          headline: `SIP/2.0 200 OK — Call Answered (${calleeCfg.extension})`,
          fields: {
            'Status': '200 OK (Ringing → Connected)',
            'Responder': `${calleeNode.name} (Ext ${calleeCfg.extension} · ${calleeIp})`,
            'Negotiated RTP': `UDP Port 16384 · ${codec}`,
            'QoS Marking': `DSCP ${dscp} · 802.1p CoS 5`,
          },
        },
      },
      outboundPdu: {
        ...hop.outboundPdu,
        l2: {
          ...hop.outboundPdu.l2,
          headerType: 'IEEE 802.1Q',
          vlanTag: hop.vlanTag ?? voiceVlan,
        },
        l3: {
          ...hop.outboundPdu.l3,
          protocol: `UDP (17) · DSCP ${dscp}`,
        },
        l4: {
          type: 'SIP_200_OK',
          summary: okSummary,
          seqNumber: 102,
          srcPort: 5060,
          dstPort: 5060,
        },
        l7: {
          appProtocol: 'SIP',
          headline: `SIP/2.0 200 OK — Call Answered (${calleeCfg.extension})`,
          fields: {
            'Status': '200 OK (Ringing → Connected)',
            'Responder': `${calleeNode.name} (Ext ${calleeCfg.extension} · ${calleeIp})`,
            'Negotiated RTP': `UDP Port 16384 · ${codec}`,
            'QoS Marking': `DSCP ${dscp} · 802.1p CoS 5`,
          },
        },
      },
      osiActions: [
        ...hop.osiActions.slice(0, 2),
        {
          layer: 'L7',
          title: `Подтверждение вызова SIP 200 OK (SDP Media Negotiated)`,
          detail: `Абонент ${calleeCfg.extension} поднял трубку. Согласован голосовой поток RTP (UDP 16384, ${codec}).`,
        },
      ],
    });
    seq++;
  }

  // Phase 3: RTP Audio Stream (UDP 16384, G.711u, DSCP EF 46)
  for (const hop of forwardHops) {
    const rtpSummary = `RTP Audio Stream (${callerCfg.extension} ↔ ${calleeCfg.extension}, ${codec}, DSCP ${dscp}, VLAN ${voiceVlan})`;
    result.push({
      ...hop,
      id: `step-${seq}`,
      stepIndex: seq,
      timestampMs: seq * 180,
      protocol: 'RTP_AUDIO',
      vlanTag: hop.vlanTag ?? voiceVlan,
      decisionTitle:
        hop.status === 'delivered' && hop.toNodeId === calleeNode.id
          ? `${calleeNode.name} (Ext ${calleeCfg.extension}): Приём голосового потока RTP (${codec}, QoS DSCP ${dscp}) от ${callerCfg.extension}`
          : `${hop.toNodeName}: Приоритетная передача голосового пакета RTP (QoS DSCP ${dscp}, Voice VLAN ${voiceVlan})`,
      inboundPdu: {
        ...hop.inboundPdu,
        l2: {
          ...hop.inboundPdu.l2,
          headerType: 'IEEE 802.1Q',
          vlanTag: hop.vlanTag ?? voiceVlan,
        },
        l3: {
          ...hop.inboundPdu.l3,
          protocol: `UDP (17) · QoS DSCP ${dscp}`,
        },
        l4: {
          type: 'RTP_AUDIO',
          summary: rtpSummary,
          seqNumber: 201,
          srcPort: 16384,
          dstPort: 16384,
        },
        l7: {
          appProtocol: 'RTP',
          headline: `Real-time Transport Protocol (RTP Audio · ${codec})`,
          fields: {
            'Call Session': `Ext ${callerCfg.extension} (${callerIp}) ↔ Ext ${calleeCfg.extension} (${calleeIp})`,
            'Audio Codec': `${codec} · 20 ms packetization`,
            'QoS Priority': `DSCP ${dscp} (Expedited Forwarding) · CoS 5`,
            'Voice VLAN': `VLAN ${voiceVlan}`,
          },
        },
      },
      outboundPdu: {
        ...hop.outboundPdu,
        l2: {
          ...hop.outboundPdu.l2,
          headerType: 'IEEE 802.1Q',
          vlanTag: hop.vlanTag ?? voiceVlan,
        },
        l3: {
          ...hop.outboundPdu.l3,
          protocol: `UDP (17) · QoS DSCP ${dscp}`,
        },
        l4: {
          type: 'RTP_AUDIO',
          summary: rtpSummary,
          seqNumber: 201,
          srcPort: 16384,
          dstPort: 16384,
        },
        l7: {
          appProtocol: 'RTP',
          headline: `Real-time Transport Protocol (RTP Audio · ${codec})`,
          fields: {
            'Call Session': `Ext ${callerCfg.extension} (${callerIp}) ↔ Ext ${calleeCfg.extension} (${calleeIp})`,
            'Audio Codec': `${codec} · 20 ms packetization`,
            'QoS Priority': `DSCP ${dscp} (Expedited Forwarding) · CoS 5`,
            'Voice VLAN': `VLAN ${voiceVlan}`,
          },
        },
      },
      osiActions: [
        ...hop.osiActions.slice(0, 2),
        {
          layer: 'L7',
          title: `Голосовой трафик реального времени RTP (${codec} · DSCP ${dscp})`,
          detail: `Передача медиапотока между IP-телефонами ${callerCfg.extension} и ${calleeCfg.extension} в изолированном Voice VLAN ${voiceVlan}.`,
        },
      ],
    });
    seq++;
  }

  return result;
}

/**
 * Updates call logs on caller and callee nodes after a VoIP call attempt.
 */
export function recordVoipCallHistory(
  nodes: NetworkNode[],
  callerNodeId: string,
  calleeNodeId: string | undefined,
  dialedExt: string,
  targetIp: string,
  success: boolean
): NetworkNode[] {
  const nowStr = new Date().toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  return nodes.map((n) => {
    if (n.id === callerNodeId && n.voipConfig) {
      const entry: VoipCallLogEntry = {
        id: `call-${Date.now()}-out`,
        timestamp: nowStr,
        direction: 'outgoing',
        peerExtension: dialedExt,
        peerIp: targetIp || '—',
        codec: n.voipConfig.codec,
        status: success ? 'CONNECTED' : 'FAILED',
      };
      return {
        ...n,
        voipConfig: {
          ...n.voipConfig,
          callStatus: success ? 'connected' : 'failed',
          activePeerExtension: dialedExt,
          callHistory: [entry, ...(n.voipConfig.callHistory || [])].slice(0, 10),
        },
      };
    }
    if (calleeNodeId && n.id === calleeNodeId && n.voipConfig && success) {
      const caller = nodes.find((c) => c.id === callerNodeId);
      const callerExt = caller?.voipConfig?.extension || caller?.name || 'Unknown';
      const callerIp = caller?.interfaces[0]?.ipAddress || '—';
      const entry: VoipCallLogEntry = {
        id: `call-${Date.now()}-in`,
        timestamp: nowStr,
        direction: 'incoming',
        peerExtension: callerExt,
        peerIp: callerIp,
        codec: n.voipConfig.codec,
        status: 'CONNECTED',
      };
      return {
        ...n,
        voipConfig: {
          ...n.voipConfig,
          callStatus: 'connected',
          activePeerExtension: callerExt,
          callHistory: [entry, ...(n.voipConfig.callHistory || [])].slice(0, 10),
        },
      };
    }
    return n;
  });
}

export interface IpCameraDirectoryItem {
  nodeId: string;
  nodeName: string;
  channelNumber: number;
  locationName: string;
  cameraName: string;
  ipAddress: string;
  surveillanceVlan: number;
  nvrServerIp: string;
  nvrTargetIp: string;
  streamMode: 'unicast' | 'multicast';
  multicastGroupIp: string;
  rtspUrl: string;
  streamUrl: string;
  videoCodec: string;
  codec: string;
  resolution: string;
  fps: number;
  dscpMark: string;
  isPowered: boolean;
  poeWatts: number;
  switchPortLabel?: string;
}

/**
 * Lists all PoE IP Cameras in the topology along with their channel, RTSP URL, VLAN, and PoE state.
 */
export function getIpCameraDirectory(
  allNodes: NetworkNode[],
  allLinks: NetworkLink[]
): IpCameraDirectoryItem[] {
  const list: IpCameraDirectoryItem[] = [];
  let fallbackIndex = 1;
  for (const n of allNodes) {
    if (!isIpCameraNode(n)) continue;
    const cfg = n.ipCameraConfig || getDefaultIpCameraConfig(fallbackIndex);
    const ethPort = n.interfaces[0];
    const ip = ethPort?.ipAddress || '0.0.0.0';
    const poe = getPoweredDevicePoeState(n, allNodes, allLinks);
    const ch = cfg.channelNumber || fallbackIndex;
    fallbackIndex++;
    const rtspUrl = cfg.streamUrl || `rtsp://${ip}:${cfg.rtspPort || 554}/live/ch${ch}`;
    const videoCodec = cfg.codec || cfg.videoCodec || 'H.265 (HEVC)';
    const nvrServerIp = cfg.nvrTargetIp || cfg.nvrServerIp || '192.168.30.100';
    const locationName = cfg.cameraName || cfg.locationName || n.name;
    list.push({
      nodeId: n.id,
      nodeName: n.name,
      channelNumber: ch,
      locationName,
      cameraName: locationName,
      ipAddress: ethPort?.ipAddress || '',
      surveillanceVlan: cfg.surveillanceVlan || ethPort?.accessVlan || 30,
      nvrServerIp,
      nvrTargetIp: nvrServerIp,
      streamMode: cfg.streamMode || 'unicast',
      multicastGroupIp: cfg.multicastGroupIp || `239.0.30.${ch}`,
      rtspUrl,
      streamUrl: rtspUrl,
      videoCodec,
      codec: videoCodec,
      resolution: cfg.resolution || '4K (3840×2160)',
      fps: cfg.fps || 30,
      dscpMark: cfg.dscpMark || 'AF41 (34)',
      isPowered: poe.isPowered,
      poeWatts: poe.watts,
      switchPortLabel:
        poe.switchNodeName && poe.switchPortShortName
          ? `${poe.switchNodeName}:${poe.switchPortShortName}`
          : undefined,
    });
  }
  return list.sort((a, b) => a.channelNumber - b.channelNumber);
}

/**
 * Resolves an NVR Server node and IPv4 address for an RTSP / Multicast stream from an IP Camera.
 */
export function resolveRtspNvrTarget(
  targetInput: string | undefined,
  cameraNode: NetworkNode,
  allNodes: NetworkNode[]
): {
  nvrNode?: NetworkNode;
  nvrIp?: string;
  streamMode: 'unicast' | 'multicast';
  multicastGroupIp: string;
} {
  const cfg = cameraNode.ipCameraConfig || getDefaultIpCameraConfig(1);
  const configuredNvrIp = cfg.nvrTargetIp || cfg.nvrServerIp || '192.168.30.100';
  const raw = (targetInput || configuredNvrIp || '').trim();
  const isMulticastInput = raw.startsWith('239.') || raw.startsWith('224.');
  const streamMode: 'unicast' | 'multicast' =
    isMulticastInput ? 'multicast' : cfg.streamMode || 'unicast';
  const multicastGroupIp = isMulticastInput
    ? raw
    : cfg.multicastGroupIp || `239.0.30.${cfg.channelNumber || 1}`;

  // 1. Find explicit NVR or Server node by IP if unicast IP is given
  if (isValidIpv4(raw) && !isMulticastInput) {
    const matchedNode = allNodes.find((n) =>
      n.interfaces.some((i) => i.ipAddress === raw)
    );
    if (matchedNode) {
      return {
        nvrNode: matchedNode,
        nvrIp: raw,
        streamMode,
        multicastGroupIp,
      };
    }
  }

  // 2. Find NVR Server by node ID or hostname
  if (raw) {
    const byNameOrId = allNodes.find(
      (n) =>
        n.id === raw ||
        n.name.toLowerCase() === raw.toLowerCase()
    );
    if (byNameOrId && byNameOrId.interfaces[0]?.ipAddress) {
      return {
        nvrNode: byNameOrId,
        nvrIp: byNameOrId.interfaces[0].ipAddress,
        streamMode,
        multicastGroupIp,
      };
    }
  }

  // 3. Find configured nvrServerIp on camera
  if (isValidIpv4(configuredNvrIp)) {
    const byCfgIp = allNodes.find((n) =>
      n.interfaces.some((i) => i.ipAddress === configuredNvrIp)
    );
    if (byCfgIp) {
      return {
        nvrNode: byCfgIp,
        nvrIp: configuredNvrIp,
        streamMode,
        multicastGroupIp,
      };
    }
  }

  // 4. Fallback to any NVR or Server node in the topology
  const fallbackNvr =
    allNodes.find((n) => isNvrServerNode(n)) ||
    allNodes.find((n) => n.type === 'server');
  return {
    nvrNode: fallbackNvr,
    nvrIp: fallbackNvr?.interfaces[0]?.ipAddress || configuredNvrIp,
    streamMode,
    multicastGroupIp,
  };
}

/**
 * Converts a successful L2/L3 packet path between a PoE IP Camera and an NVR Recorder
 * into a full RTSP SETUP/PLAY (TCP 554) -> RTSP 200 OK -> RTP Video Stream (UDP 5004, H.265, DSCP AF41, Unicast or Multicast 239.0.30.x) trace.
 */
export function buildRtspStreamStepsFromPath(
  cameraNode: NetworkNode,
  nvrNode: NetworkNode,
  baseSteps: SimulationStep[],
  streamModeOverride?: 'unicast' | 'multicast'
): SimulationStep[] {
  const camCfg = cameraNode.ipCameraConfig || getDefaultIpCameraConfig(1);
  const camIp = cameraNode.interfaces[0]?.ipAddress || '192.168.30.11';
  const nvrIp =
    nvrNode.interfaces[0]?.ipAddress ||
    camCfg.nvrTargetIp ||
    camCfg.nvrServerIp ||
    '192.168.30.100';
  const survVlan = camCfg.surveillanceVlan || cameraNode.interfaces[0]?.accessVlan || 30;
  const codec = camCfg.codec || camCfg.videoCodec || 'H.265 (HEVC)';
  const res = camCfg.resolution || '4K (3840×2160)';
  const dscp = camCfg.dscpMark || 'AF41 (34)';
  const ch = camCfg.channelNumber || 1;
  const rtspPort = camCfg.rtspPort || 554;
  const mode = streamModeOverride || camCfg.streamMode || 'unicast';
  const mcastIp = camCfg.multicastGroupIp || `239.0.30.${ch}`;
  const rtspUrl = camCfg.streamUrl || `rtsp://${camIp}:${rtspPort}/live/ch${ch}`;

  const arpSteps = baseSteps.filter(
    (s) => s.protocol === 'ARP_REQUEST' || s.protocol === 'ARP_REPLY'
  );
  const forwardHops = baseSteps.filter((s) => s.protocol === 'ICMP_ECHO_REQUEST');
  const reverseHops = baseSteps.filter((s) => s.protocol === 'ICMP_ECHO_REPLY');

  const result: SimulationStep[] = [];
  let seq = 1;

  for (const arp of arpSteps) {
    result.push({
      ...arp,
      id: `step-${seq}`,
      stepIndex: seq,
      timestampMs: seq * 180,
    });
    seq++;
  }

  // Phase 1: RTSP SETUP / PLAY (TCP 554)
  for (const hop of forwardHops) {
    const setupSummary = `RTSP PLAY ${rtspUrl} RTSP/1.0 (Ch ${ch}: ${camCfg.locationName}, VLAN ${survVlan})`;
    result.push({
      ...hop,
      id: `step-${seq}`,
      stepIndex: seq,
      timestampMs: seq * 180,
      protocol: 'RTSP_SETUP',
      vlanTag: hop.vlanTag ?? survVlan,
      decisionTitle:
        hop.status === 'delivered' && hop.toNodeId === nvrNode.id
          ? `${nvrNode.name}: Запрос видеопотока RTSP PLAY от IP-камеры ${cameraNode.name} (Ch ${ch} · ${camIp}) в VLAN ${survVlan}`
          : `${hop.toNodeName}: Передача управляющего пакета RTSP SETUP/PLAY (${cameraNode.name} → ${nvrNode.name}, VLAN ${survVlan})`,
      inboundPdu: {
        ...hop.inboundPdu,
        l2: {
          ...hop.inboundPdu.l2,
          headerType: 'IEEE 802.1Q',
          vlanTag: hop.vlanTag ?? survVlan,
        },
        l3: {
          ...hop.inboundPdu.l3,
          protocol: `TCP (6) · DSCP ${dscp}`,
        },
        l4: {
          type: 'RTSP_SETUP',
          summary: setupSummary,
          seqNumber: 301,
          srcPort: rtspPort,
          dstPort: 54320,
        },
        l7: {
          appProtocol: 'RTSP',
          headline: `PLAY ${rtspUrl} RTSP/1.0`,
          fields: {
            'Camera Source': `${cameraNode.name} (${camCfg.locationName})`,
            'Transport':
              mode === 'multicast'
                ? `RTP/AVP/UDP;multicast;destination=${mcastIp};port=5004-5005`
                : `RTP/AVP/UDP;unicast;client_port=5004-5005`,
            'Video Profile': `${codec} · ${res} @ ${camCfg.fps || 30} fps`,
            'Surveillance VLAN': `VLAN ${survVlan} (Isolated CCTV Segment)`,
          },
        },
      },
      outboundPdu: {
        ...hop.outboundPdu,
        l2: {
          ...hop.outboundPdu.l2,
          headerType: 'IEEE 802.1Q',
          vlanTag: hop.vlanTag ?? survVlan,
        },
        l3: {
          ...hop.outboundPdu.l3,
          protocol: `TCP (6) · DSCP ${dscp}`,
        },
        l4: {
          type: 'RTSP_SETUP',
          summary: setupSummary,
          seqNumber: 301,
          srcPort: rtspPort,
          dstPort: 54320,
        },
        l7: {
          appProtocol: 'RTSP',
          headline: `PLAY ${rtspUrl} RTSP/1.0`,
          fields: {
            'Camera Source': `${cameraNode.name} (${camCfg.locationName})`,
            'Transport':
              mode === 'multicast'
                ? `RTP/AVP/UDP;multicast;destination=${mcastIp};port=5004-5005`
                : `RTP/AVP/UDP;unicast;client_port=5004-5005`,
            'Video Profile': `${codec} · ${res} @ ${camCfg.fps || 30} fps`,
            'Surveillance VLAN': `VLAN ${survVlan} (Isolated CCTV Segment)`,
          },
        },
      },
      osiActions: [
        ...hop.osiActions.slice(0, 2),
        {
          layer: 'L7',
          title: `Инициализация видеосессии RTSP (TCP 554 · VLAN ${survVlan})`,
          detail: `IP-камера ${cameraNode.name} (${camIp}) согласует с видеорегистратором ${nvrNode.name} (${nvrIp}) передачу потока ${codec} (${mode.toUpperCase()}).`,
        },
      ],
    });
    seq++;
  }

  // Phase 2: RTSP 200 OK (TCP 554)
  for (const hop of reverseHops) {
    const okSummary = `RTSP/1.0 200 OK (Session: NVR-CH0${ch}, SDP ${codec} → ${mode === 'multicast' ? mcastIp : nvrIp}:5004)`;
    result.push({
      ...hop,
      id: `step-${seq}`,
      stepIndex: seq,
      timestampMs: seq * 180,
      protocol: 'RTSP_200_OK',
      vlanTag: hop.vlanTag ?? survVlan,
      decisionTitle:
        hop.status === 'delivered' && hop.toNodeId === cameraNode.id
          ? `${cameraNode.name}: Получено подтверждение RTSP 200 OK от ${nvrNode.name} — старт записи канала CH-0${ch}`
          : `${hop.toNodeName}: Передача ответа RTSP 200 OK (${nvrNode.name} → ${cameraNode.name})`,
      inboundPdu: {
        ...hop.inboundPdu,
        l2: {
          ...hop.inboundPdu.l2,
          headerType: 'IEEE 802.1Q',
          vlanTag: hop.vlanTag ?? survVlan,
        },
        l3: {
          ...hop.inboundPdu.l3,
          protocol: `TCP (6) · DSCP ${dscp}`,
        },
        l4: {
          type: 'RTSP_200_OK',
          summary: okSummary,
          seqNumber: 302,
          srcPort: 54320,
          dstPort: rtspPort,
        },
        l7: {
          appProtocol: 'RTSP',
          headline: `RTSP/1.0 200 OK — Recording Channel CH-0${ch} Active`,
          fields: {
            'NVR Recorder': `${nvrNode.name} (${nvrIp}) · RAID-6 Storage`,
            'Session ID': `NVR-SESSION-CH0${ch}`,
            'Negotiated Stream':
              mode === 'multicast'
                ? `IGMP Multicast ${mcastIp}:5004 (${codec})`
                : `Unicast RTP ${nvrIp}:5004 (${codec})`,
            'QoS Marking': `DSCP ${dscp} · 802.1p CoS 4`,
          },
        },
      },
      outboundPdu: {
        ...hop.outboundPdu,
        l2: {
          ...hop.outboundPdu.l2,
          headerType: 'IEEE 802.1Q',
          vlanTag: hop.vlanTag ?? survVlan,
        },
        l3: {
          ...hop.outboundPdu.l3,
          protocol: `TCP (6) · DSCP ${dscp}`,
        },
        l4: {
          type: 'RTSP_200_OK',
          summary: okSummary,
          seqNumber: 302,
          srcPort: 54320,
          dstPort: rtspPort,
        },
        l7: {
          appProtocol: 'RTSP',
          headline: `RTSP/1.0 200 OK — Recording Channel CH-0${ch} Active`,
          fields: {
            'NVR Recorder': `${nvrNode.name} (${nvrIp}) · RAID-6 Storage`,
            'Session ID': `NVR-SESSION-CH0${ch}`,
            'Negotiated Stream':
              mode === 'multicast'
                ? `IGMP Multicast ${mcastIp}:5004 (${codec})`
                : `Unicast RTP ${nvrIp}:5004 (${codec})`,
            'QoS Marking': `DSCP ${dscp} · 802.1p CoS 4`,
          },
        },
      },
      osiActions: [
        ...hop.osiActions.slice(0, 2),
        {
          layer: 'L7',
          title: `Подтверждение сессии RTSP 200 OK (Канал CH-0${ch} на записи)`,
          detail: `Видеорегистратор ${nvrNode.name} активировал запись потока с камеры ${cameraNode.name} в архив.`,
        },
      ],
    });
    seq++;
  }

  // Phase 3: RTP Video Stream (UDP 5004, H.265 / H.264, Unicast or Multicast 239.0.30.x)
  const videoDstIp = mode === 'multicast' ? mcastIp : nvrIp;
  const videoDstMac =
    mode === 'multicast' ? `01:00:5E:00:1E:0${ch}` : undefined;

  for (const hop of forwardHops) {
    const rtpVideoSummary =
      mode === 'multicast'
        ? `RTP Video Multicast (${camIp} → ${mcastIp}:5004, ${codec}, VLAN ${survVlan})`
        : `RTP Video Stream (${camIp} → ${nvrIp}:5004, ${codec}, DSCP ${dscp}, VLAN ${survVlan})`;

    result.push({
      ...hop,
      id: `step-${seq}`,
      stepIndex: seq,
      timestampMs: seq * 180,
      protocol: 'RTP_VIDEO',
      status:
        hop.status === 'delivered'
          ? 'delivered'
          : mode === 'multicast'
          ? 'broadcast'
          : hop.status,
      vlanTag: hop.vlanTag ?? survVlan,
      decisionTitle:
        hop.status === 'delivered' && hop.toNodeId === nvrNode.id
          ? `${nvrNode.name}: Приём и запись видеопотока RTP (${codec}, ${res}, ${mode === 'multicast' ? `Multicast ${mcastIp}` : 'Unicast'}) с камеры ${cameraNode.name}`
          : `${hop.toNodeName}: Передача потокового видео RTP (${codec}, QoS DSCP ${dscp}, VLAN ${survVlan})`,
      inboundPdu: {
        ...hop.inboundPdu,
        l2: {
          ...hop.inboundPdu.l2,
          headerType: 'IEEE 802.1Q',
          dstMac: videoDstMac || hop.inboundPdu.l2.dstMac,
          vlanTag: hop.vlanTag ?? survVlan,
        },
        l3: {
          ...hop.inboundPdu.l3,
          dstIp: videoDstIp,
          protocol: `UDP (17) · QoS DSCP ${dscp}`,
        },
        l4: {
          type: 'RTP_VIDEO',
          summary: rtpVideoSummary,
          seqNumber: 401,
          srcPort: 5004,
          dstPort: 5004,
        },
        l7: {
          appProtocol: 'RTP',
          headline: `RTP Video Payload — ${codec} (${res})`,
          fields: {
            'Camera Channel': `CH-0${ch}: ${cameraNode.name} (${camCfg.locationName})`,
            'Stream Mode':
              mode === 'multicast'
                ? `IPv4 Multicast Group ${mcastIp}:5004 (MAC ${videoDstMac})`
                : `Unicast RTP ${camIp}:5004 → ${nvrIp}:5004`,
            'Video Bitrate & FPS': `${codec} · ${camCfg.fps || 30} fps · Keyframe I-Slice`,
            'QoS & VLAN': `DSCP ${dscp} · Surveillance VLAN ${survVlan}`,
          },
        },
      },
      outboundPdu: {
        ...hop.outboundPdu,
        l2: {
          ...hop.outboundPdu.l2,
          headerType: 'IEEE 802.1Q',
          dstMac: videoDstMac || hop.outboundPdu.l2.dstMac,
          vlanTag: hop.vlanTag ?? survVlan,
        },
        l3: {
          ...hop.outboundPdu.l3,
          dstIp: videoDstIp,
          protocol: `UDP (17) · QoS DSCP ${dscp}`,
        },
        l4: {
          type: 'RTP_VIDEO',
          summary: rtpVideoSummary,
          seqNumber: 401,
          srcPort: 5004,
          dstPort: 5004,
        },
        l7: {
          appProtocol: 'RTP',
          headline: `RTP Video Payload — ${codec} (${res})`,
          fields: {
            'Camera Channel': `CH-0${ch}: ${cameraNode.name} (${camCfg.locationName})`,
            'Stream Mode':
              mode === 'multicast'
                ? `IPv4 Multicast Group ${mcastIp}:5004 (MAC ${videoDstMac})`
                : `Unicast RTP ${camIp}:5004 → ${nvrIp}:5004`,
            'Video Bitrate & FPS': `${codec} · ${camCfg.fps || 30} fps · Keyframe I-Slice`,
            'QoS & VLAN': `DSCP ${dscp} · Surveillance VLAN ${survVlan}`,
          },
        },
      },
      osiActions: [
        ...hop.osiActions.slice(0, 2),
        {
          layer: 'L7',
          title: `Потоковое видео RTP (${codec} · ${mode === 'multicast' ? `Multicast ${mcastIp}` : `Unicast ${nvrIp}`})`,
          detail: `Передача кадров видеонаблюдения с PoE-камеры ${cameraNode.name} на видеорегистратор ${nvrNode.name} в выделенном VLAN ${survVlan}.`,
        },
      ],
    });
    seq++;
  }

  return result;
}

