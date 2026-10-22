import React from 'react';
import { SimulationStep } from '../network/types';
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  RotateCcw,
  Eye,
  CheckCircle2,
  AlertTriangle,
  Radio,
  ArrowRight,
  ChevronUp,
  ChevronDown,
  ListFilter,
} from 'lucide-react';

interface SimulationTimelineBarProps {
  steps: SimulationStep[];
  currentStepIndex: number;
  isPlaying: boolean;
  speedMultiplier: number;
  summaryMessage: string;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onPlayPause: () => void;
  onStepForward: () => void;
  onStepBack: () => void;
  onReset: () => void;
  onSelectStep: (index: number) => void;
  onInspectStep: (step: SimulationStep) => void;
  onChangeSpeed: (speed: number) => void;
}

export const SimulationTimelineBar: React.FC<SimulationTimelineBarProps> = ({
  steps,
  currentStepIndex,
  isPlaying,
  speedMultiplier,
  summaryMessage,
  isExpanded,
  onToggleExpand,
  onPlayPause,
  onStepForward,
  onStepBack,
  onReset,
  onSelectStep,
  onInspectStep,
  onChangeSpeed,
}) => {
  const currentStep = steps[currentStepIndex] || null;

  return (
    <section
      aria-label="Панель управления пошаговой симуляцией и журнал пакетов"
      className={`${
        isExpanded ? 'h-52' : 'h-11'
      } border-t border-slate-800 bg-slate-900/95 flex flex-col shrink-0 select-none transition-all`}
    >
      {/* Compact Playback & Status Strip */}
      <div className="h-11 px-3.5 flex items-center justify-between gap-2 bg-slate-950/70 shrink-0">
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={onReset}
            disabled={steps.length === 0}
            aria-label="Сбросить симуляцию в начало"
            title="В начало"
            className="p-1.5 rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-200 transition-colors shrink-0"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={onStepBack}
            disabled={steps.length === 0 || currentStepIndex <= 0}
            aria-label="Шаг назад"
            className="flex items-center gap-1 px-2 py-1 text-xs font-medium rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-200 transition-colors whitespace-nowrap shrink-0"
          >
            <SkipBack className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Назад</span>
          </button>
          <button
            onClick={onPlayPause}
            disabled={steps.length === 0}
            aria-label={isPlaying ? 'Пауза симуляции' : 'Воспроизвести пакеты'}
            className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded bg-sky-600 hover:bg-sky-500 disabled:opacity-40 text-white transition-colors whitespace-nowrap shrink-0"
          >
            {isPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
            <span>{isPlaying ? 'Пауза' : 'Авто-шаг'}</span>
          </button>
          <button
            onClick={onStepForward}
            disabled={steps.length === 0 || currentStepIndex >= steps.length - 1}
            aria-label="Шаг вперёд"
            className="flex items-center gap-1 px-2 py-1 text-xs font-medium rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-200 transition-colors whitespace-nowrap shrink-0"
          >
            <span className="hidden sm:inline">Вперёд</span>
            <SkipForward className="w-3.5 h-3.5" />
          </button>

          {/* Speed Selector */}
          <div className="hidden lg:flex items-center gap-1 ml-1 pl-2 border-l border-slate-800 shrink-0">
            {[0.5, 1, 2].map((spd) => (
              <button
                key={spd}
                onClick={() => onChangeSpeed(spd)}
                className={`px-1.5 py-0.5 text-[11px] font-mono rounded transition-colors whitespace-nowrap shrink-0 ${
                  speedMultiplier === spd
                    ? 'bg-sky-500/20 text-sky-300 border border-sky-500/40'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {spd}x
              </button>
            ))}
          </div>
        </div>

        {/* Center Status Message */}
        <div className="flex-1 min-w-0 text-xs text-slate-300 truncate font-mono text-center px-2">
          {summaryMessage ||
            'Нажмите «Запустить Ping» или выберите два узла инструментом «Пакет PDU»'}
        </div>

        {/* Right Inspect Current Step + Expand/Collapse Log Button */}
        <div className="flex items-center gap-2 shrink-0">
          {steps.length > 0 && (
            <span className="text-xs font-mono text-slate-400 tabular-nums whitespace-nowrap shrink-0">
              Шаг {currentStepIndex + 1}/{steps.length}
            </span>
          )}
          {currentStep && (
            <button
              onClick={() => onInspectStep(currentStep)}
              className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-300 border border-emerald-500/40 rounded transition-colors whitespace-nowrap shrink-0"
            >
              <Eye className="w-3.5 h-3.5 shrink-0" />
              <span>Инспектор PDU</span>
            </button>
          )}
          <button
            type="button"
            onClick={onToggleExpand}
            aria-label={isExpanded ? 'Свернуть журнал пакетов' : 'Развернуть журнал пакетов'}
            className={`flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded border transition-colors whitespace-nowrap shrink-0 ${
              isExpanded
                ? 'bg-slate-800 border-slate-700 text-slate-200 hover:bg-slate-700'
                : steps.length > 0
                ? 'bg-sky-500/15 border-sky-500/40 text-sky-300 hover:bg-sky-500/25'
                : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
            }`}
          >
            <ListFilter className="w-3.5 h-3.5" />
            <span>Журнал ({steps.length})</span>
            {isExpanded ? (
              <ChevronDown className="w-3.5 h-3.5" />
            ) : (
              <ChevronUp className="w-3.5 h-3.5" />
            )}
          </button>
        </div>
      </div>

      {/* Collapsible Event List Table */}
      {isExpanded && (
        <div className="flex-1 border-t border-slate-800 overflow-y-auto">
          {steps.length === 0 ? (
            <div className="h-full flex items-center justify-center text-xs text-slate-400 px-6 text-center">
              Журнал событий симуляции пуст. Нажмите кнопку «Запустить Ping» или выберите два узла инструментом «Пакет PDU».
            </div>
          ) : (
            <table className="w-full text-left text-xs font-mono border-collapse">
              <thead className="bg-slate-950/90 text-slate-400 sticky top-0 border-b border-slate-800">
                <tr>
                  <th className="py-1.5 px-3 w-14 whitespace-nowrap">Шаг</th>
                  <th className="py-1.5 px-3 w-24 whitespace-nowrap">Время</th>
                  <th className="py-1.5 px-3 w-48 whitespace-nowrap">Откуда → Куда</th>
                  <th className="py-1.5 px-3 w-36 whitespace-nowrap">Протокол / VLAN</th>
                  <th className="py-1.5 px-3 w-32 whitespace-nowrap">Статус L2/L3</th>
                  <th className="py-1.5 px-3">Решение узла и заголовки</th>
                  <th className="py-1.5 px-3 text-right w-28 whitespace-nowrap">Детали</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/70">
                {steps.map((st, idx) => {
                  const isSelected = idx === currentStepIndex;
                  return (
                    <tr
                      key={st.id}
                      onClick={() => onSelectStep(idx)}
                      className={`cursor-pointer transition-colors ${
                        isSelected
                          ? 'bg-sky-500/15 text-slate-100'
                          : 'hover:bg-slate-800/50 text-slate-300'
                      }`}
                    >
                      <td className="py-1.5 px-3 tabular-nums font-semibold text-slate-400 whitespace-nowrap">
                        #{st.stepIndex}
                      </td>
                      <td className="py-1.5 px-3 tabular-nums text-slate-400 whitespace-nowrap">
                        {st.timestampMs} мс
                      </td>
                      <td className="py-1.5 px-3 whitespace-nowrap">
                        <span className="text-slate-200">{st.fromNodeName}</span>
                        <span className="text-slate-500"> ({st.fromPortName}) → </span>
                        <span className="text-sky-300">{st.toNodeName}</span>
                        <span className="text-slate-500"> ({st.toPortName})</span>
                      </td>
                      <td className="py-1.5 px-3 whitespace-nowrap">
                        <span
                          className={
                            st.protocol.startsWith('ARP')
                              ? 'text-amber-300'
                              : st.protocol.startsWith('ICMP')
                              ? 'text-sky-300'
                              : 'text-purple-300'
                          }
                        >
                          {st.protocol}
                        </span>
                        {st.vlanTag !== null && (
                          <span className="text-slate-400"> · VLAN {st.vlanTag}</span>
                        )}
                      </td>
                      <td className="py-1.5 px-3 whitespace-nowrap">
                        {st.status === 'delivered' && (
                          <span className="inline-flex items-center gap-1 text-emerald-400">
                            <CheckCircle2 className="w-3 h-3" /> ● DELIVERED
                          </span>
                        )}
                        {st.status === 'forwarded' && (
                          <span className="inline-flex items-center gap-1 text-sky-400">
                            <ArrowRight className="w-3 h-3" /> ◆ FORWARDED
                          </span>
                        )}
                        {st.status === 'broadcast' && (
                          <span className="inline-flex items-center gap-1 text-amber-400">
                            <Radio className="w-3 h-3" /> ▲ FLOOD
                          </span>
                        )}
                        {st.status === 'dropped' && (
                          <span className="inline-flex items-center gap-1 text-red-400">
                            <AlertTriangle className="w-3 h-3" /> ✕ DROPPED
                          </span>
                        )}
                      </td>
                      <td className="py-1.5 px-3 font-sans text-slate-300 truncate max-w-md">
                        {st.decisionTitle}
                      </td>
                      <td className="py-1.5 px-3 text-right">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onSelectStep(idx);
                            onInspectStep(st);
                          }}
                          className="px-2 py-0.5 text-[11px] font-sans font-medium bg-slate-800 hover:bg-slate-700 text-sky-300 rounded transition-colors whitespace-nowrap shrink-0"
                        >
                          Открыть PDU
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </section>
  );
};
