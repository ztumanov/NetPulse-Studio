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
import {
  getRouterLogicalInterfaces,
  isLinkOperational,
  runPacketSimulation,
  runRtspVideoStreamSimulation,
  runVoipSipCallSimulation,
} from '../network/simulator';
import {
  computeWifiSignalMetrics,
  connectWirelessClientToAp,
  disconnectWirelessClient,
  scanAvailableWifiNetworks,
} from '../network/wifiEngine';
import {
  getIpCameraDirectory,
  getPoweredDevicePoeState,
  getVoipDirectory,
  isIpCameraNode,
  isNvrServerNode,
  isVoipPhoneNode,
} from '../network/poeAndVoipEngine';
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
  Server,
  Plus,
  Trash2,
  Lock,
  Unlock,
  Radio,
  PhoneCall,
  Camera,
  Video,
  ShieldAlert,
  Zap,
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
  onUpdateLinks?: (links: NetworkLink[], summaryMessage?: string) => void;
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
  onUpdateLinks,
  onTriggerDhcpSimulation,
  onTriggerTracerouteSimulation,
  onTriggerHttpSimulation,
  onLoadSimulationSteps,
  onClose,
}) => {
  const isWirelessDevice =
    node.deviceModel === 'laptop' ||
    node.deviceModel === 'smartphone' ||
    Boolean(node.wifiClientConfig) ||
    node.interfaces.some((i) => i.isWireless || i.shortName.toLowerCase().startsWith('wlan'));

  const isIpPhone = isVoipPhoneNode(node);
  const isIpCamera = isIpCameraNode(node);
  const isNvr = isNvrServerNode(node);

  const [activeTab, setActiveTab] = useState<
    'voip' | 'camera' | 'network' | 'wifi' | 'services' | 'console' | 'browser'
  >(
    node.type === 'server'
      ? 'services'
      : isIpPhone
      ? 'voip'
      : isIpCamera
      ? 'camera'
      : node.deviceModel === 'laptop' || node.deviceModel === 'smartphone'
      ? 'wifi'
      : 'network'
  );
  const [dialedNumber, setDialedNumber] = useState<string>(
    node.voipConfig?.extension === '101' ? '102' : '101'
  );
  const [voipCallFeedback, setVoipCallFeedback] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);
  const [cameraFeedback, setCameraFeedback] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);
  const [wifiPasswords, setWifiPasswords] = useState<Record<string, string>>({});
  const [wifiStatusMsg, setWifiStatusMsg] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);

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

  // L7 Server DNS / DHCP form state
  const [newDnsDomain, setNewDnsDomain] = useState('intranet.corp.local');
  const [newDnsIp, setNewDnsIp] = useState(primaryIface?.ipAddress || '192.168.2.100');
  const [newPoolName, setNewPoolName] = useState('CORP_POOL');
  const [newPoolNet, setNewPoolNet] = useState('192.168.1.0');
  const [newPoolMask, setNewPoolMask] = useState('255.255.255.0');
  const [newPoolGw, setNewPoolGw] = useState('192.168.1.1');
  const [newPoolDns, setNewPoolDns] = useState(primaryIface?.ipAddress || '192.168.2.100');
  const [newPoolStart, setNewPoolStart] = useState('192.168.1.50');
  const [newPoolEnd, setNewPoolEnd] = useState('192.168.1.150');
  const [selectedServiceId, setSelectedServiceId] = useState<
    'http' | 'dns' | 'dhcp' | 'sip' | 'nvr' | 'tftp' | 'syslog'
  >(() =>
    isNvr || node.name.toLowerCase().includes('nvr')
      ? 'nvr'
      : node.name.toLowerCase().includes('sip') || node.name.toLowerCase().includes('pbx')
      ? 'sip'
      : 'http'
  );
  const [newTftpFile, setNewTftpFile] = useState('branch-router-backup.cfg');

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
      className="fixed w-[740px] max-w-[95vw] select-none flex flex-col items-center"
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
              {isIpPhone && (
                <button
                  type="button"
                  data-testid={`pc-voip-tab-${node.id}`}
                  onClick={() => setActiveTab('voip')}
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium whitespace-nowrap transition-colors cursor-pointer ${
                    activeTab === 'voip'
                      ? 'bg-fuchsia-600 text-white shadow-xs'
                      : 'text-fuchsia-300 hover:text-slate-200 hover:bg-slate-900'
                  }`}
                >
                  <PhoneCall className="w-3.5 h-3.5 shrink-0" />
                  <span>VoIP Телефон (SIP)</span>
                </button>
              )}

              {isIpCamera && (
                <button
                  type="button"
                  data-testid={`pc-camera-tab-${node.id}`}
                  onClick={() => setActiveTab('camera')}
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium whitespace-nowrap transition-colors cursor-pointer ${
                    activeTab === 'camera'
                      ? 'bg-teal-600 text-white shadow-xs'
                      : 'text-teal-300 hover:text-slate-200 hover:bg-slate-900'
                  }`}
                >
                  <Camera className="w-3.5 h-3.5 shrink-0" />
                  <span>IP-Камера (RTSP)</span>
                </button>
              )}

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
                <span>Сеть и ARP</span>
              </button>

              {node.type !== 'server' && !isIpPhone && !isIpCamera && (
                <button
                  type="button"
                  data-testid={`pc-wifi-tab-${node.id}`}
                  onClick={() => setActiveTab('wifi')}
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium whitespace-nowrap transition-colors cursor-pointer ${
                    activeTab === 'wifi'
                      ? 'bg-cyan-600 text-white shadow-xs'
                      : isWirelessDevice
                      ? 'text-cyan-300 hover:text-slate-200 hover:bg-slate-900'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
                  }`}
                >
                  <Wifi className="w-3.5 h-3.5 shrink-0" />
                  <span>Wi-Fi 802.11</span>
                </button>
              )}

              {node.type === 'server' && (
                <button
                  type="button"
                  data-testid={`server-services-tab-${node.id}`}
                  title="Службы L7 (HTTP · DNS · DHCP)"
                  onClick={() => setActiveTab('services')}
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium whitespace-nowrap transition-colors cursor-pointer ${
                    activeTab === 'services'
                      ? 'bg-amber-600 text-white shadow-xs'
                      : 'text-amber-300 hover:text-slate-200 hover:bg-slate-900'
                  }`}
                >
                  <Server className="w-3.5 h-3.5 shrink-0" />
                  <span>Службы L7</span>
                </button>
              )}

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
                        MAC: <strong className="text-slate-300">{primaryIface?.macAddress || '—'}</strong>
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

                {/* Section 3: Live ARP Cache Table */}
                <div className="p-3 rounded-xl bg-slate-900/90 border border-slate-800 space-y-2">
                  <div className="flex items-center justify-between text-xs font-mono">
                    <span className="font-semibold text-slate-200">
                      Таблица ARP-кэша ({node.arpTable.length} записей)
                    </span>
                    {node.arpTable.length > 0 && (
                      <button
                        type="button"
                        onClick={() => onUpdateNode({ ...node, arpTable: [] })}
                        className="text-[11px] text-red-300 hover:text-red-200 underline cursor-pointer"
                      >
                        Очистить ARP (arp -d)
                      </button>
                    )}
                  </div>
                  {node.arpTable.length > 0 ? (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                      {node.arpTable.map((entry, i) => (
                        <div
                          key={`${entry.ipAddress}-${i}`}
                          className="px-2.5 py-1.5 rounded bg-slate-950 border border-slate-800 flex items-center justify-between text-xs font-mono"
                        >
                          <span className="text-sky-300 font-semibold">{entry.ipAddress}</span>
                          <span className="text-emerald-300">{entry.macAddress}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-[11px] font-mono text-slate-500">
                      Записи ARP отсутствуют. Отправьте Ping для разрешения MAC-адресов соседей.
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* TAB 1.5: SERVER SERVICES WITH LEFT SIDEBAR MENU & DEDICATED DETAIL PANE */}
            {activeTab === 'services' && node.type === 'server' && (() => {
              const currentServices = node.services || {
                httpEnabled: true,
                serverBanner: 'nginx/1.24.0 (NetPulse Enterprise)',
                httpTitle: `Welcome to ${node.name}`,
                httpBody: `Корпоративный портал ${node.name} работает в штатном режиме.`,
                dnsEnabled: true,
                dnsRecords: [],
                dhcpEnabled: false,
                dhcpPools: [],
                dhcpLeases: [],
                sipEnabled: true,
                sipDomain: 'voip.corp.local',
                sipExtensions: [],
                tftpEnabled: true,
                tftpFiles: [
                  'c2960x-universalk9-mz.152-7.E.bin',
                  'isr4300-universalk9.16.12.05.SPA.bin',
                  'asa914-smp-k8.bin',
                  'running-config-core.cfg',
                ],
                syslogEnabled: true,
                ntpEnabled: true,
                ntpStratum: 2,
              };

              const patchServices = (patch: Partial<typeof currentServices>) => {
                onUpdateNode({
                  ...node,
                  services: {
                    ...currentServices,
                    ...patch,
                  },
                });
              };

              const voipDirectory = getVoipDirectory(allNodes, allLinks);
              const cameraDirectory = getIpCameraDirectory(allNodes, allLinks);
              const dnsRecords = currentServices.dnsRecords || [];
              const dhcpPools = currentServices.dhcpPools || [];
              const dhcpLeases = currentServices.dhcpLeases || [];
              const tftpFiles = currentServices.tftpFiles || [
                'c2960x-universalk9-mz.152-7.E.bin',
                'isr4300-universalk9.16.12.05.SPA.bin',
                'asa914-smp-k8.bin',
                'running-config-core.cfg',
              ];

              const serviceItems: Array<{
                id: 'http' | 'dns' | 'dhcp' | 'sip' | 'nvr' | 'tftp' | 'syslog';
                title: string;
                protocolMeta: string;
                enabled: boolean;
                icon: React.ReactNode;
              }> = [
                {
                  id: 'http',
                  title: 'HTTP Веб-сервер',
                  protocolMeta: 'TCP 80 · HTML',
                  enabled: currentServices.httpEnabled !== false,
                  icon: <Globe className="w-3.5 h-3.5 shrink-0" />,
                },
                {
                  id: 'dns',
                  title: 'DNS Сервер имён',
                  protocolMeta: `UDP 53 · ${dnsRecords.length} зап.`,
                  enabled: currentServices.dnsEnabled !== false,
                  icon: <Server className="w-3.5 h-3.5 shrink-0" />,
                },
                {
                  id: 'dhcp',
                  title: 'DHCPv4 Пулы IP',
                  protocolMeta: `UDP 67 · ${dhcpPools.length} пул.`,
                  enabled: Boolean(currentServices.dhcpEnabled),
                  icon: <RefreshCw className="w-3.5 h-3.5 shrink-0" />,
                },
                {
                  id: 'sip',
                  title: 'SIP АТС (VoIP)',
                  protocolMeta: `UDP 5060 · ${voipDirectory.length} аб.`,
                  enabled: currentServices.sipEnabled !== false,
                  icon: <PhoneCall className="w-3.5 h-3.5 shrink-0" />,
                },
                {
                  id: 'nvr',
                  title: 'NVR Видеорегистратор',
                  protocolMeta: `RTSP 554 · ${cameraDirectory.length} кам.`,
                  enabled: currentServices.nvrEnabled ?? isNvr,
                  icon: <Video className="w-3.5 h-3.5 shrink-0" />,
                },
                {
                  id: 'tftp',
                  title: 'TFTP / FTP Файлы',
                  protocolMeta: `UDP 69 · ${tftpFiles.length} файл.`,
                  enabled: currentServices.tftpEnabled !== false,
                  icon: <Terminal className="w-3.5 h-3.5 shrink-0" />,
                },
                {
                  id: 'syslog',
                  title: 'Syslog и NTP',
                  protocolMeta: `UDP 514 / 123`,
                  enabled:
                    currentServices.syslogEnabled !== false ||
                    currentServices.ntpEnabled !== false,
                  icon: <Settings2 className="w-3.5 h-3.5 shrink-0" />,
                },
              ];

              const activeServicesCount = serviceItems.filter((s) => s.enabled).length;

              return (
                <div
                  data-testid={`server-services-layout-${node.id}`}
                  className="h-full flex overflow-hidden bg-slate-950"
                >
                  {/* LEFT SIDEBAR: SERVICE NAVIGATION LIST */}
                  <aside
                    data-testid="server-services-sidebar"
                    className="w-56 shrink-0 border-r border-slate-800 bg-slate-900/60 flex flex-col justify-between"
                  >
                    <div>
                      <div className="px-3.5 py-2.5 border-b border-slate-800/80 flex items-center justify-between">
                        <span className="text-xs font-semibold text-slate-200">
                          Службы сервера
                        </span>
                        <span className="text-[11px] font-mono text-slate-400 tabular-nums">
                          {activeServicesCount} из {serviceItems.length} ВКЛ
                        </span>
                      </div>

                      <nav
                        aria-label="Список сетевых служб сервера"
                        className="p-2 space-y-1"
                      >
                        {serviceItems.map((item) => {
                          const isSelected = selectedServiceId === item.id;
                          return (
                            <button
                              key={item.id}
                              type="button"
                              data-testid={`server-service-nav-${item.id}`}
                              onClick={() => setSelectedServiceId(item.id)}
                              className={`w-full px-2.5 py-2 rounded-lg text-left transition-colors flex items-center justify-between gap-2 cursor-pointer border ${
                                isSelected
                                  ? 'bg-slate-800/95 border-slate-700 text-white shadow-xs'
                                  : 'bg-transparent border-transparent text-slate-300 hover:bg-slate-900 hover:text-slate-100'
                              }`}
                            >
                              <div className="flex items-center gap-2 min-w-0">
                                <span
                                  className={
                                    isSelected
                                      ? 'text-amber-400'
                                      : item.enabled
                                      ? 'text-sky-400'
                                      : 'text-slate-500'
                                  }
                                >
                                  {item.icon}
                                </span>
                                <div className="min-w-0">
                                  <div className="text-xs font-medium truncate">
                                    {item.title}
                                  </div>
                                  <div className="text-[10px] font-mono text-slate-400 truncate tabular-nums">
                                    {item.protocolMeta}
                                  </div>
                                </div>
                              </div>

                              <span
                                className={`text-[10px] font-mono font-semibold shrink-0 ${
                                  item.enabled ? 'text-emerald-400' : 'text-slate-500'
                                }`}
                              >
                                {item.enabled ? 'ВКЛ' : 'ВЫКЛ'}
                              </span>
                            </button>
                          );
                        })}
                      </nav>
                    </div>

                    {/* Sidebar Footer: Server IPv4 & Gateway Context */}
                    <div className="px-3.5 py-2.5 border-t border-slate-800/80 bg-slate-950/60 space-y-0.5 text-[10px] font-mono text-slate-400">
                      <div className="flex items-center justify-between">
                        <span>IPv4 сервера:</span>
                        <span className="text-sky-300 font-semibold tabular-nums">
                          {primaryIface?.ipAddress || 'не задан'}
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span>Шлюз (GW):</span>
                        <span className="text-slate-300 tabular-nums">
                          {node.defaultGateway || '—'}
                        </span>
                      </div>
                    </div>
                  </aside>

                  {/* RIGHT DETAIL PANE: SINGLE SELECTED SERVICE */}
                  <div
                    data-testid={`server-service-panel-${selectedServiceId}`}
                    className="flex-1 min-w-0 h-full overflow-y-auto p-4"
                  >
                    {/* 1. HTTP WEB SERVER */}
                    {selectedServiceId === 'http' && (
                      <div className="space-y-4">
                        <div className="pb-3 border-b border-slate-800 flex items-start justify-between gap-3">
                          <div>
                            <h3 className="text-sm font-semibold text-slate-100">
                              Веб-сервер HTTP/1.1 (TCP порт 80)
                            </h3>
                            <p className="text-xs text-slate-400 mt-0.5">
                              Отвечает на запросы браузера HTTP GET 200 OK после установки 3-стороннего рукопожатия TCP SYN / SYN-ACK / ACK.
                            </p>
                          </div>
                          <button
                            type="button"
                            data-testid="server-http-toggle-btn"
                            onClick={() =>
                              patchServices({
                                httpEnabled: !(currentServices.httpEnabled ?? true),
                              })
                            }
                            className={`px-3 py-1.5 rounded-lg text-xs font-mono font-bold border shrink-0 cursor-pointer transition-colors ${
                              currentServices.httpEnabled !== false
                                ? 'bg-emerald-600 border-emerald-400 text-white'
                                : 'bg-slate-900 border-slate-700 text-slate-400 hover:text-slate-200'
                            }`}
                          >
                            {currentServices.httpEnabled !== false
                              ? 'HTTP 80: ВКЛ'
                              : 'HTTP 80: ВЫКЛ'}
                          </button>
                        </div>

                        <div className="space-y-3">
                          <div>
                            <div className="flex items-center justify-between mb-1">
                              <label className="text-xs font-medium text-slate-300">
                                Заголовок HTTP Server (Server Banner)
                              </label>
                              <div className="flex items-center gap-1">
                                {[
                                  'nginx/1.24.0 (NetPulse)',
                                  'Apache/2.4.58 (Unix)',
                                  'Microsoft-IIS/10.0',
                                ].map((preset) => (
                                  <button
                                    key={preset}
                                    type="button"
                                    onClick={() => patchServices({ serverBanner: preset })}
                                    className="px-2 py-0.5 rounded bg-slate-900 hover:bg-slate-800 border border-slate-800 text-[10px] font-mono text-slate-300 cursor-pointer"
                                  >
                                    {preset.split('/')[0]}
                                  </button>
                                ))}
                              </div>
                            </div>
                            <input
                              type="text"
                              aria-label="HTTP Server Banner"
                              value={
                                currentServices.serverBanner ||
                                'nginx/1.24.0 (NetPulse Enterprise)'
                              }
                              onChange={(e) =>
                                patchServices({ serverBanner: e.target.value })
                              }
                              className="w-full px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-700 text-xs font-mono text-slate-100 focus:outline-none focus:border-sky-500"
                            />
                          </div>

                          <div>
                            <label className="block text-xs font-medium text-slate-300 mb-1">
                              Заголовок веб-страницы (&lt;title&gt;)
                            </label>
                            <input
                              type="text"
                              aria-label="Заголовок страницы HTTP"
                              value={
                                currentServices.httpTitle ||
                                `Welcome to ${node.name} (${primaryIface?.ipAddress || 'Server'})`
                              }
                              onChange={(e) => patchServices({ httpTitle: e.target.value })}
                              className="w-full px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-700 text-xs text-slate-100 focus:outline-none focus:border-sky-500"
                            />
                          </div>

                          <div>
                            <label className="block text-xs font-medium text-slate-300 mb-1">
                              Содержимое главной страницы (/index.html)
                            </label>
                            <textarea
                              rows={4}
                              aria-label="Содержимое веб-страницы HTTP"
                              value={
                                currentServices.httpBody ||
                                `HTML-страница успешно загружена с узла ${node.name} (${
                                  primaryIface?.ipAddress || '192.168.2.100'
                                }) по протоколу HTTP/1.1 поверх TCP-соединения.`
                              }
                              onChange={(e) => patchServices({ httpBody: e.target.value })}
                              className="w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-700 text-xs font-mono text-slate-200 focus:outline-none focus:border-sky-500 resize-none"
                            />
                          </div>

                          <div className="p-2.5 rounded-lg bg-slate-900/80 border border-slate-800 flex items-center justify-between text-xs">
                            <span className="text-slate-400">
                              Адрес для проверки из вкладки «Браузер» на любом ПК:
                            </span>
                            <code className="font-mono text-sky-300">
                              http://{primaryIface?.ipAddress || '192.168.2.100'}/index.html
                            </code>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* 2. DNS SERVER */}
                    {selectedServiceId === 'dns' && (
                      <div className="space-y-4">
                        <div className="pb-3 border-b border-slate-800 flex items-start justify-between gap-3">
                          <div>
                            <h3 className="text-sm font-semibold text-slate-100">
                              Сервер имён DNS (UDP порт 53)
                            </h3>
                            <p className="text-xs text-slate-400 mt-0.5">
                              Разрешает доменные имена (FQDN) в IPv4-адреса при командах ping, nslookup, tracert и в веб-браузере.
                            </p>
                          </div>
                          <button
                            type="button"
                            data-testid="server-dns-toggle-btn"
                            onClick={() =>
                              patchServices({
                                dnsEnabled: !(currentServices.dnsEnabled ?? true),
                              })
                            }
                            className={`px-3 py-1.5 rounded-lg text-xs font-mono font-bold border shrink-0 cursor-pointer transition-colors ${
                              currentServices.dnsEnabled !== false
                                ? 'bg-emerald-600 border-emerald-400 text-white'
                                : 'bg-slate-900 border-slate-700 text-slate-400 hover:text-slate-200'
                            }`}
                          >
                            {currentServices.dnsEnabled !== false
                              ? 'DNS 53: ВКЛ'
                              : 'DNS 53: ВЫКЛ'}
                          </button>
                        </div>

                        <form
                          onSubmit={(e) => {
                            e.preventDefault();
                            if (!newDnsDomain.trim() || !isValidIpv4(newDnsIp)) return;
                            patchServices({
                              dnsEnabled: true,
                              dnsRecords: [
                                ...dnsRecords.filter(
                                  (r) =>
                                    r.domain.toLowerCase() !==
                                    newDnsDomain.trim().toLowerCase()
                                ),
                                {
                                  id: `dns-${Date.now()}`,
                                  domain: newDnsDomain.trim().toLowerCase(),
                                  ipAddress: newDnsIp.trim(),
                                },
                              ],
                            });
                            setNewDnsDomain('');
                          }}
                          className="p-3 rounded-lg bg-slate-900/80 border border-slate-800 space-y-2"
                        >
                          <div className="text-xs font-medium text-slate-300">
                            Добавить ресурсную A-запись (Host IPv4)
                          </div>
                          <div className="flex items-center gap-2">
                            <input
                              type="text"
                              aria-label="Доменное имя DNS"
                              value={newDnsDomain}
                              onChange={(e) => setNewDnsDomain(e.target.value)}
                              placeholder="app.corp.local"
                              className="min-w-0 flex-1 px-2.5 py-1.5 rounded-lg bg-slate-950 border border-slate-700 text-xs font-mono text-slate-100 focus:outline-none focus:border-sky-500"
                            />
                            <input
                              type="text"
                              aria-label="IP-адрес записи DNS"
                              value={newDnsIp}
                              onChange={(e) => setNewDnsIp(e.target.value)}
                              placeholder="192.168.2.100"
                              className="w-32 shrink-0 px-2.5 py-1.5 rounded-lg bg-slate-950 border border-slate-700 text-xs font-mono text-slate-100 focus:outline-none focus:border-sky-500"
                            />
                            <button
                              type="submit"
                              className="px-2.5 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-xs font-semibold text-white flex items-center gap-1 shrink-0 whitespace-nowrap cursor-pointer"
                            >
                              <Plus className="w-3.5 h-3.5 shrink-0" />
                              <span>A-запись</span>
                            </button>
                          </div>
                        </form>

                        <div className="space-y-1.5">
                          <div className="flex items-center justify-between text-xs text-slate-400">
                            <span>Таблица зоны DNS ({dnsRecords.length} записей)</span>
                            <span className="font-mono text-[11px]">IN A · TTL 3600s</span>
                          </div>

                          {dnsRecords.length === 0 ? (
                            <div className="p-4 rounded-lg bg-slate-900/50 border border-slate-800 text-center text-xs text-slate-500">
                              Записи DNS отсутствуют. Добавьте домен выше для разрешения имён.
                            </div>
                          ) : (
                            <div className="rounded-lg border border-slate-800 overflow-hidden bg-slate-900/40 divide-y divide-slate-800/80">
                              {dnsRecords.map((rec) => (
                                <div
                                  key={rec.id}
                                  className="px-3 py-2 flex items-center justify-between text-xs font-mono"
                                >
                                  <div className="flex items-center gap-3 min-w-0">
                                    <span className="text-amber-300 font-semibold truncate">
                                      {rec.domain}
                                    </span>
                                    <span className="text-slate-500">IN A</span>
                                    <span className="text-sky-300 tabular-nums">
                                      {rec.ipAddress}
                                    </span>
                                  </div>
                                  <button
                                    type="button"
                                    onClick={() =>
                                      patchServices({
                                        dnsRecords: dnsRecords.filter(
                                          (r) => r.id !== rec.id
                                        ),
                                      })
                                    }
                                    className="p-1 rounded text-slate-400 hover:text-red-400 cursor-pointer"
                                    title="Удалить запись DNS"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    )}

                    {/* 3. DHCPv4 SERVER */}
                    {selectedServiceId === 'dhcp' && (
                      <div className="space-y-4">
                        <div className="pb-3 border-b border-slate-800 flex items-start justify-between gap-3">
                          <div>
                            <h3 className="text-sm font-semibold text-slate-100">
                              Сервер DHCPv4 (UDP порты 67 / 68)
                            </h3>
                            <p className="text-xs text-slate-400 mt-0.5">
                              Автоматически выдаёт IPv4-адреса, маску, шлюз и DNS по процессу DORA напрямую в VLAN или через маршрутизатор с ip helper-address.
                            </p>
                          </div>
                          <button
                            type="button"
                            data-testid="server-dhcp-toggle-btn"
                            onClick={() =>
                              patchServices({
                                dhcpEnabled: !(currentServices.dhcpEnabled ?? false),
                              })
                            }
                            className={`px-3 py-1.5 rounded-lg text-xs font-mono font-bold border shrink-0 cursor-pointer transition-colors ${
                              currentServices.dhcpEnabled
                                ? 'bg-emerald-600 border-emerald-400 text-white'
                                : 'bg-slate-900 border-slate-700 text-slate-400 hover:text-slate-200'
                            }`}
                          >
                            {currentServices.dhcpEnabled
                              ? 'DHCP 67: ВКЛ'
                              : 'DHCP 67: ВЫКЛ'}
                          </button>
                        </div>

                        <form
                          onSubmit={(e) => {
                            e.preventDefault();
                            if (
                              !isValidIpv4(newPoolNet) ||
                              !isValidIpv4(newPoolStart) ||
                              !isValidIpv4(newPoolEnd)
                            )
                              return;
                            patchServices({
                              dhcpEnabled: true,
                              dhcpPools: [
                                ...dhcpPools,
                                {
                                  id: `srv-pool-${Date.now()}`,
                                  poolName: newPoolName.trim() || 'CORP_POOL',
                                  network: newPoolNet.trim(),
                                  mask: newPoolMask.trim() || '255.255.255.0',
                                  defaultRouter: newPoolGw.trim(),
                                  dnsServer: newPoolDns.trim(),
                                  startIp: newPoolStart.trim(),
                                  endIp: newPoolEnd.trim(),
                                },
                              ],
                            });
                          }}
                          className="p-3 rounded-lg bg-slate-900/80 border border-slate-800 space-y-2.5"
                        >
                          <div className="text-xs font-medium text-slate-300">
                            Создать новый пул адресов DHCPv4
                          </div>
                          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                            <div>
                              <label className="block text-[10px] text-slate-400 mb-0.5 truncate">
                                Имя пула
                              </label>
                              <input
                                type="text"
                                value={newPoolName}
                                onChange={(e) => setNewPoolName(e.target.value)}
                                placeholder="CORP_POOL"
                                className="w-full px-2 py-1 rounded bg-slate-950 border border-slate-700 font-mono text-slate-100"
                              />
                            </div>
                            <div>
                              <label className="block text-[10px] text-slate-400 mb-0.5 truncate">
                                Сеть (Network)
                              </label>
                              <input
                                type="text"
                                value={newPoolNet}
                                onChange={(e) => setNewPoolNet(e.target.value)}
                                placeholder="192.168.1.0"
                                className="w-full px-2 py-1 rounded bg-slate-950 border border-slate-700 font-mono text-slate-100"
                              />
                            </div>
                            <div>
                              <label className="block text-[10px] text-slate-400 mb-0.5 truncate">
                                Основной шлюз
                              </label>
                              <input
                                type="text"
                                value={newPoolGw}
                                onChange={(e) => setNewPoolGw(e.target.value)}
                                placeholder="192.168.1.1"
                                className="w-full px-2 py-1 rounded bg-slate-950 border border-slate-700 font-mono text-slate-100"
                              />
                            </div>
                            <div>
                              <label className="block text-[10px] text-slate-400 mb-0.5 truncate">
                                DNS-сервер
                              </label>
                              <input
                                type="text"
                                value={newPoolDns}
                                onChange={(e) => setNewPoolDns(e.target.value)}
                                placeholder="192.168.2.100"
                                className="w-full px-2 py-1 rounded bg-slate-950 border border-slate-700 font-mono text-slate-100"
                              />
                            </div>
                            <div>
                              <label className="block text-[10px] text-slate-400 mb-0.5 truncate">
                                Начальный IP
                              </label>
                              <input
                                type="text"
                                value={newPoolStart}
                                onChange={(e) => setNewPoolStart(e.target.value)}
                                placeholder="192.168.1.50"
                                className="w-full px-2 py-1 rounded bg-slate-950 border border-slate-700 font-mono text-slate-100"
                              />
                            </div>
                            <div>
                              <label className="block text-[10px] text-slate-400 mb-0.5 truncate">
                                Конечный IP
                              </label>
                              <input
                                type="text"
                                value={newPoolEnd}
                                onChange={(e) => setNewPoolEnd(e.target.value)}
                                placeholder="192.168.1.150"
                                className="w-full px-2 py-1 rounded bg-slate-950 border border-slate-700 font-mono text-slate-100"
                              />
                            </div>
                            <div>
                              <label className="block text-[10px] text-slate-400 mb-0.5 truncate">
                                Маска подсети
                              </label>
                              <input
                                type="text"
                                value={newPoolMask}
                                onChange={(e) => setNewPoolMask(e.target.value)}
                                placeholder="255.255.255.0"
                                className="w-full px-2 py-1 rounded bg-slate-950 border border-slate-700 font-mono text-slate-100"
                              />
                            </div>
                            <div className="flex items-end">
                              <button
                                type="submit"
                                className="w-full py-1 px-2.5 rounded bg-amber-600 hover:bg-amber-500 font-semibold text-white cursor-pointer whitespace-nowrap"
                              >
                                + Пул DHCP
                              </button>
                            </div>
                          </div>
                        </form>

                        <div className="space-y-1.5">
                          <div className="flex items-center justify-between text-xs text-slate-400">
                            <span>Настроенные пулы DHCP ({dhcpPools.length})</span>
                            <span className="font-mono text-[11px] tabular-nums">
                              Выдано аренд: {dhcpLeases.length}
                            </span>
                          </div>

                          {dhcpPools.length === 0 ? (
                            <div className="p-4 rounded-lg bg-slate-900/50 border border-slate-800 text-center text-xs text-slate-500">
                              Пулы DHCP не созданы. Добавьте пул адресов выше.
                            </div>
                          ) : (
                            <div className="space-y-1.5">
                              {dhcpPools.map((pool) => {
                                const poolLeases = dhcpLeases.filter(
                                  (l) => l.poolName === pool.poolName
                                );
                                return (
                                  <div
                                    key={pool.id}
                                    className="p-2.5 rounded-lg bg-slate-900/60 border border-slate-800 flex items-center justify-between text-xs font-mono"
                                  >
                                    <div className="space-y-0.5">
                                      <div>
                                        <span className="font-bold text-amber-300">
                                          {pool.poolName}
                                        </span>
                                        <span className="text-slate-300 ml-2 tabular-nums">
                                          {pool.network}/
                                          {maskToCidr(pool.mask || '255.255.255.0')} (
                                          {pool.startIp} – {pool.endIp})
                                        </span>
                                      </div>
                                      <div className="text-[11px] text-slate-400 tabular-nums">
                                        Шлюз: {pool.defaultRouter || '—'} · DNS:{' '}
                                        {pool.dnsServer || '—'} · Аренд:{' '}
                                        <strong className="text-emerald-300">
                                          {poolLeases.length}
                                        </strong>
                                      </div>
                                    </div>
                                    <button
                                      type="button"
                                      onClick={() =>
                                        patchServices({
                                          dhcpPools: dhcpPools.filter(
                                            (p) => p.id !== pool.id
                                          ),
                                        })
                                      }
                                      className="p-1 rounded text-slate-400 hover:text-red-400 cursor-pointer"
                                      title="Удалить пул DHCP"
                                    >
                                      <Trash2 className="w-3.5 h-3.5" />
                                    </button>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>

                        {dhcpLeases.length > 0 && (
                          <div className="space-y-1.5">
                            <div className="text-xs text-slate-400">
                              Активные аренды адресов (DHCP Bindings)
                            </div>
                            <div className="rounded-lg border border-slate-800 overflow-hidden bg-slate-900/40 divide-y divide-slate-800/80 text-xs font-mono">
                              {dhcpLeases.map((lease, idx) => (
                                <div
                                  key={`${lease.ipAddress}-${idx}`}
                                  className="px-3 py-1.5 flex items-center justify-between"
                                >
                                  <span className="text-sky-300 font-semibold tabular-nums">
                                    {lease.ipAddress}
                                  </span>
                                  <span className="text-slate-300">{lease.hostname}</span>
                                  <span className="text-emerald-300 tabular-nums">
                                    {lease.macAddress}
                                  </span>
                                  <span className="text-amber-300">{lease.poolName}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    {/* 4. SIP REGISTRAR / IP-PBX (VoIP) */}
                    {selectedServiceId === 'sip' && (
                      <div
                        data-testid="server-sip-pbx-section"
                        className="space-y-4"
                      >
                        <div className="pb-3 border-b border-slate-800 flex items-start justify-between gap-3">
                          <div>
                            <h3 className="text-sm font-semibold text-slate-100 flex items-center gap-1.5">
                              <PhoneCall className="w-4 h-4 text-fuchsia-400" />
                              <span>SIP Registrar / IP-АТС (UDP порт 5060)</span>
                            </h3>
                            <p className="text-xs text-slate-400 mt-0.5">
                              Регистрирует абонентские IP-телефоны Cisco 7960G в Voice VLAN и маршрутизирует вызовы SIP INVITE / 200 OK + голосовой поток RTP.
                            </p>
                          </div>
                          <button
                            type="button"
                            data-testid="server-sip-toggle-btn"
                            onClick={() =>
                              patchServices({
                                sipEnabled: !(currentServices.sipEnabled ?? true),
                              })
                            }
                            className={`px-3 py-1.5 rounded-lg text-xs font-mono font-bold border shrink-0 cursor-pointer transition-colors ${
                              currentServices.sipEnabled !== false
                                ? 'bg-fuchsia-600 border-fuchsia-400 text-white'
                                : 'bg-slate-900 border-slate-700 text-slate-400 hover:text-slate-200'
                            }`}
                          >
                            {currentServices.sipEnabled !== false
                              ? 'SIP 5060: ВКЛ'
                              : 'SIP 5060: ВЫКЛ'}
                          </button>
                        </div>

                        <div className="p-3 rounded-lg bg-slate-900/80 border border-slate-800 flex items-center justify-between gap-3">
                          <label className="text-xs font-medium text-slate-300 shrink-0">
                            Домен SIP Registrar (SIP URI Realm):
                          </label>
                          <input
                            type="text"
                            aria-label="Домен SIP сервера"
                            value={currentServices.sipDomain || 'voip.corp.local'}
                            onChange={(e) => patchServices({ sipDomain: e.target.value })}
                            className="flex-1 px-2.5 py-1 rounded bg-slate-950 border border-slate-700 text-xs font-mono text-fuchsia-300"
                          />
                        </div>

                        <div className="space-y-1.5">
                          <div className="flex items-center justify-between text-xs text-slate-400">
                            <span>
                              Справочник абонентов VoIP в топологии ({voipDirectory.length})
                            </span>
                            <span className="font-mono text-[11px]">
                              Кодеки: G.711u / G.729a / Opus · DSCP EF (46)
                            </span>
                          </div>

                          {voipDirectory.length === 0 ? (
                            <div className="p-4 rounded-lg bg-slate-900/50 border border-slate-800 text-center text-xs text-slate-500">
                              В топологии нет IP-телефонов. Добавьте IP-Телефон из панели устройств.
                            </div>
                          ) : (
                            <div className="rounded-lg border border-slate-800 overflow-hidden bg-slate-900/40 divide-y divide-slate-800/80">
                              {voipDirectory.map((entry) => (
                                <div
                                  key={entry.nodeId}
                                  className="px-3 py-2 flex items-center justify-between text-xs font-mono"
                                >
                                  <div className="flex items-center gap-2.5 min-w-0">
                                    <span className="px-2 py-0.5 rounded bg-fuchsia-500/20 border border-fuchsia-500/40 text-fuchsia-300 font-bold tabular-nums">
                                      Ext {entry.extension}
                                    </span>
                                    <span className="text-slate-100 font-semibold truncate">
                                      {entry.displayName}
                                    </span>
                                    <span className="text-slate-500 truncate">
                                      ({entry.nodeName})
                                    </span>
                                  </div>
                                  <div className="flex items-center gap-2.5 shrink-0 tabular-nums">
                                    <span className="text-sky-300">{entry.ipAddress}</span>
                                    <span className="text-indigo-300">
                                      VLAN {entry.voiceVlan}
                                    </span>
                                    <span
                                      className={`text-[10px] font-bold ${
                                        entry.isPowered
                                          ? 'text-emerald-400'
                                          : 'text-red-400'
                                      }`}
                                    >
                                      {entry.isPowered ? 'REGISTERED' : 'NO PoE'}
                                    </span>
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    )}

                    {/* 4.5 NVR VIDEO SURVEILLANCE RECORDER (RTSP / RTP / MULTICAST) */}
                    {selectedServiceId === 'nvr' && (
                      <div
                        data-testid="server-nvr-section"
                        className="space-y-4"
                      >
                        <div className="pb-3 border-b border-slate-800 flex items-start justify-between gap-3">
                          <div>
                            <h3 className="text-sm font-semibold text-slate-100 flex items-center gap-1.5">
                              <Video className="w-4 h-4 text-teal-400" />
                              <span>Видеорегистратор NVR (RTSP TCP 554 · RTP UDP 5004)</span>
                            </h3>
                            <p className="text-xs text-slate-400 mt-0.5">
                              Принимает и архивирует видеопотоки H.265/H.264 от PoE IP-камер в выделенном CCTV VLAN (Unicast и Multicast 239.0.30.x).
                            </p>
                          </div>
                          <button
                            type="button"
                            data-testid="server-nvr-toggle-btn"
                            onClick={() =>
                              patchServices({
                                nvrEnabled: !(currentServices.nvrEnabled ?? isNvr),
                              })
                            }
                            className={`px-3 py-1.5 rounded-lg text-xs font-mono font-bold border shrink-0 cursor-pointer transition-colors ${
                              (currentServices.nvrEnabled ?? isNvr)
                                ? 'bg-teal-600 border-teal-400 text-white'
                                : 'bg-slate-900 border-slate-700 text-slate-400 hover:text-slate-200'
                            }`}
                          >
                            {(currentServices.nvrEnabled ?? isNvr)
                              ? 'NVR 554: ВКЛ'
                              : 'NVR 554: ВЫКЛ'}
                          </button>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 p-3 rounded-lg bg-slate-900/80 border border-slate-800 text-xs">
                          <div>
                            <label className="block text-[10px] text-slate-400 mb-1">
                              Дисковый массив RAID-6 (ТБ)
                            </label>
                            <input
                              type="number"
                              min={1}
                              max={256}
                              value={currentServices.nvrStorageTb ?? 16}
                              onChange={(e) =>
                                patchServices({
                                  nvrStorageTb: Math.max(1, Number(e.target.value) || 16),
                                })
                              }
                              className="w-full px-2.5 py-1 rounded bg-slate-950 border border-slate-700 font-mono text-teal-300"
                            />
                          </div>
                          <div>
                            <label className="block text-[10px] text-slate-400 mb-1">
                              Глубина видеоархива (суток)
                            </label>
                            <input
                              type="number"
                              min={1}
                              max={365}
                              value={currentServices.nvrRetentionDays ?? 30}
                              onChange={(e) =>
                                patchServices({
                                  nvrRetentionDays: Math.max(1, Number(e.target.value) || 30),
                                })
                              }
                              className="w-full px-2.5 py-1 rounded bg-slate-950 border border-slate-700 font-mono text-slate-200"
                            />
                          </div>
                          <div>
                            <label className="block text-[10px] text-slate-400 mb-1">
                              Multicast-группа IGMP
                            </label>
                            <input
                              type="text"
                              value={currentServices.nvrMulticastGroup || '239.0.30.1'}
                              onChange={(e) =>
                                patchServices({ nvrMulticastGroup: e.target.value })
                              }
                              className="w-full px-2.5 py-1 rounded bg-slate-950 border border-slate-700 font-mono text-amber-300"
                            />
                          </div>
                        </div>

                        <div className="space-y-2">
                          <div className="flex items-center justify-between text-xs text-slate-400">
                            <span>
                              Каналы IP-камер в топологии ({cameraDirectory.length})
                            </span>
                            <span className="font-mono text-[11px] text-teal-300">
                              RTSP TCP 554 · RTP Video UDP 5004
                            </span>
                          </div>

                          {cameraDirectory.length === 0 ? (
                            <div className="p-4 rounded-lg bg-slate-900/50 border border-slate-800 text-center text-xs text-slate-500">
                              В топологии нет IP-камер. Добавьте «IP-Камера (PoE)» из левой панели устройств.
                            </div>
                          ) : (
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                              {cameraDirectory.map((cam, idx) => (
                                <div
                                  key={cam.nodeId}
                                  data-testid={`nvr-channel-card-${cam.nodeId}`}
                                  className="p-2.5 rounded-lg bg-slate-900/90 border border-slate-800 flex flex-col justify-between space-y-2"
                                >
                                  {/* Mini CCTV OSD Monitor Header */}
                                  <div className="flex items-center justify-between text-[11px] font-mono">
                                    <span className="font-bold text-teal-300 truncate">
                                      CH0{idx + 1} · {cam.nodeName}
                                    </span>
                                    <span
                                      className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${
                                        cam.isPowered
                                          ? 'bg-emerald-950 text-emerald-300 border border-emerald-500/50'
                                          : 'bg-red-950 text-red-300 border border-red-500/50'
                                      }`}
                                    >
                                      {cam.isPowered ? '● REC' : 'NO PoE'}
                                    </span>
                                  </div>

                                  {/* Simulated Video Feed Frame */}
                                  <div className="px-2.5 py-2 rounded bg-slate-950 border border-slate-800/90 font-mono text-[10px] space-y-1">
                                    <div className="text-slate-200 truncate font-semibold">
                                      {cam.cameraName}
                                    </div>
                                    <div className="flex items-center justify-between text-slate-400">
                                      <span>{cam.ipAddress} (VLAN {cam.surveillanceVlan})</span>
                                      <span className="text-teal-300">{cam.codec.split(' ')[0]}</span>
                                    </div>
                                    <div className="flex items-center justify-between text-slate-400">
                                      <span>{cam.resolution}</span>
                                      <span>
                                        {cam.streamMode === 'multicast'
                                          ? `Mcast ${cam.multicastGroupIp}`
                                          : `Unicast → ${cam.nvrTargetIp}`}
                                      </span>
                                    </div>
                                  </div>

                                  <button
                                    type="button"
                                    data-testid={`nvr-pull-rtsp-btn-${cam.nodeId}`}
                                    onClick={() => {
                                      const target =
                                        cam.streamMode === 'multicast'
                                          ? cam.multicastGroupIp
                                          : primaryIface?.ipAddress || cam.nvrTargetIp;
                                      const res = runRtspVideoStreamSimulation(
                                        allNodes,
                                        allLinks,
                                        cam.nodeId,
                                        target,
                                        cam.streamMode
                                      );
                                      onUpdateAllNodes(res.updatedNodes);
                                      onLoadSimulationSteps(res.steps, res.summaryMessage);
                                    }}
                                    className="w-full py-1.5 px-2.5 rounded-lg bg-teal-600/90 hover:bg-teal-500 text-[11px] font-semibold text-white flex items-center justify-center gap-1.5 cursor-pointer transition-colors"
                                  >
                                    <Video className="w-3.5 h-3.5 shrink-0" />
                                    <span>Запросить поток RTSP ({cam.streamMode})</span>
                                  </button>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    )}

                    {/* 5. TFTP / FTP FILE & IOS IMAGE SERVER */}
                    {selectedServiceId === 'tftp' && (
                      <div className="space-y-4">
                        <div className="pb-3 border-b border-slate-800 flex items-start justify-between gap-3">
                          <div>
                            <h3 className="text-sm font-semibold text-slate-100">
                              Файловый сервер TFTP / FTP (UDP 69 · TCP 21)
                            </h3>
                            <p className="text-xs text-slate-400 mt-0.5">
                              Хранилище образов прошивок Cisco IOS и резервных копий конфигураций (copy running-config tftp:).
                            </p>
                          </div>
                          <button
                            type="button"
                            data-testid="server-tftp-toggle-btn"
                            onClick={() =>
                              patchServices({
                                tftpEnabled: !(currentServices.tftpEnabled ?? true),
                              })
                            }
                            className={`px-3 py-1.5 rounded-lg text-xs font-mono font-bold border shrink-0 cursor-pointer transition-colors ${
                              currentServices.tftpEnabled !== false
                                ? 'bg-emerald-600 border-emerald-400 text-white'
                                : 'bg-slate-900 border-slate-700 text-slate-400 hover:text-slate-200'
                            }`}
                          >
                            {currentServices.tftpEnabled !== false
                              ? 'TFTP 69: ВКЛ'
                              : 'TFTP 69: ВЫКЛ'}
                          </button>
                        </div>

                        <form
                          onSubmit={(e) => {
                            e.preventDefault();
                            if (!newTftpFile.trim()) return;
                            patchServices({
                              tftpEnabled: true,
                              tftpFiles: [
                                ...tftpFiles.filter((f) => f !== newTftpFile.trim()),
                                newTftpFile.trim(),
                              ],
                            });
                            setNewTftpFile('');
                          }}
                          className="flex items-center gap-2"
                        >
                          <input
                            type="text"
                            aria-label="Имя файла на TFTP сервере"
                            value={newTftpFile}
                            onChange={(e) => setNewTftpFile(e.target.value)}
                            placeholder="router-startup-config.cfg"
                            className="flex-1 px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-700 text-xs font-mono text-slate-100"
                          />
                          <button
                            type="submit"
                            className="px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-xs font-semibold text-white flex items-center gap-1 cursor-pointer"
                          >
                            <Plus className="w-3.5 h-3.5" />
                            <span>Добавить файл</span>
                          </button>
                        </form>

                        <div className="rounded-lg border border-slate-800 overflow-hidden bg-slate-900/40 divide-y divide-slate-800/80 text-xs font-mono">
                          {tftpFiles.map((fileName) => (
                            <div
                              key={fileName}
                              className="px-3 py-2 flex items-center justify-between"
                            >
                              <div className="flex items-center gap-2 min-w-0">
                                <span className="text-sky-300 truncate">{fileName}</span>
                                <span className="text-[10px] text-slate-500">
                                  {fileName.endsWith('.bin') ? 'Образ IOS' : 'Конфигурация'}
                                </span>
                              </div>
                              <button
                                type="button"
                                onClick={() =>
                                  patchServices({
                                    tftpFiles: tftpFiles.filter((f) => f !== fileName),
                                  })
                                }
                                className="p-1 rounded text-slate-400 hover:text-red-400 cursor-pointer"
                                title="Удалить файл"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* 6. SYSLOG & NTP SERVER */}
                    {selectedServiceId === 'syslog' && (
                      <div className="space-y-4">
                        <div className="pb-3 border-b border-slate-800 flex items-start justify-between gap-3">
                          <div>
                            <h3 className="text-sm font-semibold text-slate-100">
                              Службы Syslog (UDP 514) и точного времени NTP (UDP 123)
                            </h3>
                            <p className="text-xs text-slate-400 mt-0.5">
                              Централизованный сбор системных сообщений маршрутизаторов и синхронизация часов сетевой инфраструктуры.
                            </p>
                          </div>
                          <div className="flex items-center gap-1.5 shrink-0">
                            <button
                              type="button"
                              data-testid="server-syslog-toggle-btn"
                              onClick={() =>
                                patchServices({
                                  syslogEnabled: !(currentServices.syslogEnabled ?? true),
                                })
                              }
                              className={`px-2.5 py-1.5 rounded-lg text-xs font-mono font-bold border cursor-pointer ${
                                currentServices.syslogEnabled !== false
                                  ? 'bg-emerald-600 border-emerald-400 text-white'
                                  : 'bg-slate-900 border-slate-700 text-slate-400'
                              }`}
                            >
                              {currentServices.syslogEnabled !== false
                                ? 'SYSLOG: ВКЛ'
                                : 'SYSLOG: ВЫКЛ'}
                            </button>
                            <button
                              type="button"
                              data-testid="server-ntp-toggle-btn"
                              onClick={() =>
                                patchServices({
                                  ntpEnabled: !(currentServices.ntpEnabled ?? true),
                                })
                              }
                              className={`px-2.5 py-1.5 rounded-lg text-xs font-mono font-bold border cursor-pointer ${
                                currentServices.ntpEnabled !== false
                                  ? 'bg-sky-600 border-sky-400 text-white'
                                  : 'bg-slate-900 border-slate-700 text-slate-400'
                              }`}
                            >
                              {currentServices.ntpEnabled !== false
                                ? 'NTP: ВКЛ'
                                : 'NTP: ВЫКЛ'}
                            </button>
                          </div>
                        </div>

                        <div className="p-3 rounded-lg bg-slate-900/80 border border-slate-800 flex items-center justify-between gap-3">
                          <div>
                            <div className="text-xs font-medium text-slate-200">
                              Уровень эталонного источника времени (NTP Stratum)
                            </div>
                            <div className="text-[11px] text-slate-400">
                              Команда привязки на Cisco IOS: <code className="text-sky-300">ntp server {primaryIface?.ipAddress || '192.168.2.100'}</code>
                            </div>
                          </div>
                          <select
                            aria-label="Уровень NTP Stratum"
                            value={currentServices.ntpStratum || 2}
                            onChange={(e) =>
                              patchServices({ ntpStratum: Number(e.target.value) || 2 })
                            }
                            className="px-2.5 py-1.5 rounded-lg bg-slate-950 border border-slate-700 text-xs font-mono text-sky-300"
                          >
                            <option value={1}>Stratum 1 (GPS / Atomic)</option>
                            <option value={2}>Stratum 2 (Primary Corp)</option>
                            <option value={3}>Stratum 3 (Branch Sync)</option>
                          </select>
                        </div>

                        <div className="space-y-1.5">
                          <div className="text-xs text-slate-400">
                            Журнал приёмника Syslog (UDP 514 · Facility LOCAL7)
                          </div>
                          <div className="p-3 rounded-lg bg-slate-900/60 border border-slate-800 font-mono text-[11px] text-slate-300 space-y-1.5">
                            <div>
                              <span className="text-slate-500">Oct 29 09:00:01</span>{' '}
                              <span className="text-sky-300">{node.name}</span>{' '}
                              <span className="text-emerald-400">%SYS-5-RESTART:</span> Службы L7 инициализированы на {primaryIface?.ipAddress || '0.0.0.0'}
                            </div>
                            <div>
                              <span className="text-slate-500">Oct 29 09:00:04</span>{' '}
                              <span className="text-sky-300">{node.name}</span>{' '}
                              <span className="text-amber-300">%NTP-6-SYNC:</span> Часы синхронизированы (Stratum {currentServices.ntpStratum || 2})
                            </div>
                            <div>
                              <span className="text-slate-500">Oct 29 09:00:10</span>{' '}
                              <span className="text-sky-300">{node.name}</span>{' '}
                              <span className="text-indigo-300">%LINK-3-UPDOWN:</span> Интерфейс {primaryIface?.shortName || 'eth0'} перешёл в состояние {isLinkUp ? 'UP' : 'DOWN'}
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              );
            })()}

            {/* TAB 0.5: POE IP CAMERA (RTSP / MULTICAST STREAMING + CCTV VLAN 30 + ACL WAN ISOLATION TEST) */}
            {activeTab === 'camera' && isIpCamera && (() => {
              const rawCfg = node.ipCameraConfig;
              const camCfg = {
                enabled: rawCfg?.enabled ?? true,
                channelNumber: rawCfg?.channelNumber ?? 1,
                locationName: rawCfg?.locationName || rawCfg?.cameraName || `CCTV ${node.name}`,
                cameraName: rawCfg?.cameraName || rawCfg?.locationName || `CCTV ${node.name}`,
                streamUrl:
                  rawCfg?.streamUrl ||
                  `rtsp://${primaryIface?.ipAddress || '192.168.30.11'}:${rawCfg?.rtspPort || 554}/live/ch01`,
                nvrServerIp: rawCfg?.nvrServerIp || rawCfg?.nvrTargetIp || '192.168.30.100',
                nvrTargetIp: rawCfg?.nvrTargetIp || rawCfg?.nvrServerIp || '192.168.30.100',
                multicastGroupIp: rawCfg?.multicastGroupIp || '239.0.30.1',
                streamMode: rawCfg?.streamMode || ('unicast' as const),
                videoCodec: rawCfg?.videoCodec || rawCfg?.codec || 'H.265 (HEVC)',
                codec: rawCfg?.codec || rawCfg?.videoCodec || 'H.265 (HEVC)',
                resolution: rawCfg?.resolution || '4K (3840×2160)',
                fps: rawCfg?.fps || 30,
                bitrateKbps: rawCfg?.bitrateKbps || 6144,
                rtspPort: rawCfg?.rtspPort || 554,
                rtpVideoPort: rawCfg?.rtpVideoPort || 5004,
                surveillanceVlan: rawCfg?.surveillanceVlan || primaryIface?.accessVlan || 30,
                poeClassWatts: rawCfg?.poeClassWatts ?? rawCfg?.poeRequiredWatts ?? 9.5,
                poeRequiredWatts: rawCfg?.poeRequiredWatts ?? rawCfg?.poeClassWatts ?? 9.5,
                poePowered: rawCfg?.poePowered ?? true,
                acAdapterConnected: rawCfg?.acAdapterConnected ?? false,
                irNightVision: rawCfg?.irNightVision ?? true,
                motionDetection: rawCfg?.motionDetection ?? true,
                status: rawCfg?.status || ('streaming' as const),
              };

              const poeState = getPoweredDevicePoeState(node, allNodes, allLinks);

              const patchCamConfig = (patch: Partial<typeof camCfg>) => {
                onUpdateNode({
                  ...node,
                  ipCameraConfig: {
                    ...camCfg,
                    ...patch,
                  },
                });
              };

              const handleTriggerRtspStream = (modeOverride?: 'unicast' | 'multicast') => {
                const effectiveMode = modeOverride || camCfg.streamMode;
                const target =
                  effectiveMode === 'multicast'
                    ? camCfg.multicastGroupIp
                    : camCfg.nvrTargetIp;
                const res = runRtspVideoStreamSimulation(
                  allNodes,
                  allLinks,
                  node.id,
                  target,
                  effectiveMode
                );
                onUpdateAllNodes(res.updatedNodes);
                onLoadSimulationSteps(res.steps, res.summaryMessage);
                setCameraFeedback({
                  ok: res.success,
                  message: res.summaryMessage,
                });
              };

              const handleTestInternetIsolation = () => {
                const wanNode = allNodes.find(
                  (n) =>
                    n.id !== node.id &&
                    n.interfaces.some((i) => i.ipAddress?.startsWith('203.0.113.'))
                );
                const wanIp =
                  wanNode?.interfaces.find((i) => i.ipAddress?.startsWith('203.0.113.'))
                    ?.ipAddress || '203.0.113.100';
                const res = runPacketSimulation(allNodes, allLinks, node.id, wanIp, 'ICMP');
                onUpdateAllNodes(res.updatedNodes);
                onLoadSimulationSteps(res.steps, res.summaryMessage);
                const blockedByAclOrFw =
                  !res.success &&
                  res.steps.some(
                    (s) =>
                      s.status === 'dropped' &&
                      (s.decisionTitle.includes('ACL') || s.decisionTitle.includes('Firewall'))
                  );
                setCameraFeedback({
                  ok: blockedByAclOrFw,
                  message: blockedByAclOrFw
                    ? `[Изоляция подтверждена]: Попытка выхода камеры ${node.name} в Интернет (${wanIp}) заблокирована правилом ACL/Firewall!`
                    : res.summaryMessage,
                });
              };

              return (
                <div className="p-3.5 space-y-3" data-testid={`ip-camera-panel-${node.id}`}>
                  <div className="grid grid-cols-1 sm:grid-cols-12 gap-3">
                    {/* Left 7 cols: Live CCTV OSD Viewfinder */}
                    <div className="sm:col-span-7 p-3 rounded-xl bg-slate-900/95 border border-teal-500/40 flex flex-col justify-between space-y-2.5">
                      <div className="flex items-center justify-between text-[10px] font-mono text-slate-400">
                        <span className="font-bold text-teal-300">
                          PoE IP-КАМЕРА ВИДЕОНАБЛЮДЕНИЯ · RTSP / ONVIF
                        </span>
                        <span
                          data-testid="ip-camera-poe-status-pill"
                          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded font-bold border ${
                            poeState.isPowered
                              ? 'bg-emerald-950/90 border-emerald-500/60 text-emerald-300'
                              : 'bg-red-950/90 border-red-500/70 text-red-300'
                          }`}
                        >
                          <Zap className="w-3 h-3" />
                          <span>
                            {poeState.isPowered
                              ? `PoE 802.3af · ${poeState.watts}W (${poeState.switchNodeName || 'DC 12V'})`
                              : 'ОБЕСТОЧЕНА (PoE OFF)'}
                          </span>
                        </span>
                      </div>

                      {/* Simulated Live CCTV Camera OSD Screen */}
                      <div
                        className={`p-3 rounded-lg border-2 font-mono space-y-2 transition-colors ${
                          poeState.isPowered
                            ? 'bg-[#041a1e] border-teal-500/50 text-teal-100 shadow-inner'
                            : 'bg-slate-950 border-red-500/40 text-red-300'
                        }`}
                      >
                        {poeState.isPowered ? (
                          <>
                            <div className="flex items-center justify-between border-b border-teal-500/30 pb-1.5 text-xs">
                              <span className="font-bold text-teal-300 flex items-center gap-1.5">
                                <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                                <span>REC · {camCfg.cameraName}</span>
                              </span>
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-teal-500/20 text-teal-200">
                                VLAN {camCfg.surveillanceVlan}
                              </span>
                            </div>

                            <div className="grid grid-cols-2 gap-2 text-[11px] py-1">
                              <div>
                                <div className="text-slate-400 text-[10px]">RTSP URI потока:</div>
                                <div className="text-sky-300 truncate">{camCfg.streamUrl}</div>
                              </div>
                              <div>
                                <div className="text-slate-400 text-[10px]">Параметры кодирования:</div>
                                <div className="text-emerald-300">
                                  {camCfg.codec} · {(camCfg.resolution || '4K').split(' ')[0]} · {camCfg.fps}fps
                                </div>
                              </div>
                            </div>

                            <div className="text-[10px] text-teal-200/90 flex flex-wrap items-center justify-between gap-1 pt-1.5 border-t border-teal-500/20">
                              <span>
                                Режим:{' '}
                                <strong>
                                  {camCfg.streamMode === 'multicast'
                                    ? `Multicast ${camCfg.multicastGroupIp}:${camCfg.rtpVideoPort}`
                                    : `Unicast NVR ${camCfg.nvrTargetIp}:${camCfg.rtspPort}`}
                                </strong>
                              </span>
                              <span>
                                Битрейт: <strong>{((camCfg.bitrateKbps || 6144) / 1024).toFixed(1)} Мбит/с</strong>
                              </span>
                            </div>
                          </>
                        ) : (
                          <div className="py-5 text-center space-y-1">
                            <div className="text-xs font-bold text-red-300">
                              ⚡ НЕТ ПИТАНИЯ PoE (IEEE 802.3af Class 3 · 9.5W)
                            </div>
                            <div className="text-[11px] text-slate-400">{poeState.reason}</div>
                          </div>
                        )}
                      </div>

                      {/* 1-Click Action Buttons: RTSP Stream & ACL Isolation Check */}
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        <button
                          type="button"
                          data-testid="ip-camera-start-rtsp-btn"
                          onClick={() => handleTriggerRtspStream()}
                          className="py-2 px-3 rounded-lg bg-teal-600 hover:bg-teal-500 text-xs font-semibold text-white flex items-center justify-center gap-1.5 cursor-pointer transition-colors shadow-sm"
                        >
                          <Video className="w-3.5 h-3.5 shrink-0" />
                          <span>Передать поток RTSP на NVR</span>
                        </button>

                        <button
                          type="button"
                          data-testid="ip-camera-test-wan-acl-btn"
                          onClick={handleTestInternetIsolation}
                          className="py-2 px-3 rounded-lg bg-rose-950/90 hover:bg-rose-900 border border-rose-500/50 text-xs font-semibold text-rose-200 flex items-center justify-center gap-1.5 cursor-pointer transition-colors"
                        >
                          <ShieldAlert className="w-3.5 h-3.5 text-rose-400 shrink-0" />
                          <span>Проверить изоляцию от WAN (ACL)</span>
                        </button>
                      </div>
                    </div>

                    {/* Right 5 cols: Stream Mode, NVR IP, Multicast Group, Codec & PoE Settings */}
                    <div className="sm:col-span-5 p-3 rounded-xl bg-slate-900/95 border border-slate-800 space-y-2.5 text-xs">
                      <div className="font-semibold text-slate-200 border-b border-slate-800 pb-1.5 flex items-center justify-between">
                        <span>Настройки потока и PoE</span>
                        <span className="text-[10px] font-mono text-teal-400">TCP 554 / UDP 5004</span>
                      </div>

                      <div>
                        <label className="block text-[10px] text-slate-400 mb-1">
                          Режим вещания видеопотока
                        </label>
                        <div className="grid grid-cols-2 gap-1.5">
                          <button
                            type="button"
                            onClick={() => patchCamConfig({ streamMode: 'unicast' })}
                            className={`py-1.5 px-2 rounded border text-[11px] font-mono font-semibold cursor-pointer ${
                              camCfg.streamMode === 'unicast'
                                ? 'bg-teal-600/25 border-teal-400 text-teal-200'
                                : 'bg-slate-950 border-slate-800 text-slate-400'
                            }`}
                          >
                            Unicast → NVR
                          </button>
                          <button
                            type="button"
                            onClick={() => patchCamConfig({ streamMode: 'multicast' })}
                            className={`py-1.5 px-2 rounded border text-[11px] font-mono font-semibold cursor-pointer ${
                              camCfg.streamMode === 'multicast'
                                ? 'bg-amber-600/25 border-amber-400 text-amber-200'
                                : 'bg-slate-950 border-slate-800 text-slate-400'
                            }`}
                          >
                            Multicast 239.x
                          </button>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="block text-[10px] text-slate-400 mb-0.5 truncate">
                            IP регистратора NVR
                          </label>
                          <input
                            type="text"
                            value={camCfg.nvrTargetIp}
                            onChange={(e) => patchCamConfig({ nvrTargetIp: e.target.value })}
                            className="w-full px-2 py-1 rounded bg-slate-950 border border-slate-700 font-mono text-sky-300"
                          />
                        </div>
                        <div>
                          <label className="block text-[10px] text-slate-400 mb-0.5 truncate">
                            Multicast группа
                          </label>
                          <input
                            type="text"
                            value={camCfg.multicastGroupIp}
                            onChange={(e) => patchCamConfig({ multicastGroupIp: e.target.value })}
                            className="w-full px-2 py-1 rounded bg-slate-950 border border-slate-700 font-mono text-amber-300"
                          />
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="block text-[10px] text-slate-400 mb-0.5">
                            Видеокодек
                          </label>
                          <select
                            value={camCfg.codec}
                            onChange={(e) =>
                              patchCamConfig({
                                codec: e.target.value as typeof camCfg.codec,
                              })
                            }
                            className="w-full px-2 py-1 rounded bg-slate-950 border border-slate-700 font-mono text-slate-200"
                          >
                            <option value="H.265 (HEVC)">H.265 (HEVC)</option>
                            <option value="H.264 (AVC)">H.264 (AVC)</option>
                            <option value="MJPEG">MJPEG</option>
                          </select>
                        </div>
                        <div>
                          <label className="block text-[10px] text-slate-400 mb-0.5">
                            Разрешение
                          </label>
                          <select
                            value={camCfg.resolution}
                            onChange={(e) =>
                              patchCamConfig({
                                resolution: e.target.value as typeof camCfg.resolution,
                              })
                            }
                            className="w-full px-2 py-1 rounded bg-slate-950 border border-slate-700 font-mono text-slate-200"
                          >
                            <option value="4K (3840×2160)">4K (3840×2160)</option>
                            <option value="1080p (1920×1080)">1080p (1920×1080)</option>
                            <option value="720p (1280×720)">720p (1280×720)</option>
                          </select>
                        </div>
                      </div>

                      <div className="pt-1 border-t border-slate-800 flex items-center justify-between">
                        <span className="text-[11px] text-slate-400">
                          Внешний БП 12V DC (резерв PoE):
                        </span>
                        <button
                          type="button"
                          onClick={() =>
                            patchCamConfig({
                              acAdapterConnected: !camCfg.acAdapterConnected,
                            })
                          }
                          className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold border cursor-pointer ${
                            camCfg.acAdapterConnected
                              ? 'bg-amber-600/30 border-amber-400 text-amber-200'
                              : 'bg-slate-950 border-slate-700 text-slate-400'
                          }`}
                        >
                          {camCfg.acAdapterConnected ? '12V DC ВКЛ' : 'Только PoE'}
                        </button>
                      </div>
                    </div>
                  </div>

                  {cameraFeedback && (
                    <div
                      data-testid="ip-camera-feedback-banner"
                      className={`p-2.5 rounded-lg border text-xs font-mono flex items-center justify-between ${
                        cameraFeedback.ok
                          ? 'bg-emerald-950/60 border-emerald-500/50 text-emerald-200'
                          : 'bg-red-950/60 border-red-500/50 text-red-200'
                      }`}
                    >
                      <span>{cameraFeedback.message}</span>
                    </div>
                  )}
                </div>
              );
            })()}

            {/* TAB 0: VOIP IP PHONE (CISCO 7960 LCD + SIP/RTP DIALER + VOICE/DATA VLAN PASSTHROUGH) */}
            {activeTab === 'voip' && isIpPhone && (() => {
              const voipCfg = node.voipConfig || {
                enabled: true,
                extension: '101',
                displayName: node.name,
                sipServerIp: '192.168.20.100',
                voiceVlan: 20,
                dataVlan: 10,
                codec: 'G.711u (64 kbps)' as const,
                dscpMark: 'EF (46)' as const,
                poeClassWatts: 7.0,
                acAdapterConnected: false,
                callStatus: 'idle' as const,
                callHistory: [],
              };
              const poeState = getPoweredDevicePoeState(node, allNodes, allLinks);
              const directory = getVoipDirectory(allNodes, allLinks).filter(
                (d) => d.nodeId !== node.id
              );
              const pcPort = node.interfaces[1];
              const pcLink = allLinks.find(
                (l) =>
                  (l.sourceNodeId === node.id && l.sourcePortId === pcPort?.id) ||
                  (l.targetNodeId === node.id && l.targetPortId === pcPort?.id)
              );
              const connectedPcNode = pcLink
                ? allNodes.find(
                    (n) =>
                      n.id ===
                      (pcLink.sourceNodeId === node.id
                        ? pcLink.targetNodeId
                        : pcLink.sourceNodeId)
                  )
                : null;

              const handleTriggerSipCall = (targetExtOrIp: string) => {
                const target = targetExtOrIp.trim() || dialedNumber.trim();
                if (!target) return;
                const res = runVoipSipCallSimulation(allNodes, allLinks, node.id, target);
                onUpdateAllNodes(res.updatedNodes);
                onLoadSimulationSteps(res.steps, res.summaryMessage);
                setVoipCallFeedback({
                  ok: res.success,
                  message: res.summaryMessage,
                });
              };

              return (
                <div className="p-3.5 space-y-3" data-testid={`voip-phone-panel-${node.id}`}>
                  {/* Top Row: Cisco IP Phone 7960 LCD Screen + 12-Key Keypad */}
                  <div className="grid grid-cols-1 sm:grid-cols-12 gap-3">
                    {/* Left 7 cols: Cisco IP Phone LCD Screen & 2-Port Switch Passthrough Status */}
                    <div className="sm:col-span-7 p-3 rounded-xl bg-slate-900/95 border border-fuchsia-500/40 flex flex-col justify-between space-y-2.5">
                      {/* LCD Bezel Header */}
                      <div className="flex items-center justify-between text-[10px] font-mono text-slate-400">
                        <span className="font-bold text-fuchsia-300">
                          CISCO IP PHONE 7960G · SIP / RTP QoS
                        </span>
                        <span
                          data-testid="voip-poe-status-pill"
                          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded font-bold border ${
                            poeState.isPowered
                              ? 'bg-emerald-950/90 border-emerald-500/60 text-emerald-300'
                              : 'bg-red-950/90 border-red-500/70 text-red-300'
                          }`}
                        >
                          <Zap className="w-3 h-3" />
                          <span>
                            {poeState.isPowered
                              ? `PoE 802.3af · ${poeState.watts}W (${poeState.switchNodeName || 'AC'})`
                              : 'ОБЕСТОЧЕН (PoE OFF)'}
                          </span>
                        </span>
                      </div>

                      {/* Green/Cyan Backlit LCD Screen */}
                      <div
                        className={`p-3 rounded-lg border-2 font-mono space-y-1.5 transition-colors ${
                          poeState.isPowered
                            ? 'bg-[#071f1a] border-emerald-500/50 text-emerald-200 shadow-inner'
                            : 'bg-slate-950 border-red-500/40 text-red-300'
                        }`}
                      >
                        {poeState.isPowered ? (
                          <>
                            <div className="flex items-center justify-between border-b border-emerald-500/30 pb-1">
                              <span className="text-sm font-bold text-emerald-300">
                                ☎ Ext {voipCfg.extension} · {voipCfg.displayName}
                              </span>
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-200">
                                SIP: {voipCfg.sipServerIp}
                              </span>
                            </div>
                            <div className="text-xs flex items-center justify-between pt-0.5">
                              <span className="text-slate-300">Набор номера (SIP URI):</span>
                              <span
                                data-testid="voip-lcd-dialed"
                                className="text-base font-bold text-fuchsia-300 tracking-wider"
                              >
                                {dialedNumber || '___'}
                              </span>
                            </div>
                            <div className="text-[10px] text-emerald-300/90 flex flex-wrap items-center justify-between gap-1 pt-1 border-t border-emerald-500/20">
                              <span>
                                SW Port: <strong>Voice VLAN {voipCfg.voiceVlan}</strong> (DSCP EF)
                              </span>
                              <span>
                                PC Port: <strong>Data VLAN {voipCfg.dataVlan}</strong>{' '}
                                {connectedPcNode ? `(${connectedPcNode.name})` : '(свободен)'}
                              </span>
                            </div>
                          </>
                        ) : (
                          <div className="py-4 text-center space-y-1">
                            <div className="text-xs font-bold text-red-300">
                              ⚡ НЕТ ПИТАНИЯ PoE (IEEE 802.3af)
                            </div>
                            <div className="text-[11px] text-slate-400">
                              {poeState.reason}
                            </div>
                          </div>
                        )}
                      </div>

                      {/* Quick Directory Buttons (Other IP Phones in Topology) */}
                      <div className="space-y-1">
                        <div className="text-[10px] font-mono text-slate-400 flex items-center justify-between">
                          <span>Быстрый набор абонентов SIP в сети:</span>
                          <span className="text-fuchsia-300">Кодек {voipCfg.codec}</span>
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5">
                          {directory.length === 0 ? (
                            <span className="text-[11px] text-slate-500">
                              Добавьте второй IP-телефон на холст для тестирования звонков.
                            </span>
                          ) : (
                            directory.map((peer) => (
                              <button
                                key={peer.nodeId}
                                type="button"
                                data-testid={`voip-quick-dial-${peer.extension}`}
                                onClick={() => {
                                  setDialedNumber(peer.extension);
                                  handleTriggerSipCall(peer.extension);
                                }}
                                className="px-2.5 py-1 rounded-lg bg-fuchsia-950/80 hover:bg-fuchsia-600 border border-fuchsia-500/50 text-xs font-mono text-fuchsia-200 hover:text-white flex items-center gap-1.5 transition-colors cursor-pointer"
                              >
                                <PhoneCall className="w-3 h-3" />
                                <span>
                                  Позвонить {peer.extension} ({peer.nodeName})
                                </span>
                              </button>
                            ))
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Right 5 cols: Interactive 12-Key Telephone Keypad & Call Button */}
                    <div className="sm:col-span-5 p-3 rounded-xl bg-slate-900/95 border border-slate-800 flex flex-col justify-between space-y-2">
                      <div className="flex items-center gap-1.5">
                        <input
                          type="text"
                          aria-label="Номер абонента SIP или IP-адрес"
                          data-testid="voip-dial-input"
                          value={dialedNumber}
                          onChange={(e) => setDialedNumber(e.target.value)}
                          placeholder="102 или IP..."
                          className="flex-1 px-2.5 py-1 rounded-lg bg-slate-950 border border-slate-700 text-sm font-mono font-bold text-fuchsia-300 focus:outline-none focus:border-fuchsia-500"
                        />
                        <button
                          type="button"
                          onClick={() => setDialedNumber('')}
                          className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-xs font-mono text-slate-300 cursor-pointer"
                          title="Очистить номер"
                        >
                          ⌫
                        </button>
                      </div>

                      <div className="grid grid-cols-3 gap-1.5">
                        {['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'].map(
                          (digit) => (
                            <button
                              key={digit}
                              type="button"
                              onClick={() => setDialedNumber((prev) => `${prev}${digit}`)}
                              className="py-1.5 rounded-lg bg-slate-950 hover:bg-slate-800 border border-slate-700/80 text-xs font-mono font-bold text-slate-100 transition-colors cursor-pointer"
                            >
                              {digit}
                            </button>
                          )
                        )}
                      </div>

                      <button
                        type="button"
                        data-testid="voip-call-btn"
                        onClick={() => handleTriggerSipCall(dialedNumber)}
                        className="w-full py-2 rounded-lg bg-fuchsia-600 hover:bg-fuchsia-500 text-xs font-mono font-bold text-white shadow-md flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
                      >
                        <PhoneCall className="w-3.5 h-3.5" />
                        <span>Вызов SIP INVITE + RTP ({dialedNumber || '102'})</span>
                      </button>
                    </div>
                  </div>

                  {voipCallFeedback && (
                    <div
                      data-testid="voip-call-feedback"
                      className={`px-3 py-2 rounded-xl border text-xs font-mono flex items-center justify-between ${
                        voipCallFeedback.ok
                          ? 'bg-emerald-950/70 border-emerald-500/50 text-emerald-200'
                          : 'bg-red-950/70 border-red-500/50 text-red-200'
                      }`}
                    >
                      <span>{voipCallFeedback.message}</span>
                      <button
                        type="button"
                        onClick={() => setVoipCallFeedback(null)}
                        className="text-slate-400 hover:text-white ml-2 cursor-pointer"
                      >
                        ✕
                      </button>
                    </div>
                  )}

                  {/* Bottom Config Card: Extension, Voice VLAN, Data VLAN (PC Port), SIP Registrar & External PSU */}
                  <div className="p-3 rounded-xl bg-slate-900/90 border border-slate-800 space-y-2.5">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-slate-200">
                        Настройки IP-телефона: Voice VLAN (802.1Q + QoS) и проходной порт PC (Data VLAN)
                      </span>
                      <label className="inline-flex items-center gap-1.5 text-[11px] font-mono text-amber-300 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={voipCfg.acAdapterConnected === true}
                          onChange={(e) =>
                            onUpdateNode({
                              ...node,
                              voipConfig: {
                                ...voipCfg,
                                acAdapterConnected: e.target.checked,
                              },
                            })
                          }
                          className="rounded border-slate-700 bg-slate-950 text-fuchsia-500"
                        />
                        <span>Внешний БП 48В (работа без PoE)</span>
                      </label>
                    </div>

                    <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-xs font-mono">
                      <div>
                        <label className="block text-[10px] text-slate-400 mb-0.5">
                          Номер (Extension)
                        </label>
                        <input
                          type="text"
                          data-testid="voip-ext-input"
                          value={voipCfg.extension}
                          onChange={(e) =>
                            onUpdateNode({
                              ...node,
                              voipConfig: { ...voipCfg, extension: e.target.value },
                            })
                          }
                          className="w-full px-2 py-1 rounded bg-slate-950 border border-slate-700 text-fuchsia-300 font-bold"
                        />
                      </div>

                      <div>
                        <label className="block text-[10px] text-slate-400 mb-0.5">
                          Voice VLAN (Тег)
                        </label>
                        <input
                          type="number"
                          min={1}
                          max={4094}
                          data-testid="voip-voice-vlan-input"
                          value={voipCfg.voiceVlan}
                          onChange={(e) => {
                            const v = Math.max(1, Math.min(4094, Number(e.target.value) || 20));
                            onUpdateNode({
                              ...node,
                              interfaces: node.interfaces.map((iface, idx) =>
                                idx === 0
                                  ? { ...iface, accessVlan: v, voiceVlan: v }
                                  : iface
                              ),
                              voipConfig: { ...voipCfg, voiceVlan: v },
                            });
                          }}
                          className="w-full px-2 py-1 rounded bg-slate-950 border border-slate-700 text-fuchsia-300"
                        />
                      </div>

                      <div>
                        <label className="block text-[10px] text-slate-400 mb-0.5">
                          PC Port (Data VLAN)
                        </label>
                        <input
                          type="number"
                          min={1}
                          max={4094}
                          data-testid="voip-data-vlan-input"
                          value={voipCfg.dataVlan}
                          onChange={(e) => {
                            const v = Math.max(1, Math.min(4094, Number(e.target.value) || 10));
                            onUpdateNode({
                              ...node,
                              interfaces: node.interfaces.map((iface, idx) =>
                                idx === 1 ? { ...iface, accessVlan: v } : iface
                              ),
                              voipConfig: { ...voipCfg, dataVlan: v },
                            });
                          }}
                          className="w-full px-2 py-1 rounded bg-slate-950 border border-slate-700 text-sky-300"
                        />
                      </div>

                      <div>
                        <label className="block text-[10px] text-slate-400 mb-0.5">
                          SIP-сервер (PBX IP)
                        </label>
                        <input
                          type="text"
                          value={voipCfg.sipServerIp}
                          onChange={(e) =>
                            onUpdateNode({
                              ...node,
                              voipConfig: { ...voipCfg, sipServerIp: e.target.value },
                            })
                          }
                          className="w-full px-2 py-1 rounded bg-slate-950 border border-slate-700 text-slate-100"
                        />
                      </div>

                      <div>
                        <label className="block text-[10px] text-slate-400 mb-0.5">
                          Аудио-кодек RTP
                        </label>
                        <select
                          value={voipCfg.codec}
                          onChange={(e) =>
                            onUpdateNode({
                              ...node,
                              voipConfig: {
                                ...voipCfg,
                                codec: e.target.value as
                                  | 'G.711u (64 kbps)'
                                  | 'G.729a (8 kbps)'
                                  | 'Opus Wideband',
                              },
                            })
                          }
                          className="w-full px-2 py-1 rounded bg-slate-950 border border-slate-700 text-emerald-300"
                        >
                          <option value="G.711u (64 kbps)">G.711u (64 kbps)</option>
                          <option value="G.729a (8 kbps)">G.729a (8 kbps)</option>
                          <option value="Opus Wideband">Opus Wideband</option>
                        </select>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })()}

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

            {/* TAB 4: WI-FI 802.11 SCANNER, WPA2-PSK AUTHENTICATION & ESS ROAMING */}
            {activeTab === 'wifi' && (() => {
              const scannedNetworks = scanAvailableWifiNetworks(node, allNodes, allLinks);
              const connectedEntry = scannedNetworks.find((n) => n.isConnected);
              const clientCfg = node.wifiClientConfig || {
                enabled: true,
                connectedSsid: connectedEntry?.ssid || '',
                passphrase: '',
                security: connectedEntry?.security || 'wpa2',
                autoRoaming: true,
              };

              return (
                <div className="p-3.5 space-y-3" data-testid={`wifi-scanner-panel-${node.id}`}>
                  {/* Top Wireless Adapter & Association Status Card */}
                  <div className="p-3 rounded-xl bg-slate-900/95 border border-cyan-500/35 space-y-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <div className="w-8 h-8 rounded-lg bg-cyan-500/15 border border-cyan-500/40 flex items-center justify-center">
                          <Radio className="w-4 h-4 text-cyan-300" />
                        </div>
                        <div>
                          <div className="text-xs font-bold text-slate-100 flex items-center gap-2">
                            <span>Беспроводной адаптер IEEE 802.11ac/ax ({primaryIface?.shortName || 'Wlan0'})</span>
                            <span
                              className={`px-1.5 py-0.5 rounded text-[10px] font-mono ${
                                connectedEntry
                                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                                  : 'bg-slate-800 text-slate-400 border border-slate-700'
                              }`}
                            >
                              {connectedEntry
                                ? `ASSOCIATED · ${connectedEntry.ssid}`
                                : 'НЕ ПОДКЛЮЧЕН'}
                            </span>
                          </div>
                          <div className="text-[11px] text-slate-400">
                            Перемещайте устройство на холсте — уровень сигнала (RSSI) и роуминг между точками доступа пересчитываются в реальном времени.
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        <label className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-950 border border-slate-800 text-[11px] text-slate-300 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={clientCfg.autoRoaming !== false}
                            onChange={(e) =>
                              onUpdateNode({
                                ...node,
                                wifiClientConfig: {
                                  ...clientCfg,
                                  autoRoaming: e.target.checked,
                                },
                              })
                            }
                            className="rounded border-slate-700 text-cyan-500 focus:ring-0"
                          />
                          <span>802.11 ESS Авто-роуминг</span>
                        </label>
                      </div>
                    </div>

                    {/* Connected AP Telemetry Bar */}
                    {connectedEntry ? (
                      <div className="p-2.5 rounded-lg bg-cyan-950/35 border border-cyan-500/30 flex flex-wrap items-center justify-between gap-2 text-xs font-mono">
                        <div className="space-y-0.5">
                          <div className="text-cyan-200 font-semibold flex items-center gap-2">
                            <span>SSID: {connectedEntry.ssid}</span>
                            <span className="text-slate-400">→</span>
                            <span className="text-emerald-300">
                              Точка доступа: {connectedEntry.apName}
                            </span>
                            <span className="px-1.5 py-0.5 rounded bg-slate-900 border border-slate-700 text-[10px] text-cyan-300">
                              {connectedEntry.band} · Канал {connectedEntry.channel}
                            </span>
                          </div>
                          <div className="text-[11px] text-slate-300">
                            Сигнал: <strong className="text-emerald-300">{connectedEntry.rssiDbm} dBm</strong> ({connectedEntry.signalQualityPercent}% · {connectedEntry.signalBars}/4 делений) · Дистанция:{' '}
                            <strong>{connectedEntry.distancePx} px</strong> (радиус {connectedEntry.coverageRadius} px) · IP:{' '}
                            <strong className="text-sky-300">
                              {primaryIface?.ipAddress || '0.0.0.0 (запросите DHCP)'}
                            </strong>
                          </div>
                        </div>

                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            data-testid="wifi-request-dhcp-btn"
                            onClick={() => {
                              updateInterface({ dhcpEnabled: true });
                              onTriggerDhcpSimulation(node.id);
                            }}
                            className="px-2.5 py-1 rounded bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 text-amber-200 text-[11px] font-semibold cursor-pointer"
                          >
                            DHCP (Получить IP)
                          </button>

                          <button
                            type="button"
                            data-testid="wifi-disconnect-btn"
                            onClick={() => {
                              const res = disconnectWirelessClient(allNodes, allLinks, node.id);
                              onUpdateAllNodes(res.nodes);
                              onUpdateLinks?.(res.links, res.summaryMessage);
                              setWifiStatusMsg({ ok: true, text: res.summaryMessage });
                            }}
                            className="px-2.5 py-1 rounded bg-red-950/70 hover:bg-red-900/80 border border-red-500/40 text-red-200 text-[11px] font-semibold cursor-pointer"
                          >
                            Отключиться
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="p-2.5 rounded-lg bg-slate-950 border border-slate-800 text-xs text-slate-400 flex items-center justify-between">
                        <span>
                          Беспроводной клиент не ассоциирован ни с одной точкой доступа. Выберите сеть Wi-Fi из эфира ниже.
                        </span>
                      </div>
                    )}

                    {wifiStatusMsg && (
                      <div
                        data-testid="wifi-auth-status"
                        className={`px-3 py-2 rounded-lg text-xs font-mono flex items-center justify-between ${
                          wifiStatusMsg.ok
                            ? 'bg-emerald-950/70 border border-emerald-500/40 text-emerald-200'
                            : 'bg-red-950/70 border border-red-500/40 text-red-200'
                        }`}
                      >
                        <span>{wifiStatusMsg.text}</span>
                        <button
                          type="button"
                          onClick={() => setWifiStatusMsg(null)}
                          className="text-slate-400 hover:text-white ml-2 cursor-pointer"
                        >
                          ✕
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Available 802.11 Networks Scanner Table */}
                  <div className="rounded-xl bg-slate-900/90 border border-slate-800 overflow-hidden">
                    <div className="px-3.5 py-2 bg-slate-950 border-b border-slate-800 flex items-center justify-between">
                      <span className="text-xs font-semibold text-slate-200">
                        Сканер радиоэфира IEEE 802.11 ({scannedNetworks.length} точек доступа)
                      </span>
                      <span className="text-[10px] font-mono text-cyan-300">
                        802.11 Beacon Scan · 2.4GHz / 5GHz
                      </span>
                    </div>

                    {scannedNetworks.length === 0 ? (
                      <div className="p-6 text-center text-xs text-slate-400">
                        В топологии пока нет точек доступа Wi-Fi. Добавьте на холст{' '}
                        <strong className="text-cyan-300">Wi-Fi Access Point</strong> или{' '}
                        <strong className="text-cyan-300">Wi-Fi Router (SOHO)</strong> из левой панели.
                      </div>
                    ) : (
                      <div className="divide-y divide-slate-800/80" data-testid="wifi-scanner-table">
                        {scannedNetworks.map((net) => {
                          const apNode = allNodes.find((n) => n.id === net.apNodeId);
                          const defaultPass =
                            wifiPasswords[net.apNodeId] !== undefined
                              ? wifiPasswords[net.apNodeId]
                              : clientCfg.connectedSsid === net.ssid && clientCfg.passphrase
                              ? clientCfg.passphrase
                              : apNode?.wifiConfig?.password || '';

                          return (
                            <div
                              key={net.apNodeId}
                              data-testid={`wifi-network-row-${net.apNodeId}`}
                              className={`p-3 flex flex-wrap items-center justify-between gap-2.5 transition-colors ${
                                net.isConnected
                                  ? 'bg-cyan-950/30'
                                  : 'hover:bg-slate-950/60'
                              }`}
                            >
                              <div className="space-y-1 min-w-[230px]">
                                <div className="flex items-center gap-2">
                                  <Wifi
                                    className={`w-4 h-4 shrink-0 ${
                                      net.inRange ? 'text-cyan-400' : 'text-slate-600'
                                    }`}
                                  />
                                  <span className="text-xs font-bold font-mono text-slate-100">
                                    {net.ssid}
                                  </span>
                                  <span className="px-1.5 py-0.5 rounded bg-slate-950 border border-slate-800 text-[10px] font-mono text-sky-300">
                                    AP: {net.apName}
                                  </span>
                                  <span
                                    className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono ${
                                      net.security === 'wpa2'
                                        ? 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
                                        : 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                                    }`}
                                  >
                                    {net.security === 'wpa2' ? (
                                      <>
                                        <Lock className="w-2.5 h-2.5" />
                                        <span>WPA2-PSK</span>
                                      </>
                                    ) : (
                                      <>
                                        <Unlock className="w-2.5 h-2.5" />
                                        <span>Open</span>
                                      </>
                                    )}
                                  </span>
                                </div>

                                <div className="text-[11px] font-mono text-slate-400 flex flex-wrap items-center gap-2">
                                  <span>
                                    {net.band} · Ch {net.channel}
                                  </span>
                                  <span>·</span>
                                  <span
                                    className={
                                      net.inRange
                                        ? 'text-emerald-300 font-semibold'
                                        : 'text-red-400 font-semibold'
                                    }
                                  >
                                    {net.inRange
                                      ? `${net.rssiDbm} dBm (${net.signalQualityPercent}%) · В зоне (${net.distancePx}/${net.coverageRadius} px)`
                                      : `Вне зоны покрытия (${net.distancePx}/${net.coverageRadius} px)`}
                                  </span>
                                </div>
                              </div>

                              <div className="flex items-center gap-2">
                                {net.security === 'wpa2' && (
                                  <input
                                    type="text"
                                    data-testid={`wifi-password-input-${net.apNodeId}`}
                                    aria-label={`Пароль WPA2 для ${net.ssid} (${net.apName})`}
                                    value={defaultPass}
                                    onChange={(e) =>
                                      setWifiPasswords((prev) => ({
                                        ...prev,
                                        [net.apNodeId]: e.target.value,
                                      }))
                                    }
                                    placeholder="Пароль WPA2-PSK..."
                                    className="w-36 px-2.5 py-1 rounded-lg bg-slate-950 border border-slate-700 text-xs font-mono text-slate-100 focus:outline-none focus:border-cyan-500"
                                  />
                                )}

                                {net.isConnected ? (
                                  <span className="px-2.5 py-1 rounded-lg bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 text-xs font-mono font-semibold">
                                    Подключено
                                  </span>
                                ) : (
                                  <button
                                    type="button"
                                    data-testid={`wifi-connect-btn-${net.apNodeId}`}
                                    onClick={() => {
                                      const res = connectWirelessClientToAp(
                                        allNodes,
                                        allLinks,
                                        node.id,
                                        net.apNodeId,
                                        defaultPass
                                      );
                                      setWifiStatusMsg({
                                        ok: res.ok,
                                        text: res.error || res.summaryMessage,
                                      });
                                      if (res.ok) {
                                        onUpdateAllNodes(res.nodes);
                                        onUpdateLinks?.(res.links, res.summaryMessage);
                                      }
                                    }}
                                    className={`px-3 py-1 rounded-lg text-xs font-semibold transition-colors cursor-pointer ${
                                      net.inRange
                                        ? 'bg-cyan-600 hover:bg-cyan-500 text-white'
                                        : 'bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700'
                                    }`}
                                  >
                                    Подключить
                                  </button>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              );
            })()}
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
