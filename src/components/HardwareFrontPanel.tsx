import React, { useState, useEffect } from 'react';
import {
  CableType,
  NetworkInterface,
  NetworkLink,
  NetworkNode,
  SimulationStep,
} from '../network/types';
import {
  addHardwarePortToNode,
  getAvailableTargetPorts,
  getDeviceChassisPorts,
  groupPortsIntoTwoRows,
  moveLinkToSocket,
  PortHardwareDescriptor,
  TwoRowPortColumn,
} from '../network/hardwareChassis';
import {
  Cable,
  Plus,
  Power,
  Terminal,
  Unplug,
  X,
  ArrowRightLeft,
  SlidersHorizontal,
  GripHorizontal,
  Minus,
  Cpu,
  Globe,
} from 'lucide-react';

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
  onSetPendingCableSource,
  onSelectCableType,
  onCreateLink,
  onDeleteLink,
  onUpdateLinks,
  onUpdateNode,
  onSelectNode,
  onOpenFloatingCli,
  onOpenWebGui,
  onHoverLink,
  onClose,
}) => {
  const [selectedPortId, setSelectedPortId] = useState<string | null>(null);
  const [ledDisplayMode, setLedDisplayMode] = useState<'peer' | 'vlan' | 'speed'>('peer');
  const [position, setPosition] = useState<{ x: number; y: number }>({
    x: 245,
    y: 62,
  });
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isMinimized, setIsMinimized] = useState(false);

  useEffect(() => {
    setSelectedPortId(null);
  }, [node.id]);

  useEffect(() => {
    if (!isDragging) return;
    const handleMouseMove = (e: MouseEvent) => {
      const nextX = Math.max(12, Math.min(window.innerWidth - 320, e.clientX - dragOffset.x));
      const nextY = Math.max(44, Math.min(window.innerHeight - 90, e.clientY - dragOffset.y));
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

  const portDescriptors = getDeviceChassisPorts(node, allNodes, allLinks, activeStep);
  const accessPorts = portDescriptors.filter((d) => !d.isUplink);
  const uplinkPorts = portDescriptors.filter((d) => d.isUplink);
  const accessColumns = groupPortsIntoTwoRows(accessPorts);
  const uplinkColumns = groupPortsIntoTwoRows(uplinkPorts);

  const freeSocketsOnThisDevice = portDescriptors.filter((d) => !d.connectedLink);
  const availablePeerPorts = getAvailableTargetPorts(node.id, allNodes, allLinks);

  const selectedDescriptor =
    portDescriptors.find((d) => d.port.id === selectedPortId) || null;

  const handleSocketClick = (desc: PortHardwareDescriptor) => {
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
      setSelectedPortId(desc.port.id);
      return;
    }

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

  const handleUpdatePort = (portId: string, patch: Partial<NetworkInterface>) => {
    const updatedInterfaces = node.interfaces.map((iface) =>
      iface.id === portId ? { ...iface, ...patch } : iface
    );
    onUpdateNode({
      ...node,
      interfaces: updatedInterfaces,
    });
  };

  const handleAddPort = () => {
    const updated = addHardwarePortToNode(node);
    onUpdateNode(updated);
  };

  const handleMovePatchCord = (linkId: string, newPortId: string) => {
    const updated = moveLinkToSocket(allLinks, linkId, node.id, newPortId);
    onUpdateLinks(updated);
    setSelectedPortId(newPortId);
  };

  const renderLedDot = (desc: PortHardwareDescriptor) => {
    switch (desc.ledState) {
      case 'active-traffic':
        return (
          <span
            className="inline-flex items-center gap-0.5 text-[7px] font-mono font-bold text-sky-300"
            title="Активная передача пакета (ACT)"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-sky-400 shadow-[0_0_6px_rgba(56,189,248,0.95)]" />
            <span>ACT</span>
          </span>
        );
      case 'link-up':
        return (
          <span
            className="inline-flex items-center gap-0.5 text-[7px] font-mono font-bold text-emerald-300"
            title="Физический линк активен (LINK UP)"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shadow-[0_0_5px_rgba(16,185,129,0.85)]" />
            <span>UP</span>
          </span>
        );
      case 'link-down':
        return (
          <span
            className="inline-flex items-center gap-0.5 text-[7px] font-mono font-bold text-amber-300"
            title="Удалённый порт выключен (DOWN)"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
            <span>DWN</span>
          </span>
        );
      case 'admin-down':
        return (
          <span
            className="inline-flex items-center gap-0.5 text-[7px] font-mono font-bold text-red-400"
            title="Порт административно выключен (SHUTDOWN)"
          >
            <span className="w-1.5 h-1.5 rounded-xs bg-red-500" />
            <span>SHT</span>
          </span>
        );
      case 'unplugged':
      default:
        return (
          <span
            className="inline-flex items-center gap-0.5 text-[7px] font-mono text-slate-500"
            title="Свободный разъём RJ-45"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-slate-700" />
          </span>
        );
    }
  };

  const getBootColorClasses = (desc: PortHardwareDescriptor) => {
    if (!desc.connectedLink) return '';
    if (desc.port.vlanMode === 'trunk' || desc.peerPort?.vlanMode === 'trunk') {
      return 'bg-indigo-600/90 border-indigo-300 text-white';
    }
    if (desc.connectedLink.cableType === 'fiber') {
      return 'bg-amber-500/90 border-amber-200 text-slate-950';
    }
    if (desc.connectedLink.cableType === 'crossover') {
      return 'bg-emerald-600/90 border-emerald-300 text-white';
    }
    return 'bg-sky-600/90 border-sky-300 text-white';
  };

  const renderCompactRj45Socket = (
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

    const bootCaption =
      ledDisplayMode === 'peer'
        ? desc.peerNode
          ? desc.peerNode.name
          : '+ кабель'
        : ledDisplayMode === 'vlan'
        ? desc.port.vlanMode === 'trunk'
          ? 'TRUNK'
          : `VLAN ${desc.port.accessVlan}`
        : desc.isUplink
        ? '1G SFP'
        : '100M';

    return (
      <button
        key={desc.port.id}
        type="button"
        data-testid={`chassis-port-${desc.port.shortName}`}
        aria-label={`Порт ${desc.port.shortName} (${
          desc.peerNode ? `подключён к ${desc.peerNode.name}` : 'свободен'
        })`}
        title={
          desc.peerNode && desc.peerPort
            ? `${desc.port.shortName}: подключён к ${desc.peerNode.name} (${desc.peerPort.shortName}) · VLAN ${desc.port.accessVlan}`
            : `${desc.port.shortName}: свободен — кликните для подключения патч-корда`
        }
        onClick={() => handleSocketClick(desc)}
        onMouseEnter={() => onHoverLink(desc.connectedLink?.id || null)}
        onMouseLeave={() => onHoverLink(null)}
        className={`group relative flex flex-col justify-between w-[68px] px-1 py-[2px] rounded-xs border transition-all cursor-pointer select-none ${
          isSelected || isArmedForCable
            ? 'bg-sky-950/90 border-sky-400 ring-1 ring-sky-400/50 shadow-sm'
            : canAcceptIncomingCable
            ? 'bg-emerald-950/70 border-emerald-400 ring-1 ring-emerald-400/40'
            : 'bg-slate-900/95 border-slate-700/80 hover:border-slate-500 hover:bg-slate-800/90'
        }`}
      >
        {/* Port ShortName + LED status */}
        <div className="w-full flex items-center justify-between gap-0.5 leading-none mb-[2px]">
          <span className="text-[8px] font-mono font-semibold text-slate-200 tracking-tighter">
            {desc.port.shortName}
          </span>
          {renderLedDot(desc)}
        </div>

        {/* Physical Recessed RJ-45 Cavity (slim 2-row hardware profile) */}
        <div
          className={`relative w-full h-[17px] rounded-xs border flex flex-col items-center justify-between px-0.5 transition-colors ${
            desc.connectedLink
              ? 'bg-slate-950 border-slate-600'
              : isArmedForCable || canAcceptIncomingCable
              ? 'bg-slate-950 border-sky-400'
              : 'bg-slate-950 border-slate-800 group-hover:border-slate-600'
          }`}
        >
          {/* Top-row RJ-45 ports have latch on top; Bottom-row ports have gold pins on top */}
          {rowPosition === 'top' ? (
            <div
              className={`w-3 h-[2px] rounded-b-xs ${
                desc.connectedLink ? 'bg-slate-400' : 'bg-slate-700'
              }`}
            />
          ) : (
            <div className="flex items-center justify-center gap-[1.5px] w-full pt-[1px]">
              {[0, 1, 2, 3, 4, 5].map((pin) => (
                <span
                  key={pin}
                  className={`w-[1.5px] h-[2px] ${
                    desc.connectedLink ? 'bg-amber-300' : 'bg-amber-500/40'
                  }`}
                />
              ))}
            </div>
          )}

          {/* Center Plugged-In Boot OR Empty Socket Label */}
          {desc.connectedLink ? (
            <div
              className={`w-full h-[10px] rounded-[2px] border flex items-center justify-center px-0.5 text-[7px] font-mono font-bold truncate leading-none ${getBootColorClasses(
                desc
              )}`}
            >
              <span className="truncate">{bootCaption}</span>
            </div>
          ) : (
            <div className="flex items-center justify-center h-[10px] text-[7px] font-mono text-slate-500 group-hover:text-sky-300 leading-none truncate">
              {isArmedForCable ? 'ВЫБРАН' : bootCaption}
            </div>
          )}

          {/* Bottom edge of RJ-45 cavity */}
          {rowPosition === 'top' ? (
            <div className="flex items-center justify-center gap-[1.5px] w-full pb-[1px]">
              {[0, 1, 2, 3, 4, 5].map((pin) => (
                <span
                  key={pin}
                  className={`w-[1.5px] h-[2px] ${
                    desc.connectedLink ? 'bg-amber-300' : 'bg-amber-500/40'
                  }`}
                />
              ))}
            </div>
          ) : (
            <div
              className={`w-3 h-[2px] rounded-t-xs ${
                desc.connectedLink ? 'bg-slate-400' : 'bg-slate-700'
              }`}
            />
          )}
        </div>
      </button>
    );
  };

  const renderTwoRowColumn = (col: TwoRowPortColumn) => {
    return (
      <div
        key={`col-${col.columnIndex}-${col.top.port.id}`}
        className="flex flex-col items-center gap-[2px]"
      >
        {/* Top Row RJ-45 Socket (Odd Port: 1X, 3X, 5X...) */}
        {renderCompactRj45Socket(col.top, 'top')}

        {/* Silkscreen Dual-Row Port Index Strip (▲1X / 2X▼) */}
        <div className="w-full flex items-center justify-between px-1 text-[7px] font-mono text-slate-400 leading-none py-[1px] bg-slate-950/90 rounded-xs border border-slate-800/80">
          <span>▲{col.top.portIndex}X</span>
          <span>{col.bottom ? `${col.bottom.portIndex}X▼` : '—'}</span>
        </div>

        {/* Bottom Row RJ-45 Socket (Even Port: 2X, 4X, 6X...) */}
        {col.bottom ? (
          renderCompactRj45Socket(col.bottom, 'bottom')
        ) : (
          <div className="w-[68px] h-[30px] rounded-xs border border-dashed border-slate-800/70 bg-slate-950/40 flex items-center justify-center text-[7px] font-mono text-slate-600">
            ПУСТО
          </div>
        )}
      </div>
    );
  };

  const switchableNodes = [...allNodes].sort((a, b) => {
    const order = { switch: 0, router: 1, server: 2, pc: 3 };
    return order[a.type] - order[b.type];
  });

  return (
    <div
      data-testid="hardware-front-panel"
      role="dialog"
      aria-label={`Передняя панель 1U — ${node.name}`}
      style={{
        left: `${position.x}px`,
        top: `${position.y}px`,
      }}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      className="fixed z-45 w-fit max-w-[95vw] rounded-lg bg-slate-950/98 border-2 border-slate-700 shadow-[0_18px_45px_rgba(0,0,0,0.85)] select-none overflow-hidden"
    >
      {/* Ultra-Slim Draggable Window Title Bar */}
      <div
        onMouseDown={handleHeaderMouseDown}
        className="flex items-center justify-between gap-2 px-2 py-1 bg-slate-900 border-b border-slate-800 cursor-move"
      >
        <div className="flex items-center gap-1.5 min-w-0">
          <GripHorizontal className="w-3.5 h-3.5 text-slate-500 shrink-0" />
          <Cpu className="w-3.5 h-3.5 text-sky-400 shrink-0" />
          <select
            aria-label="Выбрать устройство на передней панели 1U"
            value={node.id}
            onChange={(e) => onSelectNode(e.target.value)}
            className="bg-slate-950 border border-slate-700 rounded px-1.5 py-0.5 text-[10px] font-mono font-semibold text-sky-300 focus:outline-none focus:border-sky-500 cursor-pointer"
          >
            {switchableNodes.map((n) => (
              <option key={n.id} value={n.id}>
                {n.name} · 1U ({n.type.toUpperCase()})
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {!isMinimized && (
            <>
              {/* Compact Cable Type Selector */}
              <div className="flex items-center gap-0.5 bg-slate-950 p-0.5 rounded border border-slate-800">
                {(['straight', 'crossover', 'fiber'] as CableType[]).map((type) => (
                  <button
                    key={type}
                    type="button"
                    onClick={() => onSelectCableType(type)}
                    className={`px-1 py-0.5 text-[8px] font-mono rounded transition-colors cursor-pointer ${
                      selectedCableType === type
                        ? 'bg-sky-600 text-white font-semibold'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {type === 'straight' ? 'Прям' : type === 'crossover' ? 'Кросс' : 'Опт'}
                  </button>
                ))}
              </div>

              <button
                type="button"
                onClick={handleAddPort}
                title="Добавить физический порт RJ-45 на шасси"
                className="flex items-center gap-0.5 px-1.5 py-0.5 rounded border border-slate-700 hover:border-sky-400 text-slate-300 hover:text-sky-300 bg-slate-950 text-[9px] font-mono transition-colors cursor-pointer"
              >
                <Plus className="w-2.5 h-2.5" />
                <span>Порт</span>
              </button>

              {onOpenWebGui && (
                <button
                  type="button"
                  onClick={() => onOpenWebGui(node.id)}
                  title="Открыть плавающий Веб-интерфейс коммутатора (настройка портов и базы VLAN)"
                  className="flex items-center gap-1 px-1.5 py-0.5 rounded border border-indigo-500/60 hover:bg-indigo-600 text-indigo-200 hover:text-white bg-indigo-950/90 text-[9px] font-mono font-semibold transition-colors cursor-pointer"
                >
                  <Globe className="w-2.5 h-2.5" />
                  <span>WEB (VLAN)</span>
                </button>
              )}
            </>
          )}

          <button
            type="button"
            onClick={() => setIsMinimized((m) => !m)}
            aria-label={isMinimized ? 'Развернуть панель коммутатора' : 'Свернуть панель коммутатора'}
            title={isMinimized ? 'Развернуть окно 1U' : 'Свернуть окно 1U'}
            className="p-1 rounded text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <Minus className="w-3 h-3" />
          </button>

          <button
            type="button"
            onClick={onClose}
            aria-label="Скрыть переднюю панель коммутатора"
            title="Закрыть плавающее окно 1U"
            className="p-1 rounded text-slate-400 hover:text-red-300 hover:bg-red-950/60 transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Slim 1U Rack-Mount Faceplate with 2-Row Port Matrix */}
      {!isMinimized && (
        <>
          <div className="flex items-stretch justify-center gap-1.5 px-2 py-1.5 bg-gradient-to-b from-slate-800/95 via-slate-900 to-slate-950">
            {/* Left Hardware Bezel: Rack Ear + System LEDs + Mode Button + Console RJ-45 Port */}
            <div className="flex items-center gap-1.5 px-1.5 py-1 rounded bg-slate-900/95 border border-slate-700/85 shrink-0">
              <div className="flex flex-col items-center justify-between h-full py-0.5">
                <span className="w-1.5 h-1 rounded-full bg-slate-950 border border-slate-600" />
                <span className="text-[7px] font-mono text-slate-400 [writing-mode:vertical-lr] rotate-180">
                  1U
                </span>
                <span className="w-1.5 h-1 rounded-full bg-slate-950 border border-slate-600" />
              </div>

              <div className="flex flex-col justify-between h-full py-0.5 gap-1">
                <div className="grid grid-cols-2 gap-x-1.5 gap-y-0.5 text-[7px] font-mono text-emerald-400 leading-none">
                  <span>●SYS</span>
                  <span>●STA</span>
                  <span>●DPX</span>
                  <span>●SPD</span>
                </div>

                {/* Physical MODE Button on Switch Faceplate */}
                <button
                  type="button"
                  onClick={() =>
                    setLedDisplayMode((m) =>
                      m === 'peer' ? 'vlan' : m === 'vlan' ? 'speed' : 'peer'
                    )
                  }
                  title="Кнопка MODE: переключить индикацию (Узел / VLAN / Скорость)"
                  className="flex items-center justify-center gap-0.5 px-1 py-0.5 rounded-xs bg-slate-800 hover:bg-slate-700 border border-slate-600 text-[7px] font-mono text-sky-300 transition-colors cursor-pointer"
                >
                  <SlidersHorizontal className="w-2 h-2" />
                  <span>MODE:{ledDisplayMode.toUpperCase()}</span>
                </button>

                {/* Physical CONSOLE Port on Switch Faceplate */}
                <button
                  type="button"
                  onClick={() => onOpenFloatingCli(node.id)}
                  title="Консольный порт RJ-45 — открыть терминал Cisco IOS CLI"
                  className="flex items-center justify-center gap-0.5 px-1 py-0.5 rounded-xs bg-emerald-950/90 hover:bg-emerald-900 border border-emerald-500/60 text-[7px] font-mono font-bold text-emerald-300 transition-colors cursor-pointer"
                >
                  <Terminal className="w-2 h-2" />
                  <span>CONSOLE</span>
                </button>
              </div>
            </div>

            {/* 2-Row Switch Port Banks (Odd Ports Top Row, Even Ports Bottom Row) */}
            <div className="flex items-center gap-1.5 overflow-x-auto">
              {/* Access / FastEthernet 2-Row Port Bank */}
              {accessColumns.length > 0 && (
                <div className="flex flex-col bg-slate-950/95 border border-slate-700/90 rounded px-1.5 py-1 shrink-0">
                  <div className="flex items-center justify-between text-[7px] font-mono text-slate-400 mb-0.5 px-0.5 leading-none">
                    <span>10/100BASE-TX</span>
                    <span className="text-slate-500 ml-2">1X–{accessPorts.length}X</span>
                  </div>
                  <div className="flex items-center gap-1">
                    {accessColumns.map((col) => renderTwoRowColumn(col))}
                  </div>
                </div>
              )}

              {/* Gigabit Uplink 2-Row Port Bank */}
              {uplinkColumns.length > 0 && (
                <div className="flex flex-col bg-slate-950/95 border border-indigo-500/45 rounded px-1.5 py-1 shrink-0">
                  <div className="flex items-center justify-between text-[7px] font-mono text-indigo-300 mb-0.5 px-0.5 leading-none">
                    <span>UPLINK 1G</span>
                  </div>
                  <div className="flex items-center gap-1">
                    {uplinkColumns.map((col) => renderTwoRowColumn(col))}
                  </div>
                </div>
              )}
            </div>

            {/* Right Compact Rack Ear */}
            <div className="flex flex-col items-center justify-between py-1 px-1 rounded bg-slate-900/95 border border-slate-700/85 shrink-0">
              <span className="w-1.5 h-1 rounded-full bg-slate-950 border border-slate-600" />
              <span className="text-[7px] font-mono text-slate-500 [writing-mode:vertical-lr]">
                CISCO
              </span>
              <span className="w-1.5 h-1 rounded-full bg-slate-950 border border-slate-600" />
            </div>
          </div>

          {/* Slim Interactive Port Action Strip when a Socket is Clicked */}
          {selectedDescriptor && (
            <div
              data-testid="chassis-port-drawer"
              className="px-2 py-1 bg-slate-950 border-t border-slate-800 flex flex-wrap items-center justify-between gap-1.5 text-[10px]"
            >
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="px-1.5 py-0.5 rounded bg-sky-500/20 border border-sky-500/40 font-mono font-semibold text-sky-300">
                  {selectedDescriptor.port.shortName}
                </span>

                {/* Port Admin Power (UP / SHUTDOWN) */}
                <button
                  type="button"
                  onClick={() =>
                    handleUpdatePort(selectedDescriptor.port.id, {
                      adminStatus:
                        selectedDescriptor.port.adminStatus === 'up' ? 'down' : 'up',
                    })
                  }
                  className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded font-mono text-[10px] border transition-colors cursor-pointer ${
                    selectedDescriptor.port.adminStatus === 'up'
                      ? 'bg-emerald-950/70 border-emerald-600/60 text-emerald-300 hover:bg-emerald-900/60'
                      : 'bg-red-950/70 border-red-600/60 text-red-300 hover:bg-red-900/60'
                  }`}
                >
                  <Power className="w-2.5 h-2.5" />
                  <span>
                    {selectedDescriptor.port.adminStatus === 'up' ? 'UP' : 'SHUT'}
                  </span>
                </button>

                {/* Compact VLAN Badge + Open Web GUI Button */}
                <span className="px-1.5 py-0.5 rounded bg-slate-900 border border-slate-800 text-[10px] font-mono text-indigo-300">
                  {selectedDescriptor.port.vlanMode === 'trunk'
                    ? `802.1Q Trunk (${selectedDescriptor.port.trunkAllowedVlans.join(',')})`
                    : `Access VLAN ${selectedDescriptor.port.accessVlan}`}
                </span>

                {onOpenWebGui && (
                  <button
                    type="button"
                    onClick={() => onOpenWebGui(node.id)}
                    className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-indigo-950/80 hover:bg-indigo-600 border border-indigo-500/50 text-[10px] font-mono text-indigo-200 hover:text-white transition-colors cursor-pointer"
                  >
                    <Globe className="w-2.5 h-2.5" />
                    <span>Настроить VLAN</span>
                  </button>
                )}
              </div>

              {/* Cable Patching / Moving / Unplugging Controls */}
              <div className="flex flex-wrap items-center gap-1">
                {selectedDescriptor.connectedLink && selectedDescriptor.peerNode ? (
                  <>
                    <span className="text-[10px] text-slate-400">
                      →{' '}
                      <button
                        type="button"
                        onClick={() => onSelectNode(selectedDescriptor.peerNode!.id)}
                        className="font-mono font-semibold text-sky-400 hover:underline cursor-pointer"
                      >
                        {selectedDescriptor.peerNode.name}:{selectedDescriptor.peerPort?.shortName}
                      </button>
                    </span>

                    {freeSocketsOnThisDevice.length > 0 && (
                      <div className="flex items-center gap-0.5 bg-slate-900 px-1 py-0.5 rounded border border-slate-800">
                        <ArrowRightLeft className="w-2.5 h-2.5 text-slate-400" />
                        {freeSocketsOnThisDevice.slice(0, 3).map((freeSock) => (
                          <button
                            key={freeSock.port.id}
                            type="button"
                            onClick={() =>
                              handleMovePatchCord(
                                selectedDescriptor.connectedLink!.id,
                                freeSock.port.id
                              )
                            }
                            className="px-1 py-0.5 text-[9px] font-mono rounded bg-slate-800 hover:bg-sky-600 text-slate-200 hover:text-white transition-colors cursor-pointer"
                          >
                            {freeSock.port.shortName}
                          </button>
                        ))}
                      </div>
                    )}

                    <button
                      type="button"
                      onClick={() => {
                        onDeleteLink(selectedDescriptor.connectedLink!.id);
                        onHoverLink(null);
                      }}
                      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-red-950/70 hover:bg-red-900 border border-red-700/70 text-[10px] font-medium text-red-200 transition-colors cursor-pointer"
                    >
                      <Unplug className="w-2.5 h-2.5" />
                      <span>Выдернуть</span>
                    </button>
                  </>
                ) : (
                  <div className="flex flex-wrap items-center gap-1">
                    <span className="inline-flex items-center gap-0.5 text-[10px] text-sky-300">
                      <Cable className="w-2.5 h-2.5" />
                      <span>В {selectedDescriptor.port.shortName}:</span>
                    </span>

                    {availablePeerPorts.length > 0 ? (
                      availablePeerPorts.slice(0, 4).map((opt) => (
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
                          }}
                          className="px-1.5 py-0.5 rounded bg-sky-600/25 hover:bg-sky-600 border border-sky-500/50 text-[9px] font-mono text-sky-200 hover:text-white transition-colors cursor-pointer"
                        >
                          +{opt.nodeName}:{opt.portShortName}
                        </button>
                      ))
                    ) : (
                      <span className="text-[10px] text-slate-500">Свободных нет</span>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};
