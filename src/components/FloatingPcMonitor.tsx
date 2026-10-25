import React, { useState, useRef, useEffect } from 'react';
import {
  HttpResponseResult,
  NetworkInterface,
  NetworkLink,
  NetworkNode,
  SimulationStep,
  TracerouteHop,
} from '../network/types';
import {
  formatCidr,
  formatIpv4Input,
  getNetworkAddress,
  isSameSubnet,
  isValidIpv4,
  isValidSubnetMask,
  maskToCidr,
  suggestSubnetMaskForIp,
} from '../network/ipMath';
import { executeIosCommand } from '../network/cliParser';
import { getRouterLogicalInterfaces, isLinkOperational } from '../network/simulator';
import {
  Monitor,
  Settings2,
  Terminal,
  Globe,
  Power,
  RefreshCw,
  Send,
  X,
  GripHorizontal,
  CheckCircle2,
  AlertTriangle,
  Sparkles,
  Wifi,
  WifiOff,
} from 'lucide-react';

interface FloatingPcMonitorProps {
  node: NetworkNode;
  allNodes: NetworkNode[];
  allLinks: NetworkLink[];
  stackIndex?: number;
  zIndex?: number;
  onFocus?: () => void;
  onUpdateNode: (updatedNode: NetworkNode) => void;
  onUpdateAllNodes: (updatedNodes: NetworkNode[]) => void;
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
  onClose: () => void;
}

export const FloatingPcMonitor: React.FC<FloatingPcMonitorProps> = ({
  node,
  allNodes,
  allLinks,
  stackIndex = 0,
  zIndex = 49,
  onFocus,
  onUpdateNode,
  onUpdateAllNodes,
  onTriggerDhcpSimulation,
  onTriggerTracerouteSimulation,
  onTriggerHttpSimulation,
  onLoadSimulationSteps,
  onClose,
}) => {
  const [activeTab, setActiveTab] = useState<'network' | 'console' | 'browser'>('network');

  // Floating draggable monitor coordinates
  const [position, setPosition] = useState(() => ({
    x: Math.max(24, 110 + (stackIndex % 4) * 36),
    y: Math.max(24, 56 + (stackIndex % 4) * 32),
  }));
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef({ x: 0, y: 0 });

  const primaryIface: NetworkInterface | undefined = node.interfaces[0];

  // Local state for smooth auto-dot IPv4 editing
  const [ipDraft, setIpDraft] = useState(primaryIface?.ipAddress || '');
  const [maskDraft, setMaskDraft] = useState(primaryIface?.subnetMask || '');
  const [gwDraft, setGwDraft] = useState(node.defaultGateway || '');
  const [dnsDraft, setDnsDraft] = useState(node.dnsServer || '');
  const [maskManuallyEditedForCurrentIp, setMaskManuallyEditedForCurrentIp] = useState(false);
  const [maskAutoFilledFlash, setMaskAutoFilledFlash] = useState(false);

  // Sync drafts when node props change externally (e.g. via DHCP DORA or CLI)
  useEffect(() => {
    setIpDraft(primaryIface?.ipAddress || '');
  }, [primaryIface?.ipAddress]);

  useEffect(() => {
    setMaskDraft(primaryIface?.subnetMask || '');
  }, [primaryIface?.subnetMask]);

  useEffect(() => {
    setGwDraft(node.defaultGateway || '');
  }, [node.defaultGateway]);

  useEffect(() => {
    setDnsDraft(node.dnsServer || '');
  }, [node.dnsServer]);

  // Console state
  const [cmdInput, setCmdInput] = useState('');
  const [historyCursor, setHistoryCursor] = useState<number>(-1);
  const consoleEndRef = useRef<HTMLDivElement>(null);

  // Browser state
  const [browserUrl, setBrowserUrl] = useState('http://app.corp.local/index.html');
  const [browserResponse, setBrowserResponse] = useState<HttpResponseResult | null>(null);
  const [browserError, setBrowserError] = useState<string | null>(null);

  useEffect(() => {
    if (!isDragging) return;
    const handleMouseMove = (e: MouseEvent) => {
      setPosition({
        x: Math.max(8, e.clientX - dragStartRef.current.x),
        y: Math.max(8, e.clientY - dragStartRef.current.y),
      });
    };
    const handleMouseUp = () => setIsDragging(false);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging]);

  useEffect(() => {
    if (activeTab === 'console') {
      consoleEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [node.cli.history, activeTab]);

  const handleHeaderMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button, input, select')) return;
    onFocus?.();
    setIsDragging(true);
    dragStartRef.current = {
      x: e.clientX - position.x,
      y: e.clientY - position.y,
    };
  };

  const updateInterface = (patch: Partial<NetworkInterface>) => {
    if (!primaryIface) return;
    const updatedInterfaces = node.interfaces.map((iface, idx) =>
      idx === 0 ? { ...iface, ...patch } : iface
    );
    onUpdateNode({
      ...node,
      interfaces: updatedInterfaces,
    });
  };

  // Auto-dot IPv4 handler
  const handleIpChange = (rawVal: string) => {
    const formatted = formatIpv4Input(rawVal, ipDraft);
    setIpDraft(formatted);
    setMaskManuallyEditedForCurrentIp(false);
    updateInterface({ ipAddress: formatted, dhcpEnabled: false });
  };

  // Subnet mask auto-fill on click/focus based on the current IP address
  const handleMaskFocusOrClick = () => {
    const suggested = suggestSubnetMaskForIp(ipDraft);
    if (!maskDraft.trim() || !maskManuallyEditedForCurrentIp) {
      setMaskDraft(suggested);
      updateInterface({ subnetMask: suggested });
      setMaskAutoFilledFlash(true);
      setTimeout(() => setMaskAutoFilledFlash(false), 1200);
    }
  };

  const handleMaskChange = (rawVal: string) => {
    const formatted = formatIpv4Input(rawVal, maskDraft);
    setMaskDraft(formatted);
    setMaskManuallyEditedForCurrentIp(true);
    updateInterface({ subnetMask: formatted });
  };

  const handleGwChange = (rawVal: string) => {
    const formatted = formatIpv4Input(rawVal, gwDraft);
    setGwDraft(formatted);
    onUpdateNode({ ...node, defaultGateway: formatted });
  };

  const handleDnsChange = (rawVal: string) => {
    const formatted = formatIpv4Input(rawVal, dnsDraft);
    setDnsDraft(formatted);
    onUpdateNode({ ...node, dnsServer: formatted });
  };

  const handleFillDefaultGateway = () => {
    if (!isValidIpv4(ipDraft)) return;
    const maskToUse = isValidSubnetMask(maskDraft) ? maskDraft : suggestSubnetMaskForIp(ipDraft);
    const netAddr = getNetworkAddress(ipDraft, maskToUse);
    const parts = netAddr.split('.');
    if (parts.length === 4) {
      const gw = `${parts[0]}.${parts[1]}.${parts[2]}.1`;
      setGwDraft(gw);
      onUpdateNode({ ...node, defaultGateway: gw });
    }
  };

  // Check physical link status
  const connectedLink = allLinks.find(
    (l) =>
      (l.sourceNodeId === node.id && l.sourcePortId === primaryIface?.id) ||
      (l.targetNodeId === node.id && l.targetPortId === primaryIface?.id)
  );
  const isLinkUp = connectedLink ? isLinkOperational(connectedLink, allNodes) : false;
  const peerInfo = (() => {
    if (!connectedLink) return null;
    const isSource = connectedLink.sourceNodeId === node.id;
    const peerNodeId = isSource ? connectedLink.targetNodeId : connectedLink.sourceNodeId;
    const peerPortId = isSource ? connectedLink.targetPortId : connectedLink.sourcePortId;
    const peerNode = allNodes.find((n) => n.id === peerNodeId);
    const peerPort = peerNode?.interfaces.find((p) => p.id === peerPortId);
    if (!peerNode) return null;
    return `${peerNode.name} (${peerPort?.shortName || 'port'})`;
  })();

  // Execute PC Workstation shell commands (ipconfig, ping, tracert, arp -a, nslookup, etc.)
  const executePcCommand = (rawCmd: string) => {
    const trimmed = rawCmd.trim();
    const promptLine = `C:\\Users\\${node.name}> ${trimmed}`;

    if (!trimmed) {
      onUpdateNode({
        ...node,
        cli: {
          ...node.cli,
          history: [...node.cli.history, promptLine],
        },
      });
      return;
    }

    const tokens = trimmed.split(/\s+/);
    const cmd = tokens[0].toLowerCase();
    const arg1 = (tokens[1] || '').toLowerCase();
    const nextCommandLog = [...(node.cli.commandLog || []), trimmed];

    if (cmd === 'cls' || cmd === 'clear') {
      onUpdateNode({
        ...node,
        cli: {
          ...node.cli,
          history: [],
          commandLog: nextCommandLog,
        },
      });
      return;
    }

    if (cmd === 'help' || cmd === '?') {
      const helpLines = [
        promptLine,
        'NetPulse Workstation OS — Доступные команды консоли ПК:',
        '  ipconfig              Показать базовые настройки IPv4, маски и шлюза',
        '  ipconfig /all         Полная конфигурация адаптера (MAC, DNS, DHCP, статус)',
        '  ipconfig /renew       Запросить IP-адрес у DHCP-сервера (процесс DORA)',
        '  ping <IP | домен>     Отправить ICMP Echo-запросы и визуализировать пакет',
        '  tracert <IP | домен>  Трассировка маршрута по шагам TTL (1..12)',
        '  arp -a                Показать таблицу ARP-кэша компьютера (IP <-> MAC)',
        '  arp -d                Очистить ARP-кэш компьютера',
        '  nslookup <домен>      Разрешить доменное имя через DNS-сервер',
        '  route print           Показать локальную таблицу маршрутизации ПК',
        '  hostname [имя]        Показать или изменить имя компьютера',
        '  cls                   Очистить экран монитора консоли',
      ];
      onUpdateNode({
        ...node,
        cli: {
          ...node.cli,
          history: [...node.cli.history, ...helpLines],
          commandLog: nextCommandLog,
        },
      });
      return;
    }

    if (cmd === 'ipconfig' || cmd === 'ifconfig') {
      if (arg1 === '/renew' || arg1 === 'renew') {
        onTriggerDhcpSimulation(node.id);
        return;
      }

      if (arg1 === '/release' || arg1 === 'release') {
        const updatedIfaces = node.interfaces.map((iface, idx) =>
          idx === 0 ? { ...iface, ipAddress: '', subnetMask: '255.255.255.0' } : iface
        );
        onUpdateNode({
          ...node,
          defaultGateway: '',
          interfaces: updatedIfaces,
          cli: {
            ...node.cli,
            history: [
              ...node.cli.history,
              promptLine,
              'Windows IP Configuration',
              '',
              'IPv4-адрес адаптера FastEthernet0 (eth0) успешно освобожден (0.0.0.0).',
            ],
            commandLog: nextCommandLog,
          },
        });
        return;
      }

      const showAll = arg1 === '/all' || arg1 === '-a';
      const lines = [
        promptLine,
        'Windows IP Configuration (NetPulse Workstation)',
        '',
        ...(showAll
          ? [
              `   Host Name . . . . . . . . . . . . : ${node.name}`,
              `   Node Type . . . . . . . . . . . . : Hybrid End-Host (L2-L7)`,
            ]
          : []),
        `Ethernet adapter ${primaryIface?.name || 'FastEthernet0'} (${primaryIface?.shortName || 'eth0'}):`,
        `   Media State . . . . . . . . . . . : ${
          primaryIface?.adminStatus !== 'up'
            ? 'Media disconnected (Admin DOWN)'
            : isLinkUp
            ? `Connected (${peerInfo || 'Link UP'})`
            : 'Media disconnected (No Cable / Peer Down)'
        }`,
        ...(showAll
          ? [
              `   Physical Address (MAC). . . . . . : ${primaryIface?.macAddress || '00:00:00:00:00:00'}`,
              `   DHCP Enabled. . . . . . . . . . . : ${primaryIface?.dhcpEnabled ? 'Yes (DORA Auto)' : 'No (Static IP)'}`,
            ]
          : []),
        `   IPv4 Address. . . . . . . . . . . : ${primaryIface?.ipAddress || '0.0.0.0 (Не назначен)'}`,
        `   Subnet Mask . . . . . . . . . . . : ${primaryIface?.subnetMask || '255.255.255.0'}`,
        `   Default Gateway . . . . . . . . . : ${node.defaultGateway || 'Не задан'}`,
        `   DNS Servers . . . . . . . . . . . : ${node.dnsServer || 'Не задан'}`,
      ];

      onUpdateNode({
        ...node,
        cli: {
          ...node.cli,
          history: [...node.cli.history, ...lines],
          commandLog: nextCommandLog,
        },
      });
      return;
    }

    if (cmd === 'arp') {
      if (arg1 === '-d') {
        onUpdateNode({
          ...node,
          arpTable: [],
          cli: {
            ...node.cli,
            history: [...node.cli.history, promptLine, 'ARP-кэш компьютера успешно очищен.'],
            commandLog: nextCommandLog,
          },
        });
        return;
      }

      const arpLines = [
        promptLine,
        `Интерфейс: ${primaryIface?.ipAddress || '0.0.0.0'} --- 0x1 (${primaryIface?.shortName || 'eth0'})`,
        '  Адрес в Интернете      Физический адрес      Тип',
        ...(node.arpTable.length === 0
          ? ['  (Записи в ARP-таблице отсутствуют. Запустите ping для разрешения MAC)']
          : node.arpTable.map(
              (entry) =>
                `  ${entry.ipAddress.padEnd(22)} ${entry.macAddress.padEnd(21)} динамический`
            )),
      ];
      onUpdateNode({
        ...node,
        cli: {
          ...node.cli,
          history: [...node.cli.history, ...arpLines],
          commandLog: nextCommandLog,
        },
      });
      return;
    }

    if (cmd === 'tracert' || cmd === 'traceroute') {
      const target = tokens[1];
      if (!target) {
        onUpdateNode({
          ...node,
          cli: {
            ...node.cli,
            history: [...node.cli.history, promptLine, 'Использование: tracert <IP-адрес или домен>'],
            commandLog: nextCommandLog,
          },
        });
        return;
      }
      const hops = onTriggerTracerouteSimulation(node.id, target);
      const hopLines = [
        promptLine,
        `Трассировка маршрута к ${target} с максимальным числом прыжков 12:`,
        '',
        ...(hops.length === 0
          ? ['  1     *        *        *     Превышен интервал ожидания для запроса.']
          : hops.map(
              (h) =>
                `  ${String(h.hop).padEnd(4)} <1 мс    <1 мс    <1 мс   ${h.nodeName} [${h.ipAddress}] (${h.status})`
            )),
        '',
        'Трассировка завершена.',
      ];
      onUpdateNode({
        ...node,
        cli: {
          ...node.cli,
          history: [...node.cli.history, ...hopLines],
          commandLog: nextCommandLog,
        },
      });
      return;
    }

    if ((cmd === 'route' && arg1 === 'print') || cmd === 'netstat') {
      const netId =
        primaryIface?.ipAddress && primaryIface?.subnetMask
          ? getNetworkAddress(primaryIface.ipAddress, primaryIface.subnetMask)
          : '0.0.0.0';
      const routeLines = [
        promptLine,
        '===========================================================================',
        'IPv4 Таблица маршрутизации рабочей станции:',
        '===========================================================================',
        'Сетевой адрес           Маска сети      Адрес шлюза       Интерфейс',
        ...(primaryIface?.ipAddress
          ? [
              `${netId.padEnd(23)} ${(primaryIface.subnetMask || '255.255.255.0').padEnd(15)} На связке         ${primaryIface.ipAddress}`,
            ]
          : []),
        ...(node.defaultGateway
          ? [
              `0.0.0.0                 0.0.0.0         ${node.defaultGateway.padEnd(17)} ${primaryIface?.ipAddress || '0.0.0.0'}`,
            ]
          : ['(Маршрут по умолчанию 0.0.0.0/0 не задан — отсутствует Default Gateway)']),
        '===========================================================================',
      ];
      onUpdateNode({
        ...node,
        cli: {
          ...node.cli,
          history: [...node.cli.history, ...routeLines],
          commandLog: nextCommandLog,
        },
      });
      return;
    }

    // Delegate ping, nslookup, hostname, etc. to the core CLI engine
    const res = executeIosCommand(trimmed, node, allNodes, allLinks);
    const formattedOutput = res.outputLines.map((line, i) => (i === 0 ? promptLine : line));
    const updatedWithHistory: NetworkNode = {
      ...res.updatedNode,
      cli: {
        ...res.updatedNode.cli,
        history: [...node.cli.history, ...formattedOutput],
        commandLog: nextCommandLog,
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

  const handleConsoleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    executePcCommand(cmdInput);
    setCmdInput('');
    setHistoryCursor(-1);
  };

  const handleConsoleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const cmdLog = node.cli.commandLog || [];
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (cmdLog.length === 0) return;
      const nextCursor =
        historyCursor === -1 ? cmdLog.length - 1 : Math.max(0, historyCursor - 1);
      setHistoryCursor(nextCursor);
      setCmdInput(cmdLog[nextCursor] || '');
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (cmdLog.length === 0 || historyCursor === -1) return;
      const nextCursor = historyCursor + 1;
      if (nextCursor >= cmdLog.length) {
        setHistoryCursor(-1);
        setCmdInput('');
      } else {
        setHistoryCursor(nextCursor);
        setCmdInput(cmdLog[nextCursor] || '');
      }
    }
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

  // Validate current IP, Mask & Gateway
  const ipValid = isValidIpv4(ipDraft);
  const maskValid = isValidSubnetMask(maskDraft);
  const gwValid = !gwDraft.trim() || isValidIpv4(gwDraft);
  const gwInSameSubnet =
    !gwDraft.trim() ||
    (ipValid && maskValid && isValidIpv4(gwDraft) && isSameSubnet(ipDraft, gwDraft, maskDraft));

  // Quick targets for Ping in console
  const reachableTargetIps = allNodes
    .filter((n) => n.id !== node.id)
    .flatMap((n) =>
      getRouterLogicalInterfaces(n)
        .filter((i) => isValidIpv4(i.ipAddress))
        .map((i) => ({ label: `${n.name} (${i.ipAddress})`, ip: i.ipAddress }))
    );

  return (
    <div
      style={{
        left: `${position.x}px`,
        top: `${position.y}px`,
        zIndex,
      }}
      onMouseDown={() => onFocus?.()}
      data-testid={`pc-monitor-window-${node.id}`}
      className="fixed w-[650px] max-w-[95vw] select-none flex flex-col items-center"
    >
      {/* Outer Physical Monitor Bezel Frame */}
      <div className="w-full rounded-2xl p-2.5 bg-gradient-to-b from-slate-700 via-slate-800 to-slate-900 border-2 border-slate-600/90 shadow-[0_28px_70px_rgba(0,0,0,0.88)]">
        {/* Top Monitor Bezel Webcam & Ambient Sensor Dot */}
        <div
          onMouseDown={handleHeaderMouseDown}
          className="flex items-center justify-center gap-2 pb-1.5 cursor-move"
          title="Перетащите монитор ПК за верхнюю рамку"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-slate-950 border border-slate-600" />
          <span className="w-2.5 h-2.5 rounded-full bg-slate-950 border border-slate-600 flex items-center justify-center">
            <span className="w-1 h-1 rounded-full bg-sky-400/70" />
          </span>
          <span className="text-[9px] font-mono tracking-widest text-slate-400 uppercase">
            {node.name} WORKSTATION
          </span>
        </div>

        {/* Inner Recessed Anti-Glare IPS Screen */}
        <div className="w-full rounded-xl bg-slate-950 border-2 border-slate-900 overflow-hidden flex flex-col shadow-inner">
          {/* Monitor Screen Top OS Bar & Navigation Tabs */}
          <div
            onMouseDown={handleHeaderMouseDown}
            className="px-3.5 py-2 bg-slate-900/95 border-b border-slate-800 flex items-center justify-between gap-2 cursor-move"
          >
            {/* Left: Device Identity & Link Status */}
            <div className="flex items-center gap-2 min-w-0">
              <div className="w-7 h-7 rounded-lg bg-sky-500/15 border border-sky-500/40 flex items-center justify-center shrink-0">
                <Monitor className="w-4 h-4 text-sky-400" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs font-bold text-slate-100 whitespace-nowrap">
                    {node.name}
                  </span>
                  <span
                    className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono whitespace-nowrap shrink-0 ${
                      primaryIface?.adminStatus === 'up' && isLinkUp
                        ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                        : 'bg-red-500/15 text-red-300 border border-red-500/30'
                    }`}
                  >
                    {primaryIface?.adminStatus === 'up' && isLinkUp ? (
                      <>
                        <Wifi className="w-2.5 h-2.5 shrink-0" />
                        <span>LINK UP</span>
                      </>
                    ) : (
                      <>
                        <WifiOff className="w-2.5 h-2.5 shrink-0" />
                        <span>NO LINK</span>
                      </>
                    )}
                  </span>
                </div>
                <div className="text-[10px] font-mono text-sky-300 truncate">
                  {primaryIface?.ipAddress
                    ? formatCidr(primaryIface.ipAddress, primaryIface.subnetMask)
                    : 'IPv4 не назначен'}
                </div>
              </div>
            </div>

            {/* Center: Top Screen Tabs */}
            <div className="flex items-center gap-1 p-1 rounded-lg bg-slate-950 border border-slate-800 shrink-0">
              <button
                type="button"
                onClick={() => setActiveTab('network')}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium whitespace-nowrap transition-colors cursor-pointer ${
                  activeTab === 'network'
                    ? 'bg-sky-600 text-white shadow-xs'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
                }`}
              >
                <Settings2 className="w-3.5 h-3.5 shrink-0" />
                <span>Сетевые настройки</span>
              </button>

              <button
                type="button"
                onClick={() => setActiveTab('console')}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium whitespace-nowrap transition-colors cursor-pointer ${
                  activeTab === 'console'
                    ? 'bg-emerald-600 text-white shadow-xs'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
                }`}
              >
                <Terminal className="w-3.5 h-3.5 shrink-0" />
                <span>Консоль (CMD)</span>
              </button>

              <button
                type="button"
                onClick={() => setActiveTab('browser')}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium whitespace-nowrap transition-colors cursor-pointer ${
                  activeTab === 'browser'
                    ? 'bg-indigo-600 text-white shadow-xs'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
                }`}
              >
                <Globe className="w-3.5 h-3.5 shrink-0" />
                <span>Браузер</span>
              </button>
            </div>

            {/* Right: Drag Handle & Close */}
            <div className="flex items-center gap-1 shrink-0">
              <GripHorizontal className="w-4 h-4 text-slate-600 hidden sm:block" />
              <button
                type="button"
                onClick={onClose}
                aria-label={`Закрыть монитор ${node.name}`}
                title="Закрыть монитор ПК"
                className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-red-600/80 transition-colors cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Screen Body Content (Fixed Comfortable Monitor Aspect Ratio) */}
          <div className="h-[430px] overflow-y-auto bg-slate-950">
            {/* TAB 1: GENERAL & NETWORK SETTINGS */}
            {activeTab === 'network' && (
              <div className="p-3.5 space-y-3">
                {/* Section 1: General Workstation & NIC Status */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 p-3 rounded-xl bg-slate-900/90 border border-slate-800">
                  <div>
                    <label className="block text-[11px] font-medium text-slate-400 mb-1">
                      Имя компьютера (Hostname)
                    </label>
                    <input
                      type="text"
                      aria-label="Имя компьютера в мониторе ПК"
                      value={node.name}
                      onChange={(e) => onUpdateNode({ ...node, name: e.target.value })}
                      placeholder="PC-1"
                      className="w-full px-3 py-1.5 text-xs font-semibold bg-slate-950 border border-slate-700 rounded-lg text-slate-100 focus:outline-none focus:border-sky-500"
                    />
                  </div>

                  <div>
                    <label className="block text-[11px] font-medium text-slate-400 mb-1">
                      Сетевой адаптер {primaryIface?.shortName || 'eth0'} (Питание порта)
                    </label>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() =>
                          updateInterface({
                            adminStatus: primaryIface?.adminStatus === 'up' ? 'down' : 'up',
                          })
                        }
                        className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-mono font-semibold border transition-colors cursor-pointer ${
                          primaryIface?.adminStatus === 'up'
                            ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/25'
                            : 'bg-red-500/15 border-red-500/40 text-red-300 hover:bg-red-500/25'
                        }`}
                      >
                        <Power className="w-3.5 h-3.5" />
                        <span>
                          {primaryIface?.adminStatus === 'up'
                            ? 'Адаптер ВКЛЮЧЕН (UP)'
                            : 'Адаптер ВЫКЛЮЧЕН (DOWN)'}
                        </span>
                      </button>
                    </div>
                  </div>

                  {/* Physical Connection & DHCP Mode Bar */}
                  <div className="sm:col-span-2 pt-2 border-t border-slate-800/80 flex flex-wrap items-center justify-between gap-2">
                    <div className="text-[11px] text-slate-400 flex items-center gap-2">
                      <span>Физический порт:</span>
                      <span className="font-mono text-slate-200">
                        {peerInfo ? `Подключен к ${peerInfo}` : 'Кабель не подключен'}
                      </span>
                    </div>

                    <div className="flex items-center gap-1.5">
                      <div className="inline-flex rounded-lg p-0.5 bg-slate-950 border border-slate-800 text-[11px]">
                        <button
                          type="button"
                          onClick={() => updateInterface({ dhcpEnabled: false })}
                          className={`px-2.5 py-1 rounded-md font-medium transition-colors cursor-pointer ${
                            !primaryIface?.dhcpEnabled
                              ? 'bg-sky-600 text-white'
                              : 'text-slate-400 hover:text-slate-200'
                          }`}
                        >
                          Статический IP
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            updateInterface({ dhcpEnabled: true });
                            onTriggerDhcpSimulation(node.id);
                          }}
                          className={`px-2.5 py-1 rounded-md font-medium transition-colors cursor-pointer ${
                            primaryIface?.dhcpEnabled
                              ? 'bg-amber-500 text-slate-950 font-semibold'
                              : 'text-slate-400 hover:text-slate-200'
                          }`}
                        >
                          DHCP (Авто)
                        </button>
                      </div>

                      <button
                        type="button"
                        onClick={() => {
                          updateInterface({ dhcpEnabled: true });
                          onTriggerDhcpSimulation(node.id);
                        }}
                        title="Отправить широковещательный DHCP Discover для получения IP"
                        className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/40 text-amber-300 text-[11px] font-medium transition-colors cursor-pointer"
                      >
                        <RefreshCw className="w-3 h-3" />
                        <span>Запросить DORA</span>
                      </button>
                    </div>
                  </div>
                </div>

                {/* Section 2: Smart IPv4 Configuration Fields */}
                <div className="p-3.5 rounded-xl bg-slate-900/90 border border-slate-800 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <div className="text-xs font-semibold text-slate-200 flex items-center gap-1.5">
                      <span>Параметры протокола IPv4</span>
                      <span className="text-[10px] font-normal text-sky-400 bg-sky-500/10 border border-sky-500/20 px-2 py-0.5 rounded-full">
                        Авто-точки при вводе · Авто-маска по клику
                      </span>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {/* IPv4 Address Input */}
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <label
                          htmlFor={`pc-ip-input-${node.id}`}
                          className="text-xs font-medium text-slate-300 whitespace-nowrap"
                        >
                          IPv4-адрес
                        </label>
                        <span
                          className={`text-[10px] font-mono whitespace-nowrap ${
                            ipValid ? 'text-emerald-400' : 'text-amber-400'
                          }`}
                        >
                          {ipValid ? '● Корректен' : 'Введите 4 октета'}
                        </span>
                      </div>
                      <input
                        id={`pc-ip-input-${node.id}`}
                        type="text"
                        inputMode="decimal"
                        aria-label="IPv4-адрес компьютера"
                        value={ipDraft}
                        onChange={(e) => handleIpChange(e.target.value)}
                        placeholder="192.168.1.10"
                        className={`w-full px-3 py-1.5 text-sm font-mono bg-slate-950 border rounded-lg text-slate-100 focus:outline-none transition-colors ${
                          ipValid
                            ? 'border-slate-700 focus:border-sky-400'
                            : 'border-amber-500/60 focus:border-amber-400'
                        }`}
                      />
                      <div className="mt-1 text-[10px] text-slate-400 truncate">
                        Точки ставятся сами после 3 цифр или Пробелом
                      </div>
                    </div>

                    {/* Subnet Mask Input (Auto-fills on click/focus based on IP!) */}
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <label
                          htmlFor={`pc-mask-input-${node.id}`}
                          className="text-xs font-medium text-slate-300 flex items-center gap-1 whitespace-nowrap"
                        >
                          <span>Маска подсети</span>
                          {maskAutoFilledFlash && (
                            <span className="inline-flex items-center gap-0.5 text-[10px] text-sky-300 font-normal animate-pulse">
                              <Sparkles className="w-2.5 h-2.5" />
                              Авто по IP
                            </span>
                          )}
                        </label>
                        <div className="flex items-center gap-1">
                          {[
                            { label: '/24', mask: '255.255.255.0' },
                            { label: '/16', mask: '255.255.0.0' },
                            { label: '/8', mask: '255.0.0.0' },
                          ].map((preset) => (
                            <button
                              key={preset.label}
                              type="button"
                              onClick={() => {
                                setMaskDraft(preset.mask);
                                setMaskManuallyEditedForCurrentIp(true);
                                updateInterface({ subnetMask: preset.mask });
                              }}
                              className={`px-1.5 py-0.5 rounded text-[10px] font-mono border transition-colors cursor-pointer ${
                                maskDraft === preset.mask
                                  ? 'bg-sky-500/20 border-sky-400 text-sky-200'
                                  : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
                              }`}
                            >
                              {preset.label}
                            </button>
                          ))}
                        </div>
                      </div>
                      <input
                        id={`pc-mask-input-${node.id}`}
                        type="text"
                        inputMode="decimal"
                        aria-label="Маска подсети компьютера"
                        value={maskDraft}
                        onFocus={handleMaskFocusOrClick}
                        onClick={handleMaskFocusOrClick}
                        onChange={(e) => handleMaskChange(e.target.value)}
                        placeholder="255.255.255.0"
                        className={`w-full px-3 py-1.5 text-sm font-mono bg-slate-950 border rounded-lg text-slate-100 focus:outline-none transition-colors ${
                          maskAutoFilledFlash
                            ? 'border-sky-400 ring-2 ring-sky-500/25'
                            : maskValid
                            ? 'border-slate-700 focus:border-sky-400'
                            : 'border-amber-500/60 focus:border-amber-400'
                        }`}
                      />
                      <div className="mt-1 text-[10px] text-slate-400 truncate">
                        Кликните — заполнится по классу IP ({suggestSubnetMaskForIp(ipDraft)})
                      </div>
                    </div>

                    {/* Default Gateway Input */}
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <label
                          htmlFor={`pc-gw-input-${node.id}`}
                          className="text-xs font-medium text-slate-300 whitespace-nowrap"
                        >
                          Основной шлюз (Gateway)
                        </label>
                        {ipValid && (
                          <button
                            type="button"
                            onClick={handleFillDefaultGateway}
                            className="text-[10px] font-mono text-sky-400 hover:text-sky-300 whitespace-nowrap cursor-pointer"
                            title="Автоматически подставить адрес маршрутизатора .1 этой подсети"
                          >
                            Подставить .1
                          </button>
                        )}
                      </div>
                      <input
                        id={`pc-gw-input-${node.id}`}
                        type="text"
                        inputMode="decimal"
                        aria-label="Основной шлюз компьютера"
                        value={gwDraft}
                        onChange={(e) => handleGwChange(e.target.value)}
                        placeholder="192.168.1.1"
                        className={`w-full px-3 py-1.5 text-sm font-mono bg-slate-950 border rounded-lg text-slate-100 focus:outline-none transition-colors ${
                          gwValid && gwInSameSubnet
                            ? 'border-slate-700 focus:border-sky-400'
                            : 'border-red-500/70 focus:border-red-400'
                        }`}
                      />
                      {!gwInSameSubnet && gwDraft.trim() && (
                        <div className="mt-1 text-[10px] text-red-400 flex items-center gap-1">
                          <AlertTriangle className="w-3 h-3 shrink-0" />
                          <span>Шлюз не входит в локальную подсеть!</span>
                        </div>
                      )}
                    </div>

                    {/* DNS Server Input */}
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <label
                          htmlFor={`pc-dns-input-${node.id}`}
                          className="text-xs font-medium text-slate-300 whitespace-nowrap"
                        >
                          Предпочитаемый DNS-сервер
                        </label>
                        <span className="text-[10px] font-mono text-slate-400">UDP 53</span>
                      </div>
                      <input
                        id={`pc-dns-input-${node.id}`}
                        type="text"
                        inputMode="decimal"
                        aria-label="DNS-сервер компьютера"
                        value={dnsDraft}
                        onChange={(e) => handleDnsChange(e.target.value)}
                        placeholder="192.168.2.100"
                        className="w-full px-3 py-1.5 text-sm font-mono bg-slate-950 border border-slate-700 rounded-lg text-slate-100 focus:outline-none focus:border-sky-400 transition-colors"
                      />
                    </div>
                  </div>

                  {/* Calculated Network Summary Footer */}
                  <div className="pt-2 border-t border-slate-800/80 flex flex-wrap items-center justify-between gap-2 text-xs">
                    <div className="flex items-center gap-3 font-mono">
                      <span className="text-slate-400">
                        Сеть:{' '}
                        <strong className="text-sky-300">
                          {ipValid && maskValid
                            ? `${getNetworkAddress(ipDraft, maskDraft)}/${maskToCidr(maskDraft)}`
                            : '—'}
                        </strong>
                      </span>
                      <span className="text-slate-400">
                        Записей ARP: <strong className="text-slate-200">{node.arpTable.length}</strong>
                      </span>
                    </div>

                    <div className="flex items-center gap-1.5 text-[11px]">
                      {ipValid && maskValid && gwInSameSubnet ? (
                        <span className="inline-flex items-center gap-1 text-emerald-400">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          <span>Стек TCP/IP настроен корректно</span>
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-amber-400">
                          <AlertTriangle className="w-3.5 h-3.5" />
                          <span>Проверьте IP-адрес, маску или шлюз</span>
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* TAB 2: PC COMMAND PROMPT (CMD CONSOLE) */}
            {activeTab === 'console' && (
              <div className="h-full flex flex-col bg-slate-950">
                {/* Quick Command Toolbar */}
                <div className="px-3.5 py-2 bg-slate-900/90 border-b border-slate-800 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[10px] font-mono text-slate-400 mr-1">Команды ОС:</span>
                    {[
                      { label: 'ipconfig', cmd: 'ipconfig' },
                      { label: 'ipconfig /all', cmd: 'ipconfig /all' },
                      { label: 'ipconfig /renew', cmd: 'ipconfig /renew' },
                      { label: 'arp -a', cmd: 'arp -a' },
                      { label: 'route print', cmd: 'route print' },
                      { label: 'help', cmd: 'help' },
                      { label: 'cls', cmd: 'cls' },
                    ].map((item) => (
                      <button
                        key={item.cmd}
                        type="button"
                        onClick={() => executePcCommand(item.cmd)}
                        className="px-2 py-0.5 rounded bg-slate-950 hover:bg-slate-800 border border-slate-700/80 text-[11px] font-mono text-emerald-300 transition-colors cursor-pointer"
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>

                  {/* Quick Ping Target Buttons */}
                  {reachableTargetIps.length > 0 && (
                    <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5">
                      <span className="text-[10px] font-mono text-slate-400 shrink-0">
                        Быстрый Ping:
                      </span>
                      {reachableTargetIps.slice(0, 5).map((t) => (
                        <button
                          key={t.ip}
                          type="button"
                          onClick={() => executePcCommand(`ping ${t.ip}`)}
                          className="px-2 py-0.5 rounded bg-sky-950/70 hover:bg-sky-900 border border-sky-500/30 text-[10px] font-mono text-sky-300 shrink-0 transition-colors cursor-pointer"
                        >
                          ping {t.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {/* Terminal Output Log */}
                <div className="flex-1 p-3.5 overflow-y-auto font-mono text-xs space-y-1 text-slate-200 bg-[#070b12]">
                  <div className="text-slate-400 pb-2 border-b border-slate-800/70 mb-2">
                    <div>NetPulse Workstation OS [Version 10.0.22631]</div>
                    <div>
                      Введите <span className="text-emerald-400">ipconfig</span>,{' '}
                      <span className="text-emerald-400">ping &lt;IP&gt;</span>,{' '}
                      <span className="text-emerald-400">tracert &lt;IP&gt;</span>,{' '}
                      <span className="text-emerald-400">arp -a</span> или{' '}
                      <span className="text-emerald-400">help</span>.
                    </div>
                  </div>

                  {node.cli.history.map((line, idx) => {
                    const isPrompt = line.startsWith('C:\\Users\\') || line.includes('>');
                    const isError =
                      line.includes('%') ||
                      line.includes('НЕУДАЧА') ||
                      line.includes('unreachable') ||
                      line.includes('timed out');
                    const isSuccess = line.includes('Reply from') || line.includes('УСПЕШНО');
                    return (
                      <div
                        key={idx}
                        className={`whitespace-pre-wrap leading-relaxed ${
                          isPrompt
                            ? 'text-sky-300 font-semibold mt-1.5'
                            : isError
                            ? 'text-red-400'
                            : isSuccess
                            ? 'text-emerald-300'
                            : 'text-slate-300'
                        }`}
                      >
                        {line}
                      </div>
                    );
                  })}
                  <div ref={consoleEndRef} />
                </div>

                {/* Command Prompt Input Line */}
                <form
                  onSubmit={handleConsoleSubmit}
                  className="px-3.5 py-2.5 bg-slate-900 border-t border-slate-800 flex items-center gap-2"
                >
                  <span className="text-xs font-mono font-semibold text-emerald-400 shrink-0">
                    C:\Users\{node.name}&gt;
                  </span>
                  <input
                    type="text"
                    aria-label="Ввод команды в консоли ПК"
                    value={cmdInput}
                    onChange={(e) => setCmdInput(e.target.value)}
                    onKeyDown={handleConsoleKeyDown}
                    placeholder="ipconfig /all, ping 192.168.1.1, arp -a..."
                    className="flex-1 bg-transparent text-xs font-mono text-slate-100 focus:outline-none"
                    autoFocus
                  />
                  <button
                    type="submit"
                    className="px-2.5 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-xs font-mono font-semibold text-white flex items-center gap-1 cursor-pointer"
                  >
                    <Send className="w-3 h-3" />
                    <span>Enter</span>
                  </button>
                </form>
              </div>
            )}

            {/* TAB 3: WEB BROWSER (HTTP / DNS CLIENT) */}
            {activeTab === 'browser' && (
              <div className="p-4 space-y-3">
                <form onSubmit={handleBrowserSubmit} className="flex items-center gap-2">
                  <div className="flex-1 flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-700">
                    <Globe className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                    <input
                      type="text"
                      aria-label="Адресная строка веб-браузера ПК"
                      value={browserUrl}
                      onChange={(e) => setBrowserUrl(e.target.value)}
                      placeholder="http://app.corp.local/index.html"
                      className="w-full bg-transparent text-xs font-mono text-slate-100 focus:outline-none"
                    />
                  </div>
                  <button
                    type="submit"
                    className="px-3.5 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-xs font-semibold text-white cursor-pointer"
                  >
                    Перейти (GET)
                  </button>
                </form>

                {browserError && (
                  <div className="p-3.5 rounded-xl bg-red-950/50 border border-red-500/40 text-xs text-red-200 font-mono">
                    {browserError}
                  </div>
                )}

                {browserResponse ? (
                  <div className="rounded-xl bg-slate-900 border border-slate-800 overflow-hidden">
                    <div className="px-3.5 py-2 bg-slate-950 border-b border-slate-800 flex items-center justify-between text-[11px] font-mono">
                      <span className="text-emerald-400 font-semibold">
                        HTTP {browserResponse.status} {browserResponse.statusText}
                      </span>
                      <span className="text-slate-400">
                        Сервер: {browserResponse.serverIp}
                      </span>
                    </div>
                    <div
                      className="p-4 text-xs text-slate-200 leading-relaxed"
                      dangerouslySetInnerHTML={{ __html: browserResponse.body }}
                    />
                  </div>
                ) : (
                  !browserError && (
                    <div className="p-8 text-center rounded-xl bg-slate-900/50 border border-slate-800/80 text-xs text-slate-400">
                      Введите URL или домен (например,{' '}
                      <code className="text-indigo-300">http://app.corp.local/index.html</code>) и
                      нажмите «Перейти», чтобы проверить работу DNS и HTTP-сервера.
                    </div>
                  )
                )}
              </div>
            )}
          </div>
        </div>

        {/* Bottom Monitor Chin Bezel with Brand Badge & Power LED */}
        <div
          onMouseDown={handleHeaderMouseDown}
          className="pt-2 px-3 flex items-center justify-between text-[10px] font-mono text-slate-400 cursor-move"
        >
          <div className="flex items-center gap-2">
            <span className="px-1.5 py-0.5 rounded bg-slate-900 border border-slate-700 text-slate-300 font-semibold tracking-wider">
              NETPULSE DISPLAY 24&quot; IPS
            </span>
            <span className="hidden sm:inline text-slate-500">
              {primaryIface?.shortName || 'eth0'} · 100BASE-TX
            </span>
          </div>

          <div className="flex items-center gap-3">
            <span className="text-[9px] uppercase tracking-wider text-slate-500">OSD MENU</span>
            <div className="flex items-center gap-1.5">
              <span
                className={`w-2 h-2 rounded-full ${
                  primaryIface?.adminStatus === 'up'
                    ? 'bg-emerald-400 shadow-[0_0_8px_#34d399]'
                    : 'bg-amber-400'
                }`}
              />
              <span className="text-[9px] text-slate-300 font-semibold">PWR</span>
            </div>
          </div>
        </div>
      </div>

      {/* Subtle Physical Monitor Stand Neck & Desk Base */}
      <div className="w-20 h-2.5 bg-gradient-to-b from-slate-700 to-slate-800 border-x border-slate-600" />
      <div className="w-40 h-2 bg-gradient-to-b from-slate-700 to-slate-900 border border-slate-600 rounded-full shadow-lg" />
    </div>
  );
};
