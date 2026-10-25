import React, { useState, useEffect } from 'react';
import {
  AclAction,
  AclProtocol,
  NetworkInterface,
  NetworkLink,
  NetworkNode,
  SimulationStep,
} from '../network/types';
import {
  addHardwarePortToNode,
  getDeviceChassisPorts,
} from '../network/hardwareChassis';
import {
  addRouterAclRule,
  addRouterStaticRoute,
  getSuggestedStaticRoutes,
  removeRouterSubinterface,
  upsertRouterSubinterface,
} from '../network/routerGuiHelpers';
import {
  formatIpv4Input,
  maskToCidr,
  suggestSubnetMaskForIp,
} from '../network/ipMath';
import { syncConnectedRoutes } from '../network/simulator';
import {
  ArrowRightLeft,
  Cpu,
  Globe,
  GripHorizontal,
  Layers,
  Minus,
  Plus,
  Power,
  Route,
  Shield,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Terminal,
  Trash2,
  X,
} from 'lucide-react';

interface FloatingRouterGuiProps {
  node: NetworkNode;
  allNodes: NetworkNode[];
  allLinks: NetworkLink[];
  activeStep: SimulationStep | null;
  onSelectNode: (nodeId: string) => void;
  onUpdateNode: (updatedNode: NetworkNode) => void;
  onOpenChassis: (nodeId: string) => void;
  onOpenFloatingCli: (nodeId: string) => void;
  onClose: () => void;
}

export const FloatingRouterGui: React.FC<FloatingRouterGuiProps> = ({
  node,
  allNodes,
  allLinks,
  activeStep,
  onSelectNode,
  onUpdateNode,
  onOpenChassis,
  onOpenFloatingCli,
  onClose,
}) => {
  const [activeTab, setActiveTab] = useState<
    'interfaces' | 'routes' | 'nat' | 'acl'
  >('interfaces');
  const [position, setPosition] = useState<{ x: number; y: number }>({
    x: 240,
    y: 184,
  });
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState<{ x: number; y: number }>({
    x: 0,
    y: 0,
  });
  const [isMinimized, setIsMinimized] = useState(false);
  const [statusToast, setStatusToast] = useState<string | null>(null);

  // 802.1Q Subinterface creation form state
  const [targetParentIfaceId, setTargetParentIfaceId] = useState<string>(
    () => node.interfaces[0]?.id || ''
  );
  const [subVlanId, setSubVlanId] = useState<string>('10');
  const [subIp, setSubIp] = useState<string>('192.168.10.1');
  const [subMask, setSubMask] = useState<string>('255.255.255.0');
  const [subHelper, setSubHelper] = useState<string>('');
  const [subNatRole, setSubNatRole] = useState<'none' | 'inside' | 'outside'>('inside');

  // Static Route creation form state
  const [routeNet, setRouteNet] = useState<string>('');
  const [routeMask, setRouteMask] = useState<string>('255.255.255.0');
  const [routeHop, setRouteHop] = useState<string>('');
  const [routeError, setRouteError] = useState<string | null>(null);

  // Extended ACL Rule creation form state
  const [aclSeq, setAclSeq] = useState<string>('');
  const [aclAction, setAclAction] = useState<AclAction>('deny');
  const [aclProto, setAclProto] = useState<AclProtocol>('ICMP');
  const [aclSrc, setAclSrc] = useState<string>('any');
  const [aclDst, setAclDst] = useState<string>('any');

  useEffect(() => {
    if (!node.interfaces.some((i) => i.id === targetParentIfaceId)) {
      setTargetParentIfaceId(node.interfaces[0]?.id || '');
    }
  }, [node.id, node.interfaces, targetParentIfaceId]);

  useEffect(() => {
    if (!statusToast) return;
    const t = window.setTimeout(() => setStatusToast(null), 3400);
    return () => window.clearTimeout(t);
  }, [statusToast]);

  useEffect(() => {
    if (!isDragging) return;
    const handleMouseMove = (e: MouseEvent) => {
      const nextX = Math.max(
        12,
        Math.min(window.innerWidth - 360, e.clientX - dragOffset.x)
      );
      const nextY = Math.max(
        44,
        Math.min(window.innerHeight - 90, e.clientY - dragOffset.y)
      );
      setPosition({ x: nextX, y: nextY });
    };
    const handleMouseUp = () => setIsDragging(false);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, dragOffset]);

  const handleHeaderMouseDown = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (
      target.closest('button') ||
      target.closest('select') ||
      target.closest('input')
    ) {
      return;
    }
    setIsDragging(true);
    setDragOffset({
      x: e.clientX - position.x,
      y: e.clientY - position.y,
    });
  };

  const portDescriptors = getDeviceChassisPorts(
    node,
    allNodes,
    allLinks,
    activeStep
  );
  const routes = syncConnectedRoutes(node);
  const staticRoutesCount = routes.filter((r) => r.type === 'S').length;
  const totalSubinterfaces = node.interfaces.reduce(
    (sum, i) => sum + (i.subinterfaces?.length || 0),
    0
  );
  const aclRules = node.aclRules || [];
  const natTranslations = node.natTranslations || [];
  const suggestedRoutes = getSuggestedStaticRoutes(node, allNodes);

  const switchableNodes = [...allNodes]
    .filter((n) => n.type !== 'pc')
    .sort((a, b) => {
      const order = { router: 0, switch: 1, server: 2, pc: 3 };
      return order[a.type] - order[b.type];
    });

  const handleUpdateInterface = (
    ifaceId: string,
    patch: Partial<NetworkInterface>
  ) => {
    const nextInterfaces = node.interfaces.map((iface) =>
      iface.id === ifaceId ? { ...iface, ...patch } : iface
    );
    const updatedNode: NetworkNode = {
      ...node,
      natEnabled:
        patch.natRole && patch.natRole !== 'none'
          ? true
          : Boolean(node.natEnabled),
      interfaces: nextInterfaces,
    };
    onUpdateNode({
      ...updatedNode,
      routingTable: syncConnectedRoutes(updatedNode),
    });
  };

  const handleAddSubinterfaceSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const parentId = targetParentIfaceId || node.interfaces[0]?.id;
    if (!parentId) return;
    const vlanNum = Math.max(1, Math.min(4094, Math.floor(Number(subVlanId) || 10)));
    const updated = upsertRouterSubinterface(node, parentId, {
      vlanId: vlanNum,
      ipAddress: subIp,
      subnetMask: subMask,
      helperAddress: subHelper.trim() || undefined,
      natRole: subNatRole,
    });
    onUpdateNode(updated);
    const parentShort =
      node.interfaces.find((i) => i.id === parentId)?.shortName || 'Fa0/0';
    setStatusToast(
      `Подинтерфейс ${parentShort}.${vlanNum} (dot1Q VLAN ${vlanNum}, GW ${subIp}) создан`
    );
    const nextVlan = vlanNum + 10 <= 4094 ? vlanNum + 10 : vlanNum + 1;
    setSubVlanId(String(nextVlan));
    if (nextVlan <= 254) {
      setSubIp(`192.168.${nextVlan}.1`);
    }
  };

  const handleApplyRoasPreset = () => {
    const parentId = targetParentIfaceId || node.interfaces[0]?.id;
    if (!parentId) return;
    let updated = upsertRouterSubinterface(node, parentId, {
      vlanId: 10,
      ipAddress: '192.168.10.1',
      subnetMask: '255.255.255.0',
      natRole: 'inside',
    });
    updated = upsertRouterSubinterface(updated, parentId, {
      vlanId: 20,
      ipAddress: '192.168.20.1',
      subnetMask: '255.255.255.0',
      natRole: 'inside',
    });
    onUpdateNode(updated);
    const parentShort =
      node.interfaces.find((i) => i.id === parentId)?.shortName || 'Fa0/0';
    setStatusToast(
      `Настроен Router-on-a-Stick на ${parentShort}: .10 (192.168.10.1/24) и .20 (192.168.20.1/24)`
    );
  };

  const handleAddRouteSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setRouteError(null);
    const { updatedNode, error } = addRouterStaticRoute(
      node,
      routeNet,
      routeMask,
      routeHop
    );
    if (error) {
      setRouteError(error);
      return;
    }
    onUpdateNode(updatedNode);
    setStatusToast(`Добавлен статический маршрут ${routeNet}/${maskToCidr(routeMask)} → ${routeHop}`);
    setRouteNet('');
  };

  const handleQuickAddSuggestedRoute = (
    network: string,
    mask: string,
    nextHop: string
  ) => {
    const { updatedNode, error } = addRouterStaticRoute(
      node,
      network,
      mask,
      nextHop
    );
    if (!error) {
      onUpdateNode(updatedNode);
      setStatusToast(
        `Добавлен маршрут к ${network}/${maskToCidr(mask)} через ${nextHop}`
      );
    }
  };

  const handleDeleteStaticRoute = (routeId: string) => {
    onUpdateNode({
      ...node,
      routingTable: node.routingTable.filter((r) => r.id !== routeId),
    });
    setStatusToast('Статический маршрут удалён из таблицы маршрутизации');
  };

  const handleAutoConfigureNat = () => {
    const nextInterfaces = node.interfaces.map((iface, idx) => {
      const isLastWan = idx === node.interfaces.length - 1 && node.interfaces.length > 1;
      const nextSubs = (iface.subinterfaces || []).map((s) => ({
        ...s,
        natRole: 'inside' as const,
      }));
      return {
        ...iface,
        natRole: (isLastWan ? 'outside' : 'inside') as 'inside' | 'outside',
        subinterfaces: nextSubs,
      };
    });
    onUpdateNode({
      ...node,
      natEnabled: true,
      interfaces: nextInterfaces,
    });
    setStatusToast(
      'NAT/PAT включён: LAN-интерфейсы назначены Inside, внешний порт назначен Outside'
    );
  };

  const handleAddAclSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const updated = addRouterAclRule(node, {
      seq: aclSeq ? Number(aclSeq) : undefined,
      action: aclAction,
      protocol: aclProto,
      srcIp: aclSrc,
      dstIp: aclDst,
    });
    onUpdateNode(updated);
    setStatusToast(
      `Правило ACL (${aclAction.toUpperCase()} ${aclProto} ${aclSrc} → ${aclDst}) добавлено`
    );
    setAclSeq('');
  };

  const handleQuickAclPreset = (
    action: AclAction,
    protocol: AclProtocol,
    srcIp: string,
    dstIp: string,
    label: string
  ) => {
    const updated = addRouterAclRule(node, {
      action,
      protocol,
      srcIp,
      dstIp,
    });
    onUpdateNode(updated);
    setStatusToast(label);
  };

  return (
    <div
      data-testid="floating-router-gui"
      role="dialog"
      aria-label={`Панель управления маршрутизатором Cisco ISR — ${node.name}`}
      style={{
        left: `${position.x}px`,
        top: `${position.y}px`,
      }}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      className="fixed z-46 w-[740px] max-w-[96vw] rounded-lg bg-slate-950/98 border-2 border-sky-500/65 shadow-[0_24px_60px_rgba(0,0,0,0.92)] select-none overflow-hidden flex flex-col"
    >
      {/* Top Draggable Cisco ISR GUI Header */}
      <div
        onMouseDown={handleHeaderMouseDown}
        className="flex items-center justify-between gap-2 px-3.5 py-2 bg-slate-900 border-b border-slate-800 cursor-move"
      >
        <div className="flex items-center gap-2 min-w-0">
          <GripHorizontal className="w-3.5 h-3.5 text-slate-500 shrink-0" />
          <div className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-sky-950/90 border border-sky-500/50 text-[10px] font-mono font-bold text-sky-200 shrink-0">
            <Globe className="w-3 h-3 text-sky-400" />
            <span>Cisco ISR GUI</span>
          </div>

          <select
            aria-label="Выбрать устройство в панели управления"
            value={node.id}
            onChange={(e) => onSelectNode(e.target.value)}
            className="bg-slate-950 border border-slate-700 rounded px-2 py-0.5 text-xs font-mono font-semibold text-sky-300 focus:outline-none focus:border-sky-500 cursor-pointer"
          >
            {switchableNodes.map((n) => (
              <option key={n.id} value={n.id}>
                {n.name} ({n.type.toUpperCase()})
              </option>
            ))}
          </select>

          <span className="hidden md:inline text-[10px] font-mono text-slate-500 truncate">
            https://{node.name.toLowerCase()}.isr.local/l3-control
          </span>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={() => onOpenChassis(node.id)}
            title="Открыть аппаратную панель 1U Cisco ISR (RJ-45 / WAN / LED)"
            className="flex items-center gap-1 px-2 py-0.5 rounded bg-sky-950/80 hover:bg-sky-900 border border-sky-500/40 text-[10px] font-mono font-semibold text-sky-300 transition-colors cursor-pointer"
          >
            <Cpu className="w-3 h-3" />
            <span>Шасси 1U</span>
          </button>

          <button
            type="button"
            onClick={() => onOpenFloatingCli(node.id)}
            title="Открыть терминал Cisco IOS CLI"
            className="flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-950/80 hover:bg-emerald-900 border border-emerald-500/40 text-[10px] font-mono font-semibold text-emerald-300 transition-colors cursor-pointer"
          >
            <Terminal className="w-3 h-3" />
            <span>IOS CLI</span>
          </button>

          <button
            type="button"
            onClick={() => setIsMinimized((m) => !m)}
            aria-label={isMinimized ? 'Развернуть окно маршрутизатора' : 'Свернуть окно маршрутизатора'}
            className="p-1 rounded text-slate-400 hover:text-white hover:bg-slate-800 transition-colors cursor-pointer"
          >
            <Minus className="w-3.5 h-3.5" />
          </button>

          <button
            type="button"
            onClick={onClose}
            aria-label="Закрыть панель маршрутизатора"
            className="p-1 rounded text-slate-400 hover:text-red-300 hover:bg-red-950/60 transition-colors cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {!isMinimized && (
        <>
          {/* Navigation Tabs: Interfaces & 802.1Q | Static Routes | NAT / PAT | ACL Firewall */}
          <div className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-1.5 bg-slate-900/80 border-b border-slate-800">
            <div className="flex flex-wrap items-center gap-1">
              <button
                type="button"
                data-testid="router-tab-interfaces"
                onClick={() => setActiveTab('interfaces')}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition-colors cursor-pointer ${
                  activeTab === 'interfaces'
                    ? 'bg-sky-600 text-white shadow-xs'
                    : 'text-slate-300 hover:text-white hover:bg-slate-800'
                }`}
              >
                <SlidersHorizontal className="w-3.5 h-3.5" />
                <span>
                  Порты и 802.1Q ({node.interfaces.length}
                  {totalSubinterfaces > 0 ? ` + ${totalSubinterfaces} dot1Q` : ''})
                </span>
              </button>

              <button
                type="button"
                data-testid="router-tab-routes"
                onClick={() => setActiveTab('routes')}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition-colors cursor-pointer ${
                  activeTab === 'routes'
                    ? 'bg-sky-600 text-white shadow-xs'
                    : 'text-slate-300 hover:text-white hover:bg-slate-800'
                }`}
              >
                <Route className="w-3.5 h-3.5" />
                <span>Static Routes ({staticRoutesCount})</span>
              </button>

              <button
                type="button"
                data-testid="router-tab-nat"
                onClick={() => setActiveTab('nat')}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition-colors cursor-pointer ${
                  activeTab === 'nat'
                    ? 'bg-sky-600 text-white shadow-xs'
                    : 'text-slate-300 hover:text-white hover:bg-slate-800'
                }`}
              >
                <ArrowRightLeft className="w-3.5 h-3.5" />
                <span>NAT / PAT ({node.natEnabled ? 'ON' : 'OFF'})</span>
              </button>

              <button
                type="button"
                data-testid="router-tab-acl"
                onClick={() => setActiveTab('acl')}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition-colors cursor-pointer ${
                  activeTab === 'acl'
                    ? 'bg-sky-600 text-white shadow-xs'
                    : 'text-slate-300 hover:text-white hover:bg-slate-800'
                }`}
              >
                <Shield className="w-3.5 h-3.5" />
                <span>ACL Firewall ({aclRules.length})</span>
              </button>
            </div>

            <div className="flex items-center gap-1.5">
              {statusToast && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-950/90 border border-emerald-500/50 text-[10px] font-mono text-emerald-300">
                  <ShieldCheck className="w-3 h-3 shrink-0" />
                  <span className="truncate max-w-[230px]">{statusToast}</span>
                </span>
              )}

              <button
                type="button"
                onClick={() => {
                  const updated = addHardwarePortToNode(node);
                  onUpdateNode(updated);
                  setStatusToast(
                    `Установлен новый модуль интерфейса ${
                      updated.interfaces[updated.interfaces.length - 1]?.shortName || ''
                    }`
                  );
                }}
                className="flex items-center gap-1 px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 text-[11px] font-mono text-sky-300 transition-colors cursor-pointer"
              >
                <Plus className="w-3 h-3" />
                <span>Порт HWIC</span>
              </button>
            </div>
          </div>

          {/* Scrollable Body */}
          <div className="max-h-[470px] overflow-y-auto p-3.5 space-y-3.5">
            {/* TAB 1: ROUTED INTERFACES, DHCP RELAY & 802.1Q SUBINTERFACES (ROUTER-ON-A-STICK) */}
            {activeTab === 'interfaces' && (
              <div className="space-y-3.5">
                {/* Physical Interfaces Table */}
                <div className="rounded-md border border-slate-800 overflow-hidden bg-slate-950">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="bg-slate-900/95 border-b border-slate-800 text-[10px] font-mono uppercase text-slate-400">
                        <th className="py-2 px-2.5 w-28">Интерфейс</th>
                        <th className="py-2 px-2 w-28">Статус / Линк</th>
                        <th className="py-2 px-2">IPv4-адрес шлюза</th>
                        <th className="py-2 px-2">Маска подсети</th>
                        <th className="py-2 px-2 w-32">DHCP Relay (Helper)</th>
                        <th className="py-2 px-2.5 w-28">Роль NAT</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/70">
                      {portDescriptors.map((desc) => {
                        const { port, peerNode, peerPort } = desc;
                        return (
                          <tr key={port.id} className="hover:bg-slate-900/50">
                            <td className="py-2 px-2.5 font-mono">
                              <div className="font-bold text-slate-100 flex items-center gap-1">
                                <span>{port.shortName}</span>
                                {port.vlanMode === 'trunk' && (
                                  <span className="px-1 py-0.2 rounded bg-indigo-500/20 border border-indigo-500/40 text-[9px] text-indigo-300">
                                    dot1Q
                                  </span>
                                )}
                              </div>
                              <div className="text-[9px] text-slate-500 truncate">
                                {port.macAddress}
                              </div>
                            </td>

                            <td className="py-2 px-2 font-mono">
                              <div className="flex flex-col gap-1">
                                <button
                                  type="button"
                                  onClick={() =>
                                    handleUpdateInterface(port.id, {
                                      adminStatus:
                                        port.adminStatus === 'up' ? 'down' : 'up',
                                    })
                                  }
                                  className={`inline-flex items-center justify-center gap-1 px-2 py-0.5 rounded text-[10px] border w-fit cursor-pointer ${
                                    port.adminStatus === 'up'
                                      ? 'bg-emerald-950/70 border-emerald-600/50 text-emerald-300'
                                      : 'bg-red-950/70 border-red-700/60 text-red-300'
                                  }`}
                                >
                                  <Power className="w-2.5 h-2.5" />
                                  <span>{port.adminStatus === 'up' ? 'UP' : 'SHUT'}</span>
                                </button>
                                <span className="text-[9.5px] text-slate-400 truncate">
                                  {peerNode
                                    ? `↔ ${peerNode.name}:${peerPort?.shortName}`
                                    : 'Не подключён'}
                                </span>
                              </div>
                            </td>

                            <td className="py-2 px-2">
                              <input
                                type="text"
                                aria-label={`IPv4 адрес интерфейса ${port.shortName}`}
                                placeholder="192.168.1.1"
                                value={port.ipAddress}
                                onChange={(e) => {
                                  const formatted = formatIpv4Input(e.target.value);
                                  handleUpdateInterface(port.id, {
                                    ipAddress: formatted,
                                  });
                                }}
                                className="w-full px-2 py-1 rounded bg-slate-900 border border-slate-700 text-xs font-mono text-sky-300 focus:outline-none focus:border-sky-500"
                              />
                            </td>

                            <td className="py-2 px-2">
                              <input
                                type="text"
                                aria-label={`Маска подсети интерфейса ${port.shortName}`}
                                placeholder="255.255.255.0"
                                value={port.subnetMask}
                                onFocus={() => {
                                  if (!port.subnetMask.trim() && port.ipAddress.trim()) {
                                    handleUpdateInterface(port.id, {
                                      subnetMask: suggestSubnetMaskForIp(port.ipAddress),
                                    });
                                  }
                                }}
                                onChange={(e) =>
                                  handleUpdateInterface(port.id, {
                                    subnetMask: formatIpv4Input(e.target.value),
                                  })
                                }
                                className="w-full px-2 py-1 rounded bg-slate-900 border border-slate-700 text-xs font-mono text-slate-200 focus:outline-none focus:border-sky-500"
                              />
                            </td>

                            <td className="py-2 px-2">
                              <input
                                type="text"
                                aria-label={`DHCP Relay адрес для ${port.shortName}`}
                                placeholder="ip helper..."
                                value={port.helperAddress || ''}
                                onChange={(e) =>
                                  handleUpdateInterface(port.id, {
                                    helperAddress:
                                      formatIpv4Input(e.target.value) || undefined,
                                  })
                                }
                                className="w-full px-2 py-1 rounded bg-slate-900 border border-slate-700 text-xs font-mono text-amber-200 focus:outline-none focus:border-amber-400"
                              />
                            </td>

                            <td className="py-2 px-2.5">
                              <select
                                aria-label={`Роль NAT для ${port.shortName}`}
                                value={port.natRole || 'none'}
                                onChange={(e) =>
                                  handleUpdateInterface(port.id, {
                                    natRole: e.target.value as
                                      | 'none'
                                      | 'inside'
                                      | 'outside',
                                  })
                                }
                                className="w-full px-1.5 py-1 rounded bg-slate-900 border border-slate-700 text-[11px] font-mono text-indigo-200 focus:outline-none focus:border-sky-500 cursor-pointer"
                              >
                                <option value="none">Без NAT</option>
                                <option value="inside">NAT Inside</option>
                                <option value="outside">NAT Outside</option>
                              </select>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {/* 802.1Q Subinterfaces (Router-on-a-Stick) Builder & Active List */}
                <div className="p-3 rounded-md bg-slate-900/90 border border-indigo-500/40 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <Layers className="w-4 h-4 text-indigo-400" />
                      <div>
                        <div className="text-xs font-semibold text-slate-100">
                          Подинтерфейсы IEEE 802.1Q (Router-on-a-Stick и DHCP Relay)
                        </div>
                        <div className="text-[11px] text-slate-400">
                          Маршрутизация между несколькими VLAN по одному Trunk-кабелю (encapsulation dot1Q)
                        </div>
                      </div>
                    </div>

                    <button
                      type="button"
                      data-testid="roas-quick-preset-btn"
                      onClick={handleApplyRoasPreset}
                      className="flex items-center gap-1 px-2.5 py-1 rounded bg-indigo-950 hover:bg-indigo-800 border border-indigo-500/50 text-[11px] font-mono text-indigo-200 transition-colors cursor-pointer"
                    >
                      <Sparkles className="w-3 h-3 text-indigo-400" />
                      <span>+ Шаблон RoaS (VLAN 10 + VLAN 20)</span>
                    </button>
                  </div>

                  {/* Form to Create / Update an 802.1Q Subinterface */}
                  <form
                    onSubmit={handleAddSubinterfaceSubmit}
                    className="grid grid-cols-12 gap-2 items-end pt-1"
                  >
                    <div className="col-span-2">
                      <label className="block text-[10px] font-mono text-slate-400 mb-0.5">
                        Trunk-порт
                      </label>
                      <select
                        aria-label="Физический интерфейс для подинтерфейса 802.1Q"
                        value={targetParentIfaceId}
                        onChange={(e) => setTargetParentIfaceId(e.target.value)}
                        className="w-full px-2 py-1 rounded bg-slate-950 border border-slate-700 text-xs font-mono text-slate-100"
                      >
                        {node.interfaces.map((iface) => (
                          <option key={iface.id} value={iface.id}>
                            {iface.shortName}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="col-span-2">
                      <label className="block text-[10px] font-mono text-slate-400 mb-0.5">
                        dot1Q VLAN
                      </label>
                      <input
                        type="number"
                        min={1}
                        max={4094}
                        aria-label="Номер VLAN для подинтерфейса"
                        value={subVlanId}
                        onChange={(e) => {
                          const val = e.target.value;
                          setSubVlanId(val);
                          const n = Number(val);
                          if (n >= 1 && n <= 254) {
                            setSubIp(`192.168.${n}.1`);
                          }
                        }}
                        className="w-full px-2 py-1 rounded bg-slate-950 border border-slate-700 text-xs font-mono text-indigo-300"
                      />
                    </div>

                    <div className="col-span-3">
                      <label className="block text-[10px] font-mono text-slate-400 mb-0.5">
                        IPv4 Шлюза VLAN
                      </label>
                      <input
                        type="text"
                        aria-label="IP адрес подинтерфейса 802.1Q"
                        value={subIp}
                        onChange={(e) => setSubIp(formatIpv4Input(e.target.value))}
                        placeholder="192.168.10.1"
                        className="w-full px-2 py-1 rounded bg-slate-950 border border-slate-700 text-xs font-mono text-sky-300"
                      />
                    </div>

                    <div className="col-span-2">
                      <label className="block text-[10px] font-mono text-slate-400 mb-0.5">
                        Маска
                      </label>
                      <input
                        type="text"
                        aria-label="Маска подинтерфейса 802.1Q"
                        value={subMask}
                        onFocus={() => {
                          if (!subMask.trim() && subIp.trim()) {
                            setSubMask(suggestSubnetMaskForIp(subIp));
                          }
                        }}
                        onChange={(e) => setSubMask(formatIpv4Input(e.target.value))}
                        placeholder="255.255.255.0"
                        className="w-full px-2 py-1 rounded bg-slate-950 border border-slate-700 text-xs font-mono text-slate-200"
                      />
                    </div>

                    <div className="col-span-3 flex items-center gap-1.5">
                      <div className="flex-1">
                        <label className="block text-[10px] font-mono text-slate-400 mb-0.5">
                          DHCP Relay (опц.)
                        </label>
                        <input
                          type="text"
                          aria-label="IP адрес DHCP сервера (ip helper-address)"
                          value={subHelper}
                          onChange={(e) => setSubHelper(formatIpv4Input(e.target.value))}
                          placeholder="helper IP"
                          className="w-full px-2 py-1 rounded bg-slate-950 border border-slate-700 text-xs font-mono text-amber-200"
                        />
                      </div>
                      <button
                        type="submit"
                        data-testid="add-subinterface-submit"
                        className="px-3 py-1 rounded bg-indigo-600 hover:bg-indigo-500 text-xs font-medium text-white shrink-0 cursor-pointer"
                      >
                        + dot1Q
                      </button>
                    </div>
                  </form>

                  {/* Active 802.1Q Subinterfaces Table */}
                  {totalSubinterfaces > 0 ? (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
                      {node.interfaces.flatMap((iface) =>
                        (iface.subinterfaces || []).map((sub) => (
                          <div
                            key={`${iface.id}.${sub.vlanId}`}
                            data-testid={`router-subif-card-${iface.shortName}.${sub.vlanId}`}
                            className="p-2.5 rounded bg-slate-950 border border-indigo-500/40 flex flex-col gap-2 text-xs font-mono"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <div className="flex items-center gap-1.5">
                                <span className="font-bold text-indigo-300 text-xs">
                                  {iface.shortName}.{sub.vlanId}
                                </span>
                                <span className="px-1.5 py-0.5 rounded bg-indigo-500/20 border border-indigo-500/40 text-[10px] text-indigo-200">
                                  VLAN {sub.vlanId}
                                </span>
                              </div>
                              <div className="flex items-center gap-1.5">
                                <select
                                  value={sub.natRole || 'none'}
                                  onChange={(e) => {
                                    const updated = upsertRouterSubinterface(
                                      node,
                                      iface.id,
                                      {
                                        ...sub,
                                        natRole: e.target.value as
                                          | 'none'
                                          | 'inside'
                                          | 'outside',
                                      }
                                    );
                                    onUpdateNode(updated);
                                  }}
                                  className="px-1.5 py-0.5 rounded bg-slate-900 border border-slate-700 text-[10px] text-emerald-300"
                                >
                                  <option value="none">Без NAT</option>
                                  <option value="inside">NAT Inside</option>
                                  <option value="outside">NAT Outside</option>
                                </select>
                                <button
                                  type="button"
                                  onClick={() => {
                                    onUpdateNode(
                                      removeRouterSubinterface(
                                        node,
                                        iface.id,
                                        sub.vlanId
                                      )
                                    );
                                    setStatusToast(
                                      `Подинтерфейс ${iface.shortName}.${sub.vlanId} удалён`
                                    );
                                  }}
                                  className="p-1 rounded text-slate-400 hover:text-red-400 hover:bg-red-950/50 cursor-pointer"
                                  title="Удалить подинтерфейс"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </div>

                            <div className="grid grid-cols-2 gap-1.5">
                              <div>
                                <span className="text-[9.5px] text-slate-500 block">
                                  Шлюз подсети (GW):
                                </span>
                                <span className="text-sky-300 font-semibold">
                                  {sub.ipAddress}/{maskToCidr(sub.subnetMask)}
                                </span>
                              </div>
                              <div>
                                <span className="text-[9.5px] text-slate-500 block">
                                  DHCP Relay (ip helper):
                                </span>
                                <span className="text-amber-300">
                                  {sub.helperAddress || 'не задан'}
                                </span>
                              </div>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  ) : (
                    <div className="text-xs text-slate-400 font-mono bg-slate-950/70 border border-slate-800 rounded px-3 py-2">
                      Подинтерфейсы 802.1Q ещё не созданы. Выберите интерфейс и нажмите «+ dot1Q» или «+ Шаблон RoaS».
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* TAB 2: STATIC ROUTING VISUAL EDITOR & AUTO-DISCOVERY */}
            {activeTab === 'routes' && (
              <div className="space-y-3.5">
                {/* Add Static Route Form */}
                <form
                  onSubmit={handleAddRouteSubmit}
                  className="p-3 rounded-md bg-slate-900/90 border border-slate-800 space-y-2.5"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-slate-100">
                      Добавить статический маршрут (ip route)
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setRouteNet('0.0.0.0');
                        setRouteMask('0.0.0.0');
                      }}
                      className="px-2 py-0.5 rounded bg-slate-950 hover:bg-slate-800 border border-slate-700 text-[10px] font-mono text-sky-300 cursor-pointer"
                    >
                      Подставить Default Route (0.0.0.0/0)
                    </button>
                  </div>

                  <div className="grid grid-cols-12 gap-2 items-end">
                    <div className="col-span-4">
                      <label className="block text-[10px] font-mono text-slate-400 mb-0.5">
                        Сеть назначения (Network)
                      </label>
                      <input
                        type="text"
                        aria-label="Сеть назначения статического маршрута"
                        placeholder="192.168.20.0"
                        value={routeNet}
                        onChange={(e) => setRouteNet(formatIpv4Input(e.target.value))}
                        className="w-full px-2.5 py-1.5 rounded bg-slate-950 border border-slate-700 text-xs font-mono text-slate-100 focus:outline-none focus:border-sky-500"
                      />
                    </div>

                    <div className="col-span-4">
                      <label className="block text-[10px] font-mono text-slate-400 mb-0.5">
                        Маска подсети (Subnet Mask)
                      </label>
                      <input
                        type="text"
                        aria-label="Маска статического маршрута"
                        placeholder="255.255.255.0"
                        value={routeMask}
                        onFocus={() => {
                          if (!routeMask.trim() && routeNet.trim()) {
                            setRouteMask(suggestSubnetMaskForIp(routeNet));
                          }
                        }}
                        onChange={(e) => setRouteMask(formatIpv4Input(e.target.value))}
                        className="w-full px-2.5 py-1.5 rounded bg-slate-950 border border-slate-700 text-xs font-mono text-slate-200 focus:outline-none focus:border-sky-500"
                      />
                    </div>

                    <div className="col-span-4 flex items-center gap-1.5">
                      <div className="flex-1">
                        <label className="block text-[10px] font-mono text-slate-400 mb-0.5">
                          Шлюз Next-Hop IP
                        </label>
                        <input
                          type="text"
                          aria-label="Next-Hop IP статического маршрута"
                          placeholder="10.0.0.2"
                          value={routeHop}
                          onChange={(e) => setRouteHop(formatIpv4Input(e.target.value))}
                          className="w-full px-2.5 py-1.5 rounded bg-slate-950 border border-slate-700 text-xs font-mono text-sky-300 focus:outline-none focus:border-sky-500"
                        />
                      </div>
                      <button
                        type="submit"
                        data-testid="add-static-route-btn"
                        className="px-3 py-1.5 rounded bg-sky-600 hover:bg-sky-500 text-xs font-medium text-white shrink-0 cursor-pointer"
                      >
                        + Маршрут
                      </button>
                    </div>
                  </div>

                  {routeError && (
                    <div className="text-xs font-mono text-red-400">{routeError}</div>
                  )}

                  {/* Auto-Discovered Remote Subnets in Topology */}
                  {suggestedRoutes.length > 0 && (
                    <div className="pt-2 border-t border-slate-800/80 space-y-1.5">
                      <div className="text-[10px] font-mono text-amber-300 flex items-center gap-1">
                        <Sparkles className="w-3 h-3" />
                        <span>
                          Обнаружены удалённые подсети на других маршрутизаторах (добавить в 1 клик):
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {suggestedRoutes.map((s) => (
                          <button
                            key={`${s.network}-${s.nextHop}`}
                            type="button"
                            onClick={() =>
                              handleQuickAddSuggestedRoute(
                                s.network,
                                s.mask,
                                s.nextHop
                              )
                            }
                            className="px-2 py-1 rounded bg-sky-950/90 hover:bg-sky-700 border border-sky-500/50 text-[11px] font-mono text-sky-200 hover:text-white transition-colors cursor-pointer"
                          >
                            + ip route {s.network}/{maskToCidr(s.mask)} via {s.nextHop} ({s.viaRouterName})
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </form>

                {/* Active Routing Table (Connected + Static) */}
                <div className="rounded-md border border-slate-800 overflow-hidden bg-slate-950">
                  <div className="px-3 py-2 bg-slate-900/95 border-b border-slate-800 flex items-center justify-between text-xs font-mono">
                    <span className="font-semibold text-slate-200">
                      Таблица маршрутизации L3 (show ip route)
                    </span>
                    <span className="text-[11px] text-slate-400">
                      Всего записей: {routes.length} (C: {routes.filter((r) => r.type === 'C').length}, S: {staticRoutesCount})
                    </span>
                  </div>
                  <table className="w-full text-left border-collapse text-xs font-mono">
                    <thead>
                      <tr className="bg-slate-900/60 border-b border-slate-800 text-[10px] uppercase text-slate-400">
                        <th className="py-1.5 px-2.5 w-16">Код</th>
                        <th className="py-1.5 px-2">Сеть / Префикс</th>
                        <th className="py-1.5 px-2">Next-Hop / Статус</th>
                        <th className="py-1.5 px-2">Выходной порт</th>
                        <th className="py-1.5 px-2.5 w-16 text-right">Действие</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/70">
                      {routes.map((rt) => (
                        <tr key={rt.id} className="hover:bg-slate-900/50">
                          <td className="py-1.5 px-2.5">
                            <span
                              className={`px-1.5 py-0.5 rounded text-[10px] font-bold border ${
                                rt.type === 'C'
                                  ? 'bg-emerald-950/80 border-emerald-500/50 text-emerald-300'
                                  : 'bg-sky-950/80 border-sky-500/50 text-sky-300'
                              }`}
                            >
                              {rt.type}
                            </span>
                          </td>
                          <td className="py-1.5 px-2 text-slate-100 font-semibold">
                            {rt.network}/{maskToCidr(rt.mask)}
                            <span className="text-slate-500 font-normal ml-1.5 text-[10px]">
                              ({rt.mask})
                            </span>
                          </td>
                          <td className="py-1.5 px-2 text-sky-300">
                            {rt.type === 'C' ? 'Directly connected' : `via ${rt.nextHop}`}
                          </td>
                          <td className="py-1.5 px-2 text-indigo-300">
                            {rt.interfaceName}
                          </td>
                          <td className="py-1.5 px-2.5 text-right">
                            {rt.type === 'S' ? (
                              <button
                                type="button"
                                onClick={() => handleDeleteStaticRoute(rt.id)}
                                className="p-1 rounded text-slate-400 hover:text-red-400 hover:bg-red-950/50 cursor-pointer"
                                title="Удалить статический маршрут"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            ) : (
                              <span className="text-[10px] text-slate-600">авто</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* TAB 3: NAT / PAT OVERLOAD & TRANSLATION TABLE */}
            {activeTab === 'nat' && (
              <div className="space-y-3.5">
                {/* Master NAT/PAT Controls */}
                <div className="p-3 rounded-md bg-slate-900/90 border border-slate-800 flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="text-xs font-semibold text-slate-100 flex items-center gap-2">
                      <span>Трансляция сетевых адресов NAT / PAT Overload</span>
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold border ${
                          node.natEnabled
                            ? 'bg-emerald-950 border-emerald-500/60 text-emerald-300'
                            : 'bg-slate-950 border-slate-700 text-slate-400'
                        }`}
                      >
                        {node.natEnabled ? 'ACTIVE (PAT OVERLOAD)' : 'DISABLED'}
                      </span>
                    </div>
                    <p className="text-[11px] text-slate-400 mt-0.5">
                      Подменяет приватные Source IP локальной сети (Inside) на публичный IP внешнего интерфейса маршрутизатора (Outside).
                    </p>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={handleAutoConfigureNat}
                      className="flex items-center gap-1 px-2.5 py-1.5 rounded bg-indigo-950 hover:bg-indigo-800 border border-indigo-500/50 text-xs font-mono text-indigo-200 cursor-pointer"
                    >
                      <Sparkles className="w-3.5 h-3.5 text-indigo-400" />
                      <span>Автонастройка LAN/WAN</span>
                    </button>

                    <button
                      type="button"
                      data-testid="toggle-router-nat-btn"
                      onClick={() => {
                        const next = !node.natEnabled;
                        onUpdateNode({ ...node, natEnabled: next });
                        setStatusToast(
                          next
                            ? 'Трансляция NAT / PAT Overload включена'
                            : 'Трансляция NAT / PAT выключена'
                        );
                      }}
                      className={`px-3 py-1.5 rounded text-xs font-medium transition-colors cursor-pointer ${
                        node.natEnabled
                          ? 'bg-emerald-600 hover:bg-emerald-500 text-white'
                          : 'bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700'
                      }`}
                    >
                      {node.natEnabled ? 'Выключить NAT' : 'Включить NAT / PAT'}
                    </button>
                  </div>
                </div>

                {/* Inside / Outside Interface Role Matrix */}
                <div className="p-3 rounded-md bg-slate-950 border border-slate-800 space-y-2">
                  <div className="text-xs font-semibold text-slate-200">
                    Распределение интерфейсов Inside (LAN) ↔ Outside (WAN)
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {node.interfaces.map((iface) => (
                      <div
                        key={iface.id}
                        className="p-2.5 rounded bg-slate-900 border border-slate-800 flex items-center justify-between gap-2 text-xs font-mono"
                      >
                        <div>
                          <div className="font-bold text-slate-100">{iface.shortName}</div>
                          <div className="text-[10px] text-sky-300">
                            {iface.ipAddress || 'без IP'}
                          </div>
                        </div>

                        <div className="flex items-center gap-1">
                          {(['none', 'inside', 'outside'] as const).map((role) => (
                            <button
                              key={role}
                              type="button"
                              onClick={() =>
                                handleUpdateInterface(iface.id, { natRole: role })
                              }
                              className={`px-2 py-0.5 rounded text-[10px] border cursor-pointer ${
                                (iface.natRole || 'none') === role
                                  ? role === 'outside'
                                    ? 'bg-amber-600 border-amber-400 text-white font-bold'
                                    : role === 'inside'
                                    ? 'bg-emerald-600 border-emerald-400 text-white font-bold'
                                    : 'bg-slate-700 border-slate-500 text-white'
                                  : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
                              }`}
                            >
                              {role === 'none'
                                ? 'Off'
                                : role === 'inside'
                                ? 'Inside (LAN)'
                                : 'Outside (WAN)'}
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Active NAT Translations Table */}
                <div className="rounded-md border border-slate-800 overflow-hidden bg-slate-950">
                  <div className="px-3 py-2 bg-slate-900/95 border-b border-slate-800 flex items-center justify-between text-xs font-mono">
                    <span className="font-semibold text-slate-200">
                      Активные сессии NAT (show ip nat translations) — {natTranslations.length}
                    </span>
                    {natTranslations.length > 0 && (
                      <button
                        type="button"
                        onClick={() => {
                          onUpdateNode({ ...node, natTranslations: [] });
                          setStatusToast('Таблица трансляций NAT очищена');
                        }}
                        className="text-[11px] text-red-300 hover:text-red-200 underline cursor-pointer"
                      >
                        Очистить таблицу
                      </button>
                    )}
                  </div>

                  {natTranslations.length > 0 ? (
                    <table className="w-full text-left border-collapse text-xs font-mono">
                      <thead>
                        <tr className="bg-slate-900/60 border-b border-slate-800 text-[10px] uppercase text-slate-400">
                          <th className="py-1.5 px-2.5">Протокол</th>
                          <th className="py-1.5 px-2">Inside Global (WAN)</th>
                          <th className="py-1.5 px-2">Inside Local (LAN)</th>
                          <th className="py-1.5 px-2.5">Outside Global (Цель)</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800/70">
                        {natTranslations.map((tr) => (
                          <tr key={tr.id}>
                            <td className="py-1.5 px-2.5 uppercase text-amber-300 font-bold">
                              {tr.protocol}
                            </td>
                            <td className="py-1.5 px-2 text-emerald-300 font-semibold">
                              {tr.insideGlobal}
                            </td>
                            <td className="py-1.5 px-2 text-sky-300">
                              {tr.insideLocal}
                            </td>
                            <td className="py-1.5 px-2.5 text-slate-200">
                              {tr.outsideGlobal}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <div className="p-4 text-center text-xs font-mono text-slate-500">
                      Трансляции появятся автоматически при прохождении пакета из сети Inside (LAN) в сеть Outside (WAN).
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* TAB 4: EXTENDED IPv4 ACCESS CONTROL LISTS (ACL FIREWALL) */}
            {activeTab === 'acl' && (
              <div className="space-y-3.5">
                {/* Create ACL Rule Form + Quick Security Presets */}
                <form
                  onSubmit={handleAddAclSubmit}
                  className="p-3 rounded-md bg-slate-900/90 border border-slate-800 space-y-2.5"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-slate-100 flex items-center gap-1.5">
                      <ShieldAlert className="w-4 h-4 text-rose-400" />
                      <span>Межсетевой экран L3/L4 (Extended IPv4 ACL)</span>
                    </span>

                    <div className="flex flex-wrap items-center gap-1 text-[10px] font-mono">
                      <span className="text-slate-400">Шаблоны:</span>
                      <button
                        type="button"
                        onClick={() =>
                          handleQuickAclPreset(
                            'deny',
                            'ICMP',
                            'any',
                            'any',
                            'Добавлено правило: Запретить Ping (deny icmp any any)'
                          )
                        }
                        className="px-2 py-0.5 rounded bg-rose-950/90 hover:bg-rose-800 border border-rose-500/50 text-rose-200 cursor-pointer"
                      >
                        Блок Ping (ICMP)
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          handleQuickAclPreset(
                            'deny',
                            'HTTP',
                            'any',
                            'any',
                            'Добавлено правило: Запретить веб-трафик HTTP (TCP 80)'
                          )
                        }
                        className="px-2 py-0.5 rounded bg-amber-950/90 hover:bg-amber-800 border border-amber-500/50 text-amber-200 cursor-pointer"
                      >
                        Блок HTTP (80)
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          handleQuickAclPreset(
                            'permit',
                            'ANY',
                            'any',
                            'any',
                            'Добавлено правило: Разрешить весь IP-трафик (permit ip any any)'
                          )
                        }
                        className="px-2 py-0.5 rounded bg-emerald-950/90 hover:bg-emerald-800 border border-emerald-500/50 text-emerald-200 cursor-pointer"
                      >
                        Permit All
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-12 gap-2 items-end">
                    <div className="col-span-2">
                      <label className="block text-[10px] font-mono text-slate-400 mb-0.5">
                        Seq #
                      </label>
                      <input
                        type="number"
                        min={1}
                        placeholder="авто"
                        value={aclSeq}
                        onChange={(e) => setAclSeq(e.target.value)}
                        className="w-full px-2 py-1.5 rounded bg-slate-950 border border-slate-700 text-xs font-mono text-slate-200"
                      />
                    </div>

                    <div className="col-span-2">
                      <label className="block text-[10px] font-mono text-slate-400 mb-0.5">
                        Действие
                      </label>
                      <select
                        aria-label="Действие правила ACL"
                        value={aclAction}
                        onChange={(e) => setAclAction(e.target.value as AclAction)}
                        className={`w-full px-2 py-1.5 rounded border text-xs font-mono font-bold ${
                          aclAction === 'deny'
                            ? 'bg-rose-950/80 border-rose-500/60 text-rose-300'
                            : 'bg-emerald-950/80 border-emerald-500/60 text-emerald-300'
                        }`}
                      >
                        <option value="deny">DENY</option>
                        <option value="permit">PERMIT</option>
                      </select>
                    </div>

                    <div className="col-span-2">
                      <label className="block text-[10px] font-mono text-slate-400 mb-0.5">
                        Протокол
                      </label>
                      <select
                        aria-label="Протокол правила ACL"
                        value={aclProto}
                        onChange={(e) => setAclProto(e.target.value as AclProtocol)}
                        className="w-full px-2 py-1.5 rounded bg-slate-950 border border-slate-700 text-xs font-mono text-sky-300"
                      >
                        <option value="ICMP">ICMP (Ping)</option>
                        <option value="HTTP">HTTP (TCP 80)</option>
                        <option value="DNS">DNS (UDP 53)</option>
                        <option value="TCP">TCP</option>
                        <option value="UDP">UDP</option>
                        <option value="ANY">ANY (IP)</option>
                      </select>
                    </div>

                    <div className="col-span-3">
                      <label className="block text-[10px] font-mono text-slate-400 mb-0.5">
                        Source (any / IP / CIDR)
                      </label>
                      <input
                        type="text"
                        aria-label="Источник правила ACL"
                        value={aclSrc}
                        onChange={(e) => setAclSrc(e.target.value)}
                        placeholder="any или 192.168.10.0/24"
                        className="w-full px-2 py-1.5 rounded bg-slate-950 border border-slate-700 text-xs font-mono text-slate-100"
                      />
                    </div>

                    <div className="col-span-3 flex items-center gap-1.5">
                      <div className="flex-1">
                        <label className="block text-[10px] font-mono text-slate-400 mb-0.5">
                          Destination (any / IP)
                        </label>
                        <input
                          type="text"
                          aria-label="Назначение правила ACL"
                          value={aclDst}
                          onChange={(e) => setAclDst(e.target.value)}
                          placeholder="any или 192.168.20.100"
                          className="w-full px-2 py-1.5 rounded bg-slate-950 border border-slate-700 text-xs font-mono text-slate-100"
                        />
                      </div>
                      <button
                        type="submit"
                        data-testid="add-acl-rule-btn"
                        className="px-3 py-1.5 rounded bg-sky-600 hover:bg-sky-500 text-xs font-medium text-white shrink-0 cursor-pointer"
                      >
                        + ACL
                      </button>
                    </div>
                  </div>
                </form>

                {/* Active ACL Rules Table */}
                <div className="rounded-md border border-slate-800 overflow-hidden bg-slate-950">
                  <div className="px-3 py-2 bg-slate-900/95 border-b border-slate-800 flex items-center justify-between text-xs font-mono">
                    <span className="font-semibold text-slate-200">
                      Список контроля доступа (show access-lists) — {aclRules.length} правил
                    </span>
                    {aclRules.length > 0 && (
                      <button
                        type="button"
                        onClick={() => {
                          onUpdateNode({ ...node, aclRules: [] });
                          setStatusToast('Все правила ACL очищены');
                        }}
                        className="text-[11px] text-red-300 hover:text-red-200 underline cursor-pointer"
                      >
                        Очистить ACL
                      </button>
                    )}
                  </div>

                  {aclRules.length > 0 ? (
                    <table className="w-full text-left border-collapse text-xs font-mono">
                      <thead>
                        <tr className="bg-slate-900/60 border-b border-slate-800 text-[10px] uppercase text-slate-400">
                          <th className="py-1.5 px-2.5 w-16">Seq</th>
                          <th className="py-1.5 px-2 w-24">Action</th>
                          <th className="py-1.5 px-2 w-24">Protocol</th>
                          <th className="py-1.5 px-2">Source → Destination</th>
                          <th className="py-1.5 px-2.5 w-24 text-right">Управление</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800/70">
                        {aclRules.map((rule) => (
                          <tr
                            key={rule.id}
                            className={
                              rule.enabled === false ? 'opacity-50 bg-slate-950' : ''
                            }
                          >
                            <td className="py-1.5 px-2.5 text-slate-400">#{rule.seq}</td>
                            <td className="py-1.5 px-2">
                              <span
                                className={`px-1.5 py-0.5 rounded text-[10px] font-bold uppercase border ${
                                  rule.action === 'deny'
                                    ? 'bg-rose-950 border-rose-500/60 text-rose-300'
                                    : 'bg-emerald-950 border-emerald-500/60 text-emerald-300'
                                }`}
                              >
                                {rule.action}
                              </span>
                            </td>
                            <td className="py-1.5 px-2 text-sky-300 font-semibold">
                              {rule.protocol}
                            </td>
                            <td className="py-1.5 px-2 text-slate-100">
                              <span>{rule.srcIp}</span>
                              <span className="text-slate-500 mx-1.5">→</span>
                              <span>{rule.dstIp}</span>
                            </td>
                            <td className="py-1.5 px-2.5 text-right">
                              <div className="inline-flex items-center gap-1">
                                <button
                                  type="button"
                                  onClick={() => {
                                    const nextRules = aclRules.map((r) =>
                                      r.id === rule.id
                                        ? { ...r, enabled: r.enabled === false }
                                        : r
                                    );
                                    onUpdateNode({ ...node, aclRules: nextRules });
                                  }}
                                  className="px-1.5 py-0.5 rounded bg-slate-900 border border-slate-700 text-[10px] text-slate-300 hover:text-white cursor-pointer"
                                >
                                  {rule.enabled === false ? 'OFF' : 'ON'}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    onUpdateNode({
                                      ...node,
                                      aclRules: aclRules.filter(
                                        (r) => r.id !== rule.id
                                      ),
                                    });
                                  }}
                                  className="p-1 rounded text-slate-400 hover:text-red-400 cursor-pointer"
                                  title="Удалить правило ACL"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <div className="p-4 text-center text-xs font-mono text-slate-500">
                      Список ACL пуст — весь транзитный трафик между подсетями разрешён (permit ip any any).
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
};
