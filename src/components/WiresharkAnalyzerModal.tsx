import React, { useMemo, useState } from 'react';
import { NetworkNode, SimulationStep } from '../network/types';
import {
  WiresharkDissectedPacket,
  WiresharkHeaderField,
  WiresharkHeaderSection,
  buildFollowStreamDialog,
  dissectStepForWireshark,
  evaluateWiresharkDisplayFilter,
  validateWiresharkDisplayFilter,
} from '../network/wiresharkEngine';
import {
  Activity,
  AlertTriangle,
  ArrowLeftRight,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Cpu,
  Filter,
  GitCompare,
  Layers,
  MessageSquareCode,
  Play,
  Radio,
  Search,
  Sparkles,
  Terminal,
  X,
} from 'lucide-react';

interface WiresharkAnalyzerModalProps {
  isOpen: boolean;
  steps: SimulationStep[];
  nodes: NetworkNode[];
  currentStepIndex: number;
  onSelectStepIndex: (index: number) => void;
  onRunDemoCapture: () => void;
  onClose: () => void;
}

const QUICK_FILTER_CHIPS: { label: string; expr: string; title: string }[] = [
  { label: 'icmp', expr: 'icmp', title: 'Только ICMP пакеты (Ping / Time Exceeded / Unreachable)' },
  { label: 'arp', expr: 'arp', title: 'Только ARP Request / Reply' },
  { label: 'http', expr: 'http', title: 'HTTP L7 и TCP сегменты порта 80' },
  { label: 'dns', expr: 'dns', title: 'DNS запросы и ответы (UDP 53)' },
  { label: 'dhcp', expr: 'dhcp', title: 'Процесс DHCP DORA (UDP 67/68)' },
  { label: 'ospf', expr: 'ospf', title: 'Пакеты маршрутизации OSPF' },
  { label: 'bgp', expr: 'bgp', title: 'Сессии eBGP (TCP 179)' },
  { label: 'sip', expr: 'sip', title: 'Сигнализация VoIP SIP и голосовой поток RTP' },
  { label: 'stp', expr: 'stp', title: 'Кадры Spanning Tree BPDU' },
  { label: 'frame.dropped', expr: 'frame.dropped', title: 'Отброшенные пакеты (Dropped ACL / TTL / STP / LOS)' },
];

const LAYER_BADGE_STYLE: Record<'L1' | 'L2' | 'L3' | 'L4' | 'L7', string> = {
  L1: 'bg-slate-800 text-slate-300 border-slate-600',
  L2: 'bg-amber-500/20 text-amber-200 border-amber-500/40',
  L3: 'bg-sky-500/20 text-sky-200 border-sky-500/40',
  L4: 'bg-purple-500/20 text-purple-200 border-purple-500/40',
  L7: 'bg-emerald-500/20 text-emerald-200 border-emerald-500/40',
};

export const WiresharkAnalyzerModal: React.FC<WiresharkAnalyzerModalProps> = ({
  isOpen,
  steps,
  nodes,
  currentStepIndex,
  onSelectStepIndex,
  onRunDemoCapture,
  onClose,
}) => {
  const [displayFilter, setDisplayFilter] = useState<string>('');
  const [captureInterface, setCaptureInterface] = useState<string>('ALL');
  const [frameViewMode, setFrameViewMode] = useState<'outbound' | 'inbound' | 'diff'>('outbound');
  const [expandedSectionIds, setExpandedSectionIds] = useState<Record<string, boolean>>({
    'sec-frame': true,
    'sec-l2': true,
    'sec-l3': true,
    'sec-l4': true,
    'sec-l7': true,
  });
  const [selectedHighlight, setSelectedHighlight] = useState<{
    byteOffset: number;
    byteLength: number;
    fieldId?: string;
    sectionId?: string;
    label: string;
    value: string;
    layer: 'L1' | 'L2' | 'L3' | 'L4' | 'L7';
  } | null>(null);
  const [isFollowStreamOpen, setIsFollowStreamOpen] = useState<boolean>(false);

  // Build available SPAN capture interfaces (All + Nodes + Specific Node:Port pairs from steps)
  const captureInterfaces = useMemo(() => {
    const portSet = new Set<string>();
    for (const s of steps) {
      if (s.fromNodeName && s.fromPortName) {
        portSet.add(`${s.fromNodeName}:${s.fromPortName}`);
      }
      if (s.toNodeName && s.toPortName) {
        portSet.add(`${s.toNodeName}:${s.toPortName}`);
      }
    }
    return {
      nodes: nodes.map((n) => ({ id: `NODE:${n.id}`, label: `Узел: ${n.name} (${n.model})` })),
      ports: Array.from(portSet).sort(),
    };
  }, [steps, nodes]);

  // Validate display filter expression
  const filterValidation = useMemo(
    () => validateWiresharkDisplayFilter(displayFilter),
    [displayFilter]
  );

  // Dissect all steps for packet list & apply SPAN interface filter + Display Filter
  const filteredDissectedPackets = useMemo(() => {
    return steps
      .map((step, arrayIdx) => ({
        step,
        arrayIdx,
        dissected: dissectStepForWireshark(
          step,
          frameViewMode === 'inbound' ? 'inbound' : 'outbound'
        ),
      }))
      .filter(({ step }) => {
        // Capture Interface (SPAN) filter
        if (captureInterface !== 'ALL') {
          if (captureInterface.startsWith('NODE:')) {
            const nodeId = captureInterface.slice(5);
            if (step.fromNodeId !== nodeId && step.toNodeId !== nodeId) {
              return false;
            }
          } else if (captureInterface.startsWith('PORT:')) {
            const portSpec = captureInterface.slice(5);
            const fromSpec = `${step.fromNodeName}:${step.fromPortName}`;
            const toSpec = `${step.toNodeName}:${step.toPortName}`;
            if (fromSpec !== portSpec && toSpec !== portSpec) {
              return false;
            }
          }
        }
        // Display Filter Bar
        if (displayFilter.trim() && filterValidation.valid) {
          return evaluateWiresharkDisplayFilter(step, displayFilter);
        }
        return true;
      });
  }, [steps, frameViewMode, captureInterface, displayFilter, filterValidation.valid]);

  // Determine currently selected step (fallback to first filtered step if current is filtered out)
  const activeEntry = useMemo(() => {
    const exact = filteredDissectedPackets.find((item) => item.arrayIdx === currentStepIndex);
    if (exact) return exact;
    return filteredDissectedPackets[0] || null;
  }, [filteredDissectedPackets, currentStepIndex]);

  const activePacket: WiresharkDissectedPacket | null = activeEntry?.dissected || null;
  const activeStep: SimulationStep | null = activeEntry?.step || null;

  // Also dissect inbound specifically when comparing Inbound vs Outbound
  const inboundPacket: WiresharkDissectedPacket | null = useMemo(() => {
    if (!activeStep) return null;
    return dissectStepForWireshark(activeStep, 'inbound');
  }, [activeStep]);

  const outboundPacket: WiresharkDissectedPacket | null = useMemo(() => {
    if (!activeStep) return null;
    return dissectStepForWireshark(activeStep, 'outbound');
  }, [activeStep]);

  // Follow Stream dialog reconstruction for the currently selected packet
  const followStreamDialog = useMemo(() => {
    if (!activeStep || steps.length === 0) return null;
    return buildFollowStreamDialog(steps, activeStep);
  }, [steps, activeStep]);

  if (!isOpen) return null;

  const changedOffsetsSet = new Set<number>(activePacket?.changedByteOffsets || []);

  const isByteSelected = (byteIndex: number): boolean => {
    if (!selectedHighlight || selectedHighlight.byteLength <= 0) return false;
    return (
      byteIndex >= selectedHighlight.byteOffset &&
      byteIndex < selectedHighlight.byteOffset + selectedHighlight.byteLength
    );
  };

  // Bi-directional lookup: when clicking a byte in the Hex or ASCII pane, select its field in the tree
  const handleSelectByteIndex = (byteIndex: number) => {
    if (!activePacket) return;

    for (const sec of activePacket.sections) {
      for (const field of sec.fields) {
        if (
          field.byteLength > 0 &&
          byteIndex >= field.byteOffset &&
          byteIndex < field.byteOffset + field.byteLength
        ) {
          setExpandedSectionIds((prev) => ({ ...prev, [sec.id]: true }));
          setSelectedHighlight({
            byteOffset: field.byteOffset,
            byteLength: field.byteLength,
            fieldId: field.id,
            sectionId: sec.id,
            label: field.label,
            value: field.value,
            layer: field.layer,
          });
          return;
        }
      }
    }

    // Fallback to section if no sub-field matched
    for (const sec of activePacket.sections) {
      if (
        sec.byteLength > 0 &&
        byteIndex >= sec.byteOffset &&
        byteIndex < sec.byteOffset + sec.byteLength
      ) {
        setExpandedSectionIds((prev) => ({ ...prev, [sec.id]: true }));
        setSelectedHighlight({
          byteOffset: sec.byteOffset,
          byteLength: sec.byteLength,
          sectionId: sec.id,
          label: sec.title,
          value: sec.summary,
          layer: sec.layer,
        });
        return;
      }
    }
  };

  const handleToggleSection = (sec: WiresharkHeaderSection) => {
    setExpandedSectionIds((prev) => ({
      ...prev,
      [sec.id]: !prev[sec.id],
    }));
    if (sec.byteLength > 0) {
      setSelectedHighlight({
        byteOffset: sec.byteOffset,
        byteLength: sec.byteLength,
        sectionId: sec.id,
        label: sec.title,
        value: sec.summary,
        layer: sec.layer,
      });
    }
  };

  const handleSelectField = (sec: WiresharkHeaderSection, field: WiresharkHeaderField) => {
    setSelectedHighlight({
      byteOffset: field.byteOffset,
      byteLength: field.byteLength,
      fieldId: field.id,
      sectionId: sec.id,
      label: field.label,
      value: field.value,
      layer: field.layer,
    });
  };

  return (
    <div
      data-testid="wireshark-analyzer-modal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/85 backdrop-blur-xs p-2 sm:p-4 select-none"
      role="dialog"
      aria-modal="true"
      aria-labelledby="wireshark-modal-title"
    >
      <div className="w-full max-w-[1440px] h-[92vh] bg-slate-900 border border-slate-700 rounded-lg shadow-2xl overflow-hidden flex flex-col">
        {/* Top Window Header */}
        <div className="px-4 py-2.5 bg-slate-950 border-b border-slate-800 flex items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-7 h-7 rounded-md bg-sky-500/20 border border-sky-400/50 flex items-center justify-center shrink-0">
              <Activity className="w-4 h-4 text-sky-400" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2
                  id="wireshark-modal-title"
                  className="text-sm font-bold text-slate-100 truncate"
                >
                  Wireshark Deep Packet Analyzer (DPI & Hex Dump)
                </h2>
                <span className="px-2 py-0.5 rounded bg-sky-500/15 border border-sky-500/40 text-[10px] font-mono font-semibold text-sky-300 shrink-0">
                  L1–L7 Promiscuous / SPAN
                </span>
              </div>
              <p className="text-[11px] text-slate-400 font-mono truncate">
                Перехвачено пакетов: {steps.length} · Отображено по фильтру:{' '}
                {filteredDissectedPackets.length}
                {activeStep
                  ? ` · Выбран кадр #${activeStep.stepIndex} (${activeStep.fromNodeName}:${activeStep.fromPortName} → ${activeStep.toNodeName}:${activeStep.toPortName})`
                  : ''}
              </p>
            </div>
          </div>

          {/* Right Toolbar: SPAN Capture Interface + Follow Stream + Close */}
          <div className="flex items-center gap-2 shrink-0 flex-wrap">
            {/* Capture Interface Selector (Port Mirroring / SPAN) */}
            <div className="flex items-center gap-1.5 bg-slate-900 border border-slate-700 rounded-md px-2 py-1">
              <Radio className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
              <span className="text-[11px] font-mono text-slate-400 whitespace-nowrap">
                Точка захвата (SPAN):
              </span>
              <select
                data-testid="wireshark-capture-interface-select"
                aria-label="Точка перехвата трафика SPAN"
                value={captureInterface}
                onChange={(e) => setCaptureInterface(e.target.value)}
                className="bg-slate-950 text-xs font-mono text-slate-100 border border-slate-700 rounded px-2 py-0.5 focus:outline-none focus:border-sky-500 cursor-pointer"
              >
                <option value="ALL">Весь трафик топологии (Promiscuous)</option>
                <optgroup label="Фильтр по сетевому узлу">
                  {captureInterfaces.nodes.map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.label}
                    </option>
                  ))}
                </optgroup>
                {captureInterfaces.ports.length > 0 && (
                  <optgroup label="Зеркалирование порта (SPAN Port Mirroring)">
                    {captureInterfaces.ports.map((portSpec) => (
                      <option key={portSpec} value={`PORT:${portSpec}`}>
                        SPAN Порт: {portSpec}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
            </div>

            {/* Follow Stream Button */}
            <button
              type="button"
              data-testid="wireshark-follow-stream-btn"
              disabled={!activeStep}
              onClick={() => setIsFollowStreamOpen((v) => !v)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold border transition-colors cursor-pointer shrink-0 ${
                isFollowStreamOpen
                  ? 'bg-indigo-600 text-white border-indigo-400 shadow-xs'
                  : 'bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-200 border-indigo-500/40 disabled:opacity-40'
              }`}
              title="Реконструкция полного потока диалога Client ↔ Server (Follow TCP / HTTP / SIP / DHCP Stream)"
            >
              <MessageSquareCode className="w-3.5 h-3.5" />
              <span>Follow Stream (Поток диалога)</span>
            </button>

            <button
              type="button"
              data-testid="wireshark-close-btn"
              onClick={onClose}
              aria-label="Закрыть анализатор Wireshark"
              className="p-1.5 rounded-md text-slate-400 hover:text-white hover:bg-slate-800 transition-colors cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Display Filter Bar (with live green/red syntax validation + quick chips) */}
        <div className="px-4 py-2 bg-slate-900 border-b border-slate-800 space-y-1.5 shrink-0">
          <div className="flex items-center gap-2">
            <div
              className={`flex-1 flex items-center gap-2 px-2.5 py-1.5 rounded-md border transition-colors ${
                !displayFilter.trim()
                  ? 'bg-slate-950 border-slate-700'
                  : filterValidation.valid
                  ? 'bg-emerald-950/40 border-emerald-500/70 shadow-[0_0_10px_rgba(16,185,129,0.15)]'
                  : 'bg-rose-950/50 border-rose-500/80'
              }`}
            >
              <Filter
                className={`w-3.5 h-3.5 shrink-0 ${
                  !displayFilter.trim()
                    ? 'text-slate-400'
                    : filterValidation.valid
                    ? 'text-emerald-400'
                    : 'text-rose-400'
                }`}
              />
              <input
                type="text"
                data-testid="wireshark-filter-input"
                aria-label="Строка фильтрации выражений Wireshark Display Filter"
                value={displayFilter}
                onChange={(e) => setDisplayFilter(e.target.value)}
                placeholder='Фильтр Wireshark: icmp, arp, http, ip.addr == 192.168.10.10, tcp.port == 80, vlan.id == 10, frame.dropped, node == "RTR-1"'
                className="w-full bg-transparent text-xs font-mono text-slate-100 placeholder:text-slate-500 focus:outline-none"
              />
              {displayFilter && (
                <button
                  type="button"
                  data-testid="wireshark-filter-clear-btn"
                  onClick={() => setDisplayFilter('')}
                  className="p-0.5 rounded text-slate-400 hover:text-white cursor-pointer"
                  title="Очистить фильтр"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {/* Syntax validity badge */}
            <div
              data-testid="wireshark-filter-status"
              className={`px-2.5 py-1.5 rounded-md border text-[11px] font-mono font-semibold flex items-center gap-1.5 shrink-0 ${
                !displayFilter.trim()
                  ? 'bg-slate-950 border-slate-800 text-slate-400'
                  : filterValidation.valid
                  ? 'bg-emerald-950/60 border-emerald-500/50 text-emerald-300'
                  : 'bg-rose-950/70 border-rose-500/60 text-rose-300'
              }`}
            >
              {!displayFilter.trim() ? (
                <span>Без фильтра ({filteredDissectedPackets.length})</span>
              ) : filterValidation.valid ? (
                <>
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Синтаксис OK ({filteredDissectedPackets.length})</span>
                </>
              ) : (
                <>
                  <AlertTriangle className="w-3.5 h-3.5 text-rose-400" />
                  <span>{filterValidation.errorMessage || 'Ошибка выражения'}</span>
                </>
              )}
            </div>
          </div>

          {/* Quick Expression Chips */}
          <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5">
            <span className="text-[10px] font-mono text-slate-400 whitespace-nowrap mr-1">
              Быстрые выражения:
            </span>
            {QUICK_FILTER_CHIPS.map((chip) => {
              const isActive = displayFilter.trim().toLowerCase() === chip.expr.toLowerCase();
              return (
                <button
                  key={chip.expr}
                  type="button"
                  data-testid={`wireshark-chip-${chip.label}`}
                  onClick={() =>
                    setDisplayFilter((prev) =>
                      prev.trim().toLowerCase() === chip.expr.toLowerCase() ? '' : chip.expr
                    )
                  }
                  title={chip.title}
                  className={`px-2 py-0.5 rounded text-[11px] font-mono border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    isActive
                      ? 'bg-sky-500/25 border-sky-400 text-sky-200 font-semibold'
                      : 'bg-slate-950 hover:bg-slate-800 border-slate-800 text-slate-300'
                  }`}
                >
                  {chip.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Empty State if no packets captured yet */}
        {steps.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center p-8 text-center space-y-4">
            <div className="w-14 h-14 rounded-full bg-sky-500/10 border border-sky-500/30 flex items-center justify-center">
              <Activity className="w-7 h-7 text-sky-400" />
            </div>
            <div className="max-w-md space-y-1.5">
              <h3 className="text-base font-bold text-slate-100">
                Буфер перехвата Wireshark пока пуст
              </h3>
              <p className="text-xs text-slate-400 leading-relaxed">
                Запустите любую симуляцию в топологии (Ping, HTTP, DHCP, VoIP SIP, OSPF, BGP) или нажмите кнопку ниже, чтобы сгенерировать пакеты и выполнить глубокую побайтовую инспекцию L1–L7.
              </p>
            </div>
            <button
              type="button"
              data-testid="wireshark-capture-demo-btn"
              onClick={onRunDemoCapture}
              className="flex items-center gap-2 px-4 py-2 rounded-md bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold shadow-md transition-colors cursor-pointer"
            >
              <Play className="w-4 h-4" />
              <span>Захватить пакеты (Запустить тестовый трафик)</span>
            </button>
          </div>
        ) : (
          /* Main 3-Pane Wireshark Workspace */
          <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
            {/* PANE 1 (TOP): Packet List Table */}
            <div
              data-testid="wireshark-packet-list"
              className="h-[36%] min-h-[160px] border-b border-slate-800 flex flex-col bg-slate-950/90 overflow-hidden"
            >
              <div className="overflow-y-auto flex-1">
                <table className="w-full text-left border-collapse font-mono text-[11px]">
                  <thead className="sticky top-0 z-10 bg-slate-900 text-slate-300 border-b border-slate-700 select-none">
                    <tr>
                      <th className="py-1.5 px-2.5 w-14">No.</th>
                      <th className="py-1.5 px-2.5 w-20">Time (s)</th>
                      <th className="py-1.5 px-2.5 w-44">Source</th>
                      <th className="py-1.5 px-2.5 w-44">Destination</th>
                      <th className="py-1.5 px-2.5 w-24">Protocol</th>
                      <th className="py-1.5 px-2.5 w-20">Length</th>
                      <th className="py-1.5 px-2.5">VLAN / Info (Deep Packet Summary)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/50">
                    {filteredDissectedPackets.map(({ step, arrayIdx, dissected }) => {
                      const isSelected = activeEntry?.arrayIdx === arrayIdx;
                      return (
                        <tr
                          key={step.id}
                          data-testid={`wireshark-pkt-row-${step.stepIndex}`}
                          onClick={() => {
                            onSelectStepIndex(arrayIdx);
                            setSelectedHighlight(null);
                          }}
                          className={`cursor-pointer transition-colors ${
                            isSelected
                              ? 'bg-sky-600/35 text-white font-semibold ring-1 ring-inset ring-sky-400'
                              : dissected.colorClass
                          }`}
                        >
                          <td className="py-1 px-2.5 tabular-nums">{dissected.stepIndex}</td>
                          <td className="py-1 px-2.5 tabular-nums">{dissected.timeSeconds}</td>
                          <td className="py-1 px-2.5 truncate max-w-[180px]" title={dissected.source}>
                            {dissected.source}
                          </td>
                          <td
                            className="py-1 px-2.5 truncate max-w-[180px]"
                            title={dissected.destination}
                          >
                            {dissected.destination}
                          </td>
                          <td className="py-1 px-2.5 font-bold">{dissected.protocolLabel}</td>
                          <td className="py-1 px-2.5 tabular-nums">{dissected.lengthBytes} B</td>
                          <td className="py-1 px-2.5 truncate max-w-[520px]">
                            <div className="flex items-center gap-1.5 truncate">
                              {dissected.vlanTag !== null && (
                                <span className="px-1.5 py-0.2 rounded bg-amber-500/20 border border-amber-400/40 text-amber-200 text-[10px] shrink-0">
                                  802.1Q VLAN {dissected.vlanTag}
                                </span>
                              )}
                              {dissected.isDropped && (
                                <span className="px-1.5 py-0.2 rounded bg-rose-600 text-white text-[10px] font-bold shrink-0">
                                  DROPPED
                                </span>
                              )}
                              <span className="truncate">{dissected.infoSummary}</span>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                    {filteredDissectedPackets.length === 0 && (
                      <tr>
                        <td colSpan={7} className="py-8 text-center text-slate-400">
                          Нет пакетов, удовлетворяющих выражению фильтра «{displayFilter}»
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Middle Control Bar: Inbound / Outbound / Diff Mode Toggle + Selected Step Summary */}
            {activePacket && activeStep && (
              <div className="px-4 py-1.5 bg-slate-900 border-b border-slate-800 flex items-center justify-between gap-3 shrink-0 flex-wrap">
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-mono text-slate-400">Режим кадра на узле:</span>
                  <div className="flex items-center p-0.5 rounded-md bg-slate-950 border border-slate-800">
                    <button
                      type="button"
                      data-testid="wireshark-direction-outbound"
                      onClick={() => setFrameViewMode('outbound')}
                      className={`px-2.5 py-1 rounded text-[11px] font-mono font-semibold transition-colors cursor-pointer ${
                        frameViewMode === 'outbound'
                          ? 'bg-sky-600 text-white'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      Outbound (Исходящий)
                    </button>
                    <button
                      type="button"
                      data-testid="wireshark-direction-inbound"
                      onClick={() => setFrameViewMode('inbound')}
                      className={`px-2.5 py-1 rounded text-[11px] font-mono font-semibold transition-colors cursor-pointer ${
                        frameViewMode === 'inbound'
                          ? 'bg-sky-600 text-white'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      Inbound (Входящий)
                    </button>
                    <button
                      type="button"
                      data-testid="wireshark-direction-diff"
                      onClick={() => setFrameViewMode('diff')}
                      className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] font-mono font-semibold transition-colors cursor-pointer ${
                        frameViewMode === 'diff'
                          ? 'bg-amber-500 text-slate-950'
                          : 'text-amber-300 hover:bg-amber-500/15'
                      }`}
                      title="Сравнить входящий и исходящий кадр: подсветить изменённые байты (TTL, NAT PAT, MAC, 802.1Q VLAN)"
                    >
                      <GitCompare className="w-3.5 h-3.5" />
                      <span>
                        Diff Inbound↔Outbound ({activePacket.diffSummaryItems.length} изм. /{' '}
                        {activePacket.changedByteOffsets.length} байт)
                      </span>
                    </button>
                  </div>
                </div>

                {/* Diff quick summary pills when changes exist */}
                {activePacket.diffSummaryItems.length > 0 && (
                  <div className="flex items-center gap-1.5 overflow-x-auto text-[11px] font-mono">
                    <span className="text-amber-300 font-semibold shrink-0">Модификации узла:</span>
                    {activePacket.diffSummaryItems.map((diff, i) => (
                      <span
                        key={i}
                        className="px-2 py-0.5 rounded bg-amber-500/15 border border-amber-500/40 text-amber-200 whitespace-nowrap"
                      >
                        [{diff.layer}] {diff.fieldLabel}: {diff.before} → {diff.after}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* BOTTOM SPLIT: PANE 2 (Packet Details Tree) + PANE 3 (Packet Bytes Hex & ASCII Dump) */}
            {activePacket && activeStep ? (
              <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 min-h-0 overflow-hidden">
                {/* PANE 2 (Bottom-Left): Packet Details Tree */}
                <div
                  data-testid="wireshark-details-tree"
                  className="lg:col-span-6 border-r border-slate-800 bg-slate-950/60 flex flex-col min-h-0 overflow-hidden"
                >
                  <div className="px-3 py-1.5 bg-slate-900/90 border-b border-slate-800 flex items-center justify-between text-[11px] font-mono text-slate-300 shrink-0">
                    <span className="font-semibold flex items-center gap-1.5">
                      <Layers className="w-3.5 h-3.5 text-sky-400" />
                      <span>Packet Details Tree (Заголовки L1–L7)</span>
                    </span>
                    <span className="text-slate-400">
                      Клик по полю подсвечивает байты в Hex
                    </span>
                  </div>

                  <div className="flex-1 overflow-y-auto p-2 space-y-1.5 font-mono text-xs">
                    {activePacket.sections.map((sec) => {
                      const isExpanded = expandedSectionIds[sec.id] ?? true;
                      const isSecSelected =
                        selectedHighlight?.sectionId === sec.id && !selectedHighlight?.fieldId;

                      return (
                        <div
                          key={sec.id}
                          data-testid={`wireshark-tree-section-${sec.id}`}
                          className="rounded border border-slate-800/90 bg-slate-900/60 overflow-hidden"
                        >
                          {/* Section Header Row */}
                          <button
                            type="button"
                            onClick={() => handleToggleSection(sec)}
                            className={`w-full px-2.5 py-1.5 flex items-center justify-between gap-2 text-left transition-colors cursor-pointer ${
                              isSecSelected
                                ? 'bg-sky-500/25 text-white border-b border-sky-500/40'
                                : 'hover:bg-slate-800/80 text-slate-100'
                            }`}
                          >
                            <div className="flex items-center gap-1.5 min-w-0">
                              {isExpanded ? (
                                <ChevronDown className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                              ) : (
                                <ChevronRight className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                              )}
                              <span
                                className={`px-1.5 py-0.2 rounded text-[10px] font-bold border shrink-0 ${
                                  LAYER_BADGE_STYLE[sec.layer]
                                }`}
                              >
                                {sec.layer}
                              </span>
                              <span className="font-semibold truncate">{sec.title}</span>
                            </div>
                            {sec.byteLength > 0 && (
                              <span className="text-[10px] text-slate-400 shrink-0 tabular-nums">
                                [0x{sec.byteOffset.toString(16).padStart(4, '0')} · {sec.byteLength}{' '}
                                B]
                              </span>
                            )}
                          </button>

                          {/* Section Fields */}
                          {isExpanded && (
                            <div className="divide-y divide-slate-800/50 bg-slate-950/80">
                              {sec.fields.map((field) => {
                                const isFieldSelected = selectedHighlight?.fieldId === field.id;
                                const hasChanged = Boolean(field.changedFromInbound);

                                return (
                                  <button
                                    key={field.id}
                                    type="button"
                                    data-testid={`wireshark-field-${field.id}`}
                                    onClick={() => handleSelectField(sec, field)}
                                    className={`w-full pl-7 pr-2.5 py-1 flex items-center justify-between gap-2 text-left text-[11px] transition-colors cursor-pointer ${
                                      isFieldSelected
                                        ? 'bg-sky-500/30 text-white font-semibold'
                                        : hasChanged && frameViewMode === 'diff'
                                        ? 'bg-amber-500/15 text-amber-200 hover:bg-amber-500/25'
                                        : 'text-slate-300 hover:bg-slate-900'
                                    }`}
                                  >
                                    <div className="min-w-0 flex-1 truncate">
                                      <span className="text-slate-400">{field.label}: </span>
                                      <span className="text-slate-100">{field.value}</span>
                                      {hasChanged && (
                                        <span className="ml-2 px-1.5 py-0.2 rounded bg-amber-500/20 border border-amber-400/50 text-[10px] text-amber-200">
                                          было: {field.changedFromInbound}
                                        </span>
                                      )}
                                    </div>
                                    {field.byteLength > 0 && (
                                      <span className="text-[10px] text-slate-500 shrink-0 tabular-nums">
                                        0x{field.byteOffset.toString(16).padStart(2, '0')} (
                                        {field.byteLength}B)
                                      </span>
                                    )}
                                  </button>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* PANE 3 (Bottom-Right): Packet Bytes — Hex & ASCII Dump */}
                <div
                  data-testid="wireshark-hex-dump"
                  className="lg:col-span-6 bg-slate-950 flex flex-col min-h-0 overflow-hidden"
                >
                  <div className="px-3 py-1.5 bg-slate-900/90 border-b border-slate-800 flex items-center justify-between text-[11px] font-mono text-slate-300 shrink-0">
                    <span className="font-semibold flex items-center gap-1.5">
                      <Terminal className="w-3.5 h-3.5 text-emerald-400" />
                      <span>
                        Packet Bytes — Hex & ASCII ({activePacket.lengthBytes} байт)
                      </span>
                    </span>
                    <div className="flex items-center gap-2 text-[10px]">
                      <span className="inline-flex items-center gap-1 text-sky-300">
                        <span className="w-2.5 h-2.5 rounded-xs bg-sky-500 inline-block" /> Выбранное
                        поле
                      </span>
                      <span className="inline-flex items-center gap-1 text-amber-300">
                        <span className="w-2.5 h-2.5 rounded-xs bg-amber-500/60 border border-amber-400 inline-block" />{' '}
                        Изменено (Diff)
                      </span>
                    </div>
                  </div>

                  {/* Hex & ASCII Table */}
                  <div className="flex-1 overflow-y-auto p-3 font-mono text-[11px] leading-relaxed">
                    {/* Column offset header */}
                    <div className="flex items-center gap-3 text-[10px] text-slate-500 pb-1 mb-1 border-b border-slate-800/80 select-none">
                      <span className="w-12 shrink-0">Offset</span>
                      <div className="grid grid-cols-16 gap-1 flex-1 max-w-[380px]">
                        {Array.from({ length: 16 }, (_, i) => (
                          <span key={i} className="text-center">
                            {i.toString(16).toUpperCase().padStart(2, '0')}
                          </span>
                        ))}
                      </div>
                      <span className="pl-2">ASCII Декодер</span>
                    </div>

                    <div className="space-y-0.5">
                      {activePacket.hexRows.map((row) => (
                        <div
                          key={row.offsetHex}
                          className="flex items-center gap-3 py-0.5 hover:bg-slate-900/60 rounded px-1"
                        >
                          {/* Offset Hex (0000, 0010, ...) */}
                          <span className="w-12 text-slate-500 shrink-0 tabular-nums select-none">
                            {row.offsetHex}
                          </span>

                          {/* 16 Hex Bytes */}
                          <div className="grid grid-cols-16 gap-1 flex-1 max-w-[380px]">
                            {Array.from({ length: 16 }, (_, colIdx) => {
                              const byteVal = row.bytes[colIdx];
                              const absByteIdx = row.startIndex + colIdx;
                              if (byteVal === undefined) {
                                return <span key={colIdx} className="inline-block w-5" />;
                              }
                              const selected = isByteSelected(absByteIdx);
                              const isDiffByte = changedOffsetsSet.has(absByteIdx);
                              const inboundVal = inboundPacket?.bytes[absByteIdx];
                              const outboundVal = outboundPacket?.bytes[absByteIdx];

                              return (
                                <button
                                  key={colIdx}
                                  type="button"
                                  data-testid={`wireshark-hex-byte-${absByteIdx}`}
                                  onClick={() => handleSelectByteIndex(absByteIdx)}
                                  title={
                                    isDiffByte && inboundVal !== undefined && outboundVal !== undefined
                                      ? `Байт 0x${absByteIdx.toString(16).padStart(4, '0')}: Inbound 0x${inboundVal
                                          .toString(16)
                                          .padStart(2, '0')} → Outbound 0x${outboundVal
                                          .toString(16)
                                          .padStart(2, '0')}`
                                      : `Смещение 0x${absByteIdx.toString(16).padStart(4, '0')} (${absByteIdx})`
                                  }
                                  className={`text-center rounded-xs px-0.5 transition-colors cursor-pointer tabular-nums ${
                                    selected
                                      ? 'bg-sky-400 text-slate-950 font-bold shadow-xs'
                                      : isDiffByte && frameViewMode === 'diff'
                                      ? 'bg-amber-500/35 text-amber-200 ring-1 ring-amber-400/70 font-semibold'
                                      : isDiffByte
                                      ? 'text-amber-300 hover:bg-slate-800'
                                      : 'text-slate-200 hover:bg-slate-800'
                                  }`}
                                >
                                  {byteVal.toString(16).padStart(2, '0')}
                                </button>
                              );
                            })}
                          </div>

                          {/* 16 ASCII Characters */}
                          <div className="flex items-center pl-2 border-l border-slate-800">
                            {row.asciiChars.map((ch, colIdx) => {
                              const absByteIdx = row.startIndex + colIdx;
                              const selected = isByteSelected(absByteIdx);
                              const isDiffByte = changedOffsetsSet.has(absByteIdx);
                              return (
                                <button
                                  key={colIdx}
                                  type="button"
                                  onClick={() => handleSelectByteIndex(absByteIdx)}
                                  className={`w-3.5 text-center rounded-xs transition-colors cursor-pointer ${
                                    selected
                                      ? 'bg-sky-400 text-slate-950 font-bold'
                                      : isDiffByte && frameViewMode === 'diff'
                                      ? 'bg-amber-500/35 text-amber-200'
                                      : ch === '.'
                                      ? 'text-slate-600 hover:text-slate-300'
                                      : 'text-emerald-300 hover:bg-slate-800'
                                  }`}
                                >
                                  {ch}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Bottom Byte Inspector Status Bar */}
                  <div
                    data-testid="wireshark-byte-status-bar"
                    className="px-3 py-1.5 bg-slate-900 border-t border-slate-800 flex items-center justify-between text-[11px] font-mono text-slate-300 shrink-0"
                  >
                    {selectedHighlight ? (
                      <div className="flex items-center gap-2 truncate">
                        <span
                          className={`px-1.5 py-0.2 rounded text-[10px] font-bold border ${
                            LAYER_BADGE_STYLE[selectedHighlight.layer]
                          }`}
                        >
                          {selectedHighlight.layer}
                        </span>
                        <span className="font-semibold text-sky-300 truncate">
                          {selectedHighlight.label}:
                        </span>
                        <span className="text-slate-100 truncate">{selectedHighlight.value}</span>
                      </div>
                    ) : (
                      <span className="text-slate-400">
                        Кликните на любое поле в дереве заголовков или на байт в Hex-дампе для двусторонней синхронизации
                      </span>
                    )}
                    {selectedHighlight && selectedHighlight.byteLength > 0 && (
                      <span className="text-sky-300 shrink-0 tabular-nums">
                        Байты: 0x{selectedHighlight.byteOffset.toString(16).padStart(4, '0')}..0x
                        {(selectedHighlight.byteOffset + selectedHighlight.byteLength - 1)
                          .toString(16)
                          .padStart(4, '0')}{' '}
                        ({selectedHighlight.byteLength} Б)
                      </span>
                    )}
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        )}

        {/* Follow Stream Modal / Overlay (Client Red ↔ Server Blue Conversation Transcript) */}
        {isFollowStreamOpen && followStreamDialog && (
          <div
            data-testid="wireshark-follow-stream-modal"
            className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-xs p-4"
          >
            <div className="w-full max-w-3xl max-h-[82vh] bg-slate-900 border border-indigo-500/50 rounded-lg shadow-2xl flex flex-col overflow-hidden">
              <div className="px-4 py-3 bg-slate-950 border-b border-slate-800 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2.5 min-w-0">
                  <MessageSquareCode className="w-5 h-5 text-indigo-400 shrink-0" />
                  <div className="min-w-0">
                    <h3 className="text-sm font-bold text-slate-100 truncate">
                      {followStreamDialog.streamTitle}
                    </h3>
                    <p className="text-[11px] font-mono text-slate-400">
                      Сообщений в потоке: {followStreamDialog.totalPackets} · Объём данных:{' '}
                      {followStreamDialog.totalBytes} байт
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  data-testid="wireshark-close-stream-btn"
                  onClick={() => setIsFollowStreamOpen(false)}
                  className="p-1.5 rounded text-slate-400 hover:text-white hover:bg-slate-800 cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Legend: Client (Red) vs Server (Blue) */}
              <div className="px-4 py-2 bg-slate-900 border-b border-slate-800 flex items-center justify-between text-xs font-mono">
                <div className="flex items-center gap-4">
                  <span className="inline-flex items-center gap-1.5 text-rose-300">
                    <span className="w-3 h-3 rounded-xs bg-rose-500/40 border border-rose-400 inline-block" />
                    Клиент / Инициатор ({followStreamDialog.clientEndpoint})
                  </span>
                  <span className="inline-flex items-center gap-1.5 text-sky-300">
                    <span className="w-3 h-3 rounded-xs bg-sky-500/40 border border-sky-400 inline-block" />
                    Сервер / Ответчик ({followStreamDialog.serverEndpoint})
                  </span>
                </div>
                <span className="text-slate-400">{followStreamDialog.streamProtocol}</span>
              </div>

              {/* Stream Messages Transcript */}
              <div className="p-4 overflow-y-auto space-y-3 flex-1 bg-slate-950 font-mono text-xs">
                {followStreamDialog.messages.map((msg, idx) => {
                  const isClient = msg.direction === 'client_to_server';
                  return (
                    <div
                      key={`${msg.stepIndex}-${idx}`}
                      data-testid={`follow-stream-msg-${idx}`}
                      className={`p-3 rounded-md border ${
                        isClient
                          ? 'bg-rose-950/35 border-rose-500/40 text-rose-200'
                          : 'bg-sky-950/35 border-sky-500/40 text-sky-200'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2 pb-1.5 mb-1.5 border-b border-slate-800/80 text-[11px]">
                        <span className="font-bold">
                          #{msg.stepIndex} [{msg.protocol}] {msg.senderLabel} → {msg.receiverLabel}
                        </span>
                        <span className="text-slate-400 tabular-nums">
                          {msg.timeSeconds}s · {msg.byteCount} B
                        </span>
                      </div>
                      <pre className="whitespace-pre-wrap break-words leading-relaxed text-[11px]">
                        {msg.rawText}
                      </pre>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
