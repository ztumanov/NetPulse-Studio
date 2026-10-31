import {
  GponOltConfig,
  GponOntConfig,
  GponOntServicePortMapping,
  GponSplitterRatio,
  NetworkLink,
  NetworkNode,
  SwitchVlanEntry,
} from './types';

export const GPON_DEFAULT_LOS_THRESHOLD_DBM = -28.0;
export const GPON_FIBER_ATTENUATION_DB_PER_KM = 0.35; // ITU-T G.652D Single-Mode Fiber at 1490/1310 nm

export function isGponOltNode(node?: NetworkNode | null): boolean {
  return Boolean(node && (node.deviceModel === 'gpon_olt' || node.gponOltConfig));
}

export function isGponOntNode(node?: NetworkNode | null): boolean {
  return Boolean(node && (node.deviceModel === 'gpon_ont' || node.gponOntConfig));
}

export function isGponLinkPair(nodeA?: NetworkNode | null, nodeB?: NetworkNode | null): boolean {
  if (!nodeA || !nodeB) return false;
  return (
    (isGponOltNode(nodeA) && isGponOntNode(nodeB)) ||
    (isGponOntNode(nodeA) && isGponOltNode(nodeB))
  );
}

export function getGponSplitterInsertionLossDb(ratio: GponSplitterRatio): number {
  switch (ratio) {
    case '1:1':
      return 0.5;
    case '1:8':
      return 10.5;
    case '1:16':
      return 13.8;
    case '1:32':
      return 17.2;
    case '1:64':
      return 20.5;
    default:
      return 13.8;
  }
}

export function generateDefaultGponSn(index: number = 1): string {
  const hexSuffix = (0x1000a0b0 + index * 0x00010203)
    .toString(16)
    .toUpperCase()
    .slice(-8);
  return `HWTC-${hexSuffix}`;
}

export function getDefaultGponOltConfig(authorizedSns?: string[]): GponOltConfig {
  return {
    enabled: true,
    vendorModel: 'Huawei MA5800-X7 GPON OLT',
    sfpClass: 'B+',
    txPowerDbm: 3.5,
    downstreamWavelengthNm: 1490,
    upstreamWavelengthNm: 1310,
    splitterRatio: '1:16',
    requireSnAuth: true,
    authorizedSnList: authorizedSns || [
      generateDefaultGponSn(1),
      generateDefaultGponSn(2),
      generateDefaultGponSn(3),
      generateDefaultGponSn(4),
      'HWTC-1001A2B3',
      'HWTC-1002C4D5',
    ],
    internetVlan: 100,
    iptvVlan: 200,
    voipVlan: 300,
  };
}

export function getDefaultGponOntServicePorts(
  internetVlan: number = 100,
  iptvVlan: number = 200,
  voipVlan: number = 300,
  subscriberIndex: number = 1
): GponOntServicePortMapping[] {
  return [
    {
      portShortName: 'LAN1',
      serviceType: 'internet',
      serviceLabel: 'Порт 1 — Интернет (PPPoE / DHCP)',
      vlanId: internetVlan,
      pppoeUsername: `abonent_0${subscriberIndex}@ftth.isp`,
      qosCos: 0,
    },
    {
      portShortName: 'LAN2',
      serviceType: 'iptv',
      serviceLabel: 'Порт 2 — IPTV Multicast (IGMP)',
      vlanId: iptvVlan,
      igmpMulticastGroup: '239.255.1.1',
      qosCos: 4,
    },
    {
      portShortName: 'LAN3',
      serviceType: 'voip',
      serviceLabel: 'Порт 3 — VoIP Телефония (SIP / RTP)',
      vlanId: voipVlan,
      qosCos: 5,
    },
  ];
}

export function getDefaultGponOntConfig(
  index: number = 1,
  customSn?: string
): GponOntConfig {
  return {
    enabled: true,
    vendorModel: 'Huawei EchoLife HG8245H GPON ONT',
    gponSn: customSn || generateDefaultGponSn(index),
    distanceKm: 4.0,
    extraAttenuationDb: 2.0,
    losThresholdDbm: GPON_DEFAULT_LOS_THRESHOLD_DBM,
    overloadThresholdDbm: -8.0,
    txPowerDbm: 2.5,
    servicePorts: getDefaultGponOntServicePorts(100, 200, 300, index),
  };
}

/**
 * Synchronizes an ONT node's LAN1..LAN3 access VLANs, Voice VLANs, and PON0 trunk allowed VLANs
 * with its `gponOntConfig.servicePorts`.
 */
export function syncOntInterfacesWithServicePorts(ontNode: NetworkNode): NetworkNode {
  if (!ontNode.gponOntConfig) return ontNode;
  const servicePorts = ontNode.gponOntConfig.servicePorts || [];
  const serviceVlans = Array.from(
    new Set([1, 10, 20, 30, 100, 200, 300, ...servicePorts.map((sp) => sp.vlanId)])
  ).sort((a, b) => a - b);

  const updatedInterfaces = ontNode.interfaces.map((iface) => {
    if (iface.shortName.toUpperCase().startsWith('PON')) {
      return {
        ...iface,
        vlanMode: 'trunk' as const,
        trunkAllowedVlans: serviceVlans,
      };
    }

    const mapping = servicePorts.find(
      (sp) => sp.portShortName.toUpperCase() === iface.shortName.toUpperCase()
    );
    if (!mapping) return iface;

    return {
      ...iface,
      name: `${iface.shortName} (${mapping.serviceLabel} · VLAN ${mapping.vlanId})`,
      vlanMode: 'access' as const,
      accessVlan: mapping.vlanId,
      voiceVlan: mapping.serviceType === 'voip' ? mapping.vlanId : undefined,
      poeEnabled: mapping.serviceType === 'voip' ? true : iface.poeEnabled,
      trunkAllowedVlans: [mapping.vlanId],
    };
  });

  const existingVlans = ontNode.vlanDatabase || [];
  const nextVlanDb: SwitchVlanEntry[] = [...existingVlans];
  for (const sp of servicePorts) {
    if (!nextVlanDb.some((v) => v.id === sp.vlanId)) {
      nextVlanDb.push({
        id: sp.vlanId,
        name:
          sp.serviceType === 'internet'
            ? `GPON_Internet_${sp.vlanId}`
            : sp.serviceType === 'iptv'
            ? `GPON_IPTV_${sp.vlanId}`
            : sp.serviceType === 'voip'
            ? `GPON_VoIP_${sp.vlanId}`
            : `GPON_Service_${sp.vlanId}`,
        subnetHint: sp.serviceLabel,
      });
    }
  }

  return {
    ...ontNode,
    interfaces: updatedInterfaces,
    vlanDatabase: nextVlanDb.sort((a, b) => a.id - b.id),
  };
}

export interface GponOntOpticalState {
  ontNodeId: string;
  ontName: string;
  gponSn: string;
  serialNumber: string;
  oltNode?: NetworkNode;
  oltPortShortName?: string;
  ontPonPortShortName?: string;
  linkId?: string;
  downstreamWavelengthNm: 1490;
  upstreamWavelengthNm: 1310;
  oltTxPowerDbm: number;
  ontTxPowerDbm: number;
  splitterRatio: GponSplitterRatio;
  splitterLossDb: number;
  distanceKm: number;
  fiberLossDb: number;
  extraAttenuationDb: number;
  totalLossDb: number;
  rxPowerDbm: number;
  losThresholdDbm: number;
  opticalMarginDb: number;
  hasPhysicalPonLink: boolean;
  isLos: boolean;
  isSnAuthorized: boolean;
  isOperational: boolean;
  isPonUp: boolean;
  status: 'online' | 'los_low_power' | 'los_no_link' | 'unauth_sn' | 'disabled';
  signalQuality: 'excellent' | 'good' | 'marginal' | 'los';
  reasonRu: string;
}

/**
 * Computes real-time GPON optical power budget (dBm), LOS (< -28.0 dBm) state,
 * and GPON-SN authorization state for a subscriber ONT/ONU.
 */
export function computeGponOntOpticalState(
  ontNode: NetworkNode,
  allNodes: NetworkNode[],
  allLinks: NetworkLink[]
): GponOntOpticalState {
  const ontCfg = ontNode.gponOntConfig || getDefaultGponOntConfig(1);
  const losThresholdDbm = ontCfg.losThresholdDbm ?? GPON_DEFAULT_LOS_THRESHOLD_DBM;

  // Find link between this ONT and any GPON OLT
  let matchedLink: NetworkLink | undefined;
  let oltNode: NetworkNode | undefined;
  let oltPortShortName: string | undefined;
  let ontPonPortShortName: string | undefined;
  let portsAdminUp = false;

  for (const link of allLinks) {
    const isSourceOnt = link.sourceNodeId === ontNode.id;
    const isTargetOnt = link.targetNodeId === ontNode.id;
    if (!isSourceOnt && !isTargetOnt) continue;

    const peerId = isSourceOnt ? link.targetNodeId : link.sourceNodeId;
    const peer = allNodes.find((n) => n.id === peerId);
    if (!peer || !isGponOltNode(peer)) continue;

    const ontPortId = isSourceOnt ? link.sourcePortId : link.targetPortId;
    const oltPortId = isSourceOnt ? link.targetPortId : link.sourcePortId;
    const ontPort = ontNode.interfaces.find((i) => i.id === ontPortId);
    const oltPort = peer.interfaces.find((i) => i.id === oltPortId);

    matchedLink = link;
    oltNode = peer;
    oltPortShortName = oltPort?.shortName || 'PON0/1';
    ontPonPortShortName = ontPort?.shortName || 'PON0';
    portsAdminUp =
      ontPort?.adminStatus === 'up' && oltPort?.adminStatus === 'up';
    break;
  }

  const oltCfg = oltNode?.gponOltConfig || getDefaultGponOltConfig();
  const oltTxPowerDbm = oltCfg.txPowerDbm ?? 3.5;
  const splitterRatio: GponSplitterRatio = oltCfg.splitterRatio || '1:16';
  const splitterLossDb = getGponSplitterInsertionLossDb(splitterRatio);
  const distanceKm = Math.max(0, Number(ontCfg.distanceKm ?? 4.0));
  const fiberLossDb =
    Math.round(distanceKm * GPON_FIBER_ATTENUATION_DB_PER_KM * 100) / 100;
  const extraAttenuationDb = Math.max(0, Number(ontCfg.extraAttenuationDb ?? 2.0));
  const totalLossDb =
    Math.round((splitterLossDb + fiberLossDb + extraAttenuationDb) * 100) / 100;
  const rxPowerDbm =
    matchedLink && portsAdminUp
      ? Math.round((oltTxPowerDbm - totalLossDb) * 100) / 100
      : -40.0;
  const opticalMarginDb =
    Math.round((rxPowerDbm - losThresholdDbm) * 100) / 100;

  if (!ontCfg.enabled || (oltNode && oltCfg.enabled === false)) {
    return {
      ontNodeId: ontNode.id,
      ontName: ontNode.name,
      gponSn: ontCfg.gponSn,
      serialNumber: ontCfg.gponSn,
      oltNode,
      oltPortShortName,
      ontPonPortShortName,
      linkId: matchedLink?.id,
      downstreamWavelengthNm: 1490,
      upstreamWavelengthNm: 1310,
      oltTxPowerDbm,
      ontTxPowerDbm: ontCfg.txPowerDbm ?? 2.5,
      splitterRatio,
      splitterLossDb,
      distanceKm,
      fiberLossDb,
      extraAttenuationDb,
      totalLossDb,
      rxPowerDbm: -40.0,
      losThresholdDbm,
      opticalMarginDb: -12.0,
      hasPhysicalPonLink: Boolean(matchedLink),
      isLos: true,
      isSnAuthorized: false,
      isOperational: false,
      isPonUp: false,
      status: 'disabled',
      signalQuality: 'los',
      reasonRu: `Оптический трансивер GPON административно отключён.`,
    };
  }

  if (!matchedLink || !oltNode || !portsAdminUp) {
    return {
      ontNodeId: ontNode.id,
      ontName: ontNode.name,
      gponSn: ontCfg.gponSn,
      serialNumber: ontCfg.gponSn,
      oltNode,
      oltPortShortName,
      ontPonPortShortName,
      linkId: matchedLink?.id,
      downstreamWavelengthNm: 1490,
      upstreamWavelengthNm: 1310,
      oltTxPowerDbm,
      ontTxPowerDbm: ontCfg.txPowerDbm ?? 2.5,
      splitterRatio,
      splitterLossDb,
      distanceKm,
      fiberLossDb,
      extraAttenuationDb,
      totalLossDb,
      rxPowerDbm: -40.0,
      losThresholdDbm,
      opticalMarginDb: -12.0,
      hasPhysicalPonLink: false,
      isLos: true,
      isSnAuthorized: false,
      isOperational: false,
      isPonUp: false,
      status: 'los_no_link',
      signalQuality: 'los',
      reasonRu: !matchedLink
        ? `Авария LOS: оптический порт PON0 терминала ${ontNode.name} не подключён к OLT.`
        : `Авария LOS: оптический порт ${oltPortShortName || 'PON'} выключен (shutdown).`,
    };
  }

  const isLowPowerLos = rxPowerDbm < losThresholdDbm;
  const cleanSn = ontCfg.gponSn.trim().toUpperCase();
  const isSnAuthorized =
    !oltCfg.requireSnAuth ||
    oltCfg.authorizedSnList.some((sn) => sn.trim().toUpperCase() === cleanSn);

  if (isLowPowerLos) {
    return {
      ontNodeId: ontNode.id,
      ontName: ontNode.name,
      gponSn: ontCfg.gponSn,
      serialNumber: ontCfg.gponSn,
      oltNode,
      oltPortShortName,
      ontPonPortShortName,
      linkId: matchedLink.id,
      downstreamWavelengthNm: 1490,
      upstreamWavelengthNm: 1310,
      oltTxPowerDbm,
      ontTxPowerDbm: ontCfg.txPowerDbm ?? 2.5,
      splitterRatio,
      splitterLossDb,
      distanceKm,
      fiberLossDb,
      extraAttenuationDb,
      totalLossDb,
      rxPowerDbm,
      losThresholdDbm,
      opticalMarginDb,
      hasPhysicalPonLink: true,
      isLos: true,
      isSnAuthorized,
      isOperational: false,
      isPonUp: false,
      status: 'los_low_power',
      signalQuality: 'los',
      reasonRu: `Авария GPON LOS (Loss of Signal): уровень оптического сигнала на ${ontNode.name} упал до ${rxPowerDbm} dBm (ниже порога чувствительности ${losThresholdDbm} dBm, суммарное затухание ${totalLossDb} dB).`,
    };
  }

  if (!isSnAuthorized) {
    return {
      ontNodeId: ontNode.id,
      ontName: ontNode.name,
      gponSn: ontCfg.gponSn,
      serialNumber: ontCfg.gponSn,
      oltNode,
      oltPortShortName,
      ontPonPortShortName,
      linkId: matchedLink.id,
      downstreamWavelengthNm: 1490,
      upstreamWavelengthNm: 1310,
      oltTxPowerDbm,
      ontTxPowerDbm: ontCfg.txPowerDbm ?? 2.5,
      splitterRatio,
      splitterLossDb,
      distanceKm,
      fiberLossDb,
      extraAttenuationDb,
      totalLossDb,
      rxPowerDbm,
      losThresholdDbm,
      opticalMarginDb,
      hasPhysicalPonLink: true,
      isLos: false,
      isSnAuthorized: false,
      isOperational: false,
      isPonUp: false,
      status: 'unauth_sn',
      signalQuality: rxPowerDbm >= -23 ? 'excellent' : rxPowerDbm >= -26 ? 'good' : 'marginal',
      reasonRu: `Блокировка GPON PLOAM/OMCI: серийный номер ONT ${ontCfg.gponSn} не авторизован на OLT ${oltNode.name}.`,
    };
  }

  const signalQuality =
    rxPowerDbm >= -22.0
      ? 'excellent'
      : rxPowerDbm >= -25.5
      ? 'good'
      : 'marginal';

  return {
    ontNodeId: ontNode.id,
    ontName: ontNode.name,
    gponSn: ontCfg.gponSn,
    serialNumber: ontCfg.gponSn,
    oltNode,
    oltPortShortName,
    ontPonPortShortName,
    linkId: matchedLink.id,
    downstreamWavelengthNm: 1490,
    upstreamWavelengthNm: 1310,
    oltTxPowerDbm,
    ontTxPowerDbm: ontCfg.txPowerDbm ?? 2.5,
    splitterRatio,
    splitterLossDb,
    distanceKm,
    fiberLossDb,
    extraAttenuationDb,
    totalLossDb,
    rxPowerDbm,
    losThresholdDbm,
    opticalMarginDb,
    hasPhysicalPonLink: true,
    isLos: false,
    isSnAuthorized: true,
    isOperational: true,
    isPonUp: true,
    status: 'online',
    signalQuality,
    reasonRu: `Оптический канал GPON активен (1490 нм TX / 1310 нм RX · сигнал ${rxPowerDbm} dBm · запас +${opticalMarginDb} dB · SN ${ontCfg.gponSn} O5 Associated).`,
  };
}

/**
 * Returns all ONT terminals connected to a given GPON OLT node along with their optical states.
 */
export function computeGponOltConnectedOnts(
  oltNode: NetworkNode,
  allNodes: NetworkNode[],
  allLinks: NetworkLink[]
): GponOntOpticalState[] {
  const connectedOnts: GponOntOpticalState[] = [];
  for (const n of allNodes) {
    if (!isGponOntNode(n)) continue;
    const state = computeGponOntOpticalState(n, allNodes, allLinks);
    if (state.oltNode?.id === oltNode.id) {
      connectedOnts.push(state);
    }
  }
  return connectedOnts;
}

export interface GponLinkTransferEvaluation {
  isGponLink: boolean;
  allowed: boolean;
  direction?: 'downstream_1490nm' | 'upstream_1310nm';
  wavelengthNm?: 1490 | 1310;
  ontState?: GponOntOpticalState;
  dropTitle?: string;
  dropDetail?: string;
  passSummary?: string;
}

/**
 * Evaluates whether a frame can traverse a GPON fiber link between an OLT and an ONT.
 */
export function evaluateGponLinkTransfer(
  senderNode: NetworkNode,
  peerNode: NetworkNode,
  allNodes: NetworkNode[],
  allLinks: NetworkLink[]
): GponLinkTransferEvaluation {
  if (!isGponLinkPair(senderNode, peerNode)) {
    return { isGponLink: false, allowed: true };
  }

  const isDownstream = isGponOltNode(senderNode) && isGponOntNode(peerNode);
  const ontNode = isDownstream ? peerNode : senderNode;
  const oltNode = isDownstream ? senderNode : peerNode;
  const ontState = computeGponOntOpticalState(ontNode, allNodes, allLinks);

  if (ontState.isLos) {
    return {
      isGponLink: true,
      allowed: false,
      direction: isDownstream ? 'downstream_1490nm' : 'upstream_1310nm',
      wavelengthNm: isDownstream ? 1490 : 1310,
      ontState,
      dropTitle: `GPON L1 Optical Drop (LOS): На терминале ${ontNode.name} горит красный индикатор LOS (${ontState.rxPowerDbm} dBm < ${ontState.losThresholdDbm} dBm)`,
      dropDetail: `${ontState.reasonRu} Передача на длинах волн 1490 нм / 1310 нм прервана из-за превышения оптического бюджета потерь (${ontState.totalLossDb} dB: сплиттер ${ontState.splitterRatio} [-${ontState.splitterLossDb} dB] + трасса ${ontState.distanceKm} км [-${ontState.fiberLossDb} dB] + доп. затухание [-${ontState.extraAttenuationDb} dB]).`,
    };
  }

  if (!ontState.isSnAuthorized) {
    return {
      isGponLink: true,
      allowed: false,
      direction: isDownstream ? 'downstream_1490nm' : 'upstream_1310nm',
      wavelengthNm: isDownstream ? 1490 : 1310,
      ontState,
      dropTitle: `GPON OMCI Auth Drop: Серийный номер ONT ${ontState.gponSn} не авторизован на OLT ${oltNode.name}`,
      dropDetail: `Оптический уровень в норме (${ontState.rxPowerDbm} dBm), однако терминал ${ontNode.name} с серийным номером GPON-SN «${ontState.gponSn}» отсутствует в таблице авторизованных ONU на OLT ${oltNode.name}. Кадры GEM блокируются.`,
    };
  }

  const wavelength = isDownstream ? 1490 : 1310;
  return {
    isGponLink: true,
    allowed: true,
    direction: isDownstream ? 'downstream_1490nm' : 'upstream_1310nm',
    wavelengthNm: wavelength,
    ontState,
    passSummary: isDownstream
      ? `GPON Downstream 1490 нм (OLT TX +${ontState.oltTxPowerDbm} dBm → Сплиттер ${ontState.splitterRatio} → ONT RX ${ontState.rxPowerDbm} dBm · SN ${ontState.gponSn})`
      : `GPON Upstream 1310 нм TDMA (ONT ${ontState.gponSn} TX +${ontState.ontTxPowerDbm} dBm → OLT ${oltNode.name} · Оптический бюджет ${ontState.rxPowerDbm} dBm)`,
  };
}
