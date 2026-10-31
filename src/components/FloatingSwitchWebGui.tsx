import React, { useState, useEffect } from 'react';
import {
  CableType,
  NetworkInterface,
  NetworkLink,
  NetworkNode,
  NetworkZone,
  SimulationStep,
  StackConfig,
  SwitchSviInterface,
  ZoneColor,
} from '../network/types';
import {
  getDefaultStackVirtualMac,
  getNodeStackStatus,
} from '../network/stackEngine';
import {
  addHardwarePortToNode,
  assignPortsToVlan,
  deleteDeviceVlan,
  getDeviceChassisPorts,
  getDeviceVlanDatabase,
  upsertDeviceVlan,
} from '../network/hardwareChassis';
import {
  computeSpanningTreeState,
  getEtherChannelBundles,
  isSwitchSviLineProtocolUp,
  syncConnectedRoutes,
} from '../network/simulator';
import { generateSviMacAddress } from '../network/cliParser';
import {
  computeWifiSignalMetrics,
  isWifiAccessPointNode,
  isWlcControllerNode,
  syncWirelessAssociations,
  synthesizeCapwapTunnelSteps,
} from '../network/wifiEngine';
import { computeSwitchPoeStatus } from '../network/poeAndVoipEngine';
import {
  computeGponOltConnectedOnts,
  computeGponOntOpticalState,
  getDefaultGponOltConfig,
  getDefaultGponOntConfig,
  getGponSplitterInsertionLossDb,
  isGponOltNode,
  isGponOntNode,
  syncOntInterfacesWithServicePorts,
} from '../network/gponEngine';
import { GponSplitterRatio } from '../network/types';
import {
  Activity,
  AlertTriangle,
  CheckSquare,
  Cpu,
  GitMerge,
  Globe,
  GripHorizontal,
  Layers,
  Minus,
  PhoneCall,
  Plus,
  Power,
  Radio,
  Router,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  Square,
  Table2,
  Terminal,
  Trash2,
  Wifi,
  X,
  Zap,
} from 'lucide-react';

interface FloatingSwitchWebGuiProps {
  node: NetworkNode;
  allNodes: NetworkNode[];
  allLinks: NetworkLink[];
  activeStep: SimulationStep | null;
  onSelectNode: (nodeId: string) => void;
  onUpdateNode: (updatedNode: NetworkNode) => void;
  onUpdateAllNodes?: (updatedNodes: NetworkNode[]) => void;
  onCreateLink?: (
    sourceNodeId: string,
    sourceIfaceId: string,
    targetNodeId: string,
    targetIfaceId: string,
    cableType?: CableType
  ) => void;
  onLoadSimulationSteps?: (steps: SimulationStep[], summaryMessage: string) => void;
  onOpenChassis: (nodeId: string) => void;
  onOpenFloatingCli: (nodeId: string) => void;
  onCreateZoneFromVlan?: (zone: NetworkZone) => void;
  onClose: () => void;
}

export const FloatingSwitchWebGui: React.FC<FloatingSwitchWebGuiProps> = ({
  node,
  allNodes,
  allLinks,
  activeStep,
  onSelectNode,
  onUpdateNode,
  onUpdateAllNodes,
  onCreateLink,
  onLoadSimulationSteps,
  onOpenChassis,
  onOpenFloatingCli,
  onCreateZoneFromVlan,
  onClose,
}) => {
  const [activeTab, setActiveTab] = useState<
    'ports' | 'vlans' | 'stp' | 'l3_lacp' | 'stack' | 'poe' | 'mac' | 'wifi' | 'wlc' | 'gpon'
  >(
    isGponOltNode(node) || isGponOntNode(node)
      ? 'gpon'
      : node.deviceModel === 'wlc' || node.wlcConfig
      ? 'wlc'
      : node.deviceModel === 'wifi_ap' || node.wifiConfig
      ? 'wifi'
      : 'ports'
  );
  const [position, setPosition] = useState<{ x: number; y: number }>({
    x: 210,
    y: 82,
  });
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isMinimized, setIsMinimized] = useState(false);

  // Bulk port selection & assignment state
  const [selectedPortIds, setSelectedPortIds] = useState<string[]>([]);
  const [bulkOperation, setBulkOperation] = useState<'access' | 'trunk-add'>('access');
  const [bulkVlanId, setBulkVlanId] = useState<number>(10);

  // New VLAN form state
  const [newVlanId, setNewVlanId] = useState<string>('30');
  const [newVlanName, setNewVlanName] = useState<string>('VLAN0030_Engineering');
  const [newVlanSubnet, setNewVlanSubnet] = useState<string>('192.168.30.0/24 · Инженерный сегмент');
  const [autoAllowOnTrunks, setAutoAllowOnTrunks] = useState<boolean>(true);

  // New SVI (interface Vlan<ID>) form state
  const [sviVlanId, setSviVlanId] = useState<string>('10');
  const [sviIpAddress, setSviIpAddress] = useState<string>('192.168.10.1');
  const [sviSubnetMask, setSviSubnetMask] = useState<string>('255.255.255.0');
  const [sviHelperAddress, setSviHelperAddress] = useState<string>('');

  // Quick EtherChannel LACP bundler state
  const [lacpGroupNumber, setLacpGroupNumber] = useState<number>(1);
  const [lacpMode, setLacpMode] = useState<'active' | 'passive' | 'on'>('active');

  // GPON OLT new authorized SN input
  const [newGponSnInput, setNewGponSnInput] = useState<string>('HWTC-1003E6F7');

  const [statusToast, setStatusToast] = useState<string | null>(null);

  useEffect(() => {
    setSelectedPortIds([]);
    if (isGponOltNode(node) || isGponOntNode(node)) {
      setActiveTab('gpon');
    } else if (node.deviceModel === 'wlc' || node.wlcConfig) {
      setActiveTab('wlc');
    } else if (node.deviceModel === 'wifi_ap' || node.wifiConfig) {
      setActiveTab('wifi');
    } else if (activeTab === 'wifi' || activeTab === 'wlc' || activeTab === 'gpon') {
      setActiveTab('ports');
    }
  }, [node.id]);

  useEffect(() => {
    if (!statusToast) return;
    const t = window.setTimeout(() => setStatusToast(null), 3200);
    return () => window.clearTimeout(t);
  }, [statusToast]);

  useEffect(() => {
    if (!isDragging) return;
    const handleMouseMove = (e: MouseEvent) => {
      const nextX = Math.max(12, Math.min(window.innerWidth - 360, e.clientX - dragOffset.x));
      const nextY = Math.max(44, Math.min(window.innerHeight - 90, e.clientY - dragOffset.y));
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
    if (target.closest('button') || target.closest('select') || target.closest('input')) {
      return;
    }
    setIsDragging(true);
    setDragOffset({
      x: e.clientX - position.x,
      y: e.clientY - position.y,
    });
  };

  const vlanDb = getDeviceVlanDatabase(node);
  const portDescriptors = getDeviceChassisPorts(node, allNodes, allLinks, activeStep);
  const stpState =
    node.type === 'switch' ? computeSpanningTreeState(allNodes, allLinks)[node.id] : undefined;
  const sviList = [...(node.sviInterfaces || [])].sort((a, b) => a.vlanId - b.vlanId);
  const allBundles = getEtherChannelBundles(allNodes, allLinks).filter(
    (b) => b.nodeAId === node.id || b.nodeBId === node.id
  );
  const nodeStackStatus = getNodeStackStatus(node, allNodes, allLinks);
  const poeStatus = computeSwitchPoeStatus(node, allNodes, allLinks);

  const switchableNodes = [...allNodes].sort((a, b) => {
    const order = { switch: 0, router: 1, server: 2, pc: 3 };
    return order[a.type] - order[b.type];
  });

  const syncSwitchNodeWithRoutes = (candidate: NetworkNode): NetworkNode => {
    const nextNodes = allNodes.map((n) => (n.id === candidate.id ? candidate : n));
    return {
      ...candidate,
      routingTable: syncConnectedRoutes(candidate, nextNodes, allLinks),
    };
  };

  const handleToggleSelectPort = (portId: string) => {
    setSelectedPortIds((prev) =>
      prev.includes(portId) ? prev.filter((id) => id !== portId) : [...prev, portId]
    );
  };

  const handleSelectAllAccessPorts = () => {
    const faIds = node.interfaces
      .filter((i) => !i.shortName.toLowerCase().startsWith('gi'))
      .map((i) => i.id);
    if (selectedPortIds.length === faIds.length && faIds.length > 0) {
      setSelectedPortIds([]);
    } else {
      setSelectedPortIds(faIds);
    }
  };

  const handleApplyBulkVlan = () => {
    if (selectedPortIds.length === 0) return;
    const updated = assignPortsToVlan(node, selectedPortIds, bulkVlanId, bulkOperation);
    onUpdateNode(syncSwitchNodeWithRoutes(updated));
    setStatusToast(
      bulkOperation === 'access'
        ? `Порты (${selectedPortIds.length} шт.) переведены в Access VLAN ${bulkVlanId}`
        : `VLAN ${bulkVlanId} добавлен в 802.1Q Trunk для ${selectedPortIds.length} портов`
    );
  };

  const handleUpdateSinglePort = (portId: string, patch: Partial<NetworkInterface>) => {
    const updatedInterfaces = node.interfaces.map((iface) =>
      iface.id === portId ? { ...iface, ...patch } : iface
    );
    const nextNode = syncSwitchNodeWithRoutes({
      ...node,
      interfaces: updatedInterfaces,
    });
    onUpdateNode(nextNode);
  };

  const handleToggleTrunkAllowedVlan = (iface: NetworkInterface, vlanId: number) => {
    const exists = iface.trunkAllowedVlans.includes(vlanId);
    const nextList = exists
      ? iface.trunkAllowedVlans.filter((v) => v !== vlanId)
      : [...iface.trunkAllowedVlans, vlanId].sort((a, b) => a - b);
    handleUpdateSinglePort(iface.id, {
      vlanMode: 'trunk',
      trunkAllowedVlans: nextList.length > 0 ? nextList : [1],
    });
  };

  const handleAddHardwarePort = () => {
    const updated = addHardwarePortToNode(node);
    onUpdateNode(updated);
    setStatusToast(
      `Добавлен новый порт ${updated.interfaces[updated.interfaces.length - 1]?.shortName || ''}`
    );
  };

  const handleCreateOrUpdateVlan = (e: React.FormEvent) => {
    e.preventDefault();
    const parsedId = Math.max(1, Math.min(4094, Math.floor(Number(newVlanId) || 1)));
    const updated = upsertDeviceVlan(
      node,
      parsedId,
      newVlanName,
      newVlanSubnet,
      autoAllowOnTrunks
    );
    onUpdateNode(syncSwitchNodeWithRoutes(updated));
    setBulkVlanId(parsedId);
    setStatusToast(`VLAN ${parsedId} (${newVlanName || `VLAN${parsedId}`}) сохранён в базе коммутатора`);
    const nextSuggested = parsedId + 10 <= 4094 ? parsedId + 10 : parsedId + 1;
    setNewVlanId(String(nextSuggested));
    setNewVlanName(`VLAN${String(nextSuggested).padStart(4, '0')}`);
  };

  const handleQuickPresetVlan = (id: number, name: string, subnetHint: string) => {
    const updated = upsertDeviceVlan(node, id, name, subnetHint, true);
    onUpdateNode(syncSwitchNodeWithRoutes(updated));
    setBulkVlanId(id);
    setStatusToast(`Добавлен стандартный сегмент VLAN ${id} (${name})`);
  };

  const handleDeleteVlan = (vlanId: number) => {
    if (vlanId === 1) return;
    const updated = deleteDeviceVlan(node, vlanId);
    onUpdateNode(syncSwitchNodeWithRoutes(updated));
    setStatusToast(`VLAN ${vlanId} удалён. Порты этого VLAN возвращены в VLAN 1.`);
  };

  const handleTogglePortInVlanCard = (iface: NetworkInterface, vlanId: number) => {
    if (iface.vlanMode === 'trunk') {
      handleToggleTrunkAllowedVlan(iface, vlanId);
      return;
    }
    const nextVlan = iface.accessVlan === vlanId && vlanId !== 1 ? 1 : vlanId;
    const updated = assignPortsToVlan(node, [iface.id], nextVlan, 'access');
    onUpdateNode(syncSwitchNodeWithRoutes(updated));
  };

  const handleSpawnCanvasZoneForVlan = (vlanId: number, name: string, subnetHint?: string) => {
    if (!onCreateZoneFromVlan) return;
    const colors: ZoneColor[] = ['sky', 'emerald', 'amber', 'indigo', 'purple', 'rose'];
    const color = colors[vlanId % colors.length];
    onCreateZoneFromVlan({
      id: `zone-vlan-${vlanId}-${Date.now()}`,
      title: `VLAN ${vlanId} — ${name}`,
      subnetLabel: subnetHint || `192.168.${vlanId}.0/24`,
      x: Math.max(60, node.x - 140),
      y: Math.max(60, node.y + 70),
      width: 310,
      height: 210,
      color,
    });
    setStatusToast(`На холст добавлена визуальная зона для VLAN ${vlanId}`);
  };

  // --- Stage 2: L3 Multilayer Switch (ip routing + SVI VlanX) & EtherChannel LACP handlers ---
  const handleToggleIpRouting = () => {
    const nextEnabled = !node.ipRoutingEnabled;
    const updated = syncSwitchNodeWithRoutes({
      ...node,
      ipRoutingEnabled: nextEnabled,
    });
    onUpdateNode(updated);
    setStatusToast(
      nextEnabled
        ? `Включена маршрутизация L3 (ip routing) на коммутаторе ${node.name}`
        : `Маршрутизация L3 (no ip routing) отключена на ${node.name}`
    );
  };

  const handleUpsertSvi = (
    vlanNum: number,
    ipAddr: string,
    maskAddr: string,
    helperAddr?: string
  ) => {
    const parsedVlan = Math.max(1, Math.min(4094, Math.floor(vlanNum || 1)));
    const existingList = [...(node.sviInterfaces || [])];
    const idx = existingList.findIndex((s) => s.vlanId === parsedVlan);
    const nextEntry: SwitchSviInterface =
      idx >= 0
        ? {
            ...existingList[idx],
            ipAddress: ipAddr.trim(),
            subnetMask: maskAddr.trim() || '255.255.255.0',
            adminStatus: 'up',
            helperAddress: helperAddr?.trim() || undefined,
          }
        : {
            id: `${node.id}-svi-vlan${parsedVlan}`,
            vlanId: parsedVlan,
            name: `Vlan${parsedVlan}`,
            ipAddress: ipAddr.trim(),
            subnetMask: maskAddr.trim() || '255.255.255.0',
            adminStatus: 'up',
            macAddress: generateSviMacAddress(node, parsedVlan),
            helperAddress: helperAddr?.trim() || undefined,
          };

    if (idx >= 0) {
      existingList[idx] = nextEntry;
    } else {
      existingList.push(nextEntry);
    }

    // Ensure VLAN exists in VLAN database as well
    const withVlan = upsertDeviceVlan(
      node,
      parsedVlan,
      `VLAN${String(parsedVlan).padStart(4, '0')}`,
      `${ipAddr}/${maskAddr}`,
      true
    );

    const updated = syncSwitchNodeWithRoutes({
      ...withVlan,
      ipRoutingEnabled: true,
      sviInterfaces: existingList,
    });
    onUpdateNode(updated);
    setStatusToast(
      `Интерфейс SVI Vlan${parsedVlan} (${ipAddr}/${maskAddr}) активен + включён ip routing`
    );
  };

  const handleSaveSviForm = (e: React.FormEvent) => {
    e.preventDefault();
    const vId = Number(sviVlanId) || 10;
    if (!sviIpAddress.trim()) return;
    handleUpsertSvi(vId, sviIpAddress, sviSubnetMask, sviHelperAddress);
    const nextVlan = vId === 10 ? 20 : vId === 20 ? 30 : vId + 10;
    setSviVlanId(String(nextVlan));
    setSviIpAddress(`192.168.${nextVlan}.1`);
  };

  const handleDeleteSvi = (vlanId: number) => {
    const nextSvis = (node.sviInterfaces || []).filter((s) => s.vlanId !== vlanId);
    const updated = syncSwitchNodeWithRoutes({
      ...node,
      sviInterfaces: nextSvis,
    });
    onUpdateNode(updated);
    setStatusToast(`Виртуальный интерфейс Vlan${vlanId} удалён`);
  };

  const handleToggleSviAdminStatus = (vlanId: number) => {
    const nextSvis = (node.sviInterfaces || []).map((s) =>
      s.vlanId === vlanId
        ? { ...s, adminStatus: (s.adminStatus === 'up' ? 'down' : 'up') as 'up' | 'down' }
        : s
    );
    const updated = syncSwitchNodeWithRoutes({
      ...node,
      sviInterfaces: nextSvis,
    });
    onUpdateNode(updated);
  };

  const handleTogglePortInChannelGroup = (port: NetworkInterface, groupNum: number) => {
    const isInThisGroup = port.channelGroup === groupNum;
    handleUpdateSinglePort(port.id, {
      channelGroup: isInThisGroup ? undefined : groupNum,
      channelMode: isInThisGroup ? undefined : lacpMode,
    });
    setStatusToast(
      isInThisGroup
        ? `Порт ${port.shortName} исключён из Port-channel ${groupNum} (Po${groupNum})`
        : `Порт ${port.shortName} добавлен в агрегацию Port-channel ${groupNum} (Po${groupNum} · ${lacpMode})`
    );
  };

  return (
    <div
      data-testid="floating-switch-web-gui"
      role="dialog"
      aria-label={`Веб-интерфейс коммутатора — ${node.name}`}
      style={{
        left: `${position.x}px`,
        top: `${position.y}px`,
      }}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      className="fixed z-45 w-[1030px] max-w-[96vw] rounded-lg bg-slate-950/98 border-2 border-indigo-500/60 shadow-[0_22px_55px_rgba(0,0,0,0.88)] select-none overflow-hidden flex flex-col"
    >
      {/* Top Draggable Browser-Like Switch Web GUI Header */}
      <div
        onMouseDown={handleHeaderMouseDown}
        className="flex items-center justify-between gap-2 px-3 py-1.5 bg-slate-900 border-b border-slate-800 cursor-move"
      >
        <div className="flex items-center gap-2 min-w-0">
          <GripHorizontal className="w-3.5 h-3.5 text-slate-500 shrink-0" />
          <div className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-indigo-950/90 border border-indigo-500/50 text-[10px] font-mono text-indigo-200 shrink-0">
            <Globe className="w-3 h-3 text-indigo-400" />
            <span>WebUI</span>
          </div>

          {node.ipRoutingEnabled && (
            <span className="px-1.5 py-0.5 rounded bg-emerald-950/90 border border-emerald-500/50 text-[10px] font-mono font-bold text-emerald-300 shrink-0">
              L3 SVI ROUTING
            </span>
          )}

          <select
            aria-label="Выбрать коммутатор в веб-интерфейсе"
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

          <input
            type="text"
            aria-label="Hostname коммутатора"
            value={node.name}
            onChange={(e) => onUpdateNode({ ...node, name: e.target.value })}
            placeholder="Hostname..."
            title="Переименовать коммутатор (hostname)"
            className="w-28 bg-slate-950 border border-slate-700 rounded px-2 py-0.5 text-xs font-mono text-slate-100 focus:outline-none focus:border-indigo-500"
          />
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={() => onOpenChassis(node.id)}
            title="Открыть физическую переднюю панель 1U (RJ-45)"
            className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-sky-950/80 hover:bg-sky-900 border border-sky-500/40 text-[10px] font-mono text-sky-300 transition-colors cursor-pointer"
          >
            <Cpu className="w-3 h-3" />
            <span>1U</span>
          </button>

          <button
            type="button"
            onClick={() => onOpenFloatingCli(node.id)}
            title="Открыть терминал Cisco IOS CLI"
            className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-emerald-950/80 hover:bg-emerald-900 border border-emerald-500/40 text-[10px] font-mono text-emerald-300 transition-colors cursor-pointer"
          >
            <Terminal className="w-3 h-3" />
            <span>CLI</span>
          </button>

          <button
            type="button"
            onClick={() => setIsMinimized((m) => !m)}
            aria-label={isMinimized ? 'Развернуть веб-интерфейс' : 'Свернуть веб-интерфейс'}
            title={isMinimized ? 'Развернуть окно' : 'Свернуть окно'}
            className="p-1 rounded text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <Minus className="w-3.5 h-3.5" />
          </button>

          <button
            type="button"
            onClick={onClose}
            aria-label="Закрыть веб-интерфейс коммутатора"
            title="Закрыть веб-интерфейс коммутатора"
            className="p-1 rounded text-slate-400 hover:text-red-300 hover:bg-red-950/60 transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {!isMinimized && (
        <div className="flex min-h-[470px] max-h-[530px] overflow-hidden">
          {/* Grouped Left Sidebar Navigation Menu */}
          <div
            data-testid="switch-left-sidebar"
            className="w-56 shrink-0 bg-slate-900/95 border-r border-slate-800 p-2.5 flex flex-col justify-between overflow-y-auto gap-3"
          >
            <div className="space-y-3">
              {/* Group 1: Коммутация L2 и STP */}
              <div className="space-y-1">
                <div className="px-2 text-[9px] font-mono uppercase tracking-wider text-slate-400 font-semibold">
                  Коммутация L2 и VLAN
                </div>

                <button
                  type="button"
                  data-testid="switch-tab-ports"
                  onClick={() => setActiveTab('ports')}
                  className={`w-full flex items-center justify-between gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium transition-colors cursor-pointer ${
                    activeTab === 'ports'
                      ? 'bg-indigo-600 text-white shadow-xs'
                      : 'text-slate-300 hover:text-white hover:bg-slate-800/80'
                  }`}
                >
                  <span className="flex items-center gap-1.5 truncate">
                    <SlidersHorizontal className="w-3.5 h-3.5 shrink-0" />
                    <span className="truncate">Порты и VLAN</span>
                  </span>
                  <span className="px-1.5 py-0.2 rounded bg-slate-950/60 text-[10px] font-mono shrink-0">
                    {node.interfaces.length}
                  </span>
                </button>

                <button
                  type="button"
                  data-testid="switch-tab-vlans"
                  onClick={() => setActiveTab('vlans')}
                  className={`w-full flex items-center justify-between gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium transition-colors cursor-pointer ${
                    activeTab === 'vlans'
                      ? 'bg-indigo-600 text-white shadow-xs'
                      : 'text-slate-300 hover:text-white hover:bg-slate-800/80'
                  }`}
                >
                  <span className="flex items-center gap-1.5 truncate">
                    <Layers className="w-3.5 h-3.5 shrink-0" />
                    <span className="truncate">База VLAN</span>
                  </span>
                  <span className="px-1.5 py-0.2 rounded bg-slate-950/60 text-[10px] font-mono shrink-0">
                    {vlanDb.length}
                  </span>
                </button>

                <button
                  type="button"
                  data-testid="switch-tab-stp"
                  onClick={() => setActiveTab('stp')}
                  className={`w-full flex items-center justify-between gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium transition-colors cursor-pointer ${
                    activeTab === 'stp'
                      ? 'bg-indigo-600 text-white shadow-xs'
                      : 'text-slate-300 hover:text-white hover:bg-slate-800/80'
                  }`}
                >
                  <span className="flex items-center gap-1.5 truncate">
                    <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
                    <span className="truncate">Spanning Tree</span>
                  </span>
                  <span
                    className={`px-1.5 py-0.2 rounded text-[9px] font-mono shrink-0 ${
                      stpState?.isRootBridge
                        ? 'bg-emerald-950/90 text-emerald-300 border border-emerald-500/40'
                        : 'bg-slate-950/60 text-slate-300'
                    }`}
                  >
                    {stpState?.isRootBridge ? 'ROOT' : '802.1D'}
                  </span>
                </button>

                <button
                  type="button"
                  data-testid="switch-tab-mac"
                  onClick={() => setActiveTab('mac')}
                  className={`w-full flex items-center justify-between gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium transition-colors cursor-pointer ${
                    activeTab === 'mac'
                      ? 'bg-indigo-600 text-white shadow-xs'
                      : 'text-slate-300 hover:text-white hover:bg-slate-800/80'
                  }`}
                >
                  <span className="flex items-center gap-1.5 truncate">
                    <Table2 className="w-3.5 h-3.5 shrink-0" />
                    <span className="truncate">Таблица MAC</span>
                  </span>
                  <span className="px-1.5 py-0.2 rounded bg-slate-950/60 text-[10px] font-mono shrink-0">
                    {node.macTable.length}
                  </span>
                </button>
              </div>

              {/* Group 2: Агрегация, Маршрутизация L3 и Стек */}
              <div className="space-y-1 pt-1 border-t border-slate-800/80">
                <div className="px-2 text-[9px] font-mono uppercase tracking-wider text-slate-400 font-semibold">
                  Маршрутизация L3 и Стек
                </div>

                <button
                  type="button"
                  data-testid="switch-tab-l3-lacp"
                  onClick={() => setActiveTab('l3_lacp')}
                  className={`w-full flex items-center justify-between gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium transition-colors cursor-pointer ${
                    activeTab === 'l3_lacp'
                      ? 'bg-emerald-600 text-white shadow-xs'
                      : 'text-emerald-300 hover:text-white hover:bg-slate-800/80'
                  }`}
                >
                  <span className="flex items-center gap-1.5 truncate">
                    <GitMerge className="w-3.5 h-3.5 shrink-0" />
                    <span className="truncate">SVI L3 & LACP</span>
                  </span>
                  <span className="px-1.5 py-0.2 rounded bg-slate-950/60 text-[10px] font-mono shrink-0">
                    {sviList.length}/{allBundles.length}Po
                  </span>
                </button>

                <button
                  type="button"
                  data-testid="switch-tab-stack"
                  onClick={() => setActiveTab('stack')}
                  className={`w-full flex items-center justify-between gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium transition-colors cursor-pointer ${
                    activeTab === 'stack'
                      ? 'bg-amber-500 text-slate-950 font-semibold shadow-xs'
                      : 'text-amber-300 hover:text-white hover:bg-slate-800/80'
                  }`}
                >
                  <span className="flex items-center gap-1.5 truncate">
                    <Layers className="w-3.5 h-3.5 shrink-0" />
                    <span className="truncate">Стек StackWise</span>
                  </span>
                  <span className="px-1.5 py-0.2 rounded bg-slate-950/60 text-[9px] font-mono text-amber-200 shrink-0">
                    {nodeStackStatus
                      ? `#${nodeStackStatus.memberNumber} ${
                          nodeStackStatus.role === 'master'
                            ? 'MST'
                            : nodeStackStatus.role === 'standby'
                            ? 'STB'
                            : 'MBR'
                        }`
                      : 'OFF'}
                  </span>
                </button>
              </div>

              {/* Group 3: Питание PoE и Беспроводная сеть */}
              <div className="space-y-1 pt-1 border-t border-slate-800/80">
                <div className="px-2 text-[9px] font-mono uppercase tracking-wider text-slate-400 font-semibold">
                  Питание PoE и Радиосеть
                </div>

                {!node.wifiConfig && node.deviceModel !== 'wlc' && (
                  <button
                    type="button"
                    data-testid="switch-tab-poe"
                    onClick={() => setActiveTab('poe')}
                    className={`w-full flex items-center justify-between gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium transition-colors cursor-pointer ${
                      activeTab === 'poe'
                        ? 'bg-fuchsia-600 text-white shadow-xs'
                        : 'text-fuchsia-300 hover:text-white hover:bg-slate-800/80'
                    }`}
                  >
                    <span className="flex items-center gap-1.5 truncate">
                      <Zap className="w-3.5 h-3.5 shrink-0" />
                      <span className="truncate">Питание PoE & Voice</span>
                    </span>
                    <span className="px-1.5 py-0.2 rounded bg-slate-950/60 text-[9px] font-mono shrink-0">
                      {poeStatus.usedWatts}W
                    </span>
                  </button>
                )}

                {(node.deviceModel === 'wifi_ap' || Boolean(node.wifiConfig)) && (
                  <button
                    type="button"
                    data-testid="switch-tab-wifi"
                    onClick={() => setActiveTab('wifi')}
                    className={`w-full flex items-center justify-between gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium transition-colors cursor-pointer ${
                      activeTab === 'wifi'
                        ? 'bg-cyan-600 text-white shadow-xs'
                        : 'text-cyan-300 hover:text-white hover:bg-slate-800/80'
                    }`}
                  >
                    <span className="flex items-center gap-1.5 truncate">
                      <Wifi className="w-3.5 h-3.5 shrink-0" />
                      <span className="truncate">Wi-Fi 802.11 AP</span>
                    </span>
                    <span className="px-1.5 py-0.2 rounded bg-slate-950/60 text-[9px] font-mono shrink-0">
                      {node.wifiConfig?.band || '5GHz'}
                    </span>
                  </button>
                )}

                {(node.deviceModel === 'wlc' || Boolean(node.wlcConfig)) && (
                  <button
                    type="button"
                    data-testid="switch-tab-wlc"
                    onClick={() => setActiveTab('wlc')}
                    className={`w-full flex items-center justify-between gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium transition-colors cursor-pointer ${
                      activeTab === 'wlc'
                        ? 'bg-cyan-600 text-white shadow-xs'
                        : 'text-cyan-300 hover:text-white hover:bg-slate-800/80'
                    }`}
                  >
                    <span className="flex items-center gap-1.5 truncate">
                      <Server className="w-3.5 h-3.5 shrink-0" />
                      <span className="truncate">WLC Контроллер</span>
                    </span>
                    <span className="px-1.5 py-0.2 rounded bg-slate-950/60 text-[9px] font-mono shrink-0">
                      CAPWAP
                    </span>
                  </button>
                )}

                {(isGponOltNode(node) || isGponOntNode(node)) && (() => {
                  const ontState = isGponOntNode(node)
                    ? computeGponOntOpticalState(node, allNodes, allLinks)
                    : null;
                  const connectedOnts = isGponOltNode(node)
                    ? computeGponOltConnectedOnts(node, allNodes, allLinks)
                    : [];
                  const hasLosAlarm = ontState
                    ? ontState.isLos
                    : connectedOnts.some((o) => o.isLos);

                  return (
                    <button
                      type="button"
                      data-testid="switch-tab-gpon"
                      onClick={() => setActiveTab('gpon')}
                      className={`w-full flex items-center justify-between gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium transition-colors cursor-pointer ${
                        activeTab === 'gpon'
                          ? hasLosAlarm
                            ? 'bg-red-600 text-white shadow-xs'
                            : 'bg-teal-600 text-white shadow-xs'
                          : hasLosAlarm
                          ? 'text-red-300 hover:text-white hover:bg-red-950/50'
                          : 'text-teal-300 hover:text-white hover:bg-slate-800/80'
                      }`}
                    >
                      <span className="flex items-center gap-1.5 truncate">
                        <Activity className="w-3.5 h-3.5 shrink-0" />
                        <span className="truncate">
                          {isGponOltNode(node) ? 'Оптика GPON OLT' : 'Оптика GPON ONT'}
                        </span>
                      </span>
                      <span
                        className={`px-1.5 py-0.2 rounded text-[9px] font-mono shrink-0 ${
                          hasLosAlarm
                            ? 'bg-red-950 text-red-200 border border-red-400/60 font-bold'
                            : 'bg-slate-950/60 text-teal-200'
                        }`}
                      >
                        {ontState
                          ? ontState.isLos
                            ? 'LOS'
                            : `${ontState.rxPowerDbm}dBm`
                          : `1490/1310`}
                      </span>
                    </button>
                  );
                })()}
              </div>
            </div>

            {/* Bottom Hardware Action */}
            <div className="pt-2 border-t border-slate-800 space-y-1.5">
              <button
                type="button"
                onClick={handleAddHardwarePort}
                className="w-full flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs font-mono text-sky-300 transition-colors cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>+ Добавить порт</span>
              </button>
            </div>
          </div>

          {/* Right Scrollable Content Area */}
          <div className="flex-1 min-w-0 max-h-[530px] overflow-y-auto p-3.5 space-y-3">
            {/* Compact Active Section Bar + Status Toast */}
            <div className="flex items-center justify-between gap-2 pb-2 border-b border-slate-800/80">
              <div className="text-xs font-mono font-semibold text-slate-200 flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-indigo-400" />
                <span>
                  {activeTab === 'ports' && `Физические порты и 802.1Q VLAN (${node.interfaces.length})`}
                  {activeTab === 'vlans' && `База данных VLAN IEEE 802.1Q (${vlanDb.length})`}
                  {activeTab === 'stp' && 'Протокол связующего дерева Spanning Tree (IEEE 802.1D / RSTP)'}
                  {activeTab === 'l3_lacp' && `Маршрутизация L3 (SVI) и Агрегация LACP (${sviList.length} SVI · ${allBundles.length} Po)`}
                  {activeTab === 'stack' && 'Стекирование коммутаторов Cisco StackWise-480'}
                  {activeTab === 'poe' && `Питание Power over Ethernet (802.3af/at) и Voice VLAN (${poeStatus.usedWatts}W / ${poeStatus.totalBudgetWatts}W)`}
                  {activeTab === 'mac' && `Таблица коммутации MAC-адресов CAM (${node.macTable.length})`}
                  {activeTab === 'wifi' && `Радиомодуль точки доступа Wi-Fi 802.11 (${node.wifiConfig?.ssid || 'Corp-WiFi'})`}
                  {activeTab === 'wlc' && 'Беспроводной контроллер Cisco WLC (CAPWAP UDP 5246/5247)'}
                  {activeTab === 'gpon' &&
                    (isGponOltNode(node)
                      ? `Станционный оптический терминал GPON OLT (1490 нм TX / 1310 нм RX · ITU-T G.984)`
                      : `Абонентский оптический модем GPON ONT / ONU (Бюджет dBm · LOS -28 dBm · Triple-Play)`)}
                </span>
              </div>

              {statusToast && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-950/90 border border-emerald-500/50 text-[10px] font-mono text-emerald-300 shrink-0">
                  <ShieldCheck className="w-3 h-3 shrink-0" />
                  <span className="truncate max-w-[260px]">{statusToast}</span>
                </span>
              )}
            </div>

            {/* DEDICATED TAB: SPANNING TREE PROTOCOL (STP 802.1D) */}
            {activeTab === 'stp' && (
              <div className="space-y-3" data-testid="switch-stp-panel">
                <div className="p-3 rounded-md bg-slate-900/95 border border-indigo-500/40 flex flex-wrap items-center justify-between gap-3">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold border ${
                          stpState?.isRootBridge
                            ? 'bg-emerald-950/90 border-emerald-500/60 text-emerald-300'
                            : 'bg-indigo-950/90 border-indigo-500/50 text-indigo-300'
                        }`}
                      >
                        {stpState?.isRootBridge ? 'ROOT BRIDGE (Корневой мост)' : 'NON-ROOT BRIDGE'}
                      </span>
                      <span className="text-xs font-mono text-slate-300">
                        Root Bridge:{' '}
                        <strong className="text-sky-300">
                          {stpState?.rootBridgeName || node.name}
                        </strong>{' '}
                        · Root Path Cost:{' '}
                        <strong className="text-amber-300">{stpState?.rootPathCost ?? 0}</strong>
                      </span>
                    </div>
                    <p className="text-[11px] text-slate-400">
                      Коммутатор с наименьшим Bridge Priority (по умолчанию 32768) избирается
                      корневым мостом (Root Bridge). Избыточные петлевые линки переводятся в{' '}
                      <span className="text-orange-300 font-mono">Alternate / BLK</span>.
                    </p>
                  </div>

                  <div className="flex items-center gap-2">
                    <span className="text-xs font-mono text-slate-300">Bridge Priority:</span>
                    <select
                      aria-label="Приоритет STP коммутатора"
                      data-testid="switch-stp-priority-select"
                      value={node.stpPriority ?? 32768}
                      onChange={(e) => {
                        const prio = Number(e.target.value) || 32768;
                        onUpdateNode({ ...node, stpPriority: prio });
                        setStatusToast(
                          `STP Priority для ${node.name} изменён на ${prio} (пересчёт Root Bridge)`
                        );
                      }}
                      className="px-2.5 py-1 rounded bg-slate-950 border border-slate-700 text-xs font-mono text-amber-300 cursor-pointer"
                    >
                      <option value={4096}>4096 (Primary Root)</option>
                      <option value={8192}>8192 (Secondary Root)</option>
                      <option value={16384}>16384</option>
                      <option value={24576}>24576</option>
                      <option value={32768}>32768 (Default)</option>
                      <option value={40960}>40960</option>
                    </select>
                  </div>
                </div>

                <div className="rounded-md border border-slate-800 overflow-x-auto bg-slate-950">
                  <table className="w-full min-w-[680px] text-left border-collapse text-xs">
                    <thead>
                      <tr className="bg-slate-900/95 border-b border-slate-800 text-[10px] font-mono uppercase text-slate-400">
                        <th className="py-2 px-3 w-[100px] whitespace-nowrap">Порт</th>
                        <th className="py-2 px-2.5 w-[165px] whitespace-nowrap">Соседнее устройство</th>
                        <th className="py-2 px-2.5 w-[145px] whitespace-nowrap">Роль STP (Role)</th>
                        <th className="py-2 px-2.5 w-[130px] whitespace-nowrap">Состояние (State)</th>
                        <th className="py-2 px-2 w-[75px] text-center whitespace-nowrap">Cost</th>
                        <th className="py-2 px-3 min-w-[130px] whitespace-nowrap">Режим VLAN</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/70 bg-slate-950/60 font-mono">
                      {portDescriptors.map(({ port: iface, link, peerNode, peerPort: peerIface }) => {
                        const pStp = stpState?.ports[iface.id];
                        const isGi = iface.shortName.toLowerCase().startsWith('gi');
                        const portCost = iface.channelGroup ? 3 : isGi ? 4 : 19;
                        return (
                          <tr key={iface.id} className="hover:bg-slate-900/40">
                            <td className="py-2 px-3 align-middle whitespace-nowrap font-bold text-slate-200">
                              <span>{iface.shortName}</span>
                              {iface.channelGroup ? (
                                <span className="ml-1.5 px-1 py-0.2 rounded bg-cyan-950 border border-cyan-500/40 text-[9px] text-cyan-300">
                                  Po{iface.channelGroup}
                                </span>
                              ) : null}
                            </td>
                            <td className="py-2 px-2.5 align-middle whitespace-nowrap text-[11px] text-slate-300">
                              {peerNode ? (
                                <span className="text-sky-300">
                                  {peerNode.name}
                                  <span className="text-slate-400">:{peerIface?.shortName || ''}</span>
                                </span>
                              ) : (
                                <span className="text-slate-500">— не подключен</span>
                              )}
                            </td>
                            <td className="py-2 px-2.5 align-middle whitespace-nowrap">
                              {pStp ? (
                                <span
                                  className={`inline-block px-2 py-0.5 rounded text-[10px] font-bold border ${
                                    pStp.role === 'root'
                                      ? 'bg-sky-950/80 border-sky-500/50 text-sky-300'
                                      : pStp.role === 'designated'
                                      ? 'bg-emerald-950/80 border-emerald-500/50 text-emerald-300'
                                      : 'bg-orange-950/80 border-orange-500/50 text-orange-300'
                                  }`}
                                >
                                  {pStp.role === 'root'
                                    ? 'Root Port (RP)'
                                    : pStp.role === 'designated'
                                    ? 'Designated (DP)'
                                    : 'Alternate (ALT)'}
                                </span>
                              ) : (
                                <span className="text-slate-500 text-[10px]">Edge / PortFast</span>
                              )}
                            </td>
                            <td className="py-2 px-2.5 align-middle whitespace-nowrap">
                              {!link || iface.adminStatus === 'down' ? (
                                <span className="text-slate-500 text-[10px]">DISABLED</span>
                              ) : pStp?.state === 'blocking' ? (
                                <span className="inline-block px-2 py-0.5 rounded bg-orange-950/90 border border-orange-500/60 text-orange-300 text-[10px] font-bold">
                                  BLK (Blocking)
                                </span>
                              ) : (
                                <span className="inline-block px-2 py-0.5 rounded bg-emerald-950/90 border border-emerald-500/50 text-emerald-300 text-[10px] font-bold">
                                  FWD (Forwarding)
                                </span>
                              )}
                            </td>
                            <td className="py-2 px-2 align-middle text-center whitespace-nowrap text-amber-300 font-semibold">
                              {link ? portCost : '—'}
                            </td>
                            <td className="py-2 px-3 align-middle whitespace-nowrap text-[11px] text-slate-300">
                              {iface.vlanMode === 'trunk' ? (
                                <span className="text-indigo-300">
                                  802.1Q Trunk ({iface.trunkAllowedVlans.join(',')})
                                </span>
                              ) : (
                                <span className="text-sky-300">Access VLAN {iface.accessVlan}</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* TAB 1: SWITCH PORT CONFIGURATION & 802.1Q VLAN ASSIGNMENT */}
            {activeTab === 'ports' && (
              <>
                {/* Spanning Tree Protocol (STP 802.1D) Summary & Priority Bar */}
                {stpState && (
                  <div className="p-2 rounded-md bg-slate-900/95 border border-slate-800 flex flex-wrap items-center justify-between gap-2 text-xs font-mono">
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] font-bold border shrink-0 ${
                          stpState.isRootBridge
                            ? 'bg-emerald-950/80 border-emerald-500/60 text-emerald-300'
                            : 'bg-indigo-950/80 border-indigo-500/50 text-indigo-300'
                        }`}
                      >
                        STP 802.1D: {stpState.isRootBridge ? 'ROOT BRIDGE' : 'NON-ROOT'}
                      </span>
                      <span className="text-[11px] text-slate-300 truncate">
                        Root: <strong className="text-sky-300">{stpState.rootBridgeName}</strong>{' '}
                        (Cost: {stpState.rootPathCost})
                      </span>
                    </div>

                    <div className="flex items-center gap-1.5">
                      <span className="text-[10px] text-slate-400">Bridge Priority:</span>
                      <select
                        aria-label="Приоритет STP коммутатора"
                        value={node.stpPriority ?? 32768}
                        onChange={(e) => {
                          const prio = Number(e.target.value) || 32768;
                          onUpdateNode({ ...node, stpPriority: prio });
                          setStatusToast(
                            `STP Priority для ${node.name} изменён на ${prio} (пересчёт Root Bridge)`
                          );
                        }}
                        className="px-2 py-0.5 rounded bg-slate-950 border border-slate-700 text-[11px] text-amber-300 cursor-pointer"
                      >
                        <option value={4096}>4096 (Primary Root)</option>
                        <option value={8192}>8192 (Secondary Root)</option>
                        <option value={24576}>24576</option>
                        <option value={32768}>32768 (Default)</option>
                        <option value={40960}>40960</option>
                      </select>
                    </div>
                  </div>
                )}

                {/* Bulk Assignment Toolbar */}
                <div className="p-2 rounded-md bg-slate-900/90 border border-slate-800 flex items-center justify-between gap-2 text-xs">
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={handleSelectAllAccessPorts}
                      className="flex items-center gap-1.5 px-2 py-1 rounded bg-slate-950 hover:bg-slate-800 border border-slate-700 text-[11px] text-slate-200 whitespace-nowrap transition-colors cursor-pointer"
                    >
                      {selectedPortIds.length > 0 ? (
                        <CheckSquare className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                      ) : (
                        <Square className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                      )}
                      <span>
                        {selectedPortIds.length > 0
                          ? `Выбрано: ${selectedPortIds.length}`
                          : 'Выбрать все Fa'}
                      </span>
                    </button>

                    {selectedPortIds.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setSelectedPortIds([])}
                        className="text-[11px] text-slate-400 hover:text-slate-200 underline whitespace-nowrap cursor-pointer"
                      >
                        Сбросить
                      </button>
                    )}
                  </div>

                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="text-[11px] text-slate-400 whitespace-nowrap">Групповое действие:</span>
                    <select
                      aria-label="Групповой режим назначения VLAN"
                      value={bulkOperation}
                      onChange={(e) =>
                        setBulkOperation(e.target.value as 'access' | 'trunk-add')
                      }
                      className="px-2 py-1 rounded bg-slate-950 border border-slate-700 text-[11px] font-mono text-slate-200"
                    >
                      <option value="access">Access →</option>
                      <option value="trunk-add">Trunk (+VLAN) →</option>
                    </select>

                    <select
                      aria-label="Целевой VLAN для группового применения"
                      value={bulkVlanId}
                      onChange={(e) => setBulkVlanId(Number(e.target.value))}
                      className="px-2 py-1 rounded bg-slate-950 border border-slate-700 text-[11px] font-mono text-indigo-300"
                    >
                      {vlanDb.map((v) => (
                        <option key={v.id} value={v.id}>
                          VLAN {v.id} ({v.name})
                        </option>
                      ))}
                    </select>

                    <button
                      type="button"
                      disabled={selectedPortIds.length === 0}
                      onClick={handleApplyBulkVlan}
                      className={`px-2.5 py-1 rounded text-[11px] font-medium whitespace-nowrap transition-colors ${
                        selectedPortIds.length > 0
                          ? 'bg-indigo-600 hover:bg-indigo-500 text-white cursor-pointer'
                          : 'bg-slate-800 text-slate-500 cursor-not-allowed'
                      }`}
                    >
                      Применить
                    </button>
                  </div>
                </div>

                {/* Port Configuration Table */}
                <div className="rounded-md border border-slate-800 overflow-x-auto bg-slate-950">
                  <table className="w-full min-w-[730px] text-left border-collapse text-xs">
                    <thead>
                      <tr className="bg-slate-900/95 border-b border-slate-800 text-[10px] font-mono uppercase text-slate-400">
                        <th className="py-2 px-2 w-[36px] text-center whitespace-nowrap">Выб</th>
                        <th className="py-2 px-2.5 w-[130px] whitespace-nowrap">Порт / STP / Po#</th>
                        <th className="py-2 px-2.5 w-[146px] whitespace-nowrap">Питание / Линк</th>
                        <th className="py-2 px-2 w-[144px] whitespace-nowrap">Режим L2</th>
                        <th className="py-2 px-2 w-[116px] whitespace-nowrap">LACP (Po#)</th>
                        <th className="py-2 px-2.5 min-w-[175px] whitespace-nowrap">
                          Привязка к VLAN (Access / 802.1Q)
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/70">
                      {portDescriptors.map((desc) => {
                        const { port, peerNode, peerPort, stpPortStatus } = desc;
                        const isChecked = selectedPortIds.includes(port.id);

                        return (
                          <tr
                            key={port.id}
                            className={`transition-colors ${
                              isChecked ? 'bg-indigo-950/30' : 'hover:bg-slate-900/60'
                            }`}
                          >
                            {/* Checkbox */}
                            <td className="py-2 px-2 align-middle text-center">
                              <input
                                type="checkbox"
                                aria-label={`Выбрать порт ${port.shortName}`}
                                checked={isChecked}
                                onChange={() => handleToggleSelectPort(port.id)}
                                className="rounded border-slate-700 bg-slate-900 text-indigo-500 focus:ring-0 cursor-pointer"
                              />
                            </td>

                            {/* Port Name, Speed, STP Role/State & Port-channel badge */}
                            <td className="py-2 px-2.5 align-middle font-mono whitespace-nowrap">
                              <div className="font-semibold text-slate-100 flex items-center gap-1 flex-wrap">
                                <span>{port.shortName}</span>
                                {desc.isUplink && (
                                  <span className="px-1 py-0.2 text-[9px] rounded bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
                                    1G
                                  </span>
                                )}
                                {port.channelGroup && (
                                  <span
                                    title={`EtherChannel Port-channel ${port.channelGroup} (${port.channelMode || 'active'})`}
                                    className="px-1 py-0.2 text-[9px] rounded bg-cyan-500/20 border border-cyan-400/60 text-cyan-300 font-bold"
                                  >
                                    Po{port.channelGroup}
                                  </span>
                                )}
                                {stpPortStatus && stpPortStatus.state !== 'disabled' && (
                                  <span
                                    title={`STP 802.1D: ${stpPortStatus.role.toUpperCase()} (${stpPortStatus.state.toUpperCase()})`}
                                    className={`px-1 py-0.2 text-[9px] rounded border font-bold ${
                                      stpPortStatus.state === 'blocking'
                                        ? 'bg-orange-500/25 border-orange-400/70 text-orange-300'
                                        : stpPortStatus.role === 'root'
                                        ? 'bg-sky-500/20 border-sky-400/50 text-sky-300'
                                        : 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                                    }`}
                                  >
                                    {stpPortStatus.state === 'blocking'
                                      ? 'BLK'
                                      : stpPortStatus.role === 'root'
                                      ? 'RP'
                                      : 'DP'}
                                  </span>
                                )}
                              </div>
                              <div className="text-[9px] text-slate-500">
                                {port.macAddress}
                              </div>
                            </td>

                            {/* Admin Power + Connected Peer */}
                            <td className="py-2 px-2.5 align-middle whitespace-nowrap">
                              <div className="flex items-center gap-1.5">
                                <button
                                  type="button"
                                  onClick={() =>
                                    handleUpdateSinglePort(port.id, {
                                      adminStatus: port.adminStatus === 'up' ? 'down' : 'up',
                                    })
                                  }
                                  className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono border shrink-0 transition-colors cursor-pointer ${
                                    port.adminStatus === 'up'
                                      ? 'bg-emerald-950/70 border-emerald-600/50 text-emerald-300'
                                      : 'bg-red-950/70 border-red-700/60 text-red-300'
                                  }`}
                                >
                                  <Power className="w-2.5 h-2.5" />
                                  <span>{port.adminStatus === 'up' ? 'UP' : 'SHUT'}</span>
                                </button>

                                {peerNode ? (
                                  <span
                                    className="text-[10px] font-mono text-sky-300 truncate max-w-[96px]"
                                    title={`${peerNode.name}:${peerPort?.shortName}`}
                                  >
                                    {peerNode.name}:{peerPort?.shortName}
                                  </span>
                                ) : (
                                  <span className="text-[10px] font-mono text-slate-500">
                                    Свободен
                                  </span>
                                )}
                              </div>
                            </td>

                            {/* L2 Mode (Access / Trunk) */}
                            <td className="py-2 px-2 align-middle whitespace-nowrap">
                              <select
                                aria-label={`Режим коммутации порта ${port.shortName}`}
                                value={port.vlanMode}
                                onChange={(e) =>
                                  handleUpdateSinglePort(port.id, {
                                    vlanMode: e.target.value as 'access' | 'trunk',
                                  })
                                }
                                className={`w-full px-1.5 py-1 rounded text-[11px] font-mono border focus:outline-none cursor-pointer ${
                                  port.vlanMode === 'trunk'
                                    ? 'bg-indigo-950/80 border-indigo-500/60 text-indigo-200 font-semibold'
                                    : 'bg-slate-900 border-slate-700 text-slate-200'
                                }`}
                              >
                                <option value="access">Access</option>
                                <option value="trunk">802.1Q Trunk</option>
                              </select>
                            </td>

                            {/* LACP EtherChannel Group Selector */}
                            <td className="py-2 px-2 align-middle whitespace-nowrap">
                              <select
                                aria-label={`Группа агрегации EtherChannel для порта ${port.shortName}`}
                                value={port.channelGroup || 0}
                                onChange={(e) => {
                                  const g = Number(e.target.value) || 0;
                                  handleUpdateSinglePort(port.id, {
                                    channelGroup: g > 0 ? g : undefined,
                                    channelMode: g > 0 ? port.channelMode || 'active' : undefined,
                                  });
                                }}
                                className={`w-full px-1.5 py-1 rounded text-[11px] font-mono border focus:outline-none cursor-pointer ${
                                  port.channelGroup
                                    ? 'bg-cyan-950/80 border-cyan-400/60 text-cyan-200 font-bold'
                                    : 'bg-slate-900 border-slate-700 text-slate-400'
                                }`}
                              >
                                <option value={0}>Нет (Off)</option>
                                {[1, 2, 3, 4, 5, 6].map((g) => (
                                  <option key={g} value={g}>
                                    Po{g} (LACP)
                                  </option>
                                ))}
                              </select>
                            </td>

                            {/* VLAN Assignment Cell */}
                            <td className="py-2 px-2.5 align-middle">
                              {port.vlanMode === 'access' ? (
                                <select
                                  aria-label={`Выбрать Access VLAN для порта ${port.shortName}`}
                                  value={port.accessVlan}
                                  onChange={(e) => {
                                    const nextVlan = Number(e.target.value) || 1;
                                    const updated = assignPortsToVlan(
                                      node,
                                      [port.id],
                                      nextVlan,
                                      'access'
                                    );
                                    onUpdateNode(syncSwitchNodeWithRoutes(updated));
                                  }}
                                  className="w-full px-2 py-1 rounded bg-slate-900 border border-slate-700 text-[11px] font-mono text-sky-300 focus:outline-none focus:border-sky-500 cursor-pointer"
                                >
                                  {vlanDb.map((v) => (
                                    <option key={v.id} value={v.id}>
                                      VLAN {v.id} ({v.name})
                                    </option>
                                  ))}
                                </select>
                              ) : (
                                <div className="flex flex-wrap items-center gap-1">
                                  {vlanDb.map((v) => {
                                    const allowed = port.trunkAllowedVlans.includes(v.id);
                                    return (
                                      <button
                                        key={v.id}
                                        type="button"
                                        onClick={() =>
                                          handleToggleTrunkAllowedVlan(port, v.id)
                                        }
                                        title={
                                          allowed
                                            ? `VLAN ${v.id} (${v.name}) разрешён в Trunk — кликните, чтобы убрать`
                                            : `Кликните, чтобы разрешить VLAN ${v.id} (${v.name}) в Trunk`
                                        }
                                        className={`px-1.5 py-0.5 rounded text-[10px] font-mono border transition-colors cursor-pointer ${
                                          allowed
                                            ? 'bg-indigo-600/80 border-indigo-400 text-white font-semibold'
                                            : 'bg-slate-900 border-slate-800 text-slate-500 hover:text-slate-300'
                                        }`}
                                      >
                                        {v.id}
                                      </button>
                                    );
                                  })}
                                </div>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            {/* TAB 2: VLAN DATABASE & SEGMENT CREATION */}
            {activeTab === 'vlans' && (
              <div className="space-y-3">
                {/* Create / Edit VLAN Form */}
                <form
                  onSubmit={handleCreateOrUpdateVlan}
                  className="p-3 rounded-md bg-slate-900/90 border border-slate-800 space-y-2.5"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-slate-100">
                      Добавить новый VLAN в базу коммутатора
                    </span>
                    <div className="flex items-center gap-1">
                      <span className="text-[10px] text-slate-400">Шаблоны:</span>
                      <button
                        type="button"
                        onClick={() =>
                          handleQuickPresetVlan(
                            10,
                            'VLAN0010_Sales',
                            '192.168.10.0/24 · Отдел продаж'
                          )
                        }
                        className="px-1.5 py-0.5 rounded bg-slate-950 hover:bg-slate-800 border border-slate-700 text-[10px] font-mono text-sky-300 cursor-pointer"
                      >
                        +VLAN 10
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          handleQuickPresetVlan(
                            20,
                            'VLAN0020_DataCenter',
                            '192.168.20.0/24 · ЦОД'
                          )
                        }
                        className="px-1.5 py-0.5 rounded bg-slate-950 hover:bg-slate-800 border border-slate-700 text-[10px] font-mono text-emerald-300 cursor-pointer"
                      >
                        +VLAN 20
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          handleQuickPresetVlan(
                            30,
                            'VLAN0030_Engineering',
                            '192.168.30.0/24 · Инженеры'
                          )
                        }
                        className="px-1.5 py-0.5 rounded bg-slate-950 hover:bg-slate-800 border border-slate-700 text-[10px] font-mono text-amber-300 cursor-pointer"
                      >
                        +VLAN 30
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          handleQuickPresetVlan(
                            99,
                            'VLAN0099_Management',
                            '10.99.0.0/24 · Управление'
                          )
                        }
                        className="px-1.5 py-0.5 rounded bg-slate-950 hover:bg-slate-800 border border-slate-700 text-[10px] font-mono text-indigo-300 cursor-pointer"
                      >
                        +VLAN 99
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-12 gap-2">
                    <div className="col-span-3">
                      <label className="block text-[10px] text-slate-400 mb-0.5">
                        VLAN ID (1–4094)
                      </label>
                      <input
                        type="number"
                        min={1}
                        max={4094}
                        aria-label="Номер нового VLAN"
                        value={newVlanId}
                        onChange={(e) => setNewVlanId(e.target.value)}
                        className="w-full px-2 py-1 text-xs font-mono bg-slate-950 border border-slate-700 rounded text-indigo-300 focus:outline-none focus:border-indigo-500"
                      />
                    </div>

                    <div className="col-span-4">
                      <label className="block text-[10px] text-slate-400 mb-0.5">
                        Имя VLAN (Name)
                      </label>
                      <input
                        type="text"
                        aria-label="Имя нового VLAN"
                        placeholder="VLAN0030_Accounting"
                        value={newVlanName}
                        onChange={(e) => setNewVlanName(e.target.value)}
                        className="w-full px-2 py-1 text-xs font-mono bg-slate-950 border border-slate-700 rounded text-slate-100 focus:outline-none focus:border-indigo-500"
                      />
                    </div>

                    <div className="col-span-5">
                      <label className="block text-[10px] text-slate-400 mb-0.5">
                        Подсеть / описание сегмента
                      </label>
                      <input
                        type="text"
                        aria-label="Описание или подсеть нового VLAN"
                        placeholder="192.168.30.0/24 · Бухгалтерия"
                        value={newVlanSubnet}
                        onChange={(e) => setNewVlanSubnet(e.target.value)}
                        className="w-full px-2 py-1 text-xs font-mono bg-slate-950 border border-slate-700 rounded text-slate-200 focus:outline-none focus:border-indigo-500"
                      />
                    </div>
                  </div>

                  <div className="flex items-center justify-between pt-1">
                    <label className="inline-flex items-center gap-1.5 text-[11px] text-slate-300 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={autoAllowOnTrunks}
                        onChange={(e) => setAutoAllowOnTrunks(e.target.checked)}
                        className="rounded border-slate-700 bg-slate-950 text-indigo-500"
                      />
                      <span>Автоматически разрешить новый VLAN на всех 802.1Q Trunk-портах</span>
                    </label>

                    <button
                      type="submit"
                      className="flex items-center gap-1 px-3 py-1 rounded bg-indigo-600 hover:bg-indigo-500 text-xs font-medium text-white shadow-xs transition-colors cursor-pointer"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span>Сохранить VLAN</span>
                    </button>
                  </div>
                </form>

                {/* Active VLAN Database Cards with One-Click Port Membership Toggles */}
                <div className="space-y-2">
                  {vlanDb.map((vlan) => {
                    const untaggedPorts = node.interfaces.filter(
                      (i) => i.vlanMode === 'access' && i.accessVlan === vlan.id
                    );
                    const taggedPorts = node.interfaces.filter(
                      (i) =>
                        i.vlanMode === 'trunk' && i.trunkAllowedVlans.includes(vlan.id)
                    );

                    return (
                      <div
                        key={vlan.id}
                        data-testid={`vlan-db-row-${vlan.id}`}
                        className="p-2.5 rounded-md bg-slate-900/70 border border-slate-800 space-y-2"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="px-2 py-0.5 rounded bg-indigo-500/20 border border-indigo-500/40 font-mono text-xs font-bold text-indigo-300 shrink-0">
                              VLAN {vlan.id}
                            </span>
                            <span className="font-mono text-xs font-semibold text-slate-100 truncate">
                              {vlan.name}
                            </span>
                            {vlan.subnetHint && (
                              <span className="text-[11px] font-mono text-slate-400 truncate">
                                · {vlan.subnetHint}
                              </span>
                            )}
                          </div>

                          <div className="flex items-center gap-1.5 shrink-0">
                            {onCreateZoneFromVlan && (
                              <button
                                type="button"
                                onClick={() =>
                                  handleSpawnCanvasZoneForVlan(
                                    vlan.id,
                                    vlan.name,
                                    vlan.subnetHint
                                  )
                                }
                                title="Создать визуальную зону этого VLAN на схеме"
                                className="flex items-center gap-1 px-2 py-0.5 rounded bg-slate-950 hover:bg-slate-800 border border-slate-700 text-[10px] text-sky-300 transition-colors cursor-pointer"
                              >
                                <Layers className="w-3 h-3" />
                                <span>+ Зона на холсте</span>
                              </button>
                            )}

                            {vlan.id !== 1 && (
                              <button
                                type="button"
                                onClick={() => handleDeleteVlan(vlan.id)}
                                title={`Удалить VLAN ${vlan.id}`}
                                className="p-1 rounded bg-slate-950 hover:bg-red-950/70 border border-slate-800 hover:border-red-700/60 text-slate-400 hover:text-red-300 transition-colors cursor-pointer"
                              >
                                <Trash2 className="w-3 h-3" />
                              </button>
                            )}
                          </div>
                        </div>

                        {/* Interactive Port Membership Matrix for this VLAN */}
                        <div className="flex flex-wrap items-center gap-1 pt-1 border-t border-slate-800/70">
                          <span className="text-[10px] text-slate-400 mr-1">
                            Кликните по порту для включения в VLAN {vlan.id}:
                          </span>
                          {node.interfaces.map((iface) => {
                            const isAccessMember =
                              iface.vlanMode === 'access' && iface.accessVlan === vlan.id;
                            const isTrunkMember =
                              iface.vlanMode === 'trunk' &&
                              iface.trunkAllowedVlans.includes(vlan.id);

                            return (
                              <button
                                key={iface.id}
                                type="button"
                                onClick={() => handleTogglePortInVlanCard(iface, vlan.id)}
                                title={
                                  iface.vlanMode === 'trunk'
                                    ? `${iface.shortName} (802.1Q Trunk): кликните для переключения тега VLAN ${vlan.id}`
                                    : isAccessMember
                                    ? `${iface.shortName} уже в Access VLAN ${vlan.id}`
                                    : `Назначить порт ${iface.shortName} в Access VLAN ${vlan.id}`
                                }
                                className={`px-1.5 py-0.5 rounded text-[10px] font-mono border transition-colors cursor-pointer ${
                                  isAccessMember
                                    ? 'bg-sky-600/85 border-sky-300 text-white font-semibold'
                                    : isTrunkMember
                                    ? 'bg-indigo-600/80 border-indigo-300 text-white font-semibold'
                                    : 'bg-slate-950 border-slate-800 text-slate-400 hover:border-slate-600 hover:text-slate-200'
                                }`}
                              >
                                {iface.shortName}
                                {isAccessMember ? ' (U)' : isTrunkMember ? ' (T)' : ''}
                              </button>
                            );
                          })}
                        </div>

                        <div className="flex items-center gap-3 text-[10px] font-mono text-slate-400">
                          <span>
                            Untagged (Access):{' '}
                            <strong className="text-sky-300">
                              {untaggedPorts.length > 0
                                ? untaggedPorts.map((p) => p.shortName).join(', ')
                                : 'нет'}
                            </strong>
                          </span>
                          <span>·</span>
                          <span>
                            Tagged (802.1Q Trunk):{' '}
                            <strong className="text-indigo-300">
                              {taggedPorts.length > 0
                                ? taggedPorts.map((p) => p.shortName).join(', ')
                                : 'нет'}
                            </strong>
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* TAB 3: MULTILAYER SWITCH L3 ROUTING (SVI VlanX) & ETHERCHANNEL LACP (802.3ad) */}
            {activeTab === 'l3_lacp' && (
              <div className="space-y-3.5">
                {/* SECTION A: L3 IP Routing Toggle & SVI Interfaces (interface Vlan10 / Vlan20) */}
                <div className="p-3 rounded-md bg-slate-900/90 border border-emerald-500/35 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="space-y-0.5">
                      <div className="flex items-center gap-2">
                        <Router className="w-4 h-4 text-emerald-400" />
                        <span className="text-xs font-semibold text-slate-100">
                          Маршрутизирующий коммутатор L3 (Switch Virtual Interfaces — SVI)
                        </span>
                      </div>
                      <p className="text-[11px] text-slate-400">
                        Включает аппаратную маршрутизацию между VLAN (<code className="text-emerald-300">ip routing</code>) и виртуальные шлюзы <code className="text-sky-300">interface Vlan10</code>, <code className="text-sky-300">interface Vlan20</code> без внешнего роутера.
                      </p>
                    </div>

                    <button
                      type="button"
                      data-testid="toggle-switch-ip-routing"
                      onClick={handleToggleIpRouting}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md font-mono text-xs font-bold border transition-colors cursor-pointer ${
                        node.ipRoutingEnabled
                          ? 'bg-emerald-600 border-emerald-400 text-white shadow-sm'
                          : 'bg-slate-950 border-slate-700 text-slate-400 hover:text-white'
                      }`}
                    >
                      <Power className="w-3.5 h-3.5" />
                      <span>
                        {node.ipRoutingEnabled
                          ? 'L3 IP Routing: ВКЛ (ip routing)'
                          : 'L3 IP Routing: ВЫКЛ (L2 Switch)'}
                      </span>
                    </button>
                  </div>

                  {/* Quick SVI Presets + Create/Update SVI Form */}
                  <form
                    onSubmit={handleSaveSviForm}
                    className="p-2.5 rounded bg-slate-950/90 border border-slate-800 space-y-2"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-[11px] font-semibold text-emerald-300 font-mono">
                        Создать / изменить SVI шлюз (interface Vlan&lt;ID&gt;)
                      </span>
                      <div className="flex items-center gap-1">
                        <span className="text-[10px] text-slate-400">Быстрые шлюзы SVI:</span>
                        <button
                          type="button"
                          onClick={() =>
                            handleUpsertSvi(10, '192.168.10.1', '255.255.255.0')
                          }
                          className="px-1.5 py-0.5 rounded bg-slate-900 hover:bg-slate-800 border border-slate-700 text-[10px] font-mono text-sky-300 cursor-pointer"
                        >
                          +Vlan10 (192.168.10.1/24)
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            handleUpsertSvi(20, '192.168.20.1', '255.255.255.0')
                          }
                          className="px-1.5 py-0.5 rounded bg-slate-900 hover:bg-slate-800 border border-slate-700 text-[10px] font-mono text-emerald-300 cursor-pointer"
                        >
                          +Vlan20 (192.168.20.1/24)
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            handleUpsertSvi(30, '192.168.30.1', '255.255.255.0')
                          }
                          className="px-1.5 py-0.5 rounded bg-slate-900 hover:bg-slate-800 border border-slate-700 text-[10px] font-mono text-amber-300 cursor-pointer"
                        >
                          +Vlan30 (192.168.30.1/24)
                        </button>
                      </div>
                    </div>

                    <div className="grid grid-cols-12 gap-2 items-end">
                      <div className="col-span-2">
                        <label className="block text-[10px] text-slate-400 mb-0.5">
                          VLAN ID
                        </label>
                        <input
                          type="number"
                          min={1}
                          max={4094}
                          aria-label="Номер VLAN для SVI"
                          value={sviVlanId}
                          onChange={(e) => setSviVlanId(e.target.value)}
                          className="w-full px-2 py-1 text-xs font-mono bg-slate-900 border border-slate-700 rounded text-sky-300"
                        />
                      </div>

                      <div className="col-span-3">
                        <label className="block text-[10px] text-slate-400 mb-0.5">
                          IPv4-шлюз (Gateway)
                        </label>
                        <input
                          type="text"
                          aria-label="IPv4 адрес SVI интерфейса"
                          placeholder="192.168.10.1"
                          value={sviIpAddress}
                          onChange={(e) => setSviIpAddress(e.target.value)}
                          className="w-full px-2 py-1 text-xs font-mono bg-slate-900 border border-slate-700 rounded text-slate-100"
                        />
                      </div>

                      <div className="col-span-3">
                        <label className="block text-[10px] text-slate-400 mb-0.5">
                          Маска подсети
                        </label>
                        <input
                          type="text"
                          aria-label="Маска подсети SVI интерфейса"
                          placeholder="255.255.255.0"
                          value={sviSubnetMask}
                          onChange={(e) => setSviSubnetMask(e.target.value)}
                          className="w-full px-2 py-1 text-xs font-mono bg-slate-900 border border-slate-700 rounded text-slate-200"
                        />
                      </div>

                      <div className="col-span-2">
                        <label className="block text-[10px] text-slate-400 mb-0.5">
                          DHCP Relay (опц.)
                        </label>
                        <input
                          type="text"
                          aria-label="IP helper-address для SVI"
                          placeholder="192.168.20.100"
                          value={sviHelperAddress}
                          onChange={(e) => setSviHelperAddress(e.target.value)}
                          className="w-full px-2 py-1 text-xs font-mono bg-slate-900 border border-slate-700 rounded text-amber-300"
                        />
                      </div>

                      <div className="col-span-2">
                        <button
                          type="submit"
                          data-testid="add-svi-button"
                          className="w-full flex items-center justify-center gap-1 px-2 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-xs font-medium text-white whitespace-nowrap cursor-pointer"
                        >
                          <Plus className="w-3.5 h-3.5 shrink-0" />
                          <span>Сохранить SVI</span>
                        </button>
                      </div>
                    </div>
                  </form>

                  {/* Active SVI Virtual Interfaces Table */}
                  <div className="rounded-md border border-slate-800 overflow-x-auto bg-slate-950">
                    <table className="w-full min-w-[660px] text-left border-collapse text-xs font-mono">
                      <thead>
                        <tr className="bg-slate-900 border-b border-slate-800 text-[10px] uppercase text-slate-400">
                          <th className="py-2 px-3 w-[135px] whitespace-nowrap">Интерфейс SVI</th>
                          <th className="py-2 px-2.5 w-[180px] whitespace-nowrap">IPv4 Шлюз / Маска</th>
                          <th className="py-2 px-2.5 w-[130px] whitespace-nowrap">DHCP Helper</th>
                          <th className="py-2 px-2.5 w-[160px] whitespace-nowrap">Line Protocol (L1/L2)</th>
                          <th className="py-2 px-3 w-[115px] text-right whitespace-nowrap">Действия</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800/70">
                        {sviList.length === 0 ? (
                          <tr>
                            <td colSpan={5} className="py-4 text-center text-slate-500 font-sans">
                              Нет виртуальных интерфейсов SVI. Создайте <code className="text-sky-300">Vlan10</code> и <code className="text-emerald-300">Vlan20</code> выше для маршрутизации между VLAN внутри коммутатора.
                            </td>
                          </tr>
                        ) : (
                          sviList.map((svi) => {
                            const lineUp =
                              svi.adminStatus === 'up' &&
                              isSwitchSviLineProtocolUp(
                                node,
                                svi.vlanId,
                                allNodes,
                                allLinks
                              );
                            return (
                              <tr key={svi.id} className="hover:bg-slate-900/60">
                                <td className="py-2 px-3 align-middle whitespace-nowrap font-bold text-sky-300">
                                  {svi.name}
                                  <span className="block text-[9px] font-normal text-slate-500">
                                    {svi.macAddress}
                                  </span>
                                </td>
                                <td className="py-2 px-2.5 align-middle whitespace-nowrap text-slate-100">
                                  {svi.ipAddress} / {svi.subnetMask}
                                </td>
                                <td className="py-2 px-2.5 align-middle whitespace-nowrap text-amber-300">
                                  {svi.helperAddress || '—'}
                                </td>
                                <td className="py-2 px-2.5 align-middle whitespace-nowrap">
                                  <span
                                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] border ${
                                      lineUp
                                        ? 'bg-emerald-950/80 border-emerald-500/50 text-emerald-300'
                                        : 'bg-amber-950/80 border-amber-500/50 text-amber-300'
                                    }`}
                                  >
                                    {svi.adminStatus === 'down'
                                      ? 'ADMIN DOWN'
                                      : lineUp
                                      ? 'UP / UP (Active)'
                                      : 'UP / DOWN (No Active Port)'}
                                  </span>
                                </td>
                                <td className="py-2 px-3 align-middle text-right whitespace-nowrap space-x-1">
                                  <button
                                    type="button"
                                    onClick={() => handleToggleSviAdminStatus(svi.vlanId)}
                                    className="px-2 py-0.5 rounded bg-slate-900 hover:bg-slate-800 border border-slate-700 text-[10px] text-slate-300 cursor-pointer"
                                  >
                                    {svi.adminStatus === 'up' ? 'Shut' : 'No Shut'}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => handleDeleteSvi(svi.vlanId)}
                                    className="p-1 rounded bg-slate-900 hover:bg-red-950/70 border border-slate-800 text-slate-400 hover:text-red-300 cursor-pointer"
                                  >
                                    <Trash2 className="w-3 h-3 inline" />
                                  </button>
                                </td>
                              </tr>
                            );
                          })
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* SECTION B: EtherChannel / LACP (IEEE 802.3ad) Link Aggregation */}
                <div className="p-3 rounded-md bg-slate-900/90 border border-cyan-500/35 space-y-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="flex items-center gap-2">
                        <GitMerge className="w-4 h-4 text-cyan-400" />
                        <span className="text-xs font-semibold text-slate-100">
                          Агрегация каналов EtherChannel / LACP (IEEE 802.3ad · Port-channel)
                        </span>
                      </div>
                      <p className="text-[11px] text-slate-400">
                        Объединяет 2–4 физических порта между коммутаторами в единый логический канал <code className="text-cyan-300">Po1</code> с суммарной скоростью (200M / 2G) без блокировки второго кабеля в STP BLK.
                      </p>
                    </div>

                    <div className="flex items-center gap-1.5 text-xs font-mono">
                      <select
                        aria-label="Выбрать номер группы Port-channel"
                        value={lacpGroupNumber}
                        onChange={(e) => setLacpGroupNumber(Number(e.target.value) || 1)}
                        className="px-2 py-1 rounded bg-slate-950 border border-cyan-500/50 text-cyan-300 font-bold cursor-pointer"
                      >
                        {[1, 2, 3, 4, 5, 6].map((g) => (
                          <option key={g} value={g}>
                            Port-channel {g} (Po{g})
                          </option>
                        ))}
                      </select>

                      <select
                        aria-label="Выбрать режим согласования LACP"
                        value={lacpMode}
                        onChange={(e) =>
                          setLacpMode(e.target.value as 'active' | 'passive' | 'on')
                        }
                        className="px-2 py-1 rounded bg-slate-950 border border-slate-700 text-slate-200 cursor-pointer"
                      >
                        <option value="active">mode active (LACP)</option>
                        <option value="passive">mode passive (LACP)</option>
                        <option value="on">mode on (Static)</option>
                      </select>
                    </div>
                  </div>

                  {/* Interactive Port Member Selector for Selected Port-channel */}
                  <div className="p-2 rounded bg-slate-950/90 border border-slate-800 space-y-1.5">
                    <div className="text-[10px] text-slate-400">
                      Кликните по портам коммутатора <strong className="text-sky-300">{node.name}</strong> для включения в <strong className="text-cyan-300">Port-channel {lacpGroupNumber} (Po{lacpGroupNumber})</strong>:
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {node.interfaces.map((iface) => {
                        const inSelectedGroup = iface.channelGroup === lacpGroupNumber;
                        const inOtherGroup =
                          iface.channelGroup && iface.channelGroup !== lacpGroupNumber;
                        return (
                          <button
                            key={iface.id}
                            type="button"
                            data-testid={`lacp-toggle-${iface.shortName}`}
                            onClick={() =>
                              handleTogglePortInChannelGroup(iface, lacpGroupNumber)
                            }
                            className={`px-2 py-1 rounded text-[11px] font-mono border transition-colors cursor-pointer ${
                              inSelectedGroup
                                ? 'bg-cyan-600/85 border-cyan-300 text-white font-bold shadow-xs'
                                : inOtherGroup
                                ? 'bg-indigo-950/80 border-indigo-500/50 text-indigo-300'
                                : 'bg-slate-900 border-slate-800 text-slate-300 hover:border-cyan-500/50'
                            }`}
                          >
                            {iface.shortName}
                            {inSelectedGroup
                              ? ` · Po${lacpGroupNumber} (${iface.channelMode || 'active'})`
                              : inOtherGroup
                              ? ` · Po${iface.channelGroup}`
                              : ''}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Active EtherChannel Bundles Summary Table */}
                  <div className="rounded-md border border-slate-800 overflow-x-auto bg-slate-950">
                    <table className="w-full min-w-[650px] text-left border-collapse text-xs font-mono">
                      <thead>
                        <tr className="bg-slate-900 border-b border-slate-800 text-[10px] uppercase text-slate-400">
                          <th className="py-2 px-3 w-[115px] whitespace-nowrap">Группа (Bundle)</th>
                          <th className="py-2 px-2.5 w-[130px] whitespace-nowrap">Протокол</th>
                          <th className="py-2 px-2.5 w-[160px] whitespace-nowrap">Агрегированная скорость</th>
                          <th className="py-2 px-2.5 w-[150px] whitespace-nowrap">STP Cost / Статус</th>
                          <th className="py-2 px-3 min-w-[130px] whitespace-nowrap">Активные порты связки</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800/70">
                        {allBundles.length === 0 ? (
                          <tr>
                            <td colSpan={5} className="py-3.5 text-center text-slate-500 font-sans">
                              Нет активных связок EtherChannel. Объедините 2 параллельных линка между коммутаторами в группу <code className="text-cyan-300">Po1</code>.
                            </td>
                          </tr>
                        ) : (
                          allBundles.map((bundle) => {
                            const localPortIds =
                              bundle.nodeAId === node.id
                                ? bundle.nodeAPortIds
                                : bundle.nodeBPortIds;
                            const localNames = localPortIds
                              .map(
                                (pid) =>
                                  node.interfaces.find((i) => i.id === pid)?.shortName || pid
                              )
                              .join(', ');
                            const firstStp =
                              stpState?.ports[localPortIds[0]];

                            return (
                              <tr key={bundle.bundleKey} className="hover:bg-slate-900/60">
                                <td className="py-2 px-3 align-middle whitespace-nowrap font-bold text-cyan-300">
                                  {bundle.portChannelName} (SU)
                                </td>
                                <td className="py-2 px-2.5 align-middle whitespace-nowrap text-slate-200">
                                  {bundle.protocol} (802.3ad)
                                </td>
                                <td className="py-2 px-2.5 align-middle whitespace-nowrap text-emerald-300 font-semibold">
                                  {bundle.aggregatedBandwidthMbps} Mbps ({bundle.memberLinkIds.length} лин.)
                                </td>
                                <td className="py-2 px-2.5 align-middle whitespace-nowrap text-sky-300">
                                  Cost {bundle.stpCost} ·{' '}
                                  {firstStp
                                    ? `${firstStp.role.toUpperCase()} (${firstStp.state.toUpperCase()})`
                                    : 'FWD'}
                                </td>
                                <td className="py-2 px-3 align-middle whitespace-nowrap text-cyan-200">
                                  {localNames}
                                </td>
                              </tr>
                            );
                          })
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}

            {/* TAB 3.5: SWITCH STACKING (Cisco StackWise-480 / VSS) */}
            {activeTab === 'stack' && (() => {
              const stackCfg: StackConfig = node.stackConfig || {
                enabled: false,
                stackId: 'STACK-CORE-1',
                domainId: 1,
                protocol: 'StackWise-480',
                memberNumber: 1,
                priority: 15,
                role: 'master',
                virtualMac: getDefaultStackVirtualMac(1),
                backplaneBandwidthGbps: 480,
                preempt: true,
              };

              const updateStackCfg = (patch: Partial<StackConfig>) => {
                const nextCfg: StackConfig = {
                  ...stackCfg,
                  ...patch,
                };
                onUpdateNode({
                  ...node,
                  stackConfig: nextCfg,
                });
              };

              const candidateSwitches = allNodes.filter(
                (n) =>
                  n.type === 'switch' &&
                  n.id !== node.id &&
                  n.deviceModel !== 'wifi_ap' &&
                  n.deviceModel !== 'wlc'
              );

              return (
                <div className="space-y-3" data-testid="switch-stack-config-panel">
                  <div className="p-3 rounded-lg bg-slate-900/95 border border-amber-500/45 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <div className="text-xs font-bold text-amber-200 flex items-center gap-2">
                          <Layers className="w-4 h-4 text-amber-400" />
                          <span>
                            Стекирование коммутаторов (Cisco StackWise-480 / VSS) — {node.name}
                          </span>
                          {nodeStackStatus && (
                            <span className="px-2 py-0.5 rounded bg-amber-500/20 border border-amber-400/60 text-[10px] font-mono font-bold text-amber-200">
                              #{nodeStackStatus.memberNumber}{' '}
                              {nodeStackStatus.role.toUpperCase()} · {stackCfg.stackId}
                            </span>
                          )}
                        </div>
                        <p className="text-[11px] text-slate-400 mt-0.5">
                          Объединяет несколько коммутаторов по шине StackWise-480 (480 Гбит/с) в единый логический коммутатор с общей плоскостью управления (Master / Standby) без блокировки STP на стековых линках.
                        </p>
                      </div>

                      <button
                        type="button"
                        data-testid="switch-stack-toggle-btn"
                        onClick={() => {
                          const nextEnabled = !stackCfg.enabled;
                          updateStackCfg({ enabled: nextEnabled });
                          setStatusToast(
                            nextEnabled
                              ? `Стекирование StackWise-480 включено на ${node.name} (${stackCfg.stackId})`
                              : `Коммутатор ${node.name} выведен из стека`
                          );
                        }}
                        className={`px-3 py-1 rounded text-xs font-mono font-bold border cursor-pointer ${
                          stackCfg.enabled
                            ? 'bg-amber-500/25 border-amber-400 text-amber-200'
                            : 'bg-slate-800 border-slate-700 text-slate-400'
                        }`}
                      >
                        {stackCfg.enabled ? 'STACKWISE ON (В СТЕКЕ)' : 'STACKWISE OFF'}
                      </button>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-4 gap-2.5 items-end text-xs font-mono">
                      <div>
                        <label className="block text-[10px] text-slate-400 mb-1 whitespace-nowrap">
                          ID стека (Stack Group)
                        </label>
                        <input
                          type="text"
                          data-testid="switch-stack-id-input"
                          value={stackCfg.stackId}
                          onChange={(e) =>
                            updateStackCfg({
                              enabled: true,
                              stackId: e.target.value.toUpperCase(),
                            })
                          }
                          className="w-full px-2.5 py-1.5 rounded bg-slate-950 border border-slate-700 text-amber-300 focus:outline-none focus:border-amber-500"
                        />
                      </div>

                      <div>
                        <label className="block text-[10px] text-slate-400 mb-1 whitespace-nowrap">
                          Протокол стека
                        </label>
                        <select
                          value={stackCfg.protocol}
                          onChange={(e) =>
                            updateStackCfg({
                              enabled: true,
                              protocol: e.target.value as 'StackWise-480' | 'VSS',
                              backplaneBandwidthGbps:
                                e.target.value === 'StackWise-480' ? 480 : 160,
                            })
                          }
                          className="w-full px-2 py-1.5 rounded bg-slate-950 border border-slate-700 text-slate-100"
                        >
                          <option value="StackWise-480">StackWise-480 (480G)</option>
                          <option value="VSS">Cisco VSS (160G)</option>
                        </select>
                      </div>

                      <div>
                        <label className="block text-[10px] text-slate-400 mb-1 whitespace-nowrap">
                          Номер юнита (Switch #1..8)
                        </label>
                        <select
                          data-testid="switch-stack-member-select"
                          value={stackCfg.memberNumber}
                          onChange={(e) =>
                            updateStackCfg({
                              enabled: true,
                              memberNumber: Number(e.target.value) || 1,
                            })
                          }
                          className="w-full px-2 py-1.5 rounded bg-slate-950 border border-slate-700 text-sky-300"
                        >
                          {[1, 2, 3, 4, 5, 6, 7, 8].map((num) => (
                            <option key={num} value={num}>
                              Switch #{num} (Юнит {num})
                            </option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label className="block text-[10px] text-slate-400 mb-1 whitespace-nowrap">
                          Приоритет (1..15, Master)
                        </label>
                        <select
                          data-testid="switch-stack-priority-select"
                          value={stackCfg.priority}
                          onChange={(e) => {
                            const prio = Number(e.target.value) || 1;
                            updateStackCfg({
                              enabled: true,
                              priority: prio,
                            });
                            setStatusToast(
                              `Приоритет StackWise для ${node.name} установлен в ${prio} (перевыбор Master)`
                            );
                          }}
                          className="w-full px-2 py-1.5 rounded bg-slate-950 border border-slate-700 text-emerald-300 font-bold"
                        >
                          {[15, 14, 12, 10, 8, 5, 1].map((p) => (
                            <option key={p} value={p}>
                              Priority {p} {p === 15 ? '(Master)' : p === 1 ? '(Default)' : ''}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>

                    {/* 1-Click Connect & Join Another Switch to Stack */}
                    {candidateSwitches.length > 0 && onCreateLink && (
                      <div className="p-2.5 rounded bg-slate-950/90 border border-slate-800 space-y-2">
                        <div className="text-[11px] text-slate-300 font-medium">
                          Быстрое объединение коммутаторов в стек (прокладывает стек-кабель StackWise 480G и синхронизирует <code className="text-amber-300">{stackCfg.stackId}</code>):
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5">
                          {candidateSwitches.map((peerSw) => {
                            const alreadyLinked = allLinks.some(
                              (l) =>
                                l.cableType === 'stack' &&
                                ((l.sourceNodeId === node.id && l.targetNodeId === peerSw.id) ||
                                  (l.sourceNodeId === peerSw.id && l.targetNodeId === node.id))
                            );
                            return (
                              <button
                                key={peerSw.id}
                                type="button"
                                data-testid={`join-switch-stack-${peerSw.id}`}
                                onClick={() => {
                                  const usedA = new Set(
                                    allLinks.flatMap((l) =>
                                      l.sourceNodeId === node.id
                                        ? [l.sourceInterfaceId]
                                        : l.targetNodeId === node.id
                                        ? [l.targetInterfaceId]
                                        : []
                                    )
                                  );
                                  const usedB = new Set(
                                    allLinks.flatMap((l) =>
                                      l.sourceNodeId === peerSw.id
                                        ? [l.sourceInterfaceId]
                                        : l.targetNodeId === peerSw.id
                                        ? [l.targetInterfaceId]
                                        : []
                                    )
                                  );
                                  const portA =
                                    [...node.interfaces]
                                      .reverse()
                                      .find((i) => !usedA.has(i.id)) ||
                                    node.interfaces[node.interfaces.length - 1];
                                  const portB =
                                    [...peerSw.interfaces]
                                      .reverse()
                                      .find((i) => !usedB.has(i.id)) ||
                                    peerSw.interfaces[peerSw.interfaces.length - 1];
                                  if (portA && portB) {
                                    onCreateLink(
                                      node.id,
                                      portA.id,
                                      peerSw.id,
                                      portB.id,
                                      'stack'
                                    );
                                    setStatusToast(
                                      `Коммутаторы ${node.name} и ${peerSw.name} объединены в стек StackWise-480 (${portA.shortName} ⇄ ${portB.shortName})`
                                    );
                                  }
                                }}
                                className={`px-2.5 py-1 rounded text-xs font-mono border transition-colors cursor-pointer ${
                                  alreadyLinked
                                    ? 'bg-amber-950/70 border-amber-500/60 text-amber-200'
                                    : 'bg-slate-900 hover:bg-amber-950/60 border-slate-700 hover:border-amber-400 text-slate-200'
                                }`}
                              >
                                {alreadyLinked ? '⇄ В стеке с ' : '+ Объединить в стек с '}
                                <strong>{peerSw.name}</strong>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {/* Live StackWise Member Table (`show switch`) */}
                    <div className="rounded-md border border-slate-800 overflow-x-auto bg-slate-950">
                      <div className="px-3 py-1.5 bg-slate-900 border-b border-slate-800 flex items-center justify-between gap-2 text-[11px] font-mono">
                        <span className="text-amber-300 font-semibold whitespace-nowrap">
                          Таблица участников стека (show switch) — Stack MAC: {nodeStackStatus?.stackGroup.virtualMac || stackCfg.virtualMac}
                        </span>
                        <span className="text-slate-400 whitespace-nowrap">
                          Шина: {stackCfg.backplaneBandwidthGbps || 480} Гбит/с Full-Ring
                        </span>
                      </div>
                      <table className="w-full min-w-[600px] text-left border-collapse text-xs font-mono">
                        <thead>
                          <tr className="bg-slate-900/60 border-b border-slate-800 text-[10px] uppercase text-slate-400">
                            <th className="py-2 px-3 w-[95px] whitespace-nowrap">Switch #</th>
                            <th className="py-2 px-3 w-[170px] whitespace-nowrap">Устройство</th>
                            <th className="py-2 px-3 w-[135px] whitespace-nowrap">Роль в стеке</th>
                            <th className="py-2 px-3 w-[95px] text-center whitespace-nowrap">Priority</th>
                            <th className="py-2 px-3 min-w-[140px] whitespace-nowrap">Состояние</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-800/70">
                          {!nodeStackStatus ? (
                            <tr>
                              <td colSpan={5} className="py-4 text-center text-slate-500 font-sans">
                                Коммутатор работает автономно (Standalone). Включите StackWise выше или соедините два коммутатора «Стек-кабелем».
                              </td>
                            </tr>
                          ) : (
                            nodeStackStatus.stackGroup.members.map((m) => (
                              <tr key={m.node.id} className="hover:bg-slate-900/60">
                                <td className="py-2 px-3 align-middle whitespace-nowrap font-bold text-amber-300">
                                  {m.role === 'master' ? `*${m.memberNumber}` : ` ${m.memberNumber}`}
                                </td>
                                <td className="py-2 px-3 align-middle whitespace-nowrap text-slate-100 font-semibold">
                                  {m.node.name}
                                </td>
                                <td className="py-2 px-3 align-middle whitespace-nowrap">
                                  <span
                                    className={`inline-block px-2 py-0.5 rounded text-[10px] font-bold border ${
                                      m.role === 'master'
                                        ? 'bg-amber-500/25 border-amber-400 text-amber-200'
                                        : m.role === 'standby'
                                        ? 'bg-sky-500/20 border-sky-400/60 text-sky-200'
                                        : 'bg-slate-800 border-slate-700 text-slate-300'
                                    }`}
                                  >
                                    {m.role.toUpperCase()}
                                  </span>
                                </td>
                                <td className="py-2 px-3 align-middle text-center whitespace-nowrap text-emerald-300 font-semibold">
                                  {m.priority}
                                </td>
                                <td className="py-2 px-3 align-middle whitespace-nowrap text-slate-300">
                                  {m.isOperational ? 'Ready (Ring Active)' : 'Down'}
                                </td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              );
            })()}

            {/* TAB 4: SWITCH MAC ADDRESS TABLE (CAM) */}
            {activeTab === 'mac' && (
              <div className="space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-slate-300">
                    Динамическая таблица коммутации L2 (CAM Table) для{' '}
                    <strong className="font-mono text-sky-300">{node.name}</strong>
                  </span>
                  {node.macTable.length > 0 && (
                    <button
                      type="button"
                      onClick={() => {
                        onUpdateNode({ ...node, macTable: [] });
                        setStatusToast('Таблица MAC-адресов коммутатора очищена');
                      }}
                      className="px-2 py-1 rounded bg-slate-900 hover:bg-red-950/60 border border-slate-700 text-[11px] text-slate-300 hover:text-red-200 transition-colors cursor-pointer"
                    >
                      Очистить MAC-таблицу
                    </button>
                  )}
                </div>

                <div className="rounded-md border border-slate-800 overflow-x-auto bg-slate-950">
                  <table className="w-full min-w-[580px] text-left border-collapse text-xs font-mono">
                    <thead>
                      <tr className="bg-slate-900 border-b border-slate-800 text-[10px] uppercase text-slate-400">
                        <th className="py-2 px-3 w-[110px] whitespace-nowrap">VLAN</th>
                        <th className="py-2 px-3 w-[190px] whitespace-nowrap">MAC-адрес</th>
                        <th className="py-2 px-3 w-[140px] whitespace-nowrap">Тип записи</th>
                        <th className="py-2 px-3 min-w-[140px] whitespace-nowrap">Интерфейс</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/70">
                      {node.macTable.length === 0 ? (
                        <tr>
                          <td colSpan={4} className="py-6 text-center text-slate-500 font-sans">
                            Таблица MAC-адресов пуста. Запустите Ping между узлами для изучения MAC.
                          </td>
                        </tr>
                      ) : (
                        node.macTable.map((entry, idx) => (
                          <tr key={`${entry.macAddress}-${idx}`} className="hover:bg-slate-900/50">
                            <td className="py-2 px-3 align-middle whitespace-nowrap text-indigo-300 font-semibold">
                              VLAN {entry.vlan}
                            </td>
                            <td className="py-2 px-3 align-middle whitespace-nowrap text-slate-200">
                              {entry.macAddress}
                            </td>
                            <td className="py-2 px-3 align-middle whitespace-nowrap text-emerald-400">
                              {entry.type}
                            </td>
                            <td className="py-2 px-3 align-middle whitespace-nowrap text-sky-300">
                              {entry.portName}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* TAB 5: WI-FI 802.11 ACCESS POINT RADIO & COVERAGE CONFIGURATION */}
            {activeTab === 'wifi' && (() => {
              const wifiCfg = node.wifiConfig || {
                enabled: true,
                ssid: 'Corp-WiFi',
                security: 'wpa2' as const,
                password: 'cisco123',
                channel: 6,
                band: '2.4GHz' as const,
                coverageRadius: 250,
                apMode: 'autonomous' as const,
                capwapStatus: 'standalone' as const,
              };

              const availableWlcs = allNodes.filter((n) => isWlcControllerNode(n));

              const updateWifiCfg = (patch: Partial<typeof wifiCfg>) => {
                onUpdateNode({
                  ...node,
                  wifiConfig: {
                    ...wifiCfg,
                    ...patch,
                  },
                });
              };

              const wirelessLinks = allLinks.filter(
                (l) =>
                  l.cableType === 'wireless' &&
                  (l.sourceNodeId === node.id || l.targetNodeId === node.id)
              );

              const isLap = wifiCfg.apMode === 'lightweight';

              return (
                <div className="space-y-3" data-testid="ap-wifi-config-panel">
                  <div className="p-3 rounded-lg bg-slate-900/95 border border-cyan-500/40 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <div className="text-xs font-bold text-cyan-200 flex items-center gap-2">
                          <Wifi className="w-4 h-4 text-cyan-400" />
                          <span>Радиомодуль IEEE 802.11ac/ax — {node.name}</span>
                          {isLap && (
                            <span className="px-1.5 py-0.5 rounded bg-cyan-500/20 border border-cyan-400/50 text-[10px] font-mono text-cyan-200">
                              CAPWAP LIGHTWEIGHT AP
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] text-slate-400">
                          Настройте режим точки доступа (Autonomous AP или Lightweight AP под управлением контроллера WLC через CAPWAP UDP 5246/5247).
                        </div>
                      </div>

                      <button
                        type="button"
                        data-testid="ap-wifi-toggle-btn"
                        onClick={() => {
                          updateWifiCfg({ enabled: !wifiCfg.enabled });
                          setStatusToast(
                            !wifiCfg.enabled
                              ? `Радиомодуль Wi-Fi на ${node.name} включён`
                              : `Радиомодуль Wi-Fi на ${node.name} выключен`
                          );
                        }}
                        className={`px-3 py-1 rounded text-xs font-mono font-bold border cursor-pointer ${
                          wifiCfg.enabled
                            ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-300'
                            : 'bg-red-500/20 border-red-500/50 text-red-300'
                        }`}
                      >
                        {wifiCfg.enabled ? 'RADIO ON (В ЭФИРЕ)' : 'RADIO OFF'}
                      </button>
                    </div>

                    {/* AP Mode Switcher: Autonomous AP vs Lightweight AP (CAPWAP -> WLC) */}
                    <div className="p-2 rounded bg-slate-950/90 border border-slate-800 flex flex-wrap items-center justify-between gap-2 text-xs">
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] font-mono text-slate-400">
                          Архитектура точки доступа:
                        </span>
                        <select
                          aria-label="Режим работы точки доступа (Autonomous / Lightweight CAPWAP)"
                          data-testid="ap-mode-select"
                          value={wifiCfg.apMode || 'autonomous'}
                          onChange={(e) => {
                            const nextMode = e.target.value as 'autonomous' | 'lightweight';
                            const targetWlc = availableWlcs[0];
                            updateWifiCfg({
                              apMode: nextMode,
                              wlcNodeId:
                                nextMode === 'lightweight'
                                  ? wifiCfg.wlcNodeId || targetWlc?.id
                                  : undefined,
                            });
                            setStatusToast(
                              nextMode === 'lightweight'
                                ? `${node.name} переведена в режим Lightweight AP (CAPWAP → ${targetWlc?.name || 'WLC'})`
                                : `${node.name} переведена в автономный режим (Autonomous AP)`
                            );
                          }}
                          className="px-2.5 py-1 rounded bg-slate-900 border border-cyan-500/50 font-mono text-cyan-200 font-semibold cursor-pointer"
                        >
                          <option value="autonomous">Autonomous AP (Автономная)</option>
                          <option value="lightweight">
                            Lightweight AP (CAPWAP → Контроллер WLC)
                          </option>
                        </select>
                      </div>

                      {isLap && (
                        <div className="flex items-center gap-2 font-mono text-[11px]">
                          <span className="text-slate-400">Контроллер WLC:</span>
                          <select
                            aria-label="Целевой контроллер WLC для CAPWAP"
                            value={wifiCfg.wlcNodeId || availableWlcs[0]?.id || ''}
                            onChange={(e) => updateWifiCfg({ wlcNodeId: e.target.value })}
                            className="px-2 py-1 rounded bg-slate-900 border border-slate-700 text-sky-300"
                          >
                            {availableWlcs.length === 0 ? (
                              <option value="">Нет контроллера WLC на схеме</option>
                            ) : (
                              availableWlcs.map((w) => (
                                <option key={w.id} value={w.id}>
                                  {w.name} ({w.wlcConfig?.managementIp || '192.168.10.5'})
                                </option>
                              ))
                            )}
                          </select>
                          <span
                            className={`px-2 py-0.5 rounded border text-[10px] font-bold ${
                              wifiCfg.capwapStatus === 'joined'
                                ? 'bg-emerald-950/80 border-emerald-500/50 text-emerald-300'
                                : 'bg-amber-950/80 border-amber-500/50 text-amber-300'
                            }`}
                          >
                            {wifiCfg.capwapStatus === 'joined'
                              ? `CAPWAP JOINED (${wifiCfg.wlcControllerName || 'WLC'} · VLAN ${wifiCfg.bridgeVlan || 10})`
                              : 'CAPWAP DISCOVERY'}
                          </span>
                        </div>
                      )}
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 text-xs">
                      <div>
                        <label className="block text-[10px] font-mono text-slate-400 mb-1">
                          Имя сети (SSID) {isLap ? '(из профиля WLC)' : ''}
                        </label>
                        <input
                          type="text"
                          data-testid="ap-wifi-ssid-input"
                          value={wifiCfg.ssid}
                          onChange={(e) => updateWifiCfg({ ssid: e.target.value })}
                          className="w-full px-2.5 py-1.5 rounded bg-slate-950 border border-slate-700 font-mono text-slate-100 focus:outline-none focus:border-cyan-500"
                        />
                      </div>

                      <div>
                        <label className="block text-[10px] font-mono text-slate-400 mb-1">
                          Диапазон / Канал {isLap ? '(RRM)' : ''}
                        </label>
                        <div className="flex items-center gap-1.5">
                          <select
                            value={wifiCfg.band}
                            onChange={(e) =>
                              updateWifiCfg({
                                band: e.target.value as '2.4GHz' | '5GHz',
                                channel: e.target.value === '2.4GHz' ? 6 : 36,
                              })
                            }
                            className="flex-1 px-2 py-1.5 rounded bg-slate-950 border border-slate-700 font-mono text-slate-100"
                          >
                            <option value="2.4GHz">2.4 GHz</option>
                            <option value="5GHz">5 GHz</option>
                          </select>
                          <select
                            value={wifiCfg.channel}
                            onChange={(e) =>
                              updateWifiCfg({
                                channel: Number(e.target.value) as 1 | 6 | 11 | 36 | 44 | 149,
                              })
                            }
                            className="w-24 px-2 py-1.5 rounded bg-slate-950 border border-slate-700 font-mono text-cyan-300"
                          >
                            <option value={1}>Ch 1</option>
                            <option value={6}>Ch 6</option>
                            <option value={11}>Ch 11</option>
                            <option value={36}>Ch 36</option>
                            <option value={44}>Ch 44</option>
                            <option value={149}>Ch 149</option>
                          </select>
                        </div>
                      </div>

                      <div>
                        <label className="block text-[10px] font-mono text-slate-400 mb-1">
                          Безопасность (WPA2 / Open)
                        </label>
                        <div className="flex items-center gap-1.5">
                          <select
                            data-testid="ap-wifi-security-select"
                            value={wifiCfg.security}
                            onChange={(e) =>
                              updateWifiCfg({ security: e.target.value as 'open' | 'wpa2' })
                            }
                            className="w-28 px-2 py-1.5 rounded bg-slate-950 border border-slate-700 font-mono text-slate-100"
                          >
                            <option value="wpa2">WPA2-PSK</option>
                            <option value="open">Open</option>
                          </select>
                          {wifiCfg.security === 'wpa2' && (
                            <input
                              type="text"
                              data-testid="ap-wifi-password-input"
                              value={wifiCfg.password}
                              onChange={(e) => updateWifiCfg({ password: e.target.value })}
                              placeholder="Пароль WPA2..."
                              className="flex-1 px-2 py-1.5 rounded bg-slate-950 border border-slate-700 font-mono text-amber-300 focus:outline-none focus:border-cyan-500"
                            />
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Coverage Radius Slider */}
                    <div className="pt-1 border-t border-slate-800 flex flex-wrap items-center justify-between gap-3">
                      <div className="text-xs font-mono text-slate-300">
                        Радиус зоны покрытия на холсте:{' '}
                        <strong className="text-cyan-300">{wifiCfg.coverageRadius} px</strong>
                      </div>
                      <input
                        type="range"
                        data-testid="ap-wifi-radius-slider"
                        min={120}
                        max={420}
                        step={10}
                        value={wifiCfg.coverageRadius}
                        onChange={(e) =>
                          updateWifiCfg({ coverageRadius: Number(e.target.value) })
                        }
                        className="w-60 accent-cyan-400 cursor-pointer"
                      />
                    </div>
                  </div>

                  {/* Associated Wireless Clients Table */}
                  <div className="rounded-md border border-slate-800 overflow-hidden bg-slate-950">
                    <div className="px-3 py-2 bg-slate-900 border-b border-slate-800 text-xs font-mono font-semibold text-slate-200">
                      Ассоциированные беспроводные клиенты ({wirelessLinks.length})
                    </div>
                    <table className="w-full text-left border-collapse text-xs font-mono">
                      <thead>
                        <tr className="bg-slate-900/60 border-b border-slate-800 text-[10px] uppercase text-slate-400">
                          <th className="py-1.5 px-3">Клиент</th>
                          <th className="py-1.5 px-3">IPv4 / MAC</th>
                          <th className="py-1.5 px-3">Дистанция</th>
                          <th className="py-1.5 px-3">Уровень сигнала (RSSI)</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800/70">
                        {wirelessLinks.length === 0 ? (
                          <tr>
                            <td colSpan={4} className="py-5 text-center text-slate-500 font-sans">
                              Нет подключённых Wi-Fi клиентов. Откройте монитор ноутбука или смартфона и подключитесь к SSID <code className="text-cyan-300">{wifiCfg.ssid}</code>.
                            </td>
                          </tr>
                        ) : (
                          wirelessLinks.map((link) => {
                            const peerId =
                              link.sourceNodeId === node.id
                                ? link.targetNodeId
                                : link.sourceNodeId;
                            const peer = allNodes.find((n) => n.id === peerId);
                            if (!peer) return null;
                            const metrics = computeWifiSignalMetrics(peer, node);
                            const peerIface = peer.interfaces[0];
                            return (
                              <tr key={link.id}>
                                <td className="py-1.5 px-3 font-bold text-cyan-300">
                                  {peer.name}
                                </td>
                                <td className="py-1.5 px-3 text-slate-200">
                                  {peerIface?.ipAddress || '0.0.0.0'} · {peerIface?.macAddress}
                                </td>
                                <td className="py-1.5 px-3 text-slate-300">
                                  {metrics.distancePx} / {wifiCfg.coverageRadius} px
                                </td>
                                <td className="py-1.5 px-3 text-emerald-300 font-semibold">
                                  {metrics.rssiDbm} dBm ({metrics.signalQualityPercent}%)
                                </td>
                              </tr>
                            );
                          })
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            })()}

            {/* TAB 6: CISCO WLC 5520 WIRELESS LAN CONTROLLER & CAPWAP CENTRALIZED MANAGEMENT */}
            {activeTab === 'wlc' && (() => {
              const wlcCfg = node.wlcConfig || {
                enabled: true,
                controllerName: node.name,
                managementIp: '192.168.10.5',
                managementVlan: 10,
                capwapUdpControlPort: 5246,
                capwapUdpDataPort: 5247,
                rfAutoChannel: true,
                defaultCoverageRadius: 245,
                wlanProfiles: [
                  {
                    id: `${node.id}-wlan-1`,
                    wlanId: 1,
                    profileName: 'Corp_Enterprise_WLAN',
                    ssid: 'Corp-Enterprise',
                    vlanId: 10,
                    security: 'wpa2' as const,
                    password: 'cisco123',
                    band: '2.4GHz' as const,
                    enabled: true,
                  },
                ],
              };

              const updateWlcCfg = (patch: Partial<typeof wlcCfg>) => {
                onUpdateNode({
                  ...node,
                  wlcConfig: {
                    ...wlcCfg,
                    ...patch,
                  },
                });
              };

              const primaryProfile = wlcCfg.wlanProfiles[0] || {
                id: `${node.id}-wlan-1`,
                wlanId: 1,
                profileName: 'Corp_Enterprise_WLAN',
                ssid: 'Corp-Enterprise',
                vlanId: 10,
                security: 'wpa2' as const,
                password: 'cisco123',
                band: '2.4GHz' as const,
                enabled: true,
              };

              const updatePrimaryProfile = (patch: Partial<typeof primaryProfile>) => {
                const nextProfiles =
                  wlcCfg.wlanProfiles.length > 0
                    ? wlcCfg.wlanProfiles.map((p, idx) =>
                        idx === 0 ? { ...p, ...patch } : p
                      )
                    : [{ ...primaryProfile, ...patch }];
                updateWlcCfg({ wlanProfiles: nextProfiles });
              };

              const allApNodes = allNodes.filter(
                (n) => n.deviceModel === 'wifi_ap' || Boolean(n.wifiConfig)
              );
              const joinedLapNodes = allApNodes.filter(
                (n) =>
                  n.wifiConfig?.apMode === 'lightweight' &&
                  (n.wifiConfig?.wlcNodeId === node.id || !n.wifiConfig?.wlcNodeId)
              );

              const handleTriggerCapwapPushAndPackets = () => {
                // Convert any standalone wifi_ap nodes to lightweight APs managed by this WLC and push config
                const nextNodes = allNodes.map((n) => {
                  if (n.id === node.id) {
                    return { ...n, wlcConfig: wlcCfg };
                  }
                  if (n.deviceModel === 'wifi_ap' && n.wifiConfig) {
                    return {
                      ...n,
                      wifiConfig: {
                        ...n.wifiConfig,
                        apMode: 'lightweight' as const,
                        wlcNodeId: node.id,
                      },
                    };
                  }
                  return n;
                });
                const synced = syncWirelessAssociations(nextNodes, allLinks);
                if (onUpdateAllNodes) {
                  onUpdateAllNodes(synced.nodes);
                } else {
                  onUpdateNode({ ...node, wlcConfig: wlcCfg });
                }
                const capwapSteps = synthesizeCapwapTunnelSteps(synced.nodes, allLinks, 1, 0);
                if (onLoadSimulationSteps && capwapSteps.length > 0) {
                  onLoadSimulationSteps(
                    capwapSteps,
                    `WLC ${node.name}: централизованный профиль SSID «${primaryProfile.ssid}» (VLAN ${primaryProfile.vlanId}) разослан по CAPWAP (UDP 5246/5247) на все легкие точки доступа.`
                  );
                }
                setStatusToast(
                  `Профиль «${primaryProfile.ssid}» (VLAN ${primaryProfile.vlanId}) применён по CAPWAP на ${allApNodes.filter((a) => a.deviceModel === 'wifi_ap').length} легких точек (LAP)`
                );
              };

              return (
                <div className="space-y-3" data-testid="wlc-controller-panel">
                  {/* Top WLC Controller Status & 1-Click CAPWAP Provisioning Banner */}
                  <div className="p-3 rounded-lg bg-slate-900/95 border border-cyan-500/45 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <div className="text-xs font-bold text-cyan-200 flex items-center gap-2">
                          <Server className="w-4 h-4 text-cyan-400" />
                          <span>
                            Cisco Wireless LAN Controller (WLC 5520) — {node.name}
                          </span>
                          <span className="px-2 py-0.5 rounded bg-cyan-950 border border-cyan-500/50 text-[10px] font-mono text-cyan-300">
                            UDP {wlcCfg.capwapUdpControlPort}/{wlcCfg.capwapUdpDataPort}
                          </span>
                        </div>
                        <div className="text-[11px] text-slate-400">
                          Централизованное управление легкими точками доступа (Lightweight AP) по туннелям CAPWAP, привязка SSID ↔ VLAN и авто-распределение радиоканалов RRM (Ch 1, 6, 11).
                        </div>
                      </div>

                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          data-testid="wlc-capwap-push-btn"
                          onClick={handleTriggerCapwapPushAndPackets}
                          className="px-3 py-1.5 rounded bg-cyan-600 hover:bg-cyan-500 text-xs font-mono font-bold text-white shadow-xs transition-colors cursor-pointer"
                        >
                          Push CAPWAP на все LAP ({joinedLapNodes.length})
                        </button>
                      </div>
                    </div>

                    {/* WLC Management IP, RRM Auto-Channel DCA & Default Coverage Radius */}
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 text-xs pt-1 border-t border-slate-800">
                      <div>
                        <label className="block text-[10px] font-mono text-slate-400 mb-1">
                          Management IPv4 (CAPWAP Endpoint)
                        </label>
                        <input
                          type="text"
                          data-testid="wlc-mgmt-ip-input"
                          value={wlcCfg.managementIp}
                          onChange={(e) => updateWlcCfg({ managementIp: e.target.value })}
                          className="w-full px-2.5 py-1.5 rounded bg-slate-950 border border-slate-700 font-mono text-sky-300 focus:outline-none focus:border-cyan-500"
                        />
                      </div>

                      <div>
                        <label className="block text-[10px] font-mono text-slate-400 mb-1">
                          RRM Dynamic Channel Assignment (DCA)
                        </label>
                        <button
                          type="button"
                          data-testid="wlc-rrm-toggle-btn"
                          onClick={() => {
                            updateWlcCfg({ rfAutoChannel: !wlcCfg.rfAutoChannel });
                            setStatusToast(
                              !wlcCfg.rfAutoChannel
                                ? 'RRM DCA включён: легкие точки доступа разведены по непересекающимся каналам 1, 6, 11'
                                : 'RRM DCA выключен: ручной выбор радиоканалов на точках доступа'
                            );
                          }}
                          className={`w-full px-2.5 py-1.5 rounded font-mono text-xs font-bold border transition-colors cursor-pointer ${
                            wlcCfg.rfAutoChannel
                              ? 'bg-emerald-950/80 border-emerald-500/50 text-emerald-300'
                              : 'bg-slate-950 border-slate-700 text-slate-400'
                          }`}
                        >
                          {wlcCfg.rfAutoChannel
                            ? 'RRM AUTO-CHANNEL: ON (Ch 1 / 6 / 11)'
                            : 'RRM AUTO-CHANNEL: OFF'}
                        </button>
                      </div>

                      <div>
                        <label className="block text-[10px] font-mono text-slate-400 mb-1">
                          Радиус покрытия всех LAP:{' '}
                          <strong className="text-cyan-300">
                            {wlcCfg.defaultCoverageRadius} px
                          </strong>
                        </label>
                        <input
                          type="range"
                          data-testid="wlc-radius-slider"
                          min={140}
                          max={400}
                          step={5}
                          value={wlcCfg.defaultCoverageRadius}
                          onChange={(e) =>
                            updateWlcCfg({ defaultCoverageRadius: Number(e.target.value) })
                          }
                          className="w-full accent-cyan-400 cursor-pointer mt-1"
                        />
                      </div>
                    </div>

                    {/* Centralized WLAN Profile Editor (SSID <-> VLAN Mapping) */}
                    <div className="p-2.5 rounded-md bg-slate-950/95 border border-indigo-500/40 space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold text-indigo-200 font-mono">
                          Централизованный профиль WLAN #1 ({primaryProfile.profileName}) — транслируется на все Lightweight AP
                        </span>
                        <span className="text-[10px] font-mono text-emerald-300">
                          802.1Q VLAN Mapping: VLAN {primaryProfile.vlanId}
                        </span>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-4 gap-2 text-xs">
                        <div>
                          <label className="block text-[10px] font-mono text-slate-400 mb-1">
                            Корпоративный SSID
                          </label>
                          <input
                            type="text"
                            data-testid="wlc-wlan-ssid-input"
                            value={primaryProfile.ssid}
                            onChange={(e) => updatePrimaryProfile({ ssid: e.target.value })}
                            className="w-full px-2 py-1.5 rounded bg-slate-900 border border-slate-700 font-mono text-cyan-200 font-semibold focus:outline-none focus:border-cyan-500"
                          />
                        </div>

                        <div>
                          <label className="block text-[10px] font-mono text-slate-400 mb-1">
                            Привязка к VLAN (802.1Q)
                          </label>
                          <select
                            data-testid="wlc-wlan-vlan-select"
                            value={primaryProfile.vlanId}
                            onChange={(e) =>
                              updatePrimaryProfile({ vlanId: Number(e.target.value) || 10 })
                            }
                            className="w-full px-2 py-1.5 rounded bg-slate-900 border border-slate-700 font-mono text-indigo-300"
                          >
                            {vlanDb.map((v) => (
                              <option key={v.id} value={v.id}>
                                VLAN {v.id} ({v.name})
                              </option>
                            ))}
                            {!vlanDb.some((v) => v.id === 10) && (
                              <option value={10}>VLAN 10 (Corp Wireless)</option>
                            )}
                            {!vlanDb.some((v) => v.id === 20) && (
                              <option value={20}>VLAN 20 (Guest / Data)</option>
                            )}
                          </select>
                        </div>

                        <div>
                          <label className="block text-[10px] font-mono text-slate-400 mb-1">
                            Диапазон радиосети
                          </label>
                          <select
                            value={primaryProfile.band}
                            onChange={(e) =>
                              updatePrimaryProfile({
                                band: e.target.value as '2.4GHz' | '5GHz',
                              })
                            }
                            className="w-full px-2 py-1.5 rounded bg-slate-900 border border-slate-700 font-mono text-slate-100"
                          >
                            <option value="2.4GHz">2.4 GHz (Ch 1 / 6 / 11)</option>
                            <option value="5GHz">5 GHz (Ch 36 / 44 / 149)</option>
                          </select>
                        </div>

                        <div>
                          <label className="block text-[10px] font-mono text-slate-400 mb-1">
                            WPA2-PSK Ключ сети
                          </label>
                          <div className="flex items-center gap-1">
                            <select
                              value={primaryProfile.security}
                              onChange={(e) =>
                                updatePrimaryProfile({
                                  security: e.target.value as 'open' | 'wpa2',
                                })
                              }
                              className="w-24 px-1.5 py-1.5 rounded bg-slate-900 border border-slate-700 font-mono text-slate-200"
                            >
                              <option value="wpa2">WPA2</option>
                              <option value="open">Open</option>
                            </select>
                            {primaryProfile.security === 'wpa2' && (
                              <input
                                type="text"
                                data-testid="wlc-wlan-password-input"
                                value={primaryProfile.password || ''}
                                onChange={(e) =>
                                  updatePrimaryProfile({ password: e.target.value })
                                }
                                className="flex-1 min-w-0 px-2 py-1.5 rounded bg-slate-900 border border-slate-700 font-mono text-amber-300"
                              />
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Joined Lightweight APs (CAPWAP Tunnels) Table */}
                  <div className="rounded-md border border-slate-800 overflow-hidden bg-slate-950">
                    <div className="px-3 py-2 bg-slate-900 border-b border-slate-800 flex items-center justify-between text-xs font-mono">
                      <span className="font-semibold text-slate-200">
                        Управляемые точки доступа Lightweight AP — Туннели CAPWAP ({joinedLapNodes.length} из {allApNodes.length} AP)
                      </span>
                      <span className="text-[10px] text-cyan-300">
                        Control: UDP 5246 · Data: UDP 5247
                      </span>
                    </div>
                    <table className="w-full text-left border-collapse text-xs font-mono">
                      <thead>
                        <tr className="bg-slate-900/60 border-b border-slate-800 text-[10px] uppercase text-slate-400">
                          <th className="py-1.5 px-2.5">Точка доступа (AP)</th>
                          <th className="py-1.5 px-2.5">Режим / CAPWAP Туннель</th>
                          <th className="py-1.5 px-2.5">Профиль SSID & VLAN</th>
                          <th className="py-1.5 px-2.5">Канал RRM</th>
                          <th className="py-1.5 px-2.5">Клиенты</th>
                          <th className="py-1.5 px-2.5 text-right">Управление</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800/70">
                        {allApNodes.length === 0 ? (
                          <tr>
                            <td colSpan={6} className="py-5 text-center text-slate-500 font-sans">
                              На холсте нет точек доступа Wi-Fi. Добавьте Wi-Fi Access Point из левой панели оборудования.
                            </td>
                          </tr>
                        ) : (
                          allApNodes.map((ap) => {
                            const apCfg = ap.wifiConfig;
                            const isLapMode = apCfg?.apMode === 'lightweight';
                            const isJoined =
                              isLapMode && apCfg?.capwapStatus === 'joined';
                            const clientCount = allLinks.filter(
                              (l) =>
                                l.cableType === 'wireless' &&
                                (l.sourceNodeId === ap.id || l.targetNodeId === ap.id)
                            ).length;
                            const uplinkIp =
                              ap.interfaces.find((i) => !i.isWireless && i.ipAddress)
                                ?.ipAddress || 'L2 PoE+';

                            return (
                              <tr key={ap.id} className="hover:bg-slate-900/50">
                                <td className="py-1.5 px-2.5">
                                  <div className="font-bold text-cyan-300">{ap.name}</div>
                                  <div className="text-[10px] text-slate-400">{uplinkIp}</div>
                                </td>
                                <td className="py-1.5 px-2.5">
                                  {isJoined ? (
                                    <span className="px-2 py-0.5 rounded bg-emerald-950/90 border border-emerald-500/50 text-[10px] font-bold text-emerald-300">
                                      CAPWAP JOINED · UDP 5246
                                    </span>
                                  ) : isLapMode ? (
                                    <span className="px-2 py-0.5 rounded bg-amber-950/90 border border-amber-500/50 text-[10px] font-bold text-amber-300">
                                      CAPWAP DISCOVERY
                                    </span>
                                  ) : (
                                    <span className="px-2 py-0.5 rounded bg-slate-900 border border-slate-700 text-[10px] text-slate-400">
                                      Autonomous AP (Standalone)
                                    </span>
                                  )}
                                </td>
                                <td className="py-1.5 px-2.5 text-slate-200">
                                  «{apCfg?.ssid}» ·{' '}
                                  <span className="text-indigo-300">
                                    VLAN {apCfg?.bridgeVlan || 1}
                                  </span>
                                </td>
                                <td className="py-1.5 px-2.5 text-cyan-300 font-semibold">
                                  Ch {apCfg?.channel} ({apCfg?.band})
                                </td>
                                <td className="py-1.5 px-2.5 text-emerald-300">
                                  {clientCount} кл.
                                </td>
                                <td className="py-1.5 px-2.5 text-right">
                                  <button
                                    type="button"
                                    onClick={() => {
                                      const nextMode = isLapMode ? 'autonomous' : 'lightweight';
                                      const nextNodes = allNodes.map((n) =>
                                        n.id === ap.id && n.wifiConfig
                                          ? {
                                              ...n,
                                              wifiConfig: {
                                                ...n.wifiConfig,
                                                apMode: nextMode as 'autonomous' | 'lightweight',
                                                wlcNodeId:
                                                  nextMode === 'lightweight' ? node.id : undefined,
                                              },
                                            }
                                          : n
                                      );
                                      const synced = syncWirelessAssociations(nextNodes, allLinks);
                                      if (onUpdateAllNodes) {
                                        onUpdateAllNodes(synced.nodes);
                                      }
                                      setStatusToast(
                                        nextMode === 'lightweight'
                                          ? `${ap.name} подключена к контроллеру ${node.name} по туннелю CAPWAP`
                                          : `${ap.name} переведена в автономный режим (Autonomous AP)`
                                      );
                                    }}
                                    className={`px-2 py-0.5 rounded text-[10px] border transition-colors cursor-pointer ${
                                      isLapMode
                                        ? 'bg-slate-900 hover:bg-slate-800 border-slate-700 text-slate-300'
                                        : 'bg-cyan-950 hover:bg-cyan-900 border-cyan-500/50 text-cyan-200 font-semibold'
                                    }`}
                                  >
                                    {isLapMode ? 'В Autonomous' : 'Join CAPWAP'}
                                  </button>
                                </td>
                              </tr>
                            );
                          })
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            })()}

            {/* TAB 6: IEEE 802.3af/at PoE POWER BUDGET & VOICE VLAN MANAGEMENT */}
            {activeTab === 'poe' && (
              <div className="space-y-3" data-testid="switch-poe-panel">
                {/* PoE PSU Summary & Budget Bar */}
                <div className="p-3 rounded-md bg-slate-900/95 border border-fuchsia-500/35 space-y-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <div className="w-8 h-8 rounded-lg bg-fuchsia-500/15 border border-fuchsia-500/40 flex items-center justify-center">
                        <Zap className="w-4 h-4 text-fuchsia-300" />
                      </div>
                      <div>
                        <div className="text-xs font-bold text-slate-100 flex items-center gap-2">
                          <span>Контроллер питания IEEE {poeStatus.standard} PoE+ (Power over Ethernet)</span>
                          <span
                            className={`px-1.5 py-0.5 rounded text-[10px] font-mono ${
                              poeStatus.enabled
                                ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                                : 'bg-red-500/20 text-red-300 border border-red-500/40'
                            }`}
                          >
                            {poeStatus.enabled ? 'PSE ACTIVE' : 'PSE DISABLED'}
                          </span>
                        </div>
                        <div className="text-[11px] text-slate-400">
                          Питание IP-телефонов (7.0 Вт Class 2) и точек доступа Wi-Fi (15.4 Вт Class 3) по медной витой паре + маркировка Voice VLAN (CoS 5 / DSCP EF).
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <select
                        aria-label="Бюджет мощности БП PoE коммутатора"
                        data-testid="switch-poe-budget-select"
                        value={poeStatus.totalBudgetWatts}
                        onChange={(e) => {
                          const watts = Number(e.target.value) || 370;
                          onUpdateNode({
                            ...node,
                            poeConfig: {
                              enabled: poeStatus.enabled,
                              totalBudgetWatts: watts,
                              standard: poeStatus.standard,
                            },
                          });
                          setStatusToast(
                            `Бюджет мощности PoE коммутатора ${node.name} установлен на ${watts} Вт`
                          );
                        }}
                        className="px-2 py-1 rounded bg-slate-950 border border-slate-700 text-xs font-mono text-amber-300 cursor-pointer"
                      >
                        <option value={15}>15 W (Малый БП — тест перегрузки)</option>
                        <option value={65}>65 W (Compact PoE)</option>
                        <option value={125}>125 W (8-Port PoE+)</option>
                        <option value={370}>370 W (24-Port PoE+ Default)</option>
                        <option value={740}>740 W (48-Port UPOE)</option>
                      </select>

                      <button
                        type="button"
                        data-testid="switch-poe-master-toggle"
                        onClick={() => {
                          const nextEnabled = !poeStatus.enabled;
                          onUpdateNode({
                            ...node,
                            poeConfig: {
                              enabled: nextEnabled,
                              totalBudgetWatts: poeStatus.totalBudgetWatts,
                              standard: poeStatus.standard,
                            },
                          });
                          setStatusToast(
                            nextEnabled
                              ? `Питание PoE 802.3af/at включено на всех портах ${node.name}`
                              : `Питание PoE отключено на коммутаторе ${node.name}`
                          );
                        }}
                        className={`px-2.5 py-1 rounded text-xs font-mono font-bold border transition-colors cursor-pointer ${
                          poeStatus.enabled
                            ? 'bg-emerald-600 border-emerald-400 text-white'
                            : 'bg-slate-950 border-slate-700 text-slate-400'
                        }`}
                      >
                        {poeStatus.enabled ? 'PoE: ВКЛ' : 'PoE: ВЫКЛ'}
                      </button>
                    </div>
                  </div>

                  {/* Power Utilization Progress Bar */}
                  <div className="p-2.5 rounded bg-slate-950 border border-slate-800 space-y-1.5">
                    <div className="flex items-center justify-between text-xs font-mono">
                      <span className="text-slate-300">
                        Потребление PoE:{' '}
                        <strong className="text-amber-300" data-testid="switch-poe-used-watts">
                          {poeStatus.usedWatts.toFixed(1)} W
                        </strong>{' '}
                        из <strong>{poeStatus.totalBudgetWatts.toFixed(1)} W</strong> (свободно:{' '}
                        <span className="text-emerald-300">
                          {poeStatus.remainingWatts.toFixed(1)} W
                        </span>
                        )
                      </span>
                      <span className="text-fuchsia-300 font-bold">
                        {poeStatus.utilizationPercent}% нагрузки БП
                      </span>
                    </div>
                    <div className="w-full h-2 rounded-full bg-slate-800 overflow-hidden">
                      <div
                        className={`h-full transition-all ${
                          poeStatus.utilizationPercent > 85
                            ? 'bg-red-500'
                            : 'bg-gradient-to-r from-emerald-500 via-amber-400 to-fuchsia-500'
                        }`}
                        style={{
                          width: `${Math.min(100, poeStatus.utilizationPercent)}%`,
                        }}
                      />
                    </div>
                  </div>
                </div>

                {/* Per-Port PoE (power inline) & Auxiliary Voice VLAN Table */}
                <div className="rounded-md border border-slate-800 overflow-x-auto bg-slate-950">
                  <div className="px-3 py-2 bg-slate-900 border-b border-slate-800 flex items-center justify-between gap-2 text-xs font-mono">
                    <span className="font-semibold text-slate-200 whitespace-nowrap">
                      Таблица портов PoE (show power inline) и Voice VLAN
                    </span>
                    <span className="text-[10px] text-fuchsia-300 whitespace-nowrap">
                      switchport voice vlan &lt;ID&gt; · power inline
                    </span>
                  </div>
                  <table className="w-full min-w-[680px] text-left border-collapse text-xs font-mono">
                    <thead>
                      <tr className="bg-slate-900/70 border-b border-slate-800 text-[10px] uppercase text-slate-400">
                        <th className="py-2 px-3 w-[75px] whitespace-nowrap">Порт</th>
                        <th className="py-2 px-2.5 w-[115px] whitespace-nowrap">Режим PoE</th>
                        <th className="py-2 px-2.5 min-w-[180px] whitespace-nowrap">Статус / Потребитель (PD)</th>
                        <th className="py-2 px-2.5 w-[90px] text-right whitespace-nowrap">Мощность</th>
                        <th className="py-2 px-2.5 w-[100px] whitespace-nowrap">Data VLAN</th>
                        <th className="py-2 px-3 w-[165px] whitespace-nowrap">Voice VLAN (Aux)</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/70">
                      {poeStatus.portList.map((pStat) => {
                        const iface = node.interfaces.find((i) => i.id === pStat.portId);
                        if (!iface) return null;
                        return (
                          <tr key={pStat.portId} className="hover:bg-slate-900/50">
                            <td className="py-2 px-3 align-middle whitespace-nowrap font-bold text-slate-100">
                              {pStat.portShortName}
                            </td>
                            <td className="py-2 px-2.5 align-middle whitespace-nowrap">
                              <button
                                type="button"
                                data-testid={`poe-port-toggle-${pStat.portShortName}`}
                                onClick={() => {
                                  const nextPoe = iface.poeEnabled === false ? true : false;
                                  handleUpdateSinglePort(iface.id, { poeEnabled: nextPoe });
                                  setStatusToast(
                                    nextPoe
                                      ? `Порт ${iface.shortName}: включено питание PoE (power inline auto)`
                                      : `Порт ${iface.shortName}: отключено питание PoE (power inline never)`
                                  );
                                }}
                                className={`px-2 py-0.5 rounded text-[10px] font-bold border cursor-pointer ${
                                  pStat.adminMode === 'auto'
                                    ? 'bg-emerald-950/80 border-emerald-500/60 text-emerald-300'
                                    : 'bg-red-950/80 border-red-500/60 text-red-300'
                                }`}
                              >
                                {pStat.adminMode === 'auto' ? 'auto (ON)' : 'never (OFF)'}
                              </button>
                            </td>
                            <td className="py-2 px-2.5 align-middle whitespace-nowrap">
                              {pStat.operStatus === 'delivering' ? (
                                <span className="inline-flex items-center gap-1.5 text-emerald-300 font-semibold">
                                  <PhoneCall className="w-3 h-3 text-fuchsia-400 shrink-0" />
                                  <span>
                                    ON · {pStat.pdNodeName} ({pStat.poeClass})
                                  </span>
                                </span>
                              ) : pStat.operStatus === 'fault_overload' ? (
                                <span className="text-red-400 font-bold">
                                  FAULT (Превышен бюджет PoE!)
                                </span>
                              ) : pStat.pdNodeName ? (
                                <span className="text-amber-300">
                                  OFF ({pStat.pdNodeName} обесточен)
                                </span>
                              ) : (
                                <span className="text-slate-500">off (нет PD)</span>
                              )}
                            </td>
                            <td className="py-2 px-2.5 align-middle text-right whitespace-nowrap">
                              <span
                                className={
                                  pStat.allocatedWatts > 0
                                    ? 'text-amber-300 font-bold'
                                    : 'text-slate-500'
                                }
                              >
                                {pStat.allocatedWatts.toFixed(1)} W
                              </span>
                            </td>
                            <td className="py-2 px-2.5 align-middle whitespace-nowrap text-sky-300">
                              {iface.vlanMode === 'trunk'
                                ? '802.1Q Trunk'
                                : `VLAN ${iface.accessVlan}`}
                            </td>
                            <td className="py-2 px-3 align-middle whitespace-nowrap">
                              {iface.vlanMode === 'access' ? (
                                <select
                                  aria-label={`Voice VLAN для порта ${iface.shortName}`}
                                  data-testid={`voice-vlan-select-${iface.shortName}`}
                                  value={iface.voiceVlan || 0}
                                  onChange={(e) => {
                                    const v = Number(e.target.value) || 0;
                                    handleUpdateSinglePort(iface.id, {
                                      voiceVlan: v > 0 ? v : undefined,
                                    });
                                    setStatusToast(
                                      v > 0
                                        ? `На порту ${iface.shortName} назначен голосовой Voice VLAN ${v} (QoS CoS 5)`
                                        : `Voice VLAN отключён на порту ${iface.shortName}`
                                    );
                                  }}
                                  className={`w-full px-2 py-1 rounded text-[11px] font-mono border cursor-pointer ${
                                    iface.voiceVlan
                                      ? 'bg-fuchsia-950/80 border-fuchsia-500/60 text-fuchsia-200 font-bold'
                                      : 'bg-slate-900 border-slate-700 text-slate-400'
                                  }`}
                                >
                                  <option value={0}>none (выкл)</option>
                                  {vlanDb.map((v) => (
                                    <option key={v.id} value={v.id}>
                                      Voice VLAN {v.id} ({v.name})
                                    </option>
                                  ))}
                                  {!vlanDb.some((v) => v.id === 20) && (
                                    <option value={20}>Voice VLAN 20 (VoIP)</option>
                                  )}
                                </select>
                              ) : (
                                <span className="text-slate-500 text-[10px]">В транке 802.1Q</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* TAB 8: GPON FTTH OPTICAL NETWORK (OLT 1490/1310nm & SUBSCRIBER ONT/ONU) */}
            {activeTab === 'gpon' && (() => {
              // ============================================================
              // CASE A: PROVIDER GPON OLT TERMINAL (`gpon_olt`)
              // ============================================================
              if (isGponOltNode(node)) {
                const oltCfg = node.gponOltConfig || getDefaultGponOltConfig();
                const connectedOnts = computeGponOltConnectedOnts(node, allNodes, allLinks);
                const splitterLossDb = getGponSplitterInsertionLossDb(oltCfg.splitterRatio);

                const updateOltCfg = (patch: Partial<typeof oltCfg>) => {
                  onUpdateNode({
                    ...node,
                    gponOltConfig: {
                      ...oltCfg,
                      ...patch,
                    },
                  });
                };

                return (
                  <div className="space-y-3" data-testid="gpon-olt-panel">
                    {/* OLT Optical Laser & PLC Splitter Configuration Card */}
                    <div className="p-3 rounded-lg bg-slate-900/95 border border-teal-500/45 space-y-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <div className="text-xs font-bold text-teal-200 flex items-center gap-2">
                            <Activity className="w-4 h-4 text-teal-400" />
                            <span>{oltCfg.vendorModel} — Оптическое дерево пассивной сети PON</span>
                            <span className="px-2 py-0.5 rounded bg-teal-950/90 border border-teal-500/50 text-[10px] font-mono text-teal-300">
                              TX 1490 нм (2.5G) / RX 1310 нм (1.25G)
                            </span>
                          </div>
                          <p className="text-[11px] text-slate-400 mt-0.5">
                            Передатчик OLT излучает нисходящий поток на длине волны <strong className="text-teal-300">1490 нм</strong> (+{oltCfg.txPowerDbm} dBm), а абонентские модемы ONT передают восходящий поток TDMA на <strong className="text-sky-300">1310 нм</strong>.
                          </p>
                        </div>

                        <button
                          type="button"
                          data-testid="gpon-olt-sn-auth-toggle"
                          onClick={() => {
                            const nextAuth = !oltCfg.requireSnAuth;
                            updateOltCfg({ requireSnAuth: nextAuth });
                            setStatusToast(
                              nextAuth
                                ? 'Включена проверка серийных номеров GPON-SN (OMCI Auth ON)'
                                : 'Проверка GPON-SN отключена (автоматический допуск всех ONT)'
                            );
                          }}
                          className={`px-2.5 py-1 rounded text-xs font-mono font-bold border cursor-pointer whitespace-nowrap ${
                            oltCfg.requireSnAuth
                              ? 'bg-emerald-950/85 border-emerald-500/60 text-emerald-300'
                              : 'bg-amber-950/80 border-amber-500/50 text-amber-300'
                          }`}
                        >
                          {oltCfg.requireSnAuth ? 'SN AUTH: ВКЛ (OMCI)' : 'SN AUTH: ВЫКЛ (AUTO)'}
                        </button>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-4 gap-2.5 items-end text-xs font-mono">
                        <div>
                          <label className="block text-[10px] text-slate-400 mb-1 whitespace-nowrap">
                            Оптический модуль SFP+ GPON
                          </label>
                          <select
                            data-testid="gpon-olt-sfp-select"
                            value={oltCfg.sfpClass}
                            onChange={(e) => {
                              const cls = e.target.value as 'B+' | 'C+';
                              const nextTx = cls === 'C+' ? 5.5 : 3.5;
                              updateOltCfg({ sfpClass: cls, txPowerDbm: nextTx });
                              setStatusToast(
                                `Установлен трансивер GPON SFP Class ${cls} (мощность лазера 1490 нм: +${nextTx} dBm)`
                              );
                            }}
                            className="w-full px-2 py-1.5 rounded bg-slate-950 border border-slate-700 text-teal-300 font-bold"
                          >
                            <option value="B+">Class B+ (+3.5 dBm · до 28 dB)</option>
                            <option value="C+">Class C+ (+5.5 dBm · до 32 dB)</option>
                          </select>
                        </div>

                        <div>
                          <label className="block text-[10px] text-slate-400 mb-1 whitespace-nowrap">
                            Мощность лазера 1490 нм (dBm)
                          </label>
                          <input
                            type="number"
                            step="0.5"
                            min="-2"
                            max="8"
                            data-testid="gpon-olt-tx-power-input"
                            value={oltCfg.txPowerDbm}
                            onChange={(e) =>
                              updateOltCfg({
                                txPowerDbm: Number(e.target.value) || 0,
                              })
                            }
                            className="w-full px-2.5 py-1.5 rounded bg-slate-950 border border-slate-700 text-emerald-300 font-bold"
                          />
                        </div>

                        <div>
                          <label className="block text-[10px] text-slate-400 mb-1 whitespace-nowrap">
                            Оптический сплиттер PLC
                          </label>
                          <select
                            data-testid="gpon-olt-splitter-select"
                            value={oltCfg.splitterRatio}
                            onChange={(e) => {
                              const ratio = e.target.value as GponSplitterRatio;
                              updateOltCfg({ splitterRatio: ratio });
                              setStatusToast(
                                `Установлен пассивный оптический сплиттер ${ratio} (вносимое затухание -${getGponSplitterInsertionLossDb(ratio)} dB)`
                              );
                            }}
                            className="w-full px-2 py-1.5 rounded bg-slate-950 border border-slate-700 text-amber-300 font-bold"
                          >
                            <option value="1:1">1:1 Прямой (-0.5 dB)</option>
                            <option value="1:8">1:8 Сплиттер (-10.5 dB)</option>
                            <option value="1:16">1:16 Сплиттер (-13.8 dB)</option>
                            <option value="1:32">1:32 Сплиттер (-17.2 dB)</option>
                            <option value="1:64">1:64 Сплиттер (-20.5 dB)</option>
                          </select>
                        </div>

                        <div>
                          <label className="block text-[10px] text-slate-400 mb-1 whitespace-nowrap">
                            Triple-Play VLAN (Inet/TV/VoIP)
                          </label>
                          <div className="px-2.5 py-1.5 rounded bg-slate-950 border border-slate-800 text-sky-300 whitespace-nowrap">
                            {oltCfg.internetVlan} / {oltCfg.iptvVlan} / {oltCfg.voipVlan}
                          </div>
                        </div>
                      </div>

                      {/* GPON-SN Whitelist Bar */}
                      <div className="p-2.5 rounded bg-slate-950/90 border border-slate-800 space-y-2">
                        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                          <span className="font-mono text-slate-300">
                            Таблица авторизованных серийных номеров <strong className="text-teal-300">GPON-SN</strong> ({oltCfg.authorizedSnList.length}):
                          </span>
                          <div className="flex items-center gap-1.5">
                            <input
                              type="text"
                              data-testid="gpon-olt-add-sn-input"
                              placeholder="HWTC-1003E6F7"
                              value={newGponSnInput}
                              onChange={(e) => setNewGponSnInput(e.target.value.toUpperCase())}
                              className="w-36 px-2 py-1 rounded bg-slate-900 border border-slate-700 text-xs font-mono text-teal-200"
                            />
                            <button
                              type="button"
                              data-testid="gpon-olt-add-sn-btn"
                              onClick={() => {
                                const clean = newGponSnInput.trim().toUpperCase();
                                if (!clean) return;
                                if (!oltCfg.authorizedSnList.includes(clean)) {
                                  updateOltCfg({
                                    authorizedSnList: [...oltCfg.authorizedSnList, clean],
                                  });
                                  setStatusToast(`Серийный номер ONT ${clean} добавлен в белый список OLT`);
                                }
                              }}
                              className="px-2.5 py-1 rounded bg-teal-600 hover:bg-teal-500 text-xs font-medium text-white whitespace-nowrap cursor-pointer"
                            >
                              + Авторизовать SN
                            </button>
                          </div>
                        </div>

                        <div className="flex flex-wrap items-center gap-1.5">
                          {oltCfg.authorizedSnList.map((sn) => (
                            <span
                              key={sn}
                              className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-teal-950/80 border border-teal-500/40 text-[11px] font-mono text-teal-200"
                            >
                              <span>{sn}</span>
                              <button
                                type="button"
                                title={`Удалить ${sn} из авторизованных`}
                                onClick={() => {
                                  updateOltCfg({
                                    authorizedSnList: oltCfg.authorizedSnList.filter((item) => item !== sn),
                                  });
                                  setStatusToast(`Авторизация GPON-SN ${sn} отозвана на OLT`);
                                }}
                                className="text-slate-400 hover:text-red-300 cursor-pointer"
                              >
                                ×
                              </button>
                            </span>
                          ))}
                        </div>
                      </div>
                    </div>

                    {/* Connected Subscriber ONT Terminals Table (`display ont info 0/1 all`) */}
                    <div className="rounded-md border border-slate-800 overflow-x-auto bg-slate-950">
                      <div className="px-3 py-2 bg-slate-900 border-b border-slate-800 flex items-center justify-between gap-2 text-xs font-mono">
                        <span className="font-semibold text-slate-200 whitespace-nowrap">
                          Подключенные абонентские терминалы ONT / ONU (display ont optical-info)
                        </span>
                        <span className="text-[10px] text-teal-300 whitespace-nowrap">
                          Сплиттер {oltCfg.splitterRatio} (-{splitterLossDb} dB) · Порог LOS: -28.0 dBm
                        </span>
                      </div>
                      <table className="w-full min-w-[720px] text-left border-collapse text-xs font-mono">
                        <thead>
                          <tr className="bg-slate-900/70 border-b border-slate-800 text-[10px] uppercase text-slate-400">
                            <th className="py-2 px-3 w-[85px] whitespace-nowrap">PON Порт</th>
                            <th className="py-2 px-2.5 w-[155px] whitespace-nowrap">Терминал / GPON-SN</th>
                            <th className="py-2 px-2.5 w-[135px] whitespace-nowrap">Трасса / Затухание</th>
                            <th className="py-2 px-2.5 w-[130px] whitespace-nowrap">Сигнал RX (dBm)</th>
                            <th className="py-2 px-2.5 w-[125px] whitespace-nowrap">Статус / LOS</th>
                            <th className="py-2 px-3 text-right whitespace-nowrap">Тест линии</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-800/70">
                          {connectedOnts.length === 0 ? (
                            <tr>
                              <td colSpan={6} className="py-5 text-center text-slate-500 font-sans">
                                К портам PON0/1..PON0/4 не подключено ни одного оптического модема ONT. Соедините OLT и ONT оптоволоконным кабелем.
                              </td>
                            </tr>
                          ) : (
                            connectedOnts.map((ontSt) => {
                              const ontNodeObj = allNodes.find((n) => n.id === ontSt.ontNodeId);
                              return (
                                <tr key={ontSt.ontNodeId} className="hover:bg-slate-900/50">
                                  <td className="py-2 px-3 align-middle whitespace-nowrap font-bold text-teal-300">
                                    {ontSt.oltPortShortName || 'PON0/1'}
                                  </td>
                                  <td className="py-2 px-2.5 align-middle whitespace-nowrap">
                                    <button
                                      type="button"
                                      onClick={() => onSelectNode(ontSt.ontNodeId)}
                                      className="font-bold text-sky-300 hover:underline cursor-pointer block"
                                    >
                                      {ontSt.ontName}
                                    </button>
                                    <span className="text-[10px] text-slate-400">
                                      SN: {ontSt.gponSn}
                                    </span>
                                  </td>
                                  <td className="py-2 px-2.5 align-middle whitespace-nowrap text-slate-300">
                                    {ontSt.distanceKm} км · -{ontSt.totalLossDb} dB
                                  </td>
                                  <td className="py-2 px-2.5 align-middle whitespace-nowrap">
                                    <span
                                      className={`font-bold ${
                                        ontSt.isLos
                                          ? 'text-red-400'
                                          : ontSt.rxPowerDbm < -25.5
                                          ? 'text-amber-300'
                                          : 'text-emerald-300'
                                      }`}
                                    >
                                      {ontSt.rxPowerDbm} dBm
                                    </span>
                                    <span className="block text-[9px] text-slate-500">
                                      запас {ontSt.opticalMarginDb >= 0 ? `+${ontSt.opticalMarginDb}` : ontSt.opticalMarginDb} dB
                                    </span>
                                  </td>
                                  <td className="py-2 px-2.5 align-middle whitespace-nowrap">
                                    {ontSt.isLos ? (
                                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-red-950/90 border border-red-500/70 text-red-200 text-[10px] font-bold animate-pulse">
                                        <AlertTriangle className="w-3 h-3 text-red-400 shrink-0" />
                                        <span>LOS ALARM</span>
                                      </span>
                                    ) : !ontSt.isSnAuthorized ? (
                                      <span className="inline-block px-2 py-0.5 rounded bg-amber-950/90 border border-amber-500/60 text-amber-300 text-[10px] font-bold">
                                        SN UNAUTH
                                      </span>
                                    ) : (
                                      <span className="inline-block px-2 py-0.5 rounded bg-emerald-950/90 border border-emerald-500/50 text-emerald-300 text-[10px] font-bold">
                                        ONLINE (O5)
                                      </span>
                                    )}
                                  </td>
                                  <td className="py-2 px-3 align-middle text-right whitespace-nowrap space-x-1">
                                    {ontNodeObj && onUpdateAllNodes && (
                                      <button
                                        type="button"
                                        data-testid={`olt-toggle-los-${ontSt.ontNodeId}`}
                                        onClick={() => {
                                          const currOntCfg =
                                            ontNodeObj.gponOntConfig || getDefaultGponOntConfig(1);
                                          const triggerLos = !ontSt.isLos;
                                          const nextExtra = triggerLos ? 16.5 : 2.0;
                                          const updatedAll = allNodes.map((n) =>
                                            n.id === ontNodeObj.id
                                              ? {
                                                  ...n,
                                                  gponOntConfig: {
                                                    ...currOntCfg,
                                                    extraAttenuationDb: nextExtra,
                                                  },
                                                }
                                              : n
                                          );
                                          onUpdateAllNodes(updatedAll);
                                          setStatusToast(
                                            triggerLos
                                              ? `Симуляция обрыва/изгиба волокна на ${ontNodeObj.name}: затухание +16.5 dB → загорелся красный индикатор LOS!`
                                              : `Оптическая линия до ${ontNodeObj.name} восстановлена (LOS погашен)`
                                          );
                                        }}
                                        className={`px-2 py-0.5 rounded text-[10px] font-mono border cursor-pointer ${
                                          ontSt.isLos
                                            ? 'bg-emerald-950/80 border-emerald-500/60 text-emerald-300'
                                            : 'bg-red-950/70 border-red-500/50 text-red-300'
                                        }`}
                                      >
                                        {ontSt.isLos ? 'Убрать LOS' : 'Тест LOS (-31dBm)'}
                                      </button>
                                    )}
                                    {!ontSt.isSnAuthorized && (
                                      <button
                                        type="button"
                                        onClick={() => {
                                          updateOltCfg({
                                            authorizedSnList: Array.from(
                                              new Set([...oltCfg.authorizedSnList, ontSt.gponSn])
                                            ),
                                          });
                                          setStatusToast(`Терминал ${ontSt.gponSn} авторизован на OLT`);
                                        }}
                                        className="px-2 py-0.5 rounded bg-teal-600 text-white text-[10px] cursor-pointer"
                                      >
                                        Авторизовать SN
                                      </button>
                                    )}
                                  </td>
                                </tr>
                              );
                            })
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                );
              }

              // ============================================================
              // CASE B: SUBSCRIBER GPON ONT / ONU MODEM (`gpon_ont`)
              // ============================================================
              const ontCfg = node.gponOntConfig || getDefaultGponOntConfig(1);
              const ontState = computeGponOntOpticalState(node, allNodes, allLinks);

              const updateOntCfg = (patch: Partial<typeof ontCfg>) => {
                const mergedCfg = {
                  ...ontCfg,
                  ...patch,
                };
                const syncedNode = syncOntInterfacesWithServicePorts({
                  ...node,
                  gponOntConfig: mergedCfg,
                });
                onUpdateNode(syncSwitchNodeWithRoutes(syncedNode));
              };

              return (
                <div className="space-y-3" data-testid="gpon-ont-panel">
                  {/* Front-Panel Optical LED Strip (POWER | PON | LOS | LAN1 | LAN2 | LAN3) */}
                  <div
                    className={`p-3 rounded-lg border flex flex-wrap items-center justify-between gap-3 ${
                      ontState.isLos
                        ? 'bg-red-950/35 border-red-500/70'
                        : !ontState.isSnAuthorized
                        ? 'bg-amber-950/30 border-amber-500/60'
                        : 'bg-slate-900/95 border-teal-500/45'
                    }`}
                  >
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <Activity
                          className={`w-4 h-4 ${
                            ontState.isLos ? 'text-red-400' : 'text-teal-400'
                          }`}
                        />
                        <span className="text-xs font-bold text-slate-100">
                          {ontCfg.vendorModel} — Абонентский терминал FTTH
                        </span>
                        <span className="px-2 py-0.5 rounded bg-slate-950 border border-slate-700 text-[10px] font-mono text-teal-300">
                          GPON-SN: {ontCfg.gponSn}
                        </span>
                      </div>
                      <p className="text-[11px] text-slate-300">{ontState.reasonRu}</p>
                    </div>

                    {/* Hardware LED Indicators */}
                    <div
                      data-testid="gpon-ont-led-strip"
                      className="flex items-center gap-2.5 px-3 py-1.5 rounded-md bg-slate-950 border border-slate-800 font-mono text-[10px]"
                    >
                      <div className="flex items-center gap-1">
                        <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 shadow-[0_0_8px_#34d399]" />
                        <span className="text-slate-300">PWR</span>
                      </div>
                      <div className="flex items-center gap-1">
                        <span
                          className={`w-2.5 h-2.5 rounded-full ${
                            ontState.isOperational
                              ? 'bg-emerald-400 shadow-[0_0_8px_#34d399]'
                              : !ontState.isLos && !ontState.isSnAuthorized
                              ? 'bg-amber-400 animate-pulse'
                              : 'bg-slate-700'
                          }`}
                        />
                        <span className={ontState.isOperational ? 'text-emerald-300 font-bold' : 'text-slate-400'}>
                          PON
                        </span>
                      </div>
                      <div className="flex items-center gap-1" data-testid="gpon-ont-los-led">
                        <span
                          className={`w-2.5 h-2.5 rounded-full ${
                            ontState.isLos
                              ? 'bg-red-500 shadow-[0_0_12px_#ef4444] animate-pulse'
                              : 'bg-slate-800'
                          }`}
                        />
                        <span className={ontState.isLos ? 'text-red-400 font-bold' : 'text-slate-500'}>
                          LOS
                        </span>
                      </div>
                      <div className="h-3 w-px bg-slate-800" />
                      {['LAN1', 'LAN2', 'LAN3'].map((lanName) => {
                        const iface = node.interfaces.find((i) => i.shortName === lanName);
                        const hasLink = allLinks.some(
                          (l) =>
                            (l.sourceNodeId === node.id && l.sourcePortId === iface?.id) ||
                            (l.targetNodeId === node.id && l.targetPortId === iface?.id)
                        );
                        return (
                          <div key={lanName} className="flex items-center gap-1">
                            <span
                              className={`w-2 h-2 rounded-full ${
                                hasLink && iface?.adminStatus === 'up'
                                  ? 'bg-emerald-400'
                                  : 'bg-slate-700'
                              }`}
                            />
                            <span className="text-slate-400">{lanName}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Optical Power Budget Calculator & Attenuation Simulator (1490nm / 1310nm) */}
                  <div className="p-3 rounded-lg bg-slate-900/90 border border-slate-800 space-y-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-mono">
                      <span className="font-semibold text-teal-300">
                        Оптический бюджет линии (RX 1490 нм / TX 1310 нм):{' '}
                        <strong
                          data-testid="gpon-ont-rx-dbm-value"
                          className={
                            ontState.isLos
                              ? 'text-red-400'
                              : ontState.rxPowerDbm < -25.5
                              ? 'text-amber-300'
                              : 'text-emerald-300'
                          }
                        >
                          {ontState.rxPowerDbm} dBm
                        </strong>{' '}
                        (Порог LOS: {ontState.losThresholdDbm} dBm)
                      </span>

                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          data-testid="gpon-ont-preset-normal-btn"
                          onClick={() => {
                            updateOntCfg({ distanceKm: 4.0, extraAttenuationDb: 2.0 });
                            setStatusToast('Оптическое затухание в норме: трасса 4.0 км, потери 2.0 dB (LOS погашен)');
                          }}
                          className="px-2 py-0.5 rounded bg-emerald-950/80 hover:bg-emerald-900 border border-emerald-500/50 text-[10px] font-mono text-emerald-300 cursor-pointer"
                        >
                          Норма (-13.7 dBm)
                        </button>
                        <button
                          type="button"
                          data-testid="gpon-ont-preset-los-btn"
                          onClick={() => {
                            updateOntCfg({ distanceKm: 10.0, extraAttenuationDb: 15.0 });
                            setStatusToast('Симуляция сильного затухания на линии (< -28.0 dBm): загорелся красный индикатор LOS!');
                          }}
                          className="px-2 py-0.5 rounded bg-red-950/80 hover:bg-red-900 border border-red-500/60 text-[10px] font-mono text-red-300 cursor-pointer"
                        >
                          Симулировать LOS (&lt; -28 dBm)
                        </button>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-4 gap-2.5 items-end text-xs font-mono">
                      <div>
                        <label className="block text-[10px] text-slate-400 mb-1 whitespace-nowrap">
                          Серийный номер GPON-SN
                        </label>
                        <input
                          type="text"
                          data-testid="gpon-ont-sn-input"
                          value={ontCfg.gponSn}
                          onChange={(e) =>
                            updateOntCfg({ gponSn: e.target.value.toUpperCase() })
                          }
                          className="w-full px-2.5 py-1.5 rounded bg-slate-950 border border-slate-700 text-teal-300 font-bold"
                        />
                      </div>

                      <div>
                        <label className="block text-[10px] text-slate-400 mb-1 whitespace-nowrap">
                          Длина волокна (км · 0.35 dB/км)
                        </label>
                        <input
                          type="number"
                          step="0.5"
                          min="0.1"
                          max="40"
                          data-testid="gpon-ont-distance-input"
                          value={ontCfg.distanceKm}
                          onChange={(e) =>
                            updateOntCfg({
                              distanceKm: Math.max(0, Number(e.target.value) || 0),
                            })
                          }
                          className="w-full px-2.5 py-1.5 rounded bg-slate-950 border border-slate-700 text-slate-100"
                        />
                      </div>

                      <div>
                        <label className="block text-[10px] text-slate-400 mb-1 whitespace-nowrap">
                          Затухание сварки/изгиба (dB)
                        </label>
                        <input
                          type="number"
                          step="0.5"
                          min="0"
                          max="30"
                          data-testid="gpon-ont-attenuation-input"
                          value={ontCfg.extraAttenuationDb}
                          onChange={(e) =>
                            updateOntCfg({
                              extraAttenuationDb: Math.max(0, Number(e.target.value) || 0),
                            })
                          }
                          className="w-full px-2.5 py-1.5 rounded bg-slate-950 border border-slate-700 text-amber-300 font-bold"
                        />
                      </div>

                      <div>
                        <label className="block text-[10px] text-slate-400 mb-1 whitespace-nowrap">
                          Формула потерь (Total Loss)
                        </label>
                        <div className="px-2.5 py-1.5 rounded bg-slate-950 border border-slate-800 text-slate-300 whitespace-nowrap">
                          +{ontState.oltTxPowerDbm} − {ontState.totalLossDb} dB ={' '}
                          <strong className={ontState.isLos ? 'text-red-400' : 'text-emerald-300'}>
                            {ontState.rxPowerDbm} dBm
                          </strong>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Triple-Play Service Port Mapping Table (Port 1 Internet / Port 2 IPTV / Port 3 VoIP) */}
                  <div className="rounded-md border border-slate-800 overflow-x-auto bg-slate-950">
                    <div className="px-3 py-2 bg-slate-900 border-b border-slate-800 flex items-center justify-between gap-2 text-xs font-mono">
                      <span className="font-semibold text-slate-200 whitespace-nowrap">
                        Распределение услуг Triple-Play по портам абонента (ONT Service Port Mapping)
                      </span>
                      <span className="text-[10px] text-teal-300 whitespace-nowrap">
                        OMCI VLAN Translation · GEM Port Mapping
                      </span>
                    </div>
                    <table className="w-full min-w-[700px] text-left border-collapse text-xs font-mono">
                      <thead>
                        <tr className="bg-slate-900/70 border-b border-slate-800 text-[10px] uppercase text-slate-400">
                          <th className="py-2 px-3 w-[80px] whitespace-nowrap">Порт ONT</th>
                          <th className="py-2 px-2.5 w-[210px] whitespace-nowrap">Назначение услуги (Service)</th>
                          <th className="py-2 px-2.5 w-[120px] whitespace-nowrap">Сервисный VLAN</th>
                          <th className="py-2 px-2.5 w-[165px] whitespace-nowrap">Параметры PPPoE / IGMP / QoS</th>
                          <th className="py-2 px-3 min-w-[130px] whitespace-nowrap">Устройство абонента</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800/70">
                        {ontCfg.servicePorts.map((sp, idx) => {
                          const portDesc = portDescriptors.find(
                            (pd) => pd.port.shortName.toUpperCase() === sp.portShortName.toUpperCase()
                          );
                          return (
                            <tr key={sp.portShortName} className="hover:bg-slate-900/50">
                              <td className="py-2 px-3 align-middle whitespace-nowrap font-bold text-slate-100">
                                {sp.portShortName}
                              </td>
                              <td className="py-2 px-2.5 align-middle whitespace-nowrap">
                                <select
                                  aria-label={`Тип услуги для порта ${sp.portShortName}`}
                                  data-testid={`gpon-ont-service-type-${sp.portShortName}`}
                                  value={sp.serviceType}
                                  onChange={(e) => {
                                    const nextType = e.target.value as
                                      | 'internet'
                                      | 'iptv'
                                      | 'voip'
                                      | 'custom';
                                    const defaultVlan =
                                      nextType === 'internet'
                                        ? 100
                                        : nextType === 'iptv'
                                        ? 200
                                        : nextType === 'voip'
                                        ? 300
                                        : sp.vlanId;
                                    const label =
                                      nextType === 'internet'
                                        ? `Порт ${idx + 1} — Интернет (PPPoE / DHCP)`
                                        : nextType === 'iptv'
                                        ? `Порт ${idx + 1} — IPTV Multicast (IGMP)`
                                        : nextType === 'voip'
                                        ? `Порт ${idx + 1} — VoIP Телефония (SIP / RTP)`
                                        : `Порт ${idx + 1} — Пользовательский VLAN`;
                                    const nextPorts = ontCfg.servicePorts.map((item, i) =>
                                      i === idx
                                        ? {
                                            ...item,
                                            serviceType: nextType,
                                            serviceLabel: label,
                                            vlanId: defaultVlan,
                                            qosCos:
                                              nextType === 'voip'
                                                ? 5
                                                : nextType === 'iptv'
                                                ? 4
                                                : 0,
                                          }
                                        : item
                                    );
                                    updateOntCfg({ servicePorts: nextPorts });
                                    setStatusToast(
                                      `Порт ${sp.portShortName} настроен под услугу «${label}» (VLAN ${defaultVlan})`
                                    );
                                  }}
                                  className="w-full px-2 py-1 rounded bg-slate-900 border border-slate-700 text-xs font-mono text-teal-200 cursor-pointer"
                                >
                                  <option value="internet">Интернет (PPPoE / DHCP)</option>
                                  <option value="iptv">IPTV Multicast (IGMP)</option>
                                  <option value="voip">VoIP Телефония (SIP / RTP)</option>
                                  <option value="custom">Custom Bridge VLAN</option>
                                </select>
                              </td>
                              <td className="py-2 px-2.5 align-middle whitespace-nowrap">
                                <input
                                  type="number"
                                  min={1}
                                  max={4094}
                                  data-testid={`gpon-ont-service-vlan-${sp.portShortName}`}
                                  value={sp.vlanId}
                                  onChange={(e) => {
                                    const nextVlan = Math.max(
                                      1,
                                      Math.min(4094, Number(e.target.value) || 100)
                                    );
                                    const nextPorts = ontCfg.servicePorts.map((item, i) =>
                                      i === idx ? { ...item, vlanId: nextVlan } : item
                                    );
                                    updateOntCfg({ servicePorts: nextPorts });
                                    setStatusToast(
                                      `Сервисный порт ${sp.portShortName} привязан к VLAN ${nextVlan}`
                                    );
                                  }}
                                  className="w-20 px-2 py-1 rounded bg-slate-900 border border-slate-700 text-sky-300 font-bold"
                                />
                              </td>
                              <td className="py-2 px-2.5 align-middle whitespace-nowrap text-[11px]">
                                {sp.serviceType === 'internet' && (
                                  <span className="text-emerald-300">
                                    PPPoE/IPoE · CoS 0 (BE)
                                  </span>
                                )}
                                {sp.serviceType === 'iptv' && (
                                  <span className="text-amber-300">
                                    IGMP {sp.igmpMulticastGroup || '239.255.1.1'} · CoS 4
                                  </span>
                                )}
                                {sp.serviceType === 'voip' && (
                                  <span className="text-fuchsia-300">
                                    SIP/RTP · CoS 5 (DSCP EF)
                                  </span>
                                )}
                                {sp.serviceType === 'custom' && (
                                  <span className="text-slate-400">Untagged Bridge</span>
                                )}
                              </td>
                              <td className="py-2 px-3 align-middle whitespace-nowrap text-sky-300">
                                {portDesc?.peerNode ? (
                                  <span>
                                    {portDesc.peerNode.name}:{portDesc.peerPort?.shortName}
                                  </span>
                                ) : (
                                  <span className="text-slate-500">— не подключен</span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            })()}
          </div>
        </div>
      )}
    </div>
  );
};

