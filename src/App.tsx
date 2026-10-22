import React, { useState, useEffect } from 'react';
import {
  CableType,
  DeviceType,
  HttpResponseResult,
  NetworkLink,
  NetworkNode,
  NetworkZone,
  SimulationStep,
  TracerouteHop,
  ZoneColor,
} from './network/types';
import { TOPOLOGY_PRESETS, createDeviceNode } from './network/presets';
import {
  runDhcpDoraSimulation,
  runHttpBrowserSimulation,
  runPacketSimulation,
  runTracerouteSimulation,
} from './network/simulator';
import { isValidIpv4 } from './network/ipMath';
import { DeviceToolbar } from './components/DeviceToolbar';
import { TopologyCanvas, WorkspaceTool } from './components/TopologyCanvas';
import { DeviceInspectorPanel } from './components/DeviceInspectorPanel';
import { SimulationTimelineBar } from './components/SimulationTimelineBar';
import { PduInspectorModal } from './components/PduInspectorModal';
import { FloatingCliWindow } from './components/FloatingCliWindow';
import { Play } from 'lucide-react';

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
  const [isRightCollapsed, setIsRightCollapsed] = useState<boolean>(false);
  const [isBottomLogExpanded, setIsBottomLogExpanded] = useState<boolean>(false);

  // Floating 1U Hardware Switch Window, Switch Web GUI & Multi-Tab CLI Window States
  const [chassisNodeId, setChassisNodeId] = useState<string | null>(null);
  const [webGuiNodeId, setWebGuiNodeId] = useState<string | null>(null);
  const [floatingCliNodeIds, setFloatingCliNodeIds] = useState<string[]>([]);
  const [activeFloatingCliNodeId, setActiveFloatingCliNodeId] = useState<string | null>(null);

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

  // Simulation state
  const [simulationSteps, setSimulationSteps] = useState<SimulationStep[]>([]);
  const [currentStepIndex, setCurrentStepIndex] = useState<number>(0);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [speedMultiplier, setSpeedMultiplier] = useState<number>(1);
  const [summaryMessage, setSummaryMessage] = useState<string>(
    'Стенд готов. Доступны протоколы L2–L7: ARP, VLAN, ICMP Ping, Traceroute (TTL), DHCP (DORA), DNS и HTTP.'
  );
  const [inspectedStep, setInspectedStep] = useState<SimulationStep | null>(null);

  // Save topology to localStorage
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ nodes, links, zones }));
    } catch {
      // ignore quota errors
    }
  }, [nodes, links, zones]);

  // Playback timer for Simulation Mode
  useEffect(() => {
    if (!isPlaying || simulationSteps.length === 0) return;

    const intervalMs = Math.round(900 / speedMultiplier);
    const timer = window.setInterval(() => {
      setCurrentStepIndex((prev) => {
        if (prev < simulationSteps.length - 1) {
          return prev + 1;
        } else {
          setIsPlaying(false);
          return prev;
        }
      });
    }, intervalMs);

    return () => window.clearInterval(timer);
  }, [isPlaying, simulationSteps.length, speedMultiplier]);

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
    setSimulationSteps([]);
    setCurrentStepIndex(0);
    setIsPlaying(false);
    setSummaryMessage(`Загружен стенд: «${preset.name}»`);
  };

  const handleAddDevice = (type: DeviceType) => {
    const countOfType = nodes.filter((n) => n.type === type).length + 1;
    const offsetX = 320 + ((nodes.length * 60) % 360);
    const offsetY = 220 + ((nodes.length * 45) % 240);
    const newNode = createDeviceNode(type, countOfType, offsetX, offsetY);
    setNodes((prev) => [...prev, newNode]);
    setSelectedNodeId(newNode.id);
    setSelectedZoneId(null);
    setIsRightCollapsed(false);
    setActiveTool('select');
    setSummaryMessage(`Добавлено устройство ${newNode.name}. Настройте порты или подключите кабель.`);
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
    setIsRightCollapsed(false);
    setActiveTool('select');
    setSummaryMessage(`Добавлена визуальная зона «${newZone.title}». Перетащите заголовок или настройте подпись.`);
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
    setNodes((prev) => prev.map((n) => (n.id === updatedNode.id ? updatedNode : n)));
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
    setLinks((prev) => [...prev, newLink]);
    setActiveTool('select');
    const srcNode = nodes.find((n) => n.id === sourceNodeId);
    const dstNode = nodes.find((n) => n.id === targetNodeId);
    setSummaryMessage(
      `Подключён патч-корд (${cableType}) между ${srcNode?.name || ''} и ${dstNode?.name || ''}.`
    );
  };

  const handleDeleteNode = (nodeId: string) => {
    setNodes((prev) => prev.filter((n) => n.id !== nodeId));
    setLinks((prev) =>
      prev.filter((l) => l.sourceNodeId !== nodeId && l.targetNodeId !== nodeId)
    );
    if (selectedNodeId === nodeId) {
      setSelectedNodeId(null);
    }
    if (chassisNodeId === nodeId) {
      setChassisNodeId(null);
    }
    if (webGuiNodeId === nodeId) {
      setWebGuiNodeId(null);
    }
    setSimulationSteps([]);
  };

  const handleDeleteLink = (linkId: string) => {
    setLinks((prev) => prev.filter((l) => l.id !== linkId));
    setSimulationSteps([]);
  };

  const handleLoadSimulationSteps = (steps: SimulationStep[], msg: string) => {
    setSimulationSteps(steps);
    setCurrentStepIndex(0);
    setSummaryMessage(msg);
    if (steps.length > 0) {
      setIsPlaying(true);
    }
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
    const targetIp = targetNode.interfaces.find(
      (i) => i.adminStatus === 'up' && isValidIpv4(i.ipAddress)
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

  const handleClearCanvas = () => {
    setNodes([]);
    setLinks([]);
    setZones([]);
    setSelectedNodeId(null);
    setSelectedZoneId(null);
    setChassisNodeId(null);
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

  const selectedNode = nodes.find((n) => n.id === selectedNodeId) || null;
  const activeStep = simulationSteps[currentStepIndex] || null;

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
            href="#pdu-inspector"
            onClick={(e) => {
              e.preventDefault();
              if (activeStep) {
                setInspectedStep(activeStep);
              } else {
                handleRunDefaultDemoSimulation();
              }
            }}
            className="hover:text-white transition-colors whitespace-nowrap shrink-0"
          >
            Инспектор OSI PDU
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
            isRightCollapsed={isRightCollapsed}
            onExpandRightPanel={() => setIsRightCollapsed(false)}
            onSelectNode={setSelectedNodeId}
            onSelectZone={setSelectedZoneId}
            onSelectCableType={setSelectedCableType}
            chassisNodeId={chassisNodeId}
            onOpenChassis={setChassisNodeId}
            webGuiNodeId={webGuiNodeId}
            onOpenWebGui={setWebGuiNodeId}
            onOpenFloatingCli={handleOpenFloatingCli}
            onMoveNode={handleMoveNode}
            onMoveZone={handleMoveZone}
            onUpdateNode={handleUpdateNode}
            onUpdateLinks={setLinks}
            onUpdateZone={handleUpdateZone}
            onCreateZone={(newZone) => setZones((prev) => [...prev, newZone])}
            onDeleteZone={handleDeleteZone}
            onCreateLink={handleCreateLink}
            onDeleteNode={handleDeleteNode}
            onDeleteLink={handleDeleteLink}
            onSendPduBetweenNodes={handleSendPduBetweenNodes}
            onInspectActiveStep={(step) => setInspectedStep(step)}
            onAddDeviceAtCenter={handleAddDevice}
            onAddZone={handleAddZone}
          />

          <SimulationTimelineBar
            steps={simulationSteps}
            currentStepIndex={currentStepIndex}
            isPlaying={isPlaying}
            speedMultiplier={speedMultiplier}
            summaryMessage={summaryMessage}
            isExpanded={isBottomLogExpanded}
            onToggleExpand={() => setIsBottomLogExpanded((e) => !e)}
            onPlayPause={() => setIsPlaying((p) => !p)}
            onStepForward={() => {
              setIsPlaying(false);
              setCurrentStepIndex((idx) => Math.min(simulationSteps.length - 1, idx + 1));
            }}
            onStepBack={() => {
              setIsPlaying(false);
              setCurrentStepIndex((idx) => Math.max(0, idx - 1));
            }}
            onReset={() => {
              setIsPlaying(false);
              setCurrentStepIndex(0);
            }}
            onSelectStep={(idx) => {
              setIsPlaying(false);
              setCurrentStepIndex(idx);
            }}
            onInspectStep={(step) => setInspectedStep(step)}
            onChangeSpeed={setSpeedMultiplier}
          />
        </div>

        {/* Right Inspector: Ports, L4-L7 Apps/Services, Cisco IOS CLI, ARP/DHCP/MAC State Tables & Subnet Zone Editor */}
        <DeviceInspectorPanel
          node={selectedNode}
          selectedZone={zones.find((z) => z.id === selectedZoneId) || null}
          allNodes={nodes}
          allLinks={links}
          allZones={zones}
          isCollapsed={isRightCollapsed}
          onToggleCollapse={() => setIsRightCollapsed((c) => !c)}
          onUpdateNode={handleUpdateNode}
          onUpdateAllNodes={setNodes}
          onSelectZone={(zoneId) => {
            if (zoneId) {
              setSelectedNodeId(null);
              setIsRightCollapsed(false);
            }
            setSelectedZoneId(zoneId);
          }}
          onUpdateZone={handleUpdateZone}
          onDeleteZone={handleDeleteZone}
          onAddZone={handleAddZone}
          onTriggerPingSimulation={handleTriggerPingSimulation}
          onTriggerDhcpSimulation={handleTriggerDhcpSimulation}
          onTriggerTracerouteSimulation={handleTriggerTracerouteSimulation}
          onTriggerHttpSimulation={handleTriggerHttpSimulation}
          onLoadSimulationSteps={handleLoadSimulationSteps}
          onOpenFloatingCli={handleOpenFloatingCli}
          onOpenChassis={(nodeId) => setChassisNodeId(nodeId)}
          onOpenWebGui={(nodeId) => setWebGuiNodeId(nodeId)}
        />
      </main>

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
    </div>
  );
}
