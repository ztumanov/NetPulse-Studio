import React, { useState, useEffect } from 'react';
import {
  CableType,
  DeviceType,
  HttpResponseResult,
  NetworkLink,
  NetworkNode,
  NetworkZone,
  PresetTestScenario,
  SimulationStep,
  TracerouteHop,
  ZoneColor,
} from './network/types';
import { TOPOLOGY_PRESETS, createDeviceNode } from './network/presets';
import {
  getRouterLogicalInterfaces,
  runDhcpDoraSimulation,
  runHttpBrowserSimulation,
  runPacketSimulation,
  runTracerouteSimulation,
  syncAllRoutersRoutingTables,
} from './network/simulator';
import { synthesizeOspfHelloSteps } from './network/ospfEngine';
import {
  CoreDiagnosticsReport,
  runCoreDiagnosticsSuite,
} from './network/diagnosticsSuite';
import {
  PacketFilterOptions,
  ProtocolFilterCategory,
  SimulationExecutionMode,
  buildCanvasPacketSquares,
  createDefaultEnabledCategories,
  generateMultiFlowTrafficSteps,
  getConcurrentBroadcastWaveIndices,
} from './network/packetStreamEngine';
import { isValidIpv4 } from './network/ipMath';
import { closeChassisWindow, openChassisWindow } from './network/hardwareChassis';
import { DeviceToolbar } from './components/DeviceToolbar';
import { TopologyCanvas, WorkspaceTool } from './components/TopologyCanvas';
import { SimulationTimelineBar } from './components/SimulationTimelineBar';
import { PduInspectorModal } from './components/PduInspectorModal';
import { FloatingCliWindow } from './components/FloatingCliWindow';
import { FloatingPcMonitor } from './components/FloatingPcMonitor';
import { CheckCircle2, Play, RefreshCw, X } from 'lucide-react';

const STORAGE_KEY = 'netpulse_studio_topology_v4';

export default function App() {
  const [activePresetId, setActivePresetId] = useState<string>('routed-dual-lan');
  const [nodes, setNodes] = useState<NetworkNode[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed.nodes) && parsed.nodes.length > 0) {
          return parsed.nodes;
        }
      }
    } catch {
      // ignore storage errors
    }
    return TOPOLOGY_PRESETS[0].nodes;
  });

  const [links, setLinks] = useState<NetworkLink[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed.links)) {
          return parsed.links;
        }
      }
    } catch {
      // ignore storage errors
    }
    return TOPOLOGY_PRESETS[0].links;
  });

  const [zones, setZones] = useState<NetworkZone[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed.zones)) {
          return parsed.zones;
        }
      }
    } catch {
      // ignore storage errors
    }
    return TOPOLOGY_PRESETS[0].zones || [];
  });

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(() => {
    const swNode = TOPOLOGY_PRESETS[0].nodes.find((n) => n.type === 'switch');
    return swNode?.id || TOPOLOGY_PRESETS[0].nodes[0]?.id || null;
  });
  const [selectedZoneId, setSelectedZoneId] = useState<string | null>(null);

  const [activeTool, setActiveTool] = useState<WorkspaceTool>('select');
  const [selectedCableType, setSelectedCableType] = useState<CableType>('straight');

  // Collapsible Workspace Panel States
  const [isLeftCollapsed, setIsLeftCollapsed] = useState<boolean>(false);
  const [isBottomLogExpanded, setIsBottomLogExpanded] = useState<boolean>(false);

  // Floating 1U Hardware Switch Windows (Multi-Window Rack), Switch Web GUI, PC Monitor & Multi-Tab CLI Window States
  const [openChassisNodeIds, setOpenChassisNodeIds] = useState<string[]>([]);
  const [webGuiNodeId, setWebGuiNodeId] = useState<string | null>(null);
  const [floatingCliNodeIds, setFloatingCliNodeIds] = useState<string[]>([]);
  const [activeFloatingCliNodeId, setActiveFloatingCliNodeId] = useState<string | null>(null);
  const [openPcMonitorNodeIds, setOpenPcMonitorNodeIds] = useState<string[]>([]);
  const [focusedPcMonitorId, setFocusedPcMonitorId] = useState<string | null>(null);

  const handleOpenChassis = (nodeId: string) => {
    setOpenChassisNodeIds((prev) => openChassisWindow(prev, nodeId));
  };

  const handleCloseChassis = (nodeId: string) => {
    setOpenChassisNodeIds((prev) => closeChassisWindow(prev, nodeId));
  };

  const handleCloseAllChassis = () => {
    setOpenChassisNodeIds([]);
  };

  const handleOpenPcMonitor = (nodeId: string) => {
    setOpenPcMonitorNodeIds((prev) => (prev.includes(nodeId) ? prev : [...prev, nodeId]));
    setFocusedPcMonitorId(nodeId);
  };

  const handleClosePcMonitor = (nodeId: string) => {
    setOpenPcMonitorNodeIds((prev) => prev.filter((id) => id !== nodeId));
  };

  const handleOpenFloatingCli = (nodeId: string) => {
    setFloatingCliNodeIds((prev) => (prev.includes(nodeId) ? prev : [...prev, nodeId]));
    setActiveFloatingCliNodeId(nodeId);
  };

  const handleCloseFloatingCliTab = (nodeId: string) => {
    setFloatingCliNodeIds((prev) => {
      const next = prev.filter((id) => id !== nodeId);
      if (activeFloatingCliNodeId === nodeId) {
        setActiveFloatingCliNodeId(next[next.length - 1] || null);
      }
      return next;
    });
  };

  // Simulation & Multi-Packet Live Stream state
  const [simulationSteps, setSimulationSteps] = useState<SimulationStep[]>([]);
  const [currentStepIndex, setCurrentStepIndex] = useState<number>(0);
  const [stepProgress, setStepProgress] = useState<number>(0.55);
  const [liveStreamPhase, setLiveStreamPhase] = useState<number>(0);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [executionMode, setExecutionMode] = useState<SimulationExecutionMode>('simulation');
  const [liveTrafficActive, setLiveTrafficActive] = useState<boolean>(false);
  const [liveWaveCount, setLiveWaveCount] = useState<number>(0);
  const [speedMultiplier, setSpeedMultiplier] = useState<number>(1);
  const [filterOptions, setFilterOptions] = useState<PacketFilterOptions>(() => ({
    enabledCategories: createDefaultEnabledCategories(),
    onlyDropped: false,
    deviceFilterId: 'ALL',
    searchQuery: '',
  }));
  const [summaryMessage, setSummaryMessage] = useState<string>(
    'Стенд готов. Доступны протоколы L2–L7: ARP, VLAN, STP, OSPF, RIPv2, ICMP Ping, Traceroute, DHCP, DNS и HTTP.'
  );
  const [inspectedStep, setInspectedStep] = useState<SimulationStep | null>(null);
  const [diagnosticsReport, setDiagnosticsReport] = useState<CoreDiagnosticsReport | null>(null);

  // Save topology to localStorage
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ nodes, links, zones }));
    } catch {
      // ignore quota errors
    }
  }, [nodes, links, zones]);

  // Unified Time-Dilated Playback & Live Stream Loop (supports 0.1x Slow-Mo .. 4x Turbo)
  useEffect(() => {
    if (!isPlaying || simulationSteps.length === 0) return;

    const tickMs = 70;
    const timer = window.setInterval(() => {
      if (executionMode === 'realtime') {
        // Continuous multi-packet stream phase increment scaled by speedMultiplier
        const deltaPhase = 0.018 * speedMultiplier;
        setLiveStreamPhase((prev) => (prev + deltaPhase) % 1);
        setCurrentStepIndex((prev) => (prev + 1) % simulationSteps.length);
      } else {
        // Step-by-step simulation mode with smooth intra-link interpolation
        const deltaStep = 0.085 * speedMultiplier;
        setStepProgress((prev) => {
          const next = prev + deltaStep;
          if (next < 0.92) {
            return next;
          }
          // Advance past the current broadcast wave or single step
          setCurrentStepIndex((currIdx) => {
            const waveIndices = getConcurrentBroadcastWaveIndices(simulationSteps, currIdx);
            const lastInWave =
              waveIndices.length > 0 ? Math.max(...waveIndices) : currIdx;
            if (lastInWave < simulationSteps.length - 1) {
              return lastInWave + 1;
            }
            if (liveTrafficActive) {
              return 0;
            }
            setIsPlaying(false);
            return currIdx;
          });
          return 0.14;
        });
      }
    }, tickMs);

    return () => window.clearInterval(timer);
  }, [isPlaying, simulationSteps, speedMultiplier, executionMode, liveTrafficActive]);

  const handleLoadPreset = (presetId: string) => {
    const preset = TOPOLOGY_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    const clonedNodes: NetworkNode[] = JSON.parse(JSON.stringify(preset.nodes));
    const clonedLinks: NetworkLink[] = JSON.parse(JSON.stringify(preset.links));
    const clonedZones: NetworkZone[] = JSON.parse(JSON.stringify(preset.zones || []));
    setActivePresetId(preset.id);
    setNodes(clonedNodes);
    setLinks(clonedLinks);
    setZones(clonedZones);
    const pcNode = clonedNodes.find((n) => n.type === 'pc');
    setSelectedNodeId(pcNode?.id || clonedNodes[0]?.id || null);
    setSelectedZoneId(null);
    setOpenChassisNodeIds([]);
    setOpenPcMonitorNodeIds([]);
    setWebGuiNodeId(null);
    setSimulationSteps([]);
    setCurrentStepIndex(0);
    setIsPlaying(false);
    setSummaryMessage(`Загружен стенд: «${preset.name}»`);
  };

  const handleAddDevice = (type: DeviceType, switchPortCount: number = 6) => {
    const countOfType = nodes.filter((n) => n.type === type).length + 1;
    const offsetX = 320 + ((nodes.length * 60) % 360);
    const offsetY = 220 + ((nodes.length * 45) % 240);
    const newNode = createDeviceNode(
      type,
      countOfType,
      offsetX,
      offsetY,
      undefined,
      switchPortCount
    );
    setNodes((prev) => [...prev, newNode]);
    setSelectedNodeId(newNode.id);
    setSelectedZoneId(null);
    setActiveTool('select');
    setSummaryMessage(`Добавлено устройство ${newNode.name} (${newNode.interfaces.length} портов). Настройте порты в плавающем окне или подключите кабель.`);
  };

  const handleAddZone = () => {
    const colors: ZoneColor[] = ['sky', 'emerald', 'amber', 'indigo', 'purple', 'rose'];
    const color = colors[zones.length % colors.length];
    const index = zones.length + 1;
    const newZone: NetworkZone = {
      id: `zone-${Date.now()}`,
      title: `VLAN ${index * 10} — Subnet Zone ${index}`,
      subnetLabel: `192.168.${index}0.0/24`,
      x: 180 + ((zones.length * 50) % 300),
      y: 120 + ((zones.length * 40) % 200),
      width: 300,
      height: 220,
      color,
    };
    setZones((prev) => [...prev, newZone]);
    setSelectedNodeId(null);
    setSelectedZoneId(newZone.id);
    setActiveTool('select');
    setSummaryMessage(`Добавлена визуальная зона «${newZone.title}». Перетащите заголовок или нажмите значок карандаша для настройки.`);
  };

  const handleMoveNode = (nodeId: string, x: number, y: number) => {
    setNodes((prev) => prev.map((n) => (n.id === nodeId ? { ...n, x, y } : n)));
  };

  const handleMoveZone = (zoneId: string, x: number, y: number) => {
    setZones((prev) => prev.map((z) => (z.id === zoneId ? { ...z, x, y } : z)));
  };

  const handleUpdateZone = (updatedZone: NetworkZone) => {
    setZones((prev) => prev.map((z) => (z.id === updatedZone.id ? updatedZone : z)));
  };

  const handleDeleteZone = (zoneId: string) => {
    setZones((prev) => prev.filter((z) => z.id !== zoneId));
    if (selectedZoneId === zoneId) {
      setSelectedZoneId(null);
    }
  };

  const handleUpdateNode = (updatedNode: NetworkNode) => {
    setNodes((prev) => {
      const next = prev.map((n) => (n.id === updatedNode.id ? updatedNode : n));
      return syncAllRoutersRoutingTables(next, links);
    });
  };

  const handleCreateLink = (
    sourceNodeId: string,
    sourcePortId: string,
    targetNodeId: string,
    targetPortId: string,
    cableType: CableType
  ) => {
    const newLink: NetworkLink = {
      id: `link-${Date.now()}`,
      sourceNodeId,
      sourcePortId,
      targetNodeId,
      targetPortId,
      cableType,
    };
    const nextLinks = [...links, newLink];
    setLinks(nextLinks);
    setNodes((prev) => syncAllRoutersRoutingTables(prev, nextLinks));
    setActiveTool('select');
    const srcNode = nodes.find((n) => n.id === sourceNodeId);
    const dstNode = nodes.find((n) => n.id === targetNodeId);
    setSummaryMessage(
      `Подключён патч-корд (${cableType}) между ${srcNode?.name || ''} и ${dstNode?.name || ''} (OSPF SPF пересчитан).`
    );
  };

  const handleDeleteNode = (nodeId: string) => {
    const nextLinks = links.filter(
      (l) => l.sourceNodeId !== nodeId && l.targetNodeId !== nodeId
    );
    setLinks(nextLinks);
    setNodes((prev) =>
      syncAllRoutersRoutingTables(
        prev.filter((n) => n.id !== nodeId),
        nextLinks
      )
    );
    if (selectedNodeId === nodeId) {
      setSelectedNodeId(null);
    }
    setOpenChassisNodeIds((prev) => closeChassisWindow(prev, nodeId));
    if (webGuiNodeId === nodeId) {
      setWebGuiNodeId(null);
    }
    setSimulationSteps([]);
  };

  const handleDeleteLink = (linkId: string) => {
    const nextLinks = links.filter((l) => l.id !== linkId);
    setLinks(nextLinks);
    setNodes((prev) => syncAllRoutersRoutingTables(prev, nextLinks));
    setSimulationSteps([]);
    setSummaryMessage('Кабель отключён — таблицы маршрутизации OSPF (SPF) автоматически перестроены.');
  };

  const handleLoadSimulationSteps = (steps: SimulationStep[], msg: string) => {
    setSimulationSteps(steps);
    setCurrentStepIndex(0);
    setStepProgress(0.52);
    setSummaryMessage(msg);
    if (steps.length > 0) {
      setIsPlaying(true);
    }
  };

  const handleToggleLiveTraffic = () => {
    if (liveTrafficActive) {
      setLiveTrafficActive(false);
      setIsPlaying(false);
      setSummaryMessage('Прямой эфир остановлен. Выберите любой пакет на схеме или в журнале для разбора заголовков PDU.');
      return;
    }
    const nextWave = liveWaveCount + 1;
    setLiveWaveCount(nextWave);
    const batch = generateMultiFlowTrafficSteps(nodes, links, nextWave);
    setNodes(batch.updatedNodes);
    setSimulationSteps(batch.steps);
    setCurrentStepIndex(0);
    setStepProgress(0.45);
    setExecutionMode('realtime');
    setLiveTrafficActive(true);
    setIsPlaying(true);
    setSummaryMessage(batch.summaryMessage);
  };

  const handleChangeExecutionMode = (mode: SimulationExecutionMode) => {
    setExecutionMode(mode);
    if (mode === 'realtime' && simulationSteps.length === 0) {
      const nextWave = liveWaveCount + 1;
      setLiveWaveCount(nextWave);
      const batch = generateMultiFlowTrafficSteps(nodes, links, nextWave);
      setNodes(batch.updatedNodes);
      setSimulationSteps(batch.steps);
      setCurrentStepIndex(0);
      setLiveTrafficActive(true);
      setIsPlaying(true);
      setSummaryMessage(batch.summaryMessage);
    } else if (mode === 'realtime') {
      setIsPlaying(true);
    } else {
      setStepProgress(0.58);
    }
  };

  const handleToggleProtocolCategory = (category: ProtocolFilterCategory) => {
    setFilterOptions((prev) => ({
      ...prev,
      enabledCategories: {
        ...prev.enabledCategories,
        [category]: !prev.enabledCategories[category],
      },
    }));
  };

  const handleEnableAllProtocols = () => {
    setFilterOptions((prev) => ({
      ...prev,
      enabledCategories: createDefaultEnabledCategories(),
      onlyDropped: false,
    }));
  };

  const handleTriggerPingSimulation = (
    sourceNodeId: string,
    targetIp: string,
    mode: 'ICMP' | 'TCP' = 'ICMP'
  ) => {
    const result = runPacketSimulation(nodes, links, sourceNodeId, targetIp, mode);
    setNodes(result.updatedNodes);
    handleLoadSimulationSteps(result.steps, result.summaryMessage);
  };

  const handleTriggerDhcpSimulation = (clientNodeId: string) => {
    const result = runDhcpDoraSimulation(nodes, links, clientNodeId);
    setNodes(result.updatedNodes);
    handleLoadSimulationSteps(result.steps, result.summaryMessage);
  };

  const handleTriggerTracerouteSimulation = (
    sourceNodeId: string,
    targetHostOrIp: string
  ): TracerouteHop[] => {
    const result = runTracerouteSimulation(nodes, links, sourceNodeId, targetHostOrIp);
    setNodes(result.updatedNodes);
    handleLoadSimulationSteps(result.steps, result.summaryMessage);
    return result.tracerouteHops || [];
  };

  const handleTriggerHttpSimulation = (
    clientNodeId: string,
    urlOrHost: string
  ): { success: boolean; httpResult?: HttpResponseResult; message: string } => {
    const result = runHttpBrowserSimulation(nodes, links, clientNodeId, urlOrHost);
    setNodes(result.updatedNodes);
    handleLoadSimulationSteps(result.steps, result.summaryMessage);
    return {
      success: result.success,
      httpResult: result.httpResult,
      message: result.summaryMessage,
    };
  };

  const handleSendPduBetweenNodes = (sourceNodeId: string, targetNodeId: string) => {
    const targetNode = nodes.find((n) => n.id === targetNodeId);
    if (!targetNode) return;
    const targetIp = getRouterLogicalInterfaces(targetNode).find((i) =>
      isValidIpv4(i.ipAddress)
    )?.ipAddress;

    if (!targetIp) {
      setSummaryMessage(
        `У целевого устройства ${targetNode.name} нет активного интерфейса с настроенным IPv4-адресом.`
      );
      return;
    }

    setActiveTool('select');
    handleTriggerPingSimulation(sourceNodeId, targetIp, 'ICMP');
  };

  const handleRunDefaultDemoSimulation = () => {
    const endpoints = nodes.filter(
      (n) =>
        (n.type === 'pc' || n.type === 'server') &&
        n.interfaces.some((i) => i.adminStatus === 'up' && isValidIpv4(i.ipAddress))
    );
    if (endpoints.length >= 2) {
      const src = endpoints[0];
      const dst = endpoints[endpoints.length - 1];
      const dstIp = dst.interfaces.find((i) => isValidIpv4(i.ipAddress))!.ipAddress;
      handleTriggerPingSimulation(src.id, dstIp, 'ICMP');
    } else {
      setSummaryMessage('Добавьте минимум два настроенных IP-узла для запуска Ping.');
    }
  };

  const handleRunPresetTest = (scenario: PresetTestScenario) => {
    setFilterOptions((prev) => ({
      ...prev,
      enabledCategories: createDefaultEnabledCategories(),
      onlyDropped: false,
    }));

    if (scenario.actionType === 'ospf_hello') {
      const synced = syncAllRoutersRoutingTables(nodes, links);
      setNodes(synced);
      const ospfSteps = synthesizeOspfHelloSteps(synced, links, 1, 0);
      if (ospfSteps.length > 0) {
        handleLoadSimulationSteps(
          ospfSteps,
          `Тест «${scenario.title}»: сгенерировано ${ospfSteps.length} пакетов OSPF Hello (224.0.0.5) и LSA.`
        );
      } else {
        setSummaryMessage('На текущем стенде нет активных интерфейсов OSPF для рассылки Hello.');
      }
      return;
    }

    if (scenario.actionType === 'multi_flow') {
      const batch = generateMultiFlowTrafficSteps(nodes, links, 1);
      setNodes(batch.updatedNodes);
      handleLoadSimulationSteps(batch.steps, batch.summaryMessage);
      return;
    }

    const srcId = scenario.sourceNodeId || nodes.find((n) => n.type === 'pc')?.id || '';
    const dst = scenario.targetIpOrHost || '';

    if (scenario.actionType === 'ping' && srcId && dst) {
      handleTriggerPingSimulation(srcId, dst, 'ICMP');
    } else if (scenario.actionType === 'traceroute' && srcId && dst) {
      handleTriggerTracerouteSimulation(srcId, dst);
    } else if (scenario.actionType === 'dhcp' && srcId) {
      handleTriggerDhcpSimulation(srcId);
    } else if (scenario.actionType === 'http' && srcId && dst) {
      handleTriggerHttpSimulation(srcId, dst);
    }
  };

  const handleOpenCoreDiagnostics = () => {
    const report = runCoreDiagnosticsSuite();
    setDiagnosticsReport(report);
    setSummaryMessage(
      `Автотест ядра завершён: ${report.passedChecks}/${report.totalChecks} проверок L1–L7 успешно (${report.totalDurationMs} мс).`
    );
  };

  const handleClearCanvas = () => {
    setNodes([]);
    setLinks([]);
    setZones([]);
    setSelectedNodeId(null);
    setSelectedZoneId(null);
    setOpenChassisNodeIds([]);
    setWebGuiNodeId(null);
    setSimulationSteps([]);
    setCurrentStepIndex(0);
    setIsPlaying(false);
    setActivePresetId('');
    setSummaryMessage('Холст очищен. Добавьте маршрутизаторы, коммутаторы, хосты и зоны из левой панели.');
  };

  const handleExportJson = () => {
    const payload = JSON.stringify({ nodes, links, zones }, null, 2);
    const blob = new Blob([payload], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `netpulse-topology-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImportJson = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result));
        if (Array.isArray(parsed.nodes) && Array.isArray(parsed.links)) {
          setNodes(parsed.nodes);
          setLinks(parsed.links);
          setZones(Array.isArray(parsed.zones) ? parsed.zones : []);
          setSelectedNodeId(parsed.nodes[0]?.id || null);
          setSelectedZoneId(null);
          setSimulationSteps([]);
          setSummaryMessage('Топология успешно импортирована из JSON-файла.');
        }
      } catch {
        setSummaryMessage('Ошибка чтения файла топологии JSON.');
      }
    };
    reader.readAsText(file);
  };

  const activeStep = simulationSteps[currentStepIndex] || null;
  const packetSquares = React.useMemo(
    () =>
      buildCanvasPacketSquares({
        nodes,
        steps: simulationSteps,
        activeStepIndex: currentStepIndex,
        stepProgress,
        executionMode,
        liveStreamPhase,
        filterOptions,
      }),
    [
      nodes,
      simulationSteps,
      currentStepIndex,
      stepProgress,
      executionMode,
      liveStreamPhase,
      filterOptions,
    ]
  );

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-slate-950 text-slate-100">
      {/* Strict 3-Zone Top Navigation Bar Contract */}
      <header className="flex items-center justify-between gap-8 px-6 py-3 border-b border-slate-800 bg-slate-900 shrink-0">
        {/* Zone 1: Single text element wordmark */}
        <a
          href="#top"
          onClick={(e) => {
            e.preventDefault();
          }}
          className="text-base font-bold tracking-tight text-slate-100 font-display whitespace-nowrap shrink-0"
        >
          NetPulse Studio
        </a>

        {/* Zone 2: 4 concise single-line navigation links */}
        <nav aria-label="Сценарии топологий" className="hidden md:flex items-center gap-6 text-xs font-medium text-slate-300">
          <a
            href="#routed-dual-lan"
            onClick={(e) => {
              e.preventDefault();
              handleLoadPreset('routed-dual-lan');
            }}
            className={`hover:text-white transition-colors whitespace-nowrap shrink-0 ${
              activePresetId === 'routed-dual-lan' ? 'text-sky-400 underline underline-offset-4' : ''
            }`}
          >
            Маршрутизация L3–L7
          </a>
          <a
            href="#vlan-trunk-isolation"
            onClick={(e) => {
              e.preventDefault();
              handleLoadPreset('vlan-trunk-isolation');
            }}
            className={`hover:text-white transition-colors whitespace-nowrap shrink-0 ${
              activePresetId === 'vlan-trunk-isolation' ? 'text-sky-400 underline underline-offset-4' : ''
            }`}
          >
            VLAN 802.1Q Trunk
          </a>
          <a
            href="#static-wan-routing"
            onClick={(e) => {
              e.preventDefault();
              handleLoadPreset('static-wan-routing');
            }}
            className={`hover:text-white transition-colors whitespace-nowrap shrink-0 ${
              activePresetId === 'static-wan-routing' ? 'text-sky-400 underline underline-offset-4' : ''
            }`}
          >
            Статика WAN
          </a>
          <a
            href="#ccna-roas-stp-acl-nat"
            onClick={(e) => {
              e.preventDefault();
              handleLoadPreset('ccna-roas-stp-acl-nat');
            }}
            className={`hover:text-white transition-colors whitespace-nowrap shrink-0 ${
              activePresetId === 'ccna-roas-stp-acl-nat' ? 'text-sky-400 underline underline-offset-4' : ''
            }`}
          >
            CCNA: RoaS · STP · ACL · NAT
          </a>
        </nav>

        {/* Zone 3: 1 primary action */}
        <div className="flex items-center gap-3 shrink-0">
          <button
            onClick={handleRunDefaultDemoSimulation}
            className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium text-white bg-sky-600 hover:bg-sky-500 rounded-md transition-colors whitespace-nowrap shrink-0 shadow-xs"
          >
            <Play className="w-3.5 h-3.5" />
            <span>Запустить Ping</span>
          </button>
        </div>
      </header>

      {/* Main Sandbox Workspace */}
      <main className="flex-1 flex min-h-0 overflow-hidden">
        <DeviceToolbar
          activeTool={activeTool}
          selectedCableType={selectedCableType}
          activePresetId={activePresetId}
          isCollapsed={isLeftCollapsed}
          onToggleCollapse={() => setIsLeftCollapsed((c) => !c)}
          onSelectTool={setActiveTool}
          onSelectCableType={setSelectedCableType}
          onAddDevice={handleAddDevice}
          onAddZone={handleAddZone}
          onLoadPreset={handleLoadPreset}
          onRunPresetTest={handleRunPresetTest}
          onOpenCoreDiagnostics={handleOpenCoreDiagnostics}
          onClearCanvas={handleClearCanvas}
          onExportJson={handleExportJson}
          onImportJson={handleImportJson}
        />

        {/* Center Stage: Topology Canvas + Bottom Simulation Event Log */}
        <div className="flex-1 flex flex-col min-w-0 min-h-0">
          <TopologyCanvas
            nodes={nodes}
            links={links}
            zones={zones}
            selectedNodeId={selectedNodeId}
            selectedZoneId={selectedZoneId}
            activeTool={activeTool}
            selectedCableType={selectedCableType}
            activeStep={activeStep}
            packetSquares={packetSquares}
            onSelectNode={setSelectedNodeId}
            onSelectZone={setSelectedZoneId}
            onSelectCableType={setSelectedCableType}
            openChassisNodeIds={openChassisNodeIds}
            onOpenChassis={handleOpenChassis}
            onCloseChassis={handleCloseChassis}
            onCloseAllChassis={handleCloseAllChassis}
            webGuiNodeId={webGuiNodeId}
            onOpenWebGui={setWebGuiNodeId}
            onOpenFloatingCli={handleOpenFloatingCli}
            openPcMonitorNodeIds={openPcMonitorNodeIds}
            onOpenPcMonitor={handleOpenPcMonitor}
            onMoveNode={handleMoveNode}
            onMoveZone={handleMoveZone}
            onUpdateNode={handleUpdateNode}
            onUpdateAllNodes={setNodes}
            onLoadSimulationSteps={handleLoadSimulationSteps}
            onUpdateLinks={(nextLinks) => {
              setLinks(nextLinks);
              setNodes((prev) => syncAllRoutersRoutingTables(prev, nextLinks));
            }}
            onUpdateZone={handleUpdateZone}
            onCreateZone={(newZone) => setZones((prev) => [...prev, newZone])}
            onDeleteZone={handleDeleteZone}
            onCreateLink={handleCreateLink}
            onDeleteNode={handleDeleteNode}
            onDeleteLink={handleDeleteLink}
            onSendPduBetweenNodes={handleSendPduBetweenNodes}
            onInspectActiveStep={(step) => setInspectedStep(step)}
            onSelectAndInspectPacketSquare={(step, stepIdx) => {
              setIsPlaying(false);
              setLiveTrafficActive(false);
              setCurrentStepIndex(stepIdx);
              setStepProgress(0.58);
              setSelectedZoneId(null);
              setSelectedNodeId(step.toNodeId);
              setInspectedStep(step);
            }}
            onAddDeviceAtCenter={handleAddDevice}
            onAddZone={handleAddZone}
          />

          <SimulationTimelineBar
            steps={simulationSteps}
            nodes={nodes}
            currentStepIndex={currentStepIndex}
            isPlaying={isPlaying}
            executionMode={executionMode}
            liveTrafficActive={liveTrafficActive}
            speedMultiplier={speedMultiplier}
            filterOptions={filterOptions}
            summaryMessage={summaryMessage}
            isExpanded={isBottomLogExpanded}
            onToggleExpand={() => setIsBottomLogExpanded((e) => !e)}
            onPlayPause={() => {
              if (!isPlaying && simulationSteps.length === 0) {
                handleToggleLiveTraffic();
              } else {
                setIsPlaying((p) => !p);
              }
            }}
            onStepForward={() => {
              setIsPlaying(false);
              setLiveTrafficActive(false);
              setExecutionMode('simulation');
              setStepProgress(0.58);
              setCurrentStepIndex((idx) => Math.min(simulationSteps.length - 1, idx + 1));
            }}
            onStepBack={() => {
              setIsPlaying(false);
              setLiveTrafficActive(false);
              setExecutionMode('simulation');
              setStepProgress(0.58);
              setCurrentStepIndex((idx) => Math.max(0, idx - 1));
            }}
            onReset={() => {
              setIsPlaying(false);
              setCurrentStepIndex(0);
              setStepProgress(0.52);
            }}
            onClearBuffer={() => {
              setIsPlaying(false);
              setLiveTrafficActive(false);
              setSimulationSteps([]);
              setCurrentStepIndex(0);
              setSummaryMessage('Буфер пакетов очищен.');
            }}
            onSelectStep={(idx, focusNode) => {
              setIsPlaying(false);
              setLiveTrafficActive(false);
              setCurrentStepIndex(idx);
              setStepProgress(0.58);
              const targetStep = simulationSteps[idx];
              if (focusNode && targetStep) {
                setSelectedZoneId(null);
                setSelectedNodeId(targetStep.toNodeId);
              }
            }}
            onInspectStep={(step) => {
              setIsPlaying(false);
              setInspectedStep(step);
            }}
            onChangeSpeed={setSpeedMultiplier}
            onChangeExecutionMode={handleChangeExecutionMode}
            onToggleLiveTraffic={handleToggleLiveTraffic}
            onToggleProtocolCategory={handleToggleProtocolCategory}
            onEnableAllProtocols={handleEnableAllProtocols}
            onToggleOnlyDropped={() =>
              setFilterOptions((prev) => ({ ...prev, onlyDropped: !prev.onlyDropped }))
            }
            onChangeDeviceFilter={(deviceId) =>
              setFilterOptions((prev) => ({ ...prev, deviceFilterId: deviceId }))
            }
            onChangeSearchQuery={(query) =>
              setFilterOptions((prev) => ({ ...prev, searchQuery: query }))
            }
          />
        </div>
      </main>

      {/* Floating Workstation PC Monitor Windows */}
      {openPcMonitorNodeIds.map((pcId, idx) => {
        const pcNode = nodes.find((n) => n.id === pcId);
        if (!pcNode) return null;
        return (
          <FloatingPcMonitor
            key={pcNode.id}
            node={pcNode}
            allNodes={nodes}
            allLinks={links}
            stackIndex={idx}
            zIndex={focusedPcMonitorId === pcNode.id ? 50 : 47}
            onFocus={() => setFocusedPcMonitorId(pcNode.id)}
            onUpdateNode={handleUpdateNode}
            onUpdateAllNodes={setNodes}
            onTriggerPingSimulation={handleTriggerPingSimulation}
            onTriggerDhcpSimulation={handleTriggerDhcpSimulation}
            onTriggerTracerouteSimulation={handleTriggerTracerouteSimulation}
            onTriggerHttpSimulation={handleTriggerHttpSimulation}
            onLoadSimulationSteps={handleLoadSimulationSteps}
            onClose={() => handleClosePcMonitor(pcNode.id)}
          />
        );
      })}

      {/* Floating Multi-Tab Cisco IOS CLI Terminal Window */}
      <FloatingCliWindow
        openNodeIds={floatingCliNodeIds}
        activeNodeId={activeFloatingCliNodeId}
        allNodes={nodes}
        allLinks={links}
        onSelectTab={setActiveFloatingCliNodeId}
        onCloseTab={handleCloseFloatingCliTab}
        onCloseWindow={() => {
          setFloatingCliNodeIds([]);
          setActiveFloatingCliNodeId(null);
        }}
        onAddDeviceTab={handleOpenFloatingCli}
        onUpdateNode={handleUpdateNode}
        onUpdateAllNodes={setNodes}
        onLoadSimulationSteps={handleLoadSimulationSteps}
      />

      {/* Modal for Deep OSI Layer 1-7 PDU Header Inspection */}
      <PduInspectorModal
        step={inspectedStep}
        onClose={() => setInspectedStep(null)}
      />

      {/* Modal for Core & Multi-Preset L1-L7 Self-Diagnostics Report */}
      {diagnosticsReport && (
        <div
          data-testid="core-diagnostics-modal"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-xs p-4"
        >
          <div className="w-full max-w-4xl max-h-[86vh] flex flex-col rounded-lg border border-slate-700 bg-slate-900 shadow-2xl overflow-hidden">
            <div className="px-4 py-3 bg-slate-950 border-b border-slate-800 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
                <div>
                  <h2 className="text-sm font-bold text-slate-100">
                    Отчёт самопроверки сетевого ядра и всех 7 лабораторных стендов (L1–L7)
                  </h2>
                  <p className="text-xs text-slate-400 font-mono">
                    Пройдено: {diagnosticsReport.passedChecks} из {diagnosticsReport.totalChecks} проверок · Время выполнения: {diagnosticsReport.totalDurationMs} мс
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleOpenCoreDiagnostics}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-emerald-700 hover:bg-emerald-600 text-xs font-medium text-white cursor-pointer"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>Перезапустить тесты</span>
                </button>
                <button
                  type="button"
                  data-testid="close-diagnostics-modal-btn"
                  onClick={() => setDiagnosticsReport(null)}
                  className="p-1.5 rounded text-slate-400 hover:text-white hover:bg-slate-800 cursor-pointer"
                  aria-label="Закрыть окно диагностики"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            <div className="p-4 overflow-y-auto space-y-2">
              {diagnosticsReport.results.map((item, idx) => (
                <div
                  key={item.id}
                  data-testid={`diag-row-${item.id}`}
                  className={`p-3 rounded-md border flex items-start justify-between gap-3 ${
                    item.passed
                      ? 'bg-slate-950/90 border-emerald-500/30'
                      : 'bg-red-950/40 border-red-500/50'
                  }`}
                >
                  <div className="space-y-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs font-mono font-bold text-slate-400">
                        #{idx + 1}
                      </span>
                      <span className="px-1.5 py-0.5 rounded bg-slate-800 text-[10px] font-mono font-bold text-sky-300">
                        {item.layer}
                      </span>
                      <span className="px-1.5 py-0.5 rounded bg-slate-900 border border-slate-700 text-[10px] font-mono text-slate-300">
                        {item.presetName}
                      </span>
                      <span className="text-xs font-semibold text-slate-100">
                        {item.title}
                      </span>
                    </div>
                    <p className="text-xs text-slate-300 font-mono leading-relaxed">
                      {item.detail}
                    </p>
                  </div>

                  <div className="flex flex-col items-end gap-1 shrink-0">
                    <span
                      className={`px-2 py-0.5 rounded text-[11px] font-mono font-bold ${
                        item.passed
                          ? 'bg-emerald-950 border border-emerald-500/50 text-emerald-300'
                          : 'bg-red-950 border border-red-500/50 text-red-300'
                      }`}
                    >
                      {item.passed ? 'PASS [OK]' : 'FAIL [ERR]'}
                    </span>
                    <span className="text-[10px] font-mono text-slate-400">
                      {item.stepsGenerated} PDU · {item.durationMs} мс
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
