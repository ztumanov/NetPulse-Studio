import React, { useState, useEffect } from 'react';
import {
  NetworkInterface,
  NetworkLink,
  NetworkNode,
  NetworkZone,
  SimulationStep,
  ZoneColor,
} from '../network/types';
import {
  addHardwarePortToNode,
  assignPortsToVlan,
  deleteDeviceVlan,
  getDeviceChassisPorts,
  getDeviceVlanDatabase,
  upsertDeviceVlan,
} from '../network/hardwareChassis';
import {
  CheckSquare,
  Cpu,
  Globe,
  GripHorizontal,
  Layers,
  Minus,
  Plus,
  Power,
  ShieldCheck,
  SlidersHorizontal,
  Square,
  Table2,
  Terminal,
  Trash2,
  X,
} from 'lucide-react';

interface FloatingSwitchWebGuiProps {
  node: NetworkNode;
  allNodes: NetworkNode[];
  allLinks: NetworkLink[];
  activeStep: SimulationStep | null;
  onSelectNode: (nodeId: string) => void;
  onUpdateNode: (updatedNode: NetworkNode) => void;
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
  onOpenChassis,
  onOpenFloatingCli,
  onCreateZoneFromVlan,
  onClose,
}) => {
  const [activeTab, setActiveTab] = useState<'ports' | 'vlans' | 'mac'>('ports');
  const [position, setPosition] = useState<{ x: number; y: number }>({
    x: 290,
    y: 118,
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
  const [statusToast, setStatusToast] = useState<string | null>(null);

  useEffect(() => {
    setSelectedPortIds([]);
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

  const switchableNodes = [...allNodes].sort((a, b) => {
    const order = { switch: 0, router: 1, server: 2, pc: 3 };
    return order[a.type] - order[b.type];
  });

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
    onUpdateNode(updated);
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
    onUpdateNode({
      ...node,
      interfaces: updatedInterfaces,
    });
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
    setStatusToast(`Добавлен новый порт ${updated.interfaces[updated.interfaces.length - 1]?.shortName || ''}`);
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
    onUpdateNode(updated);
    setBulkVlanId(parsedId);
    setStatusToast(`VLAN ${parsedId} (${newVlanName || `VLAN${parsedId}`}) сохранён в базе коммутатора`);
    // Suggest next VLAN ID
    const nextSuggested = parsedId + 10 <= 4094 ? parsedId + 10 : parsedId + 1;
    setNewVlanId(String(nextSuggested));
    setNewVlanName(`VLAN${String(nextSuggested).padStart(4, '0')}`);
  };

  const handleQuickPresetVlan = (id: number, name: string, subnetHint: string) => {
    const updated = upsertDeviceVlan(node, id, name, subnetHint, true);
    onUpdateNode(updated);
    setBulkVlanId(id);
    setStatusToast(`Добавлен стандартный сегмент VLAN ${id} (${name})`);
  };

  const handleDeleteVlan = (vlanId: number) => {
    if (vlanId === 1) return;
    const updated = deleteDeviceVlan(node, vlanId);
    onUpdateNode(updated);
    setStatusToast(`VLAN ${vlanId} удалён. Порты этого VLAN возвращены в VLAN 1.`);
  };

  const handleTogglePortInVlanCard = (iface: NetworkInterface, vlanId: number) => {
    if (iface.vlanMode === 'trunk') {
      handleToggleTrunkAllowedVlan(iface, vlanId);
      return;
    }
    const nextVlan = iface.accessVlan === vlanId && vlanId !== 1 ? 1 : vlanId;
    const updated = assignPortsToVlan(node, [iface.id], nextVlan, 'access');
    onUpdateNode(updated);
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
      className="fixed z-45 w-[680px] max-w-[96vw] rounded-lg bg-slate-950/98 border-2 border-indigo-500/60 shadow-[0_22px_55px_rgba(0,0,0,0.88)] select-none overflow-hidden flex flex-col"
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

          <span className="hidden sm:inline text-[10px] font-mono text-slate-500 truncate">
            https://{node.name.toLowerCase()}.netpulse.local/vlan-ports
          </span>
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
        <>
          {/* Sub-Navigation Bar: Tabs + Summary Counters */}
          <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5 bg-slate-900/75 border-b border-slate-800">
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setActiveTab('ports')}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition-colors cursor-pointer ${
                  activeTab === 'ports'
                    ? 'bg-indigo-600 text-white shadow-xs'
                    : 'text-slate-300 hover:text-white hover:bg-slate-800'
                }`}
              >
                <SlidersHorizontal className="w-3.5 h-3.5" />
                <span>Настройка портов ({node.interfaces.length})</span>
              </button>

              <button
                type="button"
                onClick={() => setActiveTab('vlans')}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition-colors cursor-pointer ${
                  activeTab === 'vlans'
                    ? 'bg-indigo-600 text-white shadow-xs'
                    : 'text-slate-300 hover:text-white hover:bg-slate-800'
                }`}
              >
                <Layers className="w-3.5 h-3.5" />
                <span>База VLAN ({vlanDb.length})</span>
              </button>

              <button
                type="button"
                onClick={() => setActiveTab('mac')}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition-colors cursor-pointer ${
                  activeTab === 'mac'
                    ? 'bg-indigo-600 text-white shadow-xs'
                    : 'text-slate-300 hover:text-white hover:bg-slate-800'
                }`}
              >
                <Table2 className="w-3.5 h-3.5" />
                <span>MAC-таблица ({node.macTable.length})</span>
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
                onClick={handleAddHardwarePort}
                className="flex items-center gap-1 px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 text-[11px] font-mono text-sky-300 transition-colors cursor-pointer"
              >
                <Plus className="w-3 h-3" />
                <span>Добавить порт</span>
              </button>
            </div>
          </div>

          {/* Main Scrollable Content Area */}
          <div className="max-h-[430px] overflow-y-auto p-3 space-y-3">
            {/* TAB 1: SWITCH PORT CONFIGURATION & 802.1Q VLAN ASSIGNMENT */}
            {activeTab === 'ports' && (
              <>
                {/* Bulk Assignment Toolbar */}
                <div className="p-2 rounded-md bg-slate-900/90 border border-slate-800 flex flex-wrap items-center justify-between gap-2 text-xs">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={handleSelectAllAccessPorts}
                      className="flex items-center gap-1.5 px-2 py-1 rounded bg-slate-950 hover:bg-slate-800 border border-slate-700 text-[11px] text-slate-200 transition-colors cursor-pointer"
                    >
                      {selectedPortIds.length > 0 ? (
                        <CheckSquare className="w-3.5 h-3.5 text-indigo-400" />
                      ) : (
                        <Square className="w-3.5 h-3.5 text-slate-400" />
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
                        className="text-[11px] text-slate-400 hover:text-slate-200 underline cursor-pointer"
                      >
                        Сбросить
                      </button>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[11px] text-slate-400">Групповое действие:</span>
                    <select
                      aria-label="Групповой режим назначения VLAN"
                      value={bulkOperation}
                      onChange={(e) =>
                        setBulkOperation(e.target.value as 'access' | 'trunk-add')
                      }
                      className="px-2 py-1 rounded bg-slate-950 border border-slate-700 text-[11px] font-mono text-slate-200"
                    >
                      <option value="access">Access (Untagged) →</option>
                      <option value="trunk-add">802.1Q Trunk (+VLAN) →</option>
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
                      className={`px-2.5 py-1 rounded text-[11px] font-medium transition-colors ${
                        selectedPortIds.length > 0
                          ? 'bg-indigo-600 hover:bg-indigo-500 text-white cursor-pointer'
                          : 'bg-slate-800 text-slate-500 cursor-not-allowed'
                      }`}
                    >
                      Применить к выбранным
                    </button>
                  </div>
                </div>

                {/* Port Configuration Table */}
                <div className="rounded-md border border-slate-800 overflow-hidden bg-slate-950">
                  <table className="w-full table-fixed text-left border-collapse text-xs">
                    <thead>
                      <tr className="bg-slate-900/95 border-b border-slate-800 text-[10px] font-mono uppercase text-slate-400">
                        <th className="py-2 px-2 w-8 text-center">Выб</th>
                        <th className="py-2 px-2 w-28">Порт</th>
                        <th className="py-2 px-2 w-36">Питание / Линк</th>
                        <th className="py-2 px-2 w-28">Режим L2</th>
                        <th className="py-2 px-2.5">Привязка к VLAN (Access / 802.1Q)</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/70">
                      {portDescriptors.map((desc) => {
                        const { port, peerNode, peerPort } = desc;
                        const isChecked = selectedPortIds.includes(port.id);

                        return (
                          <tr
                            key={port.id}
                            className={`transition-colors ${
                              isChecked ? 'bg-indigo-950/30' : 'hover:bg-slate-900/60'
                            }`}
                          >
                            {/* Checkbox */}
                            <td className="py-1.5 px-2 text-center">
                              <input
                                type="checkbox"
                                aria-label={`Выбрать порт ${port.shortName}`}
                                checked={isChecked}
                                onChange={() => handleToggleSelectPort(port.id)}
                                className="rounded border-slate-700 bg-slate-900 text-indigo-500 focus:ring-0 cursor-pointer"
                              />
                            </td>

                            {/* Port Name & Speed */}
                            <td className="py-1.5 px-2 font-mono truncate">
                              <div className="font-semibold text-slate-100 flex items-center gap-1">
                                <span>{port.shortName}</span>
                                {desc.isUplink && (
                                  <span className="px-1 py-0.2 text-[9px] rounded bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
                                    1G
                                  </span>
                                )}
                              </div>
                              <div className="text-[9px] text-slate-500 truncate">
                                {port.macAddress}
                              </div>
                            </td>

                            {/* Admin Power + Connected Peer */}
                            <td className="py-1.5 px-2">
                              <div className="flex items-center gap-1.5 min-w-0">
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
                                  <span className="text-[10px] font-mono text-sky-300 truncate">
                                    {peerNode.name}:{peerPort?.shortName}
                                  </span>
                                ) : (
                                  <span className="text-[10px] font-mono text-slate-500 truncate">
                                    Свободен
                                  </span>
                                )}
                              </div>
                            </td>

                            {/* L2 Mode (Access / Trunk) */}
                            <td className="py-1.5 px-2">
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

                            {/* VLAN Assignment Cell */}
                            <td className="py-1.5 px-2.5">
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
                                    onUpdateNode(updated);
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
                                <div className="space-y-1">
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

            {/* TAB 3: SWITCH MAC ADDRESS TABLE (CAM) */}
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

                <div className="rounded-md border border-slate-800 overflow-hidden bg-slate-950">
                  <table className="w-full text-left border-collapse text-xs font-mono">
                    <thead>
                      <tr className="bg-slate-900 border-b border-slate-800 text-[10px] uppercase text-slate-400">
                        <th className="py-2 px-3">VLAN</th>
                        <th className="py-2 px-3">MAC-адрес</th>
                        <th className="py-2 px-3">Тип записи</th>
                        <th className="py-2 px-3">Интерфейс</th>
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
                            <td className="py-1.5 px-3 text-indigo-300 font-semibold">
                              VLAN {entry.vlan}
                            </td>
                            <td className="py-1.5 px-3 text-slate-200">{entry.macAddress}</td>
                            <td className="py-1.5 px-3 text-emerald-400">{entry.type}</td>
                            <td className="py-1.5 px-3 text-sky-300">{entry.portName}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
};
