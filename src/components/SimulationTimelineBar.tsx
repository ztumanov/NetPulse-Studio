import React from 'react';
import { NetworkNode, SimulationStep } from '../network/types';
import {
  ALL_PROTOCOL_CATEGORIES,
  SPEED_PRESETS,
   PacketFilterOptions,
  ProtocolFilterCategory,
  SimulationExecutionMode,
  computePduHeaderDiff,
  countStepsByProtocolCategory,
  filterSimulationSteps,
  getProtocolVisualMeta,
} from '../network/packetStreamEngine';
import { NetworkTroubleDiagnostic } from '../network/networkTroubleshooter';
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  RotateCcw,
  Trash2,
  Eye,
  CheckCircle2,
  AlertTriangle,
  Radio,
  ArrowRight,
  ChevronUp,
  ChevronDown,
  ListFilter,
  Activity,
  Clock,
  Search,
  Layers,
  Crosshair,
  Wrench,
  Sparkles,
  Terminal,
  X,
} from 'lucide-react';

interface SimulationTimelineBarProps {
  steps: SimulationStep[];
  nodes: NetworkNode[];
  currentStepIndex: number;
  isPlaying: boolean;
  executionMode: SimulationExecutionMode;
  liveTrafficActive: boolean;
  speedMultiplier: number;
  filterOptions: PacketFilterOptions;
  summaryMessage: string;
  isExpanded: boolean;
  troubleDiagnostics?: NetworkTroubleDiagnostic[];
  onApplyTroubleFix?: (diagnostic: NetworkTroubleDiagnostic) => void;
  onSelectNodeFromTrouble?: (nodeId: string) => void;
  onToggleExpand: () => void;
  onPlayPause: () => void;
  onStepForward: () => void;
  onStepBack: () => void;
  onReset: () => void;
  onClearBuffer: () => void;
  onSelectStep: (index: number, focusNodeOnCanvas?: boolean) => void;
  onInspectStep: (step: SimulationStep) => void;
  onChangeSpeed: (speed: number) => void;
  onChangeExecutionMode: (mode: SimulationExecutionMode) => void;
  onToggleLiveTraffic: () => void;
  onToggleProtocolCategory: (category: ProtocolFilterCategory) => void;
  onEnableAllProtocols: () => void;
  onToggleOnlyDropped: () => void;
  onChangeDeviceFilter: (nodeId: string) => void;
  onChangeSearchQuery: (query: string) => void;
  onOpenWireshark?: () => void;
}

const PROTOCOL_CHIP_META: Record<
  ProtocolFilterCategory,
  { label: string; activeClass: string; dotColor: string }
> = {
  ARP: {
    label: 'ARP',
    activeClass: 'bg-amber-500/20 text-amber-200 border-amber-500/50',
    dotColor: 'bg-amber-400',
  },
  ICMP: {
    label: 'ICMP',
    activeClass: 'bg-sky-500/20 text-sky-200 border-sky-500/50',
    dotColor: 'bg-sky-400',
  },
  DHCP: {
    label: 'DHCP',
    activeClass: 'bg-purple-500/20 text-purple-200 border-purple-500/50',
    dotColor: 'bg-purple-400',
  },
  DNS: {
    label: 'DNS',
    activeClass: 'bg-orange-500/20 text-orange-200 border-orange-500/50',
    dotColor: 'bg-orange-400',
  },
  HTTP: {
    label: 'HTTP/TCP',
    activeClass: 'bg-emerald-500/20 text-emerald-200 border-emerald-500/50',
    dotColor: 'bg-emerald-400',
  },
  STP: {
    label: 'STP',
    activeClass: 'bg-indigo-500/20 text-indigo-200 border-indigo-500/50',
    dotColor: 'bg-indigo-400',
  },
  OSPF: {
    label: 'OSPF',
    activeClass: 'bg-lime-500/20 text-lime-200 border-lime-500/50',
    dotColor: 'bg-lime-400',
  },
};

export const SimulationTimelineBar: React.FC<SimulationTimelineBarProps> = ({
  steps,
  nodes,
  currentStepIndex,
  isPlaying,
  executionMode,
  liveTrafficActive,
  speedMultiplier,
  filterOptions,
  summaryMessage,
  isExpanded,
  troubleDiagnostics = [],
  onApplyTroubleFix,
  onSelectNodeFromTrouble,
  onToggleExpand,
  onPlayPause,
  onStepForward,
  onStepBack,
  onReset,
  onClearBuffer,
  onSelectStep,
  onInspectStep,
  onChangeSpeed,
  onChangeExecutionMode,
  onToggleLiveTraffic,
  onToggleProtocolCategory,
  onEnableAllProtocols,
  onToggleOnlyDropped,
  onChangeDeviceFilter,
  onChangeSearchQuery,
  onOpenWireshark,
}) => {
  const currentStep = steps[currentStepIndex] || null;
  const { counts, droppedCount, total } = React.useMemo(
    () => countStepsByProtocolCategory(steps),
    [steps]
  );

  const hasSimulationFailure = React.useMemo(() => {
    if (droppedCount > 0) return true;
    const lower = summaryMessage.toLowerCase();
    return (
      lower.includes('ошибка') ||
      lower.includes('отказ') ||
      lower.includes('не задан') ||
      lower.includes('заблокирован') ||
      lower.includes('отброшен') ||
      lower.includes('недоступен') ||
      lower.includes('обесточен') ||
      lower.includes('выключен') ||
      lower.includes('drop') ||
      lower.includes('unreachable')
    );
  }, [droppedCount, summaryMessage]);

  const [isTroubleshooterOpen, setIsTroubleshooterOpen] = React.useState<boolean>(false);

  const showTroubleshooterBanner =
    troubleDiagnostics.length > 0 && isTroubleshooterOpen;

  const filteredEntries = React.useMemo(
    () => filterSimulationSteps(steps, filterOptions),
    [steps, filterOptions]
  );

  const allCategoriesEnabled = ALL_PROTOCOL_CATEGORIES.every(
    (cat) => filterOptions.enabledCategories[cat]
  );

  const currentStepDiff = React.useMemo(
    () => (currentStep ? computePduHeaderDiff(currentStep) : null),
    [currentStep]
  );

  return (
    <section
      aria-label="Панель управления пошаговой симуляцией и журнал пакетов"
      className={`${
        isExpanded
          ? 'h-96'
          : showTroubleshooterBanner
          ? 'h-auto max-h-72'
          : 'h-21'
      } border-t border-slate-800 bg-slate-900/98 flex flex-col shrink-0 select-none transition-all z-30`}
    >
      {/* Interactive Network Troubleshooter Card (1-Click Auto-Fix) — Opened ONLY on user button click */}
      {showTroubleshooterBanner && (
        <div
          data-testid="network-troubleshooter-panel"
          className="px-3 py-2 bg-gradient-to-r from-amber-950/90 via-slate-900 to-rose-950/85 border-b border-amber-500/40 shrink-0"
        >
          <div className="flex items-center justify-between gap-2 mb-1.5">
            <div className="flex items-center gap-2 min-w-0">
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-amber-500/20 border border-amber-400/50 text-[10px] font-mono font-bold text-amber-200 uppercase tracking-wide shrink-0">
                <Wrench className="w-3 h-3 text-amber-400" />
                <span>Анализатор проблем сети ({troubleDiagnostics.length})</span>
              </span>
              <span className="text-[11px] text-slate-300 truncate">
                Обнаружены причины потери пакетов или ошибки конфигурации L1–L4 — доступно автоматическое исправление в 1 клик:
              </span>
            </div>
            <button
              type="button"
              onClick={() => setIsTroubleshooterOpen(false)}
              className="p-1 rounded text-slate-400 hover:text-white hover:bg-slate-800/80 transition-colors cursor-pointer shrink-0"
              title="Скрыть подсказки анализатора"
              aria-label="Скрыть подсказки анализатора"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-2 max-h-36 overflow-y-auto pr-1">
            {troubleDiagnostics.slice(0, 4).map((diag, idx) => (
              <div
                key={diag.id}
                data-testid={`troubleshooter-card-${diag.id}`}
                className="p-2 rounded-md bg-slate-950/90 border border-slate-700/90 hover:border-amber-500/50 flex items-center justify-between gap-3 transition-colors"
              >
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span
                      className={`px-1.5 py-0.2 rounded text-[9px] font-mono font-bold uppercase ${
                        diag.severity === 'critical'
                          ? 'bg-rose-500/25 text-rose-200 border border-rose-500/40'
                          : 'bg-amber-500/25 text-amber-200 border border-amber-500/40'
                      }`}
                    >
                      {diag.category}
                    </span>
                    <button
                      type="button"
                      onClick={() => onSelectNodeFromTrouble?.(diag.nodeId)}
                      className="text-[11px] font-bold text-sky-300 hover:underline font-mono cursor-pointer truncate"
                    >
                      [{diag.nodeName}]
                    </button>
                    <span className="text-xs font-semibold text-slate-100 truncate">
                      {diag.title}
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-300 leading-snug line-clamp-2">
                    {diag.explanation}
                  </p>
                  {diag.cliHint && (
                    <div className="flex items-center gap-1 text-[10px] font-mono text-emerald-300/90 truncate pt-0.5">
                      <Terminal className="w-3 h-3 shrink-0 text-emerald-400" />
                      <span className="truncate">{diag.cliHint}</span>
                    </div>
                  )}
                </div>

                {onApplyTroubleFix && (
                  <button
                    type="button"
                    data-testid={idx === 0 ? 'troubleshooter-autofix-btn' : `troubleshooter-autofix-btn-${idx}`}
                    onClick={() => onApplyTroubleFix(diag)}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-semibold shadow-xs transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <Sparkles className="w-3.5 h-3.5 shrink-0" />
                    <span>{diag.fixButtonLabel}</span>
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Row 1: Realtime / Simulation Mode Switch, Playback Controls, Time Dilation Slider & Presets, Actions */}
      <div className="h-11 px-3 flex items-center justify-between gap-2 bg-slate-950/90 border-b border-slate-800/80 shrink-0">
        {/* Left: Cisco Packet Tracer Mode Switcher (Realtime vs Simulation) + Live Stream Generator + Step Controls */}
        <div className="flex items-center gap-1.5 shrink-0">
          {/* Realtime / Simulation Mode Segmented Switch */}
          <div
            role="group"
            aria-label="Режим работы симулятора"
            className="flex items-center p-0.5 rounded-md bg-slate-900 border border-slate-700/90"
          >
            <button
              type="button"
              data-testid="mode-switch-realtime"
              onClick={() => onChangeExecutionMode('realtime')}
              className={`flex items-center gap-1 px-2 py-1 text-[11px] font-semibold rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                executionMode === 'realtime'
                  ? 'bg-emerald-600 text-white shadow-xs'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
              title="Режим прямого эфира (Realtime): непрерывное движение потока пакетов по всем активным линкам"
            >
              <Clock className="w-3 h-3" />
              <span>Realtime</span>
            </button>
            <button
              type="button"
              data-testid="mode-switch-simulation"
              onClick={() => onChangeExecutionMode('simulation')}
              className={`flex items-center gap-1 px-2 py-1 text-[11px] font-semibold rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                executionMode === 'simulation'
                  ? 'bg-sky-600 text-white shadow-xs'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
              title="Пошаговый режим (Simulation): детальный захват каждого кадра и волны Broadcast"
            >
              <Layers className="w-3 h-3" />
              <span>Simulation</span>
            </button>
          </div>

          {/* Live Traffic Multi-Flow Generator Toggle */}
          <button
            type="button"
            data-testid="toggle-live-traffic-btn"
            onClick={onToggleLiveTraffic}
            className={`flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              liveTrafficActive
                ? 'bg-emerald-500/20 border-emerald-400 text-emerald-200 shadow-[0_0_12px_rgba(16,185,129,0.3)]'
                : 'bg-slate-800/90 hover:bg-slate-700 border-slate-700 text-slate-200'
            }`}
            title="Генератор живого трафика (Multi-Flow): непрерывно запускает STP BPDU, ARP, ICMP Ping, DNS и HTTP пакеты по сети"
          >
            <Activity className="w-3.5 h-3.5 text-emerald-400" />
            <span>Прямой эфир</span>
          </button>

          <div className="h-4 w-px bg-slate-800 mx-0.5" />

          {/* Step & Playback Controls */}
          <button
            type="button"
            onClick={onReset}
            disabled={steps.length === 0}
            aria-label="Сбросить симуляцию в начало"
            title="Перемотать в начало"
            className="p-1.5 rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-200 transition-colors shrink-0 cursor-pointer"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={onStepBack}
            disabled={steps.length === 0 || currentStepIndex <= 0}
            aria-label="Шаг назад"
            className="flex items-center gap-1 px-2 py-1 text-xs font-medium rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-200 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <SkipBack className="w-3.5 h-3.5" />
            <span className="hidden xl:inline">Назад</span>
          </button>
          <button
            type="button"
            data-testid="sim-play-pause-btn"
            onClick={onPlayPause}
            disabled={steps.length === 0 && !liveTrafficActive}
            aria-label={isPlaying ? 'Пауза симуляции' : 'Воспроизвести пакеты'}
            className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded bg-sky-600 hover:bg-sky-500 disabled:opacity-40 text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            {isPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
            <span>{isPlaying ? 'Пауза' : 'Старт'}</span>
          </button>
          <button
            type="button"
            onClick={onStepForward}
            disabled={steps.length === 0 || currentStepIndex >= steps.length - 1}
            aria-label="Шаг вперёд"
            className="flex items-center gap-1 px-2 py-1 text-xs font-medium rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-200 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <span className="hidden xl:inline">Вперёд</span>
            <SkipForward className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={onClearBuffer}
            disabled={steps.length === 0}
            aria-label="Очистить буфер пакетов"
            title="Очистить буфер перехваченных пакетов"
            className="p-1.5 rounded bg-slate-800 hover:bg-red-950/70 hover:text-red-300 disabled:opacity-40 text-slate-400 transition-colors shrink-0 cursor-pointer"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Center: Time Dilation Controls (0.1x Slow-Mo .. 4x Turbo + Smooth Slider) */}
        <div className="hidden md:flex items-center gap-2 px-2.5 py-1 rounded bg-slate-900/90 border border-slate-800 shrink-0">
          <span className="text-[11px] font-mono text-slate-400 whitespace-nowrap">
            Время:
          </span>
          <input
            type="range"
            aria-label="Ползунок скорости времени симуляции"
            min={0.1}
            max={4}
            step={0.05}
            value={speedMultiplier}
            onChange={(e) => onChangeSpeed(Number(parseFloat(e.target.value).toFixed(2)))}
            className="w-20 accent-sky-500 cursor-pointer h-1.5 bg-slate-800 rounded-lg"
          />
          <div className="flex items-center gap-0.5">
            {SPEED_PRESETS.map((spd) => (
              <button
                key={spd}
                type="button"
                data-testid={`speed-preset-${spd}`}
                onClick={() => onChangeSpeed(spd)}
                className={`px-1.5 py-0.5 text-[10px] font-mono rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer tabular-nums ${
                  Math.abs(speedMultiplier - spd) < 0.03
                    ? 'bg-sky-500/25 text-sky-200 border border-sky-400/50 font-semibold'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
                }`}
              >
                {spd}x
              </button>
            ))}
          </div>
        </div>

        {/* Right: Step Counter + Inspect Current PDU + Expand Event List */}
        <div className="flex items-center gap-2 shrink-0">
          {steps.length > 0 && (
            <span className="text-xs font-mono text-slate-300 tabular-nums whitespace-nowrap shrink-0">
              Пакет {currentStepIndex + 1}/{steps.length}
            </span>
          )}
          {troubleDiagnostics.length > 0 && (
            <button
              type="button"
              data-testid="toggle-troubleshooter-btn"
              onClick={() => setIsTroubleshooterOpen((open) => !open)}
              className={`flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold rounded border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                showTroubleshooterBanner
                  ? 'bg-amber-500 text-slate-950 border-amber-300 shadow-xs'
                  : 'bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 border-amber-500/50'
              }`}
              title="Открыть или скрыть интерактивный анализатор проблем сети"
            >
              <Wrench className="w-3.5 h-3.5 shrink-0" />
              <span>Диагностика ({troubleDiagnostics.length})</span>
            </button>
          )}
          {currentStep && (
            <button
              type="button"
              onClick={() => onInspectStep(currentStep)}
              className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-300 border border-emerald-500/40 rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Eye className="w-3.5 h-3.5 shrink-0" />
              <span>Инспектор PDU</span>
            </button>
          )}
          {onOpenWireshark && (
            <button
              type="button"
              data-testid="open-wireshark-btn"
              onClick={onOpenWireshark}
              className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold bg-indigo-600/25 hover:bg-indigo-600/40 text-indigo-200 border border-indigo-400/50 rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer shadow-xs"
              title="Открыть 3-панельный анализатор трафика Wireshark (Packet List, Details Tree, Hex/ASCII Dump, Follow Stream)"
            >
              <Activity className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
              <span>Wireshark DPI</span>
            </button>
          )}
          <button
            type="button"
            data-testid="toggle-event-list-btn"
            onClick={onToggleExpand}
            aria-label={isExpanded ? 'Свернуть журнал пакетов' : 'Развернуть журнал пакетов'}
            className={`flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              isExpanded
                ? 'bg-sky-600 border-sky-400 text-white'
                : steps.length > 0
                ? 'bg-sky-500/15 border-sky-500/40 text-sky-300 hover:bg-sky-500/25'
                : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
            }`}
          >
            <ListFilter className="w-3.5 h-3.5" />
            <span>
              События ({filteredEntries.length}/{total})
            </span>
            {isExpanded ? (
              <ChevronDown className="w-3.5 h-3.5" />
            ) : (
              <ChevronUp className="w-3.5 h-3.5" />
            )}
          </button>
        </div>
      </div>

      {/* Row 2: Protocol Filter Chips Bar + Live Summary Ticker */}
      <div className="h-10 px-3 flex items-center justify-between gap-3 bg-slate-900/95 shrink-0">
        {/* Protocol Filter Toggle Chips */}
        <div
          role="group"
          aria-label="Фильтр протоколов пакетов"
          className="flex items-center gap-1 overflow-x-auto py-0.5 shrink-0"
        >
          <span className="text-[11px] font-mono text-slate-400 mr-1 whitespace-nowrap">
            Фильтр PDU:
          </span>
          <button
            type="button"
            data-testid="filter-chip-ALL"
            onClick={onEnableAllProtocols}
            className={`px-2 py-0.5 text-[11px] font-mono rounded border transition-colors whitespace-nowrap shrink-0 cursor-pointer tabular-nums ${
              allCategoriesEnabled && !filterOptions.onlyDropped
                ? 'bg-slate-100 text-slate-950 border-white font-semibold'
                : 'bg-slate-950 text-slate-400 border-slate-800 hover:text-slate-200'
            }`}
          >
            Все ({total})
          </button>

          {ALL_PROTOCOL_CATEGORIES.map((cat) => {
            const meta = PROTOCOL_CHIP_META[cat];
            const isEnabled = filterOptions.enabledCategories[cat];
            const count = counts[cat] || 0;
            return (
              <button
                key={cat}
                type="button"
                data-testid={`filter-chip-${cat}`}
                onClick={() => onToggleProtocolCategory(cat)}
                className={`flex items-center gap-1.5 px-2 py-0.5 text-[11px] font-mono rounded border transition-colors whitespace-nowrap shrink-0 cursor-pointer tabular-nums ${
                  isEnabled
                    ? meta.activeClass
                    : 'bg-slate-950/60 text-slate-500 border-slate-800/80 line-through hover:text-slate-300'
                }`}
                title={`Включить или скрыть пакеты протокола ${meta.label} на холсте и в журнале`}
              >
                <span className={`w-2 h-2 rounded-[2px] ${meta.dotColor}`} />
                <span>{meta.label}</span>
                <span className="opacity-80">({count})</span>
              </button>
            );
          })}

          <button
            type="button"
            data-testid="filter-chip-DROPPED"
            onClick={onToggleOnlyDropped}
            className={`flex items-center gap-1 px-2 py-0.5 text-[11px] font-mono rounded border transition-colors whitespace-nowrap shrink-0 cursor-pointer tabular-nums ${
              filterOptions.onlyDropped
                ? 'bg-red-500/25 text-red-200 border-red-400 font-semibold'
                : 'bg-slate-950 text-slate-400 border-slate-800 hover:text-red-300'
            }`}
            title="Показать только отброшенные пакеты (ACL Drop / STP Loop Guard / Unreachable)"
          >
            <AlertTriangle className="w-3 h-3 text-red-400" />
            <span>Только Drop ({droppedCount})</span>
          </button>
        </div>

        {/* Right: Current Simulation Status Summary */}
        <div className="flex-1 min-w-0 text-xs text-slate-300 truncate font-mono text-right">
          {summaryMessage}
        </div>
      </div>

      {/* Row 3 (Expanded): Split Simulation Event List & Inbound/Outbound PDU Diff Sniffer */}
      {isExpanded && (
        <div className="flex-1 min-h-0 border-t border-slate-800 flex flex-col lg:flex-row overflow-hidden bg-slate-950">
          {/* Left Pane (62%): Simulation Event List Table with Search & Device Filter */}
          <div className="flex-1 flex flex-col min-w-0 min-h-0 border-r border-slate-800">
            {/* Search & Device Filter Subbar */}
            <div className="px-3 py-1.5 bg-slate-900/90 border-b border-slate-800 flex items-center justify-between gap-2 shrink-0">
              <div className="relative flex-1 max-w-xs">
                <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="text"
                  value={filterOptions.searchQuery}
                  onChange={(e) => onChangeSearchQuery(e.target.value)}
                  placeholder="Поиск по IP, MAC, узлу, VLAN..."
                  aria-label="Поиск событий по IP, MAC или имени узла"
                  className="w-full pl-8 pr-2.5 py-1 rounded bg-slate-950 border border-slate-800 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-sky-500 font-mono"
                />
              </div>

              <div className="flex items-center gap-2">
                <label
                  htmlFor="event-device-filter"
                  className="text-[11px] font-mono text-slate-400 whitespace-nowrap"
                >
                  Узел (At Device):
                </label>
                <select
                  id="event-device-filter"
                  value={filterOptions.deviceFilterId}
                  onChange={(e) => onChangeDeviceFilter(e.target.value)}
                  className="px-2 py-1 rounded bg-slate-950 border border-slate-800 text-xs font-mono text-slate-200 focus:outline-none focus:border-sky-500"
                >
                  <option value="ALL">Все устройства ({nodes.length})</option>
                  {nodes.map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.name} ({n.type.toUpperCase()})
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Event List Table */}
            <div className="flex-1 overflow-y-auto">
              {filteredEntries.length === 0 ? (
                <div className="h-full flex items-center justify-center text-xs text-slate-400 px-6 text-center">
                  {steps.length === 0
                    ? 'Журнал событий пуст. Нажмите «Прямой эфир» или «Запустить Ping», чтобы увидеть поток пакетов.'
                    : 'Нет пакетов, соответствующих выбранным фильтрам протоколов или поисковому запросу.'}
                </div>
              ) : (
                <table className="w-full text-left text-[11px] font-mono border-collapse">
                  <thead className="bg-slate-950 text-slate-400 sticky top-0 z-10 border-b border-slate-800 text-[10px]">
                    <tr>
                      <th className="py-1.5 px-2 w-18 whitespace-nowrap"># / Время</th>
                      <th className="py-1.5 px-1.5 w-24 whitespace-nowrap">Протокол</th>
                      <th className="py-1.5 px-1.5 whitespace-nowrap">Узел и переход (In → Out)</th>
                      <th className="py-1.5 px-1.5 whitespace-nowrap">Src IP → Dst IP</th>
                      <th className="py-1.5 px-1.5 w-16 whitespace-nowrap">VLAN</th>
                      <th className="py-1.5 px-2 w-24 whitespace-nowrap">Статус</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60">
                    {filteredEntries.map(({ step: st, originalIndex }) => {
                      const isSelected = originalIndex === currentStepIndex;
                      const vis = getProtocolVisualMeta(st.protocol, st.status);
                      return (
                        <tr
                          key={st.id}
                          data-testid={`event-row-${originalIndex}`}
                          onClick={() => onSelectStep(originalIndex, true)}
                          className={`cursor-pointer transition-colors ${
                            isSelected
                              ? 'bg-sky-500/20 text-white'
                              : 'hover:bg-slate-900/80 text-slate-300'
                          }`}
                        >
                          <td className="py-1 px-2 tabular-nums whitespace-nowrap">
                            <span className="font-semibold text-slate-200">#{st.stepIndex}</span>
                            <span className="text-slate-500 ml-1">{st.timestampMs}ms</span>
                          </td>
                          <td className="py-1 px-1.5 whitespace-nowrap">
                            <span
                              className={`inline-flex items-center px-1.5 py-0.2 rounded text-[9.5px] font-semibold border ${vis.badgeClass}`}
                            >
                              {st.protocol}
                            </span>
                          </td>
                          <td className="py-1 px-1.5 whitespace-nowrap">
                            <span className="font-semibold text-sky-300">{st.toNodeName}</span>
                            <span className="text-slate-500 ml-1">
                              ({st.fromNodeName}:{st.fromPortName}→{st.toPortName})
                            </span>
                          </td>
                          <td className="py-1 px-1.5 whitespace-nowrap text-[10.5px]">
                            <span className="text-slate-200">{st.inboundPdu.l3.srcIp}</span>
                            <span className="text-slate-500 mx-1">→</span>
                            <span className="text-emerald-300">{st.outboundPdu.l3.dstIp}</span>
                          </td>
                          <td className="py-1 px-1.5 whitespace-nowrap tabular-nums">
                            {st.vlanTag !== null ? (
                              <span className="text-indigo-300">VLAN {st.vlanTag}</span>
                            ) : (
                              <span className="text-slate-500">—</span>
                            )}
                          </td>
                          <td className="py-1 px-2 whitespace-nowrap text-[10px]">
                            {st.status === 'delivered' && (
                              <span className="inline-flex items-center gap-1 text-emerald-400">
                                <CheckCircle2 className="w-3 h-3 shrink-0" /> DELIVERED
                              </span>
                            )}
                            {st.status === 'forwarded' && (
                              <span className="inline-flex items-center gap-1 text-sky-400">
                                <ArrowRight className="w-3 h-3 shrink-0" /> FORWARDED
                              </span>
                            )}
                            {st.status === 'broadcast' && (
                              <span className="inline-flex items-center gap-1 text-amber-400">
                                <Radio className="w-3 h-3 shrink-0" /> FLOOD
                              </span>
                            )}
                            {st.status === 'dropped' && (
                              <span className="inline-flex items-center gap-1 text-red-400 font-semibold">
                                <AlertTriangle className="w-3 h-3 shrink-0" /> DROPPED
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          {/* Right Pane: Instant Inbound PDU vs Outbound PDU Diff Comparison */}
          <div className="w-full lg:w-[390px] xl:w-[430px] flex flex-col min-h-0 bg-slate-900/60 shrink-0">
            {currentStep && currentStepDiff ? (
              <>
                <div className="px-3.5 py-2 bg-slate-900 border-b border-slate-800 flex items-center justify-between gap-2 shrink-0">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-xs font-semibold text-slate-100">
                      <Crosshair className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                      <span className="truncate">
                        Сравнение PDU на узле {currentStep.toNodeName} (Шаг #{currentStep.stepIndex})
                      </span>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => onInspectStep(currentStep)}
                    className="px-2 py-0.5 text-[11px] font-medium bg-sky-600 hover:bg-sky-500 text-white rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    Развернуть L1–L7 OSI
                  </button>
                </div>

                <div className="flex-1 overflow-y-auto p-3 space-y-2.5 text-xs">
                  {/* Decision & Header Modification Summary */}
                  <div className="p-2.5 rounded bg-slate-950 border border-slate-800 space-y-1.5">
                    <div className="text-[11px] text-slate-300 leading-snug">
                      {currentStep.decisionTitle}
                    </div>
                    {currentStepDiff.changeBadges.length > 0 && (
                      <div className="flex flex-wrap items-center gap-1.5 pt-0.5 font-mono text-[10px]">
                        <span className="text-slate-400">Модификации заголовков:</span>
                        {currentStepDiff.changeBadges.map((b) => (
                          <span
                            key={b}
                            className="px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/40"
                          >
                            {b}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Inbound vs Outbound Side-by-Side Diff Table */}
                  <div className="border border-slate-800 rounded overflow-hidden">
                    <table className="w-full text-left font-mono text-[11px] border-collapse">
                      <thead className="bg-slate-950 text-slate-400 border-b border-slate-800">
                        <tr>
                          <th className="py-1 px-2 w-28">Уровень / Поле</th>
                          <th className="py-1 px-2">Inbound PDU (Вход)</th>
                          <th className="py-1 px-2">Outbound PDU (Выход)</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800/70 bg-slate-950/60">
                        {currentStepDiff.fields.map((f) => (
                          <tr
                            key={`${f.layer}-${f.field}`}
                            className={f.changed ? 'bg-amber-500/[0.07]' : ''}
                          >
                            <td className="py-1 px-2 text-slate-400 whitespace-nowrap">
                              <span className="text-sky-400 font-semibold mr-1">[{f.layer}]</span>
                              <span>{f.field}</span>
                            </td>
                            <td className="py-1 px-2 text-slate-300 truncate max-w-[140px]">
                              {f.inboundValue}
                            </td>
                            <td className="py-1 px-2 truncate max-w-[165px]">
                              <span
                                className={
                                  f.changed
                                    ? 'text-amber-300 font-semibold'
                                    : 'text-slate-300'
                                }
                              >
                                {f.outboundValue}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            ) : (
              <div className="h-full flex items-center justify-center text-xs text-slate-500 px-6 text-center">
                Выберите любое событие в таблице слева или кликните по бегущему квадратику пакета на холсте для сравнения Inbound / Outbound заголовков PDU.
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
};
