import { NetworkLink, NetworkNode, SimulationStep } from './types';
import { getNetworkAddress, isSameSubnet, isValidIpv4, maskToCidr } from './ipMath';
import { addRouterStaticRoute, getSuggestedStaticRoutes } from './routerGuiHelpers';
import { getRouterLogicalInterfaces, syncAllRoutersRoutingTables } from './simulator';
import { getPoweredDevicePoeState } from './poeAndVoipEngine';
import { upsertDeviceVlan } from './hardwareChassis';
import {
  computeGponOntOpticalState,
  isGponOntNode,
} from './gponEngine';

export type TroubleCategory =
  | 'GATEWAY'
  | 'VLAN'
  | 'ROUTING'
  | 'ACL'
  | 'FIREWALL'
  | 'POE'
  | 'WAN'
  | 'INTERFACE'
  | 'GPON';

export interface NetworkTroubleDiagnostic {
  id: string;
  category: TroubleCategory;
  severity: 'critical' | 'warning';
  nodeId: string;
  nodeName: string;
  title: string;
  explanation: string;
  cliHint: string;
  fixButtonLabel: string;
  applyFix: (
    nodes: NetworkNode[],
    links: NetworkLink[]
  ) => {
    updatedNodes: NetworkNode[];
    updatedLinks: NetworkLink[];
    fixedMessage: string;
  };
}

/**
 * Finds a gateway router or L3 switch SVI IP in the same subnet as `hostIp`/`hostMask`.
 */
function findGatewayInSubnet(
  hostIp: string,
  hostMask: string,
  nodes: NetworkNode[]
): { gatewayIp: string; ownerName: string } | null {
  if (!isValidIpv4(hostIp)) return null;

  for (const n of nodes) {
    if (n.type === 'router') {
      const logical = getRouterLogicalInterfaces(n);
      for (const iface of logical) {
        if (
          isValidIpv4(iface.ipAddress) &&
          isSameSubnet(hostIp, iface.ipAddress, hostMask)
        ) {
          return { gatewayIp: iface.ipAddress, ownerName: `${n.name} (${iface.logicalName})` };
        }
      }
      if (
        n.stackConfig?.enabled &&
        n.stackConfig.virtualIp &&
        isValidIpv4(n.stackConfig.virtualIp) &&
        isSameSubnet(hostIp, n.stackConfig.virtualIp, hostMask)
      ) {
        return {
          gatewayIp: n.stackConfig.virtualIp,
          ownerName: `${n.name} (HSRP VIP)`,
        };
      }
    }
    if (n.type === 'switch' && n.ipRoutingEnabled && Array.isArray(n.sviInterfaces)) {
      for (const svi of n.sviInterfaces) {
        if (
          isValidIpv4(svi.ipAddress) &&
          isSameSubnet(hostIp, svi.ipAddress, hostMask)
        ) {
          return {
            gatewayIp: svi.ipAddress,
            ownerName: `${n.name} (SVI Vlan${svi.vlanId})`,
          };
        }
      }
    }
  }

  // Fallback to .1 in the host's network
  const netAddr = getNetworkAddress(hostIp, hostMask);
  const parts = netAddr.split('.');
  if (parts.length === 4) {
    const fallbackGw = `${parts[0]}.${parts[1]}.${parts[2]}.1`;
    if (fallbackGw !== hostIp) {
      return { gatewayIp: fallbackGw, ownerName: 'Шлюз подсети (.1)' };
    }
  }
  return null;
}

/**
 * Determines the expected VLAN for an endpoint node (IP Camera, VoIP Phone, or PC/Server based on its subnet/router subinterface).
 */
function inferExpectedVlanForEndpoint(
  endpoint: NetworkNode,
  nodes: NetworkNode[]
): number | null {
  if (endpoint.deviceModel === 'ip_camera' && endpoint.ipCameraConfig?.surveillanceVlan) {
    return endpoint.ipCameraConfig.surveillanceVlan;
  }
  if (endpoint.deviceModel === 'ip_phone' && endpoint.voipConfig?.voiceVlan) {
    return endpoint.voipConfig.dataVlan || endpoint.voipConfig.voiceVlan;
  }

  const iface = endpoint.interfaces[0];
  if (!iface || !isValidIpv4(iface.ipAddress)) return null;

  // Check if any router 802.1Q subinterface or L3 Switch SVI matches this endpoint's subnet
  for (const n of nodes) {
    if (n.type === 'router') {
      for (const p of n.interfaces) {
        for (const sub of p.subinterfaces || []) {
          if (
            isValidIpv4(sub.ipAddress) &&
            isSameSubnet(iface.ipAddress, sub.ipAddress, iface.subnetMask)
          ) {
            return sub.vlanId;
          }
        }
      }
    }
    if (n.type === 'switch' && Array.isArray(n.sviInterfaces)) {
      for (const svi of n.sviInterfaces) {
        if (
          isValidIpv4(svi.ipAddress) &&
          isSameSubnet(iface.ipAddress, svi.ipAddress, iface.subnetMask)
        ) {
          return svi.vlanId;
        }
      }
    }
  }

  // Or check if another endpoint with the same subnet is on a specific non-1 access VLAN
  if (iface.accessVlan && iface.accessVlan !== 1) {
    return iface.accessVlan;
  }

  return null;
}

/**
 * Analyzes simulation steps, summary messages, and topology state to produce actionable
 * 1-click troubleshooting diagnostics in Russian.
 */
export function analyzeNetworkTroubles(params: {
  nodes: NetworkNode[];
  links: NetworkLink[];
  steps: SimulationStep[];
  summaryMessage: string;
  sourceNodeId?: string | null;
  targetIp?: string | null;
}): NetworkTroubleDiagnostic[] {
  const { nodes, links, steps, summaryMessage } = params;
  const diagnostics: NetworkTroubleDiagnostic[] = [];
  const addedIds = new Set<string>();

  const pushUnique = (diag: NetworkTroubleDiagnostic) => {
    if (!addedIds.has(diag.id)) {
      addedIds.add(diag.id);
      diagnostics.push(diag);
    }
  };

  const droppedSteps = steps.filter(
    (s) =>
      s.status === 'dropped' &&
      !s.outboundPdu?.outPort?.includes('Not for this host')
  );
  const droppedStep =
    droppedSteps[droppedSteps.length - 1] ||
    steps.find((s) => s.status === 'dropped');
  const firstStep = steps[0];
  const nonArpStep = steps.find(
    (s) => s.protocol !== 'ARP_REQUEST' && s.protocol !== 'ARP_REPLY'
  );
  const srcNodeObj = params.sourceNodeId
    ? nodes.find((n) => n.id === params.sourceNodeId)
    : undefined;
  const srcIpFromSteps =
    nonArpStep?.inboundPdu?.l3?.srcIp ||
    firstStep?.inboundPdu?.l3?.srcIp ||
    srcNodeObj?.interfaces[0]?.ipAddress ||
    '';
  const ipMatchInSummary = summaryMessage.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g);
  const dstIpFromSteps =
    params.targetIp ||
    nonArpStep?.outboundPdu?.l3?.dstIp ||
    (droppedStep &&
    droppedStep.protocol !== 'ARP_REQUEST' &&
    droppedStep.protocol !== 'ARP_REPLY'
      ? droppedStep.inboundPdu?.l3?.dstIp
      : '') ||
    (ipMatchInSummary ? ipMatchInSummary[ipMatchInSummary.length - 1] : '') ||
    firstStep?.outboundPdu?.l3?.dstIp ||
    '';

  // 1. Check PoE Power Cutoff on Powered Devices (IP Phones, IP Cameras, Wi-Fi APs)
  for (const node of nodes) {
    if (
      node.deviceModel === 'ip_phone' ||
      node.deviceModel === 'ip_camera' ||
      node.deviceModel === 'wifi_ap'
    ) {
      const poeState = getPoweredDevicePoeState(node, nodes, links);
      if (!poeState.isPowered && poeState.switchNodeName && poeState.switchPortName) {
        const swNode = nodes.find((n) => n.name === poeState.switchNodeName);
        const swPort = swNode?.interfaces.find(
          (i) => i.shortName === poeState.switchPortName
        );
        if (swNode && swPort) {
          pushUnique({
            id: `poe-off-${swNode.id}-${swPort.id}`,
            category: 'POE',
            severity: 'critical',
            nodeId: swNode.id,
            nodeName: swNode.name,
            title: `Устройство ${node.name} обесточено: отключено питание PoE на порту ${swNode.name}:${swPort.shortName}`,
            explanation: `На порту ${swPort.shortName} коммутатора ${swNode.name} выключена подача питания PoE (power inline never) или превышен бюджет мощности. Из-за этого ${node.name} не может передавать трафик.`,
            cliHint: `interface ${swPort.shortName} → power inline auto`,
            fixButtonLabel: `Включить PoE на ${swNode.name}:${swPort.shortName}`,
            applyFix: (currNodes, currLinks) => {
              const updatedNodes = currNodes.map((n) =>
                n.id === swNode.id
                  ? {
                      ...n,
                      poeConfig: {
                        enabled: true,
                        totalBudgetWatts: n.poeConfig?.totalBudgetWatts || 370,
                        standard: n.poeConfig?.standard || '802.3at (PoE+)',
                      },
                      interfaces: n.interfaces.map((i) =>
                        i.id === swPort.id ? { ...i, poeEnabled: true } : i
                      ),
                    }
                  : n
              );
              return {
                updatedNodes: syncAllRoutersRoutingTables(updatedNodes, currLinks),
                updatedLinks: currLinks,
                fixedMessage: `[Авто-исправление]: Питание PoE 802.3af/at подано на порт ${swNode.name}:${swPort.shortName} — устройство ${node.name} включено.`,
              };
            },
          });
        }
      }
    }
  }

  // 2. Check Missing or Invalid Default Gateway on Endpoints
  const candidateEndpoints = nodes.filter(
    (n) => n.type === 'pc' || n.type === 'server'
  );
  for (const ep of candidateEndpoints) {
    const iface = ep.interfaces[0];
    if (!iface || !isValidIpv4(iface.ipAddress)) continue;

    const gwInfo = findGatewayInSubnet(iface.ipAddress, iface.subnetMask, nodes);
    if (!gwInfo) continue;

    const hasMissingGw = !ep.defaultGateway || !ep.defaultGateway.trim();
    const hasWrongSubnetGw =
      Boolean(ep.defaultGateway?.trim()) &&
      (!isValidIpv4(ep.defaultGateway!) ||
        !isSameSubnet(iface.ipAddress, ep.defaultGateway!, iface.subnetMask));

    const isRelevantToFailure =
      summaryMessage.includes(ep.name) ||
      summaryMessage.toLowerCase().includes('шлюз') ||
      summaryMessage.toLowerCase().includes('gateway') ||
      srcIpFromSteps === iface.ipAddress ||
      dstIpFromSteps === iface.ipAddress ||
      params.sourceNodeId === ep.id;

    if ((hasMissingGw || hasWrongSubnetGw) && (isRelevantToFailure || steps.length === 0)) {
      pushUnique({
        id: `gw-missing-${ep.id}`,
        category: 'GATEWAY',
        severity: 'critical',
        nodeId: ep.id,
        nodeName: ep.name,
        title: hasMissingGw
          ? `На узле ${ep.name} не задан шлюз по умолчанию (Default Gateway)`
          : `На узле ${ep.name} указан шлюз (${ep.defaultGateway}) из чужой подсети`,
        explanation: `Узел ${ep.name} (${iface.ipAddress}/${maskToCidr(
          iface.subnetMask
        )}) не может обмениваться пакетами с другими подсетями и VLAN без корректного шлюза. В этой подсети доступен шлюз ${
          gwInfo.gatewayIp
        } на ${gwInfo.ownerName}.`,
        cliHint: `ip default-gateway ${gwInfo.gatewayIp}`,
        fixButtonLabel: `Прописать шлюз ${gwInfo.gatewayIp} на ${ep.name}`,
        applyFix: (currNodes, currLinks) => {
          const updatedNodes = currNodes.map((n) =>
            n.id === ep.id ? { ...n, defaultGateway: gwInfo.gatewayIp } : n
          );
          return {
            updatedNodes: syncAllRoutersRoutingTables(updatedNodes, currLinks),
            updatedLinks: currLinks,
            fixedMessage: `[Авто-исправление]: На устройстве ${ep.name} прописан шлюз по умолчанию (Default Gateway) ${gwInfo.gatewayIp}.`,
          };
        },
      });
    }
  }

  // 3. Check Switch Access VLAN Mismatch (e.g., Switch port in VLAN 1 while IP-Camera / PC is in VLAN 30 / 10 / 20)
  for (const ep of candidateEndpoints) {
    const expectedVlan = inferExpectedVlanForEndpoint(ep, nodes);
    if (!expectedVlan) continue;

    const epIface = ep.interfaces[0];
    if (!epIface) continue;

    const link = links.find(
      (l) =>
        (l.sourceNodeId === ep.id && l.sourcePortId === epIface.id) ||
        (l.targetNodeId === ep.id && l.targetPortId === epIface.id)
    );
    if (!link) continue;

    const peerNodeId = link.sourceNodeId === ep.id ? link.targetNodeId : link.sourceNodeId;
    const peerPortId = link.sourceNodeId === ep.id ? link.targetPortId : link.sourcePortId;
    const swNode = nodes.find((n) => n.id === peerNodeId && n.type === 'switch');
    const swPort = swNode?.interfaces.find((i) => i.id === peerPortId);

    const isDedicatedVoicePort =
      ep.deviceModel === 'ip_phone' &&
      Boolean(ep.voipConfig?.voiceVlan) &&
      swPort?.accessVlan === ep.voipConfig?.voiceVlan;

    if (
      swNode &&
      swPort &&
      swPort.vlanMode === 'access' &&
      swPort.accessVlan !== expectedVlan &&
      !isDedicatedVoicePort
    ) {
      pushUnique({
        id: `vlan-mismatch-${swNode.id}-${swPort.id}-${expectedVlan}`,
        category: 'VLAN',
        severity: 'critical',
        nodeId: swNode.id,
        nodeName: swNode.name,
        title: `Порт коммутатора ${swNode.name}:${swPort.shortName} в VLAN ${swPort.accessVlan}, а устройство ${ep.name} относится к VLAN ${expectedVlan}`,
        explanation: `Кадры от ${ep.name} (${epIface.ipAddress}) попадают в VLAN ${swPort.accessVlan} вместо целевого VLAN ${expectedVlan}, поэтому не доходят до шлюза или видеорегистратора/сервера в VLAN ${expectedVlan}.`,
        cliHint: `interface ${swPort.shortName} → switchport mode access → switchport access vlan ${expectedVlan}`,
        fixButtonLabel: `Перевести порт ${swPort.shortName} в Access VLAN ${expectedVlan}`,
        applyFix: (currNodes, currLinks) => {
          const updatedNodes = currNodes.map((n) => {
            if (n.id === swNode.id) {
              const withVlan = upsertDeviceVlan(
                n,
                expectedVlan,
                `VLAN_${expectedVlan}`
              );
              return {
                ...withVlan,
                interfaces: withVlan.interfaces.map((i) =>
                  i.id === swPort.id
                    ? { ...i, vlanMode: 'access' as const, accessVlan: expectedVlan }
                    : i
                ),
              };
            }
            if (n.id === ep.id) {
              return {
                ...n,
                interfaces: n.interfaces.map((i, idx) =>
                  idx === 0 ? { ...i, accessVlan: expectedVlan } : i
                ),
              };
            }
            return n;
          });
          return {
            updatedNodes: syncAllRoutersRoutingTables(updatedNodes, currLinks),
            updatedLinks: currLinks,
            fixedMessage: `[Авто-исправление]: Порт ${swNode.name}:${swPort.shortName} переведён в Access VLAN ${expectedVlan} для устройства ${ep.name}.`,
          };
        },
      });
    }
  }

  // 4. Analyze Dropped Steps on Router / Firewall / Switch / WAN Link
  for (const dStep of droppedSteps) {
    const dropNode =
      nodes.find((n) => n.id === dStep.toNodeId) ||
      nodes.find((n) => n.id === dStep.fromNodeId);

    // 4a. ACL Drop
    if (dropNode && dStep.decisionTitle.includes('ACL Drop')) {
      const blockingRule = (dropNode.aclRules || [])
        .filter((r) => r.enabled !== false && r.action === 'deny')
        .sort((a, b) => a.seq - b.seq)[0];

      if (blockingRule) {
        pushUnique({
          id: `acl-drop-${dropNode.id}-${blockingRule.id}`,
          category: 'ACL',
          severity: 'critical',
          nodeId: dropNode.id,
          nodeName: dropNode.name,
          title: `Пакет заблокирован правилом ACL Seq #${blockingRule.seq} на маршрутизаторе ${dropNode.name}`,
          explanation: `Расширенный список контроля доступа (Extended ACL 100) на узле ${dropNode.name} содержит запрещающее правило: seq ${blockingRule.seq} deny ${blockingRule.protocol} ${blockingRule.srcIp} → ${blockingRule.dstIp}.`,
          cliHint: `no access-list 100 seq ${blockingRule.seq}`,
          fixButtonLabel: `Отключить правило ACL Seq #${blockingRule.seq} на ${dropNode.name}`,
          applyFix: (currNodes, currLinks) => {
            const updatedNodes = currNodes.map((n) =>
              n.id === dropNode.id
                ? {
                    ...n,
                    aclRules: (n.aclRules || []).map((r) =>
                      r.id === blockingRule.id ? { ...r, enabled: false } : r
                    ),
                  }
                : n
            );
            return {
              updatedNodes: syncAllRoutersRoutingTables(updatedNodes, currLinks),
              updatedLinks: currLinks,
              fixedMessage: `[Авто-исправление]: Запрещающее правило ACL Seq #${blockingRule.seq} на ${dropNode.name} отключено.`,
            };
          },
        });
      }
    }

    // 4b. Cisco ASA Firewall Zone Policy Drop
    if (dropNode && dStep.decisionTitle.includes('Firewall ASA DROP')) {
      pushUnique({
        id: `fw-drop-${dropNode.id}`,
        category: 'FIREWALL',
        severity: 'critical',
        nodeId: dropNode.id,
        nodeName: dropNode.name,
        title: `Межсетевой экран ${dropNode.name} заблокировал пакет из менее защищённой зоны (Outside → Inside)`,
        explanation: `По умолчанию политика Cisco ASA запрещает неинициированные входящие подключения из зоны с низким уровнем безопасности (Outside 0) в защищённую зону (Inside 100).`,
        cliHint: `access-list OUTSIDE_IN extended permit ip any any`,
        fixButtonLabel: `Разрешить политику Outside → Inside на ${dropNode.name}`,
        applyFix: (currNodes, currLinks) => {
          const updatedNodes = currNodes.map((n) =>
            n.id === dropNode.id && n.firewallConfig
              ? {
                  ...n,
                  firewallConfig: {
                    ...n.firewallConfig,
                    outsideToInsidePolicy: 'permit' as const,
                  },
                }
              : n
          );
          return {
            updatedNodes: syncAllRoutersRoutingTables(updatedNodes, currLinks),
            updatedLinks: currLinks,
            fixedMessage: `[Авто-исправление]: На межсетевом экране ${dropNode.name} разрешён входящий трафик Outside → Inside.`,
          };
        },
      });
    }

    // 4c. WAN Link Impairment Drop (100% Packet Loss or 0 Mbps Bandwidth)
    if (
      dStep.decisionTitle.includes('WAN Link Impairment Drop') ||
      dStep.decisionTitle.includes('Packet Loss')
    ) {
      const wanNode =
        nodes.find(
          (n) =>
            (n.id === dStep.fromNodeId || n.id === dStep.toNodeId) &&
            n.wanImpairment?.enabled
        ) || dropNode;

      if (wanNode && wanNode.wanImpairment) {
        pushUnique({
          id: `wan-loss-${wanNode.id}`,
          category: 'WAN',
          severity: 'critical',
          nodeId: wanNode.id,
          nodeName: wanNode.name,
          title: `Потеря пакетов на канале WAN узла ${wanNode.name} (Packet Loss ${wanNode.wanImpairment.packetLossPercent}%)`,
          explanation: `Эмулятор канала WAN на узле ${wanNode.name} настроен в режим аварии или перегрузки (Loss ${wanNode.wanImpairment.packetLossPercent}%, BW ${wanNode.wanImpairment.bandwidthLimitMbps} Мбит/с), поэтому пакеты сбрасываются.`,
          cliHint: `wan impairment loss 0 bandwidth 1000`,
          fixButtonLabel: `Восстановить канал WAN на ${wanNode.name} (0% потерь)`,
          applyFix: (currNodes, currLinks) => {
            const updatedNodes = currNodes.map((n) =>
              n.id === wanNode.id && n.wanImpairment
                ? {
                    ...n,
                    wanImpairment: {
                      ...n.wanImpairment,
                      packetLossPercent: 0,
                      latencyMs: Math.min(n.wanImpairment.latencyMs, 25),
                      bandwidthLimitMbps: Math.max(
                        100,
                        n.wanImpairment.bandwidthLimitMbps
                      ),
                    },
                  }
                : n
            );
            return {
              updatedNodes: syncAllRoutersRoutingTables(updatedNodes, currLinks),
              updatedLinks: currLinks,
              fixedMessage: `[Авто-исправление]: Канал WAN на узле ${wanNode.name} восстановлен (0% потерь пакетов).`,
            };
          },
        });
      }
    }

    // 4d. Missing L3 Route on Router (No Route to Host / Destination Unreachable — forward or return route)
    if (
      dropNode &&
      dropNode.type === 'router' &&
      (dStep.decisionTitle.includes('No Route') ||
        dStep.decisionTitle.includes('Unreachable') ||
        dStep.decisionTitle.includes('нет маршрута'))
    ) {
      const unreachableDstIp = dStep.inboundPdu?.l3?.dstIp || dstIpFromSteps;
      const suggestions = getSuggestedStaticRoutes(dropNode, nodes);
      const matchingSuggestion =
        suggestions.find(
          (s) =>
            isValidIpv4(unreachableDstIp) &&
            isSameSubnet(unreachableDstIp, s.network, s.mask)
        ) || suggestions[0];

      if (matchingSuggestion) {
        const cidr = maskToCidr(matchingSuggestion.mask);
        pushUnique({
          id: `missing-route-${dropNode.id}-${matchingSuggestion.network}`,
          category: 'ROUTING',
          severity: 'critical',
          nodeId: dropNode.id,
          nodeName: dropNode.name,
          title: `На маршрутизаторе ${dropNode.name} нет маршрута к сети ${matchingSuggestion.network}/${cidr}`,
          explanation: `Маршрутизатор ${dropNode.name} отбросил пакет для ${unreachableDstIp}, так как в его таблице маршрутизации (FIB) нет записи для подсети ${matchingSuggestion.network}/${cidr}. Доступен соседний шлюз ${matchingSuggestion.nextHop} (${matchingSuggestion.viaRouterName}).`,
          cliHint: `ip route ${matchingSuggestion.network} ${matchingSuggestion.mask} ${matchingSuggestion.nextHop}`,
          fixButtonLabel: `Добавить маршрут ${matchingSuggestion.network}/${cidr} → ${matchingSuggestion.nextHop}`,
          applyFix: (currNodes, currLinks) => {
            const targetRtr = currNodes.find((n) => n.id === dropNode.id);
            if (!targetRtr) {
              return {
                updatedNodes: currNodes,
                updatedLinks: currLinks,
                fixedMessage: '',
              };
            }
            const { updatedNode } = addRouterStaticRoute(
              targetRtr,
              matchingSuggestion.network,
              matchingSuggestion.mask,
              matchingSuggestion.nextHop
            );
            const replaced = currNodes.map((n) =>
              n.id === dropNode.id ? updatedNode : n
            );
            return {
              updatedNodes: syncAllRoutersRoutingTables(replaced, currLinks),
              updatedLinks: currLinks,
              fixedMessage: `[Авто-исправление]: На маршрутизаторе ${dropNode.name} добавлен маршрут к ${matchingSuggestion.network}/${cidr} через ${matchingSuggestion.nextHop}.`,
            };
          },
        });
      }
    }
  }

  // 5. Check for Missing Return/Forward Routes on Routers when routing or ping fails
  const hasRoutingFailureInSummary =
    summaryMessage.includes('не имеет маршрута') ||
    summaryMessage.includes('Unreachable') ||
    summaryMessage.includes('не получен') ||
    summaryMessage.includes('TTL');

  if (hasRoutingFailureInSummary || !steps.length || droppedStep) {
    for (const rtr of nodes.filter((n) => n.type === 'router')) {
      const suggestions = getSuggestedStaticRoutes(rtr, nodes);
      for (const sug of suggestions) {
        const matchesSrcOrDst =
          (isValidIpv4(srcIpFromSteps || '') &&
            isSameSubnet(srcIpFromSteps!, sug.network, sug.mask)) ||
          (isValidIpv4(dstIpFromSteps) &&
            isSameSubnet(dstIpFromSteps, sug.network, sug.mask));

        if (matchesSrcOrDst || summaryMessage.includes(rtr.name)) {
          const cidr = maskToCidr(sug.mask);
          pushUnique({
            id: `missing-route-${rtr.id}-${sug.network}`,
            category: 'ROUTING',
            severity: 'critical',
            nodeId: rtr.id,
            nodeName: rtr.name,
            title: `На маршрутизаторе ${rtr.name} отсутствует маршрут к сети ${sug.network}/${cidr}`,
            explanation: `Для доставки пакетов (или возврата ответа ICMP Echo Reply) маршрутизатору ${rtr.name} необходим маршрут к подсети ${sug.network}/${cidr} через соседний роутер ${sug.viaRouterName} (${sug.nextHop}).`,
            cliHint: `ip route ${sug.network} ${sug.mask} ${sug.nextHop}`,
            fixButtonLabel: `Добавить маршрут ${sug.network}/${cidr} → ${sug.nextHop} на ${rtr.name}`,
            applyFix: (currNodes, currLinks) => {
              const targetRtr = currNodes.find((n) => n.id === rtr.id);
              if (!targetRtr) {
                return {
                  updatedNodes: currNodes,
                  updatedLinks: currLinks,
                  fixedMessage: '',
                };
              }
              const { updatedNode } = addRouterStaticRoute(
                targetRtr,
                sug.network,
                sug.mask,
                sug.nextHop
              );
              const replaced = currNodes.map((n) =>
                n.id === rtr.id ? updatedNode : n
              );
              return {
                updatedNodes: syncAllRoutersRoutingTables(replaced, currLinks),
                updatedLinks: currLinks,
                fixedMessage: `[Авто-исправление]: На маршрутизаторе ${rtr.name} добавлен маршрут к подсети ${sug.network}/${cidr} через ${sug.nextHop}.`,
              };
            },
          });
        }
      }
    }
  }

  // 6. Check for Administratively Down (shutdown) Interfaces on Connected Links
  for (const link of links) {
    const srcNode = nodes.find((n) => n.id === link.sourceNodeId);
    const dstNode = nodes.find((n) => n.id === link.targetNodeId);
    const srcPort = srcNode?.interfaces.find((i) => i.id === link.sourcePortId);
    const dstPort = dstNode?.interfaces.find((i) => i.id === link.targetPortId);

    for (const pair of [
      { node: srcNode, port: srcPort },
      { node: dstNode, port: dstPort },
    ]) {
      if (pair.node && pair.port && pair.port.adminStatus === 'down') {
        pushUnique({
          id: `port-down-${pair.node.id}-${pair.port.id}`,
          category: 'INTERFACE',
          severity: 'warning',
          nodeId: pair.node.id,
          nodeName: pair.node.name,
          title: `Порт ${pair.node.name}:${pair.port.shortName} административно выключен (shutdown)`,
          explanation: `Физический интерфейс ${pair.port.shortName} на устройстве ${pair.node.name} находится в состоянии administratively down и не пропускает трафик L1/L2.`,
          cliHint: `interface ${pair.port.shortName} → no shutdown`,
          fixButtonLabel: `Включить порт ${pair.node.name}:${pair.port.shortName} (no shutdown)`,
          applyFix: (currNodes, currLinks) => {
            const updatedNodes = currNodes.map((n) =>
              n.id === pair.node!.id
                ? {
                    ...n,
                    interfaces: n.interfaces.map((i) =>
                      i.id === pair.port!.id ? { ...i, adminStatus: 'up' as const } : i
                    ),
                  }
                : n
            );
            return {
              updatedNodes: syncAllRoutersRoutingTables(updatedNodes, currLinks),
              updatedLinks: currLinks,
              fixedMessage: `[Авто-исправление]: Интерфейс ${pair.node!.name}:${pair.port!.shortName} переведён в состояние UP (no shutdown).`,
            };
          },
        });
      }
    }
  }

  // 7. Check for GPON Optical Budget LOS (< -28.0 dBm) or Unauthorized GPON-SN on ONT/OLT
  for (const node of nodes) {
    if (!isGponOntNode(node)) continue;
    const ontState = computeGponOntOpticalState(node, nodes, links);
    if (ontState.status === 'los_low_power' && ontState.oltNode) {
      pushUnique({
        id: `gpon-los-${node.id}`,
        category: 'GPON',
        severity: 'critical',
        nodeId: node.id,
        nodeName: node.name,
        title: `Авария GPON LOS на ${node.name}: оптический сигнал ${ontState.rxPowerDbm} dBm (ниже порога ${ontState.losThresholdDbm} dBm)`,
        explanation: `Затухание оптической линии 1490/1310 нм до терминала ${node.name} составляет ${ontState.totalLossDb} dB (сплиттер ${ontState.splitterRatio}: -${ontState.splitterLossDb} dB, трасса ${ontState.distanceKm} км: -${ontState.fiberLossDb} dB, доп. потери: -${ontState.extraAttenuationDb} dB). На модеме горит красный индикатор LOS.`,
        cliHint: `interface gpon 0/1 → optical-attenuation normalize (Rx > -25 dBm)`,
        fixButtonLabel: `Нормализовать оптический бюджет линии до ${node.name} (убрать затухание LOS)`,
        applyFix: (currNodes, currLinks) => {
          const updatedNodes = currNodes.map((n) => {
            if (n.id === node.id && n.gponOntConfig) {
              return {
                ...n,
                gponOntConfig: {
                  ...n.gponOntConfig,
                  distanceKm: Math.min(n.gponOntConfig.distanceKm, 5.0),
                  extraAttenuationDb: 1.5,
                },
              };
            }
            if (n.id === ontState.oltNode?.id && n.gponOltConfig) {
              return {
                ...n,
                gponOltConfig: {
                  ...n.gponOltConfig,
                  splitterRatio:
                    n.gponOltConfig.splitterRatio === '1:64'
                      ? '1:16'
                      : n.gponOltConfig.splitterRatio,
                },
              };
            }
            return n;
          });
          return {
            updatedNodes: syncAllRoutersRoutingTables(updatedNodes, currLinks),
            updatedLinks: currLinks,
            fixedMessage: `[Авто-исправление GPON]: Затухание оптической линии до ${node.name} устранено (индикатор LOS погашен, сигнал в норме).`,
          };
        },
      });
    } else if (ontState.status === 'unauth_sn' && ontState.oltNode) {
      const oltId = ontState.oltNode.id;
      const oltName = ontState.oltNode.name;
      const snToAuthorize = ontState.gponSn;
      pushUnique({
        id: `gpon-unauth-sn-${node.id}`,
        category: 'GPON',
        severity: 'critical',
        nodeId: oltId,
        nodeName: oltName,
        title: `Терминал ${node.name} (GPON-SN: ${snToAuthorize}) не авторизован на OLT ${oltName}`,
        explanation: `Оптический сигнал на ${node.name} в норме (${ontState.rxPowerDbm} dBm), но серийный номер GPON-SN «${snToAuthorize}» не добавлен в список разрешённых ONU на станционном терминале ${oltName}.`,
        cliHint: `ont add 0/1 sn-auth ${snToAuthorize} omci`,
        fixButtonLabel: `Авторизовать серийный номер ${snToAuthorize} на ${oltName}`,
        applyFix: (currNodes, currLinks) => {
          const updatedNodes = currNodes.map((n) => {
            if (n.id === oltId && n.gponOltConfig) {
              const nextList = Array.from(
                new Set([...n.gponOltConfig.authorizedSnList, snToAuthorize])
              );
              return {
                ...n,
                gponOltConfig: {
                  ...n.gponOltConfig,
                  authorizedSnList: nextList,
                },
              };
            }
            return n;
          });
          return {
            updatedNodes: syncAllRoutersRoutingTables(updatedNodes, currLinks),
            updatedLinks: currLinks,
            fixedMessage: `[Авто-исправление GPON]: Серийный номер ONT ${snToAuthorize} (${node.name}) успешно авторизован на OLT ${oltName}.`,
          };
        },
      });
    }
  }

  return diagnostics;
}
