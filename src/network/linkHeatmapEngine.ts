import { NetworkInterface, NetworkLink, NetworkNode, SimulationStep } from './types';
import { getEtherChannelBundles, isLinkOperational } from './simulator';
import { isStackInterconnectLink } from './stackEngine';

export type CableDisplayMode = 'standard' | 'bandwidth' | 'qos';

export type QosQueueClass = 'EF' | 'AF41' | 'CS6' | 'BE';

export interface LinkHeatmapMetrics {
  linkId: string;
  isUp: boolean;
  bandwidthMbps: number;
  bandwidthLabel: string;
  latencyMs: number;
  packetLossPercent: number;
  utilizationPercent: number;
  qosQueue: QosQueueClass;
  qosDscpCode: string;
  qosBadgeLabel: string;
  qosFullDescription: string;
  bandwidthStrokeHex: string;
  qosStrokeHex: string;
}

function getEffectivePortBandwidthMbps(
  port: NetworkInterface | undefined,
  cableType: NetworkLink['cableType']
): number {
  if (cableType === 'stack') return 480000;
  if (cableType === 'fiber') return Math.max(port?.bandwidthMbps || 1000, 10000);
  if (cableType === 'wireless') return port?.bandwidthMbps || 300;
  if (port?.bandwidthMbps) return port.bandwidthMbps;
  const short = (port?.shortName || '').toLowerCase();
  if (short.startsWith('gi') || short.startsWith('te')) return 1000;
  return 100;
}

export function formatBandwidthShort(bwMbps: number, poName?: string): string {
  const base =
    bwMbps >= 100000
      ? `${Math.round(bwMbps / 1000)}G`
      : bwMbps >= 1000
      ? `${Number((bwMbps / 1000).toFixed(bwMbps % 1000 === 0 ? 0 : 1))}G`
      : `${bwMbps}M`;
  return poName ? `${base} (${poName})` : base;
}

/**
 * Computes Link Utilization, Bandwidth (100M / 1G / 10G / 480G Stack), Latency (ms),
 * and QoS DiffServ Queue Classification (DSCP EF / AF41 / CS6 / BE) for every link in the topology.
 */
export function computeTopologyLinkHeatmap(params: {
  nodes: NetworkNode[];
  links: NetworkLink[];
  activeStep?: SimulationStep | null;
  activeLinkIds?: string[];
}): Record<string, LinkHeatmapMetrics> {
  const { nodes, links, activeStep, activeLinkIds = [] } = params;
  const bundles = getEtherChannelBundles(nodes, links);
  const result: Record<string, LinkHeatmapMetrics> = {};

  for (const link of links) {
    const srcNode = nodes.find((n) => n.id === link.sourceNodeId);
    const dstNode = nodes.find((n) => n.id === link.targetNodeId);
    if (!srcNode || !dstNode) continue;

    const srcPort = srcNode.interfaces.find((p) => p.id === link.sourcePortId);
    const dstPort = dstNode.interfaces.find((p) => p.id === link.targetPortId);
    const isUp = isLinkOperational(link, nodes);
    const isStack =
      link.cableType === 'stack' || isStackInterconnectLink(link, nodes, links);

    const bundle = bundles.find((b) => b.memberLinkIds.includes(link.id));

    // Resolve WAN impairment or physical latency first so WAN bandwidth shaping applies
    const wanImp =
      link.wanImpairment?.enabled
        ? link.wanImpairment
        : srcNode.wanImpairment?.enabled &&
          (srcNode.deviceModel === 'isp_cloud' || srcPort?.natRole === 'outside')
        ? srcNode.wanImpairment
        : dstNode.wanImpairment?.enabled &&
          (dstNode.deviceModel === 'isp_cloud' || dstPort?.natRole === 'outside')
        ? dstNode.wanImpairment
        : undefined;

    const srcBw = getEffectivePortBandwidthMbps(srcPort, link.cableType);
    const dstBw = getEffectivePortBandwidthMbps(dstPort, link.cableType);
    const physicalBw = isStack
      ? srcNode.type === 'switch' && dstNode.type === 'switch'
        ? 480000
        : 80000
      : bundle
      ? bundle.aggregatedBandwidthMbps
      : Math.min(srcBw, dstBw);

    const rawBw =
      wanImp && wanImp.bandwidthLimitMbps > 0
        ? Math.min(physicalBw, wanImp.bandwidthLimitMbps)
        : physicalBw;

    const bandwidthLabel = isStack
      ? rawBw >= 480000
        ? '480G Stack'
        : '80G HA'
      : link.cableType === 'fiber' && rawBw >= 10000
      ? '10G Fiber'
      : formatBandwidthShort(rawBw, bundle?.portChannelName);

    const latencyMs = wanImp
      ? wanImp.latencyMs
      : isStack
      ? 0.2
      : link.cableType === 'fiber'
      ? 1
      : link.cableType === 'wireless'
      ? 4
      : rawBw >= 1000
      ? 1
      : 2;

    const packetLossPercent = wanImp ? wanImp.packetLossPercent : 0;

    // Determine QoS Queue Class (EF for VoIP, AF41 for RTSP/CCTV, CS6 for Control Plane, BE for Data)
    const isActiveLink =
      activeStep?.linkId === link.id || activeLinkIds.includes(link.id);
    const activeProto = isActiveLink ? activeStep?.protocol : undefined;

    const hasVoipEndpoint =
      srcNode.deviceModel === 'ip_phone' ||
      dstNode.deviceModel === 'ip_phone' ||
      Boolean(srcPort?.voiceVlan) ||
      Boolean(dstPort?.voiceVlan) ||
      Boolean(srcNode.services?.sipEnabled) ||
      Boolean(dstNode.services?.sipEnabled);

    const hasVideoEndpoint =
      srcNode.deviceModel === 'ip_camera' ||
      dstNode.deviceModel === 'ip_camera' ||
      srcNode.deviceModel === 'nvr' ||
      dstNode.deviceModel === 'nvr' ||
      Boolean(srcNode.services?.nvrEnabled) ||
      Boolean(dstNode.services?.nvrEnabled);

    const hasControlPlaneRole =
      isStack ||
      srcNode.deviceModel === 'isp_cloud' ||
      dstNode.deviceModel === 'isp_cloud' ||
      srcNode.deviceModel === 'wlc' ||
      dstNode.deviceModel === 'wlc' ||
      (srcNode.type === 'router' &&
        dstNode.type === 'router' &&
        (Boolean(srcNode.ospfConfig?.enabled) || Boolean(srcNode.bgpConfig?.enabled)));

    let qosQueue: QosQueueClass = 'BE';
    if (
      activeProto === 'SIP_INVITE' ||
      activeProto === 'SIP_TRYING' ||
      activeProto === 'SIP_RINGING' ||
      activeProto === 'SIP_200_OK' ||
      activeProto === 'RTP_AUDIO' ||
      hasVoipEndpoint
    ) {
      qosQueue = 'EF';
    } else if (
      activeProto === 'RTSP_SETUP' ||
      activeProto === 'RTSP_200_OK' ||
      activeProto === 'RTP_VIDEO' ||
      hasVideoEndpoint
    ) {
      qosQueue = 'AF41';
    } else if (
      activeProto === 'OSPF_HELLO' ||
      activeProto === 'OSPF_LSA' ||
      activeProto === 'BGP_OPEN' ||
      activeProto === 'BGP_KEEPALIVE' ||
      activeProto === 'BGP_UPDATE' ||
      activeProto === 'STP_BPDU' ||
      activeProto === 'CAPWAP_CTRL' ||
      activeProto === 'IKEV2_SA' ||
      hasControlPlaneRole
    ) {
      qosQueue = 'CS6';
    } else {
      qosQueue = 'BE';
    }

    const qosMeta: Record<
      QosQueueClass,
      { code: string; badge: string; desc: string; hex: string }
    > = {
      EF: {
        code: 'DSCP 46 (EF)',
        badge: 'QoS EF · CoS 5 (VoIP)',
        desc: 'Strict Priority Queue (DSCP EF 46 / 802.1p CoS 5): голосовой трафик RTP/SIP без буферизации',
        hex: '#e879f9',
      },
      AF41: {
        code: 'DSCP 34 (AF41)',
        badge: 'QoS AF41 · CoS 4 (RTSP)',
        desc: 'Assured Forwarding Class 4 (DSCP AF41 34 / CoS 4): потоковое видео RTSP H.265 и Multicast NVR',
        hex: '#2dd4bf',
      },
      CS6: {
        code: 'DSCP 48 (CS6)',
        badge: 'QoS CS6 · Control (OSPF/BGP)',
        desc: 'Internetwork Control (DSCP CS6 48 / CoS 6): служебные пакеты маршрутизации OSPF, eBGP, STP и CAPWAP',
        hex: '#f59e0b',
      },
      BE: {
        code: 'DSCP 0 (BE)',
        badge: 'QoS BE · CoS 0 (Data)',
        desc: 'Best Effort (DSCP 0 / CoS 0): стандартная очередь передачи данных HTTP, DNS, DHCP и ICMP',
        hex: '#60a5fa',
      },
    };

    // Compute realistic link utilization percentage (0..100%)
    let utilizationPercent = 0;
    if (isUp) {
      if (qosQueue === 'AF41') {
        utilizationPercent = rawBw <= 100 ? 38 : 14; // 4K H.265 video stream ~25-38 Mbps
      } else if (qosQueue === 'EF') {
        utilizationPercent = rawBw <= 100 ? 12 : 4; // VoIP RTP G.711 + signalling
      } else if (qosQueue === 'CS6') {
        utilizationPercent = isStack ? 6 : 9;
      } else {
        utilizationPercent = rawBw <= 100 ? 8 : 3;
      }
      if (isActiveLink) {
        utilizationPercent = Math.min(96, utilizationPercent + 42);
      }
      if (wanImp && wanImp.bandwidthLimitMbps > 0 && wanImp.bandwidthLimitMbps <= 100) {
        utilizationPercent = Math.min(95, Math.max(utilizationPercent, 54));
      }
    }

    const bandwidthStrokeHex = !isUp
      ? '#ef4444'
      : isStack
      ? '#fbbf24'
      : rawBw >= 10000
      ? '#f97316'
      : bundle
      ? '#22d3ee'
      : rawBw >= 1000
      ? '#10b981'
      : link.cableType === 'wireless'
      ? '#a855f7'
      : '#38bdf8';

    result[link.id] = {
      linkId: link.id,
      isUp,
      bandwidthMbps: rawBw,
      bandwidthLabel,
      latencyMs,
      packetLossPercent,
      utilizationPercent,
      qosQueue,
      qosDscpCode: qosMeta[qosQueue].code,
      qosBadgeLabel: qosMeta[qosQueue].badge,
      qosFullDescription: qosMeta[qosQueue].desc,
      bandwidthStrokeHex,
      qosStrokeHex: !isUp ? '#ef4444' : qosMeta[qosQueue].hex,
    };
  }

  return result;
}
