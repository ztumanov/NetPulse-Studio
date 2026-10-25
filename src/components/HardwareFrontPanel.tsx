import React, { useState, useEffect, useRef } from 'react';
import {
  CableType,
  NetworkLink,
  NetworkNode,
  SimulationStep,
} from '../network/types';
import {
  addHardwarePortToNode,
  computeChassisInitialPosition,
  getAvailableTargetPorts,
  getDeviceChassisPorts,
  groupPortsIntoTwoRows,
  PortHardwareDescriptor,
  TwoRowPortColumn,
} from '../network/hardwareChassis';
import { Cable, Globe, Plus, Terminal, Unplug, X } from 'lucide-react';

interface HardwareFrontPanelProps {
  node: NetworkNode;
  allNodes: NetworkNode[];
  allLinks: NetworkLink[];
  activeStep: SimulationStep | null;
  selectedCableType: CableType;
  pendingCableSource: {
    nodeId: string;
    portId: string;
    portName: string;
  } | null;
  stackIndex?: number;
  zIndex?: number;
  onFocus?: () => void;
  onSetPendingCableSource: (
    source: { nodeId: string; portId: string; portName: string } | null
  ) => void;
  onSelectCableType: (type: CableType) => void;
  onCreateLink: (
    sourceNodeId: string,
    sourcePortId: string,
    targetNodeId: string,
    targetPortId: string,
    cableType: CableType
  ) => void;
  onDeleteLink: (linkId: string) => void;
  onUpdateLinks: (updatedLinks: NetworkLink[]) => void;
  onUpdateNode: (updatedNode: NetworkNode) => void;
  onSelectNode: (nodeId: string) => void;
  onOpenFloatingCli: (nodeId: string) => void;
  onOpenWebGui?: (nodeId: string) => void;
  onHoverLink: (linkId: string | null) => void;
  onClose: () => void;
}

export const HardwareFrontPanel: React.FC<HardwareFrontPanelProps> = ({
  node,
  allNodes,
  allLinks,
  activeStep,
  selectedCableType,
  pendingCableSource,
  stackIndex = 0,
  zIndex = 45,
  onFocus,
  onSetPendingCableSource,
  onCreateLink,
  onDeleteLink,
  onUpdateNode,
  onOpenFloatingCli,
  onOpenWebGui,
  onHoverLink,
  onClose,
}) => {
  const [selectedPortId, setSelectedPortId] = useState<string | null>(null);
  const [position, setPosition] = useState<{ x: number; y: number }>(() =>
    computeChassisInitialPosition(stackIndex)
  );
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState<{ x: number; y: number }>({
    x: 0,
    y: 0,
  });

  const prevPendingCableRef = useRef(pendingCableSource);

  // When a pending cable connection finishes (pendingCableSource transitions from active to null),
  // automatically close the armed port drawer on the source 1U switch.
  useEffect(() => {
    if (prevPendingCableRef.current && !pendingCableSource) {
      setSelectedPortId(null);
    }
    prevPendingCableRef.current = pendingCableSource;
  }, [pendingCableSource]);

  const portDescriptors = getDeviceChassisPorts(
    node,
    allNodes,
    allLinks,
    activeStep
  );

  useEffect(() => {
    if (!isDragging) return;
    const handleMouseMove = (e: MouseEvent) => {
      const nextX = Math.max(
        12,
        Math.min(window.innerWidth - 360, e.clientX - dragOffset.x)
      );
      const nextY = Math.max(
        48,
        Math.min(window.innerHeight - 120, e.clientY - dragOffset.y)
      );
      setPosition({ x: nextX, y: nextY });
    };
    const handleMouseUp = () => {
      setIsDragging(false);
    };
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, dragOffset]);

  const handleChassisMouseDown = (e: React.MouseEvent) => {
    onFocus?.();
    const target = e.target as HTMLElement;
    if (target.closest('button')) {
      return;
    }
    setIsDragging(true);
    setDragOffset({
      x: e.clientX - position.x,
      y: e.clientY - position.y,
    });
  };

  const accessPorts = portDescriptors.filter((d) => !d.isUplink);
  const uplinkPorts = portDescriptors.filter((d) => d.isUplink);
  const accessColumns = groupPortsIntoTwoRows(accessPorts);
  const uplinkColumns = groupPortsIntoTwoRows(uplinkPorts);

  const availablePeerPorts = getAvailableTargetPorts(
    node.id,
    allNodes,
    allLinks
  );

  const selectedDescriptor =
    portDescriptors.find((d) => d.port.id === selectedPortId) || null;

  const handleSocketClick = (desc: PortHardwareDescriptor) => {
    onFocus?.();
    // Direct connection if a cable was already started from another device
    if (
      pendingCableSource &&
      pendingCableSource.nodeId !== node.id &&
      !desc.connectedLink
    ) {
      onCreateLink(
        pendingCableSource.nodeId,
        pendingCableSource.portId,
        node.id,
        desc.port.id,
        selectedCableType
      );
      onSetPendingCableSource(null);
      setSelectedPortId(null);
      return;
    }

    // Toggle off if clicking the same port again
    if (selectedPortId === desc.port.id) {
      setSelectedPortId(null);
      if (pendingCableSource?.portId === desc.port.id) {
        onSetPendingCableSource(null);
      }
      return;
    }

    setSelectedPortId(desc.port.id);

    if (!desc.connectedLink) {
      onSetPendingCableSource({
        nodeId: node.id,
        portId: desc.port.id,
        portName: desc.port.shortName,
      });
    } else {
      onSetPendingCableSource(null);
    }
  };

  const getPortLedStyle = (desc: PortHardwareDescriptor) => {
    switch (desc.ledState) {
      case 'active-traffic':
        return {
          dotClass:
            'bg-emerald-300 shadow-[0_0_8px_#34d399,0_0_3px_#ffffff] animate-pulse',
          title: 'Активная передача данных (ACT)',
        };
      case 'stp-blocking':
        return {
          dotClass:
            'bg-orange-500 ring-1 ring-orange-300 shadow-[0_0_8px_#f97316]',
          title: 'Spanning Tree (802.1D): Порт в состоянии BLK (Blocking — защита от петли L2)',
        };
      case 'link-up':
        return {
          dotClass: 'bg-emerald-400 shadow-[0_0_6px_#10b981]',
          title: 'Кабель подключён, линк активен (LINK UP / STP FWD)',
        };
      case 'link-down':
        return {
          dotClass: 'bg-amber-400 shadow-[0_0_5px_#f59e0b]',
          title: 'Кабель подключён, удалённый порт неактивен (AMBIENT/DOWN)',
        };
      case 'admin-down':
        return {
          dotClass: 'bg-red-500 shadow-[0_0_5px_#ef4444]',
          title: 'Порт выключен (SHUTDOWN)',
        };
      case 'unplugged':
      default:
        return {
          dotClass: 'bg-slate-800 border border-slate-700/80',
          title: 'Порт свободен (кабель не подключён)',
        };
    }
  };

  const getPlugColorClasses = (desc: PortHardwareDescriptor) => {
    if (!desc.connectedLink) return '';
    if (desc.ledState === 'stp-blocking') {
      return 'from-orange-500 to-orange-700 border-orange-300';
    }
    if (desc.port.vlanMode === 'trunk' || desc.peerPort?.vlanMode === 'trunk') {
      return 'from-indigo-500 to-indigo-700 border-indigo-300';
    }
    if (desc.connectedLink.cableType === 'fiber') {
      return 'from-amber-400 to-amber-600 border-amber-200';
    }
    if (desc.connectedLink.cableType === 'crossover') {
      return 'from-emerald-500 to-emerald-700 border-emerald-300';
    }
    return 'from-sky-500 to-sky-700 border-sky-300';
  };

  const renderSquareRj45Port = (
    desc: PortHardwareDescriptor,
    rowPosition: 'top' | 'bottom'
  ) => {
    const isSelected = selectedPortId === desc.port.id;
    const isArmedForCable =
      pendingCableSource?.nodeId === node.id &&
      pendingCableSource?.portId === desc.port.id;
    const canAcceptIncomingCable =
      Boolean(pendingCableSource) &&
      pendingCableSource?.nodeId !== node.id &&
      !desc.connectedLink;

    const led = getPortLedStyle(desc);
    const isConnected = Boolean(desc.connectedLink);
    const isStpBlocked = desc.ledState === 'stp-blocking';

    return (
      <button
        key={desc.port.id}
        type="button"
        data-testid={`chassis-port-${desc.port.shortName}`}
        data-node-port={`${node.id}-${desc.port.shortName}`}
        data-stp-state={desc.stpPortStatus?.state || 'none'}
        aria-label={`Порт ${desc.port.shortName} на ${node.name} (${
          desc.peerNode
            ? `подключён к ${desc.peerNode.name}${isStpBlocked ? ', STP BLK' : ''}`
            : 'свободен'
        })`}
        title={
          desc.peerNode && desc.peerPort
            ? `Порт ${desc.port.shortName} (#${desc.portIndex}): подключён к ${desc.peerNode.name} [${desc.peerPort.shortName}]${
                isStpBlocked ? ' · STP 802.1D: BLOCKING (Петля заблокирована)' : ''
              } — кликните, чтобы отсоединить`
            : `Порт ${desc.port.shortName} (#${desc.portIndex}): свободен — кликните, чтобы подсоединить кабель`
        }
        onClick={() => handleSocketClick(desc)}
        onMouseEnter={() => onHoverLink(desc.connectedLink?.id || null)}
        onMouseLeave={() => onHoverLink(null)}
        className={`group relative w-8 h-8 rounded-[3px] p-[2px] flex flex-col justify-between transition-all cursor-pointer select-none ${
          isSelected || isArmedForCable
            ? 'bg-slate-800 border-2 border-sky-400 shadow-[0_0_10px_rgba(56,189,248,0.55)]'
            : canAcceptIncomingCable
            ? 'bg-slate-800 border-2 border-emerald-400 shadow-[0_0_9px_rgba(16,185,129,0.5)]'
            : 'bg-gradient-to-b from-slate-600 via-slate-700 to-slate-800 border border-slate-500 hover:border-slate-300 shadow-inner'
        }`}
      >
        {/* Top LED & Port Number Strip on the Metal Shield */}
        <div className="w-full flex items-center justify-between px-[1.5px] leading-none">
          {/* Physical LED Indicator Lamp */}
          <span
            title={led.title}
            className={`w-2 h-2 rounded-[1.5px] transition-all shrink-0 ${led.dotClass}`}
          />
          <span className="text-[9px] font-mono font-bold text-slate-100 tracking-tighter leading-none">
            {desc.portIndex}
          </span>
        </div>

        {/* Square Recessed Physical RJ-45 Jack Cavity */}
        <div
          className={`relative w-full h-[18px] rounded-[2px] bg-slate-950 border flex flex-col items-center justify-between p-[1.5px] overflow-hidden ${
            isConnected
              ? 'border-slate-500'
              : 'border-slate-800 group-hover:border-slate-600'
          }`}
        >
          {/* Top Latch Notch (for top row) or 8 Gold Pins (for bottom row) */}
          {rowPosition === 'top' ? (
            <div
              className={`w-2.5 h-[2px] rounded-b-[1px] ${
                isConnected ? 'bg-slate-300' : 'bg-slate-800'
              }`}
            />
          ) : (
            <div className="flex items-center justify-center gap-[1px] w-full">
              {[0, 1, 2, 3, 4, 5, 6, 7].map((pin) => (
                <span
                  key={pin}
                  className={`w-[1.5px] h-[2.5px] ${
                    isConnected ? 'bg-amber-300' : 'bg-amber-500/45'
                  }`}
                />
              ))}
            </div>
          )}

          {/* Center of Square Socket: Plugged RJ-45 Connector OR Empty Cavity */}
          {isConnected ? (
            <div
              className={`w-full h-[8px] rounded-[1.5px] bg-gradient-to-b border flex items-center justify-center ${getPlugColorClasses(
                desc
              )}`}
            >
              <div className="w-2.5 h-[3.5px] rounded-[1px] bg-white/40" />
            </div>
          ) : (
            <div className="w-4/5 h-[7px] rounded-[1.5px] bg-black/85 border border-slate-900" />
          )}

          {/* Bottom 8 Gold Pins (for top row) or Latch Notch (for bottom row) */}
          {rowPosition === 'top' ? (
            <div className="flex items-center justify-center gap-[1px] w-full">
              {[0, 1, 2, 3, 4, 5, 6, 7].map((pin) => (
                <span
                  key={pin}
                  className={`w-[1.5px] h-[2.5px] ${
                    isConnected ? 'bg-amber-300' : 'bg-amber-500/45'
                  }`}
                />
              ))}
            </div>
          ) : (
            <div
              className={`w-2.5 h-[2px] rounded-t-[1px] ${
                isConnected ? 'bg-slate-300' : 'bg-slate-800'
              }`}
            />
          )}
        </div>
      </button>
    );
  };

  const renderTwoRowColumn = (col: TwoRowPortColumn, idx: number, totalCols: number) => {
    // Authentic 12-port bank separator (every 6 columns) on 24-port switches
    const addBankDivider = totalCols > 6 && idx > 0 && idx % 6 === 0;
    return (
      <React.Fragment key={`col-${col.columnIndex}-${col.top.port.id}`}>
        {addBankDivider && (
          <div className="w-[2px] h-14 bg-slate-700/80 mx-1 rounded-full shrink-0" />
        )}
        <div className="flex flex-col items-center gap-[3px]">
          {/* Upper Row Square Port (Odd: 1, 3, 5...) */}
          {renderSquareRj45Port(col.top, 'top')}

          {/* Lower Row Square Port (Even: 2, 4, 6...) */}
          {col.bottom ? (
            renderSquareRj45Port(col.bottom, 'bottom')
          ) : (
            <div className="w-8 h-8 rounded-[3px] border border-slate-800 bg-slate-950/70" />
          )}
        </div>
      </React.Fragment>
    );
  };

  const hasAnyTraffic = portDescriptors.some(
    (d) => d.ledState === 'active-traffic'
  );
  const hasAnyLink = portDescriptors.some(
    (d) => d.ledState === 'link-up' || d.ledState === 'active-traffic'
  );

  const isRouter = node.type === 'router';
  const hasNatActive =
    Boolean(node.natEnabled) ||
    node.interfaces.some(
      (i) =>
        (i.natRole && i.natRole !== 'none') ||
        (i.subinterfaces || []).some((s) => s.natRole && s.natRole !== 'none')
    );
  const hasAclActive =
    (node.aclRules || []).filter((r) => r.enabled !== false).length > 0;
  const hasDot1qSubifs = node.interfaces.some(
    (i) => (i.subinterfaces || []).length > 0
  );

  return (
    <div
      data-testid="hardware-front-panel"
      data-node-id={node.id}
      data-device-type={node.type}
      role="dialog"
      aria-label={`Передняя панель 1U — ${node.name}`}
      style={{
        left: `${position.x}px`,
        top: `${position.y}px`,
        zIndex,
      }}
      onClick={(e) => {
        e.stopPropagation();
        onFocus?.();
      }}
      onMouseDown={(e) => {
        e.stopPropagation();
        onFocus?.();
      }}
      className="fixed w-fit select-none"
    >
      {/* Realistic Physical 1U Rack-Mount Chassis (+30% Enlarged) */}
      <div
        onMouseDown={handleChassisMouseDown}
        title="Потяните за корпус 1U для перемещения окна"
        className={`flex items-stretch rounded-md p-[3px] border shadow-[0_18px_42px_rgba(0,0,0,0.92)] cursor-move ${
          isRouter
            ? 'bg-gradient-to-b from-slate-600 via-slate-800 to-slate-950 border-sky-500/60'
            : 'bg-gradient-to-b from-slate-600 via-slate-800 to-slate-900 border-slate-500/85'
        }`}
      >
        {/* Left 19-Inch Rack Mounting Ear */}
        <div className="w-5 flex flex-col items-center justify-between py-1.5 px-1 bg-gradient-to-r from-slate-800 via-slate-700 to-slate-800 border-r border-slate-950 rounded-l-[4px] shrink-0">
          <div className="w-2.5 h-1.5 rounded-full bg-slate-950 border border-slate-500 shadow-inner" />
          <span className="text-[8.5px] font-mono font-bold text-slate-300 tracking-wider [writing-mode:vertical-lr] rotate-180">
            {isRouter ? 'ISR' : '1U'}
          </span>
          <div className="w-2.5 h-1.5 rounded-full bg-slate-950 border border-slate-500 shadow-inner" />
        </div>

        {/* Main Front Bezel Faceplate */}
        {isRouter ? (
          <div className="flex items-center gap-3.5 px-3.5 py-2 bg-gradient-to-b from-slate-800 via-slate-900 to-slate-950 border-x border-slate-700/80">
            {/* Left Cisco ISR Branding & Security/Routing Telemetry LEDs */}
            <div className="flex items-center pr-3.5 border-r border-slate-800 shrink-0">
              <div className="flex flex-col justify-between h-[80px] min-w-[122px]">
                <div>
                  <div className="flex items-center justify-between gap-1.5">
                    <span className="text-[9px] font-mono font-extrabold tracking-wider text-sky-400 uppercase leading-none">
                      CISCO ISR 1U
                    </span>
                    <span className="px-1 py-0.2 rounded bg-sky-500/15 border border-sky-500/40 text-[7.5px] font-mono font-bold text-sky-300 leading-none">
                      L3 SEC
                    </span>
                  </div>
                  <div className="text-[13px] font-mono font-bold text-slate-100 tracking-tight mt-1 truncate max-w-[130px]">
                    {node.name}
                  </div>
                  <div className="text-[8.5px] font-mono text-slate-400 leading-none mt-0.5">
                    ISR-2911-SEC/K9
                  </div>
                </div>

                {/* Cisco ISR 6-Lamp System & Security LED Matrix (SYS, ACT, VPN, NAT, ACL, dot1Q) */}
                <div className="grid grid-cols-3 gap-x-2 gap-y-1 pt-1 border-t border-slate-800/90">
                  <div className="flex items-center gap-1" title="Питание шасси Cisco ISR (SYS OK)">
                    <span className="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_5px_#10b981]" />
                    <span className="text-[7.5px] font-mono font-bold text-slate-300">SYS</span>
                  </div>
                  <div className="flex items-center gap-1" title="Активность пакетов L3 (ACT)">
                    <span
                      className={`w-2 h-2 rounded-full ${
                        hasAnyTraffic
                          ? 'bg-emerald-300 shadow-[0_0_6px_#34d399] animate-pulse'
                          : hasAnyLink
                          ? 'bg-emerald-400 shadow-[0_0_5px_#10b981]'
                          : 'bg-slate-700'
                      }`}
                    />
                    <span className="text-[7.5px] font-mono font-bold text-slate-300">ACT</span>
                  </div>
                  <div className="flex items-center gap-1" title="Аппаратный криптомодуль VPN / WAN">
                    <span
                      className={`w-2 h-2 rounded-full ${
                        hasAnyLink
                          ? 'bg-sky-400 shadow-[0_0_5px_#38bdf8]'
                          : 'bg-slate-700'
                      }`}
                    />
                    <span className="text-[7.5px] font-mono font-bold text-slate-300">VPN</span>
                  </div>
                  <div
                    className="flex items-center gap-1"
                    title={
                      hasNatActive
                        ? 'Трансляция NAT / PAT Overload активна'
                        : 'NAT / PAT выключен'
                    }
                  >
                    <span
                      className={`w-2 h-2 rounded-full ${
                        hasNatActive
                          ? 'bg-emerald-400 shadow-[0_0_6px_#10b981]'
                          : 'bg-slate-700'
                      }`}
                    />
                    <span className="text-[7.5px] font-mono font-bold text-slate-300">NAT</span>
                  </div>
                  <div
                    className="flex items-center gap-1"
                    title={
                      hasAclActive
                        ? `Межсетевой экран ACL активен (${(node.aclRules || []).length} правил)`
                        : 'Правила фильтрации ACL не заданы'
                    }
                  >
                    <span
                      className={`w-2 h-2 rounded-full ${
                        hasAclActive
                          ? 'bg-amber-400 shadow-[0_0_6px_#f59e0b]'
                          : 'bg-slate-700'
                      }`}
                    />
                    <span className="text-[7.5px] font-mono font-bold text-slate-300">ACL</span>
                  </div>
                  <div
                    className="flex items-center gap-1"
                    title={
                      hasDot1qSubifs
                        ? 'Router-on-a-Stick (802.1Q подинтерфейсы активны)'
                        : 'Подинтерфейсы 802.1Q не настроены'
                    }
                  >
                    <span
                      className={`w-2 h-2 rounded-full ${
                        hasDot1qSubifs
                          ? 'bg-indigo-400 shadow-[0_0_6px_#818cf8]'
                          : 'bg-slate-700'
                      }`}
                    />
                    <span className="text-[7.5px] font-mono font-bold text-slate-300">802.1Q</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Cisco Blue Console RJ-45 + Quick GUI / Slot Controls */}
            <div className="flex flex-col items-center justify-between h-[80px] pr-3 border-r border-slate-800 shrink-0">
              <span className="text-[8px] font-mono font-semibold text-sky-300 uppercase leading-none">
                CONSOLE / MGMT
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => onOpenFloatingCli(node.id)}
                  title="Консольный порт RJ-45 (CON) — открыть терминал Cisco IOS CLI"
                  className="w-8 h-8 rounded-[3px] p-[2px] bg-sky-950 hover:bg-sky-900 border border-sky-400/80 flex flex-col items-center justify-between cursor-pointer transition-colors shadow-inner"
                >
                  <span className="text-[7.5px] font-mono font-bold text-sky-200 leading-none">
                    CON
                  </span>
                  <div className="w-full h-[15px] rounded-[1.5px] bg-slate-950 border border-sky-500/60 flex items-center justify-center">
                    <Terminal className="w-3 h-3 text-sky-400" />
                  </div>
                </button>

                {onOpenWebGui && (
                  <button
                    type="button"
                    data-testid={`router-1u-open-gui-${node.id}`}
                    onClick={() => onOpenWebGui(node.id)}
                    title="Открыть визуальный редактор маршрутизатора (Static Routes / 802.1Q / NAT / ACL)"
                    className="h-8 px-2.5 rounded-[3px] bg-indigo-950 hover:bg-indigo-700 border border-indigo-400/80 flex flex-col items-center justify-center gap-0.5 text-indigo-100 hover:text-white cursor-pointer transition-colors shadow-md"
                  >
                    <Globe className="w-3.5 h-3.5 text-indigo-300" />
                    <span className="text-[8px] font-mono font-bold leading-none">
                      ISR GUI
                    </span>
                  </button>
                )}
              </div>
              <button
                type="button"
                onClick={() => onUpdateNode(addHardwarePortToNode(node))}
                title="Установить дополнительный сетевой интерфейс HWIC (Fa/WAN)"
                className="w-full flex items-center justify-center gap-0.5 px-1.5 py-0.5 rounded bg-slate-900 hover:bg-slate-800 border border-slate-700 text-[8px] font-mono text-slate-300 hover:text-white cursor-pointer transition-colors"
              >
                <Plus className="w-2.5 h-2.5 text-sky-400" />
                <span>HWIC Порт</span>
              </button>
            </div>

            {/* Routed Onboard LAN / WAN Interfaces Bay (Gi0/0, Fa0/0, Fa0/1, Serial/WAN) */}
            <div className="flex flex-col justify-between h-[80px]">
              <div className="flex items-center justify-between gap-3 text-[8.5px] font-mono font-semibold text-slate-400 px-1 leading-none">
                <span>ROUTED LAN / WAN INTERFACES (GE / FE / HWIC)</span>
                <span className="text-sky-400">
                  {node.routingTable.filter((r) => r.type === 'S').length} STATIC ·{' '}
                  {(node.aclRules || []).length} ACL
                </span>
              </div>

              <div className="flex items-center gap-2 p-1.5 rounded-[4px] bg-slate-950 border border-slate-600/90 shadow-inner">
                {portDescriptors.map((desc) => {
                  const subCount = (desc.port.subinterfaces || []).length;
                  const natRole = desc.port.natRole;
                  const isWan =
                    natRole === 'outside' ||
                    desc.port.shortName.toLowerCase().includes('se') ||
                    desc.portIndex >= 3;

                  return (
                    <div
                      key={desc.port.id}
                      className={`flex flex-col items-center gap-1 px-2 py-1 rounded-[3px] border ${
                        isWan
                          ? 'bg-slate-900/90 border-amber-500/45'
                          : 'bg-slate-900/60 border-slate-800'
                      }`}
                    >
                      <div className="flex items-center gap-1 leading-none">
                        <span className="text-[9px] font-mono font-bold text-slate-100">
                          {desc.port.shortName}
                        </span>
                        {natRole && natRole !== 'none' ? (
                          <span
                            className={`px-1 py-0.2 rounded text-[7px] font-mono font-bold uppercase ${
                              natRole === 'outside'
                                ? 'bg-amber-500/25 text-amber-300 border border-amber-500/50'
                                : 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                            }`}
                          >
                            {natRole === 'outside' ? 'WAN' : 'LAN'}
                          </span>
                        ) : isWan ? (
                          <span className="px-1 py-0.2 rounded bg-slate-800 text-[7px] font-mono text-slate-400">
                            WAN
                          </span>
                        ) : null}
                      </div>

                      {renderSquareRj45Port(desc, 'top')}

                      <div className="text-[8px] font-mono leading-none truncate max-w-[78px]">
                        {subCount > 0 ? (
                          <span className="text-indigo-300 font-semibold">
                            dot1Q ×{subCount}
                          </span>
                        ) : desc.port.ipAddress ? (
                          <span className="text-sky-300">{desc.port.ipAddress}</span>
                        ) : (
                          <span className="text-slate-500">unassigned</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-3 px-3.5 py-2 bg-gradient-to-b from-slate-800 via-slate-900 to-slate-950 border-x border-slate-700/80">
            {/* Left Chassis Section: Branding & System LEDs */}
            <div className="flex items-center pr-3.5 border-r border-slate-800 shrink-0">
              <div className="flex flex-col justify-between h-[74px] min-w-[104px]">
                <div>
                  <div className="text-[9px] font-mono font-extrabold tracking-wider text-sky-400 uppercase leading-none">
                    CISCO 1U
                  </div>
                  <div className="text-[13px] font-mono font-bold text-slate-100 tracking-tight mt-1 truncate max-w-[118px]">
                    {node.name}
                  </div>
                  <div className="text-[9px] font-mono text-slate-400 leading-none mt-0.5">
                    {accessPorts.length >= 24 ? '2960-24TT' : `2960-${accessPorts.length}TC`}
                  </div>
                </div>

                {/* Physical Pinhole System LEDs */}
                <div className="grid grid-cols-2 gap-x-2.5 gap-y-1 pt-1 border-t border-slate-800/90">
                  <div className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_5px_#10b981]" />
                    <span className="text-[8px] font-mono font-bold text-slate-300">
                      SYST
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span
                      className={`w-2 h-2 rounded-full ${
                        hasAnyTraffic
                          ? 'bg-emerald-300 shadow-[0_0_6px_#34d399] animate-pulse'
                          : hasAnyLink
                          ? 'bg-emerald-400 shadow-[0_0_5px_#10b981]'
                          : 'bg-slate-700'
                      }`}
                    />
                    <span className="text-[8px] font-mono font-bold text-slate-300">
                      STAT
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span
                      className={`w-2 h-2 rounded-full ${
                        hasAnyLink
                          ? 'bg-emerald-400 shadow-[0_0_5px_#10b981]'
                          : 'bg-slate-700'
                      }`}
                    />
                    <span className="text-[8px] font-mono font-bold text-slate-300">
                      DUPLX
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span
                      className={`w-2 h-2 rounded-full ${
                        hasAnyLink
                          ? 'bg-emerald-400 shadow-[0_0_5px_#10b981]'
                          : 'bg-slate-700'
                      }`}
                    />
                    <span className="text-[8px] font-mono font-bold text-slate-300">
                      SPEED
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* Center 2-Row Square RJ-45 Port Banks */}
            <div className="flex items-center gap-2.5">
              {/* FastEthernet / Access Dual-Row Square Port Matrix */}
              {accessColumns.length > 0 && (
                <div className="flex flex-col">
                  <div className="flex items-center justify-between gap-2 text-[8.5px] font-mono font-semibold text-slate-400 mb-1 px-1 leading-none">
                    <span>10/100BASE-TX</span>
                    <span className="text-slate-500">1–{accessPorts.length}</span>
                  </div>
                  <div className="flex items-center gap-[4px] p-[4px] rounded-[4px] bg-slate-950 border border-slate-600/90 shadow-inner">
                    {accessColumns.map((col, idx) =>
                      renderTwoRowColumn(col, idx, accessColumns.length)
                    )}
                  </div>
                </div>
              )}

              {/* Gigabit Uplink Dual-Row Square Port Matrix */}
              {uplinkColumns.length > 0 && (
                <div className="flex flex-col">
                  <div className="flex items-center justify-between gap-1 text-[8.5px] font-mono font-semibold text-amber-300/90 mb-1 px-1 leading-none">
                    <span>1000BASE-T</span>
                  </div>
                  <div className="flex items-center gap-[4px] p-[4px] rounded-[4px] bg-slate-950 border border-amber-500/60 shadow-inner">
                    {uplinkColumns.map((col, idx) =>
                      renderTwoRowColumn(col, idx, uplinkColumns.length)
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Right 19-Inch Rack Mounting Ear with Close Button */}
        <div className="w-6 flex flex-col items-center justify-between py-1.5 px-1 bg-gradient-to-l from-slate-800 via-slate-700 to-slate-800 border-l border-slate-950 rounded-r-[4px] shrink-0">
          <button
            type="button"
            onClick={onClose}
            aria-label={`Скрыть переднюю панель коммутатора ${node.name}`}
            title={`Закрыть панель 1U (${node.name})`}
            className="w-[18px] h-[18px] rounded-full bg-slate-950 hover:bg-red-900/90 border border-slate-500 hover:border-red-400 flex items-center justify-center text-slate-300 hover:text-white transition-colors cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
          <div className="w-2.5 h-1.5 rounded-full bg-slate-950 border border-slate-500 shadow-inner" />
        </div>
      </div>

      {/* Cable Connect / Disconnect Popover Anchored Directly Below the 1U Chassis */}
      {selectedDescriptor && (
        <div
          data-testid="chassis-port-drawer"
          className="absolute left-0 top-full mt-1.5 min-w-full w-max max-w-[580px] px-3.5 py-2.5 rounded-md bg-slate-900/98 border border-slate-700 shadow-2xl flex flex-col gap-1.5 text-xs text-slate-200"
        >
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <span className="px-2 py-0.5 rounded bg-sky-500/20 border border-sky-500/40 font-mono font-bold text-sky-300 shrink-0">
                Порт {selectedDescriptor.port.shortName} (#{selectedDescriptor.portIndex})
              </span>

              {selectedDescriptor.stpPortStatus?.state === 'blocking' && (
                <span className="px-2 py-0.5 rounded bg-orange-500/25 border border-orange-400/70 font-mono font-bold text-orange-300 shrink-0">
                  STP BLK
                </span>
              )}

              {selectedDescriptor.connectedLink && selectedDescriptor.peerNode ? (
                <span className="font-mono text-slate-300 truncate">
                  ↔{' '}
                  <strong className="text-emerald-300">
                    {selectedDescriptor.peerNode.name} (
                    {selectedDescriptor.peerPort?.shortName})
                  </strong>
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 text-slate-300 truncate">
                  <Cable className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                  <span>Выберите порт или кликните 2-й коммутатор:</span>
                </span>
              )}
            </div>

            {selectedDescriptor.connectedLink && (
              <button
                type="button"
                onClick={() => {
                  onDeleteLink(selectedDescriptor.connectedLink!.id);
                  onHoverLink(null);
                  setSelectedPortId(null);
                }}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-red-950 hover:bg-red-800 border border-red-600/80 text-xs font-medium text-red-100 transition-colors cursor-pointer shrink-0"
              >
                <Unplug className="w-3.5 h-3.5" />
                <span>Отсоединить кабель</span>
              </button>
            )}
          </div>

          {!selectedDescriptor.connectedLink && (
            <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
              {availablePeerPorts.length > 0 ? (
                availablePeerPorts.slice(0, 6).map((opt) => (
                  <button
                    key={`${opt.nodeId}-${opt.portId}`}
                    type="button"
                    onClick={() => {
                      onCreateLink(
                        node.id,
                        selectedDescriptor.port.id,
                        opt.nodeId,
                        opt.portId,
                        selectedCableType
                      );
                      onSetPendingCableSource(null);
                      setSelectedPortId(null);
                    }}
                    className="px-2 py-1 rounded bg-sky-950 hover:bg-sky-600 border border-sky-500/60 text-[11px] font-mono font-semibold text-sky-200 hover:text-white transition-colors cursor-pointer"
                  >
                    + {opt.nodeName} ({opt.portShortName})
                  </button>
                ))
              ) : (
                <span className="text-xs text-slate-400">
                  Нет свободных портов на других устройствах
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
