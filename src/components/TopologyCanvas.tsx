import React, { useState, useRef } from 'react';
import {
  CableType,
  DeviceType,
  NetworkInterface,
  NetworkLink,
  NetworkNode,
  NetworkZone,
  SimulationStep,
  ZoneColor,
} from '../network/types';
import { formatCidr } from '../network/ipMath';
import { isLinkOperational } from '../network/simulator';
import { HardwareFrontPanel } from './HardwareFrontPanel';
import { FloatingSwitchWebGui } from './FloatingSwitchWebGui';
import {
  Router,
  Network,
  Monitor,
  Server,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Mail,
  Cable,
  Trash2,
  Layers,
  Pencil,
  PanelRightOpen,
  Tag,
  HelpCircle,
  Cpu,
  Terminal,
  Settings2,
  Plus,
  Globe,
} from 'lucide-react';

export type WorkspaceTool = 'select' | 'cable' | 'pdu' | 'delete';

interface TopologyCanvasProps {
  nodes: NetworkNode[];
  links: NetworkLink[];
  zones: NetworkZone[];
  selectedNodeId: string | null;
  selectedZoneId: string | null;
  activeTool: WorkspaceTool;
  selectedCableType: CableType;
  activeStep: SimulationStep | null;
  isRightCollapsed: boolean;
  onExpandRightPanel: () => void;
  onSelectNode: (nodeId: string | null) => void;
  onSelectZone: (zoneId: string | null) => void;
  onSelectCableType: (type: CableType) => void;
  chassisNodeId: string | null;
  onOpenChassis: (nodeId: string | null) => void;
  webGuiNodeId: string | null;
  onOpenWebGui: (nodeId: string | null) => void;
  onOpenFloatingCli: (nodeId: string) => void;
  onMoveNode: (nodeId: string, x: number, y: number) => void;
  onMoveZone: (zoneId: string, x: number, y: number) => void;
  onUpdateNode: (updatedNode: NetworkNode) => void;
  onUpdateLinks: (updatedLinks: NetworkLink[]) => void;
  onUpdateZone: (updatedZone: NetworkZone) => void;
  onCreateZone?: (newZone: NetworkZone) => void;
  onDeleteZone: (zoneId: string) => void;
  onCreateLink: (
    sourceNodeId: string,
    sourcePortId: string,
    targetNodeId: string,
    targetPortId: string,
    cableType: CableType
  ) => void;
  onDeleteNode: (nodeId: string) => void;
  onDeleteLink: (linkId: string) => void;
  onSendPduBetweenNodes: (sourceNodeId: string, targetNodeId: string) => void;
  onInspectActiveStep: (step: SimulationStep) => void;
  onAddDeviceAtCenter: (type: DeviceType) => void;
  onAddZone: () => void;
}

type ContextMenuState =
  | {
      kind: 'node';
      nodeId: string;
      x: number;
      y: number;
    }
  | {
      kind: 'zone';
      zoneId: string;
      x: number;
      y: number;
    }
  | {
      kind: 'canvas';
      x: number;
      y: number;
    };

const ZONE_COLOR_STYLES: Record<
  ZoneColor,
  { bg: string; border: string; headerBg: string; text: string; badge: string }
> = {
  sky: {
    bg: 'bg-sky-500/[0.06] hover:bg-sky-500/[0.09]',
    border: 'border-sky-500/35',
    headerBg: 'bg-sky-950/85 border-b border-sky-500/30',
    text: 'text-sky-200',
    badge: 'text-sky-300 bg-sky-500/15 border-sky-500/30',
  },
  emerald: {
    bg: 'bg-emerald-500/[0.06] hover:bg-emerald-500/[0.09]',
    border: 'border-emerald-500/35',
    headerBg: 'bg-emerald-950/85 border-b border-emerald-500/30',
    text: 'text-emerald-200',
    badge: 'text-emerald-300 bg-emerald-500/15 border-emerald-500/30',
  },
  amber: {
    bg: 'bg-amber-500/[0.06] hover:bg-amber-500/[0.09]',
    border: 'border-amber-500/35',
    headerBg: 'bg-amber-950/85 border-b border-amber-500/30',
    text: 'text-amber-200',
    badge: 'text-amber-300 bg-amber-500/15 border-amber-500/30',
  },
  indigo: {
    bg: 'bg-indigo-500/[0.06] hover:bg-indigo-500/[0.09]',
    border: 'border-indigo-500/35',
    headerBg: 'bg-indigo-950/85 border-b border-indigo-500/30',
    text: 'text-indigo-200',
    badge: 'text-indigo-300 bg-indigo-500/15 border-indigo-500/30',
  },
  purple: {
    bg: 'bg-purple-500/[0.06] hover:bg-purple-500/[0.09]',
    border: 'border-purple-500/35',
    headerBg: 'bg-purple-950/85 border-b border-purple-500/30',
    text: 'text-purple-200',
    badge: 'text-purple-300 bg-purple-500/15 border-purple-500/30',
  },
  rose: {
    bg: 'bg-rose-500/[0.06] hover:bg-rose-500/[0.09]',
    border: 'border-rose-500/35',
    headerBg: 'bg-rose-950/85 border-b border-rose-500/30',
    text: 'text-rose-200',
    badge: 'text-rose-300 bg-rose-500/15 border-rose-500/30',
  },
};

export const TopologyCanvas: React.FC<TopologyCanvasProps> = ({
  nodes,
  links,
  zones,
  selectedNodeId,
  selectedZoneId,
  activeTool,
  selectedCableType,
  activeStep,
  isRightCollapsed,
  onExpandRightPanel,
  onSelectNode,
  onSelectZone,
  onSelectCableType,
  chassisNodeId,
  onOpenChassis,
  webGuiNodeId,
  onOpenWebGui,
  onOpenFloatingCli,
  onMoveNode,
  onMoveZone,
  onUpdateNode,
  onUpdateLinks,
  onUpdateZone,
  onCreateZone,
  onDeleteZone,
  onCreateLink,
  onDeleteNode,
  onDeleteLink,
  onSendPduBetweenNodes,
  onInspectActiveStep,
  onAddDeviceAtCenter,
  onAddZone,
}) => {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null);
  const [draggingZoneId, setDraggingZoneId] = useState<string | null>(null);
  const [resizingZoneId, setResizingZoneId] = useState<string | null>(null);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });

  // Declutter & Hardware Front Panel view options
  const [showZones, setShowZones] = useState(true);
  const [showPortLabels, setShowPortLabels] = useState(true);
  const [showLegend, setShowLegend] = useState(false);
  const [hoveredLinkId, setHoveredLinkId] = useState<string | null>(null);

  // Right-click Context Menu state
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  // Cable connection wizard state (shared between Canvas and 1U Front Panel)
  const [cableStart, setCableStart] = useState<{
    nodeId: string;
    portId: string;
    portName: string;
  } | null>(null);
  const [portPickerNodeId, setPortPickerNodeId] = useState<string | null>(null);

  // PDU source selection state
  const [pduSourceNodeId, setPduSourceNodeId] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);

  // Helper to check if a port is already occupied by a link
  const isPortUsed = (nodeId: string, portId: string) => {
    return links.some(
      (l) =>
        (l.sourceNodeId === nodeId && l.sourcePortId === portId) ||
        (l.targetNodeId === nodeId && l.targetPortId === portId)
    );
  };

  const handleCanvasMouseDown = (e: React.MouseEvent) => {
    if (e.button === 2) return; // Right-click is handled by onContextMenu
    setContextMenu(null);
    const target = e.target as HTMLElement;
    if (
      target === e.currentTarget ||
      target.dataset.canvasStage === 'true' ||
      target.tagName === 'svg'
    ) {
      onSelectNode(null);
      onSelectZone(null);
      setPortPickerNodeId(null);
      setIsPanning(true);
      setPanStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
    }
  };

  const handleCanvasContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const x = Math.min(rect.width - 230, Math.max(12, e.clientX - rect.left));
    const y = Math.min(rect.height - 220, Math.max(12, e.clientY - rect.top));
    setContextMenu({ kind: 'canvas', x, y });
  };

  const handleNodeContextMenu = (e: React.MouseEvent, node: NetworkNode) => {
    e.preventDefault();
    e.stopPropagation();
    onSelectZone(null);
    onSelectNode(node.id);
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const x = Math.min(rect.width - 250, Math.max(12, e.clientX - rect.left));
    const y = Math.min(rect.height - 260, Math.max(12, e.clientY - rect.top));
    setContextMenu({ kind: 'node', nodeId: node.id, x, y });
  };

  const handleZoneContextMenu = (e: React.MouseEvent, zone: NetworkZone) => {
    e.preventDefault();
    e.stopPropagation();
    onSelectNode(null);
    onSelectZone(zone.id);
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const x = Math.min(rect.width - 230, Math.max(12, e.clientX - rect.left));
    const y = Math.min(rect.height - 150, Math.max(12, e.clientY - rect.top));
    setContextMenu({ kind: 'zone', zoneId: zone.id, x, y });
  };

  const handleCanvasMouseMove = (e: React.MouseEvent) => {
    if (draggingNodeId && containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      const canvasX = (e.clientX - rect.left - pan.x) / zoom - dragOffset.x;
      const canvasY = (e.clientY - rect.top - pan.y) / zoom - dragOffset.y;
      const snappedX = Math.round(canvasX / 10) * 10;
      const snappedY = Math.round(canvasY / 10) * 10;
      onMoveNode(draggingNodeId, Math.max(40, snappedX), Math.max(40, snappedY));
    } else if (draggingZoneId && containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      const canvasX = (e.clientX - rect.left - pan.x) / zoom - dragOffset.x;
      const canvasY = (e.clientY - rect.top - pan.y) / zoom - dragOffset.y;
      const snappedX = Math.round(canvasX / 10) * 10;
      const snappedY = Math.round(canvasY / 10) * 10;
      onMoveZone(draggingZoneId, Math.max(20, snappedX), Math.max(20, snappedY));
    } else if (resizingZoneId && containerRef.current) {
      const zone = zones.find((z) => z.id === resizingZoneId);
      if (zone) {
        const rect = containerRef.current.getBoundingClientRect();
        const mouseCanvasX = (e.clientX - rect.left - pan.x) / zoom;
        const mouseCanvasY = (e.clientY - rect.top - pan.y) / zoom;
        const newWidth = Math.max(160, Math.round((mouseCanvasX - zone.x) / 10) * 10);
        const newHeight = Math.max(110, Math.round((mouseCanvasY - zone.y) / 10) * 10);
        onUpdateZone({ ...zone, width: newWidth, height: newHeight });
      }
    } else if (isPanning) {
      setPan({
        x: e.clientX - panStart.x,
        y: e.clientY - panStart.y,
      });
    }
  };

  const handleCanvasMouseUp = () => {
    setDraggingNodeId(null);
    setDraggingZoneId(null);
    setResizingZoneId(null);
    setIsPanning(false);
  };

  const handleSelectPortForCable = (node: NetworkNode, port: NetworkInterface) => {
    if (!cableStart) {
      setCableStart({ nodeId: node.id, portId: port.id, portName: port.shortName });
      setPortPickerNodeId(null);
    } else {
      if (cableStart.nodeId !== node.id) {
        onCreateLink(cableStart.nodeId, cableStart.portId, node.id, port.id, selectedCableType);
      }
      setCableStart(null);
      setPortPickerNodeId(null);
    }
  };

  const handleNodeClick = (e: React.MouseEvent, node: NetworkNode) => {
    e.stopPropagation();
    setContextMenu(null);

    if (activeTool === 'delete') {
      onDeleteNode(node.id);
      return;
    }

    // If a patch cord is armed (either from the 1U Front Panel socket OR from the Cable Tool)
    if (cableStart && cableStart.nodeId !== node.id) {
      const freePorts = node.interfaces.filter((i) => !isPortUsed(node.id, i.id));
      if (freePorts.length === 1) {
        handleSelectPortForCable(node, freePorts[0]);
        return;
      }
      if (freePorts.length > 1) {
        setPortPickerNodeId(node.id);
        return;
      }
    }

    if (activeTool === 'cable') {
      setPortPickerNodeId(node.id);
      return;
    }

    if (activeTool === 'pdu') {
      if (!pduSourceNodeId) {
        setPduSourceNodeId(node.id);
      } else if (pduSourceNodeId !== node.id) {
        onSendPduBetweenNodes(pduSourceNodeId, node.id);
        setPduSourceNodeId(null);
      } else {
        setPduSourceNodeId(null);
      }
      return;
    }

    onSelectZone(null);
    onSelectNode(node.id);
    onExpandRightPanel();
  };

  const handleNodeMouseDown = (e: React.MouseEvent, node: NetworkNode) => {
    if (e.button === 2) return;
    if (activeTool !== 'select' || cableStart) return;
    e.stopPropagation();
    setContextMenu(null);
    onSelectZone(null);
    onSelectNode(node.id);
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const mouseCanvasX = (e.clientX - rect.left - pan.x) / zoom;
    const mouseCanvasY = (e.clientY - rect.top - pan.y) / zoom;
    setDraggingNodeId(node.id);
    setDragOffset({ x: mouseCanvasX - node.x, y: mouseCanvasY - node.y });
  };

  const handleZoneMouseDown = (e: React.MouseEvent, zone: NetworkZone) => {
    if (e.button === 2) return;
    e.stopPropagation();
    setContextMenu(null);
    if (activeTool === 'delete') {
      onDeleteZone(zone.id);
      return;
    }
    onSelectNode(null);
    onSelectZone(zone.id);
    if (activeTool !== 'select' || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const mouseCanvasX = (e.clientX - rect.left - pan.x) / zoom;
    const mouseCanvasY = (e.clientY - rect.top - pan.y) / zoom;
    setDraggingZoneId(zone.id);
    setDragOffset({ x: mouseCanvasX - zone.x, y: mouseCanvasY - zone.y });
  };

  const renderDeviceIcon = (type: DeviceType) => {
    switch (type) {
      case 'router':
        return <Router className="w-6 h-6 text-sky-400" />;
      case 'switch':
        return <Network className="w-6 h-6 text-indigo-400" />;
      case 'server':
        return <Server className="w-6 h-6 text-emerald-400" />;
      case 'pc':
      default:
        return <Monitor className="w-6 h-6 text-slate-200" />;
    }
  };

  // Compute animated packet coordinates along activeStep link
  const getPacketVisualPosition = () => {
    if (!activeStep) return null;
    const fromNode = nodes.find((n) => n.id === activeStep.fromNodeId);
    const toNode = nodes.find((n) => n.id === activeStep.toNodeId);
    if (!fromNode || !toNode) return null;

    const x = fromNode.x + (toNode.x - fromNode.x) * 0.62;
    const y = fromNode.y + (toNode.y - fromNode.y) * 0.62;
    return { x, y, fromNode, toNode };
  };

  const packetPos = getPacketVisualPosition();
  const selectedNode = nodes.find((n) => n.id === selectedNodeId) || null;
  const chassisNode = nodes.find((n) => n.id === chassisNodeId) || null;
  const webGuiNode = nodes.find((n) => n.id === webGuiNodeId) || null;
  const activeNodeName = selectedNode?.name;
  const activeZoneName = zones.find((z) => z.id === selectedZoneId)?.title;

  const contextMenuNode =
    contextMenu?.kind === 'node'
      ? nodes.find((n) => n.id === contextMenu.nodeId) || null
      : null;
  const contextMenuZone =
    contextMenu?.kind === 'zone'
      ? zones.find((z) => z.id === contextMenu.zoneId) || null
      : null;

  return (
    <div className="flex-1 flex flex-col min-w-0 min-h-0 bg-netops-grid">
      {/* Realistic 1U Hardware Front Panel Floating Window */}
      {chassisNode && (
        <HardwareFrontPanel
          node={chassisNode}
          allNodes={nodes}
          allLinks={links}
          activeStep={activeStep}
          selectedCableType={selectedCableType}
          pendingCableSource={cableStart}
          onSetPendingCableSource={setCableStart}
          onSelectCableType={onSelectCableType}
          onCreateLink={onCreateLink}
          onDeleteLink={onDeleteLink}
          onUpdateLinks={onUpdateLinks}
          onUpdateNode={onUpdateNode}
          onSelectNode={(nodeId) => {
            onSelectZone(null);
            onSelectNode(nodeId);
            onOpenChassis(nodeId);
          }}
          onOpenFloatingCli={onOpenFloatingCli}
          onOpenWebGui={(nodeId) => onOpenWebGui(nodeId)}
          onHoverLink={setHoveredLinkId}
          onClose={() => onOpenChassis(null)}
        />
      )}

      {/* Switch Web Management Interface Floating Window (Ports & VLAN Database) */}
      {webGuiNode && (
        <FloatingSwitchWebGui
          node={webGuiNode}
          allNodes={nodes}
          allLinks={links}
          activeStep={activeStep}
          onSelectNode={(nodeId) => {
            onSelectZone(null);
            onSelectNode(nodeId);
            onOpenWebGui(nodeId);
          }}
          onUpdateNode={onUpdateNode}
          onOpenChassis={(nodeId) => onOpenChassis(nodeId)}
          onOpenFloatingCli={onOpenFloatingCli}
          onCreateZoneFromVlan={onCreateZone}
          onClose={() => onOpenWebGui(null)}
        />
      )}

      {/* Main Interactive Topology Canvas */}
      <div
        ref={containerRef}
        data-testid="topology-canvas"
        onMouseDown={handleCanvasMouseDown}
        onMouseMove={handleCanvasMouseMove}
        onMouseUp={handleCanvasMouseUp}
        onContextMenu={handleCanvasContextMenu}
        className="relative flex-1 min-h-0 overflow-hidden select-none cursor-grab active:cursor-grabbing"
      >
        {/* Right-Click Context Menu Overlay */}
        {contextMenu && (
          <div
            data-testid="canvas-context-menu"
            role="menu"
            style={{
              left: `${contextMenu.x}px`,
              top: `${contextMenu.y}px`,
            }}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            className="absolute z-40 w-56 rounded-lg bg-slate-900/98 border border-slate-700 shadow-2xl p-1.5 text-xs text-slate-200 space-y-0.5"
          >
            {contextMenu.kind === 'node' && contextMenuNode && (
              <>
                <div className="px-2.5 py-1.5 border-b border-slate-800 flex items-center justify-between">
                  <span className="font-mono font-bold text-sky-400 truncate">
                    {contextMenuNode.name}
                  </span>
                  <span className="text-[10px] font-mono text-slate-400 uppercase">
                    {contextMenuNode.type}
                  </span>
                </div>

                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onOpenFloatingCli(contextMenuNode.id);
                    setContextMenu(null);
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded hover:bg-emerald-950/80 text-emerald-300 font-medium text-left transition-colors cursor-pointer"
                >
                  <Terminal className="w-3.5 h-3.5 shrink-0" />
                  <span>Открыть терминал CLI (окно)</span>
                </button>

                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onSelectZone(null);
                    onSelectNode(contextMenuNode.id);
                    onOpenChassis(contextMenuNode.id);
                    setContextMenu(null);
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded hover:bg-slate-800 text-slate-200 text-left transition-colors cursor-pointer"
                >
                  <Cpu className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                  <span>Передняя панель 1U (RJ-45)</span>
                </button>

                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onSelectZone(null);
                    onSelectNode(contextMenuNode.id);
                    onOpenWebGui(contextMenuNode.id);
                    setContextMenu(null);
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded hover:bg-indigo-950/80 text-indigo-300 font-medium text-left transition-colors cursor-pointer"
                >
                  <Globe className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                  <span>Веб-интерфейс (Порты и VLAN)</span>
                </button>

                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onSelectZone(null);
                    onSelectNode(contextMenuNode.id);
                    onExpandRightPanel();
                    setContextMenu(null);
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded hover:bg-slate-800 text-slate-200 text-left transition-colors cursor-pointer"
                >
                  <Settings2 className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                  <span>Настроить в инспекторе</span>
                </button>

                <div className="my-1 border-t border-slate-800" />

                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setPortPickerNodeId(contextMenuNode.id);
                    setContextMenu(null);
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded hover:bg-slate-800 text-slate-200 text-left transition-colors cursor-pointer"
                >
                  <Cable className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                  <span>Подключить патч-корд...</span>
                </button>

                {contextMenuNode.type !== 'switch' && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setPduSourceNodeId(contextMenuNode.id);
                      setContextMenu(null);
                    }}
                    className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded hover:bg-slate-800 text-slate-200 text-left transition-colors cursor-pointer"
                  >
                    <Mail className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                    <span>Отправить Ping (PDU) отсюда</span>
                  </button>
                )}

                <div className="my-1 border-t border-slate-800" />

                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onDeleteNode(contextMenuNode.id);
                    setContextMenu(null);
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded hover:bg-red-950/70 text-red-300 text-left transition-colors cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5 shrink-0" />
                  <span>Удалить устройство</span>
                </button>
              </>
            )}

            {contextMenu.kind === 'zone' && contextMenuZone && (
              <>
                <div className="px-2.5 py-1.5 border-b border-slate-800 font-semibold text-sky-300 truncate">
                  {contextMenuZone.title}
                </div>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onSelectNode(null);
                    onSelectZone(contextMenuZone.id);
                    onExpandRightPanel();
                    setContextMenu(null);
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded hover:bg-slate-800 text-slate-200 text-left transition-colors cursor-pointer"
                >
                  <Pencil className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                  <span>Редактировать зону</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onDeleteZone(contextMenuZone.id);
                    setContextMenu(null);
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded hover:bg-red-950/70 text-red-300 text-left transition-colors cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5 shrink-0" />
                  <span>Удалить зону со схемы</span>
                </button>
              </>
            )}

            {contextMenu.kind === 'canvas' && (
              <>
                <div className="px-2.5 py-1.5 border-b border-slate-800 text-[11px] font-semibold text-slate-400">
                  Добавить на холст
                </div>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onAddDeviceAtCenter('router');
                    setContextMenu(null);
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded hover:bg-slate-800 text-slate-200 text-left transition-colors cursor-pointer"
                >
                  <Router className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                  <span>+ Маршрутизатор (Router L3)</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onAddDeviceAtCenter('switch');
                    setContextMenu(null);
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded hover:bg-slate-800 text-slate-200 text-left transition-colors cursor-pointer"
                >
                  <Network className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                  <span>+ Коммутатор (Switch L2)</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onAddDeviceAtCenter('pc');
                    setContextMenu(null);
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded hover:bg-slate-800 text-slate-200 text-left transition-colors cursor-pointer"
                >
                  <Monitor className="w-3.5 h-3.5 text-slate-200 shrink-0" />
                  <span>+ Рабочая станция (PC)</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onAddDeviceAtCenter('server');
                    setContextMenu(null);
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded hover:bg-slate-800 text-slate-200 text-left transition-colors cursor-pointer"
                >
                  <Server className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  <span>+ Сервер (HTTP / DNS / DHCP)</span>
                </button>
                <div className="my-1 border-t border-slate-800" />
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onAddZone();
                    setContextMenu(null);
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded hover:bg-slate-800 text-sky-300 text-left transition-colors cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5 shrink-0" />
                  <span>+ Зона подсети / VLAN</span>
                </button>
              </>
            )}
          </div>
        )}

        {/* Floating Button to Reopen Right Inspector when Collapsed */}
        {isRightCollapsed && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onExpandRightPanel();
            }}
            aria-label="Развернуть правую панель инспектора"
            className="absolute top-3 right-3 z-30 flex items-center gap-2 px-3 py-1.5 rounded-md bg-slate-900/95 hover:bg-slate-800 border border-slate-700 shadow-lg text-xs font-medium text-slate-200 transition-colors"
          >
            <PanelRightOpen className="w-3.5 h-3.5 text-sky-400" />
            <span>
              Инспектор
              {activeNodeName ? `: ${activeNodeName}` : activeZoneName ? `: ${activeZoneName}` : ''}
            </span>
          </button>
        )}

        {/* Contextual Mode Banner at Top of Canvas */}
        {(activeTool !== 'select' || (cableStart && !chassisNode) || pduSourceNodeId) && (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 z-30 px-4 py-1.5 rounded-md bg-slate-900/95 border border-sky-500/40 shadow-lg flex items-center gap-3 text-xs text-slate-200">
            {(activeTool === 'cable' || (cableStart && !chassisNode)) && (
              <>
                <Cable className="w-4 h-4 text-sky-400" />
                <span>
                  {cableStart
                    ? `Патч-корд из порта ${cableStart.portName}: кликните по целевому устройству на схеме или по свободному разъёму RJ-45.`
                    : 'Режим коммутации: кликните по первому устройству или выберите разъём RJ-45 на панели.'}
                </span>
                {cableStart && (
                  <button
                    onClick={() => setCableStart(null)}
                    className="text-slate-400 hover:text-slate-100 underline ml-1"
                  >
                    Отмена
                  </button>
                )}
              </>
            )}
            {activeTool === 'pdu' && !cableStart && (
              <>
                <Mail className="w-4 h-4 text-emerald-400" />
                <span>
                  {pduSourceNodeId
                    ? `Отправитель выбран. Кликните по целевому устройству для запуска Ping / PDU.`
                    : 'Отправка пакета (Simple PDU): кликните по узлу-отправителю, затем по узлу-получателю.'}
                </span>
                {pduSourceNodeId && (
                  <button
                    onClick={() => setPduSourceNodeId(null)}
                    className="text-slate-400 hover:text-slate-100 underline ml-1"
                  >
                    Сбросить
                  </button>
                )}
              </>
            )}
            {activeTool === 'delete' && !cableStart && (
              <>
                <Trash2 className="w-4 h-4 text-red-400" />
                <span>
                  Режим удаления: кликните по любому узлу, кабелю или зоне подсети для удаления.
                </span>
              </>
            )}
          </div>
        )}

        {/* Compact Zoom, View Filters & 1U Chassis Toggle at Bottom-Left */}
        <div
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          className="absolute bottom-3 left-3 z-20 flex items-center gap-2"
        >
          {/* Zoom Controls */}
          <div className="flex items-center bg-slate-900/95 border border-slate-800 rounded-md p-1 shadow-md">
            <button
              onClick={() => setZoom((z) => Math.min(1.6, Number((z + 0.15).toFixed(2))))}
              aria-label="Приблизить схему"
              className="p-1 text-slate-300 hover:text-white hover:bg-slate-800 rounded"
            >
              <ZoomIn className="w-3.5 h-3.5" />
            </button>
            <span className="px-2 text-xs font-mono text-slate-300 tabular-nums">
              {Math.round(zoom * 100)}%
            </span>
            <button
              onClick={() => setZoom((z) => Math.max(0.6, Number((z - 0.15).toFixed(2))))}
              aria-label="Отдалить схему"
              className="p-1 text-slate-300 hover:text-white hover:bg-slate-800 rounded"
            >
              <ZoomOut className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => {
                setZoom(1);
                setPan({ x: 0, y: 0 });
              }}
              aria-label="Сбросить масштаб"
              title="Сбросить масштаб"
              className="p-1 text-slate-300 hover:text-white hover:bg-slate-800 rounded border-l border-slate-800 ml-1"
            >
              <Maximize2 className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* View Declutter Toggles (1U Chassis, Zones, Port Names, Legend) */}
          <div className="flex items-center gap-1 bg-slate-900/95 border border-slate-800 rounded-md p-1 shadow-md text-xs">
            <button
              type="button"
              onClick={() => {
                if (chassisNodeId) {
                  onOpenChassis(null);
                } else {
                  const targetId =
                    selectedNodeId ||
                    nodes.find((n) => n.type === 'switch')?.id ||
                    nodes[0]?.id ||
                    null;
                  onOpenChassis(targetId);
                }
              }}
              className={`flex items-center gap-1 px-2 py-0.5 rounded transition-colors cursor-pointer ${
                chassisNodeId
                  ? 'bg-sky-500/20 text-sky-300 font-medium'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
              title="Показать или скрыть плавающее окно передней панели 1U (RJ-45)"
            >
              <Cpu className="w-3 h-3" />
              <span>1U Панель</span>
            </button>

            <button
              type="button"
              onClick={() => {
                if (webGuiNodeId) {
                  onOpenWebGui(null);
                } else {
                  const targetId =
                    (selectedNode?.type === 'switch' ? selectedNode.id : null) ||
                    nodes.find((n) => n.type === 'switch')?.id ||
                    selectedNodeId ||
                    nodes[0]?.id ||
                    null;
                  onOpenWebGui(targetId);
                }
              }}
              className={`flex items-center gap-1 px-2 py-0.5 rounded transition-colors cursor-pointer ${
                webGuiNodeId
                  ? 'bg-indigo-500/25 text-indigo-300 font-medium'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
              title="Открыть плавающий Веб-интерфейс коммутатора (настройка портов и базы VLAN)"
            >
              <Globe className="w-3 h-3" />
              <span>Веб-панель</span>
            </button>

            <button
              type="button"
              onClick={() => setShowZones((v) => !v)}
              className={`flex items-center gap-1 px-2 py-0.5 rounded transition-colors ${
                showZones
                  ? 'bg-sky-500/20 text-sky-300 font-medium'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
              title="Показать или скрыть цветные зоны подсетей"
            >
              <Layers className="w-3 h-3" />
              <span>Зоны</span>
            </button>

            <button
              type="button"
              onClick={() => setShowPortLabels((v) => !v)}
              className={`flex items-center gap-1 px-2 py-0.5 rounded transition-colors ${
                showPortLabels
                  ? 'bg-sky-500/20 text-sky-300 font-medium'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
              title="Показать или скрыть подписи портов (Fa0/0, Gi0/1) на кабелях"
            >
              <Tag className="w-3 h-3" />
              <span>Порты</span>
            </button>

            <button
              type="button"
              onClick={() => setShowLegend((v) => !v)}
              className={`flex items-center gap-1 px-2 py-0.5 rounded transition-colors ${
                showLegend
                  ? 'bg-slate-800 text-white'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
              title="Показать условные обозначения"
            >
              <HelpCircle className="w-3 h-3" />
              <span className="hidden sm:inline">Легенда</span>
            </button>
          </div>

          {/* On-Demand Legend Popover */}
          {showLegend && (
            <div className="flex items-center gap-3 px-3 py-1.5 bg-slate-900/95 border border-slate-700 rounded-md text-[11px] font-mono text-slate-300 shadow-lg">
              <span className="text-emerald-400">● LINK UP</span>
              <span>·</span>
              <span className="text-red-400">▲ SHUTDOWN</span>
              <span>·</span>
              <span className="text-indigo-300">---- 802.1Q TRUNK</span>
              <span>·</span>
              <span className="text-sky-300">◆ OSI PDU</span>
            </div>
          )}
        </div>

        {/* Transformed Canvas Stage */}
        <div
          data-canvas-stage="true"
          className="w-full h-full origin-top-left"
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          }}
        >
          {/* Layer 1: Interactive Subnet / VLAN Zones */}
          {showZones &&
            zones.map((zone) => {
              const palette = ZONE_COLOR_STYLES[zone.color] || ZONE_COLOR_STYLES.sky;
              const isZoneSelected = zone.id === selectedZoneId;

              return (
                <div
                  key={zone.id}
                  data-testid={`network-zone-${zone.id}`}
                  style={{
                    left: `${zone.x}px`,
                    top: `${zone.y}px`,
                    width: `${zone.width}px`,
                    height: `${zone.height}px`,
                  }}
                  onMouseDown={(e) => handleZoneMouseDown(e, zone)}
                  onContextMenu={(e) => handleZoneContextMenu(e, zone)}
                  onClick={(e) => {
                    e.stopPropagation();
                    setContextMenu(null);
                    if (activeTool === 'delete') {
                      onDeleteZone(zone.id);
                      return;
                    }
                    onSelectNode(null);
                    onSelectZone(zone.id);
                    onExpandRightPanel();
                  }}
                  className={`absolute z-10 rounded-xl border border-dashed transition-all pointer-events-auto cursor-pointer group ${
                    palette.bg
                  } ${
                    isZoneSelected
                      ? 'border-sky-400 ring-2 ring-sky-400/35 shadow-lg'
                      : palette.border
                  }`}
                >
                  {/* Clean Zone Header Bar */}
                  <div
                    className={`cursor-move rounded-t-[11px] px-3 py-1.5 flex items-center justify-between gap-2 ${palette.headerBg}`}
                  >
                    <span className={`text-xs font-semibold tracking-tight truncate ${palette.text}`}>
                      {zone.title}
                    </span>

                    <div className="flex items-center gap-1.5 shrink-0">
                      <span
                        className={`text-[10px] font-mono px-1.5 py-0.5 rounded border max-w-[175px] truncate ${palette.badge}`}
                        title={zone.subnetLabel}
                      >
                        {zone.subnetLabel}
                      </span>
                      <button
                        type="button"
                        aria-label={`Изменить зону ${zone.title}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelectNode(null);
                          onSelectZone(zone.id);
                          onExpandRightPanel();
                        }}
                        className={`p-1 rounded border transition-all ${
                          isZoneSelected
                            ? 'opacity-100 bg-sky-500 text-slate-950 border-sky-300'
                            : 'opacity-0 group-hover:opacity-100 bg-slate-900/80 text-slate-300 border-slate-700 hover:text-white hover:border-sky-400'
                        }`}
                        title="Редактировать зону"
                      >
                        <Pencil className="w-3 h-3" />
                      </button>
                    </div>
                  </div>

                  {/* Bottom-Right Resize Handle (visible on hover or when selected) */}
                  <div
                    data-testid={`resize-zone-${zone.id}`}
                    onMouseDown={(e) => {
                      e.stopPropagation();
                      onSelectNode(null);
                      onSelectZone(zone.id);
                      setResizingZoneId(zone.id);
                    }}
                    title="Потяните за угол для изменения ширины и высоты зоны"
                    className={`absolute bottom-1.5 right-1.5 w-3.5 h-3.5 cursor-nwse-resize rounded-xs border-r-2 border-b-2 transition-opacity ${
                      isZoneSelected
                        ? 'opacity-100 border-sky-300 bg-sky-500/30'
                        : 'opacity-0 group-hover:opacity-100 border-slate-400/70 hover:border-sky-400'
                    }`}
                  />
                </div>
              );
            })}

          {/* Layer 2: SVG Layer for Cables, Port Status Indicators, and Link Labels */}
          <svg className="relative z-15 w-[2400px] h-[1600px] overflow-visible pointer-events-none">
            <defs>
              <marker
                id="packet-arrow"
                viewBox="0 0 10 10"
                refX="6"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 1 L 10 5 L 0 9 z" fill="#38bdf8" />
              </marker>
            </defs>

            {links.map((link) => {
              const srcNode = nodes.find((n) => n.id === link.sourceNodeId);
              const dstNode = nodes.find((n) => n.id === link.targetNodeId);
              if (!srcNode || !dstNode) return null;

              const srcPort = srcNode.interfaces.find((p) => p.id === link.sourcePortId);
              const dstPort = dstNode.interfaces.find((p) => p.id === link.targetPortId);
              const isUp = isLinkOperational(link, nodes);
              const isTrunk = srcPort?.vlanMode === 'trunk' || dstPort?.vlanMode === 'trunk';
              const isActiveStepLink =
                activeStep?.linkId === link.id || hoveredLinkId === link.id;

              const dx = dstNode.x - srcNode.x;
              const dy = dstNode.y - srcNode.y;
              const srcDotX = srcNode.x + dx * 0.24;
              const srcDotY = srcNode.y + dy * 0.24;
              const dstDotX = srcNode.x + dx * 0.76;
              const dstDotY = srcNode.y + dy * 0.76;

              return (
                <g
                  key={link.id}
                  onClick={(e) => {
                    if (activeTool === 'delete') {
                      e.stopPropagation();
                      onDeleteLink(link.id);
                    }
                  }}
                  className={
                    activeTool === 'delete'
                      ? 'pointer-events-auto cursor-pointer group'
                      : 'pointer-events-none'
                  }
                >
                  {isActiveStepLink && (
                    <line
                      x1={srcNode.x}
                      y1={srcNode.y}
                      x2={dstNode.x}
                      y2={dstNode.y}
                      stroke="#0ea5e9"
                      strokeWidth={8}
                      strokeOpacity={0.32}
                      strokeLinecap="round"
                    />
                  )}

                  <line
                    x1={srcNode.x}
                    y1={srcNode.y}
                    x2={dstNode.x}
                    y2={dstNode.y}
                    stroke={
                      !isUp
                        ? '#ef4444'
                        : isActiveStepLink
                        ? '#38bdf8'
                        : link.cableType === 'fiber'
                        ? '#f59e0b'
                        : isTrunk
                        ? '#818cf8'
                        : '#64748b'
                    }
                    strokeWidth={isActiveStepLink ? 3 : 2.2}
                    strokeDasharray={
                      link.cableType === 'crossover' || isTrunk ? '6 4' : undefined
                    }
                  />

                  {srcPort?.adminStatus === 'up' ? (
                    <circle
                      cx={srcDotX}
                      cy={srcDotY}
                      r={4}
                      fill="#10b981"
                      stroke="#090d16"
                      strokeWidth={1.5}
                    />
                  ) : (
                    <polygon
                      points={`${srcDotX},${srcDotY - 5} ${srcDotX - 5},${srcDotY + 4} ${srcDotX + 5},${srcDotY + 4}`}
                      fill="#ef4444"
                    />
                  )}

                  {dstPort?.adminStatus === 'up' ? (
                    <circle
                      cx={dstDotX}
                      cy={dstDotY}
                      r={4}
                      fill="#10b981"
                      stroke="#090d16"
                      strokeWidth={1.5}
                    />
                  ) : (
                    <polygon
                      points={`${dstDotX},${dstDotY - 5} ${dstDotX - 5},${dstDotY + 4} ${dstDotX + 5},${dstDotY + 4}`}
                      fill="#ef4444"
                    />
                  )}

                  {showPortLabels && (
                    <>
                      <text
                        x={srcDotX}
                        y={srcDotY - 7}
                        textAnchor="middle"
                        className="fill-slate-400 text-[10px] font-mono select-none"
                      >
                        {srcPort?.shortName}
                      </text>
                      <text
                        x={dstDotX}
                        y={dstDotY - 7}
                        textAnchor="middle"
                        className="fill-slate-400 text-[10px] font-mono select-none"
                      >
                        {dstPort?.shortName}
                      </text>
                    </>
                  )}

                  {isTrunk && showPortLabels && (
                    <text
                      x={(srcNode.x + dstNode.x) / 2}
                      y={(srcNode.y + dstNode.y) / 2 - 7}
                      textAnchor="middle"
                      className="fill-indigo-300 text-[10px] font-mono font-semibold"
                    >
                      802.1Q Trunk
                    </text>
                  )}
                </g>
              );
            })}

            {packetPos && activeStep && (
              <line
                x1={packetPos.fromNode.x}
                y1={packetPos.fromNode.y}
                x2={packetPos.x}
                y2={packetPos.y}
                stroke="#38bdf8"
                strokeWidth={2.5}
                markerEnd="url(#packet-arrow)"
              />
            )}
          </svg>

          {/* Layer 3: HTML Overlay Layer for Devices */}
          {nodes.map((node) => {
            const isSelected = node.id === selectedNodeId;
            const isPduSource = node.id === pduSourceNodeId;
            const primaryIface = node.interfaces.find((i) => i.ipAddress) || node.interfaces[0];

            return (
              <div
                key={node.id}
                data-testid={`canvas-node-${node.id}`}
                style={{
                  left: `${node.x}px`,
                  top: `${node.y}px`,
                  transform: 'translate(-50%, -50%)',
                }}
                onMouseDown={(e) => handleNodeMouseDown(e, node)}
                onClick={(e) => handleNodeClick(e, node)}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  onOpenFloatingCli(node.id);
                }}
                onContextMenu={(e) => handleNodeContextMenu(e, node)}
                className="absolute z-20 flex flex-col items-center group cursor-pointer"
              >
                {/* Quick Nearby Action Buttons on Top of Device: [1U] Front Panel, [WEB] Switch GUI & [>_] CLI */}
                <div
                  className={`absolute -top-3.5 -right-4 z-30 flex items-center gap-1 transition-opacity ${
                    isSelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                  }`}
                >
                  <button
                    type="button"
                    aria-label={`Открыть 1U панель ${node.name}`}
                    title="Открыть плавающее окно портов 1U (RJ-45)"
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelectZone(null);
                      onSelectNode(node.id);
                      onOpenChassis(node.id);
                    }}
                    className="px-1.5 py-0.5 rounded-full bg-sky-950 border border-sky-400/80 text-[9px] font-mono font-bold text-sky-200 hover:bg-sky-600 hover:text-white shadow-md flex items-center gap-0.5 cursor-pointer"
                  >
                    <Cpu className="w-2.5 h-2.5" />
                    <span>1U</span>
                  </button>

                  <button
                    type="button"
                    aria-label={`Открыть веб-интерфейс ${node.name}`}
                    title="Открыть плавающий Веб-интерфейс коммутатора (настройка портов и VLAN)"
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelectZone(null);
                      onSelectNode(node.id);
                      onOpenWebGui(node.id);
                    }}
                    className="px-1.5 py-0.5 rounded-full bg-indigo-950 border border-indigo-400/80 text-[9px] font-mono font-bold text-indigo-200 hover:bg-indigo-600 hover:text-white shadow-md flex items-center gap-0.5 cursor-pointer"
                  >
                    <Globe className="w-2.5 h-2.5" />
                    <span>WEB</span>
                  </button>

                  <button
                    type="button"
                    aria-label={`Открыть CLI окно ${node.name}`}
                    title="Открыть плавающий терминал CLI (или ПКМ / двойной клик)"
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenFloatingCli(node.id);
                    }}
                    className="p-1 rounded-full bg-emerald-950 border border-emerald-500/70 text-emerald-300 hover:bg-emerald-600 hover:text-white shadow-md cursor-pointer"
                  >
                    <Terminal className="w-3 h-3" />
                  </button>
                </div>

                {/* Device Chassis Box */}
                <div
                  className={`w-13 h-13 rounded-lg bg-slate-900 border-2 flex flex-col items-center justify-center transition-transform shadow-lg ${
                    isSelected
                      ? 'border-sky-400 ring-2 ring-sky-500/30 scale-105'
                      : isPduSource
                      ? 'border-emerald-400 ring-2 ring-emerald-500/30'
                      : cableStart && cableStart.nodeId !== node.id
                      ? 'border-sky-500/70 hover:border-sky-300 scale-105'
                      : 'border-slate-700 hover:border-slate-500'
                  }`}
                >
                  {renderDeviceIcon(node.type)}
                  <span className="text-[9px] font-mono text-slate-400 mt-0.5 uppercase">
                    {node.type}
                  </span>
                </div>

                {/* Compact Device Hostname + Primary IP or Switch Port Status Caption */}
                <div className="mt-1 px-2 py-0.5 rounded bg-slate-950/90 border border-slate-800/90 text-center whitespace-nowrap">
                  <div className="text-xs font-semibold text-slate-100 leading-tight">
                    {node.name}
                  </div>
                  {node.type !== 'switch' && primaryIface?.ipAddress && (
                    <div className="text-[10px] font-mono text-sky-300 leading-tight">
                      {formatCidr(primaryIface.ipAddress, primaryIface.subnetMask)}
                    </div>
                  )}
                  {node.type === 'switch' && (
                    <div className="text-[9px] font-mono text-indigo-300 leading-tight">
                      {
                        node.interfaces.filter((iface) =>
                          isPortUsed(node.id, iface.id)
                        ).length
                      }
                      /{node.interfaces.length} RJ-45 · 1U
                    </div>
                  )}
                </div>

                {/* Port Picker Popover when Cable Tool is active */}
                {portPickerNodeId === node.id && (
                  <div
                    onClick={(e) => e.stopPropagation()}
                    className="absolute top-16 z-30 w-52 bg-slate-900 border border-slate-700 rounded-md shadow-xl p-2 space-y-1"
                  >
                    <div className="text-[11px] font-semibold text-slate-300 px-1.5 py-1 border-b border-slate-800">
                      Выберите порт на {node.name}:
                    </div>
                    {node.interfaces.map((iface) => {
                      const used = isPortUsed(node.id, iface.id);
                      return (
                        <button
                          key={iface.id}
                          disabled={used}
                          onClick={() => handleSelectPortForCable(node, iface)}
                          className={`w-full flex items-center justify-between px-2 py-1 text-xs font-mono rounded text-left ${
                            used
                              ? 'text-slate-600 cursor-not-allowed'
                              : 'text-slate-200 hover:bg-sky-600/20 hover:text-sky-300'
                          }`}
                        >
                          <span>{iface.shortName}</span>
                          <span className="text-[10px]">
                            {used ? 'Занят' : iface.ipAddress || `VLAN ${iface.accessVlan}`}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}

          {/* Animated Packet PDU Badge on the Canvas */}
          {packetPos && activeStep && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onInspectActiveStep(activeStep);
              }}
              style={{
                left: `${packetPos.x}px`,
                top: `${packetPos.y}px`,
                transform: 'translate(-50%, -50%)',
              }}
              aria-label={`Инспектировать пакет ${activeStep.protocol} на шаге ${activeStep.stepIndex}`}
              className={`absolute z-30 flex items-center gap-1.5 px-2.5 py-1 rounded-md border shadow-xl transition-all cursor-pointer ${
                activeStep.status === 'dropped'
                  ? 'bg-red-950 border-red-400 text-red-200'
                  : activeStep.protocol.startsWith('ARP')
                  ? 'bg-amber-950 border-amber-400 text-amber-200'
                  : 'bg-sky-950 border-sky-400 text-sky-100'
              }`}
            >
              <Mail className="w-3.5 h-3.5 shrink-0" />
              <div className="text-left font-mono leading-tight">
                <div className="text-[10px] font-semibold whitespace-nowrap">
                  #{activeStep.stepIndex} {activeStep.protocol}
                </div>
                <div className="text-[9px] opacity-85 whitespace-nowrap">
                  {activeStep.vlanTag !== null ? `802.1Q VLAN ${activeStep.vlanTag} · ` : ''}
                  Клик для OSI PDU
                </div>
              </div>
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
