import React, { useState, useRef, useMemo } from 'react';
import {
  CableType,
  DeviceModel,
  DeviceType,
  NetworkInterface,
  NetworkLink,
  NetworkNode,
  NetworkZone,
  SimulationStep,
  ZoneColor,
} from '../network/types';
import { formatCidr } from '../network/ipMath';
import {
  computeSpanningTreeState,
  getEtherChannelBundles,
  getRouterLogicalInterfaces,
  isLinkOperational,
} from '../network/simulator';
import {
  computeWifiSignalMetrics,
  isWifiAccessPointNode,
} from '../network/wifiEngine';
import {
  getNodeStackStatus,
  isStackInterconnectLink,
} from '../network/stackEngine';
import {
  computeSwitchPoeStatus,
  getPoweredDevicePoeState,
  isIpCameraNode,
  isNvrServerNode,
  isVoipPhoneNode,
} from '../network/poeAndVoipEngine';
import {
  computeGponOntOpticalState,
  isGponLinkPair,
  isGponOltNode,
  isGponOntNode,
} from '../network/gponEngine';
import { HardwareFrontPanel } from './HardwareFrontPanel';
import { FloatingSwitchWebGui } from './FloatingSwitchWebGui';
import { FloatingRouterGui } from './FloatingRouterGui';
import { CanvasPacketSquareDescriptor } from '../network/packetStreamEngine';
import {
  CableDisplayMode,
  computeTopologyLinkHeatmap,
} from '../network/linkHeatmapEngine';
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
  Tag,
  HelpCircle,
  Cpu,
  Terminal,
  Plus,
  Globe,
  Wifi,
  Radio,
  Laptop,
  Smartphone,
  Shield,
  PhoneCall,
  Camera,
  Video,
  Zap,
  Cloud,
  ChevronDown,
  ChevronRight,
  Activity,
  Gauge,
} from 'lucide-react';

export type WorkspaceTool = 'select' | 'cable' | 'pdu' | 'delete';

export interface PendingCanvasPlacement {
  kind: 'device' | 'zone';
  type?: DeviceType;
  switchPortCount?: number;
  deviceModel?: DeviceModel;
  label: string;
}

interface TopologyCanvasProps {
  nodes: NetworkNode[];
  links: NetworkLink[];
  zones: NetworkZone[];
  selectedNodeId: string | null;
  selectedZoneId: string | null;
  activeTool: WorkspaceTool;
  selectedCableType: CableType;
  pendingPlacement?: PendingCanvasPlacement | null;
  onPlacePendingAt?: (x: number, y: number) => void;
  onCancelPendingPlacement?: () => void;
  activeStep: SimulationStep | null;
  packetSquares: CanvasPacketSquareDescriptor[];
  onSelectNode: (nodeId: string | null) => void;
  onSelectZone: (zoneId: string | null) => void;
  onSelectCableType: (type: CableType) => void;
  openChassisNodeIds: string[];
  onOpenChassis: (nodeId: string) => void;
  onCloseChassis: (nodeId: string) => void;
  onCloseAllChassis: () => void;
  webGuiNodeId: string | null;
  onOpenWebGui: (nodeId: string | null) => void;
  onOpenFloatingCli: (nodeId: string) => void;
  openPcMonitorNodeIds: string[];
  onOpenPcMonitor: (nodeId: string) => void;
  onMoveNode: (nodeId: string, x: number, y: number) => void;
  onMoveZone: (zoneId: string, x: number, y: number) => void;
  onUpdateNode: (updatedNode: NetworkNode) => void;
  onUpdateAllNodes?: (updatedNodes: NetworkNode[]) => void;
  onLoadSimulationSteps?: (steps: SimulationStep[], summaryMessage: string) => void;
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
  onSelectAndInspectPacketSquare: (step: SimulationStep, stepIndexZeroBased: number) => void;
  onAddDeviceAtCenter: (
    type: DeviceType,
    switchPortCount?: number,
    deviceModel?: DeviceModel,
    customX?: number,
    customY?: number
  ) => void;
  onAddZone: (customX?: number, customY?: number) => void;
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
  pendingPlacement,
  onPlacePendingAt,
  onCancelPendingPlacement,
  activeStep,
  packetSquares,
  onSelectNode,
  onSelectZone,
  onSelectCableType,
  openChassisNodeIds,
  onOpenChassis,
  onCloseChassis,
  onCloseAllChassis,
  webGuiNodeId,
  onOpenWebGui,
  onOpenFloatingCli,
  openPcMonitorNodeIds,
  onOpenPcMonitor,
  onMoveNode,
  onMoveZone,
  onUpdateNode,
  onUpdateAllNodes,
  onLoadSimulationSteps,
  onUpdateLinks,
  onUpdateZone,
  onCreateZone,
  onDeleteZone,
  onCreateLink,
  onDeleteNode,
  onDeleteLink,
  onSendPduBetweenNodes,
  onInspectActiveStep,
  onSelectAndInspectPacketSquare,
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
  const [hoverCanvasPos, setHoverCanvasPos] = useState<{ x: number; y: number } | null>(null);

  // Declutter & Hardware Front Panel view options
  const [showZones, setShowZones] = useState(true);
  const [showWifiCoverage, setShowWifiCoverage] = useState(true);
  const [showPortLabels, setShowPortLabels] = useState(true);
  const [showLegend, setShowLegend] = useState(false);
  const [cableDisplayMode, setCableDisplayMode] = useState<CableDisplayMode>('standard');
  const [hoveredLinkId, setHoveredLinkId] = useState<string | null>(null);
  const [focusedChassisId, setFocusedChassisId] = useState<string | null>(null);
  const [editingZoneId, setEditingZoneId] = useState<string | null>(null);

  // Right-click Context Menu state
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [ctxCategories, setCtxCategories] = useState<{
    routing: boolean;
    switching: boolean;
    wireless: boolean;
    endpoints: boolean;
  }>({
    routing: true,
    switching: true,
    wireless: true,
    endpoints: true,
  });

  const toggleCtxCategory = (key: keyof typeof ctxCategories) => {
    setCtxCategories((prev) => ({ ...prev, [key]: !prev[key] }));
  };

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

  const computeSnappedCanvasCoords = (clientX: number, clientY: number) => {
    if (!containerRef.current) return { x: 360, y: 240 };
    const rect = containerRef.current.getBoundingClientRect();
    const rawX = (clientX - rect.left - pan.x) / zoom;
    const rawY = (clientY - rect.top - pan.y) / zoom;
    return {
      x: Math.max(40, Math.round(rawX / 10) * 10),
      y: Math.max(40, Math.round(rawY / 10) * 10),
    };
  };

  const handleCanvasMouseDown = (e: React.MouseEvent) => {
    if (e.button === 2) {
      if (pendingPlacement && onCancelPendingPlacement) {
        onCancelPendingPlacement();
      }
      return; // Right-click is handled by onContextMenu
    }
    setContextMenu(null);

    // If a device or zone from the left toolbar is armed for placement, place it at the clicked coordinates!
    if (pendingPlacement && onPlacePendingAt && containerRef.current) {
      const coords = computeSnappedCanvasCoords(e.clientX, e.clientY);
      onPlacePendingAt(coords.x, coords.y);
      return;
    }

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
    if (pendingPlacement && onCancelPendingPlacement) {
      onCancelPendingPlacement();
      return;
    }
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
    if (pendingPlacement && containerRef.current) {
      setHoverCanvasPos(computeSnappedCanvasCoords(e.clientX, e.clientY));
    }
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
  };

  const handleNodeMouseDown = (e: React.MouseEvent, node: NetworkNode) => {
    if (e.button === 2) return;
    if (pendingPlacement && onPlacePendingAt && containerRef.current) {
      e.stopPropagation();
      const coords = computeSnappedCanvasCoords(e.clientX, e.clientY);
      onPlacePendingAt(coords.x, coords.y);
      return;
    }
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
    if (pendingPlacement && onPlacePendingAt && containerRef.current) {
      const coords = computeSnappedCanvasCoords(e.clientX, e.clientY);
      onPlacePendingAt(coords.x, coords.y);
      return;
    }
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

  const renderDeviceIcon = (node: NetworkNode) => {
    if (node.deviceModel === 'firewall') {
      return <Shield className="w-6 h-6 text-rose-400" />;
    }
    if (node.deviceModel === 'isp_cloud') {
      return <Cloud className="w-6 h-6 text-orange-400" />;
    }
    if (node.deviceModel === 'wlc') {
      return <Server className="w-6 h-6 text-cyan-300" />;
    }
    if (node.deviceModel === 'wifi_ap') {
      return <Wifi className="w-6 h-6 text-cyan-400" />;
    }
    if (node.deviceModel === 'soho_wifi_router') {
      return <Radio className="w-6 h-6 text-cyan-400" />;
    }
    if (node.deviceModel === 'laptop') {
      return <Laptop className="w-6 h-6 text-violet-300" />;
    }
    if (node.deviceModel === 'smartphone') {
      return <Smartphone className="w-6 h-6 text-violet-300" />;
    }
    if (node.deviceModel === 'ip_phone') {
      return <PhoneCall className="w-6 h-6 text-fuchsia-400" />;
    }
    if (node.deviceModel === 'ip_camera') {
      return <Camera className="w-6 h-6 text-teal-400" />;
    }
    if (node.deviceModel === 'nvr') {
      return <Video className="w-6 h-6 text-teal-300" />;
    }
    if (node.deviceModel === 'gpon_olt') {
      return <Zap className="w-6 h-6 text-emerald-400" />;
    }
    if (node.deviceModel === 'gpon_ont') {
      return <Cpu className="w-6 h-6 text-teal-400" />;
    }
    switch (node.type) {
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
  const stpStateMap = computeSpanningTreeState(nodes, links);
  const etherChannelBundles = getEtherChannelBundles(nodes, links);
  const linkHeatmapMap = useMemo(
    () =>
      computeTopologyLinkHeatmap({
        nodes,
        links,
        activeStep,
        activeLinkIds: packetSquares.map((p) => p.linkId),
      }),
    [nodes, links, activeStep, packetSquares]
  );
  const selectedNode = nodes.find((n) => n.id === selectedNodeId) || null;
  const openChassisNodes = openChassisNodeIds
    .map((id) => nodes.find((n) => n.id === id))
    .filter((n): n is NetworkNode => Boolean(n));
  const webGuiNode = nodes.find((n) => n.id === webGuiNodeId) || null;
  const editingZone = zones.find((z) => z.id === editingZoneId) || null;

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
      {/* Realistic 1U Hardware Front Panel Floating Windows (Multi-Instance Rack Support) */}
      {openChassisNodes.map((chassisNode, idx) => (
        <HardwareFrontPanel
          key={chassisNode.id}
          node={chassisNode}
          allNodes={nodes}
          allLinks={links}
          activeStep={activeStep}
          selectedCableType={selectedCableType}
          pendingCableSource={cableStart}
          stackIndex={idx}
          zIndex={focusedChassisId === chassisNode.id ? 48 : 45}
          onFocus={() => setFocusedChassisId(chassisNode.id)}
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
            setFocusedChassisId(nodeId);
          }}
          onOpenFloatingCli={onOpenFloatingCli}
          onOpenWebGui={(nodeId) => onOpenWebGui(nodeId)}
          onHoverLink={setHoveredLinkId}
          onClose={() => onCloseChassis(chassisNode.id)}
        />
      ))}

      {/* Router GUI (Routes / 802.1Q / NAT / ACL / Stack) or Switch Web Management Interface (Ports & VLAN & StackWise) */}
      {webGuiNode &&
        (webGuiNode.type === 'router' ? (
          <FloatingRouterGui
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
            onUpdateAllNodes={onUpdateAllNodes}
            onCreateLink={onCreateLink}
            onLoadSimulationSteps={onLoadSimulationSteps}
            onOpenChassis={(nodeId) => onOpenChassis(nodeId)}
            onOpenFloatingCli={onOpenFloatingCli}
            onClose={() => onOpenWebGui(null)}
          />
        ) : (
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
            onUpdateAllNodes={onUpdateAllNodes}
            onCreateLink={onCreateLink}
            onLoadSimulationSteps={onLoadSimulationSteps}
            onOpenChassis={(nodeId) => onOpenChassis(nodeId)}
            onOpenFloatingCli={onOpenFloatingCli}
            onCreateZoneFromVlan={onCreateZone}
            onClose={() => onOpenWebGui(null)}
          />
        ))}

      {/* Main Interactive Topology Canvas */}
      <div
        ref={containerRef}
        data-testid="topology-canvas"
        onMouseDown={handleCanvasMouseDown}
        onMouseMove={handleCanvasMouseMove}
        onMouseUp={handleCanvasMouseUp}
        onMouseLeave={() => setHoverCanvasPos(null)}
        onContextMenu={handleCanvasContextMenu}
        style={pendingPlacement ? { cursor: 'crosshair' } : undefined}
        className={`relative flex-1 min-h-0 overflow-hidden select-none ${
          pendingPlacement
            ? 'cursor-crosshair'
            : 'cursor-grab active:cursor-grabbing'
        }`}
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

                {contextMenuNode.type === 'pc' ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onSelectZone(null);
                      onSelectNode(contextMenuNode.id);
                      onOpenPcMonitor(contextMenuNode.id);
                      setContextMenu(null);
                    }}
                    className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded hover:bg-sky-950/90 text-sky-300 font-semibold text-left transition-colors cursor-pointer"
                  >
                    <Monitor className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                    <span>Открыть монитор ПК (Сеть и CMD)</span>
                  </button>
                ) : contextMenuNode.type === 'server' ? (
                  <>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        onSelectZone(null);
                        onSelectNode(contextMenuNode.id);
                        onOpenPcMonitor(contextMenuNode.id);
                        setContextMenu(null);
                      }}
                      className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded hover:bg-amber-950/90 text-amber-300 font-semibold text-left transition-colors cursor-pointer"
                    >
                      <Server className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                      <span>Панель Сервера (HTTP / DNS / DHCP)</span>
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
                        onOpenFloatingCli(contextMenuNode.id);
                        setContextMenu(null);
                      }}
                      className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded hover:bg-emerald-950/80 text-emerald-300 font-medium text-left transition-colors cursor-pointer"
                    >
                      <Terminal className="w-3.5 h-3.5 shrink-0" />
                      <span>Открыть терминал CLI (окно)</span>
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        onSelectZone(null);
                        onSelectNode(contextMenuNode.id);
                        onOpenWebGui(contextMenuNode.id);
                        setContextMenu(null);
                      }}
                      className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded hover:bg-indigo-950/80 text-indigo-300 font-semibold text-left transition-colors cursor-pointer"
                    >
                      <Globe className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                      <span>
                        {contextMenuNode.type === 'router'
                          ? 'Панель роутера (Порты / OSPF / ACL / NAT)'
                          : 'Веб-интерфейс (Порты / VLAN / STP)'}
                      </span>
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
                        onOpenFloatingCli(contextMenuNode.id);
                        setContextMenu(null);
                      }}
                      className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded hover:bg-emerald-950/80 text-emerald-300 font-medium text-left transition-colors cursor-pointer"
                    >
                      <Terminal className="w-3.5 h-3.5 shrink-0" />
                      <span>Открыть терминал CLI (окно)</span>
                    </button>
                  </>
                )}

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

                {(contextMenuNode.type === 'switch' || contextMenuNode.type === 'router') && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onSelectCableType('stack');
                      setPortPickerNodeId(contextMenuNode.id);
                      setContextMenu(null);
                    }}
                    className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded hover:bg-amber-950/80 text-amber-300 font-medium text-left transition-colors cursor-pointer"
                  >
                    <Layers className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                    <span>Объединить в стек (StackWise / HA)...</span>
                  </button>
                )}

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
                    setEditingZoneId(contextMenuZone.id);
                    setContextMenu(null);
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded hover:bg-slate-800 text-slate-200 text-left transition-colors cursor-pointer"
                >
                  <Pencil className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                  <span>Редактировать зону (окно)</span>
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
                <div className="px-2.5 py-1.5 border-b border-slate-800 text-[11px] font-semibold text-slate-300 flex items-center justify-between">
                  <span>Добавить устройство на холст</span>
                  <span className="text-[9px] font-mono text-slate-500">4 категории</span>
                </div>

                {/* Category 1: Routing & Security */}
                <button
                  type="button"
                  onClick={() => toggleCtxCategory('routing')}
                  className="w-full flex items-center justify-between px-2.5 py-1 mt-0.5 rounded bg-slate-950/70 hover:bg-slate-800/80 text-[11px] font-semibold text-slate-300 transition-colors cursor-pointer"
                >
                  <span className="flex items-center gap-1.5">
                    <Router className="w-3 h-3 text-sky-400 shrink-0" />
                    <span>Маршрутизация и NGFW</span>
                  </span>
                  {ctxCategories.routing ? (
                    <ChevronDown className="w-3 h-3 text-slate-400" />
                  ) : (
                    <ChevronRight className="w-3 h-3 text-slate-400" />
                  )}
                </button>
                {ctxCategories.routing && (
                  <div className="pl-2 space-y-0.5">
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        onAddDeviceAtCenter('router');
                        setContextMenu(null);
                      }}
                      className="w-full flex items-center justify-between gap-2 px-2.5 py-1 rounded hover:bg-slate-800 text-slate-200 text-left transition-colors cursor-pointer"
                    >
                      <span className="flex items-center gap-2">
                        <Router className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                        <span>Router (L3)</span>
                      </span>
                      <span className="text-[10px] font-mono text-slate-400">3 порта</span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        onAddDeviceAtCenter('router', 3, 'firewall');
                        setContextMenu(null);
                      }}
                      className="w-full flex items-center justify-between gap-2 px-2.5 py-1 rounded hover:bg-slate-800 text-slate-200 text-left transition-colors cursor-pointer"
                    >
                      <span className="flex items-center gap-2">
                        <Shield className="w-3.5 h-3.5 text-rose-400 shrink-0" />
                        <span>Firewall (ASA)</span>
                      </span>
                      <span className="text-[10px] font-mono text-slate-400">SPI · VPN</span>
                    </button>
                  </div>
                )}

                {/* Category 2: Switching */}
                <button
                  type="button"
                  onClick={() => toggleCtxCategory('switching')}
                  className="w-full flex items-center justify-between px-2.5 py-1 mt-0.5 rounded bg-slate-950/70 hover:bg-slate-800/80 text-[11px] font-semibold text-slate-300 transition-colors cursor-pointer"
                >
                  <span className="flex items-center gap-1.5">
                    <Network className="w-3 h-3 text-indigo-400 shrink-0" />
                    <span>Коммутация L2 / L3</span>
                  </span>
                  {ctxCategories.switching ? (
                    <ChevronDown className="w-3 h-3 text-slate-400" />
                  ) : (
                    <ChevronRight className="w-3 h-3 text-slate-400" />
                  )}
                </button>
                {ctxCategories.switching && (
                  <div className="pl-2 space-y-0.5">
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        onAddDeviceAtCenter('switch', 6);
                        setContextMenu(null);
                      }}
                      className="w-full flex items-center justify-between gap-2 px-2.5 py-1 rounded hover:bg-slate-800 text-slate-200 text-left transition-colors cursor-pointer"
                    >
                      <span className="flex items-center gap-2">
                        <Network className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                        <span>Switch 6p (L2)</span>
                      </span>
                      <span className="text-[10px] font-mono text-slate-400">6 портов</span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        onAddDeviceAtCenter('switch', 24);
                        setContextMenu(null);
                      }}
                      className="w-full flex items-center justify-between gap-2 px-2.5 py-1 rounded hover:bg-slate-800 text-slate-200 text-left transition-colors cursor-pointer"
                    >
                      <span className="flex items-center gap-2">
                        <Network className="w-3.5 h-3.5 text-indigo-300 shrink-0" />
                        <span>Switch 24p (L2)</span>
                      </span>
                      <span className="text-[10px] font-mono text-slate-400">24 порта</span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        onAddDeviceAtCenter('switch', 6, 'gpon_olt');
                        setContextMenu(null);
                      }}
                      className="w-full flex items-center justify-between gap-2 px-2.5 py-1 rounded hover:bg-slate-800 text-slate-200 text-left transition-colors cursor-pointer"
                    >
                      <span className="flex items-center gap-2">
                        <Zap className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                        <span>GPON OLT</span>
                      </span>
                      <span className="text-[10px] font-mono text-emerald-300">1490/1310нм</span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        onAddDeviceAtCenter('switch', 4, 'gpon_ont');
                        setContextMenu(null);
                      }}
                      className="w-full flex items-center justify-between gap-2 px-2.5 py-1 rounded hover:bg-slate-800 text-slate-200 text-left transition-colors cursor-pointer"
                    >
                      <span className="flex items-center gap-2">
                        <Cpu className="w-3.5 h-3.5 text-teal-400 shrink-0" />
                        <span>ONT / ONU Модем</span>
                      </span>
                      <span className="text-[10px] font-mono text-teal-300">FTTH · dBm</span>
                    </button>
                  </div>
                )}

                {/* Category 3: Wireless Wi-Fi */}
                <button
                  type="button"
                  onClick={() => toggleCtxCategory('wireless')}
                  className="w-full flex items-center justify-between px-2.5 py-1 mt-0.5 rounded bg-slate-950/70 hover:bg-slate-800/80 text-[11px] font-semibold text-slate-300 transition-colors cursor-pointer"
                >
                  <span className="flex items-center gap-1.5">
                    <Wifi className="w-3 h-3 text-cyan-400 shrink-0" />
                    <span>Беспроводные сети Wi-Fi</span>
                  </span>
                  {ctxCategories.wireless ? (
                    <ChevronDown className="w-3 h-3 text-slate-400" />
                  ) : (
                    <ChevronRight className="w-3 h-3 text-slate-400" />
                  )}
                </button>
                {ctxCategories.wireless && (
                  <div className="pl-2 space-y-0.5">
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        onAddDeviceAtCenter('switch', 4, 'wlc');
                        setContextMenu(null);
                      }}
                      className="w-full flex items-center justify-between gap-2 px-2.5 py-1 rounded hover:bg-slate-800 text-slate-200 text-left transition-colors cursor-pointer"
                    >
                      <span className="flex items-center gap-2">
                        <Server className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                        <span>WLC Контроллер</span>
                      </span>
                      <span className="text-[10px] font-mono text-slate-400">CAPWAP</span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        onAddDeviceAtCenter('switch', 6, 'wifi_ap');
                        setContextMenu(null);
                      }}
                      className="w-full flex items-center justify-between gap-2 px-2.5 py-1 rounded hover:bg-slate-800 text-slate-200 text-left transition-colors cursor-pointer"
                    >
                      <span className="flex items-center gap-2">
                        <Wifi className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                        <span>Точка доступа AP</span>
                      </span>
                      <span className="text-[10px] font-mono text-slate-400">802.11 AP</span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        onAddDeviceAtCenter('router', 6, 'soho_wifi_router');
                        setContextMenu(null);
                      }}
                      className="w-full flex items-center justify-between gap-2 px-2.5 py-1 rounded hover:bg-slate-800 text-slate-200 text-left transition-colors cursor-pointer"
                    >
                      <span className="flex items-center gap-2">
                        <Radio className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                        <span>Wi-Fi Роутер</span>
                      </span>
                      <span className="text-[10px] font-mono text-slate-400">NAT+Wlan0</span>
                    </button>
                  </div>
                )}

                {/* Category 4: Endpoints */}
                <button
                  type="button"
                  onClick={() => toggleCtxCategory('endpoints')}
                  className="w-full flex items-center justify-between px-2.5 py-1 mt-0.5 rounded bg-slate-950/70 hover:bg-slate-800/80 text-[11px] font-semibold text-slate-300 transition-colors cursor-pointer"
                >
                  <span className="flex items-center gap-1.5">
                    <Monitor className="w-3 h-3 text-emerald-400 shrink-0" />
                    <span>Конечные устройства</span>
                  </span>
                  {ctxCategories.endpoints ? (
                    <ChevronDown className="w-3 h-3 text-slate-400" />
                  ) : (
                    <ChevronRight className="w-3 h-3 text-slate-400" />
                  )}
                </button>
                {ctxCategories.endpoints && (
                  <div className="pl-2 space-y-0.5">
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        onAddDeviceAtCenter('pc');
                        setContextMenu(null);
                      }}
                      className="w-full flex items-center justify-between gap-2 px-2.5 py-1 rounded hover:bg-slate-800 text-slate-200 text-left transition-colors cursor-pointer"
                    >
                      <span className="flex items-center gap-2">
                        <Monitor className="w-3.5 h-3.5 text-slate-200 shrink-0" />
                        <span>Хост (PC)</span>
                      </span>
                      <span className="text-[10px] font-mono text-slate-400">Eth0</span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        onAddDeviceAtCenter('server');
                        setContextMenu(null);
                      }}
                      className="w-full flex items-center justify-between gap-2 px-2.5 py-1 rounded hover:bg-slate-800 text-slate-200 text-left transition-colors cursor-pointer"
                    >
                      <span className="flex items-center gap-2">
                        <Server className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                        <span>Сервер (L7)</span>
                      </span>
                      <span className="text-[10px] font-mono text-slate-400">HTTP/DNS</span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        onAddDeviceAtCenter('pc', 6, 'laptop');
                        setContextMenu(null);
                      }}
                      className="w-full flex items-center justify-between gap-2 px-2.5 py-1 rounded hover:bg-slate-800 text-slate-200 text-left transition-colors cursor-pointer"
                    >
                      <span className="flex items-center gap-2">
                        <Laptop className="w-3.5 h-3.5 text-violet-400 shrink-0" />
                        <span>Ноутбук</span>
                      </span>
                      <span className="text-[10px] font-mono text-slate-400">Wlan0</span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        onAddDeviceAtCenter('pc', 6, 'smartphone');
                        setContextMenu(null);
                      }}
                      className="w-full flex items-center justify-between gap-2 px-2.5 py-1 rounded hover:bg-slate-800 text-slate-200 text-left transition-colors cursor-pointer"
                    >
                      <span className="flex items-center gap-2">
                        <Smartphone className="w-3.5 h-3.5 text-violet-400 shrink-0" />
                        <span>Смартфон</span>
                      </span>
                      <span className="text-[10px] font-mono text-slate-400">Wlan0</span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        onAddDeviceAtCenter('pc', 2, 'ip_phone');
                        setContextMenu(null);
                      }}
                      className="w-full flex items-center justify-between gap-2 px-2.5 py-1 rounded hover:bg-slate-800 text-slate-200 text-left transition-colors cursor-pointer"
                    >
                      <span className="flex items-center gap-2">
                        <PhoneCall className="w-3.5 h-3.5 text-fuchsia-400 shrink-0" />
                        <span>IP-Телефон (VoIP)</span>
                      </span>
                      <span className="text-[10px] font-mono text-slate-400">PoE · SIP</span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        onAddDeviceAtCenter('pc', 1, 'ip_camera');
                        setContextMenu(null);
                      }}
                      className="w-full flex items-center justify-between gap-2 px-2.5 py-1 rounded hover:bg-slate-800 text-slate-200 text-left transition-colors cursor-pointer"
                    >
                      <span className="flex items-center gap-2">
                        <Camera className="w-3.5 h-3.5 text-teal-400 shrink-0" />
                        <span>IP-Камера (PoE)</span>
                      </span>
                      <span className="text-[10px] font-mono text-slate-400">RTSP · 9.5W</span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        onAddDeviceAtCenter('server', 1, 'nvr');
                        setContextMenu(null);
                      }}
                      className="w-full flex items-center justify-between gap-2 px-2.5 py-1 rounded hover:bg-slate-800 text-slate-200 text-left transition-colors cursor-pointer"
                    >
                      <span className="flex items-center gap-2">
                        <Video className="w-3.5 h-3.5 text-teal-300 shrink-0" />
                        <span>Видеорегистратор NVR</span>
                      </span>
                      <span className="text-[10px] font-mono text-slate-400">NVR · 16TB</span>
                    </button>
                  </div>
                )}

                <div className="my-1 border-t border-slate-800" />
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onAddZone();
                    setContextMenu(null);
                  }}
                  className="w-full flex items-center justify-between gap-2 px-2.5 py-1 rounded hover:bg-slate-800 text-slate-200 text-left transition-colors cursor-pointer"
                >
                  <span className="flex items-center gap-2">
                    <Layers className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                    <span>Зона подсети</span>
                  </span>
                  <span className="text-[10px] font-mono text-slate-400">+VLAN</span>
                </button>
              </>
            )}
          </div>
        )}

        {/* Floating Subnet Zone Editor Window */}
        {editingZone && (
          <div
            data-testid="floating-zone-editor"
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            className="absolute top-4 right-4 z-40 w-80 rounded-xl bg-slate-900/98 border border-slate-700 shadow-2xl p-3.5 space-y-3 text-xs text-slate-200"
          >
            <div className="flex items-center justify-between pb-2 border-b border-slate-800">
              <div className="flex items-center gap-2 font-semibold text-sky-300">
                <Layers className="w-4 h-4" />
                <span>Настройка зоны подсети / VLAN</span>
              </div>
              <button
                type="button"
                onClick={() => setEditingZoneId(null)}
                className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 cursor-pointer"
              >
                Закрыть
              </button>
            </div>

            <div className="space-y-2">
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">
                  Название зоны (Title)
                </label>
                <input
                  type="text"
                  aria-label="Название зоны подсети"
                  value={editingZone.title}
                  onChange={(e) =>
                    onUpdateZone({ ...editingZone, title: e.target.value })
                  }
                  className="w-full px-2.5 py-1.5 rounded bg-slate-950 border border-slate-700 text-xs text-slate-100 focus:outline-none focus:border-sky-500"
                />
              </div>

              <div>
                <label className="block text-[11px] text-slate-400 mb-1">
                  Подсеть / VLAN аннотация
                </label>
                <input
                  type="text"
                  aria-label="Подсеть или аннотация зоны"
                  value={editingZone.subnetLabel}
                  onChange={(e) =>
                    onUpdateZone({ ...editingZone, subnetLabel: e.target.value })
                  }
                  className="w-full px-2.5 py-1.5 rounded bg-slate-950 border border-slate-700 text-xs font-mono text-sky-300 focus:outline-none focus:border-sky-500"
                />
              </div>

              <div>
                <label className="block text-[11px] text-slate-400 mb-1">
                  Цвет выделения
                </label>
                <div className="grid grid-cols-3 gap-1.5">
                  {(['sky', 'emerald', 'amber', 'indigo', 'purple', 'rose'] as ZoneColor[]).map(
                    (c) => (
                      <button
                        key={c}
                        type="button"
                        onClick={() => onUpdateZone({ ...editingZone, color: c })}
                        className={`px-2 py-1 rounded border text-[11px] capitalize cursor-pointer ${
                          editingZone.color === c
                            ? 'bg-sky-500/20 border-sky-400 text-white font-semibold'
                            : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-white'
                        }`}
                      >
                        {c}
                      </button>
                    )
                  )}
                </div>
              </div>

              <div className="pt-2 border-t border-slate-800 flex items-center justify-between">
                <button
                  type="button"
                  onClick={() => {
                    onDeleteZone(editingZone.id);
                    setEditingZoneId(null);
                  }}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-red-950/70 hover:bg-red-900/80 border border-red-500/40 text-red-300 cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Удалить зону</span>
                </button>
                <button
                  type="button"
                  onClick={() => setEditingZoneId(null)}
                  className="px-3 py-1 rounded bg-sky-600 hover:bg-sky-500 text-white font-medium cursor-pointer"
                >
                  Готово
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Contextual Mode Banner at Top of Canvas */}
        {(pendingPlacement ||
          activeTool !== 'select' ||
          (cableStart && openChassisNodes.length === 0) ||
          pduSourceNodeId) && (
          <div
            data-testid="canvas-mode-banner"
            className="absolute top-3 left-1/2 -translate-x-1/2 z-30 px-4 py-1.5 rounded-md bg-slate-900/95 border border-sky-500/50 shadow-lg flex items-center gap-3 text-xs text-slate-200"
          >
            {pendingPlacement && (
              <>
                <Plus className="w-4 h-4 text-sky-400 shrink-0" />
                <span>
                  Режим установки: <strong className="text-sky-300">«{pendingPlacement.label}»</strong> — кликните крестиком в нужную точку рабочей области для создания
                </span>
                {onCancelPendingPlacement && (
                  <button
                    type="button"
                    data-testid="cancel-pending-placement-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      onCancelPendingPlacement();
                    }}
                    className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white cursor-pointer shrink-0"
                  >
                    Отмена (Esc)
                  </button>
                )}
              </>
            )}
            {!pendingPlacement &&
              (activeTool === 'cable' || (cableStart && openChassisNodes.length === 0)) && (
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
            {!pendingPlacement && activeTool === 'pdu' && !cableStart && (
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
            {!pendingPlacement && activeTool === 'delete' && !cableStart && (
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
                if (selectedNodeId && !openChassisNodeIds.includes(selectedNodeId)) {
                  onOpenChassis(selectedNodeId);
                  setFocusedChassisId(selectedNodeId);
                } else if (openChassisNodeIds.length > 0) {
                  onCloseAllChassis();
                } else {
                  const targetId =
                    selectedNodeId ||
                    nodes.find((n) => n.type === 'switch')?.id ||
                    nodes[0]?.id;
                  if (targetId) {
                    onOpenChassis(targetId);
                    setFocusedChassisId(targetId);
                  }
                }
              }}
              className={`flex items-center gap-1 px-2 py-0.5 rounded transition-colors cursor-pointer ${
                openChassisNodeIds.length > 0
                  ? 'bg-sky-500/20 text-sky-300 font-medium'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
              title="Открыть переднюю панель 1U выбранного коммутатора или закрыть открытые панели 1U"
            >
              <Cpu className="w-3 h-3" />
              <span>
                1U Панель
                {openChassisNodeIds.length > 1 ? ` (${openChassisNodeIds.length})` : ''}
              </span>
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
              data-testid="toggle-wifi-coverage-btn"
              onClick={() => setShowWifiCoverage((v) => !v)}
              className={`flex items-center gap-1 px-2 py-0.5 rounded transition-colors cursor-pointer ${
                showWifiCoverage
                  ? 'bg-cyan-500/20 text-cyan-300 font-medium'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
              title="Показать или скрыть радиус радиопокрытия точек доступа Wi-Fi 802.11"
            >
              <Wifi className="w-3 h-3" />
              <span>Wi-Fi зоны</span>
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

            <div className="h-3.5 w-px bg-slate-800 mx-0.5" />

            {/* Cable Display Mode Switcher: Standard / Bandwidth & Load / QoS DSCP Queues */}
            <div
              data-testid="cable-heatmap-switcher"
              className="flex items-center gap-0.5 bg-slate-950/80 border border-slate-800 rounded p-0.5"
            >
              <button
                type="button"
                data-testid="cable-mode-standard"
                onClick={() => setCableDisplayMode('standard')}
                className={`px-1.5 py-0.5 rounded text-[10px] font-mono transition-colors cursor-pointer ${
                  cableDisplayMode === 'standard'
                    ? 'bg-slate-800 text-white font-semibold'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
                title="Стандартный режим отображения кабелей (Trunk / STP / Fiber)"
              >
                Кабели
              </button>

              <button
                type="button"
                data-testid="cable-mode-bandwidth"
                onClick={() => setCableDisplayMode('bandwidth')}
                className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono transition-colors cursor-pointer ${
                  cableDisplayMode === 'bandwidth'
                    ? 'bg-emerald-600/30 border border-emerald-500/50 text-emerald-200 font-semibold'
                    : 'text-slate-400 hover:text-emerald-300'
                }`}
                title="Карта полосы пропускания (100M / 1G / 10G / 480G), загрузки (%) и задержки (ms)"
              >
                <Gauge className="w-2.5 h-2.5" />
                <span>BW / Load</span>
              </button>

              <button
                type="button"
                data-testid="cable-mode-qos"
                onClick={() => setCableDisplayMode('qos')}
                className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono transition-colors cursor-pointer ${
                  cableDisplayMode === 'qos'
                    ? 'bg-fuchsia-600/30 border border-fuchsia-500/50 text-fuchsia-200 font-semibold'
                    : 'text-slate-400 hover:text-fuchsia-300'
                }`}
                title="Карта приоритетных очередей QoS (DSCP EF Голос / AF41 Видео / CS6 Control / BE Данные)"
              >
                <Activity className="w-2.5 h-2.5" />
                <span>QoS DSCP</span>
              </button>
            </div>

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

          {/* Active Cable Heatmap Legend Strip */}
          {cableDisplayMode === 'bandwidth' && (
            <div
              data-testid="cable-bandwidth-legend"
              className="flex flex-wrap items-center gap-2.5 px-3 py-1 bg-slate-900/95 border border-emerald-500/40 rounded-md text-[10px] font-mono text-slate-200 shadow-lg"
            >
              <span className="text-emerald-300 font-bold">КАРТА КАНАЛОВ (BW / LOAD):</span>
              <span className="text-sky-400">━ 100M FastEth</span>
              <span>·</span>
              <span className="text-emerald-400">━ 1G Gigabit</span>
              <span>·</span>
              <span className="text-cyan-300">━ 2G–4G LACP (Po#)</span>
              <span>·</span>
              <span className="text-amber-400">━ 10G Fiber / 480G Stack</span>
            </div>
          )}

          {cableDisplayMode === 'qos' && (
            <div
              data-testid="cable-qos-legend"
              className="flex flex-wrap items-center gap-2.5 px-3 py-1 bg-slate-900/95 border border-fuchsia-500/40 rounded-md text-[10px] font-mono text-slate-200 shadow-lg"
            >
              <span className="text-fuchsia-300 font-bold">ОЧЕРЕДИ QoS (DiffServ DSCP):</span>
              <span className="text-fuchsia-400">━ EF (DSCP 46 · VoIP RTP/SIP)</span>
              <span>·</span>
              <span className="text-purple-400">━ AF41 (DSCP 34 · CCTV RTSP)</span>
              <span>·</span>
              <span className="text-amber-400">━ CS6 (DSCP 48 · OSPF/BGP/STP)</span>
              <span>·</span>
              <span className="text-sky-400">━ BE (DSCP 0 · Data)</span>
            </div>
          )}

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
                          setEditingZoneId(zone.id);
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

            {/* IEEE 802.11 Wi-Fi Radial Coverage Zones */}
            {showWifiCoverage &&
              nodes
                .filter((n) => n.wifiConfig && n.wifiConfig.enabled)
                .map((apNode) => {
                  const cfg = apNode.wifiConfig!;
                  const r = Math.max(80, cfg.coverageRadius || 235);
                  const is5G = cfg.band === '5GHz';
                  const strokeColor = is5G ? '#a855f7' : '#06b6d4';
                  const fillColor = is5G
                    ? 'rgba(168, 85, 247, 0.065)'
                    : 'rgba(6, 182, 212, 0.065)';

                  return (
                    <g
                      key={`wifi-coverage-${apNode.id}`}
                      data-testid={`wifi-coverage-circle-${apNode.id}`}
                    >
                      <circle
                        cx={apNode.x}
                        cy={apNode.y}
                        r={r}
                        fill={fillColor}
                        stroke={strokeColor}
                        strokeWidth={1.6}
                        strokeDasharray="8 6"
                        strokeOpacity={0.65}
                      />
                      <circle
                        cx={apNode.x}
                        cy={apNode.y}
                        r={Math.round(r * 0.55)}
                        fill="none"
                        stroke={strokeColor}
                        strokeWidth={1}
                        strokeDasharray="3 6"
                        strokeOpacity={0.28}
                      />
                      <g transform={`translate(${apNode.x}, ${apNode.y - r + 14})`}>
                        <rect
                          x={-98}
                          y={-10}
                          width={196}
                          height={18}
                          rx={9}
                          fill="#020617"
                          fillOpacity={0.9}
                          stroke={strokeColor}
                          strokeWidth={1}
                          strokeOpacity={0.75}
                        />
                        <text
                          x={0}
                          y={2}
                          textAnchor="middle"
                          className="text-[9.5px] font-mono font-semibold fill-cyan-200 select-none"
                        >
                          Wi-Fi «{cfg.ssid}» · Ch {cfg.channel} ({cfg.band}) ·{' '}
                          {cfg.security === 'wpa2' ? 'WPA2' : 'Open'}
                        </text>
                      </g>
                    </g>
                  );
                })}

            {links.map((link) => {
              const srcNode = nodes.find((n) => n.id === link.sourceNodeId);
              const dstNode = nodes.find((n) => n.id === link.targetNodeId);
              if (!srcNode || !dstNode) return null;

              const srcPort = srcNode.interfaces.find((p) => p.id === link.sourcePortId);
              const dstPort = dstNode.interfaces.find((p) => p.id === link.targetPortId);
              const isUp = isLinkOperational(link, nodes);
              const isWireless = link.cableType === 'wireless';
              const isTrunk =
                !isWireless &&
                (srcPort?.vlanMode === 'trunk' || dstPort?.vlanMode === 'trunk');
              const srcStpState = !isWireless
                ? stpStateMap[srcNode.id]?.ports[link.sourcePortId]?.state
                : undefined;
              const dstStpState = !isWireless
                ? stpStateMap[dstNode.id]?.ports[link.targetPortId]?.state
                : undefined;
              const isStpBlocked = srcStpState === 'blocking' || dstStpState === 'blocking';
              const hasMovingPacketOnLink = packetSquares.some((p) => p.linkId === link.id);
              const isActiveStepLink =
                activeStep?.linkId === link.id ||
                hoveredLinkId === link.id ||
                hasMovingPacketOnLink;

              // Check if there are multiple parallel links between the same unordered node pair
              const pairA =
                link.sourceNodeId < link.targetNodeId ? link.sourceNodeId : link.targetNodeId;
              const pairB =
                link.sourceNodeId < link.targetNodeId ? link.targetNodeId : link.sourceNodeId;
              const siblingLinks = links.filter((l) => {
                const lA = l.sourceNodeId < l.targetNodeId ? l.sourceNodeId : l.targetNodeId;
                const lB = l.sourceNodeId < l.targetNodeId ? l.targetNodeId : l.sourceNodeId;
                return lA === pairA && lB === pairB;
              });
              const siblingIdx = siblingLinks.findIndex((l) => l.id === link.id);

              // Canonical normal vector from pairA -> pairB so parallel links never cross
              const canonNodeA = srcNode.id === pairA ? srcNode : dstNode;
              const canonNodeB = srcNode.id === pairA ? dstNode : srcNode;
              const canonDx = canonNodeB.x - canonNodeA.x;
              const canonDy = canonNodeB.y - canonNodeA.y;
              const canonLen = Math.max(1, Math.hypot(canonDx, canonDy));
              const normX = -canonDy / canonLen;
              const normY = canonDx / canonLen;
              const parallelOffsetPx =
                siblingLinks.length > 1
                  ? (siblingIdx - (siblingLinks.length - 1) / 2) * 20
                  : 0;

              const x1 = srcNode.x + normX * parallelOffsetPx;
              const y1 = srcNode.y + normY * parallelOffsetPx;
              const x2 = dstNode.x + normX * parallelOffsetPx;
              const y2 = dstNode.y + normY * parallelOffsetPx;

              const dx = x2 - x1;
              const dy = y2 - y1;
              const srcDotX = x1 + dx * 0.24;
              const srcDotY = y1 + dy * 0.24;
              const dstDotX = x1 + dx * 0.76;
              const dstDotY = y1 + dy * 0.76;

              const isBundledInPo = etherChannelBundles.some((b) =>
                b.memberLinkIds.includes(link.id)
              );
              const isStackLink =
                link.cableType === 'stack' || isStackInterconnectLink(link, nodes, links);

              const wifiMetrics = (() => {
                if (!isWireless) return null;
                const ap = isWifiAccessPointNode(srcNode) ? srcNode : dstNode;
                const cl = ap.id === srcNode.id ? dstNode : srcNode;
                return computeWifiSignalMetrics(cl, ap);
              })();

              const gponOpticalLink = (() => {
                if (!isGponLinkPair(srcNode, dstNode)) return null;
                const ont = isGponOntNode(srcNode) ? srcNode : dstNode;
                return computeGponOntOpticalState(ont, nodes, links);
              })();

              const linkHeatmap = linkHeatmapMap[link.id];

              const effectiveStrokeColor =
                !isUp || (gponOpticalLink && !gponOpticalLink.isPonUp)
                  ? '#ef4444'
                  : cableDisplayMode === 'bandwidth' && linkHeatmap
                  ? linkHeatmap.bandwidthStrokeHex
                  : cableDisplayMode === 'qos' && linkHeatmap
                  ? linkHeatmap.qosStrokeHex
                  : isActiveStepLink
                  ? '#38bdf8'
                  : gponOpticalLink
                  ? '#10b981'
                  : isWireless
                  ? '#06b6d4'
                  : isStackLink
                  ? '#fbbf24'
                  : isStpBlocked
                  ? '#f97316'
                  : isBundledInPo
                  ? '#22d3ee'
                  : link.cableType === 'fiber'
                  ? '#f59e0b'
                  : isTrunk
                  ? '#818cf8'
                  : '#64748b';

              return (
                <g
                  key={link.id}
                  data-testid={`canvas-link-${link.id}`}
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
                  {(isActiveStepLink ||
                    (isStackLink && isUp) ||
                    (cableDisplayMode !== 'standard' && isUp)) && (
                    <line
                      x1={x1}
                      y1={y1}
                      x2={x2}
                      y2={y2}
                      stroke={
                        cableDisplayMode !== 'standard'
                          ? effectiveStrokeColor
                          : isActiveStepLink
                          ? '#0ea5e9'
                          : '#f59e0b'
                      }
                      strokeWidth={isActiveStepLink ? 8 : 6}
                      strokeOpacity={
                        isActiveStepLink ? 0.34 : cableDisplayMode !== 'standard' ? 0.22 : 0.2
                      }
                      strokeLinecap="round"
                    />
                  )}

                  <line
                    x1={x1}
                    y1={y1}
                    x2={x2}
                    y2={y2}
                    stroke={effectiveStrokeColor}
                    strokeWidth={
                      isActiveStepLink
                        ? 3.2
                        : cableDisplayMode !== 'standard'
                        ? 2.8
                        : isStackLink
                        ? 3
                        : isWireless
                        ? 2.2
                        : isBundledInPo
                        ? 2.5
                        : 2.2
                    }
                    strokeDasharray={
                      isWireless
                        ? '4 5'
                        : isStackLink
                        ? undefined
                        : isStpBlocked
                        ? '4 4'
                        : link.cableType === 'crossover' || isTrunk
                        ? '6 4'
                        : undefined
                    }
                  />

                  {!isWireless &&
                    (srcPort?.adminStatus === 'up' ? (
                      <circle
                        cx={srcDotX}
                        cy={srcDotY}
                        r={srcStpState === 'blocking' ? 5 : 4}
                        fill={srcStpState === 'blocking' ? '#f97316' : '#10b981'}
                        stroke="#090d16"
                        strokeWidth={1.5}
                      />
                    ) : (
                      <polygon
                        points={`${srcDotX},${srcDotY - 5} ${srcDotX - 5},${srcDotY + 4} ${srcDotX + 5},${srcDotY + 4}`}
                        fill="#ef4444"
                      />
                    ))}

                  {!isWireless &&
                    (dstPort?.adminStatus === 'up' ? (
                      <circle
                        cx={dstDotX}
                        cy={dstDotY}
                        r={dstStpState === 'blocking' ? 5 : 4}
                        fill={dstStpState === 'blocking' ? '#f97316' : '#10b981'}
                        stroke="#090d16"
                        strokeWidth={1.5}
                      />
                    ) : (
                      <polygon
                        points={`${dstDotX},${dstDotY - 5} ${dstDotX - 5},${dstDotY + 4} ${dstDotX + 5},${dstDotY + 4}`}
                        fill="#ef4444"
                      />
                    ))}

                  {isWireless && showPortLabels && wifiMetrics && cableDisplayMode === 'standard' && (
                    <g transform={`translate(${(x1 + x2) / 2}, ${(y1 + y2) / 2})`}>
                      <rect
                        x={-48}
                        y={-9}
                        width={96}
                        height={16}
                        rx={8}
                        fill="#083344"
                        stroke={isUp ? '#06b6d4' : '#ef4444'}
                        strokeWidth={1}
                      />
                      <text
                        x={0}
                        y={2}
                        textAnchor="middle"
                        className="text-[9px] font-mono font-bold fill-cyan-200 select-none"
                      >
                        {isUp ? `802.11 · ${wifiMetrics.rssiDbm} dBm` : 'Вне зоны Wi-Fi'}
                      </text>
                    </g>
                  )}

                  {/* Bandwidth / Utilization / Latency Heatmap Midpoint Pill */}
                  {cableDisplayMode === 'bandwidth' && linkHeatmap && (
                    <g
                      data-testid={`link-bw-badge-${link.id}`}
                      transform={`translate(${(x1 + x2) / 2}, ${(y1 + y2) / 2})`}
                    >
                      <rect
                        x={-60}
                        y={-9}
                        width={120}
                        height={16}
                        rx={8}
                        fill="#090d16"
                        stroke={effectiveStrokeColor}
                        strokeWidth={1.2}
                      />
                      <text
                        x={0}
                        y={2.5}
                        textAnchor="middle"
                        className="text-[8.5px] font-mono font-bold fill-slate-100 select-none"
                      >
                        {!isUp
                          ? 'LINK DOWN'
                          : `${linkHeatmap.bandwidthLabel} · ${linkHeatmap.utilizationPercent}% · ${linkHeatmap.latencyMs}ms`}
                      </text>
                    </g>
                  )}

                  {/* QoS DSCP Queue Midpoint Pill */}
                  {cableDisplayMode === 'qos' && linkHeatmap && (
                    <g
                      data-testid={`link-qos-badge-${link.id}`}
                      transform={`translate(${(x1 + x2) / 2}, ${(y1 + y2) / 2})`}
                    >
                      <rect
                        x={-62}
                        y={-9}
                        width={124}
                        height={16}
                        rx={8}
                        fill="#090d16"
                        stroke={effectiveStrokeColor}
                        strokeWidth={1.2}
                      />
                      <text
                        x={0}
                        y={2.5}
                        textAnchor="middle"
                        className="text-[8.5px] font-mono font-bold fill-slate-100 select-none"
                      >
                        {!isUp
                          ? 'LINK DOWN'
                          : `${linkHeatmap.qosBadgeLabel} · ${linkHeatmap.qosDscpCode}`}
                      </text>
                    </g>
                  )}

                  {!isWireless && showPortLabels && (
                    <>
                      <text
                        x={srcDotX}
                        y={srcDotY - 7}
                        textAnchor="middle"
                        className={`text-[10px] font-mono select-none ${
                          srcStpState === 'blocking'
                            ? 'fill-orange-400 font-bold'
                            : isBundledInPo
                            ? 'fill-cyan-300'
                            : 'fill-slate-400'
                        }`}
                      >
                        {srcPort?.shortName}
                        {srcStpState === 'blocking' ? ' (BLK)' : ''}
                      </text>
                      <text
                        x={dstDotX}
                        y={dstDotY - 7}
                        textAnchor="middle"
                        className={`text-[10px] font-mono select-none ${
                          dstStpState === 'blocking'
                            ? 'fill-orange-400 font-bold'
                            : isBundledInPo
                            ? 'fill-cyan-300'
                            : 'fill-slate-400'
                        }`}
                      >
                        {dstPort?.shortName}
                        {dstStpState === 'blocking' ? ' (BLK)' : ''}
                      </text>
                    </>
                  )}

                  {isStackLink &&
                    showPortLabels &&
                    siblingIdx === 0 &&
                    cableDisplayMode === 'standard' && (
                    <g transform={`translate(${(x1 + x2) / 2}, ${(y1 + y2) / 2 - 9})`}>
                      <rect
                        x={-54}
                        y={-9}
                        width={108}
                        height={15}
                        rx={7}
                        fill="#451a03"
                        stroke="#fbbf24"
                        strokeWidth={1}
                      />
                      <text
                        x={0}
                        y={1.5}
                        textAnchor="middle"
                        className="text-[9px] font-mono font-bold fill-amber-200 select-none"
                      >
                        {srcNode.type === 'switch' ? 'StackWise 480G' : 'HA Stack · 80G'}
                      </text>
                    </g>
                  )}

                  {gponOpticalLink && showPortLabels && cableDisplayMode === 'standard' && (
                    <g
                      data-testid={`gpon-link-badge-${link.id}`}
                      transform={`translate(${(x1 + x2) / 2}, ${(y1 + y2) / 2 - 9})`}
                    >
                      <rect
                        x={-68}
                        y={-9}
                        width={136}
                        height={15}
                        rx={7}
                        fill={gponOpticalLink.isPonUp ? '#022c22' : '#450a0a'}
                        stroke={gponOpticalLink.isPonUp ? '#10b981' : '#ef4444'}
                        strokeWidth={1}
                      />
                      <text
                        x={0}
                        y={1.5}
                        textAnchor="middle"
                        className={`text-[9px] font-mono font-bold select-none ${
                          gponOpticalLink.isPonUp ? 'fill-emerald-200' : 'fill-red-200'
                        }`}
                      >
                        {gponOpticalLink.isLos
                          ? `GPON LOS (${gponOpticalLink.rxPowerDbm.toFixed(1)} dBm)`
                          : !gponOpticalLink.isSnAuthorized
                          ? 'GPON SN UNAUTH'
                          : `1490/1310nm · ${gponOpticalLink.rxPowerDbm.toFixed(1)} dBm`}
                      </text>
                    </g>
                  )}

                  {(isTrunk || isStpBlocked) &&
                    !isStackLink &&
                    !gponOpticalLink &&
                    !isBundledInPo &&
                    !isWireless &&
                    showPortLabels &&
                    cableDisplayMode === 'standard' && (
                    <text
                      x={(x1 + x2) / 2}
                      y={(y1 + y2) / 2 - 7}
                      textAnchor="middle"
                      className={`text-[10px] font-mono font-semibold ${
                        isStpBlocked ? 'fill-orange-400' : 'fill-indigo-300'
                      }`}
                    >
                      {isStpBlocked ? 'STP 802.1D BLK' : '802.1Q Trunk'}
                    </text>
                  )}
                </g>
              );
            })}

            {/* Cisco Packet Tracer Style EtherChannel / LACP Oval Ring Overlay (Po1..Po6) */}
            {etherChannelBundles.map((bundle) => {
              const nodeA = nodes.find((n) => n.id === bundle.nodeAId);
              const nodeB = nodes.find((n) => n.id === bundle.nodeBId);
              if (!nodeA || !nodeB) return null;

              const midX = (nodeA.x + nodeB.x) / 2;
              const midY = (nodeA.y + nodeB.y) / 2;
              const angleDeg =
                (Math.atan2(nodeB.y - nodeA.y, nodeB.x - nodeA.x) * 180) / Math.PI;
              const ry = Math.max(18, bundle.memberLinkIds.length * 11);

              return (
                <g
                  key={`etherchannel-ring-${bundle.bundleKey}`}
                  data-testid={`etherchannel-oval-ring-${bundle.portChannelName}`}
                >
                  <ellipse
                    cx={midX}
                    cy={midY}
                    rx={12}
                    ry={ry}
                    transform={`rotate(${angleDeg} ${midX} ${midY})`}
                    fill="rgba(6, 182, 212, 0.14)"
                    stroke="#22d3ee"
                    strokeWidth={2.2}
                  />
                  {showPortLabels && (
                    <g transform={`translate(${midX}, ${midY - ry - 11})`}>
                      <rect
                        x={-58}
                        y={-10}
                        width={116}
                        height={16}
                        rx={4}
                        fill="#083344"
                        stroke="#22d3ee"
                        strokeWidth={1}
                      />
                      <text
                        x={0}
                        y={1}
                        textAnchor="middle"
                        className="text-[9px] font-mono font-bold fill-cyan-200 select-none"
                      >
                        {bundle.portChannelName} · {bundle.protocol}{' '}
                        {bundle.aggregatedBandwidthMbps >= 1000
                          ? `${bundle.aggregatedBandwidthMbps / 1000}G`
                          : `${bundle.aggregatedBandwidthMbps}M`}
                      </text>
                    </g>
                  )}
                </g>
              );
            })}

            {/* Motion Trails for Multi-Packet Stream Squares */}
            {packetSquares.map((pkt) => (
              <g key={`trail-${pkt.id}`}>
                <line
                  x1={pkt.tailX}
                  y1={pkt.tailY}
                  x2={pkt.x}
                  y2={pkt.y}
                  stroke={pkt.visual.trailHex}
                  strokeWidth={pkt.isPrimaryActive ? 5.5 : 4}
                  strokeOpacity={0.35}
                  strokeLinecap="round"
                />
                <line
                  x1={pkt.tailX}
                  y1={pkt.tailY}
                  x2={pkt.x}
                  y2={pkt.y}
                  stroke={pkt.visual.fillHex}
                  strokeWidth={pkt.isPrimaryActive ? 2.5 : 2}
                  strokeOpacity={0.9}
                  strokeLinecap="round"
                />
              </g>
            ))}
          </svg>

          {/* Layer 3: HTML Overlay Layer for Devices */}
          {nodes.map((node) => {
            const isSelected = node.id === selectedNodeId;
            const isChassisOpen = openChassisNodeIds.includes(node.id);
            const isPcMonitorOpen = openPcMonitorNodeIds.includes(node.id);
            const isPduSource = node.id === pduSourceNodeId;
            const logicalIfaces = getRouterLogicalInterfaces(node);
            const primaryIface =
              logicalIfaces.find((i) => i.ipAddress) || node.interfaces[0];
            const nodeStp = stpStateMap[node.id];

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
                  if (node.type === 'pc' || node.type === 'server') {
                    onOpenPcMonitor(node.id);
                  } else {
                    onOpenWebGui(node.id);
                  }
                }}
                onContextMenu={(e) => handleNodeContextMenu(e, node)}
                className="absolute z-20 flex flex-col items-center group cursor-pointer"
              >
                {/* Quick Nearby Action Buttons on Top of Device */}
                <div
                  className={`absolute -top-3.5 -right-4 z-30 flex items-center gap-1 transition-opacity ${
                    isSelected || isChassisOpen || isPcMonitorOpen
                      ? 'opacity-100'
                      : 'opacity-0 group-hover:opacity-100'
                  }`}
                >
                  {node.type === 'pc' ? (
                    <button
                      type="button"
                      aria-label={
                        isVoipPhoneNode(node)
                          ? `Открыть панель IP-телефона ${node.name}`
                          : isIpCameraNode(node)
                          ? `Открыть панель IP-камеры ${node.name}`
                          : `Открыть монитор ПК ${node.name}`
                      }
                      title={
                        isVoipPhoneNode(node)
                          ? `Открыть IP-телефон (${node.name}): набор SIP-номера, Voice/Data VLAN и PoE`
                          : isIpCameraNode(node)
                          ? `Открыть IP-камеру (${node.name}): видеопоток RTSP / Multicast, PoE 802.3af и CCTV VLAN`
                          : `Открыть монитор ПК (${node.name}): сетевые настройки IP/маски и консоль CMD`
                      }
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelectZone(null);
                        onSelectNode(node.id);
                        onOpenPcMonitor(node.id);
                      }}
                      className={`px-2 py-0.5 rounded-full border text-[9px] font-mono font-bold shadow-md flex items-center gap-1 cursor-pointer transition-colors ${
                        isPcMonitorOpen
                          ? isVoipPhoneNode(node)
                            ? 'bg-fuchsia-600 border-fuchsia-300 text-white'
                            : isIpCameraNode(node)
                            ? 'bg-teal-600 border-teal-300 text-white'
                            : 'bg-sky-600 border-sky-300 text-white'
                          : isVoipPhoneNode(node)
                          ? 'bg-fuchsia-950 border-fuchsia-400/90 text-fuchsia-200 hover:bg-fuchsia-600 hover:text-white'
                          : isIpCameraNode(node)
                          ? 'bg-teal-950 border-teal-400/90 text-teal-200 hover:bg-teal-600 hover:text-white'
                          : 'bg-sky-950 border-sky-400/90 text-sky-200 hover:bg-sky-600 hover:text-white'
                      }`}
                    >
                      {isVoipPhoneNode(node) ? (
                        <PhoneCall className="w-2.5 h-2.5" />
                      ) : isIpCameraNode(node) ? (
                        <Camera className="w-2.5 h-2.5" />
                      ) : (
                        <Monitor className="w-2.5 h-2.5" />
                      )}
                      <span>
                        {isVoipPhoneNode(node)
                          ? 'SIP Вызов'
                          : isIpCameraNode(node)
                          ? 'RTSP Камера'
                          : 'Экран ПК'}
                      </span>
                    </button>
                  ) : node.type === 'server' ? (
                    <>
                      <button
                        type="button"
                        aria-label={`Открыть панель сервера ${node.name}`}
                        title={`Открыть панель Сервера (${node.name}): Службы L7 HTTP / DNS / DHCP / NVR, сеть и консоль`}
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelectZone(null);
                          onSelectNode(node.id);
                          onOpenPcMonitor(node.id);
                        }}
                        className={`px-2 py-0.5 rounded-full border text-[9px] font-mono font-bold shadow-md flex items-center gap-1 cursor-pointer transition-colors ${
                          isPcMonitorOpen
                            ? isNvrServerNode(node)
                              ? 'bg-teal-600 border-teal-300 text-white'
                              : 'bg-amber-600 border-amber-300 text-white'
                            : isNvrServerNode(node)
                            ? 'bg-teal-950 border-teal-400/90 text-teal-200 hover:bg-teal-600 hover:text-white'
                            : 'bg-amber-950 border-amber-400/90 text-amber-200 hover:bg-amber-600 hover:text-white'
                        }`}
                      >
                        {isNvrServerNode(node) ? (
                          <Video className="w-2.5 h-2.5" />
                        ) : (
                          <Server className="w-2.5 h-2.5" />
                        )}
                        <span>{isNvrServerNode(node) ? 'NVR Архив' : 'Службы L7'}</span>
                      </button>

                      <button
                        type="button"
                        aria-label={`Открыть 1U панель ${node.name}`}
                        title={`Открыть плавающее окно портов 1U (${node.name})`}
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelectZone(null);
                          onSelectNode(node.id);
                          onOpenChassis(node.id);
                          setFocusedChassisId(node.id);
                        }}
                        className={`px-1.5 py-0.5 rounded-full border text-[9px] font-mono font-bold shadow-md flex items-center gap-0.5 cursor-pointer transition-colors ${
                          isChassisOpen
                            ? 'bg-sky-600 border-sky-300 text-white'
                            : 'bg-sky-950 border-sky-400/80 text-sky-200 hover:bg-sky-600 hover:text-white'
                        }`}
                      >
                        <Cpu className="w-2.5 h-2.5" />
                        <span>1U</span>
                      </button>

                      <button
                        type="button"
                        aria-label={`Открыть CLI окно ${node.name}`}
                        title="Открыть плавающий терминал CLI"
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenFloatingCli(node.id);
                        }}
                        className="p-1 rounded-full bg-emerald-950 border border-emerald-500/70 text-emerald-300 hover:bg-emerald-600 hover:text-white shadow-md cursor-pointer"
                      >
                        <Terminal className="w-3 h-3" />
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        aria-label={`Открыть 1U панель ${node.name}`}
                        title={`Открыть плавающее окно портов 1U (${node.name})`}
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelectZone(null);
                          onSelectNode(node.id);
                          onOpenChassis(node.id);
                          setFocusedChassisId(node.id);
                        }}
                        className={`px-1.5 py-0.5 rounded-full border text-[9px] font-mono font-bold shadow-md flex items-center gap-0.5 cursor-pointer transition-colors ${
                          isChassisOpen
                            ? 'bg-sky-600 border-sky-300 text-white'
                            : 'bg-sky-950 border-sky-400/80 text-sky-200 hover:bg-sky-600 hover:text-white'
                        }`}
                      >
                        <Cpu className="w-2.5 h-2.5" />
                        <span>1U</span>
                      </button>

                      <button
                        type="button"
                        aria-label={`Открыть веб-интерфейс ${node.name}`}
                        title={
                          node.type === 'router'
                            ? 'Открыть плавающую панель роутера (Порты, 802.1Q, OSPF, NAT, ACL, DHCP)'
                            : 'Открыть плавающий Веб-интерфейс коммутатора (Порты, VLAN, STP, MAC)'
                        }
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelectZone(null);
                          onSelectNode(node.id);
                          onOpenWebGui(node.id);
                        }}
                        className="px-1.5 py-0.5 rounded-full bg-indigo-950 border border-indigo-400/80 text-[9px] font-mono font-bold text-indigo-200 hover:bg-indigo-600 hover:text-white shadow-md flex items-center gap-0.5 cursor-pointer"
                      >
                        <Globe className="w-2.5 h-2.5" />
                        <span>{node.type === 'router' ? 'GUI' : 'WEB'}</span>
                      </button>

                      <button
                        type="button"
                        aria-label={`Открыть CLI окно ${node.name}`}
                        title="Открыть плавающий терминал CLI"
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenFloatingCli(node.id);
                        }}
                        className="p-1 rounded-full bg-emerald-950 border border-emerald-500/70 text-emerald-300 hover:bg-emerald-600 hover:text-white shadow-md cursor-pointer"
                      >
                        <Terminal className="w-3 h-3" />
                      </button>
                    </>
                  )}
                </div>

                {/* Device Chassis Box */}
                {(() => {
                  const ontOptical = isGponOntNode(node)
                    ? computeGponOntOpticalState(node, nodes, links)
                    : null;

                  return (
                    <div
                      className={`relative w-13 h-13 rounded-lg bg-slate-900 border-2 flex flex-col items-center justify-center transition-transform shadow-lg ${
                        isSelected
                          ? 'border-sky-400 ring-2 ring-sky-500/30 scale-105'
                          : isPduSource
                          ? 'border-emerald-400 ring-2 ring-emerald-500/30'
                          : cableStart && cableStart.nodeId !== node.id
                          ? 'border-sky-500/70 hover:border-sky-300 scale-105'
                          : ontOptical && (ontOptical.isLos || !ontOptical.isSnAuthorized)
                          ? 'border-red-500 ring-2 ring-red-500/35'
                          : node.deviceModel === 'gpon_olt'
                          ? 'border-emerald-500/75 hover:border-emerald-400'
                          : node.deviceModel === 'gpon_ont'
                          ? 'border-teal-500/75 hover:border-teal-400'
                          : node.deviceModel === 'firewall'
                          ? 'border-rose-500/70 hover:border-rose-400'
                          : node.deviceModel === 'isp_cloud'
                          ? 'border-orange-500/70 hover:border-orange-400'
                          : node.deviceModel === 'wlc' ||
                            node.deviceModel === 'wifi_ap' ||
                            node.deviceModel === 'soho_wifi_router'
                          ? 'border-cyan-500/60 hover:border-cyan-400'
                          : node.deviceModel === 'laptop' || node.deviceModel === 'smartphone'
                          ? 'border-violet-500/50 hover:border-violet-400'
                          : node.deviceModel === 'ip_phone'
                          ? 'border-fuchsia-500/60 hover:border-fuchsia-400'
                          : node.deviceModel === 'ip_camera' || node.deviceModel === 'nvr'
                          ? 'border-teal-500/60 hover:border-teal-400'
                          : 'border-slate-700 hover:border-slate-500'
                      }`}
                    >
                      {/* Red LOS Hardware LED Indicator on ONT Chassis */}
                      {ontOptical && (
                        <span
                          data-testid={`ont-canvas-los-led-${node.id}`}
                          title={
                            ontOptical.isLos
                              ? `LOS ALARM: Сигнал ${ontOptical.rxPowerDbm.toFixed(1)} dBm < -28.0 dBm`
                              : `PON OK: Сигнал ${ontOptical.rxPowerDbm.toFixed(1)} dBm`
                          }
                          className={`absolute top-1 left-1 w-2.5 h-2.5 rounded-full border ${
                            ontOptical.isLos
                              ? 'bg-red-500 border-red-200 shadow-[0_0_8px_#ef4444] animate-pulse'
                              : ontOptical.isPonUp
                              ? 'bg-emerald-400 border-emerald-200 shadow-[0_0_6px_#10b981]'
                              : 'bg-amber-400 border-amber-200'
                          }`}
                        />
                      )}
                      {renderDeviceIcon(node)}
                      <span className="text-[9px] font-mono text-slate-400 mt-0.5 uppercase">
                        {node.deviceModel === 'gpon_olt'
                          ? 'OLT'
                          : node.deviceModel === 'gpon_ont'
                          ? 'ONT/ONU'
                          : node.deviceModel === 'firewall'
                          ? 'ASA/FW'
                          : node.deviceModel === 'isp_cloud'
                          ? 'ISP/WAN'
                          : node.deviceModel === 'wlc'
                          ? 'WLC'
                          : node.deviceModel === 'wifi_ap'
                          ? node.wifiConfig?.apMode === 'lightweight'
                            ? 'LAP'
                            : 'AP'
                          : node.deviceModel === 'soho_wifi_router'
                          ? 'SOHO'
                          : node.deviceModel === 'laptop'
                          ? 'LAPTOP'
                          : node.deviceModel === 'smartphone'
                          ? 'PHONE'
                          : node.deviceModel === 'ip_phone'
                          ? 'VOIP'
                          : node.deviceModel === 'ip_camera'
                          ? 'CCTV'
                          : node.deviceModel === 'nvr'
                          ? 'NVR'
                          : node.type}
                      </span>
                    </div>
                  );
                })()}

                {/* Compact Device Hostname + Primary IP or Switch Port Status Caption */}
                {(() => {
                  const stackInfo =
                    node.type === 'switch' || node.type === 'router'
                      ? getNodeStackStatus(node.id, nodes, links)
                      : null;
                  const pdPoeState =
                    node.deviceModel === 'ip_phone' ||
                    node.deviceModel === 'wifi_ap' ||
                    node.deviceModel === 'ip_camera'
                      ? getPoweredDevicePoeState(node, nodes, links)
                      : null;
                  const swPoeStatus =
                    node.type === 'switch' &&
                    !node.wifiConfig &&
                    node.deviceModel !== 'wlc' &&
                    !isGponOltNode(node) &&
                    !isGponOntNode(node)
                      ? computeSwitchPoeStatus(node, nodes, links)
                      : null;
                  const ontOptical = isGponOntNode(node)
                    ? computeGponOntOpticalState(node, nodes, links)
                    : null;

                  return (
                    <div className="mt-1 px-2 py-0.5 rounded bg-slate-950/90 border border-slate-800/90 text-center whitespace-nowrap">
                      <div className="text-xs font-semibold text-slate-100 leading-tight flex items-center justify-center gap-1">
                        <span>{node.name}</span>
                        {stackInfo && (
                          <span
                            data-testid={`stack-badge-${node.id}`}
                            className={`text-[9px] font-mono px-1 py-0.2 rounded border ${
                              stackInfo.member.role === 'master'
                                ? 'bg-amber-500/20 border-amber-400/60 text-amber-300'
                                : 'bg-sky-500/20 border-sky-400/50 text-sky-300'
                            }`}
                          >
                            #{stackInfo.member.memberNumber}{' '}
                            {stackInfo.member.role === 'master'
                              ? 'MASTER'
                              : stackInfo.member.role === 'standby'
                              ? 'STANDBY'
                              : 'MEMBER'}
                          </span>
                        )}
                      </div>
                      {node.type !== 'switch' && primaryIface?.ipAddress && (
                        <div className="text-[10px] font-mono text-sky-300 leading-tight">
                          {formatCidr(primaryIface.ipAddress, primaryIface.subnetMask)}
                          {stackInfo?.group.virtualIp && (
                            <span className="text-amber-300 ml-1">
                              · VIP {stackInfo.group.virtualIp}
                            </span>
                          )}
                        </div>
                      )}
                      {node.deviceModel === 'ip_phone' && node.voipConfig && (
                        <div className="text-[9px] font-mono text-fuchsia-300 leading-tight flex items-center justify-center gap-1">
                          <span>
                            Ext {node.voipConfig.extension} · Voice VLAN {node.voipConfig.voiceVlan}
                          </span>
                          {pdPoeState && (
                            <span
                              data-testid={`poe-pd-badge-${node.id}`}
                              className={`px-1 rounded border text-[8.5px] font-bold ${
                                pdPoeState.isPowered
                                  ? 'bg-emerald-950/90 border-emerald-500/60 text-emerald-300'
                                  : 'bg-red-950/90 border-red-500/70 text-red-300'
                              }`}
                            >
                              {pdPoeState.isPowered
                                ? `⚡ ${pdPoeState.watts}W PoE`
                                : '⚡ PoE OFF'}
                            </span>
                          )}
                        </div>
                      )}
                      {node.deviceModel === 'ip_camera' && node.ipCameraConfig && (
                        <div className="text-[9px] font-mono text-teal-300 leading-tight flex items-center justify-center gap-1">
                          <span>
                            {node.ipCameraConfig.streamMode === 'multicast'
                              ? `Mcast ${node.ipCameraConfig.multicastGroupIp || '239.0.30.1'}`
                              : `RTSP ${(node.ipCameraConfig.codec || node.ipCameraConfig.videoCodec || 'H.265').split(' ')[0]}`}{' '}
                            · VLAN {node.ipCameraConfig.surveillanceVlan ?? 30}
                          </span>
                          {pdPoeState && (
                            <span
                              data-testid={`poe-pd-badge-${node.id}`}
                              className={`px-1 rounded border text-[8.5px] font-bold ${
                                pdPoeState.isPowered
                                  ? 'bg-emerald-950/90 border-emerald-500/60 text-emerald-300'
                                  : 'bg-red-950/90 border-red-500/70 text-red-300'
                              }`}
                            >
                              {pdPoeState.isPowered
                                ? `⚡ ${pdPoeState.watts}W PoE`
                                : '⚡ PoE OFF'}
                            </span>
                          )}
                        </div>
                      )}
                      {node.deviceModel === 'nvr' && (
                        <div className="text-[9px] font-mono text-teal-300 leading-tight">
                          NVR · RAID-6 {node.services?.nvrStorageTb ?? 16}TB · TCP 554
                        </div>
                      )}
                      {node.deviceModel === 'firewall' && (
                        <div className="text-[9px] font-mono text-rose-300 leading-tight">
                          SPI · IN:100 DMZ:50 OUT:0
                        </div>
                      )}
                      {node.bgpConfig?.enabled && (
                        <div
                          data-testid={`bgp-asn-caption-${node.id}`}
                          className="text-[9px] font-mono text-orange-300 leading-tight flex items-center justify-center gap-1"
                        >
                          <span className="font-bold">AS {node.bgpConfig.asn} · eBGP</span>
                          {node.wanImpairment?.enabled && (
                            <span
                              data-testid={`wan-impairment-badge-${node.id}`}
                              className={`px-1 rounded border text-[8.5px] font-bold ${
                                node.wanImpairment.packetLossPercent >= 50 ||
                                node.wanImpairment.bandwidthLimitMbps <= 0
                                  ? 'bg-red-950/90 border-red-500/70 text-red-300'
                                  : node.wanImpairment.packetLossPercent > 0 ||
                                    node.wanImpairment.latencyMs >= 100
                                  ? 'bg-amber-950/90 border-amber-500/60 text-amber-300'
                                  : 'bg-emerald-950/90 border-emerald-500/60 text-emerald-300'
                              }`}
                            >
                              ⏱ {node.wanImpairment.latencyMs}ms · Loss{' '}
                              {node.wanImpairment.packetLossPercent}% ·{' '}
                              {node.wanImpairment.bandwidthLimitMbps}M
                            </span>
                          )}
                        </div>
                      )}
                      {!node.bgpConfig?.enabled && node.wanImpairment?.enabled && (
                        <div
                          data-testid={`wan-impairment-badge-${node.id}`}
                          className="text-[9px] font-mono text-orange-300 leading-tight"
                        >
                          WAN ⏱ {node.wanImpairment.latencyMs}ms · Loss{' '}
                          {node.wanImpairment.packetLossPercent}% ·{' '}
                          {node.wanImpairment.bandwidthLimitMbps}Mbps
                        </div>
                      )}
                      {node.deviceModel === 'wlc' && node.wlcConfig && (
                        <div className="text-[9px] font-mono text-cyan-300 leading-tight">
                          CAPWAP · {node.wlcConfig.managementIp}
                        </div>
                      )}
                      {node.wifiConfig?.enabled && (
                        <div className="text-[9px] font-mono text-cyan-300 leading-tight flex items-center justify-center gap-1">
                          <span>
                            {node.wifiConfig.apMode === 'lightweight'
                              ? `CAPWAP · Ch ${node.wifiConfig.channel} (${node.wifiConfig.ssid})`
                              : `SSID: ${node.wifiConfig.ssid} (${node.wifiConfig.band})`}
                          </span>
                          {pdPoeState && pdPoeState.switchNodeName && (
                            <span
                              data-testid={`poe-pd-badge-${node.id}`}
                              className={`px-1 rounded border text-[8.5px] font-bold ${
                                pdPoeState.isPowered
                                  ? 'bg-emerald-950/90 border-emerald-500/60 text-emerald-300'
                                  : 'bg-red-950/90 border-red-500/70 text-red-300'
                              }`}
                            >
                              {pdPoeState.isPowered
                                ? `⚡ ${pdPoeState.watts}W`
                                : '⚡ PoE OFF'}
                            </span>
                          )}
                        </div>
                      )}
                      {isGponOltNode(node) && (
                        <div
                          data-testid={`gpon-olt-caption-${node.id}`}
                          className="text-[9px] font-mono text-emerald-300 leading-tight"
                        >
                          1490/1310nm · TX +{node.gponOltConfig?.txPowerDbm ?? 3.5}dBm · Сплиттер{' '}
                          {node.gponOltConfig?.splitterRatio || '1:16'}
                        </div>
                      )}
                      {isGponOntNode(node) && ontOptical && (
                        <div
                          data-testid={`gpon-ont-caption-${node.id}`}
                          className="text-[9px] font-mono leading-tight flex flex-col items-center gap-0.5"
                        >
                          <div className="flex items-center justify-center gap-1">
                            <span className="text-teal-300">{ontOptical.serialNumber}</span>
                            <span
                              data-testid={`gpon-ont-dbm-badge-${node.id}`}
                              className={`px-1 rounded border text-[8.5px] font-bold ${
                                ontOptical.isLos
                                  ? 'bg-red-950/95 border-red-500 text-red-200 animate-pulse'
                                  : !ontOptical.isSnAuthorized
                                  ? 'bg-amber-950/95 border-amber-500 text-amber-200'
                                  : 'bg-emerald-950/90 border-emerald-500/60 text-emerald-300'
                              }`}
                            >
                              {ontOptical.isLos
                                ? `LOS ${ontOptical.rxPowerDbm.toFixed(1)} dBm`
                                : !ontOptical.isSnAuthorized
                                ? 'SN UNAUTH'
                                : `RX ${ontOptical.rxPowerDbm.toFixed(1)} dBm`}
                            </span>
                          </div>
                          <div className="text-[8.5px] text-slate-400">
                            P1:Inet(100) · P2:IPTV(200) · P3:VoIP(300)
                          </div>
                        </div>
                      )}
                      {node.type === 'switch' &&
                        !node.wifiConfig &&
                        node.deviceModel !== 'wlc' &&
                        !isGponOltNode(node) &&
                        !isGponOntNode(node) && (
                        <div className="text-[9px] font-mono text-indigo-300 leading-tight">
                          {stackInfo && (
                            <span className="text-amber-300 font-bold mr-1">
                              {stackInfo.group.protocol} ·
                            </span>
                          )}
                          {node.ipRoutingEnabled && (
                            <span className="text-emerald-300 font-bold mr-1">L3 SVI ·</span>
                          )}
                          {swPoeStatus && swPoeStatus.usedWatts > 0 && (
                            <span
                              data-testid={`switch-poe-caption-${node.id}`}
                              className="text-amber-300 font-bold mr-1"
                            >
                              ⚡ PoE {swPoeStatus.usedWatts}W/{swPoeStatus.totalBudgetWatts}W ·
                            </span>
                          )}
                          {
                            node.interfaces.filter((iface) =>
                              isPortUsed(node.id, iface.id)
                            ).length
                          }
                          /{node.interfaces.length} RJ-45 ·{' '}
                          {nodeStp?.isRootBridge ? 'STP ROOT' : '1U'}
                        </div>
                      )}
                    </div>
                  );
                })()}

                {/* Port Picker Popover when Cable Tool is active */}
                {portPickerNodeId === node.id && (
                  <div
                    onClick={(e) => e.stopPropagation()}
                    className="absolute top-16 z-30 w-52 max-h-60 overflow-y-auto bg-slate-900 border border-slate-700 rounded-md shadow-xl p-2 space-y-1"
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

          {/* Layer 4: Multi-Packet Live Stream of Clickable 10x10 Protocol Squares */}
          {packetSquares.map((pkt) => (
            <button
              key={pkt.id}
              type="button"
              data-testid={`canvas-packet-square-${pkt.stepIndexZeroBased}`}
              data-protocol-category={pkt.visual.category}
              onClick={(e) => {
                e.stopPropagation();
                onSelectAndInspectPacketSquare(pkt.step, pkt.stepIndexZeroBased);
              }}
              style={{
                left: `${pkt.x}px`,
                top: `${pkt.y}px`,
                transform: 'translate(-50%, -50%)',
              }}
              aria-label={`Пакет #${pkt.step.stepIndex} ${pkt.step.protocol} (${pkt.step.fromNodeName} → ${pkt.step.toNodeName})`}
              title={`#${pkt.step.stepIndex} ${pkt.step.protocol} (${pkt.step.fromNodeName}:${pkt.step.fromPortName} → ${pkt.step.toNodeName}:${pkt.step.toPortName}) — кликните для паузы и разбора OSI PDU`}
              className="absolute z-30 flex items-center gap-1 group cursor-pointer focus:outline-none"
            >
              {/* The 10x10 px Rounded-2px Glowing Protocol Square */}
              <span
                className={`w-[10px] h-[10px] rounded-[2px] border flex items-center justify-center text-[8px] font-mono font-bold leading-none transition-transform group-hover:scale-150 ${
                  pkt.visual.squareClass
                } ${pkt.isPrimaryActive ? 'ring-2 ring-white/95 scale-125' : ''}`}
              >
                {pkt.visual.isDropped ? '×' : ''}
              </span>

              {/* Floating Micro-Tag (visible on primary active step, dropped packets, or on hover) */}
              <span
                className={`px-1.5 py-0.5 rounded-[3px] border text-[9px] font-mono font-semibold leading-none whitespace-nowrap shadow-lg transition-opacity pointer-events-none ${
                  pkt.isPrimaryActive || pkt.visual.isDropped
                    ? 'opacity-100'
                    : 'opacity-0 group-hover:opacity-100'
                } ${
                  pkt.visual.isDropped
                    ? 'bg-red-950/95 border-red-400 text-red-100'
                    : 'bg-slate-950/95 border-slate-600 text-white'
                }`}
              >
                <span style={{ color: pkt.visual.trailHex }}>{pkt.visual.shortLabel}</span>
                <span className="ml-1 text-slate-300">#{pkt.step.stepIndex}</span>
              </span>
            </button>
          ))}

          {/* Layer 5: Crosshair & Ghost Device/Zone Placement Preview */}
          {pendingPlacement && hoverCanvasPos && (
            <div
              data-testid="canvas-placement-ghost"
              style={{
                left: `${hoverCanvasPos.x}px`,
                top: `${hoverCanvasPos.y}px`,
                transform: 'translate(-50%, -50%)',
              }}
              className="absolute z-40 pointer-events-none flex flex-col items-center gap-1"
            >
              <div className="relative w-12 h-12 rounded-xl border-2 border-dashed border-sky-400 bg-sky-500/20 shadow-[0_0_20px_rgba(56,189,248,0.35)] flex items-center justify-center">
                <Plus className="w-6 h-6 text-sky-300" />
              </div>
              <span className="px-2 py-0.5 rounded bg-slate-950/95 border border-sky-400/60 text-[10px] font-mono font-semibold text-sky-200 whitespace-nowrap shadow-md">
                + {pendingPlacement.label} ({hoverCanvasPos.x}, {hoverCanvasPos.y})
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
