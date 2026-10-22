import React, { useState, useRef, useEffect } from 'react';
import {
  DhcpPool,
  DnsRecord,
  HttpResponseResult,
  NetworkInterface,
  NetworkLink,
  NetworkNode,
  NetworkZone,
  SimulationStep,
  TracerouteHop,
  ZoneColor,
} from '../network/types';
import { autocompleteIosCommand, executeIosCommand, getCliPrompt } from '../network/cliParser';
import { getDeviceVlanDatabase } from '../network/hardwareChassis';
import { isValidIpv4, isValidSubnetMask } from '../network/ipMath';
import { syncConnectedRoutes } from '../network/simulator';
import { createDefaultServices } from '../network/presets';
import {
  Terminal,
  Settings2,
  Table2,
  Plus,
  Trash2,
  Send,
  Power,
  Cpu,
  Globe,
  RefreshCw,
  Route,
  Server,
  Layers,
  Pencil,
  PanelRightClose,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';

interface DeviceInspectorPanelProps {
  node: NetworkNode | null;
  selectedZone: NetworkZone | null;
  allNodes: NetworkNode[];
  allLinks: NetworkLink[];
  allZones: NetworkZone[];
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  onUpdateNode: (updatedNode: NetworkNode) => void;
  onUpdateAllNodes: (updatedNodes: NetworkNode[]) => void;
  onSelectZone: (zoneId: string | null) => void;
  onUpdateZone: (updatedZone: NetworkZone) => void;
  onDeleteZone: (zoneId: string) => void;
  onAddZone: () => void;
  onTriggerPingSimulation: (sourceNodeId: string, targetIp: string, mode?: 'ICMP' | 'TCP') => void;
  onTriggerDhcpSimulation: (clientNodeId: string) => void;
  onTriggerTracerouteSimulation: (
    sourceNodeId: string,
    targetHostOrIp: string
  ) => TracerouteHop[];
  onTriggerHttpSimulation: (
    clientNodeId: string,
    urlOrHost: string
  ) => { success: boolean; httpResult?: HttpResponseResult; message: string };
  onLoadSimulationSteps: (steps: SimulationStep[], summaryMessage: string) => void;
  onOpenFloatingCli: (nodeId: string) => void;
  onOpenChassis: (nodeId: string) => void;
  onOpenWebGui: (nodeId: string) => void;
}

const ZONE_COLOR_OPTIONS: { id: ZoneColor; label: string; dot: string }[] = [
  { id: 'sky', label: 'Sky (Синий)', dot: 'bg-sky-500' },
  { id: 'emerald', label: 'Emerald (Зелёный)', dot: 'bg-emerald-500' },
  { id: 'amber', label: 'Amber (Жёлтый)', dot: 'bg-amber-500' },
  { id: 'indigo', label: 'Indigo (Индиго)', dot: 'bg-indigo-500' },
  { id: 'purple', label: 'Purple (Фиолетовый)', dot: 'bg-purple-500' },
  { id: 'rose', label: 'Rose (Красный)', dot: 'bg-rose-500' },
];

export const DeviceInspectorPanel: React.FC<DeviceInspectorPanelProps> = ({
  node,
  selectedZone,
  allNodes,
  allLinks,
  allZones,
  isCollapsed,
  onToggleCollapse,
  onUpdateNode,
  onUpdateAllNodes,
  onSelectZone,
  onUpdateZone,
  onDeleteZone,
  onAddZone,
  onTriggerPingSimulation,
  onTriggerDhcpSimulation,
  onTriggerTracerouteSimulation,
  onTriggerHttpSimulation,
  onLoadSimulationSteps,
  onOpenFloatingCli,
  onOpenChassis,
  onOpenWebGui,
}) => {
  const [activeTab, setActiveTab] = useState<'config' | 'apps' | 'cli' | 'tables'>('config');
  const [cliInput, setCliInput] = useState('');
  const [historyCursor, setHistoryCursor] = useState<number>(-1);
  const [cliSuggestions, setCliSuggestions] = useState<string[]>([]);
  const [newRouteNet, setNewRouteNet] = useState('');
  const [newRouteMask, setNewRouteMask] = useState('255.255.255.0');
  const [newRouteHop, setNewRouteHop] = useState('');
  const [routeError, setRouteError] = useState<string | null>(null);
  const [showAddRouteForm, setShowAddRouteForm] = useState(false);
  const [expandedVlanPortIds, setExpandedVlanPortIds] = useState<Record<string, boolean>>({});
  const [quickPingTarget, setQuickPingTarget] = useState('');

  // L7 Browser & Traceroute State (for PC / Host)
  const [browserUrl, setBrowserUrl] = useState('http://app.corp.local/index.html');
  const [browserResponse, setBrowserResponse] = useState<HttpResponseResult | null>(null);
  const [browserError, setBrowserError] = useState<string | null>(null);

  const [traceTarget, setTraceTarget] = useState('192.168.2.100');
  const [traceHops, setTraceHops] = useState<TracerouteHop[]>([]);

  // L7 Server DNS / DHCP form state
  const [newDnsDomain, setNewDnsDomain] = useState('');
  const [newDnsIp, setNewDnsIp] = useState('');
  const [newPoolName, setNewPoolName] = useState('CORP_POOL');
  const [newPoolNet, setNewPoolNet] = useState('192.168.1.0');
  const [newPoolMask, setNewPoolMask] = useState('255.255.255.0');
  const [newPoolGw, setNewPoolGw] = useState('192.168.1.1');
  const [newPoolDns, setNewPoolDns] = useState('192.168.2.100');
  const [newPoolStart, setNewPoolStart] = useState('192.168.1.50');
  const [newPoolEnd, setNewPoolEnd] = useState('192.168.1.150');

  const terminalEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (activeTab === 'cli') {
      terminalEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [node?.cli.history, activeTab]);

  if (isCollapsed) {
    return null;
  }

  if (selectedZone) {
    return (
      <aside
        aria-label="Инспектор визуальной зоны подсети"
        className="w-[380px] border-l border-slate-800 bg-slate-900 flex flex-col h-full shrink-0 select-none"
      >
        <div className="px-4 py-2.5 border-b border-slate-800 bg-slate-900 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <Layers className="w-4 h-4 text-sky-400 shrink-0" />
            <h2 className="text-sm font-semibold text-slate-100 truncate">
              Зона подсети / VLAN
            </h2>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => onSelectZone(null)}
              className="px-2 py-1 text-xs text-slate-300 hover:text-white bg-slate-800 rounded"
            >
              К узлам
            </button>
            <button
              type="button"
              onClick={onToggleCollapse}
              title="Свернуть правую панель"
              aria-label="Свернуть правую панель"
              className="p-1.5 rounded text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
            >
              <PanelRightClose className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-5">
          {/* Primary Zone Attributes */}
          <div className="p-3.5 rounded-md bg-slate-950 border border-slate-800 space-y-3">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                Название зоны / отдела (Title)
              </label>
              <input
                type="text"
                aria-label="Название зоны подсети в инспекторе"
                value={selectedZone.title}
                onChange={(e) => onUpdateZone({ ...selectedZone, title: e.target.value })}
                placeholder="VLAN 10 — Sales & Office LAN"
                className="w-full px-3 py-1.5 text-xs font-medium bg-slate-900 border border-slate-700 rounded-md text-slate-100 focus:outline-none focus:border-sky-500"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                Подсеть / VLAN аннотация (Subnet Badge)
              </label>
              <input
                type="text"
                aria-label="Подсеть или аннотация зоны в инспекторе"
                value={selectedZone.subnetLabel}
                onChange={(e) => onUpdateZone({ ...selectedZone, subnetLabel: e.target.value })}
                placeholder="Подсеть 192.168.1.0/24 · Gateway .1"
                className="w-full px-3 py-1.5 text-xs font-mono bg-slate-900 border border-slate-700 rounded-md text-sky-300 focus:outline-none focus:border-sky-500"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                Цветовое выделение зоны
              </label>
              <div className="grid grid-cols-2 gap-1.5">
                {ZONE_COLOR_OPTIONS.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => onUpdateZone({ ...selectedZone, color: c.id })}
                    className={`flex items-center gap-2 px-2.5 py-1.5 rounded border text-xs transition-colors ${
                      selectedZone.color === c.id
                        ? 'bg-sky-500/20 border-sky-400 text-white font-medium'
                        : 'bg-slate-900 border-slate-800 text-slate-300 hover:bg-slate-800'
                    }`}
                  >
                    <span className={`w-3 h-3 rounded-full shrink-0 ${c.dot}`} />
                    <span className="truncate">{c.label}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Zone Dimensions & Coordinates */}
          <div className="p-3.5 rounded-md bg-slate-950 border border-slate-800 space-y-3">
            <div className="text-xs font-semibold text-slate-200">
              Размеры и расположение на холсте (px)
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">Ширина (Width)</label>
                <input
                  type="number"
                  min={160}
                  max={1400}
                  step={10}
                  value={selectedZone.width}
                  onChange={(e) =>
                    onUpdateZone({
                      ...selectedZone,
                      width: Math.max(160, Number(e.target.value) || 160),
                    })
                  }
                  className="w-full px-2.5 py-1 text-xs font-mono bg-slate-900 border border-slate-700 rounded text-slate-100"
                />
              </div>
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">Высота (Height)</label>
                <input
                  type="number"
                  min={110}
                  max={1000}
                  step={10}
                  value={selectedZone.height}
                  onChange={(e) =>
                    onUpdateZone({
                      ...selectedZone,
                      height: Math.max(110, Number(e.target.value) || 110),
                    })
                  }
                  className="w-full px-2.5 py-1 text-xs font-mono bg-slate-900 border border-slate-700 rounded text-slate-100"
                />
              </div>
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">Позиция X</label>
                <input
                  type="number"
                  step={10}
                  value={selectedZone.x}
                  onChange={(e) =>
                    onUpdateZone({
                      ...selectedZone,
                      x: Math.max(10, Number(e.target.value) || 10),
                    })
                  }
                  className="w-full px-2.5 py-1 text-xs font-mono bg-slate-900 border border-slate-700 rounded text-slate-100"
                />
              </div>
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">Позиция Y</label>
                <input
                  type="number"
                  step={10}
                  value={selectedZone.y}
                  onChange={(e) =>
                    onUpdateZone({
                      ...selectedZone,
                      y: Math.max(10, Number(e.target.value) || 10),
                    })
                  }
                  className="w-full px-2.5 py-1 text-xs font-mono bg-slate-900 border border-slate-700 rounded text-slate-100"
                />
              </div>
            </div>
            <div className="text-[11px] text-slate-400">
              Совет: перетаскивайте зону мышью за шапку или тяните за правый нижний угол на холсте для изменения размера.
            </div>
          </div>

          {/* All Zones List for Fast Switching */}
          <div className="pt-2 border-t border-slate-800 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-200">
                Все зоны на схеме ({allZones.length})
              </span>
              <button
                type="button"
                onClick={onAddZone}
                className="flex items-center gap-1 px-2 py-1 text-[11px] font-medium bg-sky-600/20 hover:bg-sky-600/30 text-sky-300 border border-sky-500/40 rounded"
              >
                <Plus className="w-3 h-3" />
                <span>Добавить зону</span>
              </button>
            </div>
            <div className="space-y-1.5">
              {allZones.map((z) => (
                <div
                  key={z.id}
                  onClick={() => onSelectZone(z.id)}
                  className={`flex items-center justify-between px-2.5 py-2 rounded border text-xs cursor-pointer transition-colors ${
                    z.id === selectedZone.id
                      ? 'bg-sky-500/15 border-sky-500/50 text-sky-200'
                      : 'bg-slate-950 border-slate-800 text-slate-300 hover:bg-slate-800'
                  }`}
                >
                  <div className="truncate pr-2">
                    <div className="font-medium truncate">{z.title}</div>
                    <div className="text-[10px] font-mono text-slate-400 truncate">
                      {z.subnetLabel}
                    </div>
                  </div>
                  <span
                    className={`text-[10px] font-mono shrink-0 ${
                      z.id === selectedZone.id ? 'text-sky-400 font-semibold' : 'text-slate-400'
                    }`}
                  >
                    {z.id === selectedZone.id ? '● Выбрана' : 'Изменить'}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <button
            type="button"
            onClick={() => onDeleteZone(selectedZone.id)}
            className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium text-red-300 hover:bg-red-950/60 border border-red-800/60 rounded-md transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>Удалить выбранную зону со схемы</span>
          </button>
        </div>
      </aside>
    );
  }

  if (!node) {
    return (
      <aside className="w-[380px] border-l border-slate-800 bg-slate-900/95 flex flex-col justify-between p-4 select-none shrink-0 overflow-y-auto">
        <div>
          <div className="flex items-center justify-between pb-3 border-b border-slate-800">
            <span className="text-xs font-semibold text-slate-300">Инспектор схемы</span>
            <button
              type="button"
              onClick={onToggleCollapse}
              title="Свернуть правую панель"
              aria-label="Свернуть правую панель"
              className="flex items-center gap-1 px-2 py-1 rounded text-xs text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
            >
              <span>Свернуть</span>
              <PanelRightClose className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="flex flex-col items-center text-center py-8">
            <Cpu className="w-9 h-9 text-slate-600 mb-2.5" />
            <h2 className="text-sm font-semibold text-slate-200 mb-1">Узел не выбран</h2>
            <p className="text-xs text-slate-400 leading-relaxed max-w-xs">
              Кликните по любому устройству или зоне на холсте для настройки, либо сверните эту панель, чтобы освободить место.
            </p>
          </div>
        </div>

        {/* Always show Zone Manager list when no node is selected */}
        <div className="p-3 rounded-md bg-slate-950 border border-slate-800 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-200 flex items-center gap-1.5">
              <Layers className="w-3.5 h-3.5 text-sky-400" />
              <span>Зоны подсетей ({allZones.length})</span>
            </span>
            <button
              type="button"
              onClick={onAddZone}
              className="flex items-center gap-1 px-2 py-1 text-[11px] font-medium bg-sky-600 hover:bg-sky-500 text-white rounded"
            >
              <Plus className="w-3 h-3" />
              <span>Новая зона</span>
            </button>
          </div>
          <div className="space-y-1.5">
            {allZones.map((z) => (
              <button
                key={z.id}
                type="button"
                onClick={() => onSelectZone(z.id)}
                className="w-full flex items-center justify-between px-2.5 py-1.5 rounded bg-slate-900 hover:bg-slate-800 border border-slate-800 text-left text-xs transition-colors"
              >
                <div className="min-w-0 pr-2">
                  <div className="font-medium text-slate-100 truncate">{z.title}</div>
                  <div className="text-[10px] font-mono text-slate-400 truncate">{z.subnetLabel}</div>
                </div>
                <span className="inline-flex items-center gap-1 text-[11px] text-sky-400 shrink-0">
                  <Pencil className="w-3 h-3" />
                  <span>Изменить</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      </aside>
    );
  }

  const services = node.services || createDefaultServices(node.type);

  const handleInterfaceChange = (ifaceId: string, patch: Partial<NetworkInterface>) => {
    const updatedInterfaces = node.interfaces.map((iface) =>
      iface.id === ifaceId ? { ...iface, ...patch } : iface
    );
    const updated: NetworkNode = {
      ...node,
      interfaces: updatedInterfaces,
    };
    if (updated.type === 'router') {
      updated.routingTable = syncConnectedRoutes(updated);
    }
    onUpdateNode(updated);
  };

  const handleAddStaticRoute = (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValidIpv4(newRouteNet) || !isValidSubnetMask(newRouteMask) || !isValidIpv4(newRouteHop)) {
      setRouteError('Проверьте корректность IP-сети, маски и адреса Next-Hop.');
      return;
    }
    setRouteError(null);
    const outIface =
      node.interfaces.find((i) => i.adminStatus === 'up' && i.ipAddress)?.shortName ||
      node.interfaces[0]?.shortName ||
      'Fa0/0';
    const updated: NetworkNode = {
      ...node,
      routingTable: syncConnectedRoutes({
        ...node,
        routingTable: [
          ...node.routingTable,
          {
            id: `sr-${Date.now()}`,
            network: newRouteNet.trim(),
            mask: newRouteMask.trim(),
            nextHop: newRouteHop.trim(),
            interfaceName: outIface,
            type: 'S',
          },
        ],
      }),
    };
    onUpdateNode(updated);
    setNewRouteNet('');
    setNewRouteHop('');
  };

  const handleDeleteRoute = (routeId: string) => {
    const updated: NetworkNode = {
      ...node,
      routingTable: node.routingTable.filter((r) => r.id !== routeId),
    };
    onUpdateNode(updated);
  };

  const handleCliSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const res = executeIosCommand(cliInput, node, allNodes, allLinks);
    const updatedWithHistory: NetworkNode = {
      ...res.updatedNode,
      cli: {
        ...res.updatedNode.cli,
        history: [...node.cli.history, ...res.outputLines],
      },
    };

    if (res.updatedAllNodes) {
      const merged = res.updatedAllNodes.map((n) =>
        n.id === updatedWithHistory.id ? updatedWithHistory : n
      );
      onUpdateAllNodes(merged);
    } else {
      onUpdateNode(updatedWithHistory);
    }

    if (res.triggeredSimulationSteps && res.triggeredSummaryMessage) {
      onLoadSimulationSteps(res.triggeredSimulationSteps, res.triggeredSummaryMessage);
    }

    setCliInput('');
    setHistoryCursor(-1);
    setCliSuggestions([]);
  };

  const handleCliKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const { completed, suggestions } = autocompleteIosCommand(cliInput, node);
      setCliInput(completed);
      setCliSuggestions(suggestions.length > 1 ? suggestions : []);
      return;
    }

    const cmdLog = node.cli.commandLog || [];
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (cmdLog.length === 0) return;
      const nextCursor =
        historyCursor === -1 ? cmdLog.length - 1 : Math.max(0, historyCursor - 1);
      setHistoryCursor(nextCursor);
      setCliInput(cmdLog[nextCursor] || '');
      setCliSuggestions([]);
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (cmdLog.length === 0 || historyCursor === -1) return;
      const nextCursor = historyCursor + 1;
      if (nextCursor >= cmdLog.length) {
        setHistoryCursor(-1);
        setCliInput('');
      } else {
        setHistoryCursor(nextCursor);
        setCliInput(cmdLog[nextCursor] || '');
      }
      setCliSuggestions([]);
    }
  };

  const runQuickCliSnippet = (cmd: string) => {
    const res = executeIosCommand(cmd, node, allNodes, allLinks);
    const updatedWithHistory: NetworkNode = {
      ...res.updatedNode,
      cli: {
        ...res.updatedNode.cli,
        history: [...node.cli.history, ...res.outputLines],
      },
    };
    if (res.updatedAllNodes) {
      onUpdateAllNodes(
        res.updatedAllNodes.map((n) => (n.id === updatedWithHistory.id ? updatedWithHistory : n))
      );
    } else {
      onUpdateNode(updatedWithHistory);
    }
    if (res.triggeredSimulationSteps && res.triggeredSummaryMessage) {
      onLoadSimulationSteps(res.triggeredSimulationSteps, res.triggeredSummaryMessage);
    }
  };

  const handleAddDnsRecord = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newDnsDomain.trim() || !isValidIpv4(newDnsIp)) return;
    const newRec: DnsRecord = {
      id: `dns-${Date.now()}`,
      domain: newDnsDomain.trim(),
      ipAddress: newDnsIp.trim(),
    };
    onUpdateNode({
      ...node,
      services: {
        ...services,
        dnsRecords: [...services.dnsRecords, newRec],
      },
    });
    setNewDnsDomain('');
    setNewDnsIp('');
  };

  const handleDeleteDnsRecord = (id: string) => {
    onUpdateNode({
      ...node,
      services: {
        ...services,
        dnsRecords: services.dnsRecords.filter((r) => r.id !== id),
      },
    });
  };

  const handleAddDhcpPool = (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValidIpv4(newPoolNet) || !isValidSubnetMask(newPoolMask) || !isValidIpv4(newPoolStart)) return;
    const pool: DhcpPool = {
      id: `pool-${Date.now()}`,
      poolName: newPoolName.trim() || 'LAN_POOL',
      network: newPoolNet.trim(),
      mask: newPoolMask.trim(),
      defaultRouter: newPoolGw.trim(),
      dnsServer: newPoolDns.trim(),
      startIp: newPoolStart.trim(),
      endIp: newPoolEnd.trim(),
    };
    onUpdateNode({
      ...node,
      services: {
        ...services,
        dhcpEnabled: true,
        dhcpPools: [...services.dhcpPools, pool],
      },
    });
  };

  const handleDeleteDhcpPool = (id: string) => {
    onUpdateNode({
      ...node,
      services: {
        ...services,
        dhcpPools: services.dhcpPools.filter((p) => p.id !== id),
      },
    });
  };

  const handleBrowserSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const res = onTriggerHttpSimulation(node.id, browserUrl);
    if (res.success && res.httpResult) {
      setBrowserResponse(res.httpResult);
      setBrowserError(null);
    } else {
      setBrowserResponse(null);
      setBrowserError(res.message);
    }
  };

  const handleTracerouteSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!traceTarget.trim()) return;
    const hops = onTriggerTracerouteSimulation(node.id, traceTarget.trim());
    setTraceHops(hops);
  };

  const otherHostIps = allNodes
    .filter((n) => n.id !== node.id)
    .flatMap((n) =>
      n.interfaces
        .filter((i) => i.adminStatus === 'up' && isValidIpv4(i.ipAddress))
        .map((i) => ({ label: `${n.name} (${i.ipAddress})`, ip: i.ipAddress }))
    );

  return (
    <aside className="w-[385px] border-l border-slate-800 bg-slate-900 flex flex-col h-full shrink-0 select-none">
      {/* Node Header with Collapse & Quick Zones Switcher */}
      <div className="px-3.5 py-2.5 border-b border-slate-800 space-y-2 bg-slate-900">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 min-w-0">
            <h2 className="text-sm font-semibold text-slate-100 whitespace-nowrap truncate">
              {node.name}
            </h2>
            <span className="text-[10px] text-slate-400 font-mono whitespace-nowrap shrink-0">
              · {node.type.toUpperCase()}
            </span>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={() => onOpenChassis(node.id)}
              title="Открыть переднюю панель портов 1U в плавающем окне"
              className="flex items-center gap-1 px-1.5 py-1 rounded bg-sky-950/80 hover:bg-sky-900 border border-sky-500/40 text-[10px] font-mono text-sky-300 transition-colors cursor-pointer"
            >
              <Cpu className="w-3 h-3" />
              <span>1U</span>
            </button>
            <button
              type="button"
              onClick={() => onOpenWebGui(node.id)}
              title="Открыть плавающий Веб-интерфейс коммутатора (настройка портов и базы VLAN)"
              className="flex items-center gap-1 px-1.5 py-1 rounded bg-indigo-950/80 hover:bg-indigo-900 border border-indigo-500/40 text-[10px] font-mono text-indigo-300 transition-colors cursor-pointer"
            >
              <Globe className="w-3 h-3" />
              <span>WEB</span>
            </button>
            <button
              type="button"
              onClick={() => onOpenFloatingCli(node.id)}
              title="Открыть консоль CLI этого устройства в плавающем окне"
              className="flex items-center gap-1 px-1.5 py-1 rounded bg-emerald-950/80 hover:bg-emerald-900 border border-emerald-500/40 text-[10px] font-mono text-emerald-300 transition-colors cursor-pointer"
            >
              <Terminal className="w-3 h-3" />
              <span>CLI</span>
            </button>
            {allZones.length > 0 && (
              <button
                type="button"
                onClick={() => onSelectZone(allZones[0].id)}
                title="Перейти к редактированию цветных зон подсетей"
                className="flex items-center gap-1 px-1.5 py-1 rounded bg-slate-950 hover:bg-slate-800 border border-slate-800 text-[10px] text-sky-300 transition-colors"
              >
                <Layers className="w-3 h-3" />
                <span>Зоны</span>
              </button>
            )}
            <button
              type="button"
              onClick={onToggleCollapse}
              title="Свернуть правую панель инспектора"
              aria-label="Свернуть правую панель"
              className="p-1 rounded text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
            >
              <PanelRightClose className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Segmented Control Tabs (4 tabs: Порты, L4-L7, IOS CLI, Таблицы) */}
        <div className="grid grid-cols-4 gap-1 p-1 bg-slate-950 border border-slate-800 rounded-md">
          <button
            onClick={() => setActiveTab('config')}
            className={`flex items-center justify-center gap-1 px-2 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
              activeTab === 'config'
                ? 'bg-slate-800 text-sky-300 shadow-xs'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Settings2 className="w-3.5 h-3.5" />
            <span>Порты</span>
          </button>
          <button
            onClick={() => setActiveTab('apps')}
            className={`flex items-center justify-center gap-1 px-2 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
              activeTab === 'apps'
                ? 'bg-slate-800 text-sky-300 shadow-xs'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Globe className="w-3.5 h-3.5" />
            <span>L4–L7</span>
          </button>
          <button
            onClick={() => setActiveTab('cli')}
            className={`flex items-center justify-center gap-1 px-2 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
              activeTab === 'cli'
                ? 'bg-slate-800 text-sky-300 shadow-xs'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Terminal className="w-3.5 h-3.5" />
            <span>IOS CLI</span>
          </button>
          <button
            onClick={() => setActiveTab('tables')}
            className={`flex items-center justify-center gap-1 px-2 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
              activeTab === 'tables'
                ? 'bg-slate-800 text-sky-300 shadow-xs'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Table2 className="w-3.5 h-3.5" />
            <span>Таблицы</span>
          </button>
        </div>
      </div>

      {/* Tab Content */}
      <div className="flex-1 overflow-y-auto p-3.5 space-y-4">
        {activeTab === 'config' && (
          <>
            {/* Compact Identity & Quick Ping Card */}
            <div className="p-3 rounded-md bg-slate-950/90 border border-slate-800 space-y-2.5">
              <div className="flex items-center gap-2">
                <label className="text-xs font-medium text-slate-400 w-20 shrink-0">
                  Hostname:
                </label>
                <input
                  type="text"
                  value={node.name}
                  onChange={(e) => onUpdateNode({ ...node, name: e.target.value })}
                  className="flex-1 px-2.5 py-1 text-xs font-mono bg-slate-900 border border-slate-700 rounded text-slate-100 focus:outline-none focus:border-sky-500"
                />
              </div>

              {(node.type === 'pc' || node.type === 'server') && (
                <>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-[11px] text-slate-400 mb-0.5">
                        Шлюз (Gateway)
                      </label>
                      <input
                        type="text"
                        placeholder="192.168.1.1"
                        value={node.defaultGateway}
                        onChange={(e) => onUpdateNode({ ...node, defaultGateway: e.target.value })}
                        className="w-full px-2 py-1 text-xs font-mono bg-slate-900 border border-slate-700 rounded text-slate-100 focus:outline-none focus:border-sky-500"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] text-slate-400 mb-0.5">
                        DNS-сервер
                      </label>
                      <input
                        type="text"
                        placeholder="192.168.2.100"
                        value={node.dnsServer || ''}
                        onChange={(e) => onUpdateNode({ ...node, dnsServer: e.target.value })}
                        className="w-full px-2 py-1 text-xs font-mono bg-slate-900 border border-slate-700 rounded text-slate-100 focus:outline-none focus:border-sky-500"
                      />
                    </div>
                  </div>

                  <div className="flex items-center justify-between pt-1">
                    <div className="flex items-center gap-1 p-0.5 bg-slate-900 border border-slate-800 rounded">
                      <button
                        onClick={() => onUpdateNode({ ...node, ipAssignmentMode: 'static' })}
                        className={`px-2 py-0.5 text-[11px] font-medium rounded transition-colors ${
                          (node.ipAssignmentMode || 'static') === 'static'
                            ? 'bg-slate-800 text-sky-300'
                            : 'text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        Static
                      </button>
                      <button
                        onClick={() => {
                          onUpdateNode({ ...node, ipAssignmentMode: 'dhcp' });
                          onTriggerDhcpSimulation(node.id);
                        }}
                        className={`px-2 py-0.5 text-[11px] font-medium rounded transition-colors ${
                          node.ipAssignmentMode === 'dhcp'
                            ? 'bg-emerald-600/30 text-emerald-300'
                            : 'text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        DHCP
                      </button>
                    </div>

                    <button
                      onClick={() => onTriggerDhcpSimulation(node.id)}
                      className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-300 border border-emerald-500/40 rounded transition-colors whitespace-nowrap shrink-0"
                    >
                      <RefreshCw className="w-3 h-3" />
                      <span>Запросить DHCP (DORA)</span>
                    </button>
                  </div>
                </>
              )}

              {/* Quick Ping Row inside Top Card */}
              {node.type !== 'switch' && (
                <div className="pt-2 border-t border-slate-800/80 flex items-center gap-1.5">
                  <select
                    aria-label="Выбрать целевой IP для отправки пакета"
                    value={quickPingTarget}
                    onChange={(e) => setQuickPingTarget(e.target.value)}
                    className="flex-1 min-w-0 px-2 py-1 text-xs font-mono bg-slate-900 border border-slate-700 rounded text-slate-200 focus:outline-none focus:border-sky-500"
                  >
                    <option value="">Быстрый Ping к узлу...</option>
                    {otherHostIps.map((item) => (
                      <option key={item.ip} value={item.ip}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={() => {
                      const target = quickPingTarget || otherHostIps[0]?.ip;
                      if (target) onTriggerPingSimulation(node.id, target, 'ICMP');
                    }}
                    className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium bg-sky-600 hover:bg-sky-500 text-white rounded transition-colors whitespace-nowrap shrink-0"
                  >
                    <Send className="w-3 h-3" />
                    <span>Ping</span>
                  </button>
                </div>
              )}
            </div>

            {/* Streamlined Network Interfaces List (Switch ports managed via Floating Web GUI) */}
            {node.type === 'switch' ? (
              <div className="space-y-3">
                <div className="p-3 rounded-md bg-indigo-950/25 border border-indigo-500/40 space-y-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-indigo-200 flex items-center gap-1.5">
                      <Globe className="w-3.5 h-3.5 text-indigo-400" />
                      <span>Веб-интерфейс коммутатора (Порты и VLAN)</span>
                    </span>
                    <span className="text-[10px] font-mono text-indigo-300">
                      {getDeviceVlanDatabase(node).length} VLAN
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-300 leading-relaxed">
                    Настройка режимов портов (Access / 802.1Q Trunk), групповая привязка портов и создание новых VLAN вынесены в отдельное плавающее окно веб-интерфейса.
                  </p>
                  <div className="grid grid-cols-2 gap-1.5 pt-0.5">
                    <button
                      type="button"
                      onClick={() => onOpenWebGui(node.id)}
                      className="flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded bg-indigo-600 hover:bg-indigo-500 text-xs font-medium text-white shadow-xs transition-colors cursor-pointer"
                    >
                      <Globe className="w-3.5 h-3.5" />
                      <span>Веб-интерфейс VLAN</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => onOpenChassis(node.id)}
                      className="flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded bg-slate-900 hover:bg-slate-800 border border-sky-500/40 text-xs font-medium text-sky-300 transition-colors cursor-pointer"
                    >
                      <Cpu className="w-3.5 h-3.5" />
                      <span>Панель 1U (RJ-45)</span>
                    </button>
                  </div>
                </div>

                {/* Compact Read-Only / Quick-Power Summary of Switch Ports */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs font-semibold text-slate-300">
                    <span>Сводка портов ({node.interfaces.length})</span>
                    <button
                      type="button"
                      onClick={() => onOpenWebGui(node.id)}
                      className="text-[11px] font-mono text-indigo-300 hover:text-indigo-200 underline cursor-pointer"
                    >
                      Изменить VLAN →
                    </button>
                  </div>
                  {node.interfaces.map((iface) => (
                    <div
                      key={iface.id}
                      className="px-2.5 py-1.5 rounded bg-slate-950/90 border border-slate-800 flex items-center justify-between gap-2 text-xs"
                    >
                      <div className="flex items-center gap-2 min-w-0 font-mono">
                        <span className="font-semibold text-slate-100">{iface.shortName}</span>
                        <span
                          className={`px-1.5 py-0.5 rounded text-[10px] border ${
                            iface.vlanMode === 'trunk'
                              ? 'bg-indigo-950/80 border-indigo-500/40 text-indigo-300'
                              : 'bg-slate-900 border-slate-800 text-sky-300'
                          }`}
                        >
                          {iface.vlanMode === 'trunk'
                            ? `Trunk (${iface.trunkAllowedVlans.join(',')})`
                            : `VLAN ${iface.accessVlan}`}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() =>
                          handleInterfaceChange(iface.id, {
                            adminStatus: iface.adminStatus === 'up' ? 'down' : 'up',
                          })
                        }
                        className={`inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-mono rounded border transition-colors cursor-pointer ${
                          iface.adminStatus === 'up'
                            ? 'bg-emerald-950/60 border-emerald-700/60 text-emerald-300'
                            : 'bg-red-950/60 border-red-800/60 text-red-300'
                        }`}
                      >
                        <Power className="w-2.5 h-2.5" />
                        <span>{iface.adminStatus === 'up' ? 'UP' : 'SHUT'}</span>
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="text-xs font-semibold text-slate-300">
                  Интерфейсы ({node.interfaces.length})
                </div>

                {node.interfaces.map((iface) => {
                  const showVlanControls = Boolean(expandedVlanPortIds[iface.id]);

                  return (
                    <div
                      key={iface.id}
                      className="p-2.5 rounded-md bg-slate-950/90 border border-slate-800 space-y-2"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-xs font-semibold font-mono text-slate-100">
                            {iface.shortName}
                          </span>
                          <span className="text-[10px] text-slate-500 font-mono truncate">
                            {iface.macAddress}
                          </span>
                        </div>

                        <div className="flex items-center gap-1.5 shrink-0">
                          <button
                            type="button"
                            onClick={() =>
                              setExpandedVlanPortIds((prev) => ({
                                ...prev,
                                [iface.id]: !prev[iface.id],
                              }))
                            }
                            className="px-1.5 py-0.5 text-[10px] font-mono rounded bg-slate-900 hover:bg-slate-800 text-slate-400 border border-slate-800"
                          >
                            VLAN {iface.accessVlan} {showVlanControls ? '▴' : '▾'}
                          </button>
                          <button
                            onClick={() =>
                              handleInterfaceChange(iface.id, {
                                adminStatus: iface.adminStatus === 'up' ? 'down' : 'up',
                              })
                            }
                            className={`inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-mono rounded border transition-colors whitespace-nowrap shrink-0 ${
                              iface.adminStatus === 'up'
                                ? 'bg-emerald-950/60 border-emerald-700/60 text-emerald-300'
                                : 'bg-red-950/60 border-red-800/60 text-red-300'
                            }`}
                          >
                            <Power className="w-2.5 h-2.5" />
                            <span>{iface.adminStatus === 'up' ? 'UP' : 'SHUT'}</span>
                          </button>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-1.5">
                        <div>
                          <label className="block text-[10px] text-slate-400 mb-0.5">IPv4</label>
                          <input
                            type="text"
                            placeholder="192.168.1.10"
                            value={iface.ipAddress}
                            onChange={(e) =>
                              handleInterfaceChange(iface.id, { ipAddress: e.target.value })
                            }
                            className="w-full px-2 py-1 text-xs font-mono bg-slate-900 border border-slate-700 rounded text-slate-100 focus:outline-none focus:border-sky-500"
                          />
                        </div>
                        <div>
                          <label className="block text-[10px] text-slate-400 mb-0.5">Маска</label>
                          <input
                            type="text"
                            placeholder="255.255.255.0"
                            value={iface.subnetMask}
                            onChange={(e) =>
                              handleInterfaceChange(iface.id, { subnetMask: e.target.value })
                            }
                            className="w-full px-2 py-1 text-xs font-mono bg-slate-900 border border-slate-700 rounded text-slate-100 focus:outline-none focus:border-sky-500"
                          />
                        </div>
                      </div>

                      {showVlanControls && (
                        <div className="grid grid-cols-2 gap-1.5 pt-1 border-t border-slate-800/60">
                          <div>
                            <label className="block text-[10px] text-slate-400 mb-0.5">
                              Режим L2
                            </label>
                            <select
                              value={iface.vlanMode}
                              onChange={(e) =>
                                handleInterfaceChange(iface.id, {
                                  vlanMode: e.target.value as 'access' | 'trunk',
                                })
                              }
                              className="w-full px-2 py-1 text-xs font-mono bg-slate-900 border border-slate-700 rounded text-slate-200 focus:outline-none focus:border-sky-500"
                            >
                              <option value="access">Access</option>
                              <option value="trunk">802.1Q Trunk</option>
                            </select>
                          </div>

                          {iface.vlanMode === 'access' ? (
                            <div>
                              <label className="block text-[10px] text-slate-400 mb-0.5">
                                Access VLAN
                              </label>
                              <input
                                type="number"
                                min={1}
                                max={4094}
                                value={iface.accessVlan}
                                onChange={(e) =>
                                  handleInterfaceChange(iface.id, {
                                    accessVlan: Math.max(
                                      1,
                                      Math.min(4094, Number(e.target.value) || 1)
                                    ),
                                  })
                                }
                                className="w-full px-2 py-1 text-xs font-mono bg-slate-900 border border-slate-700 rounded text-slate-100 focus:outline-none focus:border-sky-500"
                              />
                            </div>
                          ) : (
                            <div>
                              <label className="block text-[10px] text-slate-400 mb-0.5">
                                Allowed VLANs
                              </label>
                              <input
                                type="text"
                                value={iface.trunkAllowedVlans.join(',')}
                                onChange={(e) => {
                                  const parsed = e.target.value
                                    .split(',')
                                    .map((s) => Number(s.trim()))
                                    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 4094);
                                  handleInterfaceChange(iface.id, {
                                    trunkAllowedVlans: parsed.length > 0 ? parsed : [1],
                                  });
                                }}
                                className="w-full px-2 py-1 text-xs font-mono bg-slate-900 border border-slate-700 rounded text-slate-100 focus:outline-none focus:border-sky-500"
                              />
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Streamlined Static Routing Configuration for Routers */}
            {node.type === 'router' && (
              <div className="pt-2.5 border-t border-slate-800 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-slate-300">
                    Маршрутизация L3
                  </span>
                  <button
                    type="button"
                    onClick={() => setShowAddRouteForm((v) => !v)}
                    className="flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium bg-slate-800 hover:bg-slate-700 text-sky-300 rounded transition-colors"
                  >
                    <Plus className="w-3 h-3" />
                    <span>{showAddRouteForm ? 'Скрыть форму' : 'Маршрут'}</span>
                  </button>
                </div>

                <div className="space-y-1">
                  {syncConnectedRoutes(node).map((rt) => (
                    <div
                      key={rt.id}
                      className="flex items-center justify-between px-2.5 py-1 rounded bg-slate-950 border border-slate-800 text-xs font-mono"
                    >
                      <div className="truncate">
                        <span
                          className={
                            rt.type === 'C'
                              ? 'text-emerald-400 font-semibold'
                              : 'text-sky-400 font-semibold'
                          }
                        >
                          [{rt.type}]
                        </span>{' '}
                        <span className="text-slate-200">{rt.network}</span>
                        <span className="text-slate-400"> → {rt.nextHop}</span>
                      </div>
                      {rt.type === 'S' && (
                        <button
                          onClick={() => handleDeleteRoute(rt.id)}
                          aria-label={`Удалить маршрут ${rt.network}`}
                          className="text-slate-400 hover:text-red-400 p-0.5"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>

                {showAddRouteForm && (
                  <form
                    onSubmit={handleAddStaticRoute}
                    className="p-2.5 rounded bg-slate-950 border border-slate-800 space-y-2"
                  >
                    <div className="text-[11px] text-slate-400">
                      Статический маршрут (ip route):
                    </div>
                    <div className="grid grid-cols-3 gap-1.5">
                      <input
                        type="text"
                        placeholder="Сеть"
                        value={newRouteNet}
                        onChange={(e) => setNewRouteNet(e.target.value)}
                        className="px-2 py-1 text-xs font-mono bg-slate-900 border border-slate-700 rounded text-slate-100"
                      />
                      <input
                        type="text"
                        placeholder="Маска"
                        value={newRouteMask}
                        onChange={(e) => setNewRouteMask(e.target.value)}
                        className="px-2 py-1 text-xs font-mono bg-slate-900 border border-slate-700 rounded text-slate-100"
                      />
                      <input
                        type="text"
                        placeholder="Next-Hop"
                        value={newRouteHop}
                        onChange={(e) => setNewRouteHop(e.target.value)}
                        className="px-2 py-1 text-xs font-mono bg-slate-900 border border-slate-700 rounded text-slate-100"
                      />
                    </div>
                    {routeError && <div className="text-[11px] text-red-400">{routeError}</div>}
                    <button
                      type="submit"
                      className="w-full flex items-center justify-center gap-1 px-2.5 py-1 text-xs font-medium bg-sky-600 hover:bg-sky-500 text-white rounded transition-colors"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span>Добавить маршрут</span>
                    </button>
                  </form>
                )}
              </div>
            )}
          </>
        )}

        {/* TAB 2: L4-L7 Application Protocols & Services */}
        {activeTab === 'apps' && (
          <div className="space-y-5">
            {/* Section A: Web Browser (DNS + TCP Handshake + HTTP GET) for PC / Host / Server */}
            {node.type !== 'switch' && (
              <div className="p-3.5 rounded-md bg-slate-950 border border-slate-800 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-xs font-semibold text-sky-300">
                    <Globe className="w-4 h-4" />
                    <span>Веб-браузер (DNS + TCP 3-Way + HTTP)</span>
                  </div>
                  <span className="text-[10px] font-mono text-slate-400">
                    DNS: {node.dnsServer || '192.168.2.100'}
                  </span>
                </div>

                <form onSubmit={handleBrowserSubmit} className="flex items-center gap-1.5">
                  <input
                    type="text"
                    aria-label="Адресная строка мини-браузера"
                    value={browserUrl}
                    onChange={(e) => setBrowserUrl(e.target.value)}
                    placeholder="http://app.corp.local/index.html"
                    className="flex-1 px-2.5 py-1.5 text-xs font-mono bg-slate-900 border border-slate-700 rounded text-slate-100 focus:outline-none focus:border-sky-500"
                  />
                  <button
                    type="submit"
                    className="px-3 py-1.5 text-xs font-medium bg-sky-600 hover:bg-sky-500 text-white rounded transition-colors whitespace-nowrap shrink-0"
                  >
                    Перейти (GET)
                  </button>
                </form>

                {/* Quick Domain Presets */}
                <div className="flex items-center gap-1.5 flex-wrap text-[11px]">
                  <span className="text-slate-400">Домены:</span>
                  {['http://app.corp.local', 'http://intranet.corp.local', 'http://192.168.2.100'].map(
                    (u) => (
                      <button
                        key={u}
                        type="button"
                        onClick={() => setBrowserUrl(u)}
                        className="px-2 py-0.5 font-mono bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-800 rounded"
                      >
                        {u.replace('http://', '')}
                      </button>
                    )
                  )}
                </div>

                {/* Rendered HTTP Viewport */}
                {browserResponse && (
                  <div className="p-3 rounded bg-slate-900 border border-emerald-500/40 space-y-1.5">
                    <div className="flex items-center justify-between text-[11px] font-mono text-emerald-400">
                      <span>
                        ● HTTP/1.1 {browserResponse.statusCode} {browserResponse.statusText}
                      </span>
                      <span>
                        IP: {browserResponse.resolvedIp} ({browserResponse.serverName})
                      </span>
                    </div>
                    <div className="text-xs font-semibold text-slate-100">
                      {browserResponse.title}
                    </div>
                    <p className="text-xs text-slate-300 leading-relaxed">
                      {browserResponse.body}
                    </p>
                  </div>
                )}

                {browserError && (
                  <div className="p-2.5 rounded bg-red-950/50 border border-red-800 text-xs text-red-300 font-mono">
                    ✕ {browserError}
                  </div>
                )}
              </div>
            )}

            {/* Section B: Traceroute Utility (TTL=1, 2, 3...) */}
            {node.type !== 'switch' && (
              <div className="p-3.5 rounded-md bg-slate-950 border border-slate-800 space-y-3">
                <div className="flex items-center gap-2 text-xs font-semibold text-amber-300">
                  <Route className="w-4 h-4" />
                  <span>Утилита Traceroute (Пошаговое истечение TTL)</span>
                </div>

                <form onSubmit={handleTracerouteSubmit} className="flex items-center gap-1.5">
                  <input
                    type="text"
                    aria-label="Целевой узел для Traceroute"
                    value={traceTarget}
                    onChange={(e) => setTraceTarget(e.target.value)}
                    placeholder="192.168.2.100 или app.corp.local"
                    className="flex-1 px-2.5 py-1.5 text-xs font-mono bg-slate-900 border border-slate-700 rounded text-slate-100 focus:outline-none focus:border-sky-500"
                  />
                  <button
                    type="submit"
                    className="px-3 py-1.5 text-xs font-medium bg-amber-600 hover:bg-amber-500 text-white rounded transition-colors whitespace-nowrap shrink-0"
                  >
                    Traceroute
                  </button>
                </form>

                {traceHops.length > 0 && (
                  <div className="border border-slate-800 rounded overflow-hidden">
                    <table className="w-full text-left text-xs font-mono">
                      <thead className="bg-slate-900 text-slate-400 border-b border-slate-800">
                        <tr>
                          <th className="py-1 px-2">TTL</th>
                          <th className="py-1 px-2">Узел (Hop)</th>
                          <th className="py-1 px-2">Ответ ICMP</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800 bg-slate-950">
                        {traceHops.map((h) => (
                          <tr key={h.hopNumber}>
                            <td className="py-1 px-2 text-amber-300 font-semibold">#{h.ttl}</td>
                            <td className="py-1 px-2 text-slate-200">
                              {h.responderName} ({h.responderIp})
                            </td>
                            <td className="py-1 px-2">
                              {h.status === 'TIME_EXCEEDED' ? (
                                <span className="text-amber-400">Time Exceeded</span>
                              ) : h.status === 'REACHED' ? (
                                <span className="text-emerald-400">Echo Reply</span>
                              ) : (
                                <span className="text-red-400">Timeout</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {/* Section C: DHCP Server Pools & Leases (for Router & Server) */}
            {(node.type === 'router' || node.type === 'server') && (
              <div className="p-3.5 rounded-md bg-slate-950 border border-slate-800 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-xs font-semibold text-emerald-300">
                    <Server className="w-4 h-4" />
                    <span>Служба DHCP-сервера (UDP 67/68)</span>
                  </div>
                  <button
                    onClick={() =>
                      onUpdateNode({
                        ...node,
                        services: { ...services, dhcpEnabled: !services.dhcpEnabled },
                      })
                    }
                    className={`px-2 py-0.5 text-[11px] font-mono rounded border ${
                      services.dhcpEnabled
                        ? 'bg-emerald-950/60 border-emerald-700 text-emerald-300'
                        : 'bg-slate-900 border-slate-700 text-slate-400'
                    }`}
                  >
                    {services.dhcpEnabled ? '● ACTIVE' : 'OFF'}
                  </button>
                </div>

                {/* Existing DHCP Pools */}
                <div className="space-y-1.5">
                  {services.dhcpPools.map((pool) => (
                    <div
                      key={pool.id}
                      className="p-2 rounded bg-slate-900 border border-slate-800 text-xs font-mono flex items-center justify-between"
                    >
                      <div className="space-y-0.5">
                        <div className="text-emerald-300 font-semibold">{pool.poolName}</div>
                        <div className="text-[11px] text-slate-300">
                          Диапазон: {pool.startIp} – {pool.endIp}
                        </div>
                        <div className="text-[10px] text-slate-400">
                          GW: {pool.defaultRouter} · DNS: {pool.dnsServer}
                        </div>
                      </div>
                      <button
                        onClick={() => handleDeleteDhcpPool(pool.id)}
                        className="text-slate-400 hover:text-red-400 p-1"
                        aria-label={`Удалить пул ${pool.poolName}`}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>

                {/* Add DHCP Pool Form */}
                <form onSubmit={handleAddDhcpPool} className="space-y-2 pt-2 border-t border-slate-800/80">
                  <div className="text-[11px] text-slate-400">Добавить пул адресов DHCP:</div>
                  <div className="grid grid-cols-2 gap-1.5">
                    <input
                      type="text"
                      placeholder="Имя пула"
                      value={newPoolName}
                      onChange={(e) => setNewPoolName(e.target.value)}
                      className="px-2 py-1 text-xs font-mono bg-slate-900 border border-slate-700 rounded text-slate-100"
                    />
                    <input
                      type="text"
                      placeholder="Сеть (192.168.1.0)"
                      value={newPoolNet}
                      onChange={(e) => setNewPoolNet(e.target.value)}
                      className="px-2 py-1 text-xs font-mono bg-slate-900 border border-slate-700 rounded text-slate-100"
                    />
                    <input
                      type="text"
                      placeholder="Начальный IP"
                      value={newPoolStart}
                      onChange={(e) => setNewPoolStart(e.target.value)}
                      className="px-2 py-1 text-xs font-mono bg-slate-900 border border-slate-700 rounded text-slate-100"
                    />
                    <input
                      type="text"
                      placeholder="Конечный IP"
                      value={newPoolEnd}
                      onChange={(e) => setNewPoolEnd(e.target.value)}
                      className="px-2 py-1 text-xs font-mono bg-slate-900 border border-slate-700 rounded text-slate-100"
                    />
                    <input
                      type="text"
                      placeholder="Шлюз (GW)"
                      value={newPoolGw}
                      onChange={(e) => setNewPoolGw(e.target.value)}
                      className="px-2 py-1 text-xs font-mono bg-slate-900 border border-slate-700 rounded text-slate-100"
                    />
                    <input
                      type="text"
                      placeholder="DNS-сервер"
                      value={newPoolDns}
                      onChange={(e) => setNewPoolDns(e.target.value)}
                      className="px-2 py-1 text-xs font-mono bg-slate-900 border border-slate-700 rounded text-slate-100"
                    />
                  </div>
                  <button
                    type="submit"
                    className="w-full flex items-center justify-center gap-1 px-2.5 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 rounded transition-colors"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Добавить DHCP пул</span>
                  </button>
                </form>
              </div>
            )}

            {/* Section D: DNS Records Table (for Server) */}
            {node.type === 'server' && (
              <div className="p-3.5 rounded-md bg-slate-950 border border-slate-800 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-indigo-300">
                    Таблица доменных имён DNS (A-записи, UDP 53)
                  </span>
                  <button
                    onClick={() =>
                      onUpdateNode({
                        ...node,
                        services: { ...services, dnsEnabled: !services.dnsEnabled },
                      })
                    }
                    className={`px-2 py-0.5 text-[11px] font-mono rounded border ${
                      services.dnsEnabled
                        ? 'bg-emerald-950/60 border-emerald-700 text-emerald-300'
                        : 'bg-slate-900 border-slate-700 text-slate-400'
                    }`}
                  >
                    {services.dnsEnabled ? '● DNS ON' : 'OFF'}
                  </button>
                </div>

                <div className="space-y-1">
                  {services.dnsRecords.map((rec) => (
                    <div
                      key={rec.id}
                      className="flex items-center justify-between px-2.5 py-1.5 rounded bg-slate-900 border border-slate-800 text-xs font-mono"
                    >
                      <div>
                        <span className="text-slate-100">{rec.domain}</span>
                        <span className="text-slate-500"> → </span>
                        <span className="text-sky-300">{rec.ipAddress}</span>
                      </div>
                      <button
                        onClick={() => handleDeleteDnsRecord(rec.id)}
                        className="text-slate-400 hover:text-red-400 p-0.5"
                        aria-label={`Удалить DNS запись ${rec.domain}`}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>

                <form onSubmit={handleAddDnsRecord} className="grid grid-cols-5 gap-1.5 pt-1">
                  <input
                    type="text"
                    placeholder="app.corp.local"
                    value={newDnsDomain}
                    onChange={(e) => setNewDnsDomain(e.target.value)}
                    className="col-span-2 px-2 py-1 text-xs font-mono bg-slate-900 border border-slate-700 rounded text-slate-100"
                  />
                  <input
                    type="text"
                    placeholder="192.168.2.100"
                    value={newDnsIp}
                    onChange={(e) => setNewDnsIp(e.target.value)}
                    className="col-span-2 px-2 py-1 text-xs font-mono bg-slate-900 border border-slate-700 rounded text-slate-100"
                  />
                  <button
                    type="submit"
                    aria-label="Добавить A-запись DNS"
                    className="flex items-center justify-center bg-sky-600 hover:bg-sky-500 text-white rounded text-xs font-medium"
                  >
                    <Plus className="w-3.5 h-3.5" />
                  </button>
                </form>
              </div>
            )}
          </div>
        )}

        {activeTab === 'cli' && (
          <div className="flex flex-col h-full min-h-[420px]">
            {/* Quick CLI Command Buttons */}
            <div className="mb-2.5 flex flex-wrap gap-1.5">
              <button
                onClick={() => runQuickCliSnippet('show ip int brief')}
                className="px-2 py-1 text-[11px] font-mono bg-slate-800 hover:bg-slate-700 text-slate-200 rounded transition-colors whitespace-nowrap shrink-0"
              >
                sh ip int brief
              </button>
              {(node.type === 'pc' || node.type === 'server') && (
                <>
                  <button
                    onClick={() => runQuickCliSnippet('ipconfig /renew')}
                    className="px-2 py-1 text-[11px] font-mono bg-emerald-950/80 hover:bg-emerald-900 border border-emerald-700/50 text-emerald-300 rounded transition-colors whitespace-nowrap shrink-0"
                  >
                    ipconfig /renew
                  </button>
                  <button
                    onClick={() => runQuickCliSnippet('traceroute 192.168.2.100')}
                    className="px-2 py-1 text-[11px] font-mono bg-amber-950/80 hover:bg-amber-900 border border-amber-700/50 text-amber-300 rounded transition-colors whitespace-nowrap shrink-0"
                  >
                    traceroute
                  </button>
                  <button
                    onClick={() => runQuickCliSnippet('curl http://app.corp.local')}
                    className="px-2 py-1 text-[11px] font-mono bg-sky-950/80 hover:bg-sky-900 border border-sky-700/50 text-sky-300 rounded transition-colors whitespace-nowrap shrink-0"
                  >
                    curl app.corp.local
                  </button>
                </>
              )}
              {node.type === 'router' && (
                <button
                  onClick={() => runQuickCliSnippet('show ip dhcp binding')}
                  className="px-2 py-1 text-[11px] font-mono bg-slate-800 hover:bg-slate-700 text-slate-200 rounded transition-colors whitespace-nowrap shrink-0"
                >
                  sh ip dhcp binding
                </button>
              )}
              <button
                onClick={() => runQuickCliSnippet('show arp')}
                className="px-2 py-1 text-[11px] font-mono bg-slate-800 hover:bg-slate-700 text-slate-200 rounded transition-colors whitespace-nowrap shrink-0"
              >
                show arp
              </button>
            </div>

            {/* Console Output Window */}
            <div className="flex-1 bg-slate-950 border border-slate-800 rounded-md p-3 font-mono text-xs text-emerald-400 overflow-y-auto space-y-1 select-text">
              {node.cli.history.map((line, i) => (
                <pre key={i} className="whitespace-pre-wrap break-words leading-relaxed font-mono">
                  {line}
                </pre>
              ))}
              <div ref={terminalEndRef} />
            </div>

            {/* Autocomplete Suggestions Strip (when multiple Tab matches exist) */}
            {cliSuggestions.length > 0 && (
              <div className="mt-2 px-2.5 py-1.5 rounded bg-slate-950 border border-sky-500/40 flex items-center flex-wrap gap-1.5 text-[11px] font-mono">
                <span className="text-slate-400">Варианты Tab:</span>
                {cliSuggestions.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => {
                      const tokens = cliInput.trimStart().split(/\s+/);
                      tokens[tokens.length - 1] = s;
                      setCliInput(`${tokens.join(' ')} `);
                      setCliSuggestions([]);
                    }}
                    className="px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-300 hover:bg-sky-500/25"
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}

            {/* Command Input Prompt */}
            <form onSubmit={handleCliSubmit} className="mt-2 flex items-center gap-2">
              <div className="flex-1 flex items-center bg-slate-950 border border-slate-700 focus-within:border-sky-500 rounded-md px-2.5 py-1.5">
                <span className="text-xs font-mono text-sky-400 mr-2 shrink-0">
                  {getCliPrompt(node)}
                </span>
                <input
                  type="text"
                  aria-label="Команда Cisco IOS CLI"
                  placeholder="conf t, int fa0/0, no shut, wr... (Tab — автодополнение)"
                  value={cliInput}
                  onKeyDown={handleCliKeyDown}
                  onChange={(e) => {
                    setCliInput(e.target.value);
                    if (cliSuggestions.length > 0) setCliSuggestions([]);
                  }}
                  className="w-full bg-transparent text-xs font-mono text-slate-100 focus:outline-none"
                />
              </div>
              <button
                type="submit"
                className="px-3 py-1.5 text-xs font-medium bg-sky-600 hover:bg-sky-500 text-white rounded-md transition-colors whitespace-nowrap shrink-0"
              >
                Выполнить
              </button>
            </form>

            {/* Keyboard Shortcut Hint Bar */}
            <div className="mt-1.5 flex items-center justify-between text-[10px] font-mono text-slate-400">
              <span>Tab — автодополнение · ↑/↓ — история ({(node.cli.commandLog || []).length})</span>
              <span>Сокращения: en · conf t · int fa0/0 · no shut · wr</span>
            </div>
          </div>
        )}

        {activeTab === 'tables' && (
          <div className="space-y-5">
            {/* ARP Table */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-xs font-semibold text-slate-200">
                  Таблица ARP ({node.arpTable.length})
                </h3>
                {node.arpTable.length > 0 && (
                  <button
                    onClick={() => onUpdateNode({ ...node, arpTable: [] })}
                    className="text-[11px] text-slate-400 hover:text-red-400"
                  >
                    Очистить ARP
                  </button>
                )}
              </div>
              {node.arpTable.length === 0 ? (
                <div className="p-3 rounded bg-slate-950 border border-slate-800 text-xs text-slate-400">
                  Таблица ARP пуста. Запустите Ping, Traceroute или HTTP-запрос для динамического заполнения.
                </div>
              ) : (
                <div className="border border-slate-800 rounded overflow-hidden">
                  <table className="w-full text-left text-xs font-mono">
                    <thead className="bg-slate-950 text-slate-400 border-b border-slate-800">
                      <tr>
                        <th className="py-1.5 px-2.5">IPv4</th>
                        <th className="py-1.5 px-2.5">MAC-адрес</th>
                        <th className="py-1.5 px-2.5">Порт</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800 bg-slate-900/50">
                      {node.arpTable.map((entry, idx) => (
                        <tr key={idx}>
                          <td className="py-1.5 px-2.5 text-sky-300">{entry.ipAddress}</td>
                          <td className="py-1.5 px-2.5 text-slate-200">{entry.macAddress}</td>
                          <td className="py-1.5 px-2.5 text-slate-400">{entry.interfaceName}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* DHCP Leases Table */}
            {(node.type === 'router' || node.type === 'server') && (
              <div>
                <h3 className="text-xs font-semibold text-slate-200 mb-2">
                  Выданные аренды DHCP ({services.dhcpLeases.length})
                </h3>
                {services.dhcpLeases.length === 0 ? (
                  <div className="p-3 rounded bg-slate-950 border border-slate-800 text-xs text-slate-400">
                    Пока нет активных клиентов DHCP. Нажмите «DHCP (DORA)» в настройках любого ПК.
                  </div>
                ) : (
                  <div className="border border-slate-800 rounded overflow-hidden">
                    <table className="w-full text-left text-xs font-mono">
                      <thead className="bg-slate-950 text-slate-400 border-b border-slate-800">
                        <tr>
                          <th className="py-1.5 px-2.5">IPv4</th>
                          <th className="py-1.5 px-2.5">Клиент</th>
                          <th className="py-1.5 px-2.5">Пул</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800 bg-slate-900/50">
                        {services.dhcpLeases.map((lease, idx) => (
                          <tr key={idx}>
                            <td className="py-1.5 px-2.5 text-emerald-300">{lease.ipAddress}</td>
                            <td className="py-1.5 px-2.5 text-slate-200">
                              {lease.hostname} ({lease.macAddress.slice(-8)})
                            </td>
                            <td className="py-1.5 px-2.5 text-slate-400">{lease.poolName}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {/* CAM MAC Address Table */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-xs font-semibold text-slate-200">
                  Таблица MAC-адресов коммутатора ({node.macTable.length})
                </h3>
                {node.macTable.length > 0 && (
                  <button
                    onClick={() => onUpdateNode({ ...node, macTable: [] })}
                    className="text-[11px] text-slate-400 hover:text-red-400"
                  >
                    Очистить CAM
                  </button>
                )}
              </div>
              {node.macTable.length === 0 ? (
                <div className="p-3 rounded bg-slate-950 border border-slate-800 text-xs text-slate-400">
                  Записи MAC-таблицы отсутствуют.
                </div>
              ) : (
                <div className="border border-slate-800 rounded overflow-hidden">
                  <table className="w-full text-left text-xs font-mono">
                    <thead className="bg-slate-950 text-slate-400 border-b border-slate-800">
                      <tr>
                        <th className="py-1.5 px-2.5">VLAN</th>
                        <th className="py-1.5 px-2.5">MAC-адрес</th>
                        <th className="py-1.5 px-2.5">Порт</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800 bg-slate-900/50">
                      {node.macTable.map((entry, idx) => (
                        <tr key={idx}>
                          <td className="py-1.5 px-2.5 text-amber-300">{entry.vlan}</td>
                          <td className="py-1.5 px-2.5 text-slate-200">{entry.macAddress}</td>
                          <td className="py-1.5 px-2.5 text-emerald-300">{entry.portName}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
};
