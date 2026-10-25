import React, { useState } from 'react';
import { CableType, DeviceType, PresetTestScenario } from '../network/types';
import { TOPOLOGY_PRESETS } from '../network/presets';
import { WorkspaceTool } from './TopologyCanvas';
import {
  MousePointer,
  Cable,
  Mail,
  Trash2,
  Router,
  Network,
  Monitor,
  Server,
  Download,
  Upload,
  Sparkles,
  Layers,
  PanelLeftClose,
  PanelLeftOpen,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  Play,
  ShieldAlert,
} from 'lucide-react';

interface DeviceToolbarProps {
  activeTool: WorkspaceTool;
  selectedCableType: CableType;
  activePresetId: string;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  onSelectTool: (tool: WorkspaceTool) => void;
  onSelectCableType: (type: CableType) => void;
  onAddDevice: (type: DeviceType, switchPortCount?: number) => void;
  onAddZone: () => void;
  onLoadPreset: (presetId: string) => void;
  onRunPresetTest?: (scenario: PresetTestScenario) => void;
  onOpenCoreDiagnostics?: () => void;
  onClearCanvas: () => void;
  onExportJson: () => void;
  onImportJson: (e: React.ChangeEvent<HTMLInputElement>) => void;
}

export const DeviceToolbar: React.FC<DeviceToolbarProps> = ({
  activeTool,
  selectedCableType,
  activePresetId,
  isCollapsed,
  onToggleCollapse,
  onSelectTool,
  onSelectCableType,
  onAddDevice,
  onAddZone,
  onLoadPreset,
  onRunPresetTest,
  onOpenCoreDiagnostics,
  onClearCanvas,
  onExportJson,
  onImportJson,
}) => {
  const [presetsOpen, setPresetsOpen] = useState(true);
  const activePreset = TOPOLOGY_PRESETS.find((p) => p.id === activePresetId) || TOPOLOGY_PRESETS[0];

  // Compact 56px Icon Rail Mode when collapsed
  if (isCollapsed) {
    return (
      <aside
        aria-label="Свёрнутая палитра инструментов"
        className="w-14 border-r border-slate-800 bg-slate-900 flex flex-col items-center justify-between py-3 shrink-0 select-none"
      >
        <div className="flex flex-col items-center gap-2 w-full px-1.5">
          <button
            onClick={onToggleCollapse}
            title="Развернуть левую панель инструментов"
            aria-label="Развернуть левую панель инструментов"
            className="p-2 rounded-md text-slate-300 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <PanelLeftOpen className="w-4 h-4" />
          </button>

          <div className="w-7 h-px bg-slate-800 my-0.5" />

          {/* Tools */}
          <button
            onClick={() => onSelectTool('select')}
            title="Курсор (Выбор и перемещение)"
            aria-label="Курсор"
            className={`p-2 rounded-md border transition-colors ${
              activeTool === 'select'
                ? 'bg-sky-500/20 border-sky-500/50 text-sky-300'
                : 'border-transparent text-slate-400 hover:text-slate-200 hover:bg-slate-800'
            }`}
          >
            <MousePointer className="w-4 h-4" />
          </button>

          <button
            onClick={() => onSelectTool('cable')}
            title="Кабель (Подключение портов)"
            aria-label="Кабель"
            className={`p-2 rounded-md border transition-colors ${
              activeTool === 'cable'
                ? 'bg-sky-500/20 border-sky-500/50 text-sky-300'
                : 'border-transparent text-slate-400 hover:text-slate-200 hover:bg-slate-800'
            }`}
          >
            <Cable className="w-4 h-4" />
          </button>

          <button
            onClick={() => onSelectTool('pdu')}
            title="Пакет PDU (Быстрый Ping между двумя узлами)"
            aria-label="Пакет PDU"
            className={`p-2 rounded-md border transition-colors ${
              activeTool === 'pdu'
                ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-300'
                : 'border-transparent text-slate-400 hover:text-slate-200 hover:bg-slate-800'
            }`}
          >
            <Mail className="w-4 h-4" />
          </button>

          <button
            onClick={() => onSelectTool('delete')}
            title="Удалить узел, кабель или зону"
            aria-label="Удалить"
            className={`p-2 rounded-md border transition-colors ${
              activeTool === 'delete'
                ? 'bg-red-500/20 border-red-500/50 text-red-300'
                : 'border-transparent text-slate-400 hover:text-slate-200 hover:bg-slate-800'
            }`}
          >
            <Trash2 className="w-4 h-4" />
          </button>

          <div className="w-7 h-px bg-slate-800 my-0.5" />

          {/* Quick Add Devices & Zone */}
          <button
            onClick={() => onAddDevice('router')}
            title="Добавить Router (ISR L3)"
            aria-label="Добавить Router"
            className="p-2 rounded-md text-sky-400 hover:bg-slate-800 transition-colors"
          >
            <Router className="w-4 h-4" />
          </button>
          <button
            onClick={() => onAddDevice('switch', 6)}
            title="Добавить Switch 6 портов (Catalyst L2)"
            aria-label="Добавить Switch 6 портов"
            className="p-2 rounded-md text-indigo-400 hover:bg-slate-800 transition-colors"
          >
            <Network className="w-4 h-4" />
          </button>
          <button
            onClick={() => onAddDevice('switch', 24)}
            title="Добавить Switch 24 порта (Catalyst 2960-24TT L2)"
            aria-label="Добавить Switch 24 порта"
            className="px-1.5 py-1 rounded-md text-[10px] font-mono font-bold text-indigo-300 border border-indigo-500/40 hover:bg-slate-800 transition-colors"
          >
            24P
          </button>
          <button
            onClick={() => onAddDevice('pc')}
            title="Добавить Рабочую станцию (PC)"
            aria-label="Добавить PC"
            className="p-2 rounded-md text-slate-200 hover:bg-slate-800 transition-colors"
          >
            <Monitor className="w-4 h-4" />
          </button>
          <button
            onClick={() => onAddDevice('server')}
            title="Добавить Сервер (HTTP/DNS/DHCP)"
            aria-label="Добавить Server"
            className="p-2 rounded-md text-emerald-400 hover:bg-slate-800 transition-colors"
          >
            <Server className="w-4 h-4" />
          </button>
          <button
            onClick={onAddZone}
            title="Добавить визуальную зону подсети / VLAN"
            aria-label="Добавить зону подсети"
            className="p-2 rounded-md text-sky-300 hover:bg-sky-950/60 transition-colors"
          >
            <Layers className="w-4 h-4" />
          </button>
        </div>

        <div className="flex flex-col items-center gap-1.5">
          <button
            onClick={onExportJson}
            title="Экспорт топологии в JSON"
            aria-label="Экспорт топологии"
            className="p-2 rounded-md text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors"
          >
            <Download className="w-4 h-4" />
          </button>
        </div>
      </aside>
    );
  }

  return (
    <aside
      aria-label="Палитра оборудования и инструментов проектирования"
      className="w-56 border-r border-slate-800 bg-slate-900 flex flex-col justify-between p-3 shrink-0 select-none overflow-y-auto"
    >
      <div className="space-y-4">
        {/* Header with Collapse Button */}
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-slate-300">Инструменты</span>
          <button
            onClick={onToggleCollapse}
            title="Свернуть левую панель в компактную полосу иконок"
            aria-label="Свернуть левую панель"
            className="flex items-center gap-1 px-1.5 py-1 rounded text-[11px] text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors"
          >
            <PanelLeftClose className="w-3.5 h-3.5" />
            <span>Свернуть</span>
          </button>
        </div>

        {/* Section 1: Workspace Mode Tools */}
        <div>
          <div className="grid grid-cols-2 gap-1.5">
            <button
              onClick={() => onSelectTool('select')}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 ${
                activeTool === 'select'
                  ? 'bg-sky-500/20 border-sky-500/50 text-sky-300'
                  : 'bg-slate-950/80 border-slate-800 text-slate-300 hover:bg-slate-800'
              }`}
            >
              <MousePointer className="w-3.5 h-3.5 shrink-0" />
              <span>Курсор</span>
            </button>

            <button
              onClick={() => onSelectTool('cable')}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 ${
                activeTool === 'cable'
                  ? 'bg-sky-500/20 border-sky-500/50 text-sky-300'
                  : 'bg-slate-950/80 border-slate-800 text-slate-300 hover:bg-slate-800'
              }`}
            >
              <Cable className="w-3.5 h-3.5 shrink-0" />
              <span>Кабель</span>
            </button>

            <button
              onClick={() => onSelectTool('pdu')}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 ${
                activeTool === 'pdu'
                  ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-300'
                  : 'bg-slate-950/80 border-slate-800 text-slate-300 hover:bg-slate-800'
              }`}
            >
              <Mail className="w-3.5 h-3.5 shrink-0" />
              <span>Пакет PDU</span>
            </button>

            <button
              onClick={() => onSelectTool('delete')}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 ${
                activeTool === 'delete'
                  ? 'bg-red-500/20 border-red-500/50 text-red-300'
                  : 'bg-slate-950/80 border-slate-800 text-slate-300 hover:bg-slate-800'
              }`}
            >
              <Trash2 className="w-3.5 h-3.5 shrink-0" />
              <span>Удалить</span>
            </button>
          </div>

          {/* Cable Sub-type selector when Cable tool is active */}
          {activeTool === 'cable' && (
            <div className="mt-2 p-2 rounded bg-slate-950 border border-slate-800 space-y-1">
              <div className="text-[11px] text-slate-400">Тип патч-корда:</div>
              {(
                [
                  { id: 'straight', label: 'Медный прямой (Straight)' },
                  { id: 'crossover', label: 'Медный кросс (Crossover)' },
                  { id: 'fiber', label: 'Оптоволокно (Fiber SFP)' },
                ] as const
              ).map((c) => (
                <button
                  key={c.id}
                  onClick={() => onSelectCableType(c.id)}
                  className={`w-full text-left px-2 py-1 text-xs rounded transition-colors ${
                    selectedCableType === c.id
                      ? 'bg-sky-500/20 text-sky-300 font-medium'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {c.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Section 2: Add Network Hardware & Subnet Zones */}
        <div className="pt-3 border-t border-slate-800">
          <div className="text-xs font-semibold text-slate-300 mb-2">
            Добавить на холст
          </div>
          <div className="space-y-1.5">
            <button
              onClick={() => onAddDevice('router')}
              className="w-full flex items-center justify-between px-2.5 py-1.5 rounded-md bg-slate-950/90 hover:bg-slate-800 border border-slate-800 text-xs text-slate-200 transition-colors"
            >
              <span className="flex items-center gap-2 font-medium">
                <Router className="w-3.5 h-3.5 text-sky-400" />
                <span>Router (L3)</span>
              </span>
              <span className="text-[10px] font-mono text-slate-400">3 порта</span>
            </button>

            <button
              onClick={() => onAddDevice('switch', 6)}
              className="w-full flex items-center justify-between px-2.5 py-1.5 rounded-md bg-slate-950/90 hover:bg-slate-800 border border-slate-800 text-xs text-slate-200 transition-colors"
            >
              <span className="flex items-center gap-2 font-medium">
                <Network className="w-3.5 h-3.5 text-indigo-400" />
                <span>Switch 6p (L2)</span>
              </span>
              <span className="text-[10px] font-mono text-slate-400">6 портов</span>
            </button>

            <button
              onClick={() => onAddDevice('switch', 24)}
              className="w-full flex items-center justify-between px-2.5 py-1.5 rounded-md bg-slate-950/90 hover:bg-slate-800 border border-indigo-500/30 text-xs text-slate-200 transition-colors"
            >
              <span className="flex items-center gap-2 font-medium">
                <Network className="w-3.5 h-3.5 text-indigo-300" />
                <span>Switch 24p (L2)</span>
              </span>
              <span className="text-[10px] font-mono text-indigo-300">24 порта</span>
            </button>

            <button
              onClick={() => onAddDevice('pc')}
              className="w-full flex items-center justify-between px-2.5 py-1.5 rounded-md bg-slate-950/90 hover:bg-slate-800 border border-slate-800 text-xs text-slate-200 transition-colors"
            >
              <span className="flex items-center gap-2 font-medium">
                <Monitor className="w-3.5 h-3.5 text-slate-200" />
                <span>Хост (PC)</span>
              </span>
              <span className="text-[10px] font-mono text-slate-400">Eth0</span>
            </button>

            <button
              onClick={() => onAddDevice('server')}
              className="w-full flex items-center justify-between px-2.5 py-1.5 rounded-md bg-slate-950/90 hover:bg-slate-800 border border-slate-800 text-xs text-slate-200 transition-colors"
            >
              <span className="flex items-center gap-2 font-medium">
                <Server className="w-3.5 h-3.5 text-emerald-400" />
                <span>Сервер (L7)</span>
              </span>
              <span className="text-[10px] font-mono text-slate-400">HTTP/DNS</span>
            </button>

            <button
              onClick={onAddZone}
              className="w-full flex items-center justify-between px-2.5 py-1.5 rounded-md bg-sky-950/40 hover:bg-sky-900/50 border border-sky-500/30 text-xs text-sky-200 transition-colors"
            >
              <span className="flex items-center gap-2 font-medium">
                <Layers className="w-3.5 h-3.5 text-sky-400" />
                <span>Зона подсети</span>
              </span>
              <span className="text-[10px] font-mono text-sky-300">+VLAN</span>
            </button>
          </div>
        </div>

        {/* Section 3: Collapsible Lab Scenarios Accordion (All 7 Presets) */}
        <div className="pt-2.5 border-t border-slate-800 space-y-2">
          {onOpenCoreDiagnostics && (
            <button
              type="button"
              data-testid="run-core-diagnostics-btn"
              onClick={onOpenCoreDiagnostics}
              className="w-full flex items-center justify-between px-2.5 py-2 rounded-md bg-emerald-950/80 hover:bg-emerald-800 border border-emerald-500/50 text-xs font-semibold text-emerald-200 hover:text-white transition-colors cursor-pointer"
            >
              <span className="flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                <span>Автотест ядра (L1–L7)</span>
              </span>
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-emerald-900/90 text-emerald-300">
                9 тестов
              </span>
            </button>
          )}

          {/* Active Preset 1-Click Feature Test Scenarios */}
          {activePreset && activePreset.testScenarios && activePreset.testScenarios.length > 0 && onRunPresetTest && (
            <div className="p-2 rounded-md bg-slate-950/90 border border-sky-500/30 space-y-1.5">
              <div className="flex items-center justify-between text-[11px] font-semibold text-sky-300">
                <span>Тесты стенда ({activePreset.testScenarios.length})</span>
                <span className="text-[9px] font-mono text-slate-400">1-клик запуск</span>
              </div>
              <div className="space-y-1">
                {activePreset.testScenarios.map((sc) => (
                  <button
                    key={sc.id}
                    type="button"
                    data-testid={`preset-test-btn-${sc.id}`}
                    onClick={() => onRunPresetTest(sc)}
                    className={`w-full text-left p-1.5 rounded border text-[11px] transition-colors cursor-pointer ${
                      sc.expectedOutcome === 'blocked'
                        ? 'bg-red-950/35 hover:bg-red-900/50 border-red-500/40 text-red-200'
                        : 'bg-slate-900/90 hover:bg-slate-800 border-slate-800 text-slate-200'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-1 font-medium">
                      <span className="truncate">{sc.title}</span>
                      <span
                        className={`px-1 py-0.2 rounded text-[9px] font-mono font-bold shrink-0 ${
                          sc.expectedOutcome === 'blocked'
                            ? 'bg-red-900/80 text-red-200'
                            : sc.protocolBadge === 'OSPF'
                            ? 'bg-lime-900/80 text-lime-300'
                            : sc.protocolBadge === 'RIP'
                            ? 'bg-amber-900/80 text-amber-300'
                            : 'bg-sky-900/80 text-sky-300'
                        }`}
                      >
                        {sc.protocolBadge}
                      </span>
                    </div>
                    <div className="text-[10px] text-slate-400 leading-tight mt-0.5 line-clamp-2">
                      {sc.subtitle}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          <button
            type="button"
            data-testid="toggle-presets-accordion-btn"
            onClick={() => setPresetsOpen((o) => !o)}
            className="w-full flex items-center justify-between py-1 text-xs font-semibold text-slate-300 hover:text-white cursor-pointer"
          >
            <span className="flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5 text-sky-400" />
              <span>Лабораторные стенды ({TOPOLOGY_PRESETS.length})</span>
            </span>
            {presetsOpen ? (
              <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
            )}
          </button>

          {presetsOpen && (
            <div className="space-y-1.5 mt-1">
              {TOPOLOGY_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  data-testid={`preset-btn-${preset.id}`}
                  onClick={() => onLoadPreset(preset.id)}
                  className={`w-full text-left px-2.5 py-1.5 rounded-md border text-xs transition-colors cursor-pointer ${
                    activePresetId === preset.id
                      ? 'bg-sky-500/15 border-sky-500/40 text-sky-200 font-medium'
                      : 'bg-slate-950/60 border-slate-800 text-slate-300 hover:bg-slate-800'
                  }`}
                >
                  <div className="leading-snug">{preset.name}</div>
                  <div className="text-[10px] text-slate-400 font-mono mt-0.5">
                    {preset.shortTag || `${preset.nodes.length} узлов`}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Bottom Project Persistence Actions */}
      <div className="pt-2.5 border-t border-slate-800 space-y-1.5">
        <div className="grid grid-cols-2 gap-1.5">
          <button
            onClick={onExportJson}
            className="flex items-center justify-center gap-1 px-2 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 rounded transition-colors whitespace-nowrap shrink-0"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Экспорт</span>
          </button>

          <label className="flex items-center justify-center gap-1 px-2 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 rounded transition-colors cursor-pointer whitespace-nowrap shrink-0">
            <Upload className="w-3.5 h-3.5" />
            <span>Импорт</span>
            <input
              type="file"
              accept=".json"
              onChange={onImportJson}
              className="hidden"
            />
          </label>
        </div>

        <button
          onClick={onClearCanvas}
          className="w-full px-2 py-1 text-[11px] font-medium text-slate-400 hover:text-red-300 hover:bg-red-950/40 border border-slate-800 rounded transition-colors whitespace-nowrap shrink-0"
        >
          Очистить холст
        </button>
      </div>
    </aside>
  );
};
